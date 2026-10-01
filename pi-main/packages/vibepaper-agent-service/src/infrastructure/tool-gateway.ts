import { randomUUID } from "node:crypto";
import type { CanvasCommand, CanvasCommandGateway } from "../application/canvas-command-service.ts";
import { type NodeReferenceSnapshot, selectNodeReferences } from "../application/node-reference-context.ts";
import type { ServiceConfig } from "../config.ts";

export interface CanvasNodeRequest {
	type: "text" | "image" | "video" | "audio" | "compose" | "director";
	creativeType?: "script" | "character" | "shot" | "keyframe" | "clip" | "audio" | "composite";
	prompt?: string;
	params?: Record<string, unknown>;
	x?: number;
	y?: number;
	expectedVersion?: number;
}

export interface CreatedCanvasNode {
	id: string;
	data: Record<string, unknown>;
}

export class ToolGateway implements CanvasCommandGateway {
	private readonly config: ServiceConfig;

	constructor(config: ServiceConfig) {
		this.config = config;
	}

	async getNodeReferences(
		userId: string,
		canvasId: string,
		nodeIds: readonly string[],
		requestId?: string,
	): Promise<NodeReferenceSnapshot[]> {
		if (nodeIds.length === 0) return [];
		const response = await fetch(`${this.config.canvasBaseUrl}/api/v1/canvases/${encodeURIComponent(canvasId)}`, {
			method: "GET",
			headers: requestHeaders(userId, requestId),
			signal: AbortSignal.timeout(10_000),
		});
		const data = await responseData(response);
		if (!response.ok) {
			const code =
				response.status === 403
					? "PERMISSION_DENIED"
					: response.status === 404
						? "NOT_FOUND"
						: "CANVAS_UNAVAILABLE";
			const statusCode = response.status === 403 || response.status === 404 ? response.status : 502;
			throw new ToolGatewayError(code, "读取参考节点失败", data, statusCode);
		}
		return selectNodeReferences(arrayValue(objectValue(data).nodes), nodeIds);
	}

	async getCanvasSummary(userId: string, canvasId: string, requestId?: string): Promise<Record<string, unknown>> {
		const response = await this.request(
			`${this.config.canvasBaseUrl}/api/v1/canvases/${canvasId}`,
			userId,
			requestId,
		);
		return this.requireObject(response, "读取画布摘要失败");
	}

	async getCanvasVersion(userId: string, canvasId: string, requestId?: string): Promise<number> {
		const summary = await this.getCanvasSummary(userId, canvasId, requestId);
		const version = objectValue(summary.canvas).version;
		if (typeof version !== "number" || !Number.isInteger(version) || version < 0)
			throw new ToolGatewayError("VERSION_CONFLICT", "读取当前画布版本失败", { version });
		return version;
	}

	async getSelectedNodes(
		userId: string,
		canvasId: string,
		nodeIds: readonly string[],
		requestId?: string,
	): Promise<readonly unknown[]> {
		const summary = await this.getCanvasSummary(userId, canvasId, requestId);
		const selected = new Set(nodeIds);
		return arrayValue(summary.nodes).filter((node) => selected.has(objectId(node) ?? ""));
	}

	async getNodeDetail(
		userId: string,
		canvasId: string,
		nodeId: string,
		requestId?: string,
	): Promise<Record<string, unknown>> {
		const response = await this.request(
			`${this.config.canvasBaseUrl}/api/v1/canvases/${canvasId}/nodes/${nodeId}`,
			userId,
			requestId,
		);
		return this.requireObject(response, "读取节点详情失败");
	}

	async listModels(userId: string, requestId?: string): Promise<readonly unknown[]> {
		const response = await this.request(`${this.config.generationBaseUrl}/api/v1/models`, userId, requestId);
		return arrayValue(objectValue(response).items);
	}

	/**
	 * Generation accepts canonical model names (or modality aliases), while an LLM
	 * may copy a human-facing display label from the catalog. Resolve that label
	 * before it becomes part of a persisted approval action, so the post-approval
	 * Billing task is submitted with the same model that was estimated.
	 */
	async resolveGenerationModel(userId: string, requestedModel: string, requestId?: string): Promise<string> {
		const requested = requestedModel.trim();
		if (!requested) return requestedModel;
		try {
			return resolveCatalogGenerationModel(await this.listModels(userId, requestId), requested);
		} catch {
			// Preserve Generation's authoritative error when its model catalog is temporarily unavailable.
			return requested;
		}
	}

