import { ApprovalService } from "../application/approval-service.ts";
import { type CanvasCommandGateway, CanvasCommandService } from "../application/canvas-command-service.ts";
import { SessionRunService } from "../application/session-run-service.ts";
import type { PlannedAction } from "../domain/action-approval.ts";
import { ToolGatewayError } from "../infrastructure/tool-gateway.ts";
import type { ReadToolsGateway } from "../tools/read-tools.ts";
import type { DesktopAgentStores } from "./agent-stores.ts";

export type DesktopDeletionPreview = {
	nodeCount: number;
	nodeLabels: string[];
	connectedEdgeCount: number;
	downstreamNodeCount: number;
	affectedGroupCount: number;
	affectedGroupLabels: string[];
	affectedStackCount: number;
	groupMembershipsRetained: true;
	stackMembershipsRetained: true;
};

export type DesktopDeletionSnapshot = {
	canvasVersion: number;
	preview: DesktopDeletionPreview;
};

export type DesktopDeletionConfirmationInput = {
	projectId: string;
	canvasId: string;
	sessionId: string;
	actionId: string;
	approvalToken: string;
	accept: boolean;
	currentCanvasVersion: number;
};

export type DesktopDeletionConfirmationResult = {
	actionId: string;
	status: "accepted" | "rejected";
	lastEventSeq: number;
};

type DesktopDeletionGateway = ReadToolsGateway & CanvasCommandGateway;
type DesktopDeletionActionParams = {
	nodeIds: string[];
	preview: DesktopDeletionPreview;
};

const inFlightConfirmations = new Map<string, Promise<DesktopDeletionConfirmationResult>>();

export function desktopDeletionConfirmationKey(projectId: string, actionId: string): string {
	return `${projectId}:${actionId}`;
}

/** Read authoritative canvas facts used both for the preview and the confirmation-time CAS. */
export async function buildDesktopDeletionSnapshot(
	gateway: Pick<ReadToolsGateway, "getCanvasSummary">,
	userId: string,
	canvasId: string,
	nodeIds: readonly string[],
	requestId?: string,
): Promise<DesktopDeletionSnapshot> {
	validateNodeIds(nodeIds);
	const summary = await gateway.getCanvasSummary(userId, canvasId, requestId);
	if (!isRecord(summary) || !isRecord(summary.canvas))
		throw new ToolGatewayError("INVALID_RESPONSE", "本地画布摘要无效", {});
	const canvas = summary.canvas;
	const canvasVersion = canvas.version;
	if (!Number.isSafeInteger(canvasVersion) || (canvasVersion as number) < 0)
		throw new ToolGatewayError("INVALID_RESPONSE", "本地画布版本无效", {});
	if (typeof canvas.id === "string" && canvas.id !== canvasId)
		throw new ToolGatewayError("PERMISSION_DENIED", "当前画布已切换", {}, 403);

	const nodes = records(summary.nodes);
	const nodesById = new Map(
		nodes
			.map((node) => [stringValue(node.id), node] as const)
			.filter((entry): entry is readonly [string, Record<string, unknown>] => Boolean(entry[0])),
	);
	const selectedIds = new Set(nodeIds);
	const selectedNodes = nodeIds.map((id) => nodesById.get(id));
	if (selectedNodes.some((node) => !node))
		throw new ToolGatewayError(
			"NOT_FOUND",
			"一个或多个待删除节点已不存在",
			{ missingNodeCount: selectedNodes.filter((node) => !node).length },
			404,
		);

	const connectedEdges = new Set<string>();
	const downstreamNodes = new Set<string>();
	for (const [index, edge] of records(summary.edges).entries()) {
		const source = endpoint(edge.sourceNodeId ?? edge.source);
		const target = endpoint(edge.targetNodeId ?? edge.target);
		if (!source || !target || (!selectedIds.has(source) && !selectedIds.has(target))) continue;
		connectedEdges.add(stringValue(edge.id) ?? `${source}\0${target}\0${index}`);
		if (selectedIds.has(source) && !selectedIds.has(target) && nodesById.has(target)) downstreamNodes.add(target);
	}

	const affectedGroupLabels = records(summary.groups)
		.filter((group) => intersects(strings(group.nodeIds), selectedIds))
		.map((group, index) => safeDisplayText(group.name, `分组 ${index + 1}`));
	const affectedStackCount = records(summary.stacks).filter((stack) =>
		intersects(strings(stack.nodeIds), selectedIds),
	).length;

	return {
		canvasVersion: canvasVersion as number,
		preview: {
			nodeCount: nodeIds.length,
			nodeLabels: selectedNodes.map((node) => nodeLabel(node!)),
			connectedEdgeCount: connectedEdges.size,
			downstreamNodeCount: downstreamNodes.size,
			affectedGroupCount: affectedGroupLabels.length,
			affectedGroupLabels,
			affectedStackCount,
			groupMembershipsRetained: true,
			stackMembershipsRetained: true,
		},
	};
}

