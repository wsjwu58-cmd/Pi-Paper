import { describe, expect, it } from "vitest";

import { ApprovalService, InMemoryApprovalRepository } from "../src/application/approval-service.ts";
import { GenerationTools } from "../src/tools/generation-tools.ts";

describe("proposed generation tool", () => {
	it("returns a confirmation action and never freezes points while proposing", async () => {
		const tools = new GenerationTools(new ApprovalService(new InMemoryApprovalRepository(), "secret", 300));
		const proposal = await tools.submitGeneration({
			actionIdempotencyKey: "proposal-1",
			userId: "101",
			sessionId: "s1",
			canvasId: "301",
			canvasVersion: 4,
			nodeId: "node-1",
			modelType: "image",
			modelParams: { prompt: "bird" },
			estimatedCost: 0,
			overwrite: false,
		});
		expect(proposal.status).toBe("awaiting_approval");
		expect(proposal.approvalToken).toBeDefined();
		expect(proposal.estimatedCost).toBe(0);
	});

	it("requires confirmation for model changes and overwrite, and is idempotent", async () => {
		const tools = new GenerationTools(new ApprovalService(new InMemoryApprovalRepository(), "secret", 300));
		const input = {
			actionIdempotencyKey: "proposal-1",
			userId: "101",
			sessionId: "s1",
			canvasId: "301",
			canvasVersion: 4,
			nodeId: "node-1",
			modelType: "video",
			modelParams: {},
			estimatedCost: 0,
			overwrite: true,
		};
		const first = await tools.submitGeneration(input);
		const second = await tools.submitGeneration(input);
		expect(first.actionId).toBe(second.actionId);
		expect(first.approvalToken).toBeDefined();
	});

	it("creates one version-bound confirmation for every generation in a batch", async () => {
		const tools = new GenerationTools(new ApprovalService(new InMemoryApprovalRepository(), "secret", 300));
		const proposal = await tools.submitGenerationBatch({
			actionIdempotencyKey: "batch-1",
			userId: "101",
			sessionId: "s1",
			canvasId: "301",
			canvasVersion: 4,
			generations: [
				{
					nodeId: "node-1",
					modelType: "image",
					modelParams: { prompt: "one" },
					estimatedCost: 8,
					overwrite: false,
				},
				{
					nodeId: "node-2",
					modelType: "image",
					modelParams: { prompt: "two" },
					estimatedCost: 8,
					overwrite: false,
				},
			],
		});
		expect(proposal.toolName).toBe("submit_generation_batch");
		expect(proposal.estimatedCost).toBe(16);
		expect(proposal.approvalToken).toBeDefined();
	});

	it("keeps the workflow continuation intent in the approval payload", async () => {
		const tools = new GenerationTools(new ApprovalService(new InMemoryApprovalRepository(), "secret", 300));
		const proposal = await tools.submitGeneration({
			actionIdempotencyKey: "continuation-1",
			userId: "101",
			sessionId: "s1",
			canvasId: "301",
			canvasVersion: 4,
			nodeId: "node-1",
			modelType: "image",
			modelParams: { prompt: "keyframe" },
			estimatedCost: 8,
			overwrite: false,
			continueAfterTask: true,
		});
		expect(proposal.params.continueAfterTask).toBe(true);
	});
});
