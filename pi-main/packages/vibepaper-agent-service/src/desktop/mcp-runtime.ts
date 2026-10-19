import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Value } from "typebox/value";

import { ApprovalService } from "../application/approval-service.ts";
import type { PlannedAction } from "../domain/action-approval.ts";
import type { RuntimeToolContext, RuntimeToolGateway } from "../tools/runtime-tools.ts";
import {
	createRuntimeTools,
	desktopGenerationConfirmationItems,
	parseDesktopMcpNodeArray,
	submitApprovedGenerationAction,
} from "../tools/runtime-tools.ts";
import type { DesktopAgentStores } from "./agent-stores.ts";
import type { DesktopAgentControlStore, DesktopMcpOperation } from "./control-store.ts";

const MAX_OPERATION_ID_LENGTH = 128;
const MCP_TOOLS = new Set([
	"get_canvas_summary",
	"get_selected_nodes",
	"get_node_detail",
	"list_models",
	"search_assets",
	"check_task_status",
	"create_nodes",
	"update_node_config",
	"connect_nodes",
	"layout_nodes",
	"prepare_generation",
]);
const WRITE_TOOLS = new Set(["create_nodes", "update_node_config", "connect_nodes", "layout_nodes"]);
const GENERATION_TOOLS = new Set(["submit_generation", "submit_generation_batch"]);
const NODE_CONFIG_FIELDS = new Set(["x", "y", "width", "height", "params", "prompt", "modelRef", "creativeType"]);
const FORBIDDEN_NODE_FIELDS = new Set([
	"id",
	"nodeId",
	"taskId",
	"task_id",
	"status",
	"execStatus",
	"output",
	"outputs",
	"currentOutputId",
	"outputPath",
	"outputUrl",
	"url",
	"stale",
	"groupId",
	"stackId",
	"createdAt",
	"updatedAt",
]);
const SENSITIVE_CONFIG_KEY =
	/^(?:api[_-]?key|access[_-]?(?:key|token)|secret(?:[_-]?key)?|password|authorization|credentials?|bearer(?:[_-]?token)?|client[_-]?secret|private[_-]?key|refresh[_-]?token)$/iu;

export type McpDesktopToolDefinition = {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations: {
		readOnlyHint: boolean;
		destructiveHint: boolean;
		idempotentHint: boolean;
		openWorldHint: boolean;
	};
};

export type McpRuntimeInput = {
	toolName: string;
	arguments: unknown;
	operationId?: string;
	expectedVersion?: number;
	clientId: string;
	grantId?: string;
	projectId: string;
	canvasId: string;
	canvasVersion: number;
	providerRevision?: number;
	providerRevisions?: Record<string, number>;
	control?: Pick<
		DesktopAgentControlStore,
		| "beginMcpOperation"
		| "getMcpOperation"
		| "updateMcpOperation"
		| "createMcpProposal"
		| "getMcpProposal"
		| "findMcpProposalByOperation"
		| "updateMcpProposal"
		| "listMcpProposals"
	>;
	gateway: RuntimeToolGateway;
	approvals: ApprovalService;
};

export type McpRuntimeExecution = {
	content: Array<{ type: "text"; text: string }>;
	structuredContent: Record<string, unknown>;
	proposal?: {
		proposalId: string;
		approvalToken: string;
		action: PlannedAction;
		confirmationItems: Awaited<ReturnType<typeof desktopGenerationConfirmationItems>>;
	};
};

export function mcpRuntimeContext(
	input: Omit<McpRuntimeInput, "toolName" | "arguments" | "operationId" | "expectedVersion">,
): RuntimeToolContext {
	return {
		userId: input.projectId,
		sessionId: mcpSessionId(input.clientId),
		canvasId: input.canvasId,
		canvasVersion: input.canvasVersion,
		canvasVersionPinned: true,
		gateway: input.gateway,
		approvals: input.approvals,
		desktopMode: true,
	};
}

