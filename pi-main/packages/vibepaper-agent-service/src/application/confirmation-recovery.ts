export type PendingConfirmation = {
	tool: string;
	actionId: string;
	approvalToken: string | undefined;
	estimatedCost: number;
	canvasVersion: number;
	expiresAt: number;
	affectedNodeCount?: number;
};

export function confirmationRecoveryMessage(input: PendingConfirmation): {
	content: string;
	meta: Record<string, unknown>;
} {
	return {
		content: "生成已准备就绪，请确认后继续执行。",
		meta: {
			requiresConfirmation: true,
			confirmation: {
				actionId: input.actionId,
				approvalToken: input.approvalToken,
				tool: input.tool,
				summary: "确认继续生成",
				confirmReason: "该操作会产生外部副作用或点数费用",
				estimatedCost: input.estimatedCost,
				estimatedTotalCost: input.estimatedCost,
				affectedNodeCount: input.affectedNodeCount,
				canvasVersion: input.canvasVersion,
				expiresAt: new Date(input.expiresAt).toISOString(),
				status: "pending",
			},
		},
	};
}