	async searchAssets(userId: string, query: string, requestId?: string): Promise<readonly unknown[]> {
		const url = `${this.config.assetBaseUrl}/internal/assets?keyword=${encodeURIComponent(query)}`;
		return arrayValue(await this.request(url, userId, requestId));
	}

	async checkTaskStatus(userId: string, taskId: string, requestId?: string): Promise<Record<string, unknown>> {
		const response = await this.request(`${this.config.generationBaseUrl}/api/v1/tasks/${taskId}`, userId, requestId);
		return this.requireObject(response, "读取任务状态失败");
	}

	async execute(command: CanvasCommand): Promise<Record<string, unknown>> {
		if (command.operation === "create_nodes") {
			const created = [];
			const canvasSummary = await this.getCanvasSummary(command.userId, command.canvasId, command.requestId);
			const existingNodeCount = arrayValue(canvasSummary.nodes).length;
			let expectedVersion = command.expectedVersion;
			for (const node of arrayValue(command.payload.nodes)) {
				const nodeIndex: number = created.length;
				const record = nodeRecord(node);
				created.push(
					await this.createCanvasNode(
						command.userId,
						command.canvasId,
						{
							...record,
							x: typeof record.x === "number" ? record.x : 220 + (existingNodeCount + nodeIndex) * 360,
							y: typeof record.y === "number" ? record.y : 180,
							expectedVersion,
						} as CanvasNodeRequest,
						command.requestId,
						`${command.idempotencyKey}:${nodeIndex}`,
					),
				);
				expectedVersion = await this.readCanvasVersion(
					command.userId,
					command.canvasId,
					expectedVersion,
					command.requestId,
				);
			}
			return { operation: command.operation, createdNodes: created, canvasVersion: expectedVersion };
		}
		if (command.operation === "connect_nodes") {
			const nodeIds = arrayValue(command.payload.nodeIds).map((id) => String(id));
			if (nodeIds.length < 2) throw new ToolGatewayError("INVALID_INPUT", "连线至少需要两个节点", command);
			const edges: Record<string, unknown>[] = [];
			let expectedVersion = command.expectedVersion;
			for (let index = 0; index < nodeIds.length - 1; index += 1) {
				const response = await this.postCanvas(
					command.userId,
					command.canvasId,
					"edges",
					{
						sourceNodeId: nodeIds[index],
						targetNodeId: nodeIds[index + 1],
						expectedVersion,
					},
					command.requestId,
					`${command.idempotencyKey}:${index}`,
				);
				edges.push(this.requireObject(response, "创建连线失败"));
				expectedVersion = await this.readCanvasVersion(
					command.userId,
					command.canvasId,
					expectedVersion,
					command.requestId,
				);
			}
			return { operation: command.operation, edges, canvasVersion: expectedVersion };
		}
		if (command.operation === "update_node_config") {
			const nodeId = String(command.payload.nodeId);
			const config = objectValue(command.payload.config);
			const body = Object.keys(config).some((key) =>
				[
					"x",
					"y",
					"width",
					"height",
					"params",
					"prompt",
					"modelRef",
					"creativeType",
					"status",
					"execStatus",
				].includes(key),
			)
				? config
				: { params: config };
			body.expectedVersion = command.expectedVersion;
			const updated = await this.putCanvas(
				command.userId,
				command.canvasId,
				`nodes/${nodeId}`,
				body,
				command.requestId,
				command.idempotencyKey,
			);
			return {
				...updated,
				canvasVersion: await this.readCanvasVersion(
					command.userId,
					command.canvasId,
					command.expectedVersion,
					command.requestId,
				),
			};
		}
		if (command.operation === "delete_nodes") {
			const results = [];
			let expectedVersion = command.expectedVersion;
			for (const nodeId of arrayValue(command.payload.nodeIds)) {
				results.push(
					await this.deleteCanvas(
						command.userId,
						command.canvasId,
						`nodes/${String(nodeId)}?expectedVersion=${expectedVersion}`,
						command.requestId,
						`${command.idempotencyKey}:${String(nodeId)}`,
					),
				);
				expectedVersion = await this.readCanvasVersion(
					command.userId,
					command.canvasId,
					expectedVersion,
					command.requestId,
				);
			}
			return { operation: command.operation, results, canvasVersion: expectedVersion };
		}
		if (command.operation === "layout_nodes") {
			const detail = objectValue(
				await this.request(
					`${this.config.canvasBaseUrl}/api/v1/canvases/${command.canvasId}`,
					command.userId,
					command.requestId,
				),
			);
			const canvas = objectValue(detail.canvas);
			const version = canvas.version;
			if (typeof version !== "number" || version !== command.expectedVersion)
				throw new ToolGatewayError("VERSION_CONFLICT", "画布版本已变化，请刷新", { version });
			const selectedIds = arrayValue(command.payload.nodeIds).map(String);
			const layout = objectValue(command.payload.layout);
			const positions = objectValue(layout.positions);
			const direction = layout.direction === "vertical" ? "vertical" : "horizontal";
			const gap = typeof layout.gap === "number" && Number.isFinite(layout.gap) ? Math.max(80, layout.gap) : 360;
			const nodes = arrayValue(detail.nodes).map((node, index) => {
				const record = objectValue(node);
				const id = objectId(record) ?? "";
				const explicit = objectValue(positions[id]);
				if (!selectedIds.includes(id)) return record;
				return {
					...record,
					x: typeof explicit.x === "number" ? explicit.x : direction === "horizontal" ? 120 + index * gap : 120,
					y: typeof explicit.y === "number" ? explicit.y : direction === "vertical" ? 120 + index * gap : 120,
				};
			});
			const saved = await this.postCanvas(
				command.userId,
				command.canvasId,
				"save",
				{
					version,
					nodes,
					edges: arrayValue(detail.edges),
					groups: arrayValue(detail.groups),
					stacks: arrayValue(detail.stacks),
				},
				command.requestId,
				command.idempotencyKey,
			);
			return this.requireObject(saved, "保存布局失败");
		}
		return { operation: command.operation, status: "accepted", nodeIds: command.payload.nodeIds };
	}

