export type ActionRisk = "low" | "canvas_write" | "high";

export type ActionBinding = {
	userId: string;
	sessionId: string;
	canvasId: string;
	canvasVersion: number;
	actionHash: string;
	expiresAt: number;
};

export type PlannedAction = {
	actionId: string;
	runId?: string;
	userId: string;
	sessionId: string;
	canvasId: string;
	canvasVersion: number;
	toolName: string;
	params: Record<string, unknown>;
	estimatedCost: number;
	risk: ActionRisk;
	actionHash: string;
	binding: ActionBinding;
	approvalToken?: string;
	status: "planned" | "awaiting_approval";
};

export type ConsumedAction = Omit<PlannedAction, "status"> & { status: "approved" };
