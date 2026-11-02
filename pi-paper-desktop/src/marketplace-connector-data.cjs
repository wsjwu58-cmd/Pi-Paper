const CLIENTS = new Set(['codex', 'claude-code', 'cursor', 'workbuddy', 'trae', 'other'])
// Provider, credential, and media scopes are chosen in the original MCP settings.
const PERMISSIONS = new Set(['canvas.read', 'canvas.write', 'generation.propose', 'task.read'])
const ownKeys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every((key) => allowed.includes(key))
const invalid = () => { throw new Error('MARKETPLACE_PACKAGE_INVALID') }

function validateConnectorData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid()
  if (data.kind === 'mcp-client') {
    if (!ownKeys(data, ['kind', 'clientName', 'permissions']) || !CLIENTS.has(data.clientName)
      || !Array.isArray(data.permissions) || !data.permissions.length || data.permissions.length > PERMISSIONS.size
      || new Set(data.permissions).size !== data.permissions.length || data.permissions.some((item) => !PERMISSIONS.has(item))) invalid()
  } else if (data.kind === 'local-mcp') {
    if (!ownKeys(data, ['kind', 'capability']) || data.capability !== 'text-transform') invalid()
  } else invalid()
  return data
}
module.exports = { validateConnectorData }