	async createCanvasNode(
		userId: string,
		canvasId: string,
		node: CanvasNodeRequest,
		requestId?: string,
		idempotencyKey?: string,
	): Promise<CreatedCanvasNode> {
		const response = await fetch(`${this.config.canvasBaseUrl}/api/v1/canvases/${canvasId}/nodes`, {
			method: "POST",
			headers: requestHeaders(userId, requestId, idempotencyKey),
			body: JSON.stringify({
				...node,
				x: node.x ?? 220,
				y: node.y ?? 180,
				modelRef: node.params?.model,
				expectedVersion: node.expectedVersion,
			}),
			signal: AbortSignal.timeout(10_000),
		});
		const data = await responseData(response);
		if (!response.ok) throw canvasResponseError(response, data, "创建画布节点失败");
		const id = objectId(data);
		if (!id) throw new ToolGatewayError("INVALID_RESPONSE", "画布服务未返回节点 ID", data);
		return { id, data: objectValue(data) };
	}

	async submitGeneration(
		userId: string,
		canvasId: string,
		nodeId: string,
		modelType: string,
		modelParams: Record<string, unknown>,
		estimatedCost: number,
		idempotencyKey: string,
		requestId?: string,
	): Promise<Record<string, unknown>> {
		const resolvedModel = await this.resolveGenerationModel(userId, modelType, requestId);
		await this.assertGenerationTargetNode(userId, canvasId, nodeId, resolvedModel, requestId);
		const estimate = await this.estimateGeneration({ userId, modelType: resolvedModel, modelParams, requestId });
		if (estimate.estimatedCost > estimatedCost) {
			throw new ToolGatewayError("COST_CAP_EXCEEDED", "实际估价超过确认时的费用上限", estimate);
		}
		const task = await this.freezeGeneration({
			userId,
			canvasId,
			nodeId,
			modelType: resolvedModel,
			modelParams,
			estimatedCost: estimate.estimatedCost,
			idempotencyKey,
			requestId,
		});
		try {
			await this.markQueued({
				userId,
				canvasId,
				nodeId,
				taskId: String(task.taskId),
				requestId,
				idempotencyKey: `${idempotencyKey}:queued`,
			});
		} catch (error) {
			await this.cancelGeneration(String(task.taskId), userId);
			throw error;
		}
		return { ...task, estimatedCost: estimate.estimatedCost, pricingVersion: estimate.pricingVersion };
	}

