import type { QueryResultRow } from "pg";

import type {
	TaskAssociation,
	TerminalNotice,
	TerminalStatus,
	TerminalStore,
} from "../application/task-terminal-service.ts";
import type { MigrationDatabase } from "./migrations.ts";

type AssociationRow = QueryResultRow & {
	task_id: string;
	action_id: string;
	session_id: string;
	run_id: string | null;
	user_id: string;
	params: unknown;
};

export class PgTaskTerminalStore implements TerminalStore {
	private readonly database: MigrationDatabase;

	constructor(database: MigrationDatabase) {
		this.database = database;
	}

	async findTask(taskId: string): Promise<TaskAssociation | undefined> {
		const result = await this.database.query<AssociationRow>(
			`SELECT a.task_id, a.id AS action_id, a.session_id, a.run_id, a.user_id, a.params
			 FROM agent_actions a WHERE a.task_id = $1 ORDER BY a.created_at DESC LIMIT 1`,
			[taskId],
		);
		const row = result.rows[0];
		if (!row || !row.run_id) return undefined;
		return {
			taskId: String(row.task_id),
			actionId: String(row.action_id),
			sessionId: String(row.session_id),
			runId: String(row.run_id),
			userId: String(row.user_id),
			continueAfterTask: actionRequestsContinuation(row.params),
		};
	}

	async getTerminalStatus(taskId: string): Promise<TerminalStatus | undefined> {
		const result = await this.database.query<{ terminal_status: TerminalStatus }>(
			"SELECT terminal_status FROM agent_wakeup_notices WHERE task_id = $1 ORDER BY id DESC LIMIT 1",
			[taskId],
		);
		return result.rows[0]?.terminal_status;
	}

	async markTerminal(notice: TerminalNotice, association: TaskAssociation): Promise<boolean> {
		return await this.database.transaction(async (client) => {
			const inserted = await client.query<{ id: string }>(
				`INSERT INTO agent_wakeup_notices
				 (id, session_id, task_id, terminal_status, canvas_id, node_id, user_id, payload)
				 VALUES ($1, $2, $3, $4, NULLIF($5, '')::bigint, NULLIF($6, '')::bigint, NULLIF($7, '')::bigint, $8::jsonb)
				 ON CONFLICT (session_id, task_id, terminal_status) DO NOTHING RETURNING id`,
				[
					association.actionId,
					association.sessionId,
					notice.taskId,
					notice.status,
					notice.canvasId ?? "",
					notice.nodeId ?? "",
					notice.userId ?? undefined,
					JSON.stringify(notice),
				],
			);
			if (!inserted.rows[0]) return false;
			const actionStatus =
				notice.status === "succeeded"
					? "succeeded"
					: notice.status === "settlement_error"
						? "compensation_required"
						: "failed";
			await client.query(
				"UPDATE agent_actions SET status = $1, result = $2::jsonb, error_code = $3 WHERE id = $4 AND task_id = $5",
				[actionStatus, JSON.stringify(notice), notice.errorCode ?? null, association.actionId, notice.taskId],
			);
			return true;
		});
	}

	async warnConflict(notice: TerminalNotice, previous: TerminalStatus): Promise<void> {
		await this.database.query(
			`INSERT INTO agent_task_terminal_conflicts (id, task_id, previous_status, received_status, payload)
			 VALUES ($1, $2, $3, $4, $5::jsonb)`,
			[nextIdForAudit(), notice.taskId, previous, notice.status, JSON.stringify(notice)],
		);
	}
}

function actionRequestsContinuation(params: unknown): boolean {
	if (typeof params === "string") {
		try {
			return actionRequestsContinuation(JSON.parse(params));
		} catch {
			return false;
		}
	}
	return (
		typeof params === "object" &&
		params !== null &&
		!Array.isArray(params) &&
		(params as Record<string, unknown>).continueAfterTask === true
	);
}

let auditSequence = 0;
function nextIdForAudit(): string {
	auditSequence += 1;
	return `${Date.now()}${auditSequence}`;
}
