import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";

import {
	type AgentRuntimeError,
	type AgentTurnEvent,
	awaitAgentTurn,
	captureEvent,
	forceInitialToolCall,
	sanitizeAgentReply,
} from "../src/application/agent-runtime.ts";

describe("Pi runtime event mapping", () => {
	it("removes implementation identifiers and tool names from user-facing replies", () => {
		expect(sanitizeAgentReply("已创建图片节点，节点 ID：219726203383320577，并调用 create_nodes。")).toBe(
			"已创建图片节点。",
		);
		expect(sanitizeAgentReply("镜头一（节点 219726203383320577）已完成，审校 / 352679957446524928：通过。")).toBe(
			"镜头一（）已完成，：通过。",
		);
		expect(sanitizeAgentReply("Shot 1\t220099587095007232\t雨夜车内\tfailed")).toBe("Shot 1 雨夜车内\tfailed");
	});

	it("emits assistant text deltas and tool lifecycle events", () => {
		const events: AgentTurnEvent[] = [];
		captureEvent(
			{
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
				assistantMessageEvent: {} as never,
			} as unknown as AgentEvent,
			events,
			() => undefined,
			() => undefined,
		);
		captureEvent(
			{ type: "tool_execution_start", toolCallId: "tool-1", toolName: "get_canvas_summary", args: {} } as AgentEvent,
			events,
			() => undefined,
			() => undefined,
		);

		expect(events.map((event) => event.type)).toEqual(["assistant_message", "tool_started"]);
	});

	it("preserves provider abort as a terminal error instead of a successful message", () => {
		const events: AgentTurnEvent[] = [];
		captureEvent(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [],
					stopReason: "aborted",
					errorMessage: "用户停止",
				},
			} as unknown as AgentEvent,
			events,
			() => undefined,
			() => undefined,
		);

		expect(events).toEqual([{ type: "error", content: "用户停止", errorCode: "RUN_ABORTED" }]);
	});

	it("aborts an unresponsive model call and reports MODEL_TIMEOUT", async () => {
		let aborted = false;
		const never = new Promise<void>(() => undefined);

		await expect(
			awaitAgentTurn(
				never,
				() => {
					aborted = true;
				},
				1,
			),
		).rejects.toMatchObject<Partial<AgentRuntimeError>>({ code: "MODEL_TIMEOUT" });
		expect(aborted).toBe(true);
	});

	it("preserves a structured tool error code for the run lifecycle", () => {
		const events: AgentTurnEvent[] = [];
		captureEvent(
			{
				type: "tool_execution_end",
				toolCallId: "tool-2",
				toolName: "submit_generation",
				isError: true,
				result: {
					content: [{ type: "text", text: "[VERSION_CONFLICT] 画布已在其他会话更新，请刷新后重试" }],
					details: {},
				},
			} as unknown as AgentEvent,
			events,
			() => undefined,
			() => undefined,
		);

		expect(events).toEqual([
			{
				type: "tool",
				toolName: "submit_generation",
				details: {
					content: [{ type: "text", text: "[VERSION_CONFLICT] 画布已在其他会话更新，请刷新后重试" }],
					details: {},
				},
				ok: false,
				errorCode: "VERSION_CONFLICT",
			},
		]);
	});

	it("forces the requested canvas tool only on the initial model request", () => {
		const choices: unknown[] = [];
		const forced = forceInitialToolCall(
			"create_nodes",
			((_, __, options) => {
				choices.push(options?.toolChoice);
				return {} as ReturnType<typeof import("@earendil-works/pi-ai").streamSimple>;
			}) as typeof import("@earendil-works/pi-ai").streamSimple,
		);
		forced({} as never, {} as never, {});
		forced({} as never, {} as never, {});
		expect(choices).toEqual([{ type: "function", function: { name: "create_nodes" } }, undefined]);
	});
});
