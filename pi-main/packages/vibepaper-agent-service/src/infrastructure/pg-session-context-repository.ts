import type { QueryResultRow } from "pg";

import type { SessionContextRepository } from "../application/session-context-service.ts";
import type { SessionContext } from "../domain/session-context.ts";
import type { MigrationDatabase } from "./migrations.ts";

type ContextRow = QueryResultRow & {
	session_id: string;
	canvas_id: string | null;
	context: unknown;
};

export class PgSessionContextRepository implements SessionContextRepository {
	private readonly database: MigrationDatabase;

	constructor(database: MigrationDatabase) {
		this.database = database;
	}

	async get(sessionId: string): Promise<SessionContext | undefined> {
		const result = await this.database.query<ContextRow>(
			"SELECT session_id, canvas_id, context FROM agent_session_context WHERE session_id = $1",
			[sessionId],
		);
		const row = result.rows[0];
		if (!row) return undefined;
		const context = parseContext(row.context);
		return context
			? {
					...context,
					sessionId: String(row.session_id),
					...(row.canvas_id == null ? {} : { canvasId: String(row.canvas_id) }),
				}
			: undefined;
	}

	async save(context: SessionContext): Promise<void> {
		await this.database.query(
			`INSERT INTO agent_session_context
			 (session_id, canvas_id, canvas_version, context, compacted_to_event_seq, token_estimate, version, updated_at)
			 VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, now())
			 ON CONFLICT (session_id) DO UPDATE SET
			 canvas_id = EXCLUDED.canvas_id,
			 canvas_version = EXCLUDED.canvas_version,
			 context = EXCLUDED.context,
			 compacted_to_event_seq = EXCLUDED.compacted_to_event_seq,
			 token_estimate = EXCLUDED.token_estimate,
			 version = agent_session_context.version + 1,
			 updated_at = now()`,
			[
				context.sessionId,
				context.canvasId ?? null,
				context.canvasVersion,
				JSON.stringify(context),
				context.compactedToEventSeq,
				Math.ceil(JSON.stringify(context).length / 4),
				context.schemaVersion,
			],
		);
	}
}

function parseContext(value: unknown): SessionContext | undefined {
	if (typeof value === "string") {
		try {
			return parseContext(JSON.parse(value) as unknown);
		} catch {
			return undefined;
		}
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const context = value as Partial<SessionContext>;
	if (typeof context.schemaVersion !== "number" || typeof context.sessionId !== "string") return undefined;
	if (typeof context.canvasVersion !== "number" || typeof context.compactedToEventSeq !== "number") return undefined;
	if (!Array.isArray(context.constraints) || !Array.isArray(context.activePlan)) return undefined;
	if (!Array.isArray(context.completedSteps) || !Array.isArray(context.pendingSteps) || !Array.isArray(context.nodeRefs))
		return undefined;
	if (typeof context.tasks !== "object" || context.tasks === null || Array.isArray(context.tasks)) return undefined;
	return context as SessionContext;
}
