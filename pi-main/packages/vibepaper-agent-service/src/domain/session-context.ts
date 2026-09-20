import type { AgentRunEvent } from "./agent-run.ts";

export const SESSION_CONTEXT_SCHEMA_VERSION = 1;

export type SessionTaskState = {
	status: string;
	nodeId?: string;
	errorCode?: string;
	outputRef?: string;
	updatedAtEventSeq: number;
};

export type PendingApprovalState = {
	actionId: string;
	tool: string;
	canvasVersion: number;
	expiresAt?: string;
};

export type SessionContext = {
	schemaVersion: number;
	sessionId: string;
	canvasId?: string;
	canvasVersion: number;
	goal?: string;
	constraints: string[];
	activePlan: string[];
	completedSteps: string[];
	pendingSteps: string[];
	nodeRefs: string[];
	tasks: Record<string, SessionTaskState>;
	pendingApproval?: PendingApprovalState;
	lastRunStatus?: string;
	summary: string;
	compactedToEventSeq: number;
	updatedAt: string;
};

export function createSessionContext(sessionId: string, canvasId?: string): SessionContext {
	return {
		schemaVersion: SESSION_CONTEXT_SCHEMA_VERSION,
		sessionId,
		...(canvasId ? { canvasId } : {}),
		canvasVersion: 0,
		constraints: [],
		activePlan: [],
		completedSteps: [],
		pendingSteps: [],
		nodeRefs: [],
		tasks: {},
		summary: "",
		compactedToEventSeq: 0,
		updatedAt: new Date(0).toISOString(),
	};
}

/**
 * Derive working state from the append-only run events. The reducer intentionally
 * ignores free-form model text: canvas/task facts must come from authoritative
 * tool and callback events so a compacted summary cannot invent progress.
 */
export function reduceSessionEvent(context: SessionContext, event: AgentRunEvent): SessionContext {
	const data = event.data;
	const next: SessionContext = {
		...context,
		tasks: { ...context.tasks },
		nodeRefs: [...context.nodeRefs],
		constraints: [...context.constraints],
		activePlan: [...context.activePlan],
		completedSteps: [...context.completedSteps],
		pendingSteps: [...context.pendingSteps],
		updatedAt: event.createdAt.toISOString(),
		compactedToEventSeq: Math.max(context.compactedToEventSeq, event.eventSeq),
	};
	const canvasVersion = firstInteger(data.canvas_version, data.canvasVersion, nestedValue(data, "details.canvasVersion"));
	if (canvasVersion !== undefined && canvasVersion >= next.canvasVersion) next.canvasVersion = canvasVersion;

	if (event.type === "confirmation_required") {
		const actionId = stringValue(data.actionId);
		const tool = stringValue(data.tool);
		const version = firstInteger(data.canvasVersion, data.canvas_version) ?? next.canvasVersion;
		if (actionId && tool) {
			next.pendingApproval = {
				actionId,
				tool,
				canvasVersion: version,
				...(stringValue(data.expiresAt) ? { expiresAt: stringValue(data.expiresAt) } : {}),
			};
		}
	}
	if (event.type === "tool_started" && next.pendingApproval) {
		const tool = stringValue(data.tool);
		if (tool && tool === next.pendingApproval.tool) next.pendingApproval = undefined;
	}
	if (event.type === "task_status") {
		const taskId = stringValue(data.task_id ?? data.taskId);
		const status = stringValue(data.status);
		if (taskId && status) {
			next.tasks[taskId] = {
				status,
				...(stringValue(data.node_id ?? data.nodeId) ? { nodeId: stringValue(data.node_id ?? data.nodeId) } : {}),
				...(stringValue(data.error_code ?? data.errorCode)
					? { errorCode: stringValue(data.error_code ?? data.errorCode) }
					: {}),
				...(stringValue(data.output_ref ?? data.outputRef)
					? { outputRef: stringValue(data.output_ref ?? data.outputRef) }
					: {}),
				updatedAtEventSeq: event.eventSeq,
			};
		}
	}
	if (event.type === "run_completed" || event.type === "run_failed" || event.type === "run_aborted") {
		next.lastRunStatus = event.type === "run_completed" ? "completed" : event.type.slice("run_".length);
		if (event.type !== "run_failed") next.pendingApproval = undefined;
	}
	for (const nodeId of nodeIdsFrom(data)) if (!next.nodeRefs.includes(nodeId)) next.nodeRefs.push(nodeId);
	return next;
}

export function reduceSessionEvents(
	context: SessionContext,
	events: readonly AgentRunEvent[],
): SessionContext {
	return [...events]
		.filter((event) => event.eventSeq > context.compactedToEventSeq)
		.sort((left, right) => left.eventSeq - right.eventSeq)
		.reduce(reduceSessionEvent, context);
}

export function formatSessionContext(context: SessionContext, maxCharacters = 8_000): string {
	const tasks = Object.entries(context.tasks).map(([id, state]) => ({ taskId: id, ...state }));
	const value = {
		schemaVersion: context.schemaVersion,
		canvasVersion: context.canvasVersion,
		goal: context.goal,
		constraints: context.constraints,
		activePlan: context.activePlan,
		completedSteps: context.completedSteps,
		pendingSteps: context.pendingSteps,
		nodeRefs: context.nodeRefs,
		tasks,
		pendingApproval: context.pendingApproval
			? { actionId: context.pendingApproval.actionId, tool: context.pendingApproval.tool, canvasVersion: context.pendingApproval.canvasVersion }
			: undefined,
		lastRunStatus: context.lastRunStatus,
	};
	const serialized = JSON.stringify(value);
	return serialized.length <= maxCharacters ? serialized : `${serialized.slice(0, Math.max(0, maxCharacters - 1))}…`;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstInteger(...values: unknown[]): number | undefined {
	for (const value of values) if (typeof value === "number" && Number.isSafeInteger(value)) return value;
	return undefined;
}

function nestedValue(value: Record<string, unknown>, path: string): unknown {
	let current: unknown = value;
	for (const key of path.split(".")) {
		if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function nodeIdsFrom(data: Record<string, unknown>): string[] {
	const values = [data.node_id, data.nodeId];
	const refs = data.referenceEdges;
	if (Array.isArray(refs)) values.push(...refs);
	return values.flatMap((value) => {
		if (typeof value === "string" && value.trim()) return [value.trim()];
		if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
		const record = value as Record<string, unknown>;
		return [record.sourceNodeId, record.targetNodeId, record.nodeId].flatMap((item) =>
			typeof item === "string" && item.trim() ? [item.trim()] : [],
		);
	});
}
