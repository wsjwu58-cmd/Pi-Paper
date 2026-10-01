import type { DesktopAgentStores } from "./agent-stores.ts";
import type { DesktopTaskStatusUpdate } from "./control-store.ts";
import { SessionRunService } from "../application/session-run-service.ts";
import { parseConfirmationExpiry } from "../application/confirmation-expiry.ts";

export type DesktopAuthoritativeTask = {
	taskId: string;
	nodeId: string;
	status: string;
	errorCode?: string | null;
	errorMessage?: string | null;
	outputVerified?: boolean;
};

export type DesktopTaskReader = (taskId: string) => Promise<unknown>;

export type ReconcileDesktopAgentTasksOptions = {
	sessionId?: string;
	runId?: string;
};

export type ReconcileDesktopAgentTasksResult = {
	checked: number;
	updated: number;
	finalizedRuns: number;
	unreadable: number;
	expiredConfirmations: number;
};

const TASK_STATUSES = new Set<DesktopTaskStatusUpdate["status"]>([
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
	"interrupted",
]);

/**
 * Refreshes only tasks already linked to persisted Agent runs. readTask must be
 * a scoped, read-only LocalCore lookup; this service never creates or retries a task.
 */
export async function reconcileDesktopAgentTasks(
	stores: Pick<DesktopAgentStores, "control" | "sessions">,
	readTask: DesktopTaskReader,
	options: ReconcileDesktopAgentTasksOptions = {},
): Promise<ReconcileDesktopAgentTasksResult> {
	const links = stores.control.listTaskLinks().filter((link) =>
		(options.sessionId === undefined || link.sessionId === options.sessionId) &&
		(options.runId === undefined || link.runId === options.runId),
	);
	const result: ReconcileDesktopAgentTasksResult = {
		checked: 0,
		updated: 0,
		finalizedRuns: 0,
		unreadable: 0,
		expiredConfirmations: 0,
	};
	const linkedSessions = new Set(links.map((link) => link.sessionId));
	if (options.sessionId) linkedSessions.add(options.sessionId);
	const runService = new SessionRunService(stores.control);
	const sessions = options.sessionId
		? [{ id: options.sessionId }]
		: options.runId
			? (() => {
					const run = stores.control.findById(options.runId!);
					return run ? [{ id: run.sessionId }] : [];
				})()
			: await stores.sessions.listSessions();
	for (const session of sessions) {
		const activeRun = await runService.findActive(session.id);
		if (!activeRun || activeRun.status !== "waiting_confirmation") continue;
		if (stores.control.findConsumedApprovalForRun(activeRun.runId)) continue;
		const events = await runService.listEvents(activeRun.runId);
		const confirmationEvent = [...events].reverse().find((event) => event.type === "confirmation_required");
		const expiresAt = parseConfirmationExpiry(confirmationEvent?.data.expiresAt ?? confirmationEvent?.data.expires_at);
		if (expiresAt === undefined || expiresAt > Date.now()) continue;
		const expired = stores.control.expireUnconsumedConfirmation(activeRun.runId, {
			reason: "confirmation_expired",
			text: "确认已过期，未提交生成任务。",
		});
		if (!expired) continue;
		linkedSessions.add(session.id);
		result.expiredConfirmations += 1;
	}

	for (const link of links) {
		if (isTerminalTaskStatus(link.status)) continue;
		result.checked += 1;
		let raw: unknown;
		try {
			raw = await readTask(link.taskId);
		} catch {
			result.unreadable += 1;
			continue;
		}
		if (!isRecord(raw) || raw.taskId !== link.taskId || typeof raw.nodeId !== "string" || raw.nodeId !== link.nodeId) {
			result.unreadable += 1;
			continue;
		}
		if (typeof raw.status !== "string" || !TASK_STATUSES.has(raw.status as DesktopTaskStatusUpdate["status"])) {
			result.unreadable += 1;
			continue;
		}

		const task = raw as unknown as DesktopAuthoritativeTask;
		const update = toTaskStatusUpdate(task);
		const stored = stores.control.recordTaskStatus(update);
		if (stored.changed || stored.event) {
			result.updated += 1;
		}
		if (stored.runFinalized) result.finalizedRuns += 1;
	}

	for (const sessionId of linkedSessions) await stores.sessions.flushOutbox(stores.control, sessionId);
	return result;
}

function toTaskStatusUpdate(task: DesktopAuthoritativeTask): DesktopTaskStatusUpdate {
	let status = task.status as DesktopTaskStatusUpdate["status"];
	let errorCode = safeErrorCode(task.errorCode);
	let errorMessage = safeTaskMessage(task.errorMessage);
	let outputRef: string | undefined;

	if (status === "succeeded") {
		if (task.outputVerified !== true) {
			status = "failed";
			errorCode = "TASK_OUTPUT_UNAVAILABLE";
			errorMessage = "生成任务已结束，但本地结果无法读取或校验失败。";
		} else if (/^[A-Za-z0-9_-]{1,128}$/u.test(task.taskId)) {
			outputRef = `vibe://app/tasks/${task.taskId}/output`;
		}
	}

	if (status === "failed" && !errorMessage) errorMessage = defaultFailureMessage(errorCode);
	if (status === "cancelled" && !errorMessage) errorMessage = "生成任务已取消。";
	if (status === "interrupted" && !errorMessage) errorMessage = "生成任务已中断，可能需要重新提交。";
	if ((status === "failed" || status === "cancelled" || status === "interrupted") && !errorCode) {
		errorCode = status === "cancelled" ? "TASK_CANCELLED" : status === "interrupted" ? "TASK_INTERRUPTED" : "TASK_FAILED";
	}

	return {
		taskId: task.taskId,
		status,
		...(errorCode ? { errorCode } : {}),
		...(errorMessage ? { errorMessage } : {}),
		...(outputRef ? { outputRef } : {}),
	};
}

function safeErrorCode(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Z0-9_]{1,120}$/u.test(value) ? value : undefined;
}

function safeTaskMessage(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const message = value
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
		.replace(/\b(api[_-]?key|authorization|token|secret|password)\s*[:=]\s*["']?[^\s,"']+/giu, "$1=[已隐藏]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [已隐藏]")
		.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, "[密钥已隐藏]")
		.replace(/\b[A-Za-z]:[\\/][^\s"'<>]+/gu, "[路径已隐藏]")
		.replace(/\\\\[^\\\s]+\\[^\s"'<>]+/gu, "[路径已隐藏]")
		.replace(/\/(?:Users|home|private\/var|tmp|var|mnt|Volumes)\/[^\s"'<>]+/gu, "[路径已隐藏]")
		.replace(/https?:\/\/[^\s)]+/giu, "远端服务")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, 400);
	if (!message || /^[\[\]，。；:：\s]+$/u.test(message)) return undefined;
	return message;
}

function defaultFailureMessage(errorCode: string | undefined): string {
	return errorCode ? `生成任务失败（${errorCode}）。` : "生成任务未成功完成。";
}

function isTerminalTaskStatus(status: string): boolean {
	return status === "succeeded" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
