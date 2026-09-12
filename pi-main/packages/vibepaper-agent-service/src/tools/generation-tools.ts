import type { ApprovalService, PlanActionInput } from "../application/approval-service.ts";
import type { ConsumedAction, PlannedAction } from "../domain/action-approval.ts";

export type SubmitGenerationInput = {
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
	requiresApproval?: boolean;
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
		const actionInput: PlanActionInput = {
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
			},
			estimatedCost: input.estimatedCost,
			risk: "high",
			requiresApproval: input.requiresApproval ?? true,
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
		const estimatedCost = input.generations.reduce((total, item) => total + item.estimatedCost, 0);
		const proposal = await this.approvals.planActionAsync({
			userId: input.userId,
			runId: input.runId,
			sessionId: input.sessionId,
			canvasId: input.canvasId,
			canvasVersion: input.canvasVersion,
			toolName: "submit_generation_batch",
			params: { generations: input.generations },
			estimatedCost,
			risk: "high",
			requiresApproval: input.requiresApproval ?? true,
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
