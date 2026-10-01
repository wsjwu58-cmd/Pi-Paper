import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ApprovalRecord, ApprovalRepository } from "../application/approval-service.ts";
import type { RunRepository, StartRunInput } from "../application/session-run-service.ts";
import { RunConflictError } from "../application/session-run-service.ts";
import type { PlannedAction } from "../domain/action-approval.ts";
import type { AgentRun, AgentRunEvent, AgentRunEventType, AgentRunStatus } from "../domain/agent-run.ts";
import { isActiveRunStatus } from "../domain/agent-run.ts";

const CONTROL_SCHEMA_VERSION = 5;
const MAX_OPERATION_RESULT_BYTES = 1_000_000;

export type DesktopMemoryCandidateScope = "session" | "canvas" | "project" | "global" | "daily";

export type DesktopMemoryCandidateRecord = {
	id: string;
	userId: string;
	canvasId?: string;
	sessionId?: string;
	sourceEventSeq?: number;
	content: string;
	memoryType: string;
	scope: DesktopMemoryCandidateScope;
	source: string;
	confidence: number;
	status: "pending" | "accepted" | "rejected";
	dedupeKey: string;
	expiresAt?: Date;
	createdAt: Date;
	reviewedAt?: Date;
};

const DESKTOP_MEMORY_CANDIDATES_SCHEMA = `
  CREATE TABLE desktop_memory_candidates (
    candidate_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT,
    canvas_id TEXT,
    source_event_seq INTEGER CHECK (source_event_seq IS NULL OR source_event_seq >= 0),
    scope TEXT NOT NULL CHECK (scope IN ('session', 'canvas', 'project', 'global', 'daily')),
    content_markdown TEXT NOT NULL CHECK (length(content_markdown) BETWEEN 1 AND 2000),
    memory_type TEXT NOT NULL CHECK (length(memory_type) BETWEEN 1 AND 120),
    source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 120),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
    dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) = 64),
    expires_at TEXT,
    created_at TEXT NOT NULL,
    reviewed_at TEXT
  ) STRICT;
  CREATE UNIQUE INDEX desktop_memory_candidates_pending_dedupe
    ON desktop_memory_candidates(user_id, scope, dedupe_key)
    WHERE status = 'pending';
  CREATE INDEX desktop_memory_candidates_pending_by_user
    ON desktop_memory_candidates(user_id, status, created_at DESC);
`;

const CONTROL_SCHEMA = `
  CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_confirmation', 'waiting_task', 'completed', 'failed', 'aborted')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (session_id, idempotency_key)
  ) STRICT;

  CREATE UNIQUE INDEX one_active_run_per_session
    ON agent_runs(session_id)
    WHERE status IN ('queued', 'running', 'waiting_confirmation', 'waiting_task');

  CREATE TABLE run_events (
    event_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    event_seq INTEGER NOT NULL CHECK (event_seq > 0),
    type TEXT NOT NULL CHECK (type IN ('assistant_delta', 'thinking', 'tool_started', 'tool_completed', 'tool_retry', 'confirmation_required', 'task_status', 'run_completed', 'run_failed', 'run_aborted')),
    runtime TEXT NOT NULL CHECK (runtime = 'pi'),
    runtime_version TEXT NOT NULL,
    data_json TEXT NOT NULL CHECK (json_valid(data_json)),
    created_at TEXT NOT NULL,
    UNIQUE (session_id, event_seq)
  ) STRICT;

  CREATE INDEX run_events_by_run ON run_events(run_id, event_seq);

  CREATE TABLE operations (
    operation_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    tool_call_id TEXT NOT NULL UNIQUE,
    effect TEXT NOT NULL CHECK (length(effect) BETWEEN 1 AND 120),
    input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
    canvas_version INTEGER CHECK (canvas_version IS NULL OR canvas_version >= 0),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'dispatched', 'succeeded', 'failed', 'uncertain')),
    external_ref TEXT,
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (session_id, idempotency_key)
  ) STRICT;

  CREATE INDEX operations_by_run_state ON operations(run_id, state);

  CREATE TABLE approvals (
    approval_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    canvas_id TEXT NOT NULL,
    canvas_version INTEGER NOT NULL CHECK (canvas_version >= 0),
    operation_hash TEXT NOT NULL CHECK (length(operation_hash) = 64),
    token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
    action_json TEXT NOT NULL CHECK (json_valid(action_json)),
    nonce TEXT NOT NULL,
    token_signature TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'expired', 'invalidated')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX approvals_by_session_status ON approvals(session_id, status, expires_at);

  CREATE TABLE control_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE agent_session_skill_state (
    session_id TEXT PRIMARY KEY,
    loaded_skill_ids TEXT NOT NULL CHECK (json_valid(loaded_skill_ids)),
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE task_links (
    task_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    action_id TEXT,
    node_id TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE memory_candidates (
    candidate_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    source_event_seq INTEGER,
    scope TEXT NOT NULL CHECK (scope IN ('session', 'project', 'global', 'daily')),
    content_markdown TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  ${DESKTOP_MEMORY_CANDIDATES_SCHEMA}

  CREATE TABLE outbox (
    outbox_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    event_seq INTEGER NOT NULL CHECK (event_seq > 0),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    UNIQUE (session_id, event_seq)
  ) STRICT;

  CREATE INDEX outbox_pending ON outbox(delivered_at, created_at);
`;

type RunRow = {
	id: string;
	session_id: string;
	idempotency_key: string;
	status: AgentRunStatus;
	created_at: string;
	updated_at: string;
};

type EventRow = {
	event_id: string;
	run_id: string;
	session_id: string;
	event_seq: number;
	type: AgentRunEventType;
	runtime_version: string;
	data_json: string;
	created_at: string;
};

type DesktopMemoryCandidateRow = {
	candidate_id: string;
	user_id: string;
	session_id: string | null;
	canvas_id: string | null;
	source_event_seq: number | null;
	scope: DesktopMemoryCandidateScope;
	content_markdown: string;
	memory_type: string;
	source: string;
	confidence: number;
	status: DesktopMemoryCandidateRecord["status"];
	dedupe_key: string;
	expires_at: string | null;
	created_at: string;
	reviewed_at: string | null;
};

type OperationState = "prepared" | "dispatched" | "succeeded" | "failed" | "uncertain";

export type DesktopOperation = {
	operationId: string;
	sessionId: string;
	runId: string;
	toolCallId: string;
	effect: string;
	inputHash: string;
	canvasVersion: number | null;
	idempotencyKey: string;
	state: OperationState;
	externalRef: string | null;
	resultJson: string | null;
	createdAt: Date;
	updatedAt: Date;
};

export type DesktopTaskLink = {
	taskId: string;
	sessionId: string;
	runId: string;
	actionId?: string;
	nodeId?: string;
	status: string;
};

