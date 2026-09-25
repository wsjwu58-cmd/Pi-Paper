import { ApprovalService } from "../application/approval-service.ts";
import { SessionRunService } from "../application/session-run-service.ts";
import { type RuntimeToolGateway, submitApprovedGenerationAction } from "../tools/runtime-tools.ts";
import type { DesktopAgentStores } from "./agent-stores.ts";

export type DesktopGenerationConfirmationInput = {
	projectId: string;
	canvasId: string;
	sessionId: string;
	actionId: string;
	approvalToken: string;
	accept: boolean;
	currentCanvasVersion: number;
};

export type DesktopGenerationConfirmationResult = {
	actionId: string;
	status: "accepted" | "rejected";
	lastEventSeq: number;
};

export async function recoverDesktopAgentRuns(
	stores: Pick<DesktopAgentStores, "projectId" | "control" | "sessions">,
): Promise<void> {
	const runService = new SessionRunService(stores.control);
	const sessions = await stores.sessions.listSessions();
	for (const session of sessions) {
		const activeRun = await runService.findActive(session.id);
		if (!activeRun) continue;
		const accepted =
			activeRun.status === "waiting_confirmation"
				? stores.control.findConsumedApprovalForRun(activeRun.runId)
				: undefined;
		if (accepted) continue;
		if (activeRun.status === "waiting_confirmation") stores.control.invalidatePendingForRun(activeRun.runId);
		await runService.setStatus(activeRun.runId, "aborted", { reason: "worker_restarted" });
	}
	await stores.sessions.flushOutbox(stores.control);
}

