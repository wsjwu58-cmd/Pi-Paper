export type AgentRunStatus =
	| "queued"
	| "running"
	| "waiting_confirmation"
	| "waiting_task"
	| "completed"
	| "failed"
	| "aborted";

export type AgentRunEventType =
	| "assistant_delta"
	| "tool_started"
	| "tool_completed"
	| "confirmation_required"
	| "task_status"
	| "run_completed"
	| "run_failed"
	| "run_aborted";

export type AgentRun = {
	runId: string;
	sessionId: string;
	idempotencyKey: string;
	status: AgentRunStatus;
	createdAt: Date;
	updatedAt: Date;
};

export type AgentRunEvent = {
	eventId: string;
	runId: string;
	sessionId: string;
	eventSeq: number;
	type: AgentRunEventType;
	runtime: "pi";
	runtimeVersion: string;
	data: Record<string, unknown>;
	createdAt: Date;
};

export function isActiveRunStatus(status: AgentRunStatus): boolean {
	return status === "queued" || status === "running" || status === "waiting_confirmation" || status === "waiting_task";
}