export function listMcpRuntimeTools(
	input: Omit<McpRuntimeInput, "toolName" | "arguments" | "operationId" | "expectedVersion">,
): McpDesktopToolDefinition[] {
	const tools = createRuntimeTools(mcpRuntimeContext(input));
	const definitions: McpDesktopToolDefinition[] = [];
	for (const tool of tools) {
		if (tool.name === "delete_nodes" || tool.name === "request_render_audit") continue;
		if (GENERATION_TOOLS.has(tool.name)) continue;
		const inputSchema = extendInputSchema(tool.parameters as Record<string, unknown>, WRITE_TOOLS.has(tool.name));
		if (tool.name === "connect_nodes") {
			inputSchema.properties = {
				sourceNodeId: { type: "string", minLength: 1, maxLength: 256 },
				targetNodeId: { type: "string", minLength: 1, maxLength: 256 },
				operationId: { type: "string", minLength: 1, maxLength: MAX_OPERATION_ID_LENGTH },
				expectedVersion: { type: "integer", minimum: 0 },
			};
			inputSchema.required = ["sourceNodeId", "targetNodeId", "operationId", "expectedVersion"];
		}
		definitions.push({
			name: tool.name,
			title: tool.label,
			description:
				tool.name === "connect_nodes"
					? "按明确的来源和目标创建一条参考连线。"
					: tool.name === "update_node_config"
						? "只更新节点的布局、提示词、模型引用或普通参数；不能伪造任务状态或输出。"
						: (tool.description ?? tool.label),
			inputSchema,
			annotations: {
				readOnlyHint: !WRITE_TOOLS.has(tool.name),
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		});
	}
	definitions.push({
		name: "prepare_generation",
		title: "准备生成提案",
		description:
			"准备一项或多项生成请求后，由桥接通过 MCP form elicitation 在当前客户端请求一次生成确认。表单只收集本次确认决定，不收集 API Key 或其他凭据；客户端拒绝、超时、断线或不支持 form elicitation 时不得提交任务。客户端确认后返回已提交、拒绝、过期或状态未知等结果；服务端不能验证客户端内部由谁点击确认。",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				operationId: { type: "string", minLength: 1, maxLength: MAX_OPERATION_ID_LENGTH },
				expectedVersion: { type: "integer", minimum: 0 },
				generations: {
					type: "array",
					minItems: 1,
					maxItems: 20,
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							nodeId: { type: "string", minLength: 1, maxLength: 256 },
							modelType: {
								type: "string",
								minLength: 1,
								maxLength: 256,
								description:
									"填写 list_models 返回的精确 name 或 bindingId；不要使用 displayName、apiModelId、简称或模糊匹配。服务端会将该标识解析为规范 name 后提交生成。",
							},
							modelParams: { type: "object", additionalProperties: true },
							overwrite: { type: "boolean" },
						},
						required: ["nodeId", "modelType", "modelParams", "overwrite"],
					},
				},
			},
			required: ["operationId", "expectedVersion", "generations"],
		},
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	});
	return definitions;
}

