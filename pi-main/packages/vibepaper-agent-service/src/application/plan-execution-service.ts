import type { AgentPlan, PlanStep } from "../domain/agent-plan.ts";
import type { AgentProfile } from "../domain/tool-manifest.ts";
import type { CompiledPlan } from "./plan-compiler.ts";
import { PerUserReadExecutionGate, type ReadExecutionGate } from "./read-execution-gate.ts";

/**
 * Persistence boundary used by the scheduler.  Implementations must make the
 * claim and terminal transitions atomic (PgPlanRepository does this under a
 * row lock); the executor intentionally never mutates a plan in memory.
 */
export interface PlanExecutionRepository {
	readySet(planId: string, ownerId: string, profile: AgentProfile): Promise<CompiledPlan>;
	claimStep(input: {
		planId: string;
		ownerId: string;
		stepId: string;
		now?: Date;
		leaseDurationMs?: number;
	}): Promise<AgentPlan>;
	completeStep(input: {
		planId: string;
		ownerId: string;
		stepId: string;
		idempotencyKey: string;
		outputRef?: string;
	}): Promise<AgentPlan>;
	failStep(input: {
		planId: string;
		ownerId: string;
		stepId: string;
		idempotencyKey: string;
		errorCode: string;
	}): Promise<AgentPlan>;
}

export interface ReadPlanStepExecutor {
	execute(input: {
		planId: string;
		step: PlanStep;
		ownerId: string;
		canvasId: string;
		requestId?: string;
	}): Promise<{ outputRef?: string; result: unknown }>;
}

export type PlanReadExecutionResult = {
	executedStepIds: readonly string[];
	failedStepIds: readonly string[];
	/** Non-read effects are deliberately returned to the confirmation-aware worker. */
	deferredStepIds: readonly string[];
	results: Readonly<Record<string, unknown>>;
};

/**
 * Executes only the compiler-approved read partitions.  Canvas writes and task
 * submissions must stay in their isolated partitions and are never invoked by
 * this service, so a scheduling bug cannot bypass confirmation or billing.
 */
export class PlanExecutionService {
	private readonly repository: PlanExecutionRepository;
	private readonly readExecutor: ReadPlanStepExecutor;
	private readonly readGate: ReadExecutionGate;

	constructor(
		repository: PlanExecutionRepository,
		readExecutor: ReadPlanStepExecutor,
		readGate: ReadExecutionGate = new PerUserReadExecutionGate(),
	) {
		this.repository = repository;
		this.readExecutor = readExecutor;
		this.readGate = readGate;
	}

	async executeReadyReads(input: {
		planId: string;
		ownerId: string;
		canvasId: string;
		profile: AgentProfile;
		requestId?: string;
		now?: Date;
		leaseDurationMs?: number;
	}): Promise<PlanReadExecutionResult> {
		const compiled = await this.repository.readySet(input.planId, input.ownerId, input.profile);
		const deferredStepIds = compiled.executionPartitions
			.filter((partition) => partition.effect !== "read")
			.flatMap((partition) => partition.stepIds);
		const outcomes: ExecutionOutcome[] = [];
		for (const partition of compiled.executionPartitions.filter((candidate) => candidate.effect === "read")) {
			const partitionOutcomes = await Promise.all(
				partition.stepIds.map(
					async (stepId) =>
						await this.readGate.run(
							input.ownerId,
							async () => await this.executeOne(compiled.plan, stepId, input),
						),
				),
			);
			outcomes.push(...partitionOutcomes);
		}
		return {
			executedStepIds: outcomes.filter((outcome) => outcome.status === "completed").map((outcome) => outcome.stepId),
			failedStepIds: outcomes.filter((outcome) => outcome.status === "failed").map((outcome) => outcome.stepId),
			deferredStepIds,
			results: Object.fromEntries(
				outcomes
					.filter((outcome): outcome is CompletedOutcome => outcome.status === "completed")
					.map((outcome) => [outcome.stepId, outcome.result]),
			),
		};
	}

	private async executeOne(
		plan: AgentPlan,
		stepId: string,
		input: {
			planId: string;
			ownerId: string;
			canvasId: string;
			profile: AgentProfile;
			requestId?: string;
			now?: Date;
			leaseDurationMs?: number;
		},
	): Promise<ExecutionOutcome> {
		let claimed: AgentPlan;
		try {
			claimed = await this.repository.claimStep({
				planId: input.planId,
				ownerId: input.ownerId,
				stepId,
				now: input.now,
				leaseDurationMs: input.leaseDurationMs,
			});
		} catch {
			return { status: "failed", stepId };
		}
		const step = claimed.steps.find((candidate) => candidate.id === stepId);
		if (!step?.idempotencyKey) return { status: "failed", stepId };
		try {
			const output = await this.readExecutor.execute({
				planId: plan.id,
				step,
				ownerId: input.ownerId,
				canvasId: input.canvasId,
				requestId: input.requestId,
			});
			await this.repository.completeStep({
				planId: input.planId,
				ownerId: input.ownerId,
				stepId,
				idempotencyKey: step.idempotencyKey,
				outputRef: output.outputRef,
			});
			return { status: "completed", stepId, result: output.result };
		} catch (error) {
			await this.repository.failStep({
				planId: input.planId,
				ownerId: input.ownerId,
				stepId,
				idempotencyKey: step.idempotencyKey,
				errorCode: toSafeErrorCode(error),
			});
			return { status: "failed", stepId };
		}
	}
}

type CompletedOutcome = { status: "completed"; stepId: string; result: unknown };
type ExecutionOutcome = CompletedOutcome | { status: "failed"; stepId: string };

function toSafeErrorCode(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	return /^[A-Z][A-Z0-9_]{2,127}$/.test(message) ? message : "READ_EXECUTION_FAILED";
}
