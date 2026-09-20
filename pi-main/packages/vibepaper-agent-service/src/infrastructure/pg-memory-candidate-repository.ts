import type { QueryResultRow } from "pg";

import type { MemoryCandidate, MemoryCandidateRepository } from "../application/memory-service.ts";
import type { MemoryScope } from "../domain/memory.ts";
import type { MigrationDatabase } from "./migrations.ts";

type CandidateRow = QueryResultRow & {
	id: string;
	user_id: string;
	tenant_id: string | null;
	canvas_id: string | null;
	session_id: string | null;
	content: string;
	memory_type: string;
	scope: MemoryScope;
	source: string;
	source_event_seq: number | null;
	confidence: number;
	status: "pending" | "accepted" | "rejected";
	dedupe_key: string;
	expires_at: Date | null;
	created_at: Date;
	reviewed_at: Date | null;
};

export class PgMemoryCandidateRepository implements MemoryCandidateRepository {
	private readonly database: MigrationDatabase;

	constructor(database: MigrationDatabase) {
		this.database = database;
	}

	async listPending(userId: string): Promise<readonly MemoryCandidate[]> {
		const result = await this.database.query<CandidateRow>(
			`${selectSql()} WHERE user_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 100`,
			[userId],
		);
		return result.rows.map(toCandidate);
	}

	async findPending(userId: string, scope: MemoryScope, dedupeKey: string): Promise<MemoryCandidate | undefined> {
		const result = await this.database.query<CandidateRow>(
			`${selectSql()} WHERE user_id = $1 AND scope = $2 AND dedupe_key = $3 AND status = 'pending' LIMIT 1`,
			[userId, scope, dedupeKey],
		);
		return result.rows[0] ? toCandidate(result.rows[0]) : undefined;
	}

	async get(id: string, userId: string): Promise<MemoryCandidate | undefined> {
		const result = await this.database.query<CandidateRow>(`${selectSql()} WHERE id = $1 AND user_id = $2`, [id, userId]);
		return result.rows[0] ? toCandidate(result.rows[0]) : undefined;
	}

	async save(candidate: MemoryCandidate): Promise<void> {
		await this.database.query(
			`INSERT INTO memory_candidates
			 (id, user_id, tenant_id, canvas_id, session_id, content, memory_type, scope, source, source_event_seq,
			  confidence, status, dedupe_key, expires_at, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
			 ON CONFLICT (user_id, scope, dedupe_key) WHERE status = 'pending' DO NOTHING`,
			[
				candidate.id,
				candidate.userId,
				candidate.tenantId ?? null,
				candidate.canvasId ?? null,
				candidate.sessionId ?? null,
				candidate.content,
				candidate.memoryType,
				candidate.scope,
				candidate.source,
				candidate.sourceEventSeq ?? null,
				candidate.confidence,
				candidate.status,
				candidate.dedupeKey,
				candidate.expiresAt ?? null,
				candidate.createdAt,
			],
		);
	}

	async updateStatus(id: string, userId: string, status: "accepted" | "rejected"): Promise<boolean> {
		const result = await this.database.query(
			"UPDATE memory_candidates SET status = $3, reviewed_at = now() WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING id",
			[id, userId, status],
		);
		return result.rows.length > 0;
	}
}

function selectSql(): string {
	return `SELECT id, user_id, tenant_id, canvas_id, session_id, content, memory_type, scope, source,
		 source_event_seq, confidence, status, dedupe_key, expires_at, created_at, reviewed_at
		 FROM memory_candidates`;
}

function toCandidate(row: CandidateRow): MemoryCandidate {
	return {
		id: String(row.id),
		userId: String(row.user_id),
		tenantId: row.tenant_id == null ? undefined : String(row.tenant_id),
		canvasId: row.canvas_id == null ? undefined : String(row.canvas_id),
		sessionId: row.session_id == null ? undefined : String(row.session_id),
		content: row.content,
		memoryType: row.memory_type,
		scope: row.scope,
		source: row.source,
		sourceEventSeq: row.source_event_seq == null ? undefined : Number(row.source_event_seq),
		confidence: Number(row.confidence),
		status: row.status,
		dedupeKey: row.dedupe_key,
		expiresAt: row.expires_at ?? undefined,
		createdAt: new Date(row.created_at),
		reviewedAt: row.reviewed_at ?? undefined,
	};
}
