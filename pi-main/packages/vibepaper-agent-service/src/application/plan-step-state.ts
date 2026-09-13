import type { AgentPlan, PlanStep } from "../domain/agent-plan.ts";
import { clonePlanStep } from "./plan-compiler.ts";

export class PlanStepStateError extends Error {
	readonly code: "NOT_READY" | "LEASE_HELD" | "INVALID_TRANSITION" | "IDEMPOTENCY_CONFLICT";

	constructor(code: PlanStepStateError["code"]) {
		super(code);
		this.name = "PlanStepStateError";
		this.code = code;
	}
}

export function releaseExpiredLeases(plan: AgentPlan, now: Date): AgentPlan {
	const nowIso = now.toISOString();
	let changed = false;
	const steps = plan.steps.map((step) => {
		if (step.status !== "running" || !step.leaseUntil || step.leaseUntil > nowIso) return step;
		changed = true;
		return clonePlanStep(step, { status: "pending", leaseUntil: undefined });
	});
	return changed ? { ...plan, version: plan.version + 1, steps } : plan;
}

export function claimPlanStep(
	plan: AgentPlan,
	stepId: string,
	now: Date,
	leaseDurationMs = 30_000,
): AgentPlan {
	const step = requireStep(plan, stepId);
	if (!isReady(plan.steps, step)) throw new PlanStepStateError("NOT_READY");
	const concurrencyKey = step.concurrencyKey?.trim();
	if (
		concurrencyKey &&
		plan.steps.some(
			(candidate) =>
				candidate.id !== step.id &&
				candidate.status === "running" &&
				candidate.concurrencyKey?.trim() === concurrencyKey,
		)
	)
		throw new PlanStepStateError("LEASE_HELD");
	const leaseUntil = new Date(now.getTime() + leaseDurationMs).toISOString();
	return updateStep(plan, stepId, {
		status: "running",
		leaseUntil,
		attemptCount: (step.attemptCount ?? 0) + 1,
		idempotencyKey: step.idempotencyKey ?? `${plan.id}:${step.id}:${step.inputHash}`,
		lastError: undefined,
	});
}

export function completePlanStep(
	plan: AgentPlan,
	stepId: string,
	input: { idempotencyKey: string; outputRef?: string },
): AgentPlan {
	const step = requireStep(plan, stepId);
	assertRunningAndIdempotent(step, input.idempotencyKey);
	return updateStep(plan, stepId, { status: "completed", leaseUntil: undefined, outputRef: input.outputRef });
}

export function failPlanStep(
	plan: AgentPlan,
	stepId: string,
	input: { idempotencyKey: string; errorCode: string },
): AgentPlan {
	const step = requireStep(plan, stepId);
	assertRunningAndIdempotent(step, input.idempotencyKey);
	return updateStep(plan, stepId, { status: "failed", leaseUntil: undefined, lastError: input.errorCode });
}

function assertRunningAndIdempotent(step: PlanStep, idempotencyKey: string): void {
	if (step.status !== "running") throw new PlanStepStateError("INVALID_TRANSITION");
	if (!step.idempotencyKey || step.idempotencyKey !== idempotencyKey)
		throw new PlanStepStateError("IDEMPOTENCY_CONFLICT");
}

function isReady(steps: readonly PlanStep[], step: PlanStep): boolean {
	return step.status === "pending" && step.dependsOn.every((id) => steps.find((candidate) => candidate.id === id)?.status === "completed");
}

function requireStep(plan: AgentPlan, stepId: string): PlanStep {
	const step = plan.steps.find((candidate) => candidate.id === stepId);
	if (!step) throw new PlanStepStateError("NOT_READY");
	return step;
}

function updateStep(plan: AgentPlan, stepId: string, overrides: Partial<PlanStep>): AgentPlan {
	return {
		...plan,
		version: plan.version + 1,
		steps: plan.steps.map((step) => (step.id === stepId ? clonePlanStep(step, overrides) : step)),
	};
}
