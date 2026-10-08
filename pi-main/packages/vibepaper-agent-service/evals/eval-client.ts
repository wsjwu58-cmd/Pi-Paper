import type {
	EvalCase,
	EvalEventEnvelope,
	EvalFixture,
	EvalRunResult,
	EvalTurn,
	EvalTurnResult,
} from "./eval-schema.ts";
import { assertEvalCase, type EvalAssertion } from "./eval-schema.ts";

export interface EvalClient {
	createFixture(caseId: string, seedNodes?: readonly Record<string, unknown>[]): Promise<EvalFixture>;
	sendTurn(fixture: EvalFixture, turn: EvalTurn): Promise<EvalTurnResult>;
	confirm(actionId: string, token: string, accept: boolean): Promise<void>;
	resumeEvents(sessionId: string, afterSeq: number): AsyncIterable<EvalEventEnvelope>;
}

export type EvalRunOptions = {
	confirm?: boolean;
	resumeAfterSeq?: number;
};

export async function runEvalCase(client: EvalClient, value: EvalCase, options: EvalRunOptions = {}): Promise<EvalRunResult> {
	assertEvalCase(value);
	const fixture = await client.createFixture(value.caseId, value.fixtureNodes);
	const turns: EvalTurnResult[] = [];
	const resumedEvents: EvalEventEnvelope[] = [];
	for (const turn of value.turns) {
		const result = await client.sendTurn(fixture, turn);
		turns.push(result);
		let waitedForConfirmedTask = false;
		if (options.confirm !== false && turn.confirmation !== "none" && result.actionId && result.confirmationToken) {
			await client.confirm(result.actionId, result.confirmationToken, true);
			const afterSeq = result.events.reduce((highest, event) => Math.max(highest, event.eventSeq), 0);
			for await (const event of client.resumeEvents(fixture.sessionId, afterSeq)) resumedEvents.push(event);
			waitedForConfirmedTask = true;
		}
		if (!waitedForConfirmedTask && options.resumeAfterSeq !== undefined) {
			for await (const event of client.resumeEvents(fixture.sessionId, options.resumeAfterSeq)) resumedEvents.push(event);
		}
	}
	const assertionFailures = evaluateAssertions(value.assertions, turns, resumedEvents);
	const externallyBlocked = turns.length > 0 && turns.every((turn) => turn.errorCode === "MODEL_UNAVAILABLE");
	const expectedErrorCodes = new Set(
		value.assertions
			.filter((assertion): assertion is Extract<EvalAssertion, { type: "error" }> => assertion.type === "error")
			.map((assertion) => assertion.code),
	);
	const unexpectedTurnFailure = turns.some(
		(turn) =>
			(turn.status === "failed" || turn.status === "aborted") &&
			(!turn.errorCode || !expectedErrorCodes.has(turn.errorCode)),
	);
	const status = externallyBlocked
		? "blocked_external"
		: unexpectedTurnFailure || assertionFailures.length > 0
			? "failed"
			: "passed";
	return {
		caseId: value.caseId,
		fixture,
		turns,
		resumedEvents,
		status,
		assertionFailures,
		evidence: {
			caseId: value.caseId,
			turns: turns.map((turn) => redactForEvidence(turn)),
			resumedEvents: resumedEvents.map((event) => redactForEvidence(event)),
			assertionFailures,
		},
	};
}

