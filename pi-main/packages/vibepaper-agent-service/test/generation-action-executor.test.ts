import { describe, expect, it } from "vitest";

import {
	type BillingGateway,
	type CanvasGateway,
	GenerationActionExecutor,
	type GenerationGateway,
} from "../src/application/generation-action-executor.ts";

function gateways() {
	const calls = { estimate: 0, freeze: 0, queued: 0, compensate: 0 };
	const generation: GenerationGateway = {
		estimate: async () => {
			calls.estimate += 1;
			return { estimatedCost: 4, pricingVersion: 2 };
		},
	};
	const billing: BillingGateway = {
		freeze: async () => {
			calls.freeze += 1;
			return { taskId: "task-1", status: "queued" };
		},
	};
	const canvas: CanvasGateway = {
		markQueued: async () => {
			calls.queued += 1;
		},
	};
	return { calls, generation, billing, canvas };
}

describe("generation action executor", () => {
	it("uses the Generation estimate instead of a model-supplied cost", async () => {
		const deps = gateways();
		const executor = new GenerationActionExecutor(deps.generation, deps.billing, deps.canvas);
		const result = await executor.execute({
			actionId: "action-1",
			userId: "101",
			canvasId: "301",
			nodeId: "401",
			modelType: "image",
			modelParams: {},
			requestedCost: 999,
			costCap: 5,
		});
		expect(result.actualCost).toBe(4);
		expect(deps.calls.freeze).toBe(1);
	});

	it("rejects estimates over the approved cap before freezing points", async () => {
		const deps = gateways();
		const executor = new GenerationActionExecutor(deps.generation, deps.billing, deps.canvas);
		await expect(
			executor.execute({
				actionId: "action-1",
				userId: "101",
				canvasId: "301",
				nodeId: "401",
				modelType: "image",
				modelParams: {},
				requestedCost: 1,
				costCap: 3,
			}),
		).rejects.toThrow("COST_CAP_EXCEEDED");
		expect(deps.calls.freeze).toBe(0);
	});

	it("is idempotent and records compensation when Canvas queued write fails", async () => {
		const deps = gateways();
		const compensation: string[] = [];
		const canvas: CanvasGateway = {
			markQueued: async () => {
				throw new Error("CANVAS_DOWN");
			},
		};
		const executor = new GenerationActionExecutor(deps.generation, deps.billing, canvas, async (actionId) => {
			compensation.push(actionId);
		});
		const first = await executor.execute({
			actionId: "action-1",
			userId: "101",
			canvasId: "301",
			nodeId: "401",
			modelType: "image",
			modelParams: {},
			requestedCost: 1,
			costCap: 5,
		});
		const second = await executor.execute({
			actionId: "action-1",
			userId: "101",
			canvasId: "301",
			nodeId: "401",
			modelType: "image",
			modelParams: {},
			requestedCost: 1,
			costCap: 5,
		});
		expect(first).toMatchObject({ taskId: "task-1", compensationRequired: true });
		expect(second).toEqual(first);
		expect(deps.calls.freeze).toBe(1);
		expect(compensation).toEqual(["action-1"]);
	});

	it("submits every approved batch item before entering the terminal wait state", async () => {
		const deps = gateways();
		const executor = new GenerationActionExecutor(deps.generation, deps.billing, deps.canvas);
		const batch = await executor.executeBatch([
			{
				actionId: "batch-1:0",
				userId: "101",
				canvasId: "301",
				nodeId: "401",
				modelType: "image",
				modelParams: {},
				requestedCost: 4,
				costCap: 4,
			},
			{
				actionId: "batch-1:1",
				userId: "101",
				canvasId: "301",
				nodeId: "402",
				modelType: "image",
				modelParams: {},
				requestedCost: 4,
				costCap: 4,
			},
		]);
		expect(batch.results).toHaveLength(2);
		expect(batch.actualCost).toBe(8);
		expect(deps.calls.freeze).toBe(2);
		expect(deps.calls.queued).toBe(2);
	});
});