	private async assertGenerationTargetNode(
		userId: string,
		canvasId: string,
		nodeId: string,
		modelType: string,
		requestId?: string,
	): Promise<void> {
		const expectedType = generationNodeType(modelType);
		if (!expectedType) return;
		const node = await this.getNodeDetail(userId, canvasId, nodeId, requestId);
		const nested = objectValue(node.data);
		const actualType = [node.type, node.nodeType, nested.type, nested.nodeType].find(
			(value): value is string => typeof value === "string",
		);
		if (actualType && actualType !== expectedType) {
			throw new ToolGatewayError(
				"INVALID_INPUT",
				`生成目标节点类型不匹配：${expectedType} 生成必须写入 ${expectedType} 节点`,
				{ expectedType, actualType },
				400,
			);
		}
	}

	async estimateGeneration(input: {
		userId: string;
		modelType: string;
		modelParams: Record<string, unknown>;
		requestId?: string;
	}): Promise<{ estimatedCost: number; pricingVersion: number; models: readonly unknown[] }> {
		const response = await fetch(`${this.config.generationBaseUrl}/api/v1/models/estimate`, {
			method: "POST",
			headers: requestHeaders(input.userId, input.requestId),
			body: JSON.stringify({ modelType: input.modelType, modelParams: input.modelParams, count: 1 }),
			signal: AbortSignal.timeout(10_000),
		});
		const data = await responseData(response);
		if (!response.ok) throw new ToolGatewayError("MODEL_UNAVAILABLE", "无法获取权威模型估价", data);
		const record = objectValue(data);
		const estimatedCost = record.estimatedCost;
		if (typeof estimatedCost !== "number" || !Number.isInteger(estimatedCost) || estimatedCost < 1)
			throw new ToolGatewayError("INVALID_ESTIMATE", "模型估价响应无效", data);
		return {
			estimatedCost,
			pricingVersion: typeof record.pricingVersion === "number" ? record.pricingVersion : 1,
			models: arrayValue(record.models),
		};
	}

	async freezeGeneration(input: {
		userId: string;
		canvasId: string;
		nodeId: string;
		modelType: string;
		modelParams: Record<string, unknown>;
		estimatedCost: number;
		idempotencyKey: string;
		requestId?: string;
	}): Promise<{ taskId: string; status: string; [key: string]: unknown }> {
		const response = await fetch(`${this.config.billingBaseUrl}/api/v1/tasks`, {
			method: "POST",
			headers: { ...requestHeaders(input.userId, input.requestId), "Idempotency-Key": input.idempotencyKey },
			body: JSON.stringify({ ...input, source: "agent" }),
			signal: AbortSignal.timeout(15_000),
		});
		const data = await responseData(response);
		if (!response.ok) throw new ToolGatewayError("INSUFFICIENT_POINTS", "冻结点数失败", data, response.status);
		const record = objectValue(data);
		const taskId = record.taskId;
		if (typeof taskId !== "string" && typeof taskId !== "number")
			throw new ToolGatewayError("INVALID_RESPONSE", "Billing 未返回任务 ID", data);
		return {
			...record,
			taskId: String(taskId),
			status: typeof record.status === "string" ? record.status : "queued",
		};
	}

	async markQueued(input: {
		userId: string;
		canvasId: string;
		nodeId: string;
		taskId: string;
		requestId?: string;
		idempotencyKey?: string;
	}): Promise<void> {
		const response = await fetch(
			`${this.config.canvasBaseUrl}/api/v1/canvases/${input.canvasId}/nodes/${input.nodeId}`,
			{
				method: "PUT",
				headers: requestHeaders(input.userId, input.requestId, input.idempotencyKey),
				body: JSON.stringify({ status: "queued", execStatus: "queued", stale: false, taskId: input.taskId }),
				signal: AbortSignal.timeout(10_000),
			},
		);
		const data = await responseData(response);
		if (!response.ok) throw canvasResponseError(response, data, "画布节点写入 queued 失败");
	}

