import type { QueryResultRow } from "pg";
import { CanvasDependencyCompiler } from "../application/canvas-dependency-compiler.ts";
import type { CompiledPlan } from "../application/plan-compiler.ts";
import { PlanCompileError, PlanCompiler } from "../application/plan-compiler.ts";
import {
	claimPlanStep,
	completePlanStep,
	failPlanStep,
	releaseExpiredLeases,
} from "../application/plan-step-state.ts";
import type { AgentPlan, PlanStep } from "../domain/agent-plan.ts";
import type { AgentProfile } from "../domain/tool-manifest.ts";
import { nextId } from "./ids.ts";
import type { MigrationDatabase } from "./migrations.ts";

type PlanRow = QueryResultRow & {
	id: string;
	session_id: string;
	version: number;
	canvas_version: number;
	status: string;
	plan_json: unknown;
};

export class PlanRepositoryError extends Error {
	readonly code: "NOT_FOUND" | "PERMISSION_DENIED" | "VERSION_CONFLICT";

	constructor(code: PlanRepositoryError["code"]) {
		super(code);
		this.name = "PlanRepositoryError";
		this.code = code;
	}
}

export class PgPlanRepository {
	private readonly compiler = new PlanCompiler();
	private readonly dependencyCompiler = new CanvasDependencyCompiler();
	private readonly database: MigrationDatabase;

	constructor(database: MigrationDatabase) {
		this.database = database;
	}

	async create(input: {
		ownerId: string;
		sessionId: string;
		plan: AgentPlan;
		expectedVersion: number;
		profile: AgentProfile;
	}): Promise<CompiledPlan> {
		await this.requireSession(input.ownerId, input.sessionId);
		const compiled = this.compiler.compile(input.plan, {
			expectedVersion: input.expectedVersion,
			profile: input.profile,
		});
		await this.database.transaction(async (client) => {
			await client.query(
				`INSERT INTO agent_plans (id, session_id, version, canvas_version, status, plan_json, created_by)
				 VALUES ($1, $2, $3, $4, 'draft', $5::jsonb, $6)`,
				[
					input.plan.id,
					input.sessionId,
					input.plan.version,
					input.plan.canvasVersion,
					JSON.stringify(input.plan),
					input.ownerId,
				],
			);
			for (const step of input.plan.steps) await this.insertStep(client, input.plan.id, step);
		});
		return compiled;
	}

	async get(planId: string, ownerId: string): Promise<AgentPlan> {
		const result = await this.database.query<PlanRow>(
			`SELECT plan.id, plan.session_id, plan.version, plan.canvas_version, plan.status, plan.plan_json
			 FROM agent_plans plan JOIN agent_sessions session ON session.id = plan.session_id
			 WHERE plan.id = $1 AND session.user_id = $2`,
			[planId, ownerId],
		);
		const row = result.rows[0];
		if (!row) throw new PlanRepositoryError("NOT_FOUND");
		return toPlan(row.plan_json, row);
	}

	async readySet(planId: string, ownerId: string, profile: AgentProfile): Promise<CompiledPlan> {
		const plan = await this.get(planId, ownerId);
		return this.compiler.compile(plan, { expectedVersion: plan.version, profile });
	}

	async rerun(input: {
		planId: string;
		ownerId: string;
		stepId: string;
	}): Promise<AgentPlan & { estimatedCost: number; rerunOf: string }> {
		const current = await this.get(input.planId, input.ownerId);
		const rerun = this.dependencyCompiler.rerun(current, input.stepId);
		const next: AgentPlan = { ...rerun, id: nextId() };
		await this.database.transaction(async (client) => {
			await client.query(
				`INSERT INTO agent_plans (id, session_id, version, canvas_version, status, plan_json, created_by)
				 SELECT $1, session_id, $2, canvas_version, 'draft', $3::jsonb, $4
				 FROM agent_plans WHERE id = $5`,
				[next.id, next.version, JSON.stringify(next), input.ownerId, input.planId],
			);
			for (const step of next.steps) await this.insertStep(client, next.id, step);
		});
		return { ...next, estimatedCost: rerun.estimatedCost, rerunOf: input.planId };
	}

	async claimStep(input: {
		planId: string;
		ownerId: string;
		stepId: string;
		now?: Date;
		leaseDurationMs?: number;
	}): Promise<AgentPlan> {
		const now = input.now ?? new Date();
		return await this.mutate(input.planId, input.ownerId, (plan) =>
			claimPlanStep(releaseExpiredLeases(plan, now), input.stepId, now, input.leaseDurationMs),
		);
	}

