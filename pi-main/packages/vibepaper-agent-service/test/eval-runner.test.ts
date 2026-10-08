import { describe, expect, it } from "vitest";

import { type EvalClient, evaluateAssertions, HttpEvalClient, runEvalCase } from "../evals/eval-client.ts";
import type { EvalCase, EvalFixture, EvalTurn, EvalTurnResult } from "../evals/eval-schema.ts";

const evalCase: EvalCase = {
	caseId: "runner-001",
	profile: "canvas-general",
	turns: [
		{ turnId: "turn-1", content: "创建一张图", confirmation: "manual" },
		{ turnId: "turn-2", content: "确认并继续", confirmation: "manual" },
	],
	assertions: [
		{ type: "confirmation", required: true },
		{ type: "task", terminal: true },
		{ type: "node", nodeType: "image" },
		{ type: "media", kind: "image" },
	],
	browserCheckpoints: [],
	tags: ["image", "generate"],
};

class FakeClient implements EvalClient {
	readonly confirmed: Array<[string, string, boolean]> = [];
	readonly fixtures: string[] = [];
	private readonly results = new Map<string, EvalTurnResult>();

	async createFixture(caseId: string) {
		const fixture = { caseId, sessionId: `session-${this.fixtures.length + 1}`, canvasId: "canvas-1" };
		this.fixtures.push(fixture.sessionId);
		return fixture;
	}

	async sendTurn(_fixture: { caseId: string; sessionId: string; canvasId: string }, turn: { turnId: string }) {
		const result: EvalTurnResult = {
			turnId: turn.turnId,
			requestId: `request-${turn.turnId}`,
			runId: `run-${turn.turnId}`,
			actionId: `action-${turn.turnId}`,
			confirmationToken: `token-${turn.turnId}`,
			events: [
				{
					eventId: `event-${turn.turnId}-1`,
					runId: `run-${turn.turnId}`,
					sessionId: "session-1",
					eventSeq: 1,
					type: "confirmation_required",
					runtime: "pi",
					runtimeVersion: "0.1.0",
					data: {},
				},
				{
					eventId: `event-${turn.turnId}-2`,
					runId: `run-${turn.turnId}`,
					sessionId: "session-1",
					eventSeq: 2,
					type: "run_completed",
					runtime: "pi",
					runtimeVersion: "0.1.0",
					data: {},
				},
			],
			status: "completed",
		};
		this.results.set(turn.turnId, result);
		return result;
	}

	async confirm(actionId: string, token: string, accept: boolean) {
		this.confirmed.push([actionId, token, accept]);
	}

	async *resumeEvents(sessionId: string, afterSeq: number) {
		yield {
			eventId: "event-resumed",
			runId: "run-1",
			sessionId,
			eventSeq: afterSeq + 1,
			type: "run_completed" as const,
			runtime: "pi" as const,
			runtimeVersion: "0.1.0",
			data: {},
		};
	}
}

class ModelUnavailableClient implements EvalClient {
	async createFixture(caseId: string): Promise<EvalFixture> {
		return { caseId, sessionId: "session-unavailable", canvasId: "canvas-1" };
	}

	async sendTurn(_fixture: EvalFixture, turn: EvalTurn): Promise<EvalTurnResult> {
		return {
			turnId: turn.turnId,
			requestId: `request-${turn.turnId}`,
			runId: `run-${turn.turnId}`,
			status: "failed",
			errorCode: "MODEL_UNAVAILABLE",
			events: [],
		};
	}

	async confirm() {}

	async *resumeEvents() {}
}

class ExpectedErrorClient implements EvalClient {
	async createFixture(caseId: string): Promise<EvalFixture> {
		return { caseId, sessionId: "session-error", canvasId: "canvas-1" };
	}

	async sendTurn(_fixture: EvalFixture, turn: EvalTurn): Promise<EvalTurnResult> {
		return {
			turnId: turn.turnId,
			requestId: "request-error",
			runId: "run-error",
			status: "failed",
			errorCode: "VERSION_CONFLICT",
			events: [
				{
					eventId: "event-error",
					runId: "run-error",
					sessionId: "session-error",
					eventSeq: 1,
					type: "run_failed",
					runtime: "pi",
					runtimeVersion: "0.1.0",
					data: { errorCode: "VERSION_CONFLICT" },
				},
			],
		};
	}

	async confirm() {}

	async *resumeEvents() {}
}

