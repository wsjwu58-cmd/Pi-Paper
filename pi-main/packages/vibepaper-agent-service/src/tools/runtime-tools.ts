import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

import type { ApprovalService } from "../application/approval-service.ts";
import { CanvasCommandService } from "../application/canvas-command-service.ts";
import type { PlannedAction } from "../domain/action-approval.ts";
import type { AuditInput } from "../domain/continuity-rules.ts";
import type { ToolGateway } from "../infrastructure/tool-gateway.ts";
import { ToolGatewayError } from "../infrastructure/tool-gateway.ts";
import { GenerationTools } from "./generation-tools.ts";
import { ReadTools } from "./read-tools.ts";

const EmptySchema = Type.Object({}, { additionalProperties: false });
const NodeIdArraySchema = Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 });
const NodeIdsSchema = Type.Object({ nodeIds: NodeIdArraySchema }, { additionalProperties: false });
const NodeDetailSchema = Type.Object({ nodeId: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const SearchSchema = Type.Object(
	{ query: Type.String({ minLength: 1, maxLength: 200 }) },
	{ additionalProperties: false },
);
const RenderAuditSchema = Type.Object(
	{
		targetNodeId: Type.String({ minLength: 1 }),
		shotDurationSeconds: Type.Integer({ minimum: 0 }),
		expectedDurationSeconds: Type.Integer({ minimum: 0 }),
		characterConsistent: Type.Boolean(),
		audioDurationMs: Type.Integer({ minimum: 0 }),
		videoDurationMs: Type.Integer({ minimum: 0 }),
		previousCamera: Type.String({ minLength: 1 }),
		currentCamera: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
const CanvasNodeSchema = Type.Object(
	{
		type: Type.Union([
			Type.Literal("text"),
			Type.Literal("image"),
			Type.Literal("video"),
			Type.Literal("audio"),
			Type.Literal("compose"),
			Type.Literal("director"),
		]),
		creativeType: Type.Optional(
			Type.Union([
				Type.Literal("script"),
				Type.Literal("character"),
				Type.Literal("shot"),
				Type.Literal("keyframe"),
				Type.Literal("clip"),
				Type.Literal("audio"),
				Type.Literal("composite"),
			]),
		),
		prompt: Type.Optional(Type.String({ maxLength: 10_000 })),
		params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		sourceNodeIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
	},
	{ additionalProperties: false },
);
const NodeArraySchema = Type.Array(CanvasNodeSchema, { minItems: 1, maxItems: 20 });
const CreateNodesSchema = Type.Object(
	{
		// Some OpenAI-compatible providers occasionally serialize an otherwise
		// valid JSON array into a string. Accept that transport form here, then
		// parse and validate it against NodeArraySchema before any canvas write.
		nodes: Type.Union([NodeArraySchema, Type.String({ minLength: 2, maxLength: 220_000 })]),
		// A few compatible model endpoints add a display type beside `nodes`.
		// It carries no command semantics and is intentionally ignored; accepting
		// it prevents an otherwise valid canvas command from being rejected before
		// the normalized node payload is validated.
		type: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
		// The runtime owns optimistic-lock and idempotency values. Requiring the
		// model to invent them made valid canvas writes unnecessarily fragile.
		expectedVersion: Type.Optional(Type.Integer({ minimum: 0 })),
		idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	},
	{ additionalProperties: false },
);
const DeleteNodesSchema = Type.Object(
	{
		// OpenAI-compatible models can serialize an ID array and numeric version
		// while producing an otherwise valid deletion command. The runtime parses
		// nodeIds and owns the optimistic-lock version and idempotency key.
		nodeIds: Type.Union([NodeIdArraySchema, Type.String({ minLength: 2, maxLength: 8_192 })]),
		expectedVersion: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.String({ pattern: "^[0-9]+$" })])),
		idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	},
	{ additionalProperties: false },
);
const ConnectNodesSchema = Type.Object(
	{
		nodeIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 20 }),
		expectedVersion: Type.Integer({ minimum: 0 }),
		idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
	},
	{ additionalProperties: false },
);
const UpdateNodeSchema = Type.Object(
	{
		nodeId: Type.String({ minLength: 1 }),
		config: Type.Record(Type.String(), Type.Unknown()),
		expectedVersion: Type.Integer({ minimum: 0 }),
		idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
	},
	{ additionalProperties: false },
);
const LayoutSchema = Type.Object(
	{
		nodeIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 }),
		layout: Type.Record(Type.String(), Type.Unknown()),
		expectedVersion: Type.Integer({ minimum: 0 }),
		idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
	},
	{ additionalProperties: false },
);
const GenerationSchema = Type.Object(
	{
		nodeId: Type.String({ minLength: 1 }),
		modelType: Type.String({ minLength: 1 }),
		modelParams: Type.Record(Type.String(), Type.Unknown()),
		estimatedCost: Type.Optional(Type.Integer({ minimum: 1 })),
		overwrite: Type.Boolean(),
	},
	{ additionalProperties: false },
);
const GenerationBatchSchema = Type.Object(
	{
		generations: Type.Array(GenerationSchema, { minItems: 2, maxItems: 20 }),
	},
	{ additionalProperties: false },
);

