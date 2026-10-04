import type { AgentOptions } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { withModelStreamRetry } from "../src/application/model-stream-retry.ts";

const model: Model<"openai-completions"> = {
	id: "fixture",
	name: "fixture",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function message(error?: string): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		timestamp: 0,
		stopReason: error ? "error" : "stop",
		...(error ? { errorMessage: error } : {}),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
describe("desktop model request retry", () => {
	it("stops after three failed requests", async () => {
		let calls = 0;
		const stream: AgentOptions["streamFn"] = () => {
			calls++;
			const result = createAssistantMessageEventStream();
			result.push({ type: "error", reason: "error", error: message("Connection error") });
			return result;
		};
		const result = await withModelStreamRetry(stream, { baseDelayMs: 1 })(model, { messages: [] });
		expect((await result.result()).stopReason).toBe("error");
		expect(calls).toBe(3);
	});
	it("does not duplicate text after a stream disconnects", async () => {
		let calls = 0;
		const stream: AgentOptions["streamFn"] = () => {
			calls++;
			const result = createAssistantMessageEventStream();
			const partial = { ...message(), content: [{ type: "text" as const, text: "hello" }] };
			result.push({ type: "text_delta", contentIndex: 0, delta: "hello", partial });
			result.push({
				type: "error",
				reason: "error",
				error: { ...partial, stopReason: "error", errorMessage: "Connection error" },
			});
			return result;
		};
		const result = await withModelStreamRetry(stream)(model, { messages: [] });
		expect((await result.result()).content).toEqual([{ type: "text", text: "hello" }]);
		expect(calls).toBe(1);
	});
	for (const failure of ["Connection error", "Model response timeout", "503 Service unavailable", "429 rate limit"]) {
		it(`recovers from ${failure} without exposing failed messages`, async () => {
			let calls = 0;
			const choices: unknown[] = [];
			const stream: AgentOptions["streamFn"] = (_model, _context, options) => {
				choices.push(options?.toolChoice);
				expect(options?.maxRetries).toBe(0);
				const result = createAssistantMessageEventStream();
				result.push({ type: "start", partial: message() });
				if (++calls < 3) result.push({ type: "error", reason: "error", error: message(failure) });
				else result.push({ type: "done", reason: "stop", message: message() });
				return result;
			};
			const result = await withModelStreamRetry(stream, { baseDelayMs: 1 })(
				model,
				{ messages: [] },
				{ toolChoice: "auto" },
			);
			const events = [];
			for await (const event of result) events.push(event.type);
			expect(events).toEqual(["start", "done"]);
			expect(calls).toBe(3);
			expect(choices).toEqual(["auto", "auto", "auto"]);
		});
	}
	for (const failure of ["401 Invalid API key", "insufficient_quota", "404 model not found", "certificate failed"]) {
		it(`does not retry ${failure}`, async () => {
			let calls = 0;
			const stream: AgentOptions["streamFn"] = () => {
				calls++;
				const result = createAssistantMessageEventStream();
				result.push({ type: "error", reason: "error", error: message(failure) });
				return result;
			};
			const result = await withModelStreamRetry(stream, { baseDelayMs: 1 })(model, { messages: [] });
			expect((await result.result()).stopReason).toBe("error");
			expect(calls).toBe(1);
		});
	}
	it("never retries after a tool call starts", async () => {
		let calls = 0;
		const stream: AgentOptions["streamFn"] = () => {
			calls++;
			const result = createAssistantMessageEventStream();
			result.push({ type: "toolcall_start", contentIndex: 0, partial: message() });
			result.push({ type: "error", reason: "error", error: message("Connection error") });
			return result;
		};
		const result = await withModelStreamRetry(stream)(model, { messages: [] });
		expect((await result.result()).stopReason).toBe("error");
		expect(calls).toBe(1);
	});
	it("aborts backoff without sending another request", async () => {
		let calls = 0;
		const controller = new AbortController();
		const stream: AgentOptions["streamFn"] = () => {
			calls++;
			const result = createAssistantMessageEventStream();
			result.push({ type: "error", reason: "error", error: message("Connection error") });
			return result;
		};
		const result = await withModelStreamRetry(stream, { onRetry: () => controller.abort() })(
			model,
			{ messages: [] },
			{ signal: controller.signal },
		);
		expect((await result.result()).stopReason).toBe("aborted");
		expect(calls).toBe(1);
	});
	it("aborts a stalled request before retrying it", async () => {
		let calls = 0;
		const stream: AgentOptions["streamFn"] = (_model, _context, options) => {
			const result = createAssistantMessageEventStream();
			if (++calls === 1)
				options?.signal?.addEventListener(
					"abort",
					() => {
						result.push({ type: "error", reason: "aborted", error: { ...message(), stopReason: "aborted" } });
					},
					{ once: true },
				);
			else result.push({ type: "done", reason: "stop", message: message() });
			return result;
		};
		const result = await withModelStreamRetry(stream, { firstOutputTimeoutMs: 5, baseDelayMs: 1 })(model, {
			messages: [],
		});
		expect((await result.result()).stopReason).toBe("stop");
		expect(calls).toBe(2);
	});
});
