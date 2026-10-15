import { describe, expect, it } from "vitest";

import {
	claimPlanStep,
	completePlanStep,
	failPlanStep,
	PlanStepStateError,
	releaseExpiredLeases,
} from "../src/application/plan-step-state.ts";
import type { AgentPlan, PlanStep } from "../src/domain/agent-plan.ts";

const step = (id: string, overrides: Partial<PlanStep> = {}): PlanStep => ({
	id,
	tool: "get_canvas_summary",
	dependsOn: [],
	status: "pending",
	inputHash: `hash-${id}`,
	estimatedCost: 0,
	...overrides,
});

const plan = (steps: PlanStep[]): AgentPlan => ({
	id: "plan-1",
	sessionId: "session-1",
	version: 1,
	canvasVersion: 3,
	steps,
});

describe("plan step execution state", () => {
	it("claims with a stable idempotency key and unlocks dependents only after completion", () => {
		const now = new Date("2026-09-11T08:00:00.000Z");
		const initial = plan([step("read"), step("write", { dependsOn: ["read"] })]);
		const running = claimPlanStep(initial, "read", now);
		expect(running.steps[0]).toMatchObject({
			status: "running",
			attemptCount: 1,
			idempotencyKey: "plan-1:read:hash-read",
		});
		expect(() => claimPlanStep(running, "write", now)).toThrow(new PlanStepStateError("NOT_READY"));
		const completed = completePlanStep(running, "read", {
			idempotencyKey: "plan-1:read:hash-read",
			outputRef: "artifact://read",
		});
		expect(claimPlanStep(completed, "write", now).steps[1]?.status).toBe("running");
	});

	it("enforces concurrency keys and only releases expired leases", () => {
		const now = new Date("2026-09-11T08:00:00.000Z");
		const initial = plan([
			step("first", { concurrencyKey: "canvas:3" }),
			step("second", { concurrencyKey: "canvas:3" }),
		]);
		const first = claimPlanStep(initial, "first", now, 1_000);
		expect(() => claimPlanStep(first, "second", now)).toThrow(new PlanStepStateError("LEASE_HELD"));
		expect(releaseExpiredLeases(first, new Date("2026-09-11T08:00:00.500Z"))).toBe(first);
		const released = releaseExpiredLeases(first, new Date("2026-09-11T08:00:01.000Z"));
		expect(released.steps[0]?.status).toBe("pending");
		expect(claimPlanStep(released, "second", now).steps[1]?.status).toBe("running");
	});

	it("rejects a terminal update from a different idempotency key", () => {
		const running = claimPlanStep(plan([step("read")]), "read", new Date("2026-09-11T08:00:00.000Z"));
		expect(() => failPlanStep(running, "read", { idempotencyKey: "other", errorCode: "MODEL_TIMEOUT" })).toThrow(
			new PlanStepStateError("IDEMPOTENCY_CONFLICT"),
		);
		expect(
			failPlanStep(running, "read", { idempotencyKey: "plan-1:read:hash-read", errorCode: "MODEL_TIMEOUT" })
				.steps[0],
		).toMatchObject({
			status: "failed",
			lastError: "MODEL_TIMEOUT",
		});
	});
});
