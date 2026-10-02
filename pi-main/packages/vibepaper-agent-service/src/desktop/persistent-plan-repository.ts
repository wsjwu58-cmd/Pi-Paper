import type { DatabaseSync } from "node:sqlite";
import { CanvasDependencyCompiler } from "../application/canvas-dependency-compiler.ts";
import { type CompiledPlan, PlanCompileError, PlanCompiler } from "../application/plan-compiler.ts";
import { claimPlanStep, completePlanStep, failPlanStep, releaseExpiredLeases } from "../application/plan-step-state.ts";
import type { TerminalStatus } from "../application/task-terminal-service.ts";
import type { AgentPlan, PlanStep, PlanStepStatus } from "../domain/agent-plan.ts";
import type { AgentProfile } from "../domain/tool-manifest.ts";
import { nextId } from "../infrastructure/ids.ts";

type PlanRow = {
	plan_id: string;
	session_id: string;
	version: number;
	canvas_version: number;
	status: string;
	plan_json: string;
};

type TaskPlanRow = PlanRow & { step_id: string };

export class DesktopPersistentPlanRepositoryError extends Error {
	readonly code: "NOT_FOUND" | "PERMISSION_DENIED" | "VERSION_CONFLICT";

	constructor(code: DesktopPersistentPlanRepositoryError["code"]) {
		super(code);
		this.name = "DesktopPersistentPlanRepositoryError";
		this.code = code;
	}
}

export class DesktopPlanInputError extends Error {
	readonly code = "INVALID_INPUT";
	readonly statusCode = 400;

	constructor(message: string) {
		super(message);
		this.name = "DesktopPlanInputError";
	}
}

export type DesktopPlanTaskTerminalStatus = TerminalStatus | "interrupted";

export type DesktopPlanTaskTerminalResult = {
	plan?: AgentPlan;
	updated: boolean;
};

export type DesktopPlanStepDto = Omit<PlanStep, "estimatedCost">;
export type DesktopAgentPlanDto = Omit<AgentPlan, "steps"> & { steps: DesktopPlanStepDto[] };
export type DesktopCompiledPlanDto = Omit<CompiledPlan, "plan" | "totalEstimatedCost"> & {
	plan: DesktopAgentPlanDto;
};
export type DesktopRerunPlanDto = DesktopAgentPlanDto & { rerunOf: string };

export type DesktopPlanCreateRequest = {
	plan: AgentPlan;
	profile: AgentProfile;
	expectedVersion: number;
};

const PLAN_TASK_TERMINAL_STATUSES = new Set<DesktopPlanTaskTerminalStatus>([
	"succeeded",
	"failed",
	"cancelled",
	"expired",
	"settlement_error",
	"interrupted",
]);

const PLAN_STEP_STATUSES = new Set<PlanStepStatus>(["pending", "running", "completed", "failed", "stale"]);
const MAX_PENDING_PLAN_TASK_IDS = 10_000;

/**
 * Local persistence adapter for the original plan application services.
 * The control database owner is responsible for schema migrations and closing
 * this connection; each mutation here is still an atomic SQLite transaction.
 * Startup never dispatches a stored step: task-backed steps are reconciled
 * against TaskStore, and unlinked read leases become claimable only after expiry.
 * A control-database backup therefore restores the plan and task association;
 * missing task records stay unresolved rather than being submitted again.
 */
export class DesktopPersistentPlanRepository {
	private readonly database: DatabaseSync;
	private readonly projectId: string;
	private readonly sessionExists: (sessionId: string) => Promise<boolean>;
	private readonly sessionActive: (sessionId: string) => Promise<boolean>;
	private readonly compiler = new PlanCompiler();
	private readonly dependencyCompiler = new CanvasDependencyCompiler();

	constructor(
		database: DatabaseSync,
		projectId: string,
		sessionExists: (sessionId: string) => Promise<boolean>,
		sessionActive: (sessionId: string) => Promise<boolean> = sessionExists,
	) {
		if (!projectId.trim()) throw new Error("PROJECT_ID_INVALID");
		this.database = database;
		this.projectId = projectId;
		this.sessionExists = sessionExists;
		this.sessionActive = sessionActive;
		this.assertSchemaAvailable();
	}

