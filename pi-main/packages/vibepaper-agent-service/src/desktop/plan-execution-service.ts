import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import type { AgentSkillContext } from "../application/agent-runtime.ts";
import { ApprovalService } from "../application/approval-service.ts";
import { type PlanExecutionRepository, PlanExecutionService } from "../application/plan-execution-service.ts";
import { ToolGatewayReadPlanStepExecutor } from "../application/read-plan-step-executor.ts";
import { SessionRunService } from "../application/session-run-service.ts";
import type { PlannedAction } from "../domain/action-approval.ts";
import type { AgentPlan, PlanStep } from "../domain/agent-plan.ts";
import type { AuditInput } from "../domain/continuity-rules.ts";
import type { AgentProfile } from "../domain/tool-manifest.ts";
import { nextId } from "../infrastructure/ids.ts";
import { ReadTools } from "../tools/read-tools.ts";
import {
	createRuntimeTools,
	desktopGenerationConfirmationItems,
	type RuntimeToolContext,
	type RuntimeToolGateway,
} from "../tools/runtime-tools.ts";
import { createLoadSkillTool } from "../tools/skill-tools.ts";
import type { DesktopAgentStores } from "./agent-stores.ts";
import { confirmDesktopDeleteAction, type DesktopDeletionConfirmationInput } from "./deletion-confirmation.ts";
import { confirmDesktopGenerationAction, type DesktopGenerationConfirmationInput } from "./generation-confirmation.ts";
import {
	type DesktopPlanExecutionRecord,
	type DesktopPlanExecutionState,
	type DesktopPlanExecutionTask,
	desktopPlanResponse,
} from "./persistent-plan-repository.ts";
import type { DesktopTaskReader } from "./task-status-sync.ts";

export type DesktopPlanGatewayScope = {
	sessionId: string;
	runId: string;
	canvasId: string;
	canvasVersion: number;
	gateway: RuntimeToolGateway;
};

export type DesktopPlanExecutionServiceOptions = {
	gatewayFactory: (input: { sessionId: string; runId: string }) => RuntimeToolGateway | Promise<RuntimeToolGateway>;
	readTask: DesktopTaskReader;
	skillContextFactory?: (sessionId: string) => AgentSkillContext | Promise<AgentSkillContext>;
	onAuditRequested?: (
		input: AuditInput & { targetNodeId: string },
		context: DesktopPlanGatewayScope,
	) => Promise<Record<string, unknown>>;
	requestId?: string;
};

export type DesktopPlanExecutionSnapshot = {
	planId: string;
	state: DesktopPlanExecutionState;
	plan: ReturnType<typeof desktopPlanResponse>;
	executions: Array<Omit<DesktopPlanExecutionRecord, "updatedAt"> & { updatedAt: string }>;
	taskIds: string[];
	stopRequested: boolean;
	lastEventSeq?: number;
	runId?: string;
	stepId?: string;
	actionId?: string;
	errorCode?: string;
};

type ExecutionRequest = { planId: string; canvasId: string; profile: AgentProfile; requestId?: string };
type ConfirmationInput = DesktopGenerationConfirmationInput | DesktopDeletionConfirmationInput;
type StepRunInput = { plan: AgentPlan; step: PlanStep; canvasId: string; profile: AgentProfile };

const READ_TOOL_NAMES = new Set([
	"get_canvas_summary",
	"get_selected_nodes",
	"get_node_detail",
	"list_models",
	"search_assets",
	"check_task_status",
]);
const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

/**
 * Desktop plan execution adapter. The plan compiler and the original runtime
 * tools remain the authority for effects, schemas, confirmation, and task
 * submission. This class only connects those services to local persistent
 * execution rows and never replays an uncertain write after restart.
 */
export class DesktopPlanExecutionService {
	private readonly stores: DesktopAgentStores;
	private readonly gatewayFactory: DesktopPlanExecutionServiceOptions["gatewayFactory"];
	private readonly readTask: DesktopTaskReader;
	private readonly skillContextFactory?: DesktopPlanExecutionServiceOptions["skillContextFactory"];
	private readonly onAuditRequested?: DesktopPlanExecutionServiceOptions["onAuditRequested"];
	private readonly requestId?: string;
	private readonly ownerId: string;
	private readonly runs: SessionRunService;
	private readonly active = new Map<string, Promise<DesktopPlanExecutionSnapshot | null>>();
	private readonly inFlight = new Set<Promise<unknown>>();
	private readonly cancelledRuns = new Set<string>();
	private dispatchStopped = false;

	constructor(stores: DesktopAgentStores, options: DesktopPlanExecutionServiceOptions) {
		this.stores = stores;
		this.gatewayFactory = options.gatewayFactory;
		this.readTask = options.readTask;
		this.skillContextFactory = options.skillContextFactory;
		this.onAuditRequested = options.onAuditRequested;
		this.requestId = options.requestId;
		this.ownerId = stores.projectId;
		this.runs = new SessionRunService(stores.control);
	}

	/** Execute only after the caller explicitly asks. Plan creation stays inert. */
	async execute(input: ExecutionRequest): Promise<DesktopPlanExecutionSnapshot | null> {
		const existing = this.active.get(input.planId);
		if (existing) return await existing;
		if (this.dispatchStopped) return await this.getExecution({ planId: input.planId });
		const work = this.track(this.drivePlan(input));
		this.active.set(input.planId, work);
		try {
			return await work;
		} finally {
			if (this.active.get(input.planId) === work) this.active.delete(input.planId);
		}
	}

