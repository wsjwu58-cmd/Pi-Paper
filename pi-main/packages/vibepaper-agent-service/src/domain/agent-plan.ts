export type PlanStepStatus = "pending" | "running" | "completed" | "failed" | "stale";
export type PlanStepEffect = "read" | "write_canvas" | "create_task";

export interface PlanStep {
	id: string;
	tool: string;
	dependsOn: readonly string[];
	status: PlanStepStatus;
	inputHash: string;
	input?: Record<string, unknown>;
	estimatedCost: number;
	batchSize?: number;
	/** Declared by a plan author and verified against the tool manifest at compile time. */
	effect?: PlanStepEffect;
	/** Steps sharing a key are never eligible for the same execution partition. */
	concurrencyKey?: string;
}

export interface AgentPlan {
	id: string;
	sessionId: string;
	version: number;
	canvasVersion: number;
	steps: readonly PlanStep[];
}