export type DesktopTaskStatusUpdate = {
	taskId: string;
	status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
	errorCode?: string;
	errorMessage?: string;
	outputRef?: string;
};

export type DesktopTaskStatusUpdateResult = {
	changed: boolean;
	event?: AgentRunEvent;
	runStatus: AgentRunStatus;
	runFinalized: boolean;
};

export type PrepareDesktopOperation = Pick<
	DesktopOperation,
	"sessionId" | "runId" | "toolCallId" | "effect" | "inputHash" | "canvasVersion" | "idempotencyKey"
>;

export type DesktopOutboxItem = {
	outboxId: string;
	sessionId: string;
	runId: string;
	eventSeq: number;
	payload: Omit<AgentRunEvent, "createdAt"> & { createdAt: string };
	createdAt: Date;
};

type ApprovalRow = {
	approval_id: string;
	session_id: string;
	run_id: string;
	project_id: string;
	canvas_id: string;
	canvas_version: number;
	operation_hash: string;
	token_hash: string;
	action_json: string;
	nonce: string;
	token_signature: string;
	expires_at: number;
	status: "pending" | "accepted" | "rejected" | "expired" | "invalidated";
};

const ACTIVE_STATUS_SQL = "('queued', 'running', 'waiting_confirmation', 'waiting_task')";
const DESKTOP_TASK_STATUSES = new Set(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]);
const TERMINAL_DESKTOP_TASK_STATUSES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const TASK_LINK_SELECT = `
	SELECT task_links.*,
		COALESCE(task_links.action_id,
			(SELECT json_extract(events.data_json, '$.actionId') FROM run_events AS events
			 WHERE events.run_id = task_links.run_id AND events.type = 'task_status'
				AND json_extract(events.data_json, '$.task_id') = task_links.task_id
				AND json_extract(events.data_json, '$.actionId') IS NOT NULL
			 ORDER BY events.event_seq DESC LIMIT 1),
			(SELECT json_extract(events.data_json, '$.actionId') FROM run_events AS events
			 WHERE events.run_id = task_links.run_id AND events.type = 'run_completed'
				AND json_extract(events.data_json, '$.actionStatus') = 'accepted'
				AND json_extract(events.data_json, '$.actionId') IS NOT NULL
			 ORDER BY events.event_seq DESC LIMIT 1),
			(SELECT json_extract(events.data_json, '$.actionId') FROM run_events AS events
			 WHERE events.run_id = task_links.run_id AND events.type = 'tool_completed'
				AND json_extract(events.data_json, '$.actionStatus') = 'accepted'
				AND json_extract(events.data_json, '$.actionId') IS NOT NULL
			 ORDER BY events.event_seq DESC LIMIT 1)) AS resolved_action_id
	FROM task_links`;

function isDesktopTaskStatus(value: string): value is DesktopTaskStatusUpdate["status"] {
	return DESKTOP_TASK_STATUSES.has(value);
}

function isTerminalDesktopTaskStatus(value: string): boolean {
	return TERMINAL_DESKTOP_TASK_STATUSES.has(value);
}

function shouldAdvanceTaskStatus(current: string, next: string): boolean {
	if (!isDesktopTaskStatus(next) || isTerminalDesktopTaskStatus(current)) return false;
	if (current === "running" && next === "queued") return false;
	return true;
}

function toTaskLink(row: Record<string, unknown>): DesktopTaskLink {
	return {
		taskId: String(row.task_id),
		sessionId: String(row.session_id),
		runId: String(row.run_id),
		...(row.resolved_action_id == null && row.action_id == null
			? {}
			: { actionId: String(row.resolved_action_id ?? row.action_id) }),
		...(row.node_id == null ? {} : { nodeId: String(row.node_id) }),
		status: String(row.status),
	};
}

function jsonObject(value: string): Record<string, unknown> {
	const decoded: unknown = JSON.parse(value);
	return typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
		? (decoded as Record<string, unknown>)
		: {};
}

function toRun(row: RunRow): AgentRun {
	return {
		runId: row.id,
		sessionId: row.session_id,
		idempotencyKey: row.idempotency_key,
		status: row.status,
		createdAt: new Date(row.created_at),
		updatedAt: new Date(row.updated_at),
	};
}

function toEvent(row: EventRow): AgentRunEvent {
	return {
		eventId: row.event_id,
		runId: row.run_id,
		sessionId: row.session_id,
		eventSeq: Number(row.event_seq),
		type: row.type,
		runtime: "pi",
		runtimeVersion: row.runtime_version,
		data: jsonObject(row.data_json),
		createdAt: new Date(row.created_at),
	};
}

function toOperation(row: Record<string, unknown>): DesktopOperation {
	return {
		operationId: String(row.operation_id),
		sessionId: String(row.session_id),
		runId: String(row.run_id),
		toolCallId: String(row.tool_call_id),
		effect: String(row.effect),
		inputHash: String(row.input_hash),
		canvasVersion: row.canvas_version === null ? null : Number(row.canvas_version),
		idempotencyKey: String(row.idempotency_key),
		state: row.state as OperationState,
		externalRef: row.external_ref === null ? null : String(row.external_ref),
		resultJson: row.result_json === null ? null : String(row.result_json),
		createdAt: new Date(String(row.created_at)),
		updatedAt: new Date(String(row.updated_at)),
	};
}

function toOutboxItem(row: Record<string, unknown>): DesktopOutboxItem {
	return {
		outboxId: String(row.outbox_id),
		sessionId: String(row.session_id),
		runId: String(row.run_id),
		eventSeq: Number(row.event_seq),
		payload: JSON.parse(String(row.payload_json)) as DesktopOutboxItem["payload"],
		createdAt: new Date(String(row.created_at)),
	};
}

function toDesktopMemoryCandidate(row: DesktopMemoryCandidateRow): DesktopMemoryCandidateRecord {
	return {
		id: String(row.candidate_id),
	userId: String(row.user_id),
	...(row.session_id == null ? {} : { sessionId: String(row.session_id) }),
	...(row.canvas_id == null ? {} : { canvasId: String(row.canvas_id) }),
	...(row.source_event_seq == null ? {} : { sourceEventSeq: Number(row.source_event_seq) }),
	scope: row.scope,
	content: row.content_markdown,
	memoryType: row.memory_type,
	source: row.source,
	confidence: Number(row.confidence),
	status: row.status,
	dedupeKey: row.dedupe_key,
	...(row.expires_at == null ? {} : { expiresAt: new Date(row.expires_at) }),
	createdAt: new Date(row.created_at),
	...(row.reviewed_at == null ? {} : { reviewedAt: new Date(row.reviewed_at) }),
	};
}