/** Consume the persisted confirmation, then dispatch the original CanvasCommand through the Tool Gateway. */
export async function confirmDesktopDeleteAction(
	input: DesktopDeletionConfirmationInput,
	stores: Pick<DesktopAgentStores, "projectId" | "control" | "sessions">,
	gateway: DesktopDeletionGateway,
): Promise<DesktopDeletionConfirmationResult> {
	validateInput(input);
	const key = desktopDeletionConfirmationKey(input.projectId, input.actionId);
	const current = inFlightConfirmations.get(key);
	if (current) return await current;
	const work = confirmDesktopDeleteActionOnce(input, stores, gateway);
	inFlightConfirmations.set(key, work);
	try {
		return await work;
	} finally {
		if (inFlightConfirmations.get(key) === work) inFlightConfirmations.delete(key);
	}
}

async function confirmDesktopDeleteActionOnce(
	input: DesktopDeletionConfirmationInput,
	stores: Pick<DesktopAgentStores, "projectId" | "control" | "sessions">,
	gateway: DesktopDeletionGateway,
): Promise<DesktopDeletionConfirmationResult> {
	if (input.projectId !== stores.projectId) throw new Error("AGENT_PROJECT_CHANGED");
	const record = await stores.control.find(input.actionId);
	if (
		!record ||
		record.action.userId !== stores.projectId ||
		record.action.sessionId !== input.sessionId ||
		record.action.canvasId !== input.canvasId ||
		record.action.toolName !== "delete_nodes" ||
		!record.action.runId ||
		record.action.binding.userId !== record.action.userId ||
		record.action.binding.sessionId !== record.action.sessionId ||
		record.action.binding.canvasId !== record.action.canvasId ||
		record.action.binding.canvasVersion !== record.action.canvasVersion ||
		record.action.binding.actionHash !== record.action.actionHash
	) {
		throw new Error("CONFIRMATION_REQUIRED");
	}
	const action = record.action;
	const runId = action.runId;
	if (!runId) throw new Error("CONFIRMATION_REQUIRED");
	const actionParams = readActionParams(action);
	const approval = new ApprovalService(stores.control, stores.control.getOrCreateApprovalSecret(), 10 * 60);
	await approval.validateApprovalToken(input.actionId, input.approvalToken);
	const runService = new SessionRunService(stores.control);
	const run = await stores.control.findById(runId);
	if (!run || run.sessionId !== input.sessionId) throw new Error("CONFIRMATION_REQUIRED");
	const priorEvents = await runService.listEvents(run.runId);
	const priorCompletion = [...priorEvents]
		.reverse()
		.find((event) => event.type === "run_completed" && event.data.actionId === input.actionId);
	if (run.status === "completed") {
		if (priorCompletion?.data.actionStatus !== "accepted" && priorCompletion?.data.actionStatus !== "rejected")
			throw new Error("CONFIRMATION_REQUIRED");
		return await finishResult(input, stores, runService, priorCompletion.data.actionStatus);
	}
	if (run.status !== "waiting_confirmation") throw new Error("RUN_NOT_ACTIVE");

	const completedAction = [...priorEvents]
		.reverse()
		.find((event) => event.type === "tool_completed" && event.data.actionId === input.actionId);
	if (completedAction?.data.actionStatus === "accepted") {
		await runService.setStatus(run.runId, "completed", {
			actionId: input.actionId,
			actionStatus: "accepted",
			text: acceptedText(actionParams.preview),
		});
		return await finishResult(input, stores, runService, "accepted");
	}
	if (completedAction?.data.actionStatus === "rejected")
		return await finishRejected(
			input,
			stores,
			runService,
			"该删除操作已取消，画布没有改变。",
			"CONFIRMATION_INVALIDATED",
		);
	if (record.status === "consumed" && !input.accept) throw new Error("CONFIRMATION_DECISION_ALREADY_ACCEPTED");

	const expired = action.binding.expiresAt <= Date.now();
	if (record.status === "rejected") {
		return await finishRejected(
			input,
			stores,
			runService,
			expired ? "删除确认已过期，画布没有改变。" : "该删除操作已取消或失效，画布没有改变。",
			expired ? "CONFIRMATION_EXPIRED" : "CONFIRMATION_INVALIDATED",
		);
	}
	if (!input.accept) {
		try {
			await approval.rejectApproval(input.actionId, input.approvalToken);
		} catch (error) {
			const refreshed = await stores.control.find(input.actionId);
			if (refreshed?.status === "consumed") throw new Error("CONFIRMATION_DECISION_ALREADY_ACCEPTED");
			if (action.binding.expiresAt > Date.now()) throw error;
			return await finishRejected(
				input,
				stores,
				runService,
				"删除确认已过期，画布没有改变。",
				"CONFIRMATION_EXPIRED",
			);
		}
		return await finishRejected(input, stores, runService, "已取消删除，画布没有改变。");
	}

	if (record.status === "pending") {
		if (input.currentCanvasVersion !== action.canvasVersion)
			return await rejectForCanvasChange(input, stores, runService, approval, action.actionId, input.approvalToken);
		const snapshot = await buildDesktopDeletionSnapshot(
			gateway,
			stores.projectId,
			input.canvasId,
			actionParams.nodeIds,
		);
		if (snapshot.canvasVersion !== action.canvasVersion || !samePreview(snapshot.preview, actionParams.preview))
			return await rejectForCanvasChange(input, stores, runService, approval, action.actionId, input.approvalToken);
	}

	let approvedAction: Awaited<ReturnType<ApprovalService["consumeApprovalIdempotently"]>>;
	try {
		approvedAction = await approval.consumeApprovalIdempotently(
			input.actionId,
			input.approvalToken,
			action.canvasVersion,
		);
	} catch (error) {
		const refreshed = await stores.control.find(input.actionId);
		if (refreshed?.status !== "consumed") {
			if (action.binding.expiresAt <= Date.now())
				return await finishRejected(
					input,
					stores,
					runService,
					"删除确认已过期，画布没有改变。",
					"CONFIRMATION_EXPIRED",
				);
			throw error;
		}
		approvedAction = await approval.consumeApprovalIdempotently(
			input.actionId,
			input.approvalToken,
			action.canvasVersion,
		);
	}

	let deleted: Record<string, unknown>;
	try {
		deleted = await new CanvasCommandService(gateway).deleteNodes({
			userId: stores.projectId,
			canvasId: approvedAction.canvasId,
			expectedVersion: approvedAction.canvasVersion,
			idempotencyKey: approvedAction.actionId,
			nodeIds: actionParams.nodeIds,
		});
		if (!Number.isSafeInteger(deleted.canvasVersion) || Number(deleted.canvasVersion) < approvedAction.canvasVersion)
			throw new ToolGatewayError("INVALID_RESPONSE", "本地画布未返回有效的删除结果", {});
	} catch (error) {
		const code = errorCode(error);
		const latestRun = await stores.control.findById(run.runId);
		if (latestRun?.status !== "aborted") {
			await runService.setStatus(run.runId, "failed", {
				actionId: input.actionId,
				actionStatus: "uncertain",
				errorCode: code ?? "DELETE_RESULT_UNCERTAIN",
				text: "删除命令已提交，但结果未能完整确认；请检查画布中的节点和关联连线。",
			});
			await stores.sessions.flushOutbox(stores.control, input.sessionId);
		}
		throw error;
	}

	const text = acceptedText(actionParams.preview);
	if (!completedAction)
		await runService.appendEvent(run.runId, "tool_completed", {
			actionId: input.actionId,
			actionStatus: "accepted",
			tool: "delete_nodes",
			ok: true,
			details: text,
			canvasVersion: deleted.canvasVersion,
		});
	await runService.setStatus(run.runId, "completed", {
		actionId: input.actionId,
		actionStatus: "accepted",
		text,
	});
	return await finishResult(input, stores, runService, "accepted");
}