export function evaluateAssertions(
	assertions: readonly EvalAssertion[],
	turns: readonly EvalTurnResult[],
	resumedEvents: readonly EvalEventEnvelope[],
): string[] {
	const events = turns.flatMap((turn) => turn.events).concat(resumedEvents);
	const errorCodes = new Set(
		turns.map((turn) => turn.errorCode).filter((value): value is string => value !== undefined),
	);
	const nodeTypes = new Set<string>();
	const mediaKinds = new Set<string>();
	const operations = new Set<string>();
	for (const event of events) {
		const data = event.data;
		collectAssertionFacts(data, nodeTypes, mediaKinds, operations);
		for (const key of ["nodeType", "node_type", "kind", "nodeKind"]) {
			if (typeof data[key] === "string") nodeTypes.add(data[key]);
		}
		for (const key of ["mediaKind", "media_kind", "kind"]) {
			if (typeof data[key] === "string") mediaKinds.add(data[key]);
		}
		if (typeof data.errorCode === "string") errorCodes.add(data.errorCode);
		if (typeof data.operation === "string") operations.add(data.operation);
		if (typeof data.tool === "string") operations.add(data.tool);
	}
	const hasTerminalTask = events.some(
		(event) =>
			event.type === "run_completed" ||
			event.type === "run_failed" ||
			event.type === "run_aborted" ||
			(event.type === "task_status" &&
				typeof event.data.status === "string" &&
				["succeeded", "failed", "cancelled", "expired", "settlement_error"].includes(event.data.status)),
	);
	const failures: string[] = [];
	for (const assertion of assertions) {
		if (assertion.type === "confirmation" && assertion.required && !events.some((event) => event.type === "confirmation_required"))
			failures.push("confirmation");
		if (assertion.type === "confirmation" && !assertion.required && events.some((event) => event.type === "confirmation_required"))
			failures.push("confirmation_unexpected");
		if (assertion.type === "task" && assertion.terminal && !hasTerminalTask) failures.push("task:terminal");
		if (assertion.type === "event" && !events.some((event) => event.type === assertion.eventType)) failures.push(`event:${assertion.eventType}`);
		if (assertion.type === "error" && !errorCodes.has(assertion.code)) failures.push(`error:${assertion.code}`);
		if (assertion.type === "node" && !nodeTypes.has(assertion.nodeType)) failures.push(`node:${assertion.nodeType}`);
		if (assertion.type === "media" && !mediaKinds.has(assertion.kind) && !nodeTypes.has(assertion.kind)) failures.push(`media:${assertion.kind}`);
		if (assertion.type === "lineage" && !operations.has(assertion.operation)) failures.push(`lineage:${assertion.operation}`);
	}
	return failures;
}

function collectAssertionFacts(
	value: unknown,
	nodeTypes: Set<string>,
	mediaKinds: Set<string>,
	operations: Set<string>,
): void {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
			try {
				collectAssertionFacts(JSON.parse(trimmed), nodeTypes, mediaKinds, operations);
			} catch {
				// Tool output can contain ordinary text that only resembles JSON.
			}
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectAssertionFacts(item, nodeTypes, mediaKinds, operations);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string") {
			if (["text", "nodeType", "node_type", "nodeKind", "kind", "type"].includes(key) && ["text", "image", "video", "audio", "compose", "director"].includes(item)) {
				nodeTypes.add(item);
				mediaKinds.add(item);
			}
			if (["operation", "tool"].includes(key)) operations.add(item);
		}
		collectAssertionFacts(item, nodeTypes, mediaKinds, operations);
	}
}

export function redactForEvidence(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactForEvidence);
	if (typeof value !== "object" || value === null) return value;
	const output: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (/(authorization|api.?key|secret|password|token|remote.?url)/i.test(key)) continue;
		output[key] = redactForEvidence(item);
	}
	return output;
}

type HttpEvalClientOptions = {
	baseUrl: string;
	canvasBaseUrl?: string;
	userId?: string;
	fetchFn?: typeof fetch;
};

export class HttpEvalClient implements EvalClient {
	private readonly baseUrl: string;
	private readonly canvasBaseUrl: string;
	private readonly userId: string;
	private readonly fetchFn: typeof fetch;
	private readonly canvasVersions = new Map<string, number>();
	private readonly canvasIds = new Map<string, string>();
	private readonly actions = new Map<string, { sessionId: string; canvasVersion: number }>();