const DESKTOP_MEMORY_CANDIDATE_SELECT = `
	SELECT candidate_id, user_id, session_id, canvas_id, source_event_seq, scope, content_markdown,
		memory_type, source, confidence, status, dedupe_key, expires_at, created_at, reviewed_at
	FROM desktop_memory_candidates`;

function toApprovalRecord(row: ApprovalRow): ApprovalRecord {
	const action = JSON.parse(row.action_json) as PlannedAction;
	return {
		action,
		nonce: row.nonce,
		tokenSignature: row.token_signature,
		status: row.status === "pending" ? "pending" : row.status === "accepted" ? "consumed" : "rejected",
	};
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export class DesktopAgentControlStore implements RunRepository, ApprovalRepository {
	private readonly database: DatabaseSync;
	private closed = false;

	constructor(databasePath: string) {
		this.database = new DatabaseSync(databasePath, { timeout: 5000 });
		try {
			this.database.exec("PRAGMA busy_timeout = 5000");
			this.database.exec("PRAGMA foreign_keys = ON");
			this.database.exec("PRAGMA journal_mode = WAL");
			this.database.exec("PRAGMA synchronous = FULL");
			this.initializeSchema();
		} catch (error) {
			this.database.close();
			throw error;
		}
	}

	findByIdempotency(sessionId: string, idempotencyKey: string): AgentRun | undefined {
		const row = this.database
			.prepare(`
			SELECT id, session_id, idempotency_key, status, created_at, updated_at
			FROM agent_runs WHERE session_id = ? AND idempotency_key = ?
		`)
			.get(sessionId, idempotencyKey) as unknown as RunRow | undefined;
		return row ? toRun(row) : undefined;
	}

	getLoadedSkillIds(sessionId: string): string[] {
		if (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 128)
			throw new Error("SESSION_ID_INVALID");
		const row = this.database
			.prepare("SELECT loaded_skill_ids FROM agent_session_skill_state WHERE session_id = ?")
			.get(sessionId) as { loaded_skill_ids: string } | undefined;
		if (!row) return [];
		try {
			const value: unknown = JSON.parse(row.loaded_skill_ids);
			return Array.isArray(value)
				? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))]
				: [];
		} catch {
			return [];
		}
	}

	markSkillLoaded(sessionId: string, skillId: string): string[] {
		if (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 128)
			throw new Error("SESSION_ID_INVALID");
		if (typeof skillId !== "string" || skillId.length < 1 || skillId.length > 160)
			throw new Error("SKILL_ID_INVALID");
		return this.transaction(() => {
			const loadedSkillIds = this.getLoadedSkillIds(sessionId);
			if (loadedSkillIds.includes(skillId)) return loadedSkillIds;
			const next = [...loadedSkillIds, skillId];
			this.database
				.prepare(`
					INSERT INTO agent_session_skill_state (session_id, loaded_skill_ids, updated_at)
					VALUES (?, ?, ?)
					ON CONFLICT(session_id) DO UPDATE SET
						loaded_skill_ids = excluded.loaded_skill_ids,
						updated_at = excluded.updated_at
				`)
				.run(sessionId, JSON.stringify(next), new Date().toISOString());
			return next;
		});
	}

	findActive(sessionId: string): AgentRun | undefined {
		const row = this.database
			.prepare(`
			SELECT id, session_id, idempotency_key, status, created_at, updated_at
			FROM agent_runs WHERE session_id = ? AND status IN ${ACTIVE_STATUS_SQL}
			ORDER BY created_at DESC LIMIT 1
		`)
			.get(sessionId) as unknown as RunRow | undefined;
		return row ? toRun(row) : undefined;
	}

	findById(runId: string): AgentRun | undefined {
		const row = this.database
			.prepare(`
			SELECT id, session_id, idempotency_key, status, created_at, updated_at
			FROM agent_runs WHERE id = ?
		`)
			.get(runId) as unknown as RunRow | undefined;
		return row ? toRun(row) : undefined;
	}

	startRunAtomic(input: StartRunInput & { runId: string; createdAt: Date }): AgentRun {
		if (!input.sessionId || !input.runId || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 255) {
			throw new Error("RUN_INPUT_INVALID");
		}
		return this.transaction(() => {
			const existing = this.findByIdempotency(input.sessionId, input.idempotencyKey);
			if (existing) return existing;
			if (this.findActive(input.sessionId)) throw new RunConflictError();
			const createdAt = input.createdAt.toISOString();
			this.database
				.prepare(`
				INSERT INTO agent_runs (id, session_id, idempotency_key, status, created_at, updated_at)
				VALUES (?, ?, ?, 'queued', ?, ?)
			`)
				.run(input.runId, input.sessionId, input.idempotencyKey, createdAt, createdAt);
			return {
				runId: input.runId,
				sessionId: input.sessionId,
				idempotencyKey: input.idempotencyKey,
				status: "queued",
				createdAt: input.createdAt,
				updatedAt: input.createdAt,
			};
		});
	}

	save(run: AgentRun): void;
	save(record: ApprovalRecord): void;
	save(value: AgentRun | ApprovalRecord): void {
		if ("action" in value) {
			this.saveApproval(value);
			return;
		}
		const run = value as AgentRun;
		this.database
			.prepare(`
			INSERT INTO agent_runs (id, session_id, idempotency_key, status, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`)
			.run(
				run.runId,
				run.sessionId,
				run.idempotencyKey,
				run.status,
				run.createdAt.toISOString(),
				run.updatedAt.toISOString(),
			);
	}

	updateStatus(runId: string, status: AgentRunStatus): void {
		const updated = this.database
			.prepare(`
			UPDATE agent_runs SET status = ?, updated_at = ? WHERE id = ?
		`)
			.run(status, new Date().toISOString(), runId);
		if (updated.changes !== 1) throw new Error("RUN_NOT_FOUND");
	}

	setStatusAtomic(input: {
		runId: string;
		status: AgentRunStatus;
		terminalEvent?: { type: AgentRunEventType; data: Record<string, unknown> };
	}): void {
		const expectedTerminalType =
			input.status === "completed"
				? "run_completed"
				: input.status === "failed"
					? "run_failed"
					: input.status === "aborted"
						? "run_aborted"
						: undefined;
		if (input.terminalEvent?.type !== expectedTerminalType) {
			if (input.terminalEvent || expectedTerminalType) throw new Error("RUN_TERMINAL_EVENT_INVALID");
		}
		this.transaction(() => {
			const row = this.database.prepare("SELECT session_id, status FROM agent_runs WHERE id = ?").get(input.runId) as
				| { session_id: string; status: AgentRunStatus }
				| undefined;
			if (!row) throw new Error("RUN_NOT_FOUND");
			if (row.status !== input.status && !isActiveRunStatus(row.status)) throw new Error("RUN_STATE_CONFLICT");
			if (row.status !== input.status) {
				this.database
					.prepare("UPDATE agent_runs SET status = ?, updated_at = ? WHERE id = ?")
					.run(input.status, new Date().toISOString(), input.runId);
			}
			if (!input.terminalEvent) return;
			const existing = this.database
				.prepare("SELECT 1 AS present FROM run_events WHERE run_id = ? AND type = ? LIMIT 1")
				.get(input.runId, input.terminalEvent.type);
			if (existing) return;
			const eventSeq = this.nextEventSequence(row.session_id);
			const now = new Date();
			this.insertEvent(
				{
					eventId: randomUUID(),
					runId: input.runId,
					sessionId: row.session_id,
					eventSeq,
					type: input.terminalEvent.type,
					runtime: "pi",
					runtimeVersion: "0.1.0",
					data: input.terminalEvent.data,
					createdAt: now,
				},
				randomUUID(),
			);
		});
	}

	appendEvent(event: AgentRunEvent): void {
		this.transaction(() => this.insertEvent(event, randomUUID()));
	}

	appendEventAtomic(input: { runId: string; type: AgentRunEventType; data: Record<string, unknown> }): AgentRunEvent {
		const dataJson = JSON.stringify(input.data);
		if (typeof dataJson !== "string") throw new Error("RUN_EVENT_NOT_SERIALIZABLE");
		return this.transaction(() => {
			const row = this.database.prepare("SELECT session_id, status FROM agent_runs WHERE id = ?").get(input.runId) as
				| { session_id: string; status: AgentRunStatus }
				| undefined;
			if (!row) throw new Error("RUN_NOT_FOUND");
			const allowedTerminal =
				(row.status === "completed" && input.type === "run_completed") ||
				(row.status === "failed" && input.type === "run_failed") ||
				(row.status === "aborted" && input.type === "run_aborted");
			if (!isActiveRunStatus(row.status) && !allowedTerminal) throw new Error("RUN_NOT_ACTIVE");

			const sequenceRow = this.database
				.prepare("SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq FROM run_events WHERE session_id = ?")
				.get(row.session_id) as { next_seq: number };
			const now = new Date();
			const event: AgentRunEvent = {
				eventId: randomUUID(),
				runId: input.runId,
				sessionId: row.session_id,
				eventSeq: Number(sequenceRow.next_seq),
				type: input.type,
				runtime: "pi",
				runtimeVersion: "0.1.0",
				data: input.data,
				createdAt: now,
			};
			this.insertEvent(event, randomUUID());
			return event;
		});
	}

	cancelIfActive(runId: string): boolean {
		const result = this.database
			.prepare(`
			UPDATE agent_runs SET status = 'aborted', updated_at = ?
			WHERE id = ? AND status IN ${ACTIVE_STATUS_SQL}
		`)
			.run(new Date().toISOString(), runId);
		return result.changes === 1;
	}

	cancelIfActiveAtomic(runId: string): boolean {
		return this.transaction(() => {
			const row = this.database.prepare("SELECT session_id, status FROM agent_runs WHERE id = ?").get(runId) as
				| { session_id: string; status: AgentRunStatus }
				| undefined;
			if (!row || !isActiveRunStatus(row.status)) return false;
			const now = new Date();
			this.database
				.prepare("UPDATE agent_runs SET status = 'aborted', updated_at = ? WHERE id = ?")
				.run(now.toISOString(), runId);
			const existing = this.database
				.prepare("SELECT 1 AS present FROM run_events WHERE run_id = ? AND type = 'run_aborted' LIMIT 1")
				.get(runId);
			if (!existing) {
				this.insertEvent(
					{
						eventId: randomUUID(),
						runId,
						sessionId: row.session_id,
						eventSeq: this.nextEventSequence(row.session_id),
						type: "run_aborted",
						runtime: "pi",
						runtimeVersion: "0.1.0",
						data: {},
						createdAt: now,
					},
					randomUUID(),
				);
			}
			return true;
		});
	}

	private saveApproval(record: ApprovalRecord): void {
		const action = record.action;
		const approvalToken = action.approvalToken;
		if (
			!approvalToken ||
			action.status !== "awaiting_approval" ||
			!action.runId ||
			!Number.isSafeInteger(action.canvasVersion) ||
			!Number.isSafeInteger(action.binding.expiresAt) ||
			!/^[a-f0-9]{64}$/u.test(action.actionHash)
		)
			throw new Error("APPROVAL_RECORD_INVALID");
		const actionJson = JSON.stringify(action);
		if (typeof actionJson !== "string") throw new Error("APPROVAL_RECORD_NOT_SERIALIZABLE");
		const runId = action.runId;
		const now = new Date().toISOString();
		this.transaction(() => {
			const run = this.database.prepare("SELECT session_id, status FROM agent_runs WHERE id = ?").get(runId) as
				| { session_id: string; status: AgentRunStatus }
				| undefined;
			if (!run || run.session_id !== action.sessionId || !isActiveRunStatus(run.status))
				throw new Error("RUN_NOT_ACTIVE");
			this.database
				.prepare(`
				INSERT INTO approvals (
					approval_id, session_id, run_id, project_id, canvas_id, canvas_version,
					operation_hash, token_hash, action_json, nonce, token_signature,
					expires_at, status, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
			`)
				.run(
					action.actionId,
					action.sessionId,
					runId,
					action.userId,
					action.canvasId,
					action.canvasVersion,
					action.actionHash,
					digest(approvalToken),
					actionJson,
					record.nonce,
					record.tokenSignature,
					action.binding.expiresAt,
					now,
					now,
				);
		});
	}

	find(actionId: string): ApprovalRecord | undefined {
		if (typeof actionId !== "string" || !actionId) return undefined;
		let row = this.database.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(actionId) as
			| ApprovalRow
			| undefined;
		if (row?.status === "pending" && row.expires_at <= Date.now()) {
			this.database
				.prepare(`
				UPDATE approvals SET status = 'expired', updated_at = ?
				WHERE approval_id = ? AND status = 'pending' AND expires_at <= ?
			`)
				.run(new Date().toISOString(), actionId, Date.now());
			row = this.database.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(actionId) as
				| ApprovalRow
				| undefined;
		}
		return row ? toApprovalRecord(row) : undefined;
	}

	findConsumedApprovalForRun(runId: string): ApprovalRecord | undefined {
		const row = this.database
			.prepare(`
			SELECT * FROM approvals WHERE run_id = ? AND status = 'accepted'
			ORDER BY created_at DESC LIMIT 1
		`)
			.get(runId) as ApprovalRow | undefined;
		return row ? toApprovalRecord(row) : undefined;
	}

	consumePending(actionId: string): ApprovalRecord | undefined {
		return this.transaction(() => {
			const now = Date.now();
			const updated = this.database
				.prepare(`
				UPDATE approvals SET status = 'accepted', updated_at = ?
				WHERE approval_id = ? AND status = 'pending' AND expires_at > ?
			`)
				.run(new Date(now).toISOString(), actionId, now);
			if (updated.changes !== 1) {
				this.database
					.prepare(`
					UPDATE approvals SET status = 'expired', updated_at = ?
					WHERE approval_id = ? AND status = 'pending' AND expires_at <= ?
				`)
					.run(new Date(now).toISOString(), actionId, now);
				return undefined;
			}
			const row = this.database.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(actionId) as
				| ApprovalRow
				| undefined;
			return row ? toApprovalRecord(row) : undefined;
		});
	}

	rejectPending(actionId: string): ApprovalRecord | undefined {
		return this.transaction(() => {
			const updated = this.database
				.prepare(`
				UPDATE approvals SET status = 'rejected', updated_at = ?
				WHERE approval_id = ? AND status = 'pending'
			`)
				.run(new Date().toISOString(), actionId);
			if (updated.changes !== 1) return undefined;
			const row = this.database.prepare("SELECT * FROM approvals WHERE approval_id = ?").get(actionId) as
				| ApprovalRow
				| undefined;
			return row ? toApprovalRecord(row) : undefined;
		});
	}

	invalidatePendingForRun(runId: string): void {
		if (typeof runId !== "string" || !runId) return;
		this.database
			.prepare(`
			UPDATE approvals SET status = 'invalidated', updated_at = ?
			WHERE run_id = ? AND status = 'pending'
		`)
			.run(new Date().toISOString(), runId);
	}

	expireUnconsumedConfirmation(runId: string, data: Record<string, unknown>): boolean {
		if (typeof runId !== "string" || !runId) return false;
		return this.transaction(() => {
			const row = this.database.prepare("SELECT session_id, status FROM agent_runs WHERE id = ?").get(runId) as
				| { session_id: string; status: AgentRunStatus }
				| undefined;
			if (!row || row.status !== "waiting_confirmation") return false;
			const accepted = this.database
				.prepare("SELECT 1 AS present FROM approvals WHERE run_id = ? AND status = 'accepted' LIMIT 1")
				.get(runId);
			if (accepted) return false;

			const now = new Date();
			this.database
				.prepare("UPDATE approvals SET status = 'invalidated', updated_at = ? WHERE run_id = ? AND status = 'pending'")
				.run(now.toISOString(), runId);
			this.database
				.prepare("UPDATE agent_runs SET status = 'aborted', updated_at = ? WHERE id = ?")
				.run(now.toISOString(), runId);
			const terminalEvent = this.database
				.prepare("SELECT 1 AS present FROM run_events WHERE run_id = ? AND type = 'run_aborted' LIMIT 1")
				.get(runId);
			if (!terminalEvent) this.appendEventInTransaction(runId, row.session_id, "run_aborted", data, now);
			return true;
		});
	}

	getOrCreateApprovalSecret(): string {
		const existing = this.database
			.prepare("SELECT value FROM control_metadata WHERE key = 'approval_secret'")
			.get() as { value: string } | undefined;
		if (existing?.value) return existing.value;
		const generated = randomBytes(32).toString("base64url");
		this.database
			.prepare("INSERT OR IGNORE INTO control_metadata (key, value) VALUES ('approval_secret', ?)")
			.run(generated);
		const stored = this.database.prepare("SELECT value FROM control_metadata WHERE key = 'approval_secret'").get() as
			| { value: string }
			| undefined;
		if (!stored?.value) throw new Error("APPROVAL_SECRET_UNAVAILABLE");
		return stored.value;
	}

	linkTask(input: {
		taskId: string;
		sessionId: string;
		runId: string;
		actionId?: string;
		nodeId: string;
		status: string;
	}): void {
		if (
			!input.taskId ||
			input.taskId.length > 200 ||
			!input.sessionId ||
			!input.runId ||
			!input.nodeId ||
			!isDesktopTaskStatus(input.status) ||
			(input.actionId !== undefined && (!input.actionId || input.actionId.length > 128))
		)
			throw new Error("TASK_LINK_INVALID");
		this.transaction(() => {
			const run = this.database.prepare("SELECT session_id FROM agent_runs WHERE id = ?").get(input.runId) as
				| { session_id: string }
				| undefined;
			if (!run || run.session_id !== input.sessionId) throw new Error("RUN_NOT_FOUND");
			const existing = this.database.prepare("SELECT * FROM task_links WHERE task_id = ?").get(input.taskId) as
				| Record<string, unknown>
				| undefined;
			const now = new Date().toISOString();
			if (existing) {
				const link = toTaskLink(existing);
				if (
					link.sessionId !== input.sessionId ||
					link.runId !== input.runId ||
					(link.nodeId && link.nodeId !== input.nodeId) ||
					(link.actionId && input.actionId && link.actionId !== input.actionId)
				)
					throw new Error("TASK_LINK_CONFLICT");
				const nextStatus = shouldAdvanceTaskStatus(link.status, input.status) ? input.status : link.status;
				this.database
					.prepare(`
					UPDATE task_links SET action_id = COALESCE(action_id, ?), node_id = COALESCE(node_id, ?),
						status = ?, updated_at = ? WHERE task_id = ?
				`)
					.run(input.actionId ?? null, input.nodeId, nextStatus, now, input.taskId);
				return;
			}
			this.database
				.prepare(`
				INSERT INTO task_links (task_id, session_id, run_id, action_id, node_id, status, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`)
				.run(input.taskId, input.sessionId, input.runId, input.actionId ?? null, input.nodeId, input.status, now, now);
		});
	}

	listTaskLinks(runId?: string): DesktopTaskLink[] {
		const rows = runId === undefined
			? this.database.prepare(`${TASK_LINK_SELECT} ORDER BY task_links.created_at, task_links.task_id`).all()
			: this.database.prepare(`${TASK_LINK_SELECT} WHERE task_links.run_id = ? ORDER BY task_links.created_at, task_links.task_id`).all(runId);
		return (rows as unknown as Record<string, unknown>[]).map(toTaskLink);
	}

	recordTaskStatus(input: DesktopTaskStatusUpdate): DesktopTaskStatusUpdateResult {
		if (!input.taskId || input.taskId.length > 200 || !isDesktopTaskStatus(input.status))
			throw new Error("TASK_STATUS_INVALID");
		if (input.errorCode !== undefined && !/^[A-Z0-9_]{1,120}$/u.test(input.errorCode))
			throw new Error("TASK_ERROR_CODE_INVALID");
		if (input.errorMessage !== undefined && input.errorMessage.length > 500)
			throw new Error("TASK_ERROR_MESSAGE_TOO_LONG");
		if (input.outputRef !== undefined && !/^vibe:\/\/app\/tasks\/[A-Za-z0-9_-]{1,128}\/output(?:\?index=(?:0|[1-9][0-9]{0,5}))?$/u.test(input.outputRef))
			throw new Error("TASK_OUTPUT_REF_INVALID");

		return this.transaction(() => {
			const linkRow = this.database.prepare(`${TASK_LINK_SELECT} WHERE task_links.task_id = ?`).get(input.taskId) as
				| Record<string, unknown>
				| undefined;
			if (!linkRow) throw new Error("TASK_LINK_NOT_FOUND");
			const link = toTaskLink(linkRow);
			const runRow = this.database.prepare("SELECT session_id, status FROM agent_runs WHERE id = ?").get(link.runId) as
				| { session_id: string; status: AgentRunStatus }
				| undefined;
			if (!runRow || runRow.session_id !== link.sessionId) throw new Error("RUN_NOT_FOUND");

			let event: AgentRunEvent | undefined;
			let changed = false;
			const previousIsTerminal = isTerminalDesktopTaskStatus(link.status);
			const canApplyStatus =
				link.status === input.status || (!previousIsTerminal && shouldAdvanceTaskStatus(link.status, input.status));
			if (!previousIsTerminal && link.status !== input.status && canApplyStatus) {
				const now = new Date();
				this.database
					.prepare("UPDATE task_links SET status = ?, updated_at = ? WHERE task_id = ?")
					.run(input.status, now.toISOString(), input.taskId);
				changed = true;
			}
			const matchingEvent = this.database.prepare(`
				SELECT 1 AS present FROM run_events
				WHERE run_id = ? AND type = 'task_status'
					AND json_extract(data_json, '$.task_id') = ?
					AND json_extract(data_json, '$.status') = ?
					AND (? IS NULL OR json_extract(data_json, '$.actionId') = ?)
				LIMIT 1
			`).get(link.runId, link.taskId, input.status, link.actionId ?? null, link.actionId ?? null);
			if (!matchingEvent && canApplyStatus) {
				const data: Record<string, unknown> = {
					...(link.actionId ? { actionId: link.actionId, actionStatus: "accepted" } : {}),
					task_id: link.taskId,
					...(link.nodeId ? { node_id: link.nodeId } : {}),
					status: input.status,
					...(input.errorCode ? { error_code: input.errorCode } : {}),
					...(input.errorMessage ? { error_message: input.errorMessage } : {}),
					...(input.outputRef ? { output_ref: input.outputRef } : {}),
				};
				event = this.appendEventInTransaction(link.runId, link.sessionId, "task_status", data);
			}

			const statusRows = this.database.prepare("SELECT status FROM task_links WHERE run_id = ?").all(link.runId) as
				Array<{ status: string }>;
			const allTerminal = statusRows.length > 0 && statusRows.every((row) => isTerminalDesktopTaskStatus(row.status));
			let runStatus = runRow.status;
			let runFinalized = false;

			// A linked task proves approval was already consumed. Repair a crash between
			// task creation and changing the run to waiting_task without submitting it again.
			if (
				statusRows.length > 0 &&
				(runStatus === "waiting_confirmation" || runStatus === "queued" || runStatus === "running")
			) {
				this.database
					.prepare("UPDATE agent_runs SET status = 'waiting_task', updated_at = ? WHERE id = ?")
					.run(new Date().toISOString(), link.runId);
				runStatus = "waiting_task";
			}

			if (allTerminal && runStatus === "waiting_task") {
				const taskStatuses = statusRows.map((row) => row.status);
				const success = taskStatuses.every((status) => status === "succeeded");
				const nextRunStatus: AgentRunStatus = success ? "completed" : "failed";
				const terminalType: AgentRunEventType = success ? "run_completed" : "run_failed";
				const terminalData = success
					? { text: "生成任务已完成。" }
					: {
							text: "生成任务未成功完成，请查看对应节点的任务详情。",
							message: "生成任务未成功完成，请查看对应节点的任务详情。",
							errorCode: "GENERATION_TASK_FAILED",
						};
				this.database
					.prepare("UPDATE agent_runs SET status = ?, updated_at = ? WHERE id = ?")
					.run(nextRunStatus, new Date().toISOString(), link.runId);
				runStatus = nextRunStatus;
				const existingTerminal = this.database
					.prepare("SELECT 1 AS present FROM run_events WHERE run_id = ? AND type = ? LIMIT 1")
					.get(link.runId, terminalType);
				if (!existingTerminal) this.appendEventInTransaction(link.runId, link.sessionId, terminalType, terminalData);
				runFinalized = true;
			}

			return { changed, ...(event ? { event } : {}), runStatus, runFinalized };
		});
	}

	listEvents(runId: string): readonly AgentRunEvent[] {
		const rows = this.database
			.prepare(`
			SELECT event_id, run_id, session_id, event_seq, type, runtime_version, data_json, created_at
			FROM run_events WHERE run_id = ? ORDER BY event_seq
		`)
			.all(runId) as unknown as EventRow[];
		return rows.map(toEvent);
	}

	listSessionEvents(sessionId: string, afterSeq = 0): readonly AgentRunEvent[] {
		const rows = this.database
			.prepare(`
			SELECT event_id, run_id, session_id, event_seq, type, runtime_version, data_json, created_at
			FROM run_events WHERE session_id = ? AND event_seq > ? ORDER BY event_seq
		`)
			.all(sessionId, afterSeq) as unknown as EventRow[];
		return rows.map(toEvent);
	}

	prepareOperation(input: PrepareDesktopOperation): DesktopOperation {
		if (
			!input.sessionId ||
			!input.runId ||
			!input.toolCallId ||
			!input.idempotencyKey ||
			input.effect.length < 1 ||
			input.effect.length > 120 ||
			!/^[a-f0-9]{64}$/u.test(input.inputHash) ||
			(input.canvasVersion !== null && (!Number.isSafeInteger(input.canvasVersion) || input.canvasVersion < 0))
		) {
			throw new Error("OPERATION_INPUT_INVALID");
		}
		return this.transaction(() => {
			const existingRow = this.database
				.prepare(`
				SELECT * FROM operations WHERE tool_call_id = ? OR (session_id = ? AND idempotency_key = ?)
				LIMIT 1
			`)
				.get(input.toolCallId, input.sessionId, input.idempotencyKey) as Record<string, unknown> | undefined;
			if (existingRow) {
				const existing = toOperation(existingRow);
				if (
					existing.runId !== input.runId ||
					existing.toolCallId !== input.toolCallId ||
					existing.effect !== input.effect ||
					existing.inputHash !== input.inputHash ||
					existing.canvasVersion !== input.canvasVersion ||
					existing.idempotencyKey !== input.idempotencyKey
				) {
					throw new Error("OPERATION_IDEMPOTENCY_CONFLICT");
				}
				return existing;
			}
			const run = this.database.prepare("SELECT session_id, status FROM agent_runs WHERE id = ?").get(input.runId) as
				| { session_id: string; status: AgentRunStatus }
				| undefined;
			if (!run || run.session_id !== input.sessionId) throw new Error("RUN_NOT_FOUND");
			if (!isActiveRunStatus(run.status)) throw new Error("RUN_NOT_ACTIVE");

			const now = new Date();
			const operation: DesktopOperation = {
				operationId: randomUUID(),
				...input,
				state: "prepared",
				externalRef: null,
				resultJson: null,
				createdAt: now,
				updatedAt: now,
			};
			this.database
				.prepare(`
				INSERT INTO operations (
					operation_id, session_id, run_id, tool_call_id, effect, input_hash, canvas_version,
					idempotency_key, state, external_ref, result_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, NULL, ?, ?)
			`)
				.run(
					operation.operationId,
					operation.sessionId,
					operation.runId,
					operation.toolCallId,
					operation.effect,
					operation.inputHash,
					operation.canvasVersion,
					operation.idempotencyKey,
					now.toISOString(),
					now.toISOString(),
				);
			return operation;
		});
	}

	findOperationByToolCall(toolCallId: string): DesktopOperation | undefined {
		const row = this.database.prepare("SELECT * FROM operations WHERE tool_call_id = ?").get(toolCallId) as
			| Record<string, unknown>
			| undefined;
		return row ? toOperation(row) : undefined;
	}

	listRecoverableOperations(sessionId?: string): DesktopOperation[] {
		const rows =
			sessionId === undefined
				? this.database
						.prepare(
							"SELECT * FROM operations WHERE state IN ('prepared', 'dispatched', 'uncertain') ORDER BY created_at",
						)
						.all()
				: this.database
						.prepare(
							"SELECT * FROM operations WHERE session_id = ? AND state IN ('prepared', 'dispatched', 'uncertain') ORDER BY created_at",
						)
						.all(sessionId);
		return (rows as unknown as Record<string, unknown>[]).map(toOperation);
	}

	transitionOperation(
		operationId: string,
		nextState: OperationState,
		options: { externalRef?: string | null; resultJson?: string | null } = {},
	): DesktopOperation {
		if (
			options.resultJson !== undefined &&
			options.resultJson !== null &&
			Buffer.byteLength(options.resultJson, "utf8") > MAX_OPERATION_RESULT_BYTES
		) {
			throw new Error("OPERATION_RESULT_TOO_LARGE");
		}
		if (options.externalRef !== undefined && options.externalRef !== null && options.externalRef.length > 512) {
			throw new Error("OPERATION_EXTERNAL_REF_TOO_LONG");
		}
		if (options.resultJson !== undefined && options.resultJson !== null) JSON.parse(options.resultJson);
		return this.transaction(() => {
			const row = this.database.prepare("SELECT * FROM operations WHERE operation_id = ?").get(operationId) as
				| Record<string, unknown>
				| undefined;
			if (!row) throw new Error("OPERATION_NOT_FOUND");
			const current = toOperation(row);
			if (current.state === nextState) {
				if (
					(options.externalRef !== undefined && options.externalRef !== current.externalRef) ||
					(options.resultJson !== undefined && options.resultJson !== current.resultJson)
				) {
					throw new Error("OPERATION_RESULT_CONFLICT");
				}
				return current;
			}
			const allowed =
				(current.state === "prepared" &&
					(nextState === "dispatched" || nextState === "failed" || nextState === "uncertain")) ||
				(current.state === "dispatched" &&
					(nextState === "succeeded" || nextState === "failed" || nextState === "uncertain")) ||
				(current.state === "uncertain" && (nextState === "succeeded" || nextState === "failed"));
			if (!allowed) throw new Error("OPERATION_STATE_CONFLICT");
			const updatedAt = new Date();
			const externalRef = options.externalRef === undefined ? current.externalRef : options.externalRef;
			const resultJson = options.resultJson === undefined ? current.resultJson : options.resultJson;
			this.database
				.prepare(`
				UPDATE operations SET state = ?, external_ref = ?, result_json = ?, updated_at = ?
				WHERE operation_id = ?
			`)
				.run(nextState, externalRef, resultJson, updatedAt.toISOString(), operationId);
			return { ...current, state: nextState, externalRef, resultJson, updatedAt };
		});
	}

	listPendingOutbox(sessionId?: string, limit = 250): DesktopOutboxItem[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("OUTBOX_LIMIT_INVALID");
		const rows =
			sessionId === undefined
				? this.database
						.prepare("SELECT * FROM outbox WHERE delivered_at IS NULL ORDER BY created_at LIMIT ?")
						.all(limit)
				: this.database
						.prepare(
							"SELECT * FROM outbox WHERE session_id = ? AND delivered_at IS NULL ORDER BY event_seq LIMIT ?",
						)
						.all(sessionId, limit);
		return (rows as unknown as Record<string, unknown>[]).map(toOutboxItem);
	}

	markOutboxDelivered(outboxId: string): boolean {
		const result = this.database
			.prepare(`
			UPDATE outbox SET delivered_at = ? WHERE outbox_id = ? AND delivered_at IS NULL
		`)
			.run(new Date().toISOString(), outboxId);
		return result.changes === 1;
	}

	listPendingDesktopMemoryCandidates(userId: string): DesktopMemoryCandidateRecord[] {
		const rows = this.database.prepare(`${DESKTOP_MEMORY_CANDIDATE_SELECT}
			WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 500`).all(userId) as unknown as DesktopMemoryCandidateRow[];
		return rows.map(toDesktopMemoryCandidate);
	}

	findPendingDesktopMemoryCandidate(
		userId: string,
		scope: DesktopMemoryCandidateScope,
		dedupeKey: string,
	): DesktopMemoryCandidateRecord | undefined {
		const row = this.database.prepare(`${DESKTOP_MEMORY_CANDIDATE_SELECT}
			WHERE user_id = ? AND scope = ? AND dedupe_key = ? AND status = 'pending' LIMIT 1`)
			.get(userId, scope, dedupeKey) as unknown as DesktopMemoryCandidateRow | undefined;
		return row ? toDesktopMemoryCandidate(row) : undefined;
	}

	getDesktopMemoryCandidate(id: string, userId: string): DesktopMemoryCandidateRecord | undefined {
		const row = this.database.prepare(`${DESKTOP_MEMORY_CANDIDATE_SELECT}
			WHERE candidate_id = ? AND user_id = ? LIMIT 1`).get(id, userId) as unknown as DesktopMemoryCandidateRow | undefined;
		return row ? toDesktopMemoryCandidate(row) : undefined;
	}

	saveDesktopMemoryCandidate(candidate: DesktopMemoryCandidateRecord): boolean {
		const result = this.database.prepare(`
			INSERT OR IGNORE INTO desktop_memory_candidates
			(candidate_id, user_id, session_id, canvas_id, source_event_seq, scope, content_markdown,
			 memory_type, source, confidence, status, dedupe_key, expires_at, created_at, reviewed_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			candidate.id,
			candidate.userId,
			candidate.sessionId ?? null,
			candidate.canvasId ?? null,
			candidate.sourceEventSeq ?? null,
			candidate.scope,
			candidate.content,
			candidate.memoryType,
			candidate.source,
			candidate.confidence,
			candidate.status,
			candidate.dedupeKey,
			candidate.expiresAt?.toISOString() ?? null,
			candidate.createdAt.toISOString(),
			candidate.reviewedAt?.toISOString() ?? null,
		);
		return result.changes === 1;
	}

	updateDesktopMemoryCandidateStatus(
		id: string,
		userId: string,
		status: "accepted" | "rejected",
	): boolean {
		const result = this.database.prepare(`
			UPDATE desktop_memory_candidates SET status = ?, reviewed_at = ?
			WHERE candidate_id = ? AND user_id = ? AND status = 'pending'
		`).run(status, new Date().toISOString(), id, userId);
		return result.changes === 1;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} finally {
			this.database.close();
		}
	}

	private appendEventInTransaction(
		runId: string,
		sessionId: string,
		type: AgentRunEventType,
		data: Record<string, unknown>,
		createdAt = new Date(),
	): AgentRunEvent {
		const event: AgentRunEvent = {
			eventId: randomUUID(),
			runId,
			sessionId,
			eventSeq: this.nextEventSequence(sessionId),
			type,
			runtime: "pi",
			runtimeVersion: "0.1.0",
			data,
			createdAt,
		};
		this.insertEvent(event, randomUUID());
		return event;
	}

	private insertEvent(event: AgentRunEvent, outboxId: string): void {
		const dataJson = JSON.stringify(event.data);
		if (typeof dataJson !== "string") throw new Error("RUN_EVENT_NOT_SERIALIZABLE");
		const run = this.database.prepare("SELECT session_id FROM agent_runs WHERE id = ?").get(event.runId) as
			| { session_id: string }
			| undefined;
		if (!run || run.session_id !== event.sessionId) throw new Error("RUN_NOT_FOUND");
		const createdAt = event.createdAt.toISOString();
		this.database
			.prepare(`
			INSERT INTO run_events (event_id, session_id, run_id, event_seq, type, runtime, runtime_version, data_json, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)
			.run(
				event.eventId,
				event.sessionId,
				event.runId,
				event.eventSeq,
				event.type,
				event.runtime,
				event.runtimeVersion,
				dataJson,
				createdAt,
			);
		const payload = JSON.stringify(event);
		if (typeof payload !== "string") throw new Error("RUN_EVENT_NOT_SERIALIZABLE");
		this.database
			.prepare(`
			INSERT INTO outbox (outbox_id, session_id, run_id, event_seq, payload_json, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`)
			.run(outboxId, event.sessionId, event.runId, event.eventSeq, payload, createdAt);
	}

	private nextEventSequence(sessionId: string): number {
		const row = this.database
			.prepare("SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq FROM run_events WHERE session_id = ?")
			.get(sessionId) as { next_seq: number };
		return Number(row.next_seq);
	}

	private transaction<T>(operation: () => T): T {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch {
				// Preserve the original operation failure.
			}
			throw error;
		}
	}

	private initializeSchema(): void {
		const version = Number(
			(this.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
		);
		if (version === CONTROL_SCHEMA_VERSION) return;
		if (version === 1) {
			this.transaction(() => {
				this.database.exec(`
					ALTER TABLE approvals ADD COLUMN action_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(action_json));
					ALTER TABLE approvals ADD COLUMN nonce TEXT NOT NULL DEFAULT '';
					ALTER TABLE approvals ADD COLUMN token_signature TEXT NOT NULL DEFAULT '';
					CREATE TABLE control_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
					CREATE TABLE agent_session_skill_state (
						session_id TEXT PRIMARY KEY,
						loaded_skill_ids TEXT NOT NULL CHECK (json_valid(loaded_skill_ids)),
						updated_at TEXT NOT NULL
					) STRICT;
					UPDATE approvals SET status = 'rejected' WHERE status IN ('pending', 'accepted');
				`);
				this.database.exec(DESKTOP_MEMORY_CANDIDATES_SCHEMA);
				this.ensureTaskLinkActionColumn();
				this.database.exec(`PRAGMA user_version = ${CONTROL_SCHEMA_VERSION}`);
			});
			return;
		}
		if (version === 2) {
			this.transaction(() => {
				this.database.exec(`
					CREATE TABLE agent_session_skill_state (
						session_id TEXT PRIMARY KEY,
						loaded_skill_ids TEXT NOT NULL CHECK (json_valid(loaded_skill_ids)),
						updated_at TEXT NOT NULL
					) STRICT;
				`);
				this.database.exec(DESKTOP_MEMORY_CANDIDATES_SCHEMA);
				this.ensureTaskLinkActionColumn();
				this.database.exec(`PRAGMA user_version = ${CONTROL_SCHEMA_VERSION}`);
			});
			return;
		}
		if (version === 3) {
			this.transaction(() => {
				this.database.exec(DESKTOP_MEMORY_CANDIDATES_SCHEMA);
				this.ensureTaskLinkActionColumn();
				this.database.exec(`PRAGMA user_version = ${CONTROL_SCHEMA_VERSION}`);
			});
			return;
		}
		if (version === 4) {
			this.transaction(() => {
				this.ensureTaskLinkActionColumn();
				this.database.exec(`PRAGMA user_version = ${CONTROL_SCHEMA_VERSION}`);
			});
			return;
		}
		if (version !== 0) throw new Error(`Agent 控制库版本 ${version} 当前不受支持。`);
		const existingTables = this.database
			.prepare(`
			SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1
		`)
			.get();
		if (existingTables) throw new Error("Agent 控制库缺少受支持的 schemaVersion，拒绝覆盖现有数据。");
		this.transaction(() => {
			this.database.exec(CONTROL_SCHEMA);
			this.database.exec(`PRAGMA user_version = ${CONTROL_SCHEMA_VERSION}`);
		});
	}

	private ensureTaskLinkActionColumn(): void {
		const columns = this.database.prepare("PRAGMA table_info(task_links)").all() as Array<{ name: string }>;
		if (columns.length === 0) throw new Error("Agent 控制库缺少任务关联表，拒绝覆盖现有数据。");
		if (!columns.some((column) => column.name === "action_id"))
			this.database.exec("ALTER TABLE task_links ADD COLUMN action_id TEXT");
	}
}
