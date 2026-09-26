import { createHash } from "node:crypto";
import type { CanvasCommand, CanvasCommandGateway } from "../application/canvas-command-service.ts";
import { ToolGatewayError } from "../infrastructure/tool-gateway.ts";
import type { ReadToolsGateway } from "../tools/read-tools.ts";

export interface DesktopLocalToolClient {
	request(method: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

/**
 * Adapts the original Agent read and CanvasCommand contracts to the desktop's
 * narrow Main → Local Core RPC surface. Tool schemas and orchestration remain
 * owned by runtime-tools.ts; this class only translates domain commands.
 */
export class DesktopLocalToolGateway implements ReadToolsGateway, CanvasCommandGateway {
	private readonly client: DesktopLocalToolClient;
	private readonly projectId: string;

	constructor(client: DesktopLocalToolClient, projectId: string) {
		this.client = client;
		this.projectId = projectId;
	}

	async getCanvasSummary(_userId: string, canvasId: string): Promise<Record<string, unknown>> {
		return projectCanvas(await this.loadCanvas(canvasId));
	}

	async getSelectedNodes(_userId: string, canvasId: string, nodeIds: readonly string[]): Promise<readonly unknown[]> {
		const canvas = projectCanvas(await this.loadCanvas(canvasId));
		const selected = new Set(nodeIds);
		return records(canvas.nodes).filter((node) => selected.has(stringValue(node.id) ?? ""));
	}

	async getNodeDetail(_userId: string, canvasId: string, nodeId: string): Promise<Record<string, unknown>> {
		const canvas = projectCanvas(await this.loadCanvas(canvasId));
		const node = records(canvas.nodes).find((candidate) => candidate.id === nodeId);
		if (!node) throw gatewayError("NOT_FOUND", "节点不存在", 404);
		return node;
	}

	async listModels(): Promise<readonly unknown[]> {
		const response = await this.call("agent:core:list-models", { projectId: this.projectId });
		if (!Array.isArray(response)) throw gatewayError("INVALID_RESPONSE", "模型目录响应无效");
		return response.map((entry) => (isRecord(entry) ? stripPrivateFields(entry) : entry));
	}

	async resolveGenerationModel(_userId: string, requestedModel: string): Promise<string> {
		const models = await this.listModels();
		const selected = models.find((entry) => isRecord(entry) && entry.name === requestedModel);
		if (!isRecord(selected) || selected.enabled !== true)
			throw new ToolGatewayError("MODEL_UNAVAILABLE", "所选模型当前不可用，请检查模型配置", {}, 400);
		return requestedModel;
	}

	async createGenerationTask(input: {
		userId: string;
		canvasId: string;
		canvasVersion: number;
		nodeId: string;
		modelType: string;
		modelParams: Record<string, unknown>;
		idempotencyKey: string;
	}): Promise<Record<string, unknown>> {
		if (input.userId !== this.projectId) throw gatewayError("PERMISSION_DENIED", "当前项目已更改", 403);
		const models = await this.listModels();
		const model = models.find((entry) => isRecord(entry) && entry.name === input.modelType);
		if (!isRecord(model) || model.enabled !== true)
			throw new ToolGatewayError("MODEL_UNAVAILABLE", "所选模型当前不可用，请检查模型配置", {}, 400);
		const modality = stringValue(model.modelType);
		const providerType = model.providerType;
		const providerId = stringValue(model.providerId);
		const modelId = stringValue(model.name);
		const prompt = stringValue(input.modelParams.prompt)?.trim();
		if (
			!modality ||
			!["text", "image", "video", "audio"].includes(modality) ||
			!prompt ||
			!providerId ||
			!modelId ||
			(providerType !== "local" && providerType !== "cloud")
		) {
			throw new ToolGatewayError("INVALID_INPUT", "模型、生成类型或提示词无效", {}, 400);
		}
		const parameters = Object.fromEntries(Object.entries(input.modelParams).filter(([key]) => key !== "prompt"));
		const response = await this.call("agent:core:create-generation-task", {
			projectId: this.projectId,
			canvasId: input.canvasId,
			canvasVersion: input.canvasVersion,
			nodeId: input.nodeId,
			modality,
			providerType,
			providerId,
			modelId,
			idempotencyKey: input.idempotencyKey,
			prompt,
			parameters,
		});
		if (!isRecord(response) || typeof response.taskId !== "string" || typeof response.status !== "string")
			throw gatewayError("INVALID_RESPONSE", "本地任务存储未返回有效任务");
		return { taskId: response.taskId, status: response.status, modality, nodeId: input.nodeId };
	}

	async searchAssets(_userId: string, query: string): Promise<readonly unknown[]> {
		const response = await this.call("agent:core:list-assets", { projectId: this.projectId });
		if (!Array.isArray(response)) throw gatewayError("INVALID_RESPONSE", "素材目录响应无效");
		const needle = query.trim().toLocaleLowerCase();
		return response
			.filter(
				(asset) =>
					isRecord(asset) &&
					[asset.name, asset.mimeType].some(
						(value) => typeof value === "string" && value.toLocaleLowerCase().includes(needle),
					),
			)
			.map((asset) => (isRecord(asset) ? stripPrivateFields(asset) : asset));
	}

	async checkTaskStatus(_userId: string, taskId: string): Promise<Record<string, unknown>> {
		const activeCanvas = await this.loadCanvas(undefined);
		const task = await this.call("agent:core:get-task", { projectId: this.projectId, taskId });
		if (
			!isRecord(task) ||
			task.taskId !== taskId ||
			task.canvasId !== activeCanvas.canvasId ||
			!activeCanvas.nodes.some((node) => node.id === task.nodeId)
		) {
			throw gatewayError("NOT_FOUND", "任务不存在", 404);
		}
		return projectTask(task);
	}

	async execute(command: CanvasCommand): Promise<Record<string, unknown>> {
		if (command.userId !== this.projectId) throw gatewayError("PERMISSION_DENIED", "当前项目已更改", 403);
		if (command.operation === "create_nodes") return this.createNodes(command);
		if (command.operation === "connect_nodes") return this.connectNodes(command);
		if (command.operation === "update_node_config") return this.updateNodeConfig(command);
		if (command.operation === "layout_nodes") return this.layoutNodes(command);
		throw gatewayError("PERMISSION_DENIED", "该画布操作尚未开放", 403);
	}

	private async createNodes(command: CanvasCommand): Promise<Record<string, unknown>> {
		const canvas = await this.loadCanvas(command.canvasId);
		const nodes = records(command.payload.nodes);
		if (nodes.length < 1 || nodes.length > 20)
			throw gatewayError("BATCH_LIMIT_EXCEEDED", "单次最多创建 20 个节点", 400);
		const createdNodes: Record<string, unknown>[] = [];
		let version = command.expectedVersion;
		for (const [index, node] of nodes.entries()) {
			const response = await this.call("agent:core:create-node", {
				projectId: this.projectId,
				canvasId: command.canvasId,
				expectedVersion: version,
				idempotencyKey: childKey(command.idempotencyKey, `node:${index}`),
				type: node.type,
				creativeType: node.creativeType,
				prompt: node.prompt,
				params: isRecord(node.params) ? node.params : {},
				x: typeof node.x === "number" ? node.x : 220 + (canvas.nodes.length + index) * 360,
				y: typeof node.y === "number" ? node.y : 180,
			});
			if (!isRecord(response) || !isRecord(response.node) || !Number.isSafeInteger(response.version)) {
				throw gatewayError("INVALID_RESPONSE", "本地画布未返回有效的节点结果");
			}
			const projected = projectNode(response.node);
			createdNodes.push({ id: projected.id, data: projected, type: projected.type });
			version = response.version as number;
		}
		return { operation: command.operation, createdNodes, canvasVersion: version };
	}

	private async connectNodes(command: CanvasCommand): Promise<Record<string, unknown>> {
		const nodeIds = strings(command.payload.nodeIds);
		if (nodeIds.length < 2 || nodeIds.length > 20)
			throw gatewayError("INVALID_INPUT", "连线需要 2 至 20 个节点", 400);
		let version = command.expectedVersion;
		const edges: Record<string, unknown>[] = [];
		for (let index = 0; index < nodeIds.length - 1; index += 1) {
			const response = await this.call("agent:core:connect-edge", {
				projectId: this.projectId,
				canvasId: command.canvasId,
				expectedVersion: version,
				idempotencyKey: childKey(command.idempotencyKey, `edge:${index}`),
				sourceNodeId: nodeIds[index],
				targetNodeId: nodeIds[index + 1],
				sourcePort: "output",
				targetPort: "input",
				dependencyType: "reference",
			});
			if (!isRecord(response) || !isRecord(response.edge) || !Number.isSafeInteger(response.version)) {
				throw gatewayError("INVALID_RESPONSE", "本地画布未返回有效的连线结果");
			}
			edges.push(response.edge);
			version = response.version as number;
		}
		return { operation: command.operation, edges, canvasVersion: version };
	}

	private async updateNodeConfig(command: CanvasCommand): Promise<Record<string, unknown>> {
		const nodeId = stringValue(command.payload.nodeId);
		const config = recordValue(command.payload.config);
		if (!nodeId) throw gatewayError("INVALID_INPUT", "节点标识无效", 400);
		const allowed = new Set([
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
		]);
		const changes = Object.keys(config).some((key) => allowed.has(key)) ? config : { params: config };
		const response = await this.call("agent:core:update-node", {
			projectId: this.projectId,
			canvasId: command.canvasId,
			expectedVersion: command.expectedVersion,
			idempotencyKey: command.idempotencyKey,
			nodeId,
			...changes,
		});
		if (!isRecord(response) || !isRecord(response.node) || !Number.isSafeInteger(response.version)) {
			throw gatewayError("INVALID_RESPONSE", "本地画布未返回有效的更新结果");
		}
		return { ...response, node: projectNode(response.node), canvasVersion: response.version };
	}

	private async layoutNodes(command: CanvasCommand): Promise<Record<string, unknown>> {
		const rawCanvas = await this.loadCanvas(command.canvasId);
		const detail = projectCanvas(rawCanvas);
		const version = recordValue(detail.canvas).version;
		if (typeof version !== "number" || version !== command.expectedVersion) {
			throw new ToolGatewayError("VERSION_CONFLICT", "画布版本已变化，请刷新", { version }, 409);
		}
		const selectedIds = strings(command.payload.nodeIds);
		const layout = recordValue(command.payload.layout);
		const positions = recordValue(layout.positions);
		const direction = layout.direction === "vertical" ? "vertical" : "horizontal";
		const gap = typeof layout.gap === "number" && Number.isFinite(layout.gap) ? Math.max(80, layout.gap) : 360;
		const nodes = detail.nodes as Record<string, unknown>[];
		const moved = nodes.map((node, index) => {
			const id = stringValue(node.id) ?? "";
			const explicit = recordValue(positions[id]);
			if (!selectedIds.includes(id)) return node;
			return {
				...node,
				x: typeof explicit.x === "number" ? explicit.x : direction === "horizontal" ? 120 + index * gap : 120,
				y: typeof explicit.y === "number" ? explicit.y : direction === "vertical" ? 120 + index * gap : 120,
			};
		});
		const saved = await this.call("agent:core:save-canvas", {
			projectId: this.projectId,
			canvasId: command.canvasId,
			expectedVersion: version,
			idempotencyKey: command.idempotencyKey,
			nodes: moved.map((node) =>
				flowNodeForSave(
					node,
					rawCanvas.nodes.find((raw) => raw.id === node.id),
				),
			),
			edges: rawCanvas.edges,
			groups: rawCanvas.groups,
			stacks: rawCanvas.stacks,
		});
		if (!isRecord(saved) || !Number.isSafeInteger(saved.version))
			throw gatewayError("INVALID_RESPONSE", "本地画布未返回有效的布局结果");
		return { operation: command.operation, canvasVersion: saved.version, replayed: saved.replayed === true };
	}

	private async loadCanvas(canvasId: string | undefined): Promise<LocalCanvas> {
		const response = await this.call("agent:core:load-canvas", {
			projectId: this.projectId,
			...(canvasId ? { canvasId } : {}),
		});
		if (
			!isRecord(response) ||
			typeof response.canvasId !== "string" ||
			!Number.isSafeInteger(response.version) ||
			!Array.isArray(response.nodes) ||
			!Array.isArray(response.edges)
		) {
			throw gatewayError("INVALID_RESPONSE", "本地画布响应无效");
		}
		return response as unknown as LocalCanvas;
	}

	private async call(method: string, payload: Record<string, unknown>): Promise<unknown> {
		try {
			return await this.client.request(method, payload, method.endsWith("save-canvas") ? 60_000 : 30_000);
		} catch (error) {
			if (error instanceof ToolGatewayError) throw error;
			const raw = error instanceof Error ? error.message : String(error);
			const code = mapLocalErrorCode(raw);
			throw gatewayError(
				code,
				safeLocalErrorMessage(code),
				code === "VERSION_CONFLICT" ? 409 : code === "INVALID_INPUT" ? 400 : 502,
			);
		}
	}
}

type LocalCanvas = {
	projectId: string;
	canvasId: string;
	version: number;
	nodes: Record<string, unknown>[];
	edges: Record<string, unknown>[];
	groups?: unknown[];
	stacks?: unknown[];
};

function projectCanvas(canvas: LocalCanvas): Record<string, unknown> {
	const nodes = canvas.nodes.map(projectNode);
	const edges = canvas.edges.map((edge) => {
		const data = recordValue(edge.data);
		return {
			id: edge.id,
			sourceNodeId: edge.sourceNodeId ?? edge.source,
			targetNodeId: edge.targetNodeId ?? edge.target,
			sourcePort: edge.sourcePort ?? edge.sourceHandle ?? "output",
			targetPort: edge.targetPort ?? edge.targetHandle ?? "input",
			dependencyType: edge.dependencyType ?? data.dependencyType ?? "reference",
		};
	});
	return {
		canvas: { id: canvas.canvasId, version: canvas.version },
		nodes,
		edges,
		groups: Array.isArray(canvas.groups)
			? canvas.groups.slice(0, 500).map((group) => (isRecord(group) ? stripPrivateFields(group) : group))
			: [],
		stacks: Array.isArray(canvas.stacks)
			? canvas.stacks.slice(0, 500).map((stack) => (isRecord(stack) ? stripPrivateFields(stack) : stack))
			: [],
	};
}

function projectNode(node: Record<string, unknown>): Record<string, unknown> {
	const data = recordValue(node.data);
	const nested = recordValue(data.node);
	const dataParams = recordValue(data.params);
	const params = Object.keys(dataParams).length > 0 ? dataParams : recordValue(nested.params);
	const position = recordValue(node.position);
	const dataOutput = recordValue(data.output);
	const output = Object.keys(dataOutput).length > 0 ? dataOutput : recordValue(nested.output);
	return stripPrivateFields({
		id: node.id,
		type: node.type,
		x: position.x ?? nested.x,
		y: position.y ?? nested.y,
		width: node.width ?? nested.width,
		height: node.height ?? nested.height,
		creativeType: data.creativeType ?? nested.creativeType,
		params: boundValue(stripPrivateFields(params), 0) as Record<string, unknown>,
		prompt: data.prompt ?? nested.prompt ?? params.prompt,
		output: boundValue(stripPrivateFields(output), 0) as Record<string, unknown>,
		status: data.status ?? nested.status,
		execStatus: data.execStatus ?? nested.execStatus,
		stale: data.stale ?? nested.stale,
		label: data.label,
	});
}

function flowNodeForSave(
	projected: Record<string, unknown>,
	raw: Record<string, unknown> | undefined,
): Record<string, unknown> {
	if (!raw) throw gatewayError("NOT_FOUND", "布局节点已不存在", 404);
	const position = recordValue(raw.position);
	return { ...raw, position: { ...position, x: projected.x, y: projected.y } };
}

function projectTask(task: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {
		taskId: task.taskId,
		status: task.status,
		outputAvailable: task.status === "succeeded" && typeof task.outputPath === "string" && task.outputPath.length > 0,
	};
	for (const key of ["modality", "attemptCount", "errorCode", "createdAt", "updatedAt", "startedAt", "completedAt"])
		if (task[key] !== undefined) result[key] = task[key];
	return result;
}

function stripPrivateFields(value: Record<string, unknown>): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (/(?:secret|token|password|api[_-]?key|authorization|binary|base64|path|directory|filelocation)/i.test(key))
			continue;
		if (typeof entry === "string" && containsAbsolutePath(entry)) continue;
		if (Array.isArray(entry)) output[key] = entry.map((item) => (isRecord(item) ? stripPrivateFields(item) : item));
		else output[key] = isRecord(entry) ? stripPrivateFields(entry) : entry;
	}
	return output;
}