/** Main-backed capabilities still use the same reviewed MCP schema boundary. */
export function listMcpAuxiliaryTools(): McpDesktopToolDefinition[] {
	const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
		type: "object",
		additionalProperties: false,
		properties,
		required,
	});
	return [
		auxiliaryTool("get_context", "读取授权上下文", "读取当前桌面连接授权范围内的项目、画布和能力状态。", object({})),
		auxiliaryTool("get_operation", "查询操作状态", "查询当前连接发起的画布操作或生成提案状态。", {
			...object({
				operationId: { type: "string", minLength: 1, maxLength: MAX_OPERATION_ID_LENGTH },
				proposalId: { type: "string", minLength: 1, maxLength: 128 },
			}),
			anyOf: [{ required: ["operationId"] }, { required: ["proposalId"] }],
		}),
		auxiliaryTool(
			"read_task_output",
			"读取任务结果或媒体预览",
			"分页读取授权画布中已完成的文本任务；查询图片或视频元数据。媒体默认只返回元数据，只有显式设置 mode=preview 且连接获准读取对应媒体时才返回有大小上限的图片/视频内容。",
			object(
				{
					taskId: { type: "string", minLength: 1, maxLength: 128 },
					outputIndex: { type: "integer", minimum: 0, maximum: 3, default: 0 },
					mode: { type: "string", enum: ["metadata", "preview"], default: "metadata" },
					offset: { type: "integer", minimum: 0, maximum: 1_000_000, default: 0 },
					limit: { type: "integer", minimum: 1, maximum: 5000, default: 5000 },
				},
				["taskId"],
			),
		),
		auxiliaryTool(
			"list_provider_configuration",
			"读取提供方配置",
			"先读取此提供方的公开配置、当前 revision、可用模型和凭据授权信息；不会返回密钥。credentialSources 中的 sourceRef 可用于同一 providerId 和 fieldName 的 authorized_env 配置，不能把环境变量名或密钥值当 sourceRef。",
			object(
				{
					providerId: { type: "string", minLength: 1, maxLength: 80 },
				},
				["providerId"],
			),
		),
		auxiliaryTool(
			"configure_provider",
			"配置模型提供方",
			"先调用 list_provider_configuration 获取当前 provider.revision、模型目录、allowedCredentialFields 和 credentialSources。publicConfig 只接受下方列出的非秘密配置；模型 ID 必须取该提供方返回的 models[].id。用户已在本地客户端范围中选定该提供方和可写凭据字段，因此配置会在授权范围内直接保存，不等待桌面批准卡。使用 authorized_env 时，将每个授权凭据字段映射到同一提供方、同一 fieldName 的 credentialSources[].sourceRef，不要传环境变量名或密钥值。用稳定唯一的 operationId 关联本次写入；若状态不确定，先调用 get_provider_operation 查询，不要盲目重放。只有 status=saved 才表示配置已保存。秘密只写入加密凭据存储，桌面输入路径不会把密钥发给此客户端。",
			object(
				{
					providerId: { type: "string", minLength: 1, maxLength: 80 },
					expectedRevision: {
						type: "integer",
						minimum: 0,
						description:
							"使用 list_provider_configuration 返回的 provider.revision；revision 冲突时重新读取当前配置后再决定如何更新。",
					},
					operationId: {
						type: "string",
						minLength: 1,
						maxLength: MAX_OPERATION_ID_LENGTH,
						description: "为这次配置写入生成稳定且唯一的操作标识；查询不确定的写入状态时复用同一值。",
					},
					publicConfig: {
						type: "object",
						additionalProperties: false,
						description:
							"可选的非秘密配置补丁。模型 ID 和每个模型可用参数从 list_provider_configuration 返回的目录读取；省略字段保留当前值或提供方默认值。",
						properties: {
							providerId: {
								type: "string",
								minLength: 1,
								maxLength: 80,
								description:
									"可选；若提供，必须与 configure_provider 的同级 providerId 完全相同，通常省略即可。",
							},
							baseUrl: {
								type: "string",
								maxLength: 2048,
								description: "提供方官方 HTTPS 地址；使用 provider.baseUrl 或 allowedHosts 中列出的主机。",
							},
							enabledModelIds: {
								type: "array",
								maxItems: 200,
								uniqueItems: true,
								items: { type: "string", minLength: 1, maxLength: 256 },
								description: "要启用的模型 ID；必须来自此提供方返回的 models[].id。",
							},
							defaultModelIds: {
								type: "object",
								maxProperties: 4,
								propertyNames: { enum: ["text", "image", "video", "audio"] },
								additionalProperties: { type: "string", minLength: 1, maxLength: 256 },
								description: "按模态设置默认模型 ID；每个 ID 必须属于已启用且模态匹配的 models[].id。",
							},
							modelDefaults: {
								type: "object",
								maxProperties: 200,
								additionalProperties: {
									type: "object",
									maxProperties: 5,
									properties: {
										ratio: { type: "string" },
										size: { type: "string" },
										resolution: { type: "string" },
										duration: { type: "integer" },
										generate_audio: { type: "boolean" },
									},
									additionalProperties: false,
								},
								description:
									"按目录中的模型 ID 设置默认参数；参数名和值必须符合该模型返回的 defaults 和 constraints。",
							},
							timeoutSeconds: {
								type: "integer",
								minimum: 10,
								maximum: 600,
								description: "请求超时秒数，范围为 10 到 600。",
							},
						},
					},
					credentialInput: {
						description: "只通过此凭据输入字段选择授权来源；不要将秘密放入 publicConfig。",
						oneOf: [
							object(
								{
									source: { const: "inline" },
									credentials: {
										type: "object",
										minProperties: 1,
										additionalProperties: { type: "string", maxLength: 8192 },
									},
								},
								["source", "credentials"],
							),
							object(
								{
									source: { const: "authorized_env" },
									sourceRefs: {
										type: "object",
										minProperties: 1,
										description:
											"按凭据字段名映射 list_provider_configuration 返回的同提供方、同字段 credentialSources[].sourceRef。",
										additionalProperties: {
											type: "string",
											minLength: 1,
											maxLength: 256,
											description: "该字段获授权的 sourceRef；不是环境变量名或密钥值。",
										},
									},
								},
								["source", "sourceRefs"],
							),
							object({ source: { const: "desktop_input" } }, ["source"]),
						],
					},
				},
				["providerId", "expectedRevision", "operationId"],
			),
		),
		auxiliaryTool(
			"test_provider_connection",
			"检测提供方连接",
			"对已保存配置执行已核验的官方鉴权检测；不创建生成任务。",
			object(
				{
					providerId: { type: "string", minLength: 1, maxLength: 80 },
					expectedRevision: { type: "integer", minimum: 0 },
				},
				["providerId", "expectedRevision"],
			),
		),
		auxiliaryTool(
			"get_provider_operation",
			"查询提供方配置操作",
			"查询当前授权客户端在其提供方范围内开始的凭据写入状态，不返回秘密。not_found 表示此操作尚无持久化记录；先刷新提供方配置和 revision，再决定是否以原 operationId 重试。",
			object(
				{
					providerId: { type: "string", minLength: 1, maxLength: 80 },
					operationId: { type: "string", minLength: 1, maxLength: MAX_OPERATION_ID_LENGTH },
				},
				["providerId", "operationId"],
			),
		),
	];
}

function auxiliaryTool(
	name: string,
	title: string,
	description: string,
	inputSchema: Record<string, unknown>,
): McpDesktopToolDefinition {
	return {
		name,
		title,
		description,
		inputSchema,
		annotations: {
			readOnlyHint: !["configure_provider", "test_provider_connection"].includes(name),
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: ["configure_provider", "test_provider_connection"].includes(name),
		},
	};
}

