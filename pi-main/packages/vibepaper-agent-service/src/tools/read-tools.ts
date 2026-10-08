export interface ReadToolsGateway {
	getCanvasSummary(userId: string, canvasId: string, requestId?: string): Promise<unknown>;
	getSelectedNodes(userId: string, canvasId: string, nodeIds: readonly string[], requestId?: string): Promise<unknown>;
	getNodeDetail(userId: string, canvasId: string, nodeId: string, requestId?: string): Promise<unknown>;
	listModels(userId: string, requestId?: string): Promise<unknown>;
	searchAssets(userId: string, query: string, requestId?: string): Promise<unknown>;
	checkTaskStatus(userId: string, taskId: string, requestId?: string): Promise<unknown>;
}

export class ReadTools {
	private readonly gateway: ReadToolsGateway;

	constructor(gateway: ReadToolsGateway) {
		this.gateway = gateway;
	}

	async getCanvasSummary(userId: string, canvasId: string, requestId?: string): Promise<Record<string, unknown>> {
		return await this.objectResult(() => this.gateway.getCanvasSummary(userId, canvasId, requestId));
	}

	async getSelectedNodes(
		userId: string,
		canvasId: string,
		nodeIds: readonly string[],
		requestId?: string,
	): Promise<readonly unknown[]> {
		return await this.arrayResult(() => this.gateway.getSelectedNodes(userId, canvasId, nodeIds, requestId));
	}

	async getNodeDetail(
		userId: string,
		canvasId: string,
		nodeId: string,
		requestId?: string,
	): Promise<Record<string, unknown>> {
		return await this.objectResult(() => this.gateway.getNodeDetail(userId, canvasId, nodeId, requestId));
	}

	async listModels(userId: string, requestId?: string): Promise<readonly unknown[]> {
		return await this.arrayResult(() => this.gateway.listModels(userId, requestId));
	}

	async searchAssets(userId: string, query: string, requestId?: string): Promise<readonly unknown[]> {
		return await this.arrayResult(() => this.gateway.searchAssets(userId, query, requestId));
	}

	async checkTaskStatus(userId: string, taskId: string, requestId?: string): Promise<Record<string, unknown>> {
		return await this.objectResult(() => this.gateway.checkTaskStatus(userId, taskId, requestId));
	}

	private async objectResult(operation: () => Promise<unknown>): Promise<Record<string, unknown>> {
		const result = await this.call(operation);
		if (!isRecord(result)) throw new Error("INVALID_RESPONSE");
		return sanitize(result);
	}

	private async arrayResult(operation: () => Promise<unknown>): Promise<readonly unknown[]> {
		const result = await this.call(operation);
		if (!Array.isArray(result)) throw new Error("INVALID_RESPONSE");
		return result.map((item) => (isRecord(item) ? sanitize(item) : item));
	}

	private async call(operation: () => Promise<unknown>): Promise<unknown> {
		try {
			return await operation();
		} catch (error) {
			// Keep structured gateway failures intact so the runtime retry policy can
			// distinguish a transient downstream timeout from a conflict or permission
			// denial. Collapsing every error here made safe retries impossible.
			if (isGatewayError(error)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("403") || message.includes("PERMISSION_DENIED")) throw new Error("PERMISSION_DENIED");
			throw new Error(message.includes("TIMEOUT") ? "SERVICE_TIMEOUT" : "DOWNSTREAM_UNAVAILABLE");
		}
	}
}

function isGatewayError(error: unknown): error is Error & { code: string; statusCode: number } {
	return (
		error instanceof Error &&
		typeof (error as { code?: unknown }).code === "string" &&
		typeof (error as { statusCode?: unknown }).statusCode === "number"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitize(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(record)
			.filter(([key]) => !/(secret|token|password|api[_-]?key|authorization|binary|base64)/i.test(key))
			.map(([key, value]) => [key, isRecord(value) ? sanitize(value) : Array.isArray(value) ? value : value]),
	);
}