export async function confirmDesktopGenerationAction(
	input: DesktopGenerationConfirmationInput,
	stores: Pick<DesktopAgentStores, "projectId" | "control" | "sessions">,
	gateway: RuntimeToolGateway,
): Promise<DesktopGenerationConfirmationResult> {
	validateInput(input);
	if (input.projectId !== stores.projectId) throw new Error("AGENT_PROJECT_CHANGED");

	const record = await stores.control.find(input.actionId);
	if (
		!record ||
		record.action.userId !== stores.projectId ||
		record.action.sessionId !== input.sessionId ||
		record.action.canvasId !== input.canvasId ||
		!record.action.runId ||
		!isGenerationTool(record.action.toolName)
	) {
		throw new Error("CONFIRMATION_REQUIRED");
	}

	const approval = new ApprovalService(stores.control, stores.control.getOrCreateApprovalSecret(), 10 * 60);
	await approval.validateApprovalToken(input.actionId, input.approvalToken);
	const runService = new SessionRunService(stores.control);
	const run = await stores.control.findById(record.action.runId);
	if (!run || run.sessionId !== input.sessionId) throw new Error("CONFIRMATION_REQUIRED");

	if (run.status === "completed") {
		const events = await runService.listEvents(run.runId);
		const prior = [...events]
			.reverse()
			.find((event) => event.type === "run_completed" && event.data.actionId === input.actionId);
		if (!prior || (prior.data.actionStatus !== "accepted" && prior.data.actionStatus !== "rejected"))
			throw new Error("CONFIRMATION_REQUIRED");
		return {
			actionId: input.actionId,
			status: prior.data.actionStatus,
			lastEventSeq: (await runService.listSessionEvents(input.sessionId)).at(-1)?.eventSeq ?? prior.eventSeq,
		};
	}
	if (run.status !== "waiting_confirmation") throw new Error("CONFIRMATION_REQUIRED");

	// A prior acceptance is durable consent. Do not let a later reject request
	// accidentally enter the replay path and create tasks after a worker restart.
	if (record.status === "consumed" && !input.accept) {
		throw new Error("CONFIRMATION_DECISION_ALREADY_ACCEPTED");
	}

	const rejectRun = async (text: string, errorCode?: string): Promise<DesktopGenerationConfirmationResult> => {
		await runService.setStatus(run.runId, "completed", {
			actionId: input.actionId,
			actionStatus: "rejected",
			...(errorCode ? { errorCode } : {}),
			text,
		});
		await stores.sessions.flushOutbox(stores.control, input.sessionId);
		return {
			actionId: input.actionId,
			status: "rejected",
			lastEventSeq: (await runService.listSessionEvents(input.sessionId)).at(-1)?.eventSeq ?? 0,
		};
	};

	if (record.status === "rejected") {
		const expired = record.action.binding.expiresAt <= Date.now();
		return rejectRun(
			expired ? "确认已过期，未提交生成任务。" : "确认已取消或失效，未提交生成任务。",
			expired ? "CONFIRMATION_EXPIRED" : "CONFIRMATION_INVALIDATED",
		);
	}

	if (record.status === "pending" && !input.accept) {
		try {
			await approval.rejectApproval(input.actionId, input.approvalToken);
		} catch (error) {
			if (record.action.binding.expiresAt > Date.now()) throw error;
			return rejectRun("确认已过期，未提交生成任务。", "CONFIRMATION_EXPIRED");
		}
		return rejectRun("已取消生成任务，未加入本地队列。");
	}

	const canvasSummary = await gateway.getCanvasSummary(stores.projectId, input.canvasId);
	const summary = isRecord(canvasSummary) ? canvasSummary : {};
	const canvas = isRecord(summary.canvas) ? summary.canvas : {};
	const authoritativeVersion = canvas.version;
	if (!Number.isSafeInteger(authoritativeVersion)) throw new Error("AGENT_CANVAS_CONTEXT_INVALID");
	if (authoritativeVersion !== input.currentCanvasVersion || authoritativeVersion !== record.action.canvasVersion) {
		if (record.status === "pending")
			await approval.rejectApproval(input.actionId, input.approvalToken).catch(() => undefined);
		return rejectRun(
			record.status === "consumed"
				? "画布内容已变化，未继续提交任务；此前已创建的本地任务仍保留在当前项目。"
				: "画布内容已变化，确认失效；未提交生成任务。",
			"AGENT_CANVAS_CHANGED",
		);
	}

	let approvedAction: Awaited<ReturnType<ApprovalService["consumeApprovalIdempotently"]>>;
	try {
		approvedAction = await approval.consumeApprovalIdempotently(
			input.actionId,
			input.approvalToken,
			authoritativeVersion,
		);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "VERSION_CONFLICT") {
			if (record.status === "pending")
				await approval.rejectApproval(input.actionId, input.approvalToken).catch(() => undefined);
			return rejectRun("画布内容已变化，确认失效；未提交生成任务。", "AGENT_CANVAS_CHANGED");
		}
		if (record.action.binding.expiresAt <= Date.now())
			return rejectRun("确认已过期，未提交生成任务。", "CONFIRMATION_EXPIRED");
		throw error;
	}

	// TaskStore uses actionId:index as the stable idempotency key. If the Worker
	// stops after acceptance or after any batch item, accepting the same action
	// resumes the exact persisted payload without duplicating completed items.
	const tasks = await submitApprovedGenerationAction(approvedAction, gateway);
	for (const task of tasks) {
		stores.control.linkTask({
			taskId: task.taskId,
			sessionId: input.sessionId,
			runId: run.runId,
			nodeId: task.nodeId,
			status: task.status,
		});
	}

	let events = await runService.listEvents(run.runId);
	for (const task of tasks) {
		if (
			events.some(
				(event) =>
					event.type === "task_status" &&
					event.data.actionId === input.actionId &&
					event.data.task_id === task.taskId,
			)
		)
			continue;
		events = [
			...events,
			await runService.appendEvent(run.runId, "task_status", {
				actionId: input.actionId,
				task_id: task.taskId,
				node_id: task.nodeId,
				status: task.status,
			}),
		];
	}
	if (!events.some((event) => event.type === "tool_completed" && event.data.actionId === input.actionId)) {
		await runService.appendEvent(run.runId, "tool_completed", {
			actionId: input.actionId,
			tool: record.action.toolName,
			ok: true,
			details: tasks.length === 1 ? "生成任务已加入本地队列" : `${tasks.length} 个生成任务已加入本地队列`,
		});
	}

	await runService.setStatus(run.runId, "completed", {
		actionId: input.actionId,
		actionStatus: "accepted",
		taskStatus: { taskId: tasks[0]?.taskId, nodeId: tasks[0]?.nodeId, status: tasks[0]?.status },
		text: tasks.length === 1 ? "生成任务已加入本地队列。" : `${tasks.length} 个生成任务已加入本地队列。`,
	});
	await stores.sessions.flushOutbox(stores.control, input.sessionId);
	return {
		actionId: input.actionId,
		status: "accepted",
		lastEventSeq: (await runService.listSessionEvents(input.sessionId)).at(-1)?.eventSeq ?? 0,
	};
}

function validateInput(input: DesktopGenerationConfirmationInput): void {
	if (
		typeof input.projectId !== "string" ||
		typeof input.canvasId !== "string" ||
		typeof input.sessionId !== "string" ||
		input.sessionId.length > 128 ||
		typeof input.actionId !== "string" ||
		input.actionId.length > 128 ||
		typeof input.approvalToken !== "string" ||
		input.approvalToken.length > 4096 ||
		typeof input.accept !== "boolean" ||
		!Number.isSafeInteger(input.currentCanvasVersion) ||
		input.currentCanvasVersion < 0
	) {
		throw new Error("AGENT_CONFIRMATION_INPUT_INVALID");
	}
}

function isGenerationTool(toolName: string): boolean {
	return toolName === "submit_generation" || toolName === "submit_generation_batch";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