	/** Read persisted execution state without scheduling or dispatching work. */
	async getExecution(input: { planId: string }): Promise<DesktopPlanExecutionSnapshot | null> {
		const plan = await this.stores.plans.get(input.planId, this.ownerId);
		const [records, context] = await Promise.all([
			this.stores.plans.getExecution({ planId: input.planId, ownerId: this.ownerId }),
			this.stores.plans.getExecutionContext({ planId: input.planId, ownerId: this.ownerId }),
		]);
		if (records.length === 0) return null;
		const tasks = await this.stores.plans.listExecutionTasks({ planId: input.planId, ownerId: this.ownerId });
		const latest = [...records].sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0];
		const state = aggregateState(plan, records, context?.stopRequested ?? false);
		const events = await this.runs.listEvents(latest.runId);
		const failure = plan.steps.find((step) => step.status === "failed");
		return {
			planId: input.planId,
			state,
			plan: desktopPlanResponse(plan),
			executions: records.map((record) => ({
				...record,
				updatedAt: record.updatedAt.toISOString(),
			})),
			taskIds: tasks.map((task) => task.taskId),
			stopRequested: context?.stopRequested ?? false,
			lastEventSeq: events.at(-1)?.eventSeq ?? 0,
			runId: latest.runId,
			stepId: latest.stepId,
			...(latest.actionId ? { actionId: latest.actionId } : {}),
			...((latest.errorCode ?? failure?.lastError) ? { errorCode: latest.errorCode ?? failure?.lastError } : {}),
		};
	}

	handlesAction(actionId: unknown): boolean {
		if (typeof actionId !== "string" || !actionId) return false;
		return Boolean(
			this.stores.control.find(actionId)?.action.runId && this.stores.plans.hasExecutionForActionSync(actionId),
		);
	}

	/** Keep the existing confirmation IPC result shape expected by the Renderer. */
	async confirm(
		input: ConfirmationInput,
	): Promise<{ actionId: string; status: "accepted" | "rejected"; lastEventSeq: number }> {
		return await this.track(this.confirmOnce(input));
	}

	private async confirmOnce(
		input: ConfirmationInput,
	): Promise<{ actionId: string; status: "accepted" | "rejected"; lastEventSeq: number }> {
		const execution = await this.stores.plans.getExecutionForAction({
			actionId: input.actionId,
			ownerId: this.ownerId,
		});
		if (!execution) throw new Error("CONFIRMATION_REQUIRED");
		const context = await this.stores.plans.getExecutionContext({ planId: execution.planId, ownerId: this.ownerId });
		if (!context?.canvasId || !context.profile) throw new Error("PLAN_EXECUTION_CONTEXT_INVALID");
		const plan = await this.stores.plans.get(execution.planId, this.ownerId);
		const step = plan.steps.find((candidate) => candidate.id === execution.stepId);
		if (!step) throw new Error("PLAN_STEP_NOT_FOUND");
		const actionRecord = await this.stores.control.find(input.actionId);
		if (!actionRecord || actionRecord.action.runId !== execution.runId) throw new Error("CONFIRMATION_REQUIRED");
		if (context.stopRequested || this.cancelledRuns.has(execution.runId)) throw new Error("CONFIRMATION_INVALIDATED");
		const gateway = await this.gatewayFactory({ sessionId: plan.sessionId, runId: execution.runId });
		const guardedGateway = this.guardGateway(execution.planId, execution.runId, gateway);
		const confirmInput = { ...input, projectId: this.ownerId, canvasId: context.canvasId, sessionId: plan.sessionId };
		let result: { actionId: string; status: "accepted" | "rejected"; lastEventSeq: number };
		try {
			if (isGenerationTool(actionRecord.action.toolName)) {
				result = await confirmDesktopGenerationAction(
					confirmInput as DesktopGenerationConfirmationInput,
					this.stores,
					guardedGateway,
				);
			} else if (actionRecord.action.toolName === "delete_nodes") {
				result = await confirmDesktopDeleteAction(
					confirmInput as DesktopDeletionConfirmationInput,
					this.stores,
					guardedGateway,
				);
			} else {
				throw new Error("CONFIRMATION_REQUIRED");
			}
		} catch (error) {
			const refreshed = await this.stores.control.find(input.actionId);
			if (refreshed?.status === "consumed") {
				const context = await this.stores.plans.getExecutionContext({
					planId: execution.planId,
					ownerId: this.ownerId,
				});
				const stopped = context?.stopRequested || this.cancelledRuns.has(execution.runId);
				const links = this.stores.control
					.listTaskLinks(execution.runId)
					.filter((link) => link.actionId === input.actionId);
				if (links.length > 0)
					await this.stores.plans
						.attachExecutionTasks({
							ownerId: this.ownerId,
							planId: execution.planId,
							stepId: execution.stepId,
							actionId: input.actionId,
							tasks: links.map((link) => ({
								taskId: link.taskId,
								status: initialExecutionTaskStatus(link.status),
							})),
						})
						.catch(() => undefined);
				if (stopped)
					await this.stores.plans
						.saveExecution({
							ownerId: this.ownerId,
							planId: execution.planId,
							stepId: execution.stepId,
							canvasId: execution.canvasId,
							profile: execution.profile,
							runId: execution.runId,
							state: "cancelled",
							actionId: input.actionId,
							errorCode: "PLAN_CANCELLED",
						})
						.catch(() => undefined);
				else
					await this.stores.plans.saveExecution({
						ownerId: this.ownerId,
						planId: execution.planId,
						stepId: execution.stepId,
						canvasId: execution.canvasId,
						profile: execution.profile,
						runId: execution.runId,
						state: links.length > 0 ? "waiting_task" : "reconciliation_required",
						actionId: input.actionId,
						errorCode: safeErrorCode(error, "CONFIRMATION_RESULT_UNCERTAIN"),
					});
			}
			throw error;
		}

		if (result.status === "rejected") {
			await this.failPlanStep(execution.planId, execution.stepId, "CONFIRMATION_REJECTED");
			await this.stores.plans.saveExecution({
				ownerId: this.ownerId,
				planId: execution.planId,
				stepId: execution.stepId,
				canvasId: execution.canvasId,
				profile: execution.profile,
				runId: execution.runId,
				state: "failed",
				actionId: input.actionId,
				errorCode: "CONFIRMATION_REJECTED",
			});
			return result;
		}
		const currentExecution = await this.stores.plans.getExecutionForAction({
			actionId: input.actionId,
			ownerId: this.ownerId,
		});
		if (currentExecution?.state === "completed" || currentExecution?.state === "failed") return result;
		if (currentExecution?.state === "cancelled") {
			const links = this.stores.control
				.listTaskLinks(execution.runId)
				.filter((link) => link.actionId === input.actionId);
			if (links.length > 0)
				await this.stores.plans
					.attachExecutionTasks({
						ownerId: this.ownerId,
						planId: execution.planId,
						stepId: execution.stepId,
						actionId: input.actionId,
						tasks: links.map((link) => ({
							taskId: link.taskId,
							status: initialExecutionTaskStatus(link.status),
						})),
					})
					.catch(() => undefined);
			return result;
		}

		if (isGenerationTool(actionRecord.action.toolName)) {
			const links = this.stores.control
				.listTaskLinks(execution.runId)
				.filter((link) => link.actionId === input.actionId);
			if (links.length === 0) {
				await this.stores.plans.saveExecution({
					ownerId: this.ownerId,
					planId: execution.planId,
					stepId: execution.stepId,
					canvasId: execution.canvasId,
					profile: execution.profile,
					runId: execution.runId,
					state: "reconciliation_required",
					actionId: input.actionId,
					errorCode: "TASK_LINKS_UNAVAILABLE",
				});
			} else {
				await this.stores.plans.attachExecutionTasks({
					ownerId: this.ownerId,
					planId: execution.planId,
					stepId: execution.stepId,
					actionId: input.actionId,
					tasks: links.map((link) => ({ taskId: link.taskId, status: initialExecutionTaskStatus(link.status) })),
				});
				await this.stores.plans.saveExecution({
					ownerId: this.ownerId,
					planId: execution.planId,
					stepId: execution.stepId,
					canvasId: execution.canvasId,
					profile: execution.profile,
					runId: execution.runId,
					state: "waiting_task",
					actionId: input.actionId,
				});
			}
			return result;
		}

		await this.finishConfirmedDelete(execution, input.actionId);
		if (!this.dispatchStopped)
			await this.execute({ planId: execution.planId, canvasId: context.canvasId, profile: context.profile });
		return result;
	}

	async onTaskTerminal(taskId: string): Promise<void> {
		const execution = await this.stores.plans.getExecutionForTask({ taskId, ownerId: this.ownerId });
		if (!execution) return;
		const update = await this.readAuthoritativeTask(taskId, execution.runId);
		if (!update) return;
		const stored = this.stores.control.recordTaskStatus(update.controlUpdate, { projectId: this.ownerId });
		if (stored.event || stored.changed)
			await this.stores.sessions.flushOutbox(this.stores.control, await this.sessionIdForRun(execution.runId));
		const result = await this.stores.plans.updateExecutionTask({
			ownerId: this.ownerId,
			taskId,
			status: update.status,
			...(update.errorCode ? { errorCode: update.errorCode } : {}),
			...(update.outputRef ? { outputRef: update.outputRef } : {}),
		});
		if (!result.record || !TERMINAL_TASK_STATUSES.has(update.status)) return;
		const context = await this.stores.plans.getExecutionContext({ planId: execution.planId, ownerId: this.ownerId });
		if (context?.stopRequested || this.cancelledRuns.has(execution.runId) || result.record.state === "cancelled")
			return;
		if (result.tasks.some((task) => !TERMINAL_TASK_STATUSES.has(task.status))) return;
		if (result.record.state === "completed")
			await this.completePlanStep(execution.planId, execution.stepId, result.tasks);
		else
			await this.failPlanStep(
				execution.planId,
				execution.stepId,
				result.record.errorCode ?? "GENERATION_TASK_FAILED",
			);
		await this.stores.plans.saveExecution({
			ownerId: this.ownerId,
			planId: execution.planId,
			stepId: execution.stepId,
			canvasId: execution.canvasId,
			profile: execution.profile,
			runId: execution.runId,
			state: result.record.state,
			actionId: execution.actionId,
			errorCode: result.record.errorCode,
		});
		if (result.record.state === "completed")
			await this.execute({ planId: execution.planId, canvasId: execution.canvasId, profile: execution.profile });
	}

	async reconcileAll(): Promise<void> {
		// Legacy v7 singleton links remain read/reconcile only; they never trigger
		// continuation into fresh plan work.
		for (const taskId of await this.stores.plans.listPendingTaskIds()) {
			if (await this.stores.plans.getExecutionForTask({ taskId, ownerId: this.ownerId })) continue;
			const update = await this.readAuthoritativeTask(taskId);
			if (!update) continue;
			await this.stores.plans.applyTaskTerminal({
				taskId,
				status: update.status as
					| "succeeded"
					| "failed"
					| "cancelled"
					| "expired"
					| "settlement_error"
					| "interrupted",
				...(update.errorCode ? { errorCode: update.errorCode } : {}),
				...(update.outputRef ? { outputRef: update.outputRef } : {}),
			});
		}
		for (const record of await this.stores.plans.listExecutions({ ownerId: this.ownerId })) {
			await this.reconcileExecution(record);
		}
	}

	async recoverAll(): Promise<void> {
		await this.reconcileAll();
	}

	async cancel(input: { planId: string }): Promise<DesktopPlanExecutionSnapshot | null> {
		await this.cancelPlan(input.planId);
		return await this.getExecution(input);
	}

	async cancelRun(runId: string): Promise<{ cancelled: boolean }> {
		const execution = await this.stores.plans.getExecutionForRun({ runId, ownerId: this.ownerId });
		if (!execution) return { cancelled: false };
		await this.cancelPlan(execution.planId);
		return { cancelled: true };
	}

	/** Lifecycle close: stop new dispatch and drain work already in flight. */
	async stop(): Promise<void> {
		this.dispatchStopped = true;
		await Promise.allSettled([...this.inFlight]);
	}

	/** User/session archive or deletion: persist cancellation and invalidate approvals. */
	async onSessionStop(sessionId: string): Promise<void> {
		for (const planId of await this.stores.plans.listPlanIdsForSession({ sessionId, ownerId: this.ownerId }))
			await this.cancelPlan(planId);
	}

	private async drivePlan(input: ExecutionRequest): Promise<DesktopPlanExecutionSnapshot | null> {
		const bound = await this.stores.plans.bindExecutionContext({
			planId: input.planId,
			ownerId: this.ownerId,
			canvasId: input.canvasId,
			profile: input.profile,
		});
		if (bound.stopRequested || this.dispatchStopped) return await this.getExecution({ planId: input.planId });
		for (let cycle = 0; cycle < 64; cycle += 1) {
			if (this.dispatchStopped || (await this.isPlanStopped(input.planId))) break;
			const compiled = await this.stores.plans.readySet(input.planId, this.ownerId, bound.profile);
			if (compiled.readySet.length === 0) break;
			const readIds = compiled.readySet.filter((stepId) => {
				const step = compiled.plan.steps.find((candidate) => candidate.id === stepId);
				return step?.effect === "read" || isReadTool(step?.tool ?? "", bound.profile);
			});
			const runtimeReadIds = readIds.filter((stepId) => {
				const step = compiled.plan.steps.find((candidate) => candidate.id === stepId);
				return step && !READ_TOOL_NAMES.has(step.tool);
			});
			const nativeReadIds = readIds.filter((stepId) => !runtimeReadIds.includes(stepId));
			if (nativeReadIds.length > 0) {
				const existing = await this.stores.plans.getExecution({ planId: input.planId, ownerId: this.ownerId });
				if (existing.some((record) => nativeReadIds.includes(record.stepId) && record.state !== "completed"))
					return await this.getExecution({ planId: input.planId });
				await this.executeNativeReads(input.planId, compiled.plan, nativeReadIds, bound.canvasId, bound.profile);
				continue;
			}
			if (runtimeReadIds.length > 0) {
				for (const stepId of runtimeReadIds) {
					if (this.dispatchStopped || (await this.isPlanStopped(input.planId))) break;
					await this.executeRuntimeStep({
						plan: compiled.plan,
						step: requiredStep(compiled.plan, stepId),
						canvasId: bound.canvasId,
						profile: bound.profile,
					});
					const record = await this.stores.plans.getExecution({ planId: input.planId, ownerId: this.ownerId });
					if (record.some((item) => item.stepId === stepId && item.state !== "completed"))
						return await this.getExecution({ planId: input.planId });
				}
				continue;
			}
			const partition = compiled.executionPartitions.find((candidate) => candidate.effect !== "read");
			const stepId = partition?.stepIds[0] ?? compiled.readySet[0];
			const step = requiredStep(compiled.plan, stepId);
			await this.executeRuntimeStep({ plan: compiled.plan, step, canvasId: bound.canvasId, profile: bound.profile });
			const row = (await this.stores.plans.getExecution({ planId: input.planId, ownerId: this.ownerId })).find(
				(item) => item.stepId === step.id,
			);
			if (!row || row.state !== "completed") break;
		}
		return await this.getExecution({ planId: input.planId });
	}

	private async executeNativeReads(
		planId: string,
		plan: AgentPlan,
		stepIds: string[],
		canvasId: string,
		profile: AgentProfile,
	): Promise<void> {
		if (this.dispatchStopped || (await this.isPlanStopped(planId))) return;
		const sessionId = plan.sessionId;
		const run = await this.runs.startRun({ sessionId, idempotencyKey: `plan-read:${planId}:${nextId()}` });
		await this.runs.setStatus(run.runId, "running");
		const toExecute = stepIds;
		for (const stepId of toExecute) {
			await this.stores.plans.saveExecution({
				ownerId: this.ownerId,
				planId,
				stepId,
				canvasId,
				profile,
				runId: run.runId,
				state: "running",
			});
		}
		const gateway = await this.gatewayFactory({ sessionId, runId: run.runId });
		const base = {
			readySet: async (id: string, ownerId: string, activeProfile: AgentProfile) => {
				const ready = await this.stores.plans.readySet(id, ownerId, activeProfile);
				const allowed = new Set(toExecute);
				return {
					...ready,
					readySet: ready.readySet.filter((stepId) => allowed.has(stepId)),
					executionPartitions: ready.executionPartitions
						.map((partition) => ({
							...partition,
							stepIds: partition.stepIds.filter((stepId) => allowed.has(stepId)),
						}))
						.filter((partition) => partition.stepIds.length > 0),
				};
			},
			claimStep: (claim: Parameters<PlanExecutionRepository["claimStep"]>[0]) => this.stores.plans.claimStep(claim),
			completeStep: (complete: Parameters<PlanExecutionRepository["completeStep"]>[0]) =>
				this.stores.plans.completeStep(complete),
			failStep: (failure: Parameters<PlanExecutionRepository["failStep"]>[0]) => this.stores.plans.failStep(failure),
		} satisfies PlanExecutionRepository;
		const reads = new PlanExecutionService(base, new ToolGatewayReadPlanStepExecutor(new ReadTools(gateway)));
		const result = await reads.executeReadyReads({ planId, ownerId: this.ownerId, canvasId, profile });
		for (const stepId of result.executedStepIds) {
			const record = (await this.stores.plans.getExecution({ planId, ownerId: this.ownerId })).find(
				(row) => row.stepId === stepId,
			);
			if (record)
				await this.stores.plans.saveExecution({ ...executionInput(record, this.ownerId), state: "completed" });
		}
		for (const stepId of result.failedStepIds) {
			const record = (await this.stores.plans.getExecution({ planId, ownerId: this.ownerId })).find(
				(row) => row.stepId === stepId,
			);
			if (record)
				await this.stores.plans.saveExecution({
					...executionInput(record, this.ownerId),
					state: "failed",
					errorCode: "READ_EXECUTION_FAILED",
				});
		}
		await this.runs.setStatus(run.runId, result.failedStepIds.length > 0 ? "failed" : "completed", {
			...(result.failedStepIds.length > 0
				? { errorCode: "READ_EXECUTION_FAILED", text: "读取计划步骤失败。" }
				: { text: "读取计划步骤已完成。" }),
		});
		await this.stores.sessions.flushOutbox(this.stores.control, sessionId);
	}

	private async executeRuntimeStep(input: StepRunInput): Promise<void> {
		if (this.dispatchStopped || (await this.isPlanStopped(input.plan.id))) return;
		const expectedAttempt = (input.step.attemptCount ?? 0) + 1;
		const runKeyHash = createHash("sha256")
			.update(JSON.stringify([input.plan.id, input.step.id, expectedAttempt]))
			.digest("hex")
			.slice(0, 40);
		const idempotencyKey = `plan:${runKeyHash}`;
		const preexisting = this.stores.control.findByIdempotency(input.plan.sessionId, idempotencyKey);
		if (preexisting) {
			await this.stores.plans.saveExecution({
				ownerId: this.ownerId,
				planId: input.plan.id,
				stepId: input.step.id,
				canvasId: input.canvasId,
				profile: input.profile,
				runId: preexisting.runId,
				state: "reconciliation_required",
				errorCode: "WRITE_RESULT_UNCERTAIN",
			});
			return;
		}
		const run = await this.runs.startRun({ sessionId: input.plan.sessionId, idempotencyKey });
		let claimed: AgentPlan;
		try {
			claimed = await this.stores.plans.claimStep({
				planId: input.plan.id,
				ownerId: this.ownerId,
				stepId: input.step.id,
			});
		} catch (error) {
			await this.runs.cancelRun(run.runId).catch(() => false);
			throw error;
		}
		const step = requiredStep(claimed, input.step.id);
		if (!step.idempotencyKey || step.attemptCount !== expectedAttempt) {
			await this.runs.cancelRun(run.runId).catch(() => false);
			throw new Error("PLAN_STEP_IDEMPOTENCY_REQUIRED");
		}
		await this.stores.plans.saveExecution({
			ownerId: this.ownerId,
			planId: input.plan.id,
			stepId: step.id,
			canvasId: input.canvasId,
			profile: input.profile,
			runId: run.runId,
			state: "running",
		});
		await this.runs.setStatus(run.runId, "running");
		const gateway = await this.gatewayFactory({ sessionId: input.plan.sessionId, runId: run.runId });
		const guardedGateway = this.guardGateway(input.plan.id, run.runId, gateway);
		const approvals = new ApprovalService(
			this.stores.control,
			this.stores.control.getOrCreateApprovalSecret(),
			10 * 60,
		);
		let confirmationAction: PlannedAction | undefined;
		let confirmationPending = false;
		const runtimeContext: RuntimeToolContext = {
			userId: this.ownerId,
			sessionId: input.plan.sessionId,
			runId: run.runId,
			canvasId: input.canvasId,
			canvasVersion: claimed.canvasVersion,
			canvasVersionPinned: true,
			requestId: this.requestId,
			gateway: guardedGateway,
			approvals,
			desktopMode: true,
			continueAfterTask: false,
			onAuditRequested: this.onAuditRequested
				? async (audit) =>
						await this.onAuditRequested!(audit, {
							sessionId: input.plan.sessionId,
							runId: run.runId,
							canvasId: input.canvasId,
							canvasVersion: runtimeContext.canvasVersion,
							gateway: guardedGateway,
						})
				: undefined,
			onApprovalRequired: async (action) => {
				confirmationAction = action;
				confirmationPending = true;
				await this.persistConfirmation(input, run.runId, action, guardedGateway);
			},
		};
		try {
			if (step.tool === "load_skill") {
				if (!this.skillContextFactory) throw new Error("SKILL_CONTEXT_UNAVAILABLE");
				const skillContext = await this.skillContextFactory(input.plan.sessionId);
				const loadTool = createLoadSkillTool(
					skillContext.skills,
					skillContext.loadedSkillIds,
					skillContext.onLoad,
				)[0];
				await executeTool(loadTool, step, idempotencyKey);
			} else {
				const tool = createRuntimeTools(runtimeContext).find((candidate) => candidate.name === step.tool);
				if (!tool)
					throw new Error(step.tool === "request_render_audit" ? "AUDIT_TOOL_UNAVAILABLE" : "TOOL_NOT_ALLOWED");
				await executeTool(tool, step, idempotencyKey);
			}
			if (confirmationPending) return;
			if (this.dispatchStopped || (await this.isPlanStopped(input.plan.id))) {
				await this.runs.cancelRun(run.runId);
				return;
			}
			await this.stores.plans.completeStep({
				planId: input.plan.id,
				ownerId: this.ownerId,
				stepId: step.id,
				idempotencyKey: step.idempotencyKey,
				outputRef: `plan-result://${input.plan.id}/${step.id}`,
			});
			if (runtimeContext.canvasVersion > claimed.canvasVersion) {
				await this.stores.plans.advanceCanvasVersion({
					planId: input.plan.id,
					ownerId: this.ownerId,
					expectedCanvasVersion: claimed.canvasVersion,
					canvasVersion: runtimeContext.canvasVersion,
				});
			}
			await this.stores.plans.saveExecution({
				...executionBase(input, run.runId, this.ownerId),
				state: "completed",
			});
			await this.runs.setStatus(run.runId, "completed", { text: "计划步骤已完成。" });
			await this.stores.sessions.flushOutbox(this.stores.control, input.plan.sessionId);
		} catch (error) {
			const code = safeErrorCode(error, "PLAN_STEP_EXECUTION_FAILED");
			const fresh = await this.stores.control.findById(run.runId);
			if (fresh && (fresh.status === "waiting_confirmation" || fresh.status === "waiting_task")) {
				await this.stores.plans.saveExecution({
					...executionBase(input, run.runId, this.ownerId),
					state: confirmationAction ? "reconciliation_required" : "waiting_task",
					...(confirmationAction ? { actionId: confirmationAction.actionId } : {}),
					errorCode: code,
				});
				return;
			}
			await this.failPlanStep(input.plan.id, step.id, code);
			await this.stores.plans.saveExecution({
				...executionBase(input, run.runId, this.ownerId),
				state: "failed",
				errorCode: code,
			});
			await this.runs
				.setStatus(run.runId, "failed", { errorCode: code, text: "计划步骤执行失败。" })
				.catch(() => undefined);
			await this.stores.sessions.flushOutbox(this.stores.control, input.plan.sessionId);
		}
	}

	private async persistConfirmation(
		input: StepRunInput,
		runId: string,
		action: PlannedAction,
		gateway: RuntimeToolGateway,
	): Promise<void> {
		await this.stores.plans.saveExecution({
			...executionBase(input, runId, this.ownerId),
			state: "waiting_confirmation",
			actionId: action.actionId,
		});
		await this.runs.setStatus(runId, "waiting_confirmation");
		let event: Record<string, unknown>;
		if (action.toolName === "delete_nodes") {
			const preview = isRecord(action.params.preview) ? action.params.preview : {};
			event = {
				kind: "canvas_delete",
				actionId: action.actionId,
				approvalToken: action.approvalToken,
				tool: action.toolName,
				summary: "确认删除节点及关联连线",
				canvasId: action.canvasId,
				canvasVersion: action.canvasVersion,
				expiresAt: action.binding.expiresAt,
				...preview,
			};
		} else {
			const generationItems = await desktopGenerationConfirmationItems(action, gateway);
			event = {
				kind: "generation",
				actionId: action.actionId,
				approvalToken: action.approvalToken,
				tool: action.toolName,
				summary:
					action.toolName === "submit_generation_batch"
						? `确认提交 ${generationItems.length} 个本地生成任务`
						: "确认提交本地生成任务",
				confirmReason: "生成任务会写入当前本地项目的任务队列。",
				affectedNodeCount: generationItems.length,
				generationItems,
				canvasVersion: action.canvasVersion,
				expiresAt: action.binding.expiresAt,
			};
		}
		await this.runs.appendEvent(runId, "confirmation_required", event);
		await this.stores.sessions.flushOutbox(this.stores.control, input.plan.sessionId);
	}

	private async finishConfirmedDelete(execution: DesktopPlanExecutionRecord, actionId: string): Promise<void> {
		const events = await this.runs.listEvents(execution.runId);
		const result = [...events]
			.reverse()
			.find(
				(event) =>
					event.type === "tool_completed" &&
					event.data.actionId === actionId &&
					event.data.actionStatus === "accepted",
			);
		const version = result?.data.canvasVersion;
		const plan = await this.stores.plans.get(execution.planId, this.ownerId);
		if (!Number.isSafeInteger(version) || Number(version) < plan.canvasVersion) {
			await this.stores.plans.saveExecution({
				ownerId: this.ownerId,
				planId: execution.planId,
				stepId: execution.stepId,
				canvasId: execution.canvasId,
				profile: execution.profile,
				runId: execution.runId,
				state: "reconciliation_required",
				actionId,
				errorCode: "DELETE_RESULT_UNAVAILABLE",
			});
			return;
		}
		const step = requiredStep(plan, execution.stepId);
		if (step.status === "running" && step.idempotencyKey) {
			await this.stores.plans.completeStep({
				planId: execution.planId,
				ownerId: this.ownerId,
				stepId: step.id,
				idempotencyKey: step.idempotencyKey,
				outputRef: `plan-result://${plan.id}/${step.id}`,
			});
		}
		if (Number(version) > plan.canvasVersion) {
			await this.stores.plans.advanceCanvasVersion({
				planId: execution.planId,
				ownerId: this.ownerId,
				expectedCanvasVersion: plan.canvasVersion,
				canvasVersion: Number(version),
			});
		}
		await this.stores.plans.saveExecution({
			ownerId: this.ownerId,
			planId: execution.planId,
			stepId: execution.stepId,
			canvasId: execution.canvasId,
			profile: execution.profile,
			runId: execution.runId,
			state: "completed",
			actionId,
		});
	}

	private async reconcileExecution(record: DesktopPlanExecutionRecord): Promise<void> {
		if (record.state === "waiting_task" || record.state === "cancelled") {
			if (record.state === "waiting_task") await this.resumeAcceptedGeneration(record);
			await this.reconcileExecutionTasks(record);
			return;
		}
		if (record.state === "waiting_confirmation") {
			const action = record.actionId ? await this.stores.control.find(record.actionId) : undefined;
			const run = await this.stores.control.findById(record.runId);
			if (action?.status === "consumed" && isGenerationTool(action.action.toolName)) {
				await this.resumeAcceptedGeneration(record);
				const current = await this.stores.plans.getExecution({ planId: record.planId, ownerId: this.ownerId });
				const resumed = current.find((item) => item.stepId === record.stepId);
				if (resumed?.state === "waiting_task") await this.reconcileExecutionTasks(resumed);
				return;
			}
			if (action?.status === "rejected" || run?.status === "aborted") {
				await this.failPlanStep(record.planId, record.stepId, "CONFIRMATION_INVALIDATED");
				await this.stores.plans.saveExecution({
					...recordInput(record, this.ownerId),
					state: "failed",
					errorCode: "CONFIRMATION_INVALIDATED",
				});
			}
			return;
		}
		if (record.state === "reconciliation_required") {
			const action = record.actionId ? await this.stores.control.find(record.actionId) : undefined;
			if (action?.status === "consumed" && isGenerationTool(action.action.toolName)) {
				await this.resumeAcceptedGeneration(record);
				const current = await this.stores.plans.getExecution({ planId: record.planId, ownerId: this.ownerId });
				const resumed = current.find((item) => item.stepId === record.stepId);
				if (resumed?.state === "waiting_task") await this.reconcileExecutionTasks(resumed);
			}
			return;
		}
		if (record.state !== "running") return;
		const plan = await this.stores.plans.get(record.planId, this.ownerId);
		const step = plan.steps.find((candidate) => candidate.id === record.stepId);
		if (step && step.effect !== "read" && !READ_TOOL_NAMES.has(step.tool)) {
			await this.failPlanStep(record.planId, record.stepId, "WRITE_RESULT_UNCERTAIN");
			await this.stores.plans.saveExecution({
				...recordInput(record, this.ownerId),
				state: "reconciliation_required",
				errorCode: "WRITE_RESULT_UNCERTAIN",
			});
			return;
		}
		await this.stores.plans.saveExecution({
			...recordInput(record, this.ownerId),
			state: "reconciliation_required",
			errorCode: "READ_RESULT_UNCERTAIN",
		});
	}

	private async resumeAcceptedGeneration(record: DesktopPlanExecutionRecord): Promise<void> {
		if (!record.actionId) return;
		const approval = await this.stores.control.find(record.actionId);
		if (!approval || approval.status !== "consumed" || !isGenerationTool(approval.action.toolName)) return;
		const existingLinks = this.stores.control
			.listTaskLinks(record.runId)
			.filter((link) => link.actionId === record.actionId);
		let runEvents = await this.runs.listEvents(record.runId);
		const acceptedEvent = runEvents.some(
			(event) =>
				event.type === "tool_completed" &&
				event.data.actionId === record.actionId &&
				event.data.actionStatus === "accepted",
		);
		const expectedTaskCount = expectedGenerationTaskCount(approval.action.toolName, approval.action.params);
		if (expectedTaskCount > 0 && existingLinks.length === expectedTaskCount) {
			if (!acceptedEvent) {
				const run = await this.stores.control.findById(record.runId);
				if (run && run.status !== "aborted" && run.status !== "completed" && run.status !== "failed") {
					for (const link of existingLinks) {
						if (runEvents.some((event) => event.type === "task_status" && event.data.task_id === link.taskId))
							continue;
						runEvents = [
							...runEvents,
							await this.runs.appendEvent(record.runId, "task_status", {
								actionId: record.actionId,
								actionStatus: "accepted",
								task_id: link.taskId,
								...(link.nodeId ? { node_id: link.nodeId } : {}),
								status: link.status,
							}),
						];
					}
					await this.runs.appendEvent(record.runId, "tool_completed", {
						actionId: record.actionId,
						actionStatus: "accepted",
						tool: approval.action.toolName,
						ok: true,
						details:
							expectedTaskCount === 1
								? "已确认，生成任务已加入本地队列"
								: `已确认，${expectedTaskCount} 个生成任务已加入本地队列`,
					});
					await this.runs.setStatus(record.runId, "waiting_task");
					await this.stores.sessions.flushOutbox(this.stores.control, run.sessionId);
				}
			}
			await this.stores.plans.attachExecutionTasks({
				ownerId: this.ownerId,
				planId: record.planId,
				stepId: record.stepId,
				actionId: record.actionId,
				tasks: existingLinks.map((link) => ({
					taskId: link.taskId,
					status: initialExecutionTaskStatus(link.status),
				})),
			});
			await this.stores.plans.saveExecution({
				...recordInput(record, this.ownerId),
				state: "waiting_task",
				actionId: record.actionId,
			});
			return;
		}
		const plan = await this.stores.plans.get(record.planId, this.ownerId);
		const gateway = await this.gatewayFactory({ sessionId: plan.sessionId, runId: record.runId });
		const summary = await gateway.getCanvasSummary(this.ownerId, record.canvasId);
		const canvas = isRecord(summary) && isRecord(summary.canvas) ? summary.canvas : {};
		if (!Number.isSafeInteger(canvas.version)) {
			await this.stores.plans.saveExecution({
				...recordInput(record, this.ownerId),
				state: "reconciliation_required",
				errorCode: "CANVAS_VERSION_UNAVAILABLE",
			});
			return;
		}
		try {
			await confirmDesktopGenerationAction(
				{
					projectId: this.ownerId,
					canvasId: record.canvasId,
					sessionId: plan.sessionId,
					actionId: record.actionId,
					approvalToken: approval.action.approvalToken ?? "",
					accept: true,
					currentCanvasVersion: Number(canvas.version),
				},
				this.stores,
				this.guardGateway(record.planId, record.runId, gateway),
			);
		} catch (error) {
			await this.stores.plans.saveExecution({
				...recordInput(record, this.ownerId),
				state: "reconciliation_required",
				errorCode: safeErrorCode(error, "GENERATION_RECOVERY_UNCERTAIN"),
			});
			return;
		}
		const links = this.stores.control.listTaskLinks(record.runId).filter((link) => link.actionId === record.actionId);
		if (links.length === 0) {
			await this.stores.plans.saveExecution({
				...recordInput(record, this.ownerId),
				state: "reconciliation_required",
				errorCode: "TASK_LINKS_UNAVAILABLE",
			});
			return;
		}
		await this.stores.plans.attachExecutionTasks({
			ownerId: this.ownerId,
			planId: record.planId,
			stepId: record.stepId,
			actionId: record.actionId,
			tasks: links.map((link) => ({ taskId: link.taskId, status: initialExecutionTaskStatus(link.status) })),
		});
		await this.stores.plans.saveExecution({
			...recordInput(record, this.ownerId),
			state: "waiting_task",
			actionId: record.actionId,
		});
	}

	private async cancelPlan(planId: string): Promise<void> {
		await this.stores.plans.requestExecutionStop({ planId, ownerId: this.ownerId });
		const records = await this.stores.plans.getExecution({ planId, ownerId: this.ownerId });
		for (const record of records) {
			this.cancelledRuns.add(record.runId);
			this.stores.control.invalidatePendingForRun(record.runId);
			await this.runs.cancelRun(record.runId).catch(() => false);
			const links = this.stores.control.listTaskLinks(record.runId);
			if (record.actionId) {
				const actionLinks = links.filter((link) => link.actionId === record.actionId);
				if (actionLinks.length > 0)
					await this.stores.plans
						.attachExecutionTasks({
							ownerId: this.ownerId,
							planId,
							stepId: record.stepId,
							actionId: record.actionId,
							tasks: actionLinks.map((link) => ({
								taskId: link.taskId,
								status: initialExecutionTaskStatus(link.status),
							})),
						})
						.catch(() => undefined);
			}
			await this.stores.plans
				.saveExecution({ ...recordInput(record, this.ownerId), state: "cancelled", errorCode: "PLAN_CANCELLED" })
				.catch(() => undefined);
		}
	}

	private async isPlanStopped(planId: string): Promise<boolean> {
		const context = await this.stores.plans.getExecutionContext({ planId, ownerId: this.ownerId });
		return this.dispatchStopped || context?.stopRequested === true;
	}

	private guardGateway(planId: string, runId: string, gateway: RuntimeToolGateway): RuntimeToolGateway {
		const service = this;
		return new Proxy(gateway, {
			get(target, property, receiver) {
				const value = Reflect.get(target, property, receiver) as unknown;
				if (typeof value !== "function") return value;
				if (property === "execute" || property === "createGenerationTask" || property === "requestRenderAudit") {
					return async (...args: unknown[]) => {
						if (service.cancelledRuns.has(runId) || (await service.isPlanStopped(planId)))
							throw new Error("PLAN_CANCELLED");
						const result: unknown = await value.apply(target, args);
						if (property === "createGenerationTask") {
							const approval = service.stores.control.findConsumedApprovalForRun(runId);
							const request = args[0];
							const task = isRecord(result) ? result : undefined;
							if (
								approval?.status === "consumed" &&
								isGenerationTool(approval.action.toolName) &&
								isRecord(request) &&
								typeof request.idempotencyKey === "string" &&
								(request.idempotencyKey === approval.action.actionId ||
									request.idempotencyKey.startsWith(`${approval.action.actionId}:`)) &&
								task &&
								typeof task.taskId === "string" &&
								typeof task.nodeId === "string" &&
								typeof task.status === "string"
							) {
								service.stores.control.linkTask({
									taskId: task.taskId,
									sessionId: approval.action.sessionId,
									runId,
									actionId: approval.action.actionId,
									nodeId: task.nodeId,
									status: initialExecutionTaskStatus(task.status),
									allowAcceptedInactiveSession: true,
								});
							}
						}
						return result;
					};
				}
				return value.bind(target);
			},
		});
	}

	private async completePlanStep(
		planId: string,
		stepId: string,
		tasks: readonly DesktopPlanExecutionTask[],
	): Promise<void> {
		const plan = await this.stores.plans.get(planId, this.ownerId);
		const step = plan.steps.find((candidate) => candidate.id === stepId);
		if (step?.status !== "running" || !step.idempotencyKey) return;
		await this.stores.plans.completeStep({
			planId,
			ownerId: this.ownerId,
			stepId,
			idempotencyKey: step.idempotencyKey,
			...(tasks.length === 1 && tasks[0]?.outputRef ? { outputRef: tasks[0].outputRef } : {}),
		});
	}

	private async failPlanStep(planId: string, stepId: string, errorCode: string): Promise<void> {
		const plan = await this.stores.plans.get(planId, this.ownerId).catch(() => undefined);
		const step = plan?.steps.find((candidate) => candidate.id === stepId);
		if (step?.status !== "running" || !step.idempotencyKey) return;
		await this.stores.plans.failStep({
			planId,
			ownerId: this.ownerId,
			stepId,
			idempotencyKey: step.idempotencyKey,
			errorCode,
		});
	}

	private async reconcileExecutionTasks(record: DesktopPlanExecutionRecord): Promise<void> {
		for (const task of await this.stores.plans.listExecutionTasks({
			planId: record.planId,
			stepId: record.stepId,
			ownerId: this.ownerId,
		})) {
			await this.onTaskTerminal(task.taskId);
		}
	}

	private async readAuthoritativeTask(
		taskId: string,
		expectedRunId?: string,
	): Promise<
		| {
				status: DesktopPlanExecutionTask["status"];
				errorCode?: string;
				outputRef?: string;
				controlUpdate: {
					taskId: string;
					status: DesktopPlanExecutionTask["status"];
					errorCode?: string;
					errorMessage?: string;
					outputRef?: string;
				};
		  }
		| undefined
	> {
		let raw: unknown;
		try {
			raw = await this.readTask(taskId);
		} catch {
			return undefined;
		}
		const link = this.stores.control.listTaskLinks().find((candidate) => candidate.taskId === taskId);
		if (
			!isRecord(raw) ||
			raw.taskId !== taskId ||
			typeof raw.nodeId !== "string" ||
			!link?.nodeId ||
			raw.nodeId !== link.nodeId ||
			(expectedRunId !== undefined && link.runId !== expectedRunId) ||
			typeof raw.status !== "string" ||
			!isTaskStatus(raw.status)
		)
			return undefined;
		let status = raw.status as DesktopPlanExecutionTask["status"];
		let errorCode = safeTaskError(raw.errorCode);
		if (status === "succeeded" && raw.outputVerified !== true) {
			status = "failed";
			errorCode = "TASK_OUTPUT_UNAVAILABLE";
		}
		const outputRef = status === "succeeded" && isTaskId(taskId) ? `vibe://app/tasks/${taskId}/output` : undefined;
		const errorMessage = typeof raw.errorMessage === "string" ? raw.errorMessage.slice(0, 400) : undefined;
		return {
			status,
			...(errorCode ? { errorCode } : {}),
			...(outputRef ? { outputRef } : {}),
			controlUpdate: {
				taskId,
				status,
				...(errorCode ? { errorCode } : {}),
				...(errorMessage ? { errorMessage } : {}),
				...(outputRef ? { outputRef } : {}),
			},
		};
	}

	private async sessionIdForRun(runId: string): Promise<string> {
		return (await this.stores.control.findById(runId))?.sessionId ?? "";
	}

	private track<T>(promise: Promise<T>): Promise<T> {
		this.inFlight.add(promise);
		void promise.then(
			() => this.inFlight.delete(promise),
			() => this.inFlight.delete(promise),
		);
		return promise;
	}
}