export async function executeMcpRuntimeTool(input: McpRuntimeInput): Promise<McpRuntimeExecution> {
	if (!MCP_TOOLS.has(input.toolName)) throw codedError("MCP_TOOL_UNAVAILABLE");
	if (!isRecord(input.arguments)) throw codedError("INVALID_INPUT");
	const context = mcpRuntimeContext(input);
	if (input.toolName === "prepare_generation") context.approvalActionId = stableMcpApprovalId(input);
	const definitions = createRuntimeTools(context);
	const supplied = input.arguments;
	if (input.toolName === "prepare_generation") {
		assertOnlyKeys(supplied, ["operationId", "expectedVersion", "generations"]);
		const { operationId, expectedVersion, generations } = supplied;
		validateWriteEnvelope(operationId, expectedVersion);
		if (!Array.isArray(generations) || generations.length < 1 || generations.length > 20)
			throw codedError("INVALID_INPUT");
		for (const generation of generations) {
			if (!isRecord(generation)) throw codedError("INVALID_INPUT");
			assertOnlyKeys(generation, ["nodeId", "modelType", "modelParams", "overwrite"]);
			assertNoCredentialFields(generation.modelParams);
		}
		const operation = await beginMcpOperation(input, "prepare_generation", supplied);
		const replay = await replayPreparedGeneration(input, operation);
		if (replay) return replay;
		assertOperationCanvasVersion(input, operation.record, expectedVersion, operation.status === "created");
		const runtimeToolName = generations.length === 1 ? "submit_generation" : "submit_generation_batch";
		const runtimeTool = requireRuntimeTool(definitions, runtimeToolName);
		const selectedBindings = await Promise.all(
			generations.map((item) => resolveGenerationBinding(input.gateway, input.projectId, item)),
		);
		const resolvedGenerations = selectedBindings.map((binding) => binding.generation);
		const selectedProviderIds = [
			...new Set(
				selectedBindings
					.map((binding) => binding.providerId)
					.filter((providerId): providerId is string => Boolean(providerId)),
			),
		];
		const proposalProviderRevisions: Record<string, number> | undefined =
			input.providerRevisions === undefined
				? undefined
				: Object.fromEntries(
						selectedProviderIds.map((providerId) => {
							const revision = input.providerRevisions?.[providerId];
							if (typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0)
								return [providerId, revision];
							const binding = selectedBindings.find((entry) => entry.providerId === providerId);
							if (binding?.providerType === "local") return [providerId, 0];
							throw codedError("PROVIDER_REVISION_UNAVAILABLE");
						}),
					);
		const runtimeArguments =
			resolvedGenerations.length === 1 ? resolvedGenerations[0] : { generations: resolvedGenerations };
		if (!Value.Check(runtimeTool.parameters, runtimeArguments)) throw codedError("INVALID_INPUT");
		try {
			const result = await runtimeTool.execute(
				stableMcpOperationKey(input, String(operationId)),
				runtimeArguments as never,
			);
			const details = isRecord(result.details) ? result.details : {};
			const action = isRecord(details.confirmation) ? (details.confirmation as unknown as PlannedAction) : null;
			if (!action || typeof action.approvalToken !== "string" || typeof action.actionId !== "string")
				throw codedError("CONFIRMATION_REQUIRED");
			const confirmationItems = await desktopGenerationConfirmationItems(action, input.gateway);
			const structuredContent = {
				proposalId: action.actionId,
				status: "awaiting_confirmation",
				expiresAt: action.binding.expiresAt,
				items: confirmationItems.map((item) => sanitizePublicValue(item)),
			};
			if (input.control && input.grantId) {
				input.control.createMcpProposal({
					proposalId: action.actionId,
					clientId: input.clientId,
					grantId: input.grantId,
					operationId: String(operationId),
					projectId: input.projectId,
					canvasId: input.canvasId,
					canvasVersion: input.canvasVersion,
					modelBindingId: String((generations[0] as Record<string, unknown>).modelType),
					...(input.providerRevision === undefined ? {} : { providerRevision: input.providerRevision }),
					...(proposalProviderRevisions === undefined ? {} : { providerRevisions: proposalProviderRevisions }),
					approvalActionId: action.actionId,
					status: "awaiting_confirmation",
					expiresAt: action.binding.expiresAt,
				});
				input.control.updateMcpOperation({
					operationId: String(operationId),
					clientId: input.clientId,
					grantId: input.grantId,
					status: "awaiting_confirmation",
					result: structuredContent,
				});
			}
			return {
				content: [{ type: "text", text: "生成提案已创建，等待 MCP 客户端表单确认。" }],
				structuredContent,
				proposal: { proposalId: action.actionId, approvalToken: action.approvalToken, action, confirmationItems },
			};
		} catch (error) {
			await persistOperationFailure(input, String(operationId), error);
			throw error;
		}
	}

	const tool = requireRuntimeTool(definitions, input.toolName);
	const exposedSchema =
		input.toolName === "connect_nodes"
			? { properties: { sourceNodeId: {}, targetNodeId: {}, operationId: {}, expectedVersion: {} } }
			: extendInputSchema(tool.parameters as Record<string, unknown>, WRITE_TOOLS.has(input.toolName));
	assertOnlyKeys(supplied, Object.keys(exposedSchema.properties as Record<string, unknown>));
	if (WRITE_TOOLS.has(input.toolName)) {
		validateWriteEnvelope(supplied.operationId, supplied.expectedVersion);
	}
	const normalized = { ...supplied };
	let toolCallId = "mcp-read";
	if (WRITE_TOOLS.has(input.toolName)) {
		toolCallId = stableMcpOperationKey(input, supplied.operationId as string);
		delete normalized.operationId;
		delete normalized.expectedVersion;
		normalized.idempotencyKey = toolCallId;
		normalized.expectedVersion = input.canvasVersion;
	}
	if (input.toolName === "connect_nodes") {
		const sourceNodeId = supplied.sourceNodeId;
		const targetNodeId = supplied.targetNodeId;
		if (typeof sourceNodeId !== "string" || typeof targetNodeId !== "string" || sourceNodeId === targetNodeId)
			throw codedError("INVALID_INPUT");
		delete normalized.sourceNodeId;
		delete normalized.targetNodeId;
		normalized.nodeIds = [sourceNodeId, targetNodeId];
	}
	if (input.toolName === "update_node_config") assertSafeNodeConfig(supplied.config);
	if (input.toolName === "create_nodes") {
		const parsedNodes = parseDesktopMcpNodeArray(supplied.nodes);
		assertNoCredentialFields(parsedNodes);
		normalized.nodes = parsedNodes;
	}
	if (!Value.Check(tool.parameters, normalized)) throw codedError("INVALID_INPUT");
	const operation = WRITE_TOOLS.has(input.toolName)
		? await beginMcpOperation(input, input.toolName, supplied)
		: undefined;
	if (operation) {
		const replay = replayMcpOperation(operation.record);
		if (replay) return replay;
		assertOperationCanvasVersion(input, operation.record, supplied.expectedVersion, operation.status === "created");
	}
	try {
		const result = await tool.execute(toolCallId, normalized as never);
		const rawDetails = isRecord(result.details) ? result.details : { result: result.details };
		let details =
			input.toolName === "list_models" ? publicModelBindings(rawDetails) : sanitizePublicValue(rawDetails);
		const completedSteps = operation && input.grantId ? drainMcpStepResults(input.gateway) : [];
		if (completedSteps.length) details = { ...details, completedEffects: completedSteps };
		const execution = {
			content: [{ type: "text" as const, text: JSON.stringify(details).slice(0, 20_000) }],
			structuredContent: details,
		};
		if (operation && input.grantId) {
			input.control?.updateMcpOperation({
				operationId: String(supplied.operationId),
				clientId: input.clientId,
				grantId: input.grantId,
				status: "completed",
				result: details,
			});
		}
		return execution;
	} catch (error) {
		if (operation) await persistOperationFailure(input, String(supplied.operationId), error);
		throw error;
	}
}