async function rejectForCanvasChange(
	input: DesktopDeletionConfirmationInput,
	stores: Pick<DesktopAgentStores, "projectId" | "control" | "sessions">,
	runService: SessionRunService,
	approval: ApprovalService,
	actionId: string,
	approvalToken: string,
): Promise<DesktopDeletionConfirmationResult> {
	try {
		await approval.rejectApproval(actionId, approvalToken);
	} catch (error) {
		const refreshed = await stores.control.find(actionId);
		if (refreshed?.status === "consumed") throw new Error("CONFIRMATION_DECISION_ALREADY_ACCEPTED");
		if (refreshed?.status !== "rejected") throw error;
	}
	return await finishRejected(
		input,
		stores,
		runService,
		"画布内容已变化，删除确认已失效；画布没有改变。",
		"AGENT_CANVAS_CHANGED",
	);
}

async function finishRejected(
	input: DesktopDeletionConfirmationInput,
	stores: Pick<DesktopAgentStores, "projectId" | "control" | "sessions">,
	runService: SessionRunService,
	text: string,
	errorCode?: string,
): Promise<DesktopDeletionConfirmationResult> {
	const record = await stores.control.find(input.actionId);
	if (!record?.action.runId) throw new Error("CONFIRMATION_REQUIRED");
	const run = await stores.control.findById(record.action.runId);
	if (!run || run.sessionId !== input.sessionId || run.status !== "waiting_confirmation")
		throw new Error("RUN_NOT_ACTIVE");
	const events = await runService.listEvents(run.runId);
	if (
		!events.some(
			(event) =>
				event.type === "tool_completed" &&
				event.data.actionId === input.actionId &&
				event.data.actionStatus === "rejected",
		)
	) {
		await runService.appendEvent(run.runId, "tool_completed", {
			actionId: input.actionId,
			actionStatus: "rejected",
			tool: "delete_nodes",
			ok: false,
			...(errorCode ? { errorCode } : {}),
			details: text,
		});
	}
	await runService.setStatus(run.runId, "completed", {
		actionId: input.actionId,
		actionStatus: "rejected",
		...(errorCode ? { errorCode } : {}),
		text,
	});
	return await finishResult(input, stores, runService, "rejected");
}