	async create(input: {
		ownerId: string;
		sessionId: string;
		plan: AgentPlan;
		expectedVersion: number;
		profile: AgentProfile;
	}): Promise<CompiledPlan> {
		this.assertOwner(input.ownerId);
		if (input.plan.sessionId !== input.sessionId) {
			throw new DesktopPersistentPlanRepositoryError("PERMISSION_DENIED");
		}
		await this.assertSessionActive(input.sessionId);
		const compiled = this.compiler.compile(input.plan, {
			expectedVersion: input.expectedVersion,
			profile: input.profile,
		});
		try {
			this.transaction(() => {
				const now = new Date().toISOString();
				this.insertPlan(input.plan, "draft", now);
			});
		} catch (error) {
			if (isConstraintError(error)) throw new DesktopPersistentPlanRepositoryError("VERSION_CONFLICT");
			throw error;
		}
		return compiled;
	}

	async get(planId: string, ownerId: string): Promise<AgentPlan> {
		this.assertOwner(ownerId);
		const row = this.requirePlanRow(planId);
		await this.assertSessionReadable(row.session_id);
		return toPlan(row);
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
		this.assertOwner(input.ownerId);
		const beforeRerun = this.requirePlanRow(input.planId);
		await this.assertSessionActive(beforeRerun.session_id);
		return this.transaction(() => {
			const current = this.requirePlan(input.planId);
			const impacted = new Set(this.dependencyCompiler.impactSet(current.steps, [input.stepId]));
			if (
				current.steps.some(
					(step) => impacted.has(step.id) && step.status === "running" && step.taskId !== undefined,
				)
			) {
				throw new DesktopPersistentPlanRepositoryError("VERSION_CONFLICT");
			}
			const compiledRerun = this.dependencyCompiler.rerun(current, input.stepId);
			const next: AgentPlan = {
				...compiledRerun,
				id: nextId(),
				steps: compiledRerun.steps.map((step) => (impacted.has(step.id) ? resetStepForRerun(step) : step)),
			};
			this.insertPlan(next, "draft", new Date().toISOString());
			return { ...next, estimatedCost: compiledRerun.estimatedCost, rerunOf: input.planId };
		});
	}

	async claimStep(input: {
		planId: string;
		ownerId: string;
		stepId: string;
		now?: Date;
		leaseDurationMs?: number;
	}): Promise<AgentPlan> {
		return this.mutate(
			input.planId,
			input.ownerId,
			(plan) => {
				const now = input.now ?? new Date();
				const recovered = releaseExpiredLeasesExceptTaskSteps(plan, now);
				return claimPlanStep(recovered, input.stepId, now, input.leaseDurationMs);
			},
			true,
		);
	}

	async completeStep(input: {
		planId: string;
		ownerId: string;
		stepId: string;
		idempotencyKey: string;
		outputRef?: string;
	}): Promise<AgentPlan> {
		return this.mutate(input.planId, input.ownerId, (plan) =>
			completePlanStep(plan, input.stepId, {
				idempotencyKey: input.idempotencyKey,
				outputRef: input.outputRef,
			}),
		);
	}

	async failStep(input: {
		planId: string;
		ownerId: string;
		stepId: string;
		idempotencyKey: string;
		errorCode: string;
	}): Promise<AgentPlan> {
		return this.mutate(input.planId, input.ownerId, (plan) =>
			failPlanStep(plan, input.stepId, {
				idempotencyKey: input.idempotencyKey,
				errorCode: input.errorCode,
			}),
		);
	}

	async attachTask(input: {
		planId: string;
		ownerId: string;
		stepId: string;
		idempotencyKey: string;
		taskId: string;
	}): Promise<AgentPlan> {
		return this.mutate(input.planId, input.ownerId, (plan) => {
			const step = plan.steps.find((candidate) => candidate.id === input.stepId);
			if (
				!step ||
				step.status !== "running" ||
				step.effect !== "create_task" ||
				step.idempotencyKey !== input.idempotencyKey ||
				step.taskId
			) {
				throw new DesktopPersistentPlanRepositoryError("VERSION_CONFLICT");
			}
			return {
				...plan,
				version: plan.version + 1,
				steps: plan.steps.map((candidate) =>
					candidate.id === input.stepId ? { ...candidate, taskId: input.taskId } : candidate,
				),
			};
		});
	}