async function beginMcpOperation(
	input: McpRuntimeInput,
	kind: string,
	argumentsValue: Record<string, unknown>,
): Promise<{ status: "created" | "replay" | "conflict"; record: DesktopMcpOperation }> {
	if (!input.control || !input.grantId) throw codedError("MCP_OPERATION_STORE_UNAVAILABLE");
	const operationId = argumentsValue.operationId;
	if (typeof operationId !== "string") throw codedError("INVALID_INPUT");
	const begun = input.control.beginMcpOperation({
		operationId,
		clientId: input.clientId,
		grantId: input.grantId,
		projectId: input.projectId,
		canvasId: input.canvasId,
		kind,
		payloadDigest: sha256(stableStringify({ kind, arguments: argumentsValue })),
		canvasVersion: argumentsValue.expectedVersion as number,
	});
	if (begun.status === "conflict") throw codedError("IDEMPOTENCY_CONFLICT");
	if (!begun.record) throw codedError("MCP_OPERATION_STORE_UNAVAILABLE");
	return { status: begun.status, record: begun.record };
}

function assertOperationCanvasVersion(
	input: McpRuntimeInput,
	operation: DesktopMcpOperation,
	expectedVersion: unknown,
	isFresh: boolean,
): void {
	if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== operation.canvasVersion)
		throw codedError("CANVAS_VERSION_CONFLICT");
	if (input.canvasVersion !== operation.canvasVersion) {
		if (operation.status === "started" && input.control && input.grantId) {
			if (isFresh) {
				input.control.updateMcpOperation({
					operationId: operation.operationId,
					clientId: input.clientId,
					grantId: input.grantId,
					status: "invalidated",
					errorCode: "CANVAS_VERSION_CONFLICT",
				});
				throw codedError("CANVAS_VERSION_CONFLICT");
			}
			throw codedError("MCP_OPERATION_RECOVERY_REQUIRED");
		}
		throw codedError("CANVAS_VERSION_CONFLICT");
	}
}

function replayMcpOperation(operation: DesktopMcpOperation): McpRuntimeExecution | null {
	if (operation.status === "started") return null;
	if (operation.status === "awaiting_confirmation") {
		return {
			content: [{ type: "text", text: "生成提案已创建，等待 MCP 客户端表单确认。" }],
			structuredContent: operation.result ?? { operationId: operation.operationId, status: operation.status },
		};
	}
	if (operation.status === "submitting" || operation.status === "submission_unknown") {
		return {
			content: [{ type: "text", text: "任务提交状态待核验，请查询操作状态。" }],
			structuredContent: operation.result ?? { operationId: operation.operationId, status: operation.status },
		};
	}
	if (operation.status === "failed") throw codedError(operation.errorCode ?? "MCP_OPERATION_FAILED");
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify(
					operation.result ?? {
						operationId: operation.operationId,
						status: operation.status,
						...(operation.errorCode ? { errorCode: operation.errorCode } : {}),
					},
				).slice(0, 20_000),
			},
		],
		structuredContent: operation.result ?? {
			operationId: operation.operationId,
			status: operation.status,
			...(operation.errorCode ? { errorCode: operation.errorCode } : {}),
		},
	};
}

