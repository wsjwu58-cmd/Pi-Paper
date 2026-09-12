import { describe, expect, it } from "vitest";
import { PlanCompiler } from "../src/application/plan-compiler.ts";
import {
	type PlanExecutionRepository,
	PlanExecutionService,
	type ReadPlanStepExecutor,
} from "../src/application/plan-execution-service.ts";
import { claimPlanStep, completePlanStep, failPlanStep } from "../src/application/plan-step-state.ts";
import type { AgentPlan, PlanStep } from "../src/domain/agent-plan.ts";
import type { AgentProfile } from "../src/domain/tool-manifest.ts";

const step = (id: string, overrides: Partial<PlanStep> = {}): PlanStep => ({
	id,
	tool: "get_canvas_summary",
	dependsOn: [],
	status: "pending",
	inputHash: `${id}-hash`,
	estimatedCost: 0,
	effect: "read",
	...overrides,
});

class MemoryPlanRepository implements PlanExecutionRepository {
	constructor(private plan: AgentPlan) {}

	async readySet(planId: string, _ownerId: string, profile: AgentProfile) {
		expect(planId).toBe(this.plan.id);
		return new PlanCompiler().compile(this.plan, { expectedVersion: this.plan.version, profile });
	}

	async claimStep(input: { stepId: string; now?: Date; leaseDurationMs?: number }) {
		this.plan = claimPlanStep(this.plan, input.stepId, input.now ?? new Date(), input.leaseDurationMs);
		return this.plan;
	}

	async completeStep(input: { stepId: string; idempotencyKey: string; outputRef?: string }) {
		this.plan = completePlanStep(this.plan, input.stepId, input);
		return this.plan;
	}

	async failStep(input: { stepId: string; idempotencyKey: string; errorCode: string }) {
		this.plan = failPlanStep(this.plan, input.stepId, input);
		return this.plan;
	}

	current(): AgentPlan {
		return this.plan;
	}
}

describe("PlanExecutionService", () => {
	it("runs ready read steps and leaves writes for the confirmation-aware worker", async () => {
		const repository = new MemoryPlanRepository({
			id: "plan-1",
			sessionId: "session-1",
			version: 1,
			canvasVersion: 4,
			steps: [
				step("summary"),
				step("models", { tool: "list_models" }),
				step("write", { tool: "create_nodes", effect: "write_canvas" }),
			],
		});
		const executor: ReadPlanStepExecutor = {
			execute: async ({ step }) => ({ outputRef: `artifact://${step.id}`, result: { tool: step.tool } }),
		};
		const service = new PlanExecutionService(repository, executor);

		const result = await service.executeReadyReads({
			planId: "plan-1",
			ownerId: "user-1",
			canvasId: "canvas-1",
			profile: "canvas-general",
			now: new Date("2026-09-11T08:00:00.000Z"),
		});

		expect(result).toMatchObject({
			executedStepIds: ["summary", "models"],
			failedStepIds: [],
			deferredStepIds: ["write"],
			results: { summary: { tool: "get_canvas_summary" }, models: { tool: "list_models" } },
		});
		expect(repository.current().steps).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "summary", status: "completed", outputRef: "artifact://summary" }),
				expect.objectContaining({ id: "models", status: "completed", outputRef: "artifact://models" }),
				expect.objectContaining({ id: "write", status: "pending" }),
			]),
		);
	});

	it("records a safe error code when a read adapter fails", async () => {
		const repository = new MemoryPlanRepository({
			id: "plan-2",
			sessionId: "session-1",
			version: 1,
			canvasVersion: 4,
			steps: [step("summary")],
		});
		const service = new PlanExecutionService(repository, {
			execute: async () => {
				throw new Error("timeout from upstream");
			},
		});

		const result = await service.executeReadyReads({
			planId: "plan-2",
			ownerId: "user-1",
			canvasId: "canvas-1",
			profile: "canvas-general",
		});

		expect(result.failedStepIds).toEqual(["summary"]);
		expect(repository.current().steps[0]).toMatchObject({ status: "failed", lastError: "READ_EXECUTION_FAILED" });
	});
});
