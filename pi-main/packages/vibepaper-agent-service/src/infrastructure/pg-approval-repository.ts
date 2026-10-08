import type { QueryResultRow } from "pg";

import type { ApprovalRecord, ApprovalRepository } from "../application/approval-service.ts";
import type { ActionRisk, PlannedAction } from "../domain/action-approval.ts";
import type { MigrationDatabase } from "./migrations.ts";

type ApprovalRow = QueryResultRow & {
	action_id: string;
	run_id: string | null;
	user_id: string;
	session_id: string;
	canvas_id: string;
	canvas_version: number;
	tool_name: string;
	params: unknown;
	estimated_cost: number;
	risk_level: ActionRisk;
	action_hash: string;
	nonce: string;
	token_signature: string;
	expires_at: Date;
	status: "pending" | "consumed" | "rejected" | "expired";
};

export class PgApprovalRepository implements ApprovalRepository {
	private readonly database: MigrationDatabase;

	constructor(database: MigrationDatabase) {
		this.database = database;
	}

	async save(record: ApprovalRecord): Promise<void> {
		await this.database.transaction(async (client) => {
			await client.query(
				`INSERT INTO agent_actions
				 (id, session_id, run_id, user_id, action_type, tool_name, params, risk_level, status, canvas_version, estimated_cost, idempotency_key)
				 VALUES ($1, $2, NULLIF($3, '')::bigint, $4, 'agent_tool', $5, $6::jsonb, $7, $8, $9, $10, $11)
				 ON CONFLICT (id) DO NOTHING`,
				[
					record.action.actionId,
					record.action.sessionId,
					record.action.runId ?? "",
					record.action.userId,
					record.action.toolName,
					JSON.stringify(record.action.params),
					record.action.risk,
					record.action.status,
					record.action.canvasVersion,
					record.action.estimatedCost,
					`approval:${record.action.actionId}`,
				],
			);
			await client.query(
				`INSERT INTO agent_approvals
				 (id, action_id, session_id, user_id, canvas_id, canvas_version, tool_name, action_hash, estimated_cost, nonce, token_signature, expires_at, status)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12 / 1000.0), 'pending')
				 ON CONFLICT (action_id) DO NOTHING`,
				[
					record.action.actionId,
					record.action.actionId,
					record.action.sessionId,
					record.action.userId,
					record.action.canvasId,
					record.action.canvasVersion,
					record.action.toolName,
					record.action.actionHash,
					record.action.estimatedCost,
					record.nonce,
					record.tokenSignature,
					record.action.binding.expiresAt,
				],
			);
		});
	}

	async find(actionId: string): Promise<ApprovalRecord | undefined> {
		const result = await this.database.query<ApprovalRow>(this.selectSql("p.action_id = $1"), [actionId]);
		return result.rows[0] ? toRecord(result.rows[0]) : undefined;
	}

	async consumePending(actionId: string): Promise<ApprovalRecord | undefined> {
		const result = await this.database.query<ApprovalRow>(
			`WITH consumed AS (
				UPDATE agent_approvals
				 SET status = 'consumed', consumed_at = now()
				 WHERE action_id = $1 AND status = 'pending' AND expires_at > now()
				 RETURNING action_id, user_id, session_id, canvas_id, canvas_version, tool_name, action_hash,
				           estimated_cost, nonce, token_signature, expires_at, status
			)
			SELECT c.action_id, a.run_id, c.user_id, c.session_id, c.canvas_id, c.canvas_version, c.tool_name,
			       a.params, c.estimated_cost, a.risk_level, c.action_hash, c.nonce, c.token_signature,
			       c.expires_at, c.status
			FROM consumed c JOIN agent_actions a ON a.id = c.action_id`,
			[actionId],
		);
		return result.rows[0] ? toRecord(result.rows[0]) : undefined;
	}

	private selectSql(where: string): string {
		return `SELECT p.action_id, a.run_id, p.user_id, p.session_id, p.canvas_id, p.canvas_version, p.tool_name,
		               a.params, p.estimated_cost, a.risk_level, p.action_hash, p.nonce, p.token_signature,
		               p.expires_at, p.status
		        FROM agent_approvals p JOIN agent_actions a ON a.id = p.action_id
		        WHERE ${where}`;
	}
}

function toRecord(row: ApprovalRow): ApprovalRecord {
	const expiresAt = new Date(row.expires_at).getTime();
	const action: PlannedAction = {
		actionId: String(row.action_id),
		runId: row.run_id == null ? undefined : String(row.run_id),
		userId: String(row.user_id),
		sessionId: String(row.session_id),
		canvasId: String(row.canvas_id),
		canvasVersion: Number(row.canvas_version),
		toolName: row.tool_name,
		params: objectValue(row.params),
		estimatedCost: Number(row.estimated_cost),
		risk: row.risk_level,
		actionHash: row.action_hash,
		binding: {
			userId: String(row.user_id),
			sessionId: String(row.session_id),
			canvasId: String(row.canvas_id),
			canvasVersion: Number(row.canvas_version),
			actionHash: row.action_hash,
			expiresAt,
		},
		status: row.status === "pending" ? "awaiting_approval" : "planned",
	};
	return {
		action,
		nonce: row.nonce,
		tokenSignature: row.token_signature,
		status: row.status === "pending" ? "pending" : row.status === "rejected" ? "rejected" : "consumed",
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