	async cancelGeneration(taskId: string, userId: string): Promise<void> {
		const response = await fetch(`${this.config.billingBaseUrl}/api/v1/tasks/${taskId}/cancel`, {
			method: "POST",
			headers: requestHeaders(userId),
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok)
			throw new ToolGatewayError("BILLING_COMPENSATION_FAILED", "任务补偿解冻失败", await responseData(response));
	}

	private async request(url: string, userId: string, requestId?: string): Promise<unknown> {
		const response = await fetch(url, {
			method: "GET",
			headers: requestHeaders(userId, requestId),
			signal: AbortSignal.timeout(10_000),
		});
		const data = await responseData(response);
		if (!response.ok) throw new ToolGatewayError("DOWNSTREAM_UNAVAILABLE", "读取下游服务失败", data, response.status);
		return data;
	}

	private async readCanvasVersion(
		userId: string,
		canvasId: string,
		fallback: number,
		requestId?: string,
	): Promise<number> {
		const detail = objectValue(
			await this.request(`${this.config.canvasBaseUrl}/api/v1/canvases/${canvasId}`, userId, requestId),
		);
		const version = objectValue(detail.canvas).version;
		// A repeated Idempotency-Key is allowed to replay an already-applied write.
		// In that case Canvas correctly returns the same version rather than incrementing it again.
		if (typeof version !== "number" || !Number.isInteger(version) || version < fallback)
			throw new ToolGatewayError("VERSION_CONFLICT", "画布版本未按预期推进，请刷新", { version, fallback });
		return version;
	}

	private async postCanvas(
		userId: string,
		canvasId: string,
		path: string,
		body: Record<string, unknown>,
		requestId?: string,
		idempotencyKey?: string,
	): Promise<unknown> {
		const response = await fetch(`${this.config.canvasBaseUrl}/api/v1/canvases/${canvasId}/${path}`, {
			method: "POST",
			headers: requestHeaders(userId, requestId, idempotencyKey),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		});
		const data = await responseData(response);
		if (!response.ok) throw canvasResponseError(response, data, "写入画布失败");
		return data;
	}

	private async putCanvas(
		userId: string,
		canvasId: string,
		path: string,
		body: unknown,
		requestId?: string,
		idempotencyKey?: string,
	): Promise<Record<string, unknown>> {
		const response = await fetch(`${this.config.canvasBaseUrl}/api/v1/canvases/${canvasId}/${path}`, {
			method: "PUT",
			headers: requestHeaders(userId, requestId, idempotencyKey),
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10_000),
		});
		const data = await responseData(response);
		if (!response.ok) throw canvasResponseError(response, data, "更新画布失败");
		return this.requireObject(data, "更新画布失败");
	}

	private async deleteCanvas(
		userId: string,
		canvasId: string,
		path: string,
		requestId?: string,
		idempotencyKey?: string,
	): Promise<unknown> {
		const response = await fetch(`${this.config.canvasBaseUrl}/api/v1/canvases/${canvasId}/${path}`, {
			method: "DELETE",
			headers: requestHeaders(userId, requestId, idempotencyKey),
			signal: AbortSignal.timeout(10_000),
		});
		const data = await responseData(response);
		if (!response.ok) throw canvasResponseError(response, data, "删除画布内容失败");
		return data;
	}

	private requireObject(value: unknown, message: string): Record<string, unknown> {
		const record = objectValue(value);
		if (Object.keys(record).length === 0 && !isEmptyObject(value))
			throw new ToolGatewayError("INVALID_RESPONSE", message, value);
		return record;
	}
}

export function requestHeaders(userId: string, requestId?: string, idempotencyKey?: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"X-User-Id": userId,
		"X-User-Role": "user",
		"X-Request-Id": requestId ?? randomUUID(),
		...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
	};
}

function canvasResponseError(response: Response, data: unknown, message: string): ToolGatewayError {
	const details = objectValue(data);
	const declaredCode = typeof details.code === "string" ? details.code : undefined;
	const code =
		declaredCode ??
		(response.status === 403
			? "PERMISSION_DENIED"
			: response.status === 404
				? "NOT_FOUND"
				: response.status === 409
					? "VERSION_CONFLICT"
					: "CANVAS_UNAVAILABLE");
	return new ToolGatewayError(code, message, data, response.status);
}