describe("evaluation runner", () => {
	it("creates an isolated canvas through the public canvas API before the Agent session", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const client = new HttpEvalClient({
			baseUrl: "http://agent.test",
			canvasBaseUrl: "http://canvas.test",
			userId: "990001",
			fetchFn: (async (input, init) => {
				calls.push({ url: String(input), init });
				if (String(input) === "http://canvas.test/api/v1/canvases")
					return new Response(JSON.stringify({ id: "canvas-42", version: 1 }), { status: 200 });
				return new Response(JSON.stringify({ sessionId: "session-42", canvasId: "canvas-42" }), { status: 201 });
			}) as typeof fetch,
		});

		expect(await client.createFixture("public-fixture-001")).toEqual({
			caseId: "public-fixture-001",
			sessionId: "session-42",
			canvasId: "canvas-42",
		});
		expect(calls.map((call) => call.url)).toEqual([
			"http://canvas.test/api/v1/canvases",
			"http://agent.test/api/v1/agent/sessions",
		]);
		expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ canvasId: "canvas-42" });
	});

	it("uses the version returned by canvas creation for the first Agent turn", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const client = new HttpEvalClient({
			baseUrl: "http://agent.test",
			canvasBaseUrl: "http://canvas.test",
			fetchFn: (async (input, init) => {
				calls.push({ url: String(input), init });
				if (String(input) === "http://canvas.test/api/v1/canvases")
					return new Response(JSON.stringify({ id: "canvas-42", version: 7 }), { status: 200 });
				if (String(input) === "http://agent.test/api/v1/agent/sessions")
					return new Response(JSON.stringify({ sessionId: "session-42", canvasId: "canvas-42" }), { status: 201 });
				return new Response(
					"data: " +
						JSON.stringify({
							type: "run_completed",
							runId: "run-1",
							sessionId: "session-42",
							eventSeq: 1,
							data: {},
						}) +
						"\n\n",
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				);
			}) as typeof fetch,
		});

		await client.createFixture("versioned-fixture-001");
		await client.sendTurn(
			{ caseId: "versioned-fixture-001", sessionId: "session-42", canvasId: "canvas-42" },
			{ turnId: "turn-1", content: "创建文本节点", confirmation: "none" },
		);

		const messageCall = calls.find((call) => call.url.endsWith("/messages"));
		expect(JSON.parse(String(messageCall?.init?.body))).toMatchObject({ canvasVersion: 7 });
	});

	it("reads the nested canvas version before the turn after a terminal task", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		let messageCalls = 0;
		const client = new HttpEvalClient({
			baseUrl: "http://agent.test",
			canvasBaseUrl: "http://canvas.test",
			fetchFn: (async (input, init) => {
				const url = String(input);
				calls.push({ url, init });
				if (url === "http://canvas.test/api/v1/canvases")
					return new Response(JSON.stringify({ id: "canvas-42", version: 1 }), { status: 200 });
				if (url === "http://agent.test/api/v1/agent/sessions")
					return new Response(JSON.stringify({ sessionId: "session-42", canvasId: "canvas-42" }), { status: 201 });
				if (url === "http://canvas.test/api/v1/canvases/canvas-42")
					return new Response(JSON.stringify({ canvas: { version: messageCalls > 0 ? 7 : 1 } }), { status: 200 });
				if (url.endsWith("/messages")) {
					messageCalls += 1;
					return new Response(
						`data: ${JSON.stringify({ type: "task_status", runId: `run-${messageCalls}`, sessionId: "session-42", eventSeq: 1, data: { status: "succeeded" } })}\n\n`,
						{ status: 200 },
					);
				}
				throw new Error(`unexpected test URL: ${url}`);
			}) as typeof fetch,
		});

		const fixture = await client.createFixture("nested-version-001");
		await client.sendTurn(fixture, { turnId: "turn-1", content: "生成图片", confirmation: "none" });
		await client.sendTurn(fixture, { turnId: "turn-2", content: "继续生成视频", confirmation: "none" });

		const secondMessage = calls.filter((call) => call.url.endsWith("/messages"))[1];
		expect(JSON.parse(String(secondMessage?.init?.body))).toMatchObject({ canvasVersion: 7 });
	});

	it("confirms with the canvas version returned by a write tool event", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const client = new HttpEvalClient({
			baseUrl: "http://agent.test",
			canvasBaseUrl: "http://canvas.test",
			fetchFn: (async (input, init) => {
				const url = String(input);
				calls.push({ url, init });
				if (url === "http://canvas.test/api/v1/canvases")
					return new Response(JSON.stringify({ id: "canvas-42", version: 1 }), { status: 200 });
				if (url === "http://agent.test/api/v1/agent/sessions")
					return new Response(JSON.stringify({ sessionId: "session-42", canvasId: "canvas-42" }), { status: 201 });
				if (url.endsWith("/messages")) {
					const events = [
						{
							type: "tool_completed",
							runId: "run-1",
							sessionId: "session-42",
							eventSeq: 1,
							data: { tool: "create_nodes", details: { canvasVersion: 4 } },
						},
						{
							type: "confirmation_required",
							runId: "run-1",
							sessionId: "session-42",
							eventSeq: 2,
							data: { actionId: "action-1", approvalToken: "token-1", canvasVersion: 4 },
						},
					];
					return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
						status: 200,
					});
				}
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}) as typeof fetch,
		});

		const fixture = await client.createFixture("confirmation-version-001");
		const result = await client.sendTurn(fixture, { turnId: "turn-1", content: "生成图片", confirmation: "manual" });
		await client.confirm(result.actionId!, result.confirmationToken!, true);

		const confirm = calls.find((call) => call.url.endsWith("/confirmations/action-1"));
		expect(JSON.parse(String(confirm?.init?.body))).toMatchObject({ canvasVersion: 4 });
	});

	it("runs ordered turns, confirms actions, resumes events, and redacts evidence", async () => {
		const client = new FakeClient();
		const result = await runEvalCase(client, evalCase, { confirm: true, resumeAfterSeq: 1 });

		expect(client.fixtures).toEqual(["session-1"]);
		expect(client.confirmed).toEqual([
			["action-turn-1", "token-turn-1", true],
			["action-turn-2", "token-turn-2", true],
		]);
		expect(result.turns.map((turn) => turn.turnId)).toEqual(["turn-1", "turn-2"]);
		expect(result.resumedEvents).toHaveLength(2);
		expect(JSON.stringify(result)).not.toContain("Authorization");
	});

	it("waits for a confirmed task terminal event before advancing to the next turn", async () => {
		const result = await runEvalCase(new FakeClient(), evalCase, { confirm: true });

		expect(result.resumedEvents).toHaveLength(2);
	});

	it("creates a new fixture when the same case is run again", async () => {
		const client = new FakeClient();
		await runEvalCase(client, evalCase, { confirm: false });
		await runEvalCase(client, evalCase, { confirm: false });

		expect(client.fixtures).toEqual(["session-1", "session-2"]);
	});

	it("fails a case when its declared event or node contract is not observed", async () => {
		const result = await runEvalCase(
			new FakeClient(),
			{
				...evalCase,
				caseId: "runner-contract-001",
				assertions: [
					{ type: "event", eventType: "task_status" },
					{ type: "node", nodeType: "video" },
				],
				tags: ["audit"],
			},
			{ confirm: false },
		);

		expect(result.status).toBe("failed");
		expect(result.assertionFailures).toEqual(expect.arrayContaining(["event:task_status", "node:video"]));
	});

	it("extracts node and operation facts from nested tool output JSON", () => {
		const failures = evaluateAssertions(
			[
				{ type: "node", nodeType: "video" },
				{ type: "lineage", operation: "request_render_audit" },
			],
			[
				{
					turnId: "turn-1",
					requestId: "request-1",
					runId: "run-1",
					status: "completed",
					events: [
						{
							eventId: "event-1",
							runId: "run-1",
							sessionId: "session-1",
							eventSeq: 1,
							type: "tool_completed",
							runtime: "pi",
							runtimeVersion: "0.1.0",
							data: {
								tool: "request_render_audit",
								details: { content: [{ type: "text", text: JSON.stringify({ id: "node-1", type: "video" }) }] },
							},
						},
					],
				},
			],
			[],
		);
		expect(failures).toEqual([]);
	});

	it("marks an all-model-unavailable run as externally blocked", async () => {
		const result = await runEvalCase(new ModelUnavailableClient(), {
			...evalCase,
			caseId: "runner-external-001",
		});

		expect(result.status).toBe("blocked_external");
	});

	it("treats a declared expected error as a passing negative case", async () => {
		const result = await runEvalCase(new ExpectedErrorClient(), {
			...evalCase,
			caseId: "runner-expected-error-001",
			turns: [
				{ turnId: "turn-1", content: "刷新后重试", confirmation: "none" },
				{ turnId: "turn-2", content: "继续", confirmation: "none" },
			],
			assertions: [
				{ type: "error", code: "VERSION_CONFLICT" },
				{ type: "event", eventType: "run_failed" },
			],
			tags: ["negative"],
		});

		expect(result.status).toBe("passed");
	});
});