	/**
	 * Applies an authoritative task terminal state once. Duplicate notifications
	 * return the current plan without advancing its version a second time.
	 */
	async applyTaskTerminal(input: {
		taskId: string;
		status: DesktopPlanTaskTerminalStatus;
		errorCode?: string;
		outputRef?: string;
	}): Promise<DesktopPlanTaskTerminalResult> {
		if (!PLAN_TASK_TERMINAL_STATUSES.has(input.status)) throw new Error("INVALID_TASK_TERMINAL_STATUS");
		const linked = this.findTaskPlanRow(input.taskId);
		if (!linked) return { updated: false };
		if (!(await this.sessionExists(linked.session_id))) return { updated: false };
		return this.transaction(() => {
			const row = this.findTaskPlanRow(input.taskId);
			if (!row) return { updated: false };
			const current = toPlan(row);
			const step = current.steps.find((candidate) => candidate.id === row.step_id);
			if (!step?.idempotencyKey || step.status !== "running") return { plan: current, updated: false };

			const outputRef =
				input.status === "succeeded" ? verifiedTaskOutputRef(input.taskId, input.outputRef) : undefined;
			const next =
				input.status === "succeeded" && outputRef !== undefined
					? completePlanStep(current, step.id, {
							idempotencyKey: step.idempotencyKey,
							outputRef,
						})
					: failPlanStep(current, step.id, {
							idempotencyKey: step.idempotencyKey,
							errorCode:
								input.errorCode ??
								(input.status === "succeeded" ? "TASK_OUTPUT_UNAVAILABLE" : defaultTaskErrorCode(input.status)),
						});
			this.persistMutation(current, next);
			return { plan: next, updated: true };
		});
	}

	/** Returns pending task links for authoritative startup/status reconciliation. */
	async listPendingTaskIds(): Promise<string[]> {
		const rows = this.database
			.prepare(
				`SELECT step.task_id, plan.session_id FROM agent_plan_steps step
				 JOIN agent_plans plan ON plan.plan_id = step.plan_id
				 WHERE step.status = 'running' AND step.task_id IS NOT NULL
				 ORDER BY plan.updated_at, plan.plan_id, step.rowid LIMIT ?`,
			)
			.all(MAX_PENDING_PLAN_TASK_IDS) as unknown as Array<{ task_id: string; session_id: string }>;
		const sessionExists = new Map<string, boolean>();
		const pending: string[] = [];
		for (const row of rows) {
			let exists = sessionExists.get(row.session_id);
			if (exists === undefined) {
				exists = await this.sessionExists(row.session_id);
				sessionExists.set(row.session_id, exists);
			}
			if (exists) pending.push(row.task_id);
		}
		return pending;
	}

	close(): void {
		this.database.close();
	}

	private async mutate(
		planId: string,
		ownerId: string,
		apply: (plan: AgentPlan) => AgentPlan,
		requireActive = false,
	): Promise<AgentPlan> {
		this.assertOwner(ownerId);
		const beforeMutation = this.requirePlanRow(planId);
		await this.assertSessionReadable(beforeMutation.session_id);
		if (requireActive) await this.assertSessionActive(beforeMutation.session_id);
		try {
			return this.transaction(() => {
				const current = this.requirePlan(planId);
				const next = apply(current);
				this.persistMutation(current, next);
				return next;
			});
		} catch (error) {
			if (isConstraintError(error)) throw new DesktopPersistentPlanRepositoryError("VERSION_CONFLICT");
			throw error;
		}
	}

