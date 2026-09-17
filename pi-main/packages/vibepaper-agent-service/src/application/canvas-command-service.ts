export type CanvasCommand = {
	userId: string;
	canvasId: string;
	requestId?: string;
	expectedVersion: number;
	idempotencyKey: string;
	operation: "create_nodes" | "connect_nodes" | "layout_nodes" | "update_node_config" | "delete_nodes";
	payload: Record<string, unknown>;
};

export type CanvasCommandGateway = {
	execute(command: CanvasCommand): Promise<Record<string, unknown>>;
};

export class CanvasCommandService {
	private readonly gateway: CanvasCommandGateway;
	private readonly results = new Map<string, Record<string, unknown>>();

	constructor(gateway: CanvasCommandGateway) {
		this.gateway = gateway;
	}

	async execute(command: CanvasCommand): Promise<Record<string, unknown>> {
		const cached = this.results.get(command.idempotencyKey);
		if (cached) return cached;
		try {
			const result = await this.gateway.execute(command);
			this.results.set(command.idempotencyKey, result);
			return result;
		} catch (error) {
			// Gateway errors carry retryability and conflict information. Preserve
			// them so the runtime can recover; caching one failure here previously
			// turned a transient canvas error into a permanent failure for the Run.
			const structuredCode = structuredErrorCode(error);
			if (structuredCode && structuredStatusCode(error) !== undefined) throw error;
			if (structuredCode) {
				const message = error instanceof Error ? error.message : structuredCode;
				const wrapped = new Error(`[${structuredCode}] ${message}`) as Error & { code: string };
				wrapped.code = structuredCode;
				throw wrapped;
			}
			const message = error instanceof Error ? error.message : String(error);
			const known = [
				"PERMISSION_DENIED",
				"NOT_FOUND",
				"INVALID_INPUT",
				"BATCH_LIMIT_EXCEEDED",
				"VERSION_CONFLICT",
			] as const;
			const code =
				known.find((candidate) => structuredErrorCode(error) === candidate || message.includes(candidate)) ??
				(message.includes("409") ? "VERSION_CONFLICT" : "CANVAS_UNAVAILABLE");
			throw new Error(code);
		}
	}

	createNodes(input: {
		userId: string;
		canvasId: string;
		requestId?: string;
		expectedVersion: number;
		idempotencyKey: string;
		nodes: readonly Record<string, unknown>[];
	}): Promise<Record<string, unknown>> {
		if (input.nodes.length > 20) return Promise.reject(new Error("BATCH_LIMIT_EXCEEDED"));
		return this.execute({ ...input, operation: "create_nodes", payload: { nodes: input.nodes } });
	}

	connectNodes(input: {
		userId: string;
		canvasId: string;
		requestId?: string;
		expectedVersion: number;
		idempotencyKey: string;
		nodeIds: readonly string[];
	}): Promise<Record<string, unknown>> {
		if (input.nodeIds.length > 20) return Promise.reject(new Error("BATCH_LIMIT_EXCEEDED"));
		return this.execute({ ...input, operation: "connect_nodes", payload: { nodeIds: input.nodeIds } });
	}

	layoutNodes(input: {
		userId: string;
		canvasId: string;
		requestId?: string;
		expectedVersion: number;
		idempotencyKey: string;
		nodeIds: readonly string[];
		layout: Record<string, unknown>;
	}): Promise<Record<string, unknown>> {
		if (input.nodeIds.length > 20) return Promise.reject(new Error("BATCH_LIMIT_EXCEEDED"));
		return this.execute({
			...input,
			operation: "layout_nodes",
			payload: { nodeIds: input.nodeIds, layout: input.layout },
		});
	}

	updateNodeConfig(input: {
		userId: string;
		canvasId: string;
		requestId?: string;
		expectedVersion: number;
		idempotencyKey: string;
		nodeId: string;
		config: Record<string, unknown>;
	}): Promise<Record<string, unknown>> {
		return this.execute({
			...input,
			operation: "update_node_config",
			payload: { nodeId: input.nodeId, config: input.config },
		});
	}

	deleteNodes(input: {
		userId: string;
		canvasId: string;
		requestId?: string;
		expectedVersion: number;
		idempotencyKey: string;
		nodeIds: readonly string[];
	}): Promise<Record<string, unknown>> {
		if (input.nodeIds.length > 20) return Promise.reject(new Error("BATCH_LIMIT_EXCEEDED"));
		return this.execute({ ...input, operation: "delete_nodes", payload: { nodeIds: input.nodeIds } });
	}
}

function structuredErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function structuredStatusCode(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
	const statusCode = (error as { statusCode?: unknown }).statusCode;
	return typeof statusCode === "number" ? statusCode : undefined;
}