async function replayPreparedGeneration(
	input: McpRuntimeInput,
	operation: { status: "created" | "replay" | "conflict"; record: DesktopMcpOperation },
): Promise<McpRuntimeExecution | null> {
	if (operation.record.status !== "awaiting_confirmation") {
		const replay = replayMcpOperation(operation.record);
		if (replay) return replay;
	}
	if (operation.status !== "replay" || !input.control || !input.grantId) return null;
	const proposal = input.control.findMcpProposalByOperation({
		operationId: operation.record.operationId,
		clientId: input.clientId,
		grantId: input.grantId,
	});
	if (!proposal || proposal.status !== "awaiting_confirmation") {
		if (operation.record.status === "awaiting_confirmation") throw codedError("MCP_OPERATION_RECOVERY_REQUIRED");
		return null;
	}
	const approval = await input.approvals.findApprovalRecord(proposal.approvalActionId);
	const action = approval?.status === "pending" ? approval.action : undefined;
	const expiresAt = action?.binding.expiresAt;
	const expired =
		typeof expiresAt !== "number" ||
		!Number.isFinite(expiresAt) ||
		expiresAt <= Date.now() ||
		proposal.expiresAt <= Date.now();
	const providerChanged =
		(proposal.providerRevision !== undefined && proposal.providerRevision !== input.providerRevision) ||
		Object.entries(proposal.providerRevisions ?? {}).some(
			([providerId, revision]) => input.providerRevisions?.[providerId] !== revision,
		);
	if (!action?.approvalToken || expired || action.canvasVersion !== input.canvasVersion || providerChanged) {
		const errorCode = expired
			? "CONFIRMATION_EXPIRED"
			: providerChanged
				? "PROVIDER_REVISION_CONFLICT"
				: "CANVAS_VERSION_CONFLICT";
		const result = {
			operationId: operation.record.operationId,
			proposalId: proposal.proposalId,
			status: "invalidated",
			errorCode,
		};
		input.control.updateMcpProposal({
			proposalId: proposal.proposalId,
			clientId: input.clientId,
			grantId: input.grantId,
			status: "invalidated",
			errorCode,
		});
		input.control.updateMcpOperation({
			operationId: operation.record.operationId,
			clientId: input.clientId,
			grantId: input.grantId,
			status: "invalidated",
			result,
			errorCode,
		});
		if (action?.approvalToken)
			await input.approvals.rejectApproval(proposal.approvalActionId, action.approvalToken).catch(() => undefined);
		return replayMcpOperation(
			input.control.getMcpOperation({
				operationId: operation.record.operationId,
				clientId: input.clientId,
				grantId: input.grantId,
			}) ?? operation.record,
		);
	}
	const confirmationItems = await desktopGenerationConfirmationItems(action, input.gateway);
	const result = {
		proposalId: proposal.proposalId,
		status: "awaiting_confirmation",
		expiresAt: action.binding.expiresAt,
		items: confirmationItems.map((item) => sanitizePublicValue(item)),
	};
	input.control.updateMcpOperation({
		operationId: operation.record.operationId,
		clientId: input.clientId,
		grantId: input.grantId,
		status: "awaiting_confirmation",
		result,
	});
	return {
		content: [{ type: "text", text: "生成提案已创建，等待 MCP 客户端表单确认。" }],
		structuredContent: result,
		proposal: { proposalId: proposal.proposalId, approvalToken: action.approvalToken, action, confirmationItems },
	};
}

async function persistOperationFailure(input: McpRuntimeInput, operationId: string, error: unknown): Promise<void> {
	if (!input.control || !input.grantId) return;
	const code = safeErrorCode(error, "MCP_OPERATION_FAILED");
	const completedSteps = drainMcpStepResults(input.gateway);
	const hasUncertainStep = completedSteps.some((step) => step.status === "uncertain");
	const hasCompletedStep = completedSteps.some((step) => step.status === "completed");
	const status = hasUncertainStep ? "submission_unknown" : hasCompletedStep ? "partial" : "failed";
	input.control.updateMcpOperation({
		operationId,
		clientId: input.clientId,
		grantId: input.grantId,
		status,
		...(status !== "failed" ? { result: { operationId, status, errorCode: code, effects: completedSteps } } : {}),
		errorCode: code,
	});
}

