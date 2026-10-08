import type { QueryResultRow } from "pg";
import type { MemoryRepository } from "../application/memory-service.ts";
import type { MemoryRecord, MemoryScope } from "../domain/memory.ts";
import type { MigrationDatabase } from "./migrations.ts";

type MemoryRow = QueryResultRow & {
	id: string;
	user_id: string;
	tenant_id: string | null;
	canvas_id: string | null;
	session_id: string | null;
	content: string;
	memory_type: string;
	scope: MemoryScope;
	source: string;
	confidence: number;
	visibility: "user" | "enterprise";
	version: number;
	created_at: Date;
	expires_at: Date | null;
	deleted: boolean;
};

export class PgMemoryRepository implements MemoryRepository {
	private readonly database: MigrationDatabase;

	constructor(database: MigrationDatabase) {
		this.database = database;
	}

	async list(): Promise<readonly MemoryRecord[]> {
		const result = await this.database.query<MemoryRow>(this.selectSql());
		return result.rows.map(toMemory);
	}

	async save(memory: MemoryRecord): Promise<void> {
		await this.database.query(
			`INSERT INTO user_memories
			 (id, user_id, tenant_id, canvas_id, session_id, content, memory_type, scope, visibility, source, confidence, version, expires_at, deleted)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, false)`,
			[
				memory.id,
				memory.userId,
				memory.tenantId ?? null,
				memory.canvasId ?? null,
				memory.sessionId ?? null,
				memory.content,
				memory.memoryType ?? memory.scope,
				memory.scope,
				memory.visibility,
				memory.source,
				memory.confidence,
				memory.version,
				memory.expiresAt ?? null,
			],
		);
	}

	async softDelete(id: string, userId: string): Promise<boolean> {
		const result = await this.database.query<{ id: string }>(
			"UPDATE user_memories SET deleted = true WHERE id = $1 AND user_id = $2 AND deleted = false RETURNING id",
			[id, userId],
		);
		return result.rows.length > 0;
	}

	private selectSql(): string {
		return `SELECT id, user_id, tenant_id, canvas_id, session_id, content, memory_type, scope, source, confidence, visibility, version, expires_at, deleted, created_at
			FROM user_memories WHERE deleted = false`;
	}
}

function toMemory(row: MemoryRow): MemoryRecord {
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
		confidence: Number(row.confidence),
		visibility: row.visibility,
		version: Number(row.version),
		createdAt: new Date(row.created_at),
		expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
		deleted: row.deleted,
	};
}
