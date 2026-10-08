import type { QueryResultRow } from "pg";
import type { RunRepository, StartRunInput } from "../application/session-run-service.ts";
import type { AgentRun, AgentRunEvent, AgentRunEventType, AgentRunStatus } from "../domain/agent-run.ts";
import { nextId } from "./ids.ts";
import type { MigrationDatabase } from "./migrations.ts";

type RunRow = QueryResultRow & {
	id: string;
	session_id: string;
	idempotency_key: string;
	status: AgentRunStatus;
	created_at: Date;
	updated_at: Date;
};

type EventRow = QueryResultRow & {
	event_id: string;
	run_id: string;
	session_id: string;
	event_seq: number;
	type: AgentRunEventType;
	runtime: "pi";
	runtime_version: string;
	data: unknown;
	created_at: Date;
};

const ACTIVE_STATUSES = "('queued','running','waiting_confirmation','waiting_task')";
const EVENTABLE_STATUS = `(runs.status IN ${ACTIVE_STATUSES} OR (runs.status = 'completed' AND $2 = 'run_completed') OR (runs.status = 'failed' AND $2 = 'run_failed') OR (runs.status = 'aborted' AND $2 = 'run_aborted'))`;

export class PgRunRepository implements RunRepository {
	private readonly database: MigrationDatabase;

	constructor(database: MigrationDatabase) {
		this.database = database;
	}

	async startRunAtomic(input: StartRunInput & { runId: string; createdAt: Date }): Promise<AgentRun> {
		try {
			const result = await this.database.query<RunRow>(
				`INSERT INTO agent_runs (id, session_id, idempotency_key, status, created_at, updated_at)
				 VALUES ($1, $2, $3, 'queued', $4, $4)
				 ON CONFLICT (session_id, idempotency_key) DO UPDATE SET updated_at = agent_runs.updated_at
				 RETURNING id, session_id, idempotency_key, status, created_at, updated_at`,
				[input.runId, input.sessionId, input.idempotencyKey, input.createdAt],
			);
			const row = result.rows[0];
			if (!row) throw new Error("RUN_CREATE_FAILED");
			return toRun(row);
		} catch (error) {
			if (isUniqueViolation(error)) {
				const existing = await this.findByIdempotency(input.sessionId, input.idempotencyKey);
				if (existing) return existing;
				throw new Error("SESSION_BUSY");
			}
			throw error;
		}
	}

	async findByIdempotency(sessionId: string, idempotencyKey: string): Promise<AgentRun | undefined> {
		const result = await this.database.query<RunRow>(
			"SELECT id, session_id, idempotency_key, status, created_at, updated_at FROM agent_runs WHERE session_id = $1 AND idempotency_key = $2",
			[sessionId, idempotencyKey],
		);
		return result.rows[0] ? toRun(result.rows[0]) : undefined;
	}

	async findActive(sessionId: string): Promise<AgentRun | undefined> {
		const result = await this.database.query<RunRow>(
			`SELECT id, session_id, idempotency_key, status, created_at, updated_at
			 FROM agent_runs WHERE session_id = $1 AND status IN ${ACTIVE_STATUSES}
			 ORDER BY created_at DESC LIMIT 1`,
			[sessionId],
		);
		return result.rows[0] ? toRun(result.rows[0]) : undefined;
	}

	async findById(runId: string): Promise<AgentRun | undefined> {
		const result = await this.database.query<RunRow>(
			"SELECT id, session_id, idempotency_key, status, created_at, updated_at FROM agent_runs WHERE id = $1",
			[runId],
		);
		return result.rows[0] ? toRun(result.rows[0]) : undefined;
	}

	async save(run: AgentRun): Promise<void> {
		await this.database.query(
			"INSERT INTO agent_runs (id, session_id, idempotency_key, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
			[run.runId, run.sessionId, run.idempotencyKey, run.status, run.createdAt, run.updatedAt],
		);
	}

	async updateStatus(runId: string, status: AgentRunStatus): Promise<void> {
		await this.database.query("UPDATE agent_runs SET status = $2, updated_at = now() WHERE id = $1", [runId, status]);
	}

	async cancelIfActive(runId: string): Promise<boolean> {
		const result = await this.database.query(
			`UPDATE agent_runs SET status = 'aborted', updated_at = now()
			 WHERE id = $1 AND status IN ${ACTIVE_STATUSES} RETURNING id`,
			[runId],
		);
		return result.rows.length > 0;
	}

