import type { ApprovalService, PlanActionInput } from "../application/approval-service.ts";
import type { ConsumedAction, PlannedAction } from "../domain/action-approval.ts";

export type SubmitGenerationInput = {
	actionId?: string;
	actionIdempotencyKey: string;
	userId: string;
	runId?: string;
	sessionId: string;
	canvasId: string;
	canvasVersion: number;
	nodeId: string;
	modelType: string;
	modelParams: Record<string, unknown>;
	estimatedCost: number;
	overwrite: boolean;
	continueAfterTask?: boolean;
};

export type SubmitGenerationBatchInput = Omit<
	SubmitGenerationInput,
	"nodeId" | "modelType" | "modelParams" | "estimatedCost" | "overwrite"
> & {
	generations: Array<{
		nodeId: string;
		modelType: string;
		modelParams: Record<string, unknown>;
		estimatedCost: number;
		overwrite: boolean;
	}>;
};

export class GenerationTools {
	private readonly approvals: ApprovalService;
	private readonly proposals = new Map<string, PlannedAction>();

	constructor(approvals: ApprovalService) {
		this.approvals = approvals;
	}

	async submitGeneration(input: SubmitGenerationInput): Promise<PlannedAction> {
		const existing = this.proposals.get(input.actionIdempotencyKey);
		if (existing) return existing;
		const persisted = input.actionId ? await this.approvals.findPlannedAction(input.actionId) : undefined;
		if (persisted) {
			if (!sameSingleGenerationAction(persisted, input)) throw new Error("APPROVAL_IDEMPOTENCY_CONFLICT");
			this.proposals.set(input.actionIdempotencyKey, persisted);
			return persisted;
		}
		const actionInput: PlanActionInput = {
			actionId: input.actionId,
			userId: input.userId,
			runId: input.runId,
			sessionId: input.sessionId,
			canvasId: input.canvasId,
			canvasVersion: input.canvasVersion,
			toolName: "submit_generation",
			params: {
				nodeId: input.nodeId,
				modelType: input.modelType,
				modelParams: input.modelParams,
				overwrite: input.overwrite,
				continueAfterTask: input.continueAfterTask,
			},
			estimatedCost: input.estimatedCost,
			risk: "high",
			requiresApproval: true,
		};
		const proposal = await this.approvals.planActionAsync(actionInput);
		this.proposals.set(input.actionIdempotencyKey, proposal);
		return proposal;
	}

	/** One approval binds the complete batch to one canvas version. */
	async submitGenerationBatch(input: SubmitGenerationBatchInput): Promise<PlannedAction> {
		if (input.generations.length < 2) throw new Error("BATCH_REQUIRES_MULTIPLE_GENERATIONS");
		const existing = this.proposals.get(input.actionIdempotencyKey);
		if (existing) return existing;
		const persisted = input.actionId ? await this.approvals.findPlannedAction(input.actionId) : undefined;
		if (persisted) {
			if (!sameBatchGenerationAction(persisted, input)) throw new Error("APPROVAL_IDEMPOTENCY_CONFLICT");
			this.proposals.set(input.actionIdempotencyKey, persisted);
			return persisted;
		}
		const estimatedCost = input.generations.reduce((total, item) => total + item.estimatedCost, 0);
		const proposal = await this.approvals.planActionAsync({
			actionId: input.actionId,
			userId: input.userId,
			runId: input.runId,
			sessionId: input.sessionId,
			canvasId: input.canvasId,
			canvasVersion: input.canvasVersion,
			toolName: "submit_generation_batch",
			params: { generations: input.generations, continueAfterTask: input.continueAfterTask },
			estimatedCost,
			risk: "high",
			requiresApproval: true,
		});
		this.proposals.set(input.actionIdempotencyKey, proposal);
		return proposal;
	}

	consumeApproval(
		actionId: string,
		token: string,
		currentCanvasVersion: number,
		now?: number,
	): Promise<ConsumedAction> {
		return this.approvals.consumeApproval(actionId, token, currentCanvasVersion, now);
	}
}

function sameSingleGenerationAction(action: PlannedAction, input: SubmitGenerationInput): boolean {
	return (
		action.toolName === "submit_generation" &&
		action.userId === input.userId &&
		action.sessionId === input.sessionId &&
		action.canvasId === input.canvasId &&
		action.canvasVersion === input.canvasVersion &&
		JSON.stringify(action.params) ===
			JSON.stringify({
				nodeId: input.nodeId,
				modelType: input.modelType,
				modelParams: input.modelParams,
				overwrite: input.overwrite,
				...(input.continueAfterTask === undefined ? {} : { continueAfterTask: input.continueAfterTask }),
			})
	);
}

function sameBatchGenerationAction(action: PlannedAction, input: SubmitGenerationBatchInput): boolean {
	const expected = {
		generations: input.generations.map((item) => ({
			nodeId: item.nodeId,
			modelType: item.modelType,
			modelParams: item.modelParams,
			estimatedCost: item.estimatedCost,
			overwrite: item.overwrite,
		})),
		...(input.continueAfterTask === undefined ? {} : { continueAfterTask: input.continueAfterTask }),
	};
	return (
		action.toolName === "submit_generation_batch" &&
		action.userId === input.userId &&
		action.sessionId === input.sessionId &&
		action.canvasId === input.canvasId &&
		action.canvasVersion === input.canvasVersion &&
		JSON.stringify(action.params) === JSON.stringify(expected)
	);
}
