export type AgentTraceFields = {
	request_id: string;
	user_id: string;
	session_id: string;
	run_id: string;
	event_seq: number;
	action_id?: string;
	task_id?: string;
	canvas_id?: string;
	model_id?: string;
	error_code?: string;
	estimated_cost?: number;
	actual_cost?: number;
	[key: string]: unknown;
};

const SENSITIVE = /(api[_-]?key|password|secret|token|authorization)/i;

export class AgentTelemetry {
	private readonly traceRecords: AgentTraceFields[] = [];
	private readonly metrics = new Map<string, number>();

	record(fields: AgentTraceFields): void {
		const safe = Object.fromEntries(
			Object.entries(fields).map(([key, value]) => [
				key,
				SENSITIVE.test(key)
					? "[REDACTED]"
					: typeof value === "string" && SENSITIVE.test(value)
						? "[REDACTED]"
						: value,
			]),
		) as AgentTraceFields;
		this.traceRecords.push(safe);
	}

	records(): readonly AgentTraceFields[] {
		return [...this.traceRecords];
	}
	increment(metric: string): void {
		this.metrics.set(metric, (this.metrics.get(metric) ?? 0) + 1);
	}
	metric(metric: string): number {
		return this.metrics.get(metric) ?? 0;
	}
}
