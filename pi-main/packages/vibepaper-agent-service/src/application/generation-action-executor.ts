export type GenerationEstimate = { estimatedCost: number; pricingVersion: number };

export type GenerationGateway = {
	estimate(input: {
		userId: string;
		modelType: string;
		modelParams: Record<string, unknown>;
		requestId?: string;
	}): Promise<GenerationEstimate>;
};

export type BillingGateway = {
	freeze(input: {
		userId: string;
		canvasId: string;
		nodeId: string;
		modelType: string;
		modelParams: Record<string, unknown>;
		requestId?: string;
		estimatedCost: number;
		idempotencyKey: string;
	}): Promise<{ taskId: string; status: string }>;
};

export type CanvasGateway = {
	markQueued(input: {
		userId: string;
		canvasId: string;
		nodeId: string;
		taskId: string;
		requestId?: string;
		idempotencyKey?: string;
	}): Promise<void>;
};

export type ExecuteGenerationInput = {
	actionId: string;
	userId: string;
	canvasId: string;
	nodeId: string;
	modelType: string;
	modelParams: Record<string, unknown>;
	requestId?: string;
	requestedCost: number;
	costCap: number;
};

export type GenerationExecutionResult = {
	actionId: string;
	taskId: string;
	actualCost: number;
	pricingVersion: number;
	compensationRequired: boolean;
};

export type BatchGenerationExecutionResult = {
	results: GenerationExecutionResult[];
	actualCost: number;
};

export class GenerationActionExecutor {
	private readonly generation: GenerationGateway;
	private readonly billing: BillingGateway;
	private readonly canvas: CanvasGateway;
	private readonly compensate: (actionId: string, taskId: string, userId: string) => Promise<void>;
	private readonly results = new Map<string, GenerationExecutionResult>();
	private readonly inFlight = new Map<string, Promise<GenerationExecutionResult>>();

	constructor(
		generation: GenerationGateway,
		billing: BillingGateway,
		canvas: CanvasGateway,
		compensate: (actionId: string, _taskId: string, _userId: string) => Promise<void> = async () => {},
	) {
		this.generation = generation;
		this.billing = billing;
		this.canvas = canvas;
		this.compensate = compensate;
	}

	execute(input: ExecuteGenerationInput): Promise<GenerationExecutionResult> {
		const result = this.results.get(input.actionId);
		if (result) return Promise.resolve(result);
		const pending = this.inFlight.get(input.actionId);
		if (pending) return pending;
		const operation = this.executeOnce(input);
		this.inFlight.set(input.actionId, operation);
		return operation.finally(() => this.inFlight.delete(input.actionId));
	}

	async executeBatch(inputs: ExecuteGenerationInput[]): Promise<BatchGenerationExecutionResult> {
		const results: GenerationExecutionResult[] = [];
		for (const input of inputs) results.push(await this.execute(input));
		return { results, actualCost: results.reduce((total, result) => total + result.actualCost, 0) };
	}

	private async executeOnce(input: ExecuteGenerationInput): Promise<GenerationExecutionResult> {
		const estimate = await this.generation.estimate({
			userId: input.userId,
			modelType: input.modelType,
			modelParams: input.modelParams,
			requestId: input.requestId,
		});
		if (!Number.isInteger(estimate.estimatedCost) || estimate.estimatedCost < 0) throw new Error("INVALID_ESTIMATE");
		if (estimate.estimatedCost > input.costCap) throw new Error("COST_CAP_EXCEEDED");
		const task = await this.billing.freeze({
			userId: input.userId,
			canvasId: input.canvasId,
			nodeId: input.nodeId,
			modelType: input.modelType,
			modelParams: input.modelParams,
			estimatedCost: estimate.estimatedCost,
			idempotencyKey: `agt:${input.actionId}:1`,
			requestId: input.requestId,
		});
		let compensationRequired = false;
		try {
			await this.canvas.markQueued({
				userId: input.userId,
				canvasId: input.canvasId,
				nodeId: input.nodeId,
				taskId: task.taskId,
				requestId: input.requestId,
				idempotencyKey: `agt:${input.actionId}:queued`,
			});
		} catch {
			compensationRequired = true;
			await this.compensate(input.actionId, task.taskId, input.userId);
		}
		const result: GenerationExecutionResult = {
			actionId: input.actionId,
			taskId: task.taskId,
			actualCost: estimate.estimatedCost,
			pricingVersion: estimate.pricingVersion,
			compensationRequired,
		};
		this.results.set(input.actionId, result);
		return result;
	}
}