	async completeStep(input: {
		planId: string;
		ownerId: string;
		stepId: string;
		idempotencyKey: string;
		outputRef?: string;
	}): Promise<AgentPlan> {
		return await this.mutate(input.planId, input.ownerId, (plan) =>
			completePlanStep(plan, input.stepId, { idempotencyKey: input.idempotencyKey, outputRef: input.outputRef }),
		);
	}

	async failStep(input: {
		planId: string;
		ownerId: string;
		stepId: string;
		idempotencyKey: string;
		errorCode: string;
	}): Promise<AgentPlan> {
		return await this.mutate(input.planId, input.ownerId, (plan) =>
			failPlanStep(plan, input.stepId, { idempotencyKey: input.idempotencyKey, errorCode: input.errorCode }),
		);
	}

	private async mutate(
		planId: string,
		ownerId: string,
		apply: (plan: AgentPlan) => AgentPlan,
	): Promise<AgentPlan> {
		return await this.database.transaction(async (client) => {
			const result = await client.query<PlanRow>(
				`SELECT plan.id, plan.session_id, plan.version, plan.canvas_version, plan.status, plan.plan_json
				 FROM agent_plans plan JOIN agent_sessions session ON session.id = plan.session_id
				 WHERE plan.id = $1 AND session.user_id = $2 FOR UPDATE OF plan`,
				[planId, ownerId],
			);
			const row = result.rows[0];
			if (!row) throw new PlanRepositoryError("NOT_FOUND");
			const current = toPlan(row.plan_json, row);
			const next = apply(current);
			const status = planStatus(next);
			const updated = await client.query<{ id: string }>(
				`UPDATE agent_plans SET version = $1, status = $2, plan_json = $3::jsonb, updated_at = now()
				 WHERE id = $4 AND version = $5 RETURNING id`,
				[next.version, status, JSON.stringify(next), next.id, current.version],
			);
			if (updated.rows.length !== 1) throw new PlanRepositoryError("VERSION_CONFLICT");
			for (const step of next.steps) await this.updateStepProjection(client, next.id, step);
			return next;
		});
	}

	private async requireSession(ownerId: string, sessionId: string): Promise<void> {
		const result = await this.database.query<{ id: string }>(
			"SELECT id FROM agent_sessions WHERE id = $1 AND user_id = $2 AND COALESCE(status, 'active') <> 'deleted'",
			[sessionId, ownerId],
		);
		if (!result.rows[0]) throw new PlanRepositoryError("PERMISSION_DENIED");
	}

	private async insertStep(
		client: { query<T extends QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[] }> },
		planId: string,
		step: PlanStep,
	): Promise<void> {
		await client.query(
			`INSERT INTO agent_plan_steps
			 (id, plan_id, step_key, tool_name, depends_on, status, input_hash, estimated_cost, effect, concurrency_key, idempotency_key, lease_until, attempt_count, output_ref, last_error)
			 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
			[
				nextId(),
				planId,
				step.id,
				step.tool,
				JSON.stringify(step.dependsOn),
				step.status,
				step.inputHash,
				step.estimatedCost,
				step.effect ?? null,
				step.concurrencyKey ?? null,
				step.idempotencyKey ?? null,
				step.leaseUntil ?? null,
				step.attemptCount ?? 0,
				step.outputRef ?? null,
				step.lastError ?? null,
			],
		);
	}

	private async updateStepProjection(
		client: { query<T extends QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[] }> },
		planId: string,
		step: PlanStep,
	): Promise<void> {
		await client.query(
			`UPDATE agent_plan_steps SET status = $1, effect = $2, concurrency_key = $3, idempotency_key = $4,
			 lease_until = $5, attempt_count = $6, output_ref = $7, last_error = $8
			 WHERE plan_id = $9 AND step_key = $10`,
			[
				step.status,
				step.effect ?? null,
				step.concurrencyKey ?? null,
				step.idempotencyKey ?? null,
				step.leaseUntil ?? null,
				step.attemptCount ?? 0,
				step.outputRef ?? null,
				step.lastError ?? null,
				planId,
				step.id,
			],
		);
	}
}

function toPlan(value: unknown, row: PlanRow): AgentPlan {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new PlanCompileError("INVALID_DEPENDENCY");
	const plan = value as Partial<AgentPlan>;
	if (typeof plan.id !== "string" || !Array.isArray(plan.steps)) throw new PlanCompileError("INVALID_DEPENDENCY");
	return {
		id: plan.id,
		sessionId: row.session_id,
		version: row.version,
		canvasVersion: row.canvas_version,
		steps: plan.steps as PlanStep[],
	};
}

function planStatus(plan: AgentPlan): string {
	if (plan.steps.some((step) => step.status === "failed")) return "failed";
	if (plan.steps.length > 0 && plan.steps.every((step) => step.status === "completed")) return "completed";
	if (plan.steps.some((step) => step.status === "running")) return "running";
	return "draft";
}