async function finishResult(
	input: DesktopDeletionConfirmationInput,
	stores: Pick<DesktopAgentStores, "projectId" | "control" | "sessions">,
	runService: SessionRunService,
	status: "accepted" | "rejected",
): Promise<DesktopDeletionConfirmationResult> {
	await stores.sessions.flushOutbox(stores.control, input.sessionId);
	return {
		actionId: input.actionId,
		status,
		lastEventSeq: (await runService.listSessionEvents(input.sessionId)).at(-1)?.eventSeq ?? 0,
	};
}

function readActionParams(action: PlannedAction): DesktopDeletionActionParams {
	if (!isRecord(action.params) || !Array.isArray(action.params.nodeIds) || !isRecord(action.params.preview))
		throw new Error("CONFIRMATION_REQUIRED");
	validateNodeIds(action.params.nodeIds);
	const preview = action.params.preview;
	if (
		!Number.isSafeInteger(preview.nodeCount) ||
		!Array.isArray(preview.nodeLabels) ||
		!Number.isSafeInteger(preview.connectedEdgeCount) ||
		!Number.isSafeInteger(preview.downstreamNodeCount) ||
		!Number.isSafeInteger(preview.affectedGroupCount) ||
		!Array.isArray(preview.affectedGroupLabels) ||
		!Number.isSafeInteger(preview.affectedStackCount) ||
		preview.groupMembershipsRetained !== true ||
		preview.stackMembershipsRetained !== true
	)
		throw new Error("CONFIRMATION_REQUIRED");
	if (
		preview.nodeCount !== action.params.nodeIds.length ||
		preview.nodeLabels.length !== action.params.nodeIds.length ||
		preview.nodeLabels.some((label) => typeof label !== "string") ||
		preview.affectedGroupCount !== preview.affectedGroupLabels.length ||
		preview.affectedGroupLabels.some((label) => typeof label !== "string") ||
		[
			preview.connectedEdgeCount,
			preview.downstreamNodeCount,
			preview.affectedGroupCount,
			preview.affectedStackCount,
		].some((value) => Number(value) < 0)
	)
		throw new Error("CONFIRMATION_REQUIRED");
	return { nodeIds: action.params.nodeIds, preview: preview as DesktopDeletionPreview };
}