	private persistMutation(current: AgentPlan, next: AgentPlan): void {
		const result = this.database
			.prepare(
				`UPDATE agent_plans SET version = ?, status = ?, plan_json = ?, updated_at = ?
				 WHERE plan_id = ? AND version = ?`,
			)
			.run(next.version, planStatus(next), JSON.stringify(next), new Date().toISOString(), next.id, current.version);
		if (Number(result.changes) !== 1) throw new DesktopPersistentPlanRepositoryError("VERSION_CONFLICT");
		for (const step of next.steps) this.upsertStep(next.id, step);
	}

	private insertPlan(plan: AgentPlan, status: "draft", now: string): void {
		this.database
			.prepare(
				`INSERT INTO agent_plans (plan_id, session_id, version, canvas_version, status, plan_json, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(plan.id, plan.sessionId, plan.version, plan.canvasVersion, status, JSON.stringify(plan), now, now);
		for (const step of plan.steps) this.upsertStep(plan.id, step);
	}

	private upsertStep(planId: string, step: PlanStep): void {
		this.database
			.prepare(
				`INSERT INTO agent_plan_steps (plan_id, step_id, status, task_id, idempotency_key, step_json)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(plan_id, step_id) DO UPDATE SET
					status = excluded.status,
					task_id = excluded.task_id,
					idempotency_key = excluded.idempotency_key,
					step_json = excluded.step_json`,
			)
			.run(planId, step.id, step.status, step.taskId ?? null, step.idempotencyKey ?? null, JSON.stringify(step));
	}

	private requirePlan(planId: string): AgentPlan {
		return toPlan(this.requirePlanRow(planId));
	}

	private requirePlanRow(planId: string): PlanRow {
		const row = this.database
			.prepare(
				`SELECT plan_id, session_id, version, canvas_version, status, plan_json
				 FROM agent_plans WHERE plan_id = ?`,
			)
			.get(planId) as unknown as PlanRow | undefined;
		if (!row) throw new DesktopPersistentPlanRepositoryError("NOT_FOUND");
		return row;
	}

	private findTaskPlanRow(taskId: string): TaskPlanRow | undefined {
		return this.database
			.prepare(
				`SELECT plan.plan_id, plan.session_id, plan.version, plan.canvas_version, plan.status, plan.plan_json,
					step.step_id
				 FROM agent_plans plan JOIN agent_plan_steps step ON step.plan_id = plan.plan_id
				 WHERE step.task_id = ?`,
			)
			.get(taskId) as unknown as TaskPlanRow | undefined;
	}

	private async assertSessionReadable(sessionId: string): Promise<void> {
		if (!(await this.sessionExists(sessionId))) throw new DesktopPersistentPlanRepositoryError("NOT_FOUND");
	}

	private async assertSessionActive(sessionId: string): Promise<void> {
		if (!(await this.sessionExists(sessionId))) throw new DesktopPersistentPlanRepositoryError("PERMISSION_DENIED");
		if (!(await this.sessionActive(sessionId))) throw new DesktopPersistentPlanRepositoryError("PERMISSION_DENIED");
	}

	private assertOwner(ownerId: string): void {
		if (ownerId !== this.projectId) throw new DesktopPersistentPlanRepositoryError("PERMISSION_DENIED");
	}

	private assertSchemaAvailable(): void {
		this.database
			.prepare("SELECT plan_id, session_id, version, canvas_version, status, plan_json FROM agent_plans LIMIT 0")
			.get();
		this.database
			.prepare("SELECT plan_id, step_id, status, task_id, idempotency_key, step_json FROM agent_plan_steps LIMIT 0")
			.get();
	}

	private transaction<T>(operation: () => T): T {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch {
				// Keep the original failure when rollback cannot run.
			}
			throw error;
		}
	}
}

/** Mirrors the source API's plan DTO validation; desktop input remains local and user-scoped. */
export function parseDesktopAgentPlan(value: unknown, sessionId: string): AgentPlan {
	const body = recordBody(value);
	if (!Array.isArray(body.steps)) throw new DesktopPlanInputError("plan.steps 必须是数组");
	const steps: PlanStep[] = body.steps.map((item) => {
		const step = recordBody(item);
		const status = step.status ?? "pending";
		if (typeof status !== "string" || !PLAN_STEP_STATUSES.has(status as PlanStepStatus)) {
			throw new DesktopPlanInputError("plan step status 无效");
		}
		const parsed: PlanStep = {
			id: requiredString(step.id, "step.id"),
			tool: requiredString(step.tool, "step.tool"),
			dependsOn: stringArray(step.dependsOn ?? []),
			status: status as PlanStepStatus,
			inputHash: requiredString(step.inputHash, "step.inputHash"),
			estimatedCost: requiredInteger(step.estimatedCost ?? 0, "step.estimatedCost"),
		};
		const input = step.input ?? step.params;
		if (input !== undefined) parsed.input = objectOrEmpty(input);
		if (step.batchSize !== undefined) parsed.batchSize = requiredInteger(step.batchSize, "step.batchSize");
		if (step.effect !== undefined) parsed.effect = requiredPlanStepEffect(step.effect, "step.effect");
		if (step.concurrencyKey !== undefined)
			parsed.concurrencyKey = requiredString(step.concurrencyKey, "step.concurrencyKey");
		return parsed;
	});
	return {
		id: requiredId(body.id, "plan.id"),
		sessionId,
		version: requiredInteger(body.version, "plan.version"),
		canvasVersion: requiredInteger(body.canvasVersion, "plan.canvasVersion"),
		steps,
	};
}

export function parseDesktopPlanCreateRequest(value: unknown, sessionId: string): DesktopPlanCreateRequest {
	const body = recordBody(value);
	const plan = parseDesktopAgentPlan(body.plan ?? body, sessionId);
	return {
		plan,
		profile: parseDesktopAgentProfile(body.profile),
		expectedVersion: requiredInteger(body.expectedVersion ?? plan.version, "expectedVersion"),
	};
}

export function parseDesktopPlanRerunRequest(value: unknown): { stepId: string } {
	const body = recordBody(value);
	return { stepId: requiredString(body.stepId, "stepId") };
}

export function parseDesktopPlanId(value: unknown): string {
	return requiredId(value, "planId");
}

export function parseDesktopAgentProfile(value: unknown): AgentProfile {
	if (
		value === "canvas-general" ||
		value === "vertical-short-drama" ||
		value === "asset-assistant" ||
		value === "audit-readonly"
	) {
		return value;
	}
	throw new DesktopPlanInputError("profile 无效");
}

export const desktopPlanProfile = parseDesktopAgentProfile;

export function desktopPlanResponse(value: AgentPlan & { estimatedCost: number; rerunOf: string }): DesktopRerunPlanDto;
export function desktopPlanResponse(value: CompiledPlan): DesktopCompiledPlanDto;
export function desktopPlanResponse(value: AgentPlan): DesktopAgentPlanDto;
export function desktopPlanResponse(
	value: AgentPlan | CompiledPlan | (AgentPlan & { estimatedCost: number; rerunOf: string }),
): DesktopAgentPlanDto | DesktopCompiledPlanDto | DesktopRerunPlanDto {
	if ("rerunOf" in value) {
		const { estimatedCost, rerunOf, ...plan } = value;
		void estimatedCost;
		return { ...withoutStepCosts(plan), rerunOf };
	}
	if ("executionPartitions" in value) {
		const { totalEstimatedCost, plan, ...compiled } = value;
		void totalEstimatedCost;
		return { ...compiled, plan: withoutStepCosts(plan) };
	}
	return withoutStepCosts(value);
}

function withoutStepCosts(plan: AgentPlan): DesktopAgentPlanDto {
	return {
		...plan,
		steps: plan.steps.map((step) => {
			const { estimatedCost, ...result } = step;
			void estimatedCost;
			return result;
		}),
	};
}

function releaseExpiredLeasesExceptTaskSteps(plan: AgentPlan, now: Date): AgentPlan {
	const planStepsWithoutTasks = plan.steps.filter((step) => step.taskId === undefined);
	const released = releaseExpiredLeases({ ...plan, steps: planStepsWithoutTasks }, now);
	if (released.version === plan.version) return plan;
	const releasedById = new Map(released.steps.map((step) => [step.id, step]));
	return {
		...plan,
		version: released.version,
		steps: plan.steps.map((step) => releasedById.get(step.id) ?? step),
	};
}

function resetStepForRerun(step: PlanStep): PlanStep {
	const next: PlanStep = { ...step, status: "pending" };
	delete next.idempotencyKey;
	delete next.taskId;
	delete next.leaseUntil;
	delete next.attemptCount;
	delete next.outputRef;
	delete next.lastError;
	return next;
}

function toPlan(row: PlanRow): AgentPlan {
	let value: unknown;
	try {
		value = JSON.parse(row.plan_json) as unknown;
	} catch {
		throw new PlanCompileError("INVALID_DEPENDENCY");
	}
	if (
		!isRecord(value) ||
		value.id !== row.plan_id ||
		!Array.isArray(value.steps) ||
		!Number.isSafeInteger(row.version) ||
		!Number.isSafeInteger(row.canvas_version)
	) {
		throw new PlanCompileError("INVALID_DEPENDENCY");
	}
	const steps = value.steps.map(decodePlanStep);
	return {
		id: row.plan_id,
		sessionId: row.session_id,
		version: row.version,
		canvasVersion: row.canvas_version,
		steps,
	};
}

function decodePlanStep(value: unknown): PlanStep {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.tool !== "string" ||
		!Array.isArray(value.dependsOn) ||
		!value.dependsOn.every((dependency) => typeof dependency === "string") ||
		typeof value.inputHash !== "string" ||
		typeof value.estimatedCost !== "number" ||
		!Number.isSafeInteger(value.estimatedCost) ||
		value.estimatedCost < 0 ||
		typeof value.status !== "string" ||
		!PLAN_STEP_STATUSES.has(value.status as PlanStepStatus)
	) {
		throw new PlanCompileError("INVALID_DEPENDENCY");
	}
	return value as unknown as PlanStep;
}

function planStatus(plan: AgentPlan): "draft" | "running" | "failed" | "completed" {
	if (plan.steps.some((step) => step.status === "failed")) return "failed";
	if (plan.steps.length > 0 && plan.steps.every((step) => step.status === "completed")) return "completed";
	if (plan.steps.some((step) => step.status === "running")) return "running";
	return "draft";
}

function verifiedTaskOutputRef(taskId: string, outputRef: string | undefined): string | undefined {
	if (!/^[A-Za-z0-9_-]{1,128}$/u.test(taskId)) return undefined;
	const expected = `vibe://app/tasks/${taskId}/output`;
	return outputRef === expected ? expected : undefined;
}

function defaultTaskErrorCode(status: Exclude<DesktopPlanTaskTerminalStatus, "succeeded">): string {
	if (status === "interrupted") return "TASK_INTERRUPTED";
	if (status === "cancelled") return "TASK_CANCELLED";
	if (status === "settlement_error") return "TASK_SETTLEMENT_ERROR";
	if (status === "expired") return "TASK_EXPIRED";
	return "TASK_FAILED";
}

function recordBody(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new DesktopPlanInputError("请求体必须是对象");
	return value as Record<string, unknown>;
}

function requiredId(value: unknown, field: string): string {
	if (typeof value !== "string" && typeof value !== "number") throw new DesktopPlanInputError(`缺少或非法 ${field}`);
	const normalized = String(value).trim();
	if (!/^\d+$/.test(normalized) || normalized === "0") throw new DesktopPlanInputError(`缺少或非法 ${field}`);
	return normalized;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new DesktopPlanInputError(`缺少或非法 ${field}`);
	return value.trim();
}

function requiredInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
		throw new DesktopPlanInputError(`缺少或非法 ${field}`);
	return value;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
		throw new DesktopPlanInputError("字段必须是非空字符串数组");
	}
	return value.map((item) => (item as string).trim());
}

function requiredPlanStepEffect(value: unknown, field: string): "read" | "write_canvas" | "create_task" {
	if (value === "read" || value === "write_canvas" || value === "create_task") return value;
	throw new DesktopPlanInputError(`${field} 无效`);
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConstraintError(error: unknown): boolean {
	return error instanceof Error && /(?:UNIQUE|PRIMARY KEY) constraint failed/u.test(error.message);
}