async function executeTool(
	tool: ReturnType<typeof createRuntimeTools>[number] | ReturnType<typeof createLoadSkillTool>[number],
	step: PlanStep,
	toolCallId: string,
): Promise<unknown> {
	const params = step.input ?? {};
	const normalized = tool.prepareArguments ? tool.prepareArguments(params) : params;
	if (!Value.Check(tool.parameters, normalized)) throw new Error("PLAN_STEP_INPUT_INVALID");
	return await tool.execute(toolCallId, normalized as never);
}

function executionBase(input: StepRunInput, runId: string, ownerId: string) {
	return {
		ownerId,
		planId: input.plan.id,
		stepId: input.step.id,
		canvasId: input.canvasId,
		profile: input.profile,
		runId,
	};
}

function executionInput(record: DesktopPlanExecutionRecord, ownerId: string) {
	return {
		ownerId,
		planId: record.planId,
		stepId: record.stepId,
		canvasId: record.canvasId,
		profile: record.profile,
		runId: record.runId,
	};
}

function recordInput(record: DesktopPlanExecutionRecord, ownerId: string) {
	return {
		ownerId,
		planId: record.planId,
		stepId: record.stepId,
		canvasId: record.canvasId,
		profile: record.profile,
		runId: record.runId,
		...(record.actionId ? { actionId: record.actionId } : {}),
	};
}

