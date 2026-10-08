import { describe, expect, it } from "vitest";

import {
	AgentArtifactError,
	type AgentArtifactRepository,
	AgentArtifactService,
} from "../src/application/agent-artifact-service.ts";
import type { AgentArtifact } from "../src/domain/agent-artifact.ts";

const artifact = (role: AgentArtifact["producerRole"], id = `${role}-1`): AgentArtifact => ({
	id,
	planId: "plan-1",
	producerRole: role,
	schemaVersion: 1,
	content: { deliverable: `${role} output` },
	evidenceRefs: [`artifact://${id}`],
	createdAt: "2026-09-11T08:00:00.000Z",
});

class MemoryArtifactRepository implements AgentArtifactRepository {
	items: AgentArtifact[] = [];

	async append(_ownerId: string, item: AgentArtifact): Promise<AgentArtifact> {
		this.items.push(item);
		return item;
	}

	async list(planId: string, _ownerId: string): Promise<readonly AgentArtifact[]> {
		return this.items.filter((item) => item.planId === planId);
	}
}

describe("AgentArtifactService", () => {
	it("allows roles to publish typed data but rejects tool-bearing artifacts", async () => {
		const service = new AgentArtifactService(new MemoryArtifactRepository());
		await expect(
			service.publish({ ownerId: "user-1", actorRole: "script", artifact: artifact("script") }),
		).resolves.toMatchObject({
			producerRole: "script",
		});
		await expect(
			service.publish({
				ownerId: "user-1",
				actorRole: "script",
				artifact: { ...artifact("script", "unsafe"), content: { toolCall: "create_nodes" } },
			}),
		).rejects.toThrow(new AgentArtifactError("INVALID_ARTIFACT"));
	});

	it("lets Lead summarize only after required role artifacts exist", async () => {
		const repository = new MemoryArtifactRepository();
		const service = new AgentArtifactService(repository);
		for (const role of ["script", "storyboard", "audit"] as const)
			await service.publish({ ownerId: "user-1", actorRole: role, artifact: artifact(role) });

		await expect(
			service.assembleLeadSummary({
				ownerId: "user-1",
				planId: "plan-1",
				id: "lead-1",
				content: { conclusion: "ready for a user-confirmed plan" },
				evidenceRefs: ["artifact://script-1", "artifact://storyboard-1", "artifact://audit-1"],
				createdAt: "2026-09-11T08:01:00.000Z",
			}),
		).resolves.toMatchObject({ producerRole: "lead" });
		expect(repository.items).toHaveLength(4);
	});

	it("does not let a role impersonate another role", async () => {
		const service = new AgentArtifactService(new MemoryArtifactRepository());
		await expect(
			service.publish({ ownerId: "user-1", actorRole: "visual", artifact: artifact("audit") }),
		).rejects.toThrow(new AgentArtifactError("ROLE_NOT_ALLOWED"));
	});
});