	async appendEventAtomic(input: {
		runId: string;
		type: AgentRunEventType;
		data: Record<string, unknown>;
	}): Promise<AgentRunEvent> {
		const result = await this.database.transaction(
			async (client) =>
				await client.query<EventRow>(
					`WITH locked_run AS (
					SELECT runs.id, runs.session_id FROM agent_runs AS runs
					JOIN agent_sessions AS sessions ON sessions.id = runs.session_id
					WHERE runs.id = $1 AND ${EVENTABLE_STATUS} FOR UPDATE OF runs, sessions
				), bumped_session AS (
					UPDATE agent_sessions AS sessions SET event_seq = sessions.event_seq + 1, updated_at = now()
					FROM locked_run WHERE sessions.id = locked_run.session_id
					RETURNING sessions.id AS session_id, sessions.event_seq
				), inserted_event AS (
					INSERT INTO agent_run_events (event_id, run_id, session_id, event_seq, type, runtime, runtime_version, data)
					SELECT $4, locked_run.id, locked_run.session_id, bumped_session.event_seq, $2, 'pi', '0.1.0', $3::jsonb
					FROM locked_run JOIN bumped_session USING (session_id)
					RETURNING event_id, run_id, session_id, event_seq, type, runtime, runtime_version, data, created_at
				), inserted_outbox AS (
					INSERT INTO agent_event_outbox (event_id, run_id, session_id, event_seq, payload)
					SELECT event_id, run_id, session_id, event_seq,
					       jsonb_build_object('eventId', event_id, 'runId', run_id, 'sessionId', session_id,
					         'eventSeq', event_seq, 'type', type, 'runtime', runtime,
					         'runtimeVersion', runtime_version, 'data', data)
					FROM inserted_event
					RETURNING event_id
				)
				SELECT event_id, run_id, session_id, event_seq, type, runtime, runtime_version, data, created_at
				FROM inserted_event`,
					[input.runId, input.type, JSON.stringify(input.data), nextEventId()],
				),
		);
		const row = result.rows[0];
		if (!row) throw new Error("RUN_NOT_ACTIVE");
		return toEvent(row);
	}

	async appendEvent(event: AgentRunEvent): Promise<void> {
		await this.database.transaction(async (client) => {
			const inserted = await client.query<EventRow>(
				`WITH bumped_session AS (
					UPDATE agent_sessions SET event_seq = event_seq + 1, updated_at = now()
					WHERE id = $3 RETURNING id, event_seq
				), inserted_event AS (
					INSERT INTO agent_run_events (event_id, run_id, session_id, event_seq, type, runtime, runtime_version, data, created_at)
					SELECT $1, $2, $3, event_seq, $4, $5, $6, $7::jsonb, $8 FROM bumped_session
					RETURNING event_id, run_id, session_id, event_seq, type, runtime, runtime_version, data, created_at
				)
				SELECT event_id, run_id, session_id, event_seq, type, runtime, runtime_version, data, created_at FROM inserted_event`,
				[
					event.eventId,
					event.runId,
					event.sessionId,
					event.type,
					event.runtime,
					event.runtimeVersion,
					JSON.stringify(event.data),
					event.createdAt,
				],
			);
			const persisted = inserted.rows[0];
			if (!persisted) throw new Error("SESSION_EVENT_SEQUENCE_FAILED");
			await client.query(
				"INSERT INTO agent_event_outbox (event_id, run_id, session_id, event_seq, payload) VALUES ($1, $2, $3, $4, $5::jsonb)",
				[
					event.eventId,
					event.runId,
					event.sessionId,
					persisted.event_seq,
					JSON.stringify({ ...event, eventSeq: persisted.event_seq }),
				],
			);
		});
	}

	async listEvents(runId: string): Promise<readonly AgentRunEvent[]> {
		const result = await this.database.query<EventRow>(
			`SELECT event_id, run_id, session_id, event_seq, type, runtime, runtime_version, data, created_at
			 FROM agent_run_events WHERE run_id = $1 ORDER BY event_seq`,
			[runId],
		);
		return result.rows.map(toEvent);
	}

	async listSessionEvents(sessionId: string, afterSeq = 0): Promise<readonly AgentRunEvent[]> {
		const result = await this.database.query<EventRow>(
			`SELECT event_id, run_id, session_id, event_seq, type, runtime, runtime_version, data, created_at
			 FROM agent_run_events WHERE session_id = $1 AND event_seq > $2 ORDER BY event_seq`,
			[sessionId, afterSeq],
		);
		return result.rows.map(toEvent);
	}
}

function toRun(row: RunRow): AgentRun {
	return {
		runId: String(row.id),
		sessionId: String(row.session_id),
		idempotencyKey: row.idempotency_key,
		status: row.status,
		createdAt: new Date(row.created_at),
		updatedAt: new Date(row.updated_at),
	};
}

function toEvent(row: EventRow): AgentRunEvent {
	return {
		eventId: String(row.event_id),
		runId: String(row.run_id),
		sessionId: String(row.session_id),
		eventSeq: Number(row.event_seq),
		type: row.type,
		runtime: "pi",
		runtimeVersion: row.runtime_version,
		data: objectValue(row.data),
		createdAt: new Date(row.created_at),
	};
}

function objectValue(value: unknown): Record<string, unknown> {
	if (typeof value === "string") {
		try {
			return objectValue(JSON.parse(value) as unknown);
		} catch {
			return {};
		}
	}
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function isUniqueViolation(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function nextEventId(): string {
	return nextId();
}