function aggregateState(
	plan: AgentPlan,
	records: readonly DesktopPlanExecutionRecord[],
	stopRequested: boolean,
): DesktopPlanExecutionState {
	if (stopRequested || records.some((record) => record.state === "cancelled")) return "cancelled";
	if (plan.steps.length > 0 && plan.steps.every((step) => step.status === "completed")) return "completed";
	if (records.some((record) => record.state === "reconciliation_required")) return "reconciliation_required";
	if (records.some((record) => record.state === "waiting_confirmation")) return "waiting_confirmation";
	if (records.some((record) => record.state === "waiting_task")) return "waiting_task";
	if (plan.steps.some((step) => step.status === "failed") || records.some((record) => record.state === "failed"))
		return "failed";
	return "running";
}

function isGenerationTool(name: string): boolean {
	return name === "submit_generation" || name === "submit_generation_batch";
}

function isReadTool(name: string, _profile: AgentProfile): boolean {
	// The plan compiler has already checked the frozen profile; this only routes
	// the original read manifest entries to their established executor.
	return name === "load_skill" || name === "request_render_audit" || READ_TOOL_NAMES.has(name);
}

function requiredStep(plan: AgentPlan, stepId: string): PlanStep {
	const step = plan.steps.find((candidate) => candidate.id === stepId);
	if (!step) throw new Error("PLAN_STEP_NOT_FOUND");
	return step;
}

