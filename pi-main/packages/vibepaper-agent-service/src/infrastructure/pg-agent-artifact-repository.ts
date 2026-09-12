import type { QueryResultRow } from "pg";

import { type AgentArtifact, type AgentArtifactRole } from "../domain/agent-artifact.ts";
import type { AgentArtifactRepository } from "../application/agent-artifact-service.ts";
import type { SqlExecutor } from "./database.ts";

type AgentArtifactRow = QueryResultRow & {
	id: string;
	plan_id: string;
	producer_role: AgentArtifactRole;
	schema_version: number;
	content: unknown;
	evidence_refs: unknown;
	created_at: Date | string;
};

export class AgentArtifactRepositoryError extends Error {
	readonly code: "NOT_FOUND" | "INVALID_ARTIFACT";

	constructor(code: AgentArtifactRepositoryError["code"]) {
		super(code);
		this.name = "AgentArtifactRepositoryError";
		this.code = code;
	}
}

/** PostgreSQL storage keeps shared role output scoped to the plan owner. */
export class PgAgentArtifactRepository implements AgentArtifactRepository {
	private readonly database: SqlExecutor;

	constructor(database: SqlExecutor) {
		this.database = database;
	}

	async append(ownerId: string, artifact: AgentArtifact): Promise<AgentArtifact> {
		const result = await this.database.query<AgentArtifactRow>(
			`INSERT INTO agent_artifacts (id, plan_id, producer_role, schema_version, content, evidence_refs, created_at)
			 SELECT $1, plan.id, $2, $3, $4::jsonb, $5::jsonb, $6::timestamptz
			 FROM agent_plans plan JOIN agent_sessions session ON session.id = plan.session_id
			 WHERE plan.id = $7 AND session.user_id = $8
			 RETURNING id, plan_id, producer_role, schema_version, content, evidence_refs, created_at`,
			[
				artifact.id,
				artifact.producerRole,
				artifact.schemaVersion,
				JSON.stringify(artifact.content),
				JSON.stringify(artifact.evidenceRefs),
				artifact.createdAt,
				artifact.planId,
				ownerId,
			],
		);
		if (!result.rows[0]) throw new AgentArtifactRepositoryError("NOT_FOUND");
		return toArtifact(result.rows[0]);
	}

	async list(planId: string, ownerId: string): Promise<readonly AgentArtifact[]> {
		const result = await this.database.query<AgentArtifactRow>(
			`SELECT artifact.id, artifact.plan_id, artifact.producer_role, artifact.schema_version,
			 artifact.content, artifact.evidence_refs, artifact.created_at
			 FROM agent_artifacts artifact
			 JOIN agent_plans plan ON plan.id = artifact.plan_id
			 JOIN agent_sessions session ON session.id = plan.session_id
			 WHERE artifact.plan_id = $1 AND session.user_id = $2
			 ORDER BY artifact.created_at ASC, artifact.id ASC`,
			[planId, ownerId],
		);
		return result.rows.map(toArtifact);
	}
}

function toArtifact(row: AgentArtifactRow): AgentArtifact {
	if (!isPlainRecord(row.content) || !Array.isArray(row.evidence_refs) || row.evidence_refs.some((item) => typeof item !== "string"))
		throw new AgentArtifactRepositoryError("INVALID_ARTIFACT");
	return {
		id: row.id,
		planId: row.plan_id,
		producerRole: row.producer_role,
		schemaVersion: row.schema_version,
		content: row.content,
		evidenceRefs: row.evidence_refs as string[],
		createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
	};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