function boundValue(value: unknown, depth: number): unknown {
	if (typeof value === "string") return value.slice(0, depth > 1 ? 4_000 : 20_000);
	if (Array.isArray(value))
		return depth >= 4
			? `[${value.length} items omitted]`
			: value.slice(0, 100).map((item) => boundValue(item, depth + 1));
	if (!isRecord(value)) return value;
	if (depth >= 5) return "[nested content omitted]";
	return Object.fromEntries(
		Object.entries(value)
			.slice(0, 200)
			.map(([key, child]) => [key, boundValue(child, depth + 1)]),
	);
}

function containsAbsolutePath(value: string): boolean {
	return /(?:^|[\s"'])(?:[A-Za-z]:\\|\\\\[^\\]+\\|\/Users\/|\/home\/|\/private\/var\/|\/tmp\/)/u.test(value);
}

function childKey(parent: string, step: string): string {
	return `agent-${createHash("sha256").update(`${parent}\0${step}`).digest("hex").slice(0, 56)}`;
}

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function recordValue(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapLocalErrorCode(message: string): string {
	if (/VERSION_CONFLICT|版本已变化|请刷新|其他会话更新/u.test(message)) return "VERSION_CONFLICT";
	if (/NOT_FOUND|不存在/u.test(message)) return "NOT_FOUND";
	if (/非法|无效|超过|必须|禁止|不支持/u.test(message)) return "INVALID_INPUT";
	if (/AGENT_PROJECT_CHANGED|当前项目已更改/u.test(message)) return "PERMISSION_DENIED";
	if (/TIMEOUT/u.test(message)) return "SERVICE_TIMEOUT";
	if (/Idempotency-Key/u.test(message)) return "INVALID_INPUT";
	return "CANVAS_UNAVAILABLE";
}

function safeLocalErrorMessage(code: string): string {
	if (code === "VERSION_CONFLICT") return "画布已更新，请读取最新内容后重试";
	if (code === "NOT_FOUND") return "请求的画布内容不存在";
	if (code === "INVALID_INPUT") return "画布操作参数无效";
	if (code === "PERMISSION_DENIED") return "当前项目已切换，操作未执行";
	return "本地画布暂时无法处理该操作";
}

function gatewayError(code: string, message: string, status = 502): ToolGatewayError {
	return new ToolGatewayError(code, message, {}, status);
}