function toExecutionTaskStatus(status: string): DesktopPlanExecutionTask["status"] {
	if (
		status === "running" ||
		status === "queued" ||
		status === "succeeded" ||
		status === "failed" ||
		status === "cancelled" ||
		status === "interrupted"
	)
		return status;
	return "interrupted";
}

function initialExecutionTaskStatus(status: string): DesktopPlanExecutionTask["status"] {
	const converted = toExecutionTaskStatus(status);
	return TERMINAL_TASK_STATUSES.has(converted) ? "running" : converted;
}

function expectedGenerationTaskCount(toolName: string, params: unknown): number {
	if (toolName === "submit_generation") return 1;
	if (toolName !== "submit_generation_batch" || !isRecord(params) || !Array.isArray(params.generations)) return 0;
	return params.generations.length;
}

function isTaskStatus(status: string): boolean {
	return (
		status === "running" ||
		status === "queued" ||
		status === "succeeded" ||
		status === "failed" ||
		status === "cancelled" ||
		status === "interrupted"
	);
}

function isTaskId(value: string): boolean {
	return /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function safeTaskError(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Z0-9_]{1,120}$/u.test(value) ? value : undefined;
}

function safeErrorCode(error: unknown, fallback: string): string {
	const candidate =
		typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
			? error.code
			: error instanceof Error
				? (error.message.match(/\[([A-Z0-9_]{1,120})\]/u)?.[1] ?? error.message)
				: "";
	return /^[A-Z][A-Z0-9_]{1,119}$/u.test(candidate) ? candidate : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