async function responseData(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text) return {};
	try {
		// Snowflake IDs are larger than JavaScript's safe integer range. Parsing
		// them with JSON.parse first rounds the value (for example ...065 to
		// ...060), which then makes follow-up node writes target a different
		// record. Preserve unsafe integer literals as strings before parsing.
		return JSON.parse(preserveUnsafeIntegerLiterals(text)) as unknown;
	} catch {
		return { raw: text.slice(0, 500) };
	}
}

function preserveUnsafeIntegerLiterals(input: string): string {
	let output = "";
	let index = 0;
	let inString = false;
	let escaped = false;
	while (index < input.length) {
		const character = input[index]!;
		if (inString) {
			output += character;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			index += 1;
			continue;
		}
		if (character === '"') {
			inString = true;
			output += character;
			index += 1;
			continue;
		}
		if (character === "-" || (character >= "0" && character <= "9")) {
			const start = index;
			index += 1;
			while (index < input.length && /[0-9]/.test(input[index]!)) index += 1;
			const literal = input.slice(start, index);
			if (/^-?\d+$/.test(literal)) {
				try {
					if (!Number.isSafeInteger(Number(literal))) {
						output += JSON.stringify(literal);
						continue;
					}
				} catch {
					// Fall through and let JSON.parse report malformed input.
				}
			}
			output += literal;
			continue;
		}
		output += character;
		index += 1;
	}
	return output;
}

function objectValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function objectId(value: unknown): string | undefined {
	const record = objectValue(value);
	const candidate = record.id ?? record.nodeId;
	return typeof candidate === "string" || typeof candidate === "number" ? String(candidate) : undefined;
}

function normalizeModelIdentifier(value: string): string {
	return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
}

function legacyModelModality(normalized: string): CanvasNodeRequest["type"] | undefined {
	if (["image", "picture", "photo", "flux"].includes(normalized)) return "image";
	if (["video", "motion", "kling", "seedance", "sora"].includes(normalized)) return "video";
	if (["audio", "tts", "speech"].includes(normalized)) return "audio";
	if (["compose", "concat"].includes(normalized)) return "compose";
	if (["director", "directorstage"].includes(normalized)) return "director";
	return undefined;
}

function generationNodeType(modelType: string): CanvasNodeRequest["type"] | undefined {
	const normalized = modelType.toLocaleLowerCase("en-US");
	if (normalized.includes("image") || normalized.includes("picture")) return "image";
	if (normalized.includes("video") || normalized.includes("motion")) return "video";
	if (normalized.includes("audio") || normalized.includes("tts") || normalized.includes("speech")) return "audio";
	if (normalized.includes("compose")) return "compose";
	if (normalized.includes("director")) return "director";
	return undefined;
}

export class ToolGatewayError extends Error {
	readonly code: string;
	readonly details: unknown;
	readonly statusCode: number;

	constructor(code: string, message: string, details: unknown, statusCode = 502) {
		super(message);
		this.name = "ToolGatewayError";
		this.code = code;
		this.details = details;
		this.statusCode = statusCode;
	}
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function nodeRecord(value: unknown): Record<string, unknown> {
	return objectValue(value);
}

function isEmptyObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

export function resolveCatalogGenerationModel(catalog: readonly unknown[], requestedModel: string): string {
	const requested = requestedModel.trim();
	if (!requested) return requestedModel;
	const models = catalog
		.map((item) => objectValue(item))
		.filter((item) => item.enabled !== false && typeof item.name === "string");
	const normalized = normalizeModelIdentifier(requested);
	const exact = models.find((item) =>
		[item.name, item.displayName]
			.filter((value): value is string => typeof value === "string")
			.some((value) => normalizeModelIdentifier(value) === normalized),
	);
	if (typeof exact?.name === "string") return exact.name;

	const matching = models.filter((item) =>
		[item.name, item.displayName]
			.filter((value): value is string => typeof value === "string")
			.some((value) => normalizeModelIdentifier(value).startsWith(normalized)),
	);
	if (matching.length === 1 && typeof matching[0]?.name === "string") return matching[0].name;

	// Older prompts may still emit a modality/model nickname such as
	// "flux" or "kling". Only repair it when the live catalog has one
	// enabled model for that modality; never guess between providers.
	const modality = legacyModelModality(normalized);
	if (modality) {
		const modalityMatches = models.filter((item) => item.modelType === modality);
		if (modalityMatches.length === 1 && typeof modalityMatches[0]?.name === "string")
			return modalityMatches[0].name;
	}
	return requested;
}