function drainMcpStepResults(gateway: RuntimeToolGateway): Array<Record<string, string | number>> {
	const tracker = gateway as RuntimeToolGateway & { drainMcpStepResults?: () => unknown };
	if (typeof tracker.drainMcpStepResults !== "function") return [];
	try {
		const results = tracker.drainMcpStepResults();
		if (!Array.isArray(results)) return [];
		return results
			.slice(0, 100)
			.filter(isRecord)
			.map(
				(step) =>
					Object.fromEntries(
						Object.entries(step).filter(
							([, value]) =>
								typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)),
						),
					) as Record<string, string | number>,
			);
	} catch {
		return [];
	}
}

function stableMcpApprovalId(input: Pick<McpRuntimeInput, "clientId" | "grantId"> & { arguments?: unknown }): string {
	const args = isRecord(input.arguments) ? input.arguments : {};
	const operationId = typeof args.operationId === "string" ? args.operationId : "missing";
	return `mcp_${sha256(`${input.clientId}\0${input.grantId ?? "missing"}\0${operationId}`).slice(0, 60)}`;
}

function stableMcpOperationKey(input: Pick<McpRuntimeInput, "clientId" | "grantId">, operationId: string): string {
	return `mcp:${sha256(`${input.clientId}\0${input.grantId ?? "missing"}\0${operationId}`)}`;
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export async function confirmExternalMcpGeneration(
	input: {
		clientId: string;
		projectId: string;
		canvasId: string;
		actionId: string;
		approvalToken: string;
		accept: boolean;
		currentCanvasVersion: number;
	},
	stores: Pick<DesktopAgentStores, "projectId" | "control">,
	gateway: RuntimeToolGateway,
): Promise<Record<string, unknown>> {
	if (input.projectId !== stores.projectId || input.actionId.length > 128 || input.approvalToken.length > 4096)
		throw codedError("CONFIRMATION_REQUIRED");
	const record = await stores.control.find(input.actionId);
	if (
		!record ||
		record.action.userId !== input.projectId ||
		record.action.canvasId !== input.canvasId ||
		record.action.sessionId !== mcpSessionId(input.clientId) ||
		!GENERATION_TOOLS.has(record.action.toolName)
	)
		throw codedError("CONFIRMATION_REQUIRED");
	const approval = new ApprovalService(stores.control, stores.control.getOrCreateApprovalSecret(), 10 * 60);
	await approval.validateApprovalToken(input.actionId, input.approvalToken);
	if (!input.accept) {
		if (record.status === "pending") await approval.rejectApproval(input.actionId, input.approvalToken);
		return { proposalId: input.actionId, status: "rejected" };
	}
	const summary = await gateway.getCanvasSummary(input.projectId, input.canvasId);
	const canvas = isRecord(summary) && isRecord(summary.canvas) ? summary.canvas : {};
	if (
		!Number.isSafeInteger(canvas.version) ||
		canvas.version !== input.currentCanvasVersion ||
		canvas.version !== record.action.canvasVersion
	) {
		if (record.status === "pending")
			await approval.rejectApproval(input.actionId, input.approvalToken).catch(() => undefined);
		return { proposalId: input.actionId, status: "invalidated", errorCode: "CANVAS_VERSION_CONFLICT" };
	}
	const approved = await approval.consumeApprovalIdempotently(
		input.actionId,
		input.approvalToken,
		canvas.version as number,
	);
	const tasks = await submitApprovedGenerationAction(approved, gateway);
	return { proposalId: input.actionId, status: "submitted", tasks };
}

export async function invalidateExternalMcpGeneration(
	input: {
		actionIds: readonly string[];
	},
	stores: Pick<DesktopAgentStores, "projectId" | "control">,
): Promise<number> {
	const approval = new ApprovalService(stores.control, stores.control.getOrCreateApprovalSecret(), 10 * 60);
	let invalidated = 0;
	for (const actionId of input.actionIds) {
		const record = await stores.control.find(actionId);
		if (!record || !record.action.sessionId.startsWith("mcp:") || record.status !== "pending") continue;
		if (!record.action.approvalToken) continue;
		await approval.rejectApproval(actionId, record.action.approvalToken).catch(() => undefined);
		invalidated += 1;
	}
	return invalidated;
}

export function mcpSessionId(clientId: string): string {
	return `mcp:${clientId}`;
}

function requireRuntimeTool(tools: AgentTool[], name: string): AgentTool {
	const tool = tools.find((entry) => entry.name === name);
	if (!tool) throw codedError("MCP_TOOL_UNAVAILABLE");
	return tool;
}

async function resolveGenerationBinding(
	gateway: RuntimeToolGateway,
	projectId: string,
	value: unknown,
): Promise<{ generation: Record<string, unknown>; providerId?: string; providerType?: string }> {
	if (!isRecord(value) || typeof value.modelType !== "string") throw codedError("INVALID_INPUT");
	const modelDirectory = await gateway.listModels(projectId);
	const models = Array.isArray(modelDirectory) ? modelDirectory : [];
	const selected = models.find(
		(entry) =>
			isRecord(entry) &&
			(entry.id === value.modelType || entry.bindingId === value.modelType || entry.name === value.modelType),
	);
	if (!isRecord(selected) || typeof selected.name !== "string") throw codedError("MODEL_NOT_FOUND");
	return {
		generation: { ...value, modelType: selected.name },
		...(typeof selected.providerId === "string" ? { providerId: selected.providerId } : {}),
		...(typeof selected.providerType === "string" ? { providerType: selected.providerType } : {}),
	};
}

function publicModelBindings(value: Record<string, unknown>): Record<string, unknown> {
	const models = Array.isArray(value.models) ? value.models : Array.isArray(value.result) ? value.result : [];
	const projected = models.filter(isRecord).map((model) => ({
		...sanitizePublicValue(model),
		bindingId: typeof model.id === "string" ? model.id : typeof model.name === "string" ? model.name : "",
	}));
	return { models: projected };
}

function safeErrorCode(error: unknown, fallback: string): string {
	if (!isRecord(error) || typeof error.code !== "string") return fallback;
	return /^[A-Z0-9_]{1,120}$/u.test(error.code) ? error.code : fallback;
}

function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
	const allowed = new Set(keys);
	if (Object.keys(value).some((key) => !allowed.has(key))) throw codedError("INVALID_INPUT");
}

