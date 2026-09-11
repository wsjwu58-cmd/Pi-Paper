import { describe, expect, it } from "vitest";

import type { AgentArtifact } from "../src/domain/agent-artifact.ts";
import { PgAgentArtifactRepository } from "../src/infrastructure/pg-agent-artifact-repository.ts";
import type { SqlExecutor } from "../src/infrastructure/database.ts";

const artifact: AgentArtifact = {
	id: "artifact-1",
	planId: "plan-1",
	producerRole: "script",
	schemaVersion: 1,
	content: { beats: ["open", "turn"] },
	evidenceRefs: ["asset://brief"],
	createdAt: "2026-09-11T08:00:00.000Z",
};

class ArtifactDatabase implements SqlExecutor {
	items: AgentArtifact[] = [];

	async query<T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
		if (text.includes("INSERT INTO agent_artifacts")) {
			const item: AgentArtifact = {
				id: values[0] as string,
				planId: values[6] as string,
				producerRole: values[1] as AgentArtifact["producerRole"],
				schemaVersion: values[2] as number,
				content: JSON.parse(values[3] as string),
				evidenceRefs: JSON.parse(values[4] as string),
				createdAt: values[5] as string,
			};
			this.items.push(item);
			return { rows: [toRow(item)] as T[] };
		}
		if (text.includes("FROM agent_artifacts artifact")) return { rows: this.items.map(toRow) as T[] };
		throw new Error(`Unexpected query: ${text}`);
	}
}

describe("PgAgentArtifactRepository", () => {
	it("persists and loads owner-scoped typed artifacts", async () => {
		const repository = new PgAgentArtifactRepository(new ArtifactDatabase());
		await expect(repository.append("user-1", artifact)).resolves.toMatchObject({ id: "artifact-1", producerRole: "script" });
		await expect(repository.list("plan-1", "user-1")).resolves.toEqual([artifact]);
	});
});

function toRow(item: AgentArtifact): Record<string, unknown> {
	return {
		id: item.id,
		plan_id: item.planId,
		producer_role: item.producerRole,
		schema_version: item.schemaVersion,
		content: item.content,
		evidence_refs: item.evidenceRefs,
		created_at: item.createdAt,
	};
}
