import type { SqlExecutor } from "../infrastructure/database.ts";

export type ConfirmationStatus = "accepted" | "rejected";

/**
 * Keep the persisted recovery card in sync with a confirmation made through
 * another client or after an SSE reconnect. Without this, a page refresh can
 * offer the same already-consumed approval again.
 */
export async function persistConfirmationStatus(
	database: SqlExecutor,
	sessionId: string,
	actionId: string,
	status: ConfirmationStatus,
): Promise<void> {
	await database.query(
		`UPDATE agent_messages
		 SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{confirmation,status}', to_jsonb($1::text), true)
		 WHERE session_id = $2 AND meta->'confirmation'->>'actionId' = $3`,
		[status, sessionId, actionId],
	);
}