function samePreview(left: DesktopDeletionPreview, right: DesktopDeletionPreview): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function validateInput(input: DesktopDeletionConfirmationInput): void {
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
	)
		throw new Error("AGENT_CONFIRMATION_INPUT_INVALID");
}

function validateNodeIds(nodeIds: readonly unknown[]): asserts nodeIds is string[] {
	if (
		!Array.isArray(nodeIds) ||
		nodeIds.length < 1 ||
		nodeIds.length > 20 ||
		nodeIds.some((id) => typeof id !== "string" || id.length < 1 || id.length > 256) ||
		new Set(nodeIds).size !== nodeIds.length
	)
		throw new ToolGatewayError("INVALID_INPUT", "删除需要 1 至 20 个不同节点", {}, 400);
}

function nodeLabel(node: Record<string, unknown>): string {
	const type = stringValue(node.type);
	const defaults: Record<string, string> = {
		text: "文本节点",
		image: "图片节点",
		video: "视频节点",
		audio: "音频节点",
		compose: "合成节点",
		director: "导演台节点",
	};
	return safeDisplayText(node.label, type ? (defaults[type] ?? "节点") : "节点");
}

function safeDisplayText(value: unknown, fallback: string): string {
	if (typeof value !== "string" || !value.trim()) return fallback;
	const sanitized = value
		.replace(/(?:[A-Za-z]:\\|\\\\|\/(?:Users|home|private\/var|tmp)\/)[^\s"']+/gu, "[本地素材]")
		.replace(/\bhttps?:\/\/[^\s]+/giu, "[引用素材]")
		.replace(/[\r\n\t]+/gu, " ")
		.trim();
	return sanitized ? sanitized.slice(0, 80) : fallback;
}

function acceptedText(preview: DesktopDeletionPreview): string {
	return `已删除 ${preview.nodeCount} 个节点，并移除 ${preview.connectedEdgeCount} 条关联连线。`;
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = (error as { code?: unknown }).code;
	if (typeof code === "string") return code;
	const message = error instanceof Error ? error.message : "";
	return [
		"VERSION_CONFLICT",
		"NOT_FOUND",
		"INVALID_INPUT",
		"PERMISSION_DENIED",
		"RUN_ABORTED",
		"OPERATION_UNCERTAIN",
	].find((candidate) => message.includes(candidate));
}

function intersects(values: readonly string[], selected: ReadonlySet<string>): boolean {
	return values.some((value) => selected.has(value));
}

function endpoint(value: unknown): string | undefined {
	if (typeof value === "string" && value) return value;
	if (!isRecord(value)) return undefined;
	return stringValue(value.id) ?? stringValue(value.nodeId);
}

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