	constructor(options: HttpEvalClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/$/, "");
		this.canvasBaseUrl = (options.canvasBaseUrl ?? process.env.VIBEPAPER_EVAL_CANVAS_BASE_URL ?? "http://127.0.0.1:8082").replace(/\/$/, "");
		this.userId = options.userId ?? "990001";
		this.fetchFn = options.fetchFn ?? fetch;
	}

	async createFixture(caseId: string, seedNodes: readonly Record<string, unknown>[] = []): Promise<EvalFixture> {
		const canvasResponse = await this.fetchFn(`${this.canvasBaseUrl}/api/v1/canvases`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-user-id": this.userId },
			body: JSON.stringify({ name: `eval-${caseId}`, description: "Pi Agent 全链路评测夹具" }),
		});
		if (!canvasResponse.ok) throw new Error(`EVAL_FIXTURE_CANVAS_FAILED:${canvasResponse.status}`);
		const canvas = (await canvasResponse.json()) as { id?: string | number; version?: number };
		if (canvas.id === undefined || canvas.id === null) throw new Error("EVAL_FIXTURE_CANVAS_MISSING");
		const canvasId = String(canvas.id);
		let canvasVersion = canvas.version ?? 1;
		const selectedNodeIds: string[] = [];
		for (const [index, node] of seedNodes.entries()) {
			const nodeResponse = await this.fetchFn(`${this.canvasBaseUrl}/api/v1/canvases/${canvasId}/nodes`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-user-id": this.userId,
					"idempotency-key": `eval-${caseId}-seed-${index}`,
				},
				body: JSON.stringify({ ...node, expectedVersion: canvasVersion }),
			});
			if (!nodeResponse.ok) throw new Error(`EVAL_FIXTURE_SEED_FAILED:${nodeResponse.status}`);
			const created = (await nodeResponse.json()) as { id?: string | number };
			if (created.id === undefined || created.id === null) throw new Error("EVAL_FIXTURE_SEED_MISSING");
			selectedNodeIds.push(String(created.id));
			canvasVersion += 1;
		}
		const response = await this.fetchFn(`${this.baseUrl}/api/v1/agent/sessions`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-user-id": this.userId },
			body: JSON.stringify({ title: `eval-${caseId}`, canvasId }),
		});
		if (!response.ok) throw new Error(`EVAL_FIXTURE_FAILED:${response.status}`);
		const payload = (await response.json()) as { sessionId?: string; canvasId?: string };
		if (!payload.sessionId) throw new Error("EVAL_FIXTURE_SESSION_MISSING");
		this.canvasVersions.set(payload.sessionId, canvasVersion);
		this.canvasIds.set(payload.sessionId, payload.canvasId ?? canvasId);
		return {
			caseId,
			sessionId: payload.sessionId,
			canvasId: payload.canvasId ?? canvasId,
			...(selectedNodeIds.length > 0 ? { selectedNodeIds } : {}),
		};
	}

	async sendTurn(fixture: EvalFixture, turn: EvalTurn): Promise<EvalTurnResult> {
		let canvasVersion = turn.canvasVersion ?? this.canvasVersions.get(fixture.sessionId) ?? 0;
		if (turn.canvasVersion === undefined) {
			const refreshed = await this.readCanvasVersion(fixture.sessionId, fixture.canvasId);
			if (refreshed !== undefined) canvasVersion = refreshed;
		}
		const response = await this.fetchFn(`${this.baseUrl}/api/v1/agent/sessions/${fixture.sessionId}/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-user-id": this.userId,
				"idempotency-key": `eval-${fixture.caseId}-${turn.turnId}`,
			},
			body: JSON.stringify({
				content: turn.content,
				canvasId: fixture.canvasId,
				canvasVersion,
				selectedNodeIds: turn.selectedNodeIds ?? fixture.selectedNodeIds ?? [],
				entrypoint: turn.entrypoint,
				canvasDomain: turn.canvasDomain,
			}),
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`EVAL_TURN_FAILED:${response.status}:${text.slice(0, 200)}`);
		const events = parseSse(text);
		const latest = events.at(-1);
		const action = events.find((event) => event.type === "confirmation_required");
		const actionData = action?.data ?? {};
		const errorEvent = events.find((event) => event.type === "run_failed" || event.type === "run_aborted");
		const eventData = errorEvent?.data ?? {};
		const observedCanvasVersion = latestCanvasVersion(events);
		if (observedCanvasVersion !== undefined) this.canvasVersions.set(fixture.sessionId, observedCanvasVersion);
		const actionId = stringValue(actionData.actionId);
		if (actionId) this.actions.set(actionId, {
			sessionId: fixture.sessionId,
			canvasVersion: integerValue(actionData.canvasVersion) ?? observedCanvasVersion ?? turn.canvasVersion ?? this.canvasVersions.get(fixture.sessionId) ?? 0,
		});
		return {
			turnId: turn.turnId,
			requestId: response.headers.get("x-request-id") ?? `eval-request-${turn.turnId}`,
			runId: latest?.runId ?? "unknown",
			status: latest?.type === "confirmation_required" ? "waiting_confirmation" : latest?.type === "run_aborted" ? "aborted" : latest?.type === "run_failed" ? "failed" : "completed",
			actionId,
			confirmationToken: stringValue(actionData.approvalToken),
			errorCode: stringValue(eventData.errorCode),
			events,
		};
	}

	async confirm(actionId: string, token: string, accept: boolean): Promise<void> {
		const action = this.actions.get(actionId);
		if (!action) throw new Error(`EVAL_CONFIRMATION_NOT_FOUND:${actionId}`);
		const response = await this.fetchFn(`${this.baseUrl}/api/v1/agent/sessions/${action.sessionId}/confirmations/${actionId}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-user-id": this.userId },
			body: JSON.stringify({ approvalToken: token, accept, canvasVersion: action.canvasVersion }),
		});
		if (!response.ok) throw new Error(`EVAL_CONFIRM_FAILED:${response.status}`);
		this.actions.delete(actionId);
	}

	async *resumeEvents(sessionId: string, afterSeq: number): AsyncIterable<EvalEventEnvelope> {
		const response = await this.fetchFn(`${this.baseUrl}/api/v1/agent/sessions/${sessionId}/events?afterSeq=${afterSeq}`, {
			headers: { "x-user-id": this.userId, accept: "text/event-stream" },
		});
		if (!response.ok) throw new Error(`EVAL_RESUME_FAILED:${response.status}`);
		const events = parseSse(await response.text());
		const observedCanvasVersion = latestCanvasVersion(events);
		if (observedCanvasVersion !== undefined) this.canvasVersions.set(sessionId, observedCanvasVersion);
		const canvasId = this.canvasIds.get(sessionId);
		if (canvasId) {
			const hasTerminalTaskEvent = events.some(
				(event) => event.type === "task_status" && ["succeeded", "failed", "cancelled", "expired", "settlement_error"].includes(String(event.data.status)),
			);
			let previousVersion: number | undefined;
			for (let attempt = 0; attempt < (hasTerminalTaskEvent ? 6 : 1); attempt += 1) {
				if (attempt > 0 || hasTerminalTaskEvent) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
				const version = await this.readCanvasVersion(sessionId, canvasId);
				if (version !== undefined && version === previousVersion) break;
				previousVersion = version;
			}
		}
		for (const event of events) yield event;
	}

	private async readCanvasVersion(sessionId: string, canvasId: string): Promise<number | undefined> {
		const response = await this.fetchFn(`${this.canvasBaseUrl}/api/v1/canvases/${canvasId}`, {
			headers: { "x-user-id": this.userId },
		});
		if (!response.ok) return undefined;
		let canvas: { version?: number };
		try {
			canvas = (await response.json()) as { version?: number };
		} catch {
			return undefined;
		}
		const version = integerValue(canvas.version ?? (canvas as { canvas?: { version?: unknown } }).canvas?.version);
		if (version !== undefined) this.canvasVersions.set(sessionId, version);
		return version;
	}
}

export function parseSse(text: string): EvalEventEnvelope[] {
	return text
		.split(/\r?\n\r?\n/)
		.map((block) => block.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice(6))
		.filter((value): value is string => value !== undefined)
		.flatMap((value) => {
			try {
				return [JSON.parse(value) as EvalEventEnvelope];
			} catch {
				return [];
			}
		});
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function latestCanvasVersion(events: readonly EvalEventEnvelope[]): number | undefined {
	let latest: number | undefined;
	for (const event of events) collectCanvasVersion(event.data, (version) => {
		if (latest === undefined || version > latest) latest = version;
	});
	return latest;
}

function collectCanvasVersion(value: unknown, onVersion: (version: number) => void): void {
	if (Array.isArray(value)) {
		for (const item of value) collectCanvasVersion(item, onVersion);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [key, item] of Object.entries(value)) {
		if (key === "canvasVersion") {
			const version = integerValue(item);
			if (version !== undefined) onVersion(version);
		}
		collectCanvasVersion(item, onVersion);
	}
}