function extendInputSchema(source: Record<string, unknown>, write: boolean): Record<string, unknown> {
	const schema = structuredClone(source);
	const properties = isRecord(schema.properties) ? schema.properties : {};
	delete properties.idempotencyKey;
	delete properties.expectedVersion;
	if (write) {
		properties.operationId = { type: "string", minLength: 1, maxLength: MAX_OPERATION_ID_LENGTH };
		properties.expectedVersion = { type: "integer", minimum: 0 };
	}
	schema.properties = properties;
	const required = Array.isArray(schema.required) ? schema.required.filter((entry) => entry !== "idempotencyKey") : [];
	if (write) required.push("operationId", "expectedVersion");
	schema.required = [...new Set(required)];
	return schema;
}

function validateWriteEnvelope(operationId: unknown, expectedVersion: unknown): void {
	if (
		typeof operationId !== "string" ||
		!/^[A-Za-z0-9._:-]{1,128}$/u.test(operationId) ||
		!Number.isSafeInteger(expectedVersion) ||
		Number(expectedVersion) < 0
	)
		throw codedError("INVALID_INPUT");
}

function assertSafeNodeConfig(value: unknown): void {
	if (
		!isRecord(value) ||
		Object.keys(value).length === 0 ||
		Object.keys(value).some((key) => !NODE_CONFIG_FIELDS.has(key))
	)
		throw codedError("INVALID_INPUT");
	const inspect = (candidate: unknown, depth: number): void => {
		if (depth > 8) throw codedError("INVALID_INPUT");
		if (Array.isArray(candidate)) {
			if (candidate.length > 500) throw codedError("INVALID_INPUT");
			for (const entry of candidate) inspect(entry, depth + 1);
			return;
		}
		if (!isRecord(candidate)) return;
		for (const [key, item] of Object.entries(candidate)) {
			if (
				FORBIDDEN_NODE_FIELDS.has(key) ||
				SENSITIVE_CONFIG_KEY.test(key) ||
				/^(?:task|output|status|execStatus|currentOutput)/iu.test(key)
			)
				throw codedError("INVALID_INPUT");
			inspect(item, depth + 1);
		}
	};
	inspect(value, 0);
}

function assertNoCredentialFields(value: unknown): void {
	const inspect = (candidate: unknown, depth: number): void => {
		if (depth > 12) throw codedError("INVALID_INPUT");
		if (Array.isArray(candidate)) {
			if (candidate.length > 1000) throw codedError("INVALID_INPUT");
			for (const item of candidate) inspect(item, depth + 1);
			return;
		}
		if (!isRecord(candidate)) return;
		for (const [key, item] of Object.entries(candidate)) {
			if (SENSITIVE_CONFIG_KEY.test(key)) throw codedError("INVALID_INPUT");
			inspect(item, depth + 1);
		}
	};
	inspect(value, 0);
}

function sanitizePublicValue(value: unknown, depth = 0): Record<string, unknown> {
	if (depth > 12 || !isRecord(value)) return {};
	return Object.fromEntries(
		Object.entries(value)
			.filter(
				([key]) =>
					!/(?:secret|token|password|api[_-]?key|authorization|approval)/iu.test(key) &&
					!/(?:path|directory|filename|localfile)/iu.test(key),
			)
			.map(([key, item]) => [
				key,
				typeof item === "string"
					? sanitizeText(item)
					: Array.isArray(item)
						? item.slice(0, 100).map((entry) => (isRecord(entry) ? sanitizePublicValue(entry, depth + 1) : entry))
						: isRecord(item)
							? sanitizePublicValue(item, depth + 1)
							: item,
			]),
	);
}

function sanitizeText(text: string): string {
	return text
		.replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/giu, "[redacted]")
		.replace(/(?:[A-Za-z]:\\|\\\\|\/(?:Users|home|private\/var|tmp)\/)[^\s"']+/gu, "[local file]")
		.replace(/Bearer\s+[A-Za-z0-9._~-]{16,}/giu, "Bearer [redacted]");
}

function codedError(code: string): Error & { code: string } {
	const error = new Error(code) as Error & { code: string };
	error.code = code;
	return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
