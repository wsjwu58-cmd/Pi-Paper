import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { RunRepository, StartRunInput } from "../application/session-run-service.ts";
import { RunConflictError } from "../application/session-run-service.ts";
import type { AgentRun, AgentRunEvent, AgentRunEventType, AgentRunStatus } from "../domain/agent-run.ts";
import { isActiveRunStatus } from "../domain/agent-run.ts";

const CONTROL_SCHEMA_VERSION = 1;
const MAX_OPERATION_RESULT_BYTES = 1_000_000;

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
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'expired', 'invalidated')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX approvals_by_session_status ON approvals(session_id, status, expires_at);

  CREATE TABLE task_links (
    task_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
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

const ACTIVE_STATUS_SQL = "('queued', 'running', 'waiting_confirmation', 'waiting_task')";

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

export class DesktopAgentControlStore implements RunRepository {
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

	save(run: AgentRun): void {
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

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} finally {
			this.database.close();
		}
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
}