export type RuntimeToolContext = {
	userId: string;
	sessionId: string;
	runId?: string;
	canvasId: string;
	canvasVersion: number;
	canvasVersionPinned?: boolean;
	referenceNodeIds?: readonly string[];
	requestId?: string;
	confirmationPending?: boolean;
	generationExecutionPolicy?: "manual" | "auto";
	continueAfterTask?: boolean;
	gateway: ToolGateway;
	approvals: ApprovalService;
	onApprovalRequired?: (action: PlannedAction) => void | Promise<void>;
	onGenerationSubmitted?: (action: PlannedAction) => Promise<{ taskIds: string[] }>;
	onAuditRequested?: (input: AuditInput & { targetNodeId: string }) => Promise<Record<string, unknown>>;
};

export function createRuntimeTools(context: RuntimeToolContext): AgentTool[] {
	const read = new ReadTools(context.gateway);
	const commands = new CanvasCommandService(context.gateway);
	const generations = new GenerationTools(context.approvals);

	return [
		tool(
			"get_canvas_summary",
			"读取画布摘要",
			"读取当前画布事实摘要，不接受用户提供的伪造节点数据。",
			EmptySchema,
			async () =>
				result(
					rememberCanvasVersion(
						context,
						await read.getCanvasSummary(context.userId, context.canvasId, context.requestId),
					),
				),
		),
		tool(
			"get_selected_nodes",
			"读取选中节点",
			"读取当前画布中指定节点的权威内容。",
			NodeIdsSchema,
			async (_id, params) =>
				result(await read.getSelectedNodes(context.userId, context.canvasId, params.nodeIds, context.requestId)),
		),
		tool("get_node_detail", "读取节点详情", "读取一个节点的权威详情。", NodeDetailSchema, async (_id, params) =>
			result(await read.getNodeDetail(context.userId, context.canvasId, params.nodeId, context.requestId)),
		),
		tool("list_models", "读取模型目录", "读取当前可用模型和真实能力目录。", EmptySchema, async () =>
			result(await read.listModels(context.userId, context.requestId)),
		),
		tool("search_assets", "搜索素材", "只读搜索当前用户可访问的素材。", SearchSchema, async (_id, params) =>
			result(await read.searchAssets(context.userId, params.query, context.requestId)),
		),
		tool(
			"check_task_status",
			"查询任务状态",
			"查询 Generation 任务及其输出状态。",
			Type.Object({ taskId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
			async (_id, params) => result(await read.checkTaskStatus(context.userId, params.taskId, context.requestId)),
		),
		...(context.onAuditRequested
			? [
					tool(
						"request_render_audit",
						"请求渲染审校",
						"运行确定性连续性规则并持久化审校证据，不允许模型覆盖规则结论。",
						RenderAuditSchema,
						async (_id, params) => result(await context.onAuditRequested?.(params)),
					),
				]
			: []),
		tool(
			"create_nodes",
			"创建画布节点",
			"通过画布服务创建节点并返回真实节点 ID。每个节点必须提供 type；展示内容写入 params（如 params.content），不得传入 id、title、content 或 contentType。",
			CreateNodesSchema,
			async (toolCallId, params) => {
				assertNoPendingConfirmation(context);
				const nodes = parseNodeArray(params.nodes);
				return result(
					await createNodesWithReferenceEdges(commands, context, {
						...params,
						nodes,
						idempotencyKey: params.idempotencyKey ?? defaultIdempotencyKey(context, toolCallId),
					}),
				);
			},
		),
		tool("connect_nodes", "连接画布节点", "通过画布服务创建连线。", ConnectNodesSchema, async (_id, params) => {
			assertNoPendingConfirmation(context);
			return result(
				rememberCanvasVersion(
					context,
					await commands.connectNodes({
						userId: context.userId,
						canvasId: context.canvasId,
						requestId: context.requestId,
						expectedVersion: context.canvasVersion,
						idempotencyKey: params.idempotencyKey,
						nodeIds: params.nodeIds,
					}),
					true,
				),
			);
		}),
		tool(
			"update_node_config",
			"修改节点配置",
			"通过画布服务更新节点配置。",
			UpdateNodeSchema,
			async (_id, params) => {
				assertNoPendingConfirmation(context);
				return result(
					rememberCanvasVersion(
						context,
						await commands.updateNodeConfig({
							userId: context.userId,
							canvasId: context.canvasId,
							requestId: context.requestId,
							expectedVersion: context.canvasVersion,
							idempotencyKey: params.idempotencyKey,
							nodeId: params.nodeId,
							config: params.config,
						}),
						true,
					),
				);
			},
		),
		tool(
			"layout_nodes",
			"整理画布布局",
			"通过画布服务按确定性规则保存节点布局。",
			LayoutSchema,
			async (_id, params) => {
				assertNoPendingConfirmation(context);
				return result(
					rememberCanvasVersion(
						context,
						await commands.layoutNodes({
							userId: context.userId,
							canvasId: context.canvasId,
							requestId: context.requestId,
							expectedVersion: context.canvasVersion,
							idempotencyKey: params.idempotencyKey,
							nodeIds: params.nodeIds,
							layout: params.layout,
						}),
						true,
					),
				);
			},
		),
		tool(
			"delete_nodes",
			"删除画布节点",
			"通过画布服务删除节点，最多 20 个。",
			DeleteNodesSchema,
			async (toolCallId, params) => {
				assertNoPendingConfirmation(context);
				const nodeIds = parseNodeIdArray(params.nodeIds);
				return result(
					rememberCanvasVersion(
						context,
						await commands.deleteNodes({
							userId: context.userId,
							canvasId: context.canvasId,
							requestId: context.requestId,
							expectedVersion: context.canvasVersion,
							idempotencyKey: params.idempotencyKey ?? defaultIdempotencyKey(context, toolCallId),
							nodeIds,
						}),
						true,
					),
				);
			},
		),
		tool(
			"submit_generation",
			"提交生成任务",
			"经受控计费链路提交生成任务；服务端策略可能要求人工确认。",
			GenerationSchema,
			async (_id, params) => {
				assertNoPendingConfirmation(context);
				const modelType = await resolveGenerationModel(context, params.modelType);
				const modelParams = inferImageOperation(
					await withResolvedComposeInputs(
						read,
						context,
						modelType,
						await withAuthoritativePrompt(read, context, params.nodeId, params.modelParams),
					),
				);
				assertComposeInputs(modelType, modelParams);
				await assertCanvasVersion(context);
				const estimate = await context.gateway.estimateGeneration({
					userId: context.userId,
					modelType,
					modelParams,
					requestId: context.requestId,
				});
				const action = await generations.submitGeneration({
					actionIdempotencyKey: `${context.sessionId}:${params.nodeId}:${modelType}:${JSON.stringify(modelParams)}`,
					userId: context.userId,
					runId: context.runId,
					sessionId: context.sessionId,
					canvasId: context.canvasId,
					canvasVersion: context.canvasVersion,
					nodeId: params.nodeId,
					modelType,
					modelParams,
					estimatedCost: estimate.estimatedCost,
					overwrite: params.overwrite,
					requiresApproval: context.generationExecutionPolicy !== "auto",
					continueAfterTask: context.continueAfterTask,
				});
				if (context.generationExecutionPolicy === "auto") {
					const submitted = await context.onGenerationSubmitted?.(action);
					if (!submitted) throw new ToolGatewayError("GENERATION_UNAVAILABLE", "生成提交服务不可用", {});
					return {
						content: [{ type: "text", text: "生成任务已提交，正在后台处理。" }],
						details: { ack: true, taskIds: submitted.taskIds },
					};
				}
				context.confirmationPending = true;
				await context.onApprovalRequired?.(action);
				return {
					content: [{ type: "text", text: "该生成任务需要用户确认后才会扣除点数。" }],
					details: { confirmation: action },
					terminate: true,
				};
			},
		),
		tool(
			"submit_generation_batch",
			"批量提交生成",
			"为多个已创建的目标节点创建一份合并确认；确认后全部任务会提交，Agent 静默等待每个任务终态。",
			GenerationBatchSchema,
			async (_id, params) => {
				assertNoPendingConfirmation(context);
				await assertCanvasVersion(context);
				const prepared = [] as Array<{
					nodeId: string;
					modelType: string;
					modelParams: Record<string, unknown>;
					estimatedCost: number;
					overwrite: boolean;
				}>;
				for (const generation of params.generations) {
					const modelType = await resolveGenerationModel(context, generation.modelType);
					const modelParams = inferImageOperation(
						await withResolvedComposeInputs(
							read,
							context,
							modelType,
							await withAuthoritativePrompt(read, context, generation.nodeId, generation.modelParams),
						),
					);
					assertComposeInputs(modelType, modelParams);
					const estimate = await context.gateway.estimateGeneration({
						userId: context.userId,
						modelType,
						modelParams,
						requestId: context.requestId,
					});
					prepared.push({
						nodeId: generation.nodeId,
						modelType,
						modelParams,
						estimatedCost: estimate.estimatedCost,
						overwrite: generation.overwrite,
					});
				}
				const action = await generations.submitGenerationBatch({
					actionIdempotencyKey: `${context.sessionId}:batch:${JSON.stringify(prepared)}`,
					userId: context.userId,
					runId: context.runId,
					sessionId: context.sessionId,
					canvasId: context.canvasId,
					canvasVersion: context.canvasVersion,
					generations: prepared,
					requiresApproval: context.generationExecutionPolicy !== "auto",
					continueAfterTask: context.continueAfterTask,
				});
				if (context.generationExecutionPolicy === "auto") {
					const submitted = await context.onGenerationSubmitted?.(action);
					if (!submitted) throw new ToolGatewayError("GENERATION_UNAVAILABLE", "生成提交服务不可用", {});
					return {
						content: [{ type: "text", text: "批量生成任务已提交，正在后台处理。" }],
						details: { ack: true, taskIds: submitted.taskIds },
					};
				}
				context.confirmationPending = true;
				await context.onApprovalRequired?.(action);
				return {
					content: [{ type: "text", text: "这批生成任务需要用户确认后才会扣除点数。" }],
					details: { confirmation: action },
					terminate: true,
				};
			},
		),
	];
}

function assertNoPendingConfirmation(context: RuntimeToolContext): void {
	if (context.confirmationPending)
		throw new ToolGatewayError("CONFIRMATION_REQUIRED", "上一项生成正在等待用户确认，确认前不能继续写入画布", {});
}

async function createNodesWithReferenceEdges(
	commands: CanvasCommandService,
	context: RuntimeToolContext,
	params: { nodes: Array<{ type: string; sourceNodeIds?: readonly string[] }>; idempotencyKey: string },
): Promise<Record<string, unknown>> {
	const created = rememberCanvasVersion(
		context,
		await commands.createNodes({
			userId: context.userId,
			canvasId: context.canvasId,
			requestId: context.requestId,
			expectedVersion: context.canvasVersion,
			idempotencyKey: params.idempotencyKey,
			nodes: params.nodes,
		}),
		true,
	) as Record<string, unknown>;
	const createdNodes = Array.isArray(created.createdNodes) ? created.createdNodes : [];
	const targetIds = createdNodes
		.map((node, index) => ({
			id: typeof (node as { id?: unknown }).id === "string" ? (node as { id: string }).id : "",
			type: params.nodes[index]?.type,
			sourceNodeIds: params.nodes[index]?.sourceNodeIds ?? [],
		}))
		.filter((node) => node.id);
	const referenceEdges: Array<{ sourceNodeId: string; targetNodeId: string }> = [];
	for (const target of targetIds) {
		const selectedReferences = isReferenceTarget(target.type) ? (context.referenceNodeIds ?? []) : [];
		// A selected canvas can contain several modalities. When the model has
		// declared sourceNodeIds, that explicit list is authoritative; merging
		// every selected node would create invalid edges (for example video ->
		// audio) and make the whole canvas command look unavailable.
		const declaredSources = [...target.sourceNodeIds].filter(Boolean);
		const sources = [...new Set(declaredSources.length > 0 ? declaredSources : selectedReferences)].filter(Boolean);
		for (const sourceNodeId of sources) {
			if (sourceNodeId === target.id) continue;
			const edge = await commands.connectNodes({
				userId: context.userId,
				canvasId: context.canvasId,
				requestId: context.requestId,
				expectedVersion: context.canvasVersion,
				idempotencyKey: `${params.idempotencyKey}:reference:${sourceNodeId}:${target.id}`.slice(0, 128),
				nodeIds: [sourceNodeId, target.id],
			});
			rememberCanvasVersion(context, edge, true);
			referenceEdges.push({ sourceNodeId, targetNodeId: target.id });
		}
	}
	return referenceEdges.length > 0 ? { ...created, canvasVersion: context.canvasVersion, referenceEdges } : created;
}

function isReferenceTarget(type: string | undefined): boolean {
	return type === "image" || type === "video" || type === "audio" || type === "compose" || type === "director";
}

function parseNodeArray(nodes: unknown): Array<{ type: string; sourceNodeIds?: readonly string[] }> {
	if (Array.isArray(nodes)) return nodes as Array<{ type: string; sourceNodeIds?: readonly string[] }>;
	if (typeof nodes !== "string") throw new ToolGatewayError("INVALID_INPUT", "创建节点参数必须是节点数组。", {});

	let parsed: unknown;
	try {
		parsed = JSON.parse(nodes);
	} catch {
		throw new ToolGatewayError("INVALID_INPUT", "创建节点参数不是有效的 JSON 数组。", {});
	}
	if (!Value.Check(NodeArraySchema, parsed))
		throw new ToolGatewayError("INVALID_INPUT", "创建节点参数不符合节点数组契约。", {});
	return parsed as Array<{ type: string; sourceNodeIds?: readonly string[] }>;
}

function parseNodeIdArray(nodeIds: unknown): string[] {
	if (Array.isArray(nodeIds)) return nodeIds as string[];
	if (typeof nodeIds !== "string") throw new ToolGatewayError("INVALID_INPUT", "删除节点参数必须是节点 ID 数组。", {});

	let parsed: unknown;
	try {
		parsed = JSON.parse(nodeIds);
	} catch {
		throw new ToolGatewayError("INVALID_INPUT", "删除节点参数不是有效的 JSON 数组。", {});
	}
	if (!Value.Check(NodeIdArraySchema, parsed))
		throw new ToolGatewayError("INVALID_INPUT", "删除节点参数不符合节点 ID 数组契约。", {});
	return parsed as string[];
}

function defaultIdempotencyKey(context: RuntimeToolContext, toolCallId: string): string {
	return `${context.runId ?? context.sessionId}:canvas:${toolCallId}`.slice(0, 128);
}

function tool<T extends TSchema>(
	name: string,
	label: string,
	description: string,
	parameters: T,
	execute: AgentTool<T>["execute"],
): AgentTool<T> {
	const wrappedExecute: AgentTool<T>["execute"] = async (toolCallId, params, signal, onUpdate) => {
		try {
			return await execute(toolCallId, params, signal, onUpdate);
		} catch (error) {
			if (error instanceof ToolGatewayError)
				throw new ToolGatewayError(error.code, `[${error.code}] ${error.message}`, error.details, error.statusCode);
			const code = toolErrorCodeFromMessage(error);
			if (code) throw new Error(`[${code}] ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
	};
	return { name, label, description, parameters, executionMode: "sequential", execute: wrappedExecute };
}

async function resolveGenerationModel(context: RuntimeToolContext, requestedModel: string): Promise<string> {
	const resolver = (context.gateway as Partial<ToolGateway>).resolveGenerationModel;
	return typeof resolver === "function"
		? resolver.call(context.gateway, context.userId, requestedModel, context.requestId)
		: requestedModel;
}

async function withResolvedComposeInputs(
	read: ReadTools,
	context: RuntimeToolContext,
	modelType: string,
	modelParams: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	if (modelType !== "compose" && modelType !== "compose-1.0") return modelParams;
	if (Array.isArray(modelParams.inputUrls) || Array.isArray(modelParams.inputs)) return modelParams;
	const nodeIds = Array.isArray(modelParams.inputNodeIds)
		? modelParams.inputNodeIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
		: [];
	if (nodeIds.length < 2) return modelParams;
	const nodes = await read.getSelectedNodes(context.userId, context.canvasId, nodeIds, context.requestId);
	const urls = nodes
		.map((node) => {
			const record = typeof node === "object" && node !== null ? (node as Record<string, unknown>) : {};
			const output =
				typeof record.output === "object" && record.output !== null
					? (record.output as Record<string, unknown>)
					: {};
			const params =
				typeof record.params === "object" && record.params !== null
					? (record.params as Record<string, unknown>)
					: {};
			return [output.url, params.output_url, params.lastOutputUrl, params.url].find(nonEmptyString);
		})
		.filter((url): url is string => Boolean(url));
	if (urls.length < 2)
		throw new ToolGatewayError(
			"INVALID_INPUT",
			"合成输入节点必须都已有成功的视频产物。",
			{ inputNodeIds: nodeIds },
			400,
		);
	return { ...modelParams, inputUrls: urls };
}

function assertComposeInputs(modelType: string, modelParams: Record<string, unknown>): void {
	if (modelType !== "compose" && modelType !== "compose-1.0") return;
	const input = modelParams.inputUrls ?? modelParams.inputs ?? modelParams.inputNodeIds;
	const count = Array.isArray(input) ? input.filter((value) => typeof value === "string" && value.trim()).length : 0;
	if (count < 2)
		throw new ToolGatewayError(
			"INVALID_INPUT",
			"视频合成至少需要 2 段视频输入；请先创建并连接至少两个视频节点，再提交生成。",
			{ providedInputCount: count },
			400,
		);
}

function toolErrorCodeFromMessage(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : String(error);
	const known = [
		"PERMISSION_DENIED",
		"NOT_FOUND",
		"INVALID_INPUT",
		"BATCH_LIMIT_EXCEEDED",
		"VERSION_CONFLICT",
		"INSUFFICIENT_POINTS",
		"MODEL_UNAVAILABLE",
		"MODEL_TIMEOUT",
		"CONTENT_BLOCKED",
		"COST_CAP_EXCEEDED",
		"CANVAS_UNAVAILABLE",
	] as const;
	return known.find((code) => message === code || message.includes(`[${code}]`));
}

function result(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

function rememberCanvasVersion(context: RuntimeToolContext, value: unknown, force = false): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
	const record = value as Record<string, unknown>;
	const details = record.details;
	const version =
		record.canvasVersion ??
		(record.canvas && typeof record.canvas === "object"
			? (record.canvas as Record<string, unknown>).version
			: undefined) ??
		(details && typeof details === "object" ? (details as Record<string, unknown>).canvasVersion : undefined);
	if (
		typeof version === "number" &&
		Number.isInteger(version) &&
		version >= context.canvasVersion &&
		(force || !context.canvasVersionPinned)
	)
		context.canvasVersion = version;
	return value;
}

async function withAuthoritativePrompt(
	read: ReadTools,
	context: RuntimeToolContext,
	nodeId: string,
	modelParams: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	if (nonEmptyString(modelParams.prompt)) return modelParams;
	const node = await read.getNodeDetail(context.userId, context.canvasId, nodeId, context.requestId);
	const params = node.params;
	const nodeParams = typeof params === "object" && params !== null && !Array.isArray(params) ? params : {};
	const nodeParamsRecord = nodeParams as Record<string, unknown>;
	const prompt =
		nonEmptyString(node.prompt) ??
		nonEmptyString(nodeParamsRecord.prompt) ??
		nonEmptyString(nodeParamsRecord.content) ??
		nonEmptyString(nodeParamsRecord.text);
	if (prompt) return { ...modelParams, prompt };

	// A derived target may only contain a reference URL when the user asks to
	// continue from a selected Director/Image node. Reuse the authoritative
	// scene description instead of sending an empty prompt downstream.
	const referenceNodeIds = [...(context.referenceNodeIds ?? [])];
	if (
		referenceNodeIds.length === 0 &&
		typeof (context.gateway as Partial<ToolGateway>).getCanvasSummary === "function"
	) {
		const summary = await read.getCanvasSummary(context.userId, context.canvasId, context.requestId);
		for (const edge of Array.isArray(summary.edges) ? summary.edges : []) {
			if (typeof edge !== "object" || edge === null || Array.isArray(edge)) continue;
			const record = edge as Record<string, unknown>;
			const targetId = stringId(record.targetNodeId ?? record.target);
			const sourceId = stringId(record.sourceNodeId ?? record.source);
			if (targetId === nodeId && sourceId) referenceNodeIds.push(sourceId);
		}
	}
	if (referenceNodeIds.length === 0) return modelParams;
	const references = await read.getSelectedNodes(
		context.userId,
		context.canvasId,
		referenceNodeIds,
		context.requestId,
	);
	for (const reference of references) {
		const record = typeof reference === "object" && reference !== null ? (reference as Record<string, unknown>) : {};
		const referenceParams =
			typeof record.params === "object" && record.params !== null && !Array.isArray(record.params)
				? (record.params as Record<string, unknown>)
				: {};
		const referencePrompt =
			nonEmptyString(record.prompt) ??
			nonEmptyString(referenceParams.prompt) ??
			nonEmptyString(referenceParams.content) ??
			nonEmptyString(referenceParams.text) ??
			nonEmptyString(referenceParams.description) ??
			nonEmptyString(referenceParams.scene);
		if (referencePrompt) return { ...modelParams, prompt: referencePrompt };
	}
	return modelParams;
}

function inferImageOperation(modelParams: Record<string, unknown>): Record<string, unknown> {
	const explicit = nonEmptyString(modelParams.operation);
	if (explicit) {
		if (["extend_right", "extend_left", "outpaint", "outpainting", "扩图"].includes(explicit))
			return { ...modelParams, operation: "outpaint_image" };
		if (["upscale", "enhance", "高清", "超分"].includes(explicit))
			return { ...modelParams, operation: "upscale_image" };
		return modelParams;
	}
	const intent = [modelParams.prompt, modelParams.action, modelParams.content, modelParams.text]
		.map(nonEmptyString)
		.filter((value): value is string => Boolean(value))
		.join(" ");
	if (/outpaint|扩图|扩展(?:画面|边缘|留白)/i.test(intent)) {
		return { ...modelParams, operation: "outpaint_image" };
	}
	if (/upscale|超分|超清|高清(?:放大|增强)/i.test(intent)) {
		return { ...modelParams, operation: "upscale_image" };
	}
	return modelParams;
}

async function assertCanvasVersion(context: RuntimeToolContext): Promise<void> {
	const gateway = context.gateway as ToolGateway & {
		getCanvasSummary?: ToolGateway["getCanvasSummary"];
	};
	if (typeof gateway.getCanvasSummary !== "function") {
		return;
	}
	const summary = await gateway.getCanvasSummary(context.userId, context.canvasId, context.requestId);
	const canvas = summary.canvas;
	const actualVersion =
		typeof canvas === "object" && canvas !== null && !Array.isArray(canvas)
			? (canvas as Record<string, unknown>).version
			: undefined;
	if (
		typeof actualVersion === "number" &&
		Number.isInteger(actualVersion) &&
		actualVersion !== context.canvasVersion
	) {
		throw new ToolGatewayError(
			"VERSION_CONFLICT",
			"画布已在其他会话更新，请刷新后重试",
			{ expectedVersion: context.canvasVersion, actualVersion },
			409,
		);
	}
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringId(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const id = (value as Record<string, unknown>).id ?? (value as Record<string, unknown>).nodeId;
	return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}
