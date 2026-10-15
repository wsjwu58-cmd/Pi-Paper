const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const STORE_SCHEMA_VERSION = 1

function createMcpControlStore(directory) {
  fs.mkdirSync(directory, { recursive: true })
  const file = path.join(directory, 'mcp-control.sqlite')
  const database = new DatabaseSync(file)
  database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;')
  const currentVersion = database.prepare('PRAGMA user_version').get().user_version
  if (currentVersion > STORE_SCHEMA_VERSION) throw new Error('MCP_STORE_SCHEMA_UNSUPPORTED')
  database.exec(`
    CREATE TABLE IF NOT EXISTS mcp_settings (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      updated_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO mcp_settings(singleton, enabled, updated_at) VALUES (1, 0, ${Date.now()});
    CREATE TABLE IF NOT EXISTS mcp_clients (
      client_id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL UNIQUE,
      client_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      permissions_json TEXT NOT NULL,
      provider_grants_json TEXT NOT NULL,
      media_types_json TEXT NOT NULL,
      disclosure_version TEXT NOT NULL,
      inline_credentials INTEGER NOT NULL CHECK (inline_credentials IN (0, 1)),
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS mcp_actions (
      proposal_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      client_id TEXT,
      grant_id TEXT,
      project_id TEXT,
      canvas_id TEXT,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      approval_action_id TEXT,
      provider_operation_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mcp_actions_scope ON mcp_actions(client_id, project_id, canvas_id, status);
    CREATE TABLE IF NOT EXISTS mcp_operations (
      operation_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      project_id TEXT,
      canvas_id TEXT,
      kind TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(operation_id, client_id, grant_id)
    );
    CREATE INDEX IF NOT EXISTS mcp_operations_project ON mcp_operations(project_id, canvas_id, updated_at);
    PRAGMA user_version = ${STORE_SCHEMA_VERSION};
  `)
  database.prepare(`UPDATE mcp_actions SET status = 'invalidated', updated_at = ?
    WHERE status IN ('awaiting_pairing', 'awaiting_disclosure', 'awaiting_desktop_input')`).run(Date.now())

  const setting = database.prepare('SELECT enabled FROM mcp_settings WHERE singleton = 1')
  const getClientStatement = database.prepare('SELECT * FROM mcp_clients WHERE client_id = ?')

  function decodeClient(row) {
    if (!row) return null
    return {
      clientId: row.client_id,
      grantId: row.grant_id,
      clientName: row.client_name,
      displayName: row.display_name,
      projectId: row.project_id,
      canvasId: row.canvas_id,
      permissions: JSON.parse(row.permissions_json),
      providerGrants: JSON.parse(row.provider_grants_json),
      mediaTypes: JSON.parse(row.media_types_json),
      disclosureVersion: row.disclosure_version,
      inlineCredentials: row.inline_credentials === 1,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at ?? null,
    }
  }

  return {
    file,
    isEnabled() { return setting.get().enabled === 1 },
    setEnabled(enabled) {
      database.prepare('UPDATE mcp_settings SET enabled = ?, updated_at = ? WHERE singleton = 1')
        .run(enabled ? 1 : 0, Date.now())
      return enabled === true
    },
    createClient(input) {
      const now = Date.now()
      const clientId = randomUUID()
      const grantId = randomUUID()
      const client = {
        clientId,
        grantId,
        clientName: input.clientName,
        displayName: input.displayName,
        projectId: input.projectId,
        canvasId: input.canvasId,
        permissions: input.permissions,
        providerGrants: input.providerGrants,
        mediaTypes: input.mediaTypes,
        disclosureVersion: input.disclosureVersion,
        inlineCredentials: input.inlineCredentials === true,
        issuedAt: now,
        expiresAt: now + 90 * 24 * 60 * 60 * 1000,
        revokedAt: null,
      }
      database.prepare(`INSERT INTO mcp_clients(
        client_id, grant_id, client_name, display_name, project_id, canvas_id,
        permissions_json, provider_grants_json, media_types_json, disclosure_version,
        inline_credentials, issued_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        client.clientId, client.grantId, client.clientName, client.displayName, client.projectId, client.canvasId,
        JSON.stringify(client.permissions), JSON.stringify(client.providerGrants), JSON.stringify(client.mediaTypes),
        client.disclosureVersion, client.inlineCredentials ? 1 : 0, client.issuedAt, client.expiresAt,
      )
      return client
    },
    getClient(clientId) { return decodeClient(getClientStatement.get(clientId)) },
    listClients() {
      return database.prepare('SELECT * FROM mcp_clients ORDER BY issued_at DESC').all().map(decodeClient)
    },
    revokeClient(clientId) {
      const now = Date.now()
      const result = database.prepare('UPDATE mcp_clients SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL')
        .run(now, clientId)
      return result.changes === 1
    },
    revokeProject(projectId) {
      const now = Date.now()
      database.prepare('UPDATE mcp_clients SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL')
        .run(now, projectId)
      database.prepare(`UPDATE mcp_actions SET status = 'invalidated', updated_at = ?
        WHERE project_id = ? AND status IN ('pending', 'awaiting_pairing', 'awaiting_confirmation', 'awaiting_disclosure', 'awaiting_desktop_input')`)
        .run(now, projectId)
    },
    createAction(input) {
      const now = Date.now()
      database.prepare(`INSERT INTO mcp_actions(
        proposal_id, kind, client_id, grant_id, project_id, canvas_id, status, payload_json,
        approval_action_id, provider_operation_id, created_at, expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.proposalId, input.kind, input.clientId ?? null, input.grantId ?? null,
        input.projectId ?? null, input.canvasId ?? null, input.status ?? 'pending',
        JSON.stringify(input.payload ?? {}), input.approvalActionId ?? null,
        input.providerOperationId ?? null, now, input.expiresAt, now,
      )
      return this.getAction(input.proposalId)
    },
    updateAction(proposalId, patch) {
      const current = this.getAction(proposalId)
      if (!current) return null
      const nextStatus = patch.status ?? current.status
      if (['authorized', 'paired', 'approved', 'rejected', 'expired', 'invalidated', 'submitted', 'failed', 'completed'].includes(current.status)
        && current.status !== nextStatus) return current
      const nextPayload = patch.payload ?? current.payload
      database.prepare(`UPDATE mcp_actions SET status = ?, payload_json = ?, updated_at = ? WHERE proposal_id = ?`)
        .run(nextStatus, JSON.stringify(nextPayload), Date.now(), proposalId)
      return this.getAction(proposalId)
    },
    getAction(proposalId) {
      const row = database.prepare('SELECT * FROM mcp_actions WHERE proposal_id = ?').get(proposalId)
      if (!row) return null
      return {
        proposalId: row.proposal_id,
        kind: row.kind,
        clientId: row.client_id,
        grantId: row.grant_id,
        projectId: row.project_id,
        canvasId: row.canvas_id,
        status: row.status,
        payload: JSON.parse(row.payload_json),
        approvalActionId: row.approval_action_id,
        providerOperationId: row.provider_operation_id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        updatedAt: row.updated_at,
      }
    },
    listActions({ projectId, canvasId, clientId } = {}) {
      const rows = database.prepare(`SELECT * FROM mcp_actions
        WHERE (? IS NULL OR project_id = ?) AND (? IS NULL OR canvas_id = ?) AND (? IS NULL OR client_id = ?)
        ORDER BY created_at DESC`).all(projectId ?? null, projectId ?? null, canvasId ?? null, canvasId ?? null,
        clientId ?? null, clientId ?? null)
      return rows.map((row) => this.getAction(row.proposal_id))
    },
    beginOperation(input) {
      const key = [input.operationId, input.clientId, input.grantId]
      const existing = database.prepare(`SELECT * FROM mcp_operations
        WHERE operation_id = ? AND client_id = ? AND grant_id = ?`).get(...key)
      if (existing) {
        if (existing.payload_digest !== input.payloadDigest) return { status: 'conflict' }
        return { status: 'replay', record: decodeOperation(existing) }
      }
      const now = Date.now()
      database.prepare(`INSERT INTO mcp_operations(
        operation_id, client_id, grant_id, project_id, canvas_id, kind, payload_digest,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'started', ?, ?)`).run(
        ...key, input.projectId ?? null, input.canvasId ?? null, input.kind, input.payloadDigest, now, now,
      )
      return { status: 'started', record: this.getOperation(input) }
    },
    completeOperation(input) {
      const current = this.getOperation(input)
      if (!current) throw new Error('MCP_OPERATION_NOT_FOUND')
      if (['completed', 'failed', 'partial', 'saved', 'denied'].includes(current.status)) return current
      const now = Date.now()
      database.prepare(`UPDATE mcp_operations SET status = ?, result_json = ?, error_code = ?, updated_at = ?
        WHERE operation_id = ? AND client_id = ? AND grant_id = ?`).run(
        input.status, input.result === undefined ? null : JSON.stringify(input.result), input.errorCode ?? null,
        now, input.operationId, input.clientId, input.grantId,
      )
      return this.getOperation(input)
    },
    getOperation(input) {
      const row = database.prepare(`SELECT * FROM mcp_operations
        WHERE operation_id = ? AND client_id = ? AND grant_id = ?`).get(input.operationId, input.clientId, input.grantId)
      return row ? decodeOperation(row) : null
    },
    listProviderOperations({ clientId, providerId } = {}) {
      const rows = database.prepare(`SELECT * FROM mcp_operations
        WHERE client_id = ? AND kind LIKE ? ORDER BY updated_at DESC LIMIT 100`).all(clientId, `provider:${providerId}:%`)
      return rows.map(decodeOperation)
    },
    close() { database.close() },
  }

  function decodeOperation(row) {
    return {
      operationId: row.operation_id,
      clientId: row.client_id,
      grantId: row.grant_id,
      projectId: row.project_id,
      canvasId: row.canvas_id,
      kind: row.kind,
      payloadDigest: row.payload_digest,
      status: row.status,
      ...(row.result_json ? { result: JSON.parse(row.result_json) } : {}),
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}

module.exports = { MCP_CONTROL_SCHEMA_VERSION: STORE_SCHEMA_VERSION, createMcpControlStore }
