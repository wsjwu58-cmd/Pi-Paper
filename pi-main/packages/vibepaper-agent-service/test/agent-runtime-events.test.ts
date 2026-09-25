import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";

import {
	type AgentRuntimeError,
	type AgentTurnEvent,
	awaitAgentTurn,
	captureEvent,
	forceInitialToolCall,
	sanitizeAgentReply,
	sanitizeAssistantMessage,
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

	it("uses Xiaop for legacy provider-branded introductions", () => {
		expect(sanitizeAgentReply("你好！我是 Agnes，由 Sapiens AI 开发的语言模型。")).toBe("你好！我是小P。");
		expect(sanitizeAgentReply("我会使用 agnes-2.5-flash 帮你完成这一步。")).toBe("我会帮你完成这一步。");
	});

	it("removes UUIDs left in legacy assistant replies", () => {
		expect(sanitizeAgentReply("任务已完成：123e4567-e89b-12d3-a456-426614174000。")).toBe("任务已完成：。");
	});

	it("sanitizes Pi assistant text while preserving thinking and tool calls", () => {
		const toolCall = { type: "toolCall", id: "call-1", name: "create_nodes", arguments: { nodes: [] } };
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "保留内部思考块结构" },
				{ type: "text", text: "已整理节点 ID: node_12345678，并调用 get_canvas_summary。" },
				toolCall,
				{ type: "text", text: "我是 Agnes，由 Sapiens AI 开发的语言模型。" },
			],
			timestamp: 123,
		};

		const sanitized = sanitizeAssistantMessage(message);

		expect(sanitized.content).toEqual([
			{ type: "thinking", thinking: "保留内部思考块结构" },
			{ type: "text", text: "已整理。我是小P。" },
			toolCall,
			{ type: "text", text: "" },
		]);
		expect(sanitized).toMatchObject({ role: "assistant", timestamp: 123 });
		expect(message.content[1]).toEqual({ type: "text", text: "已整理节点 ID: node_12345678，并调用 get_canvas_summary。" });
	});

	it("keeps the legacy string-content shape and leaves non-assistant messages untouched", () => {
		const legacy = { role: "assistant", content: "你好！我是 Agnes。" };
		expect(sanitizeAssistantMessage(legacy)).toEqual({ role: "assistant", content: "你好！我是小P。" });

		const userMessage = { role: "user", content: "你好！" };
		expect(sanitizeAssistantMessage(userMessage)).toBe(userMessage);
	});

	it("preserves Markdown paragraph and heading boundaries while sanitizing", () => {
		expect(sanitizeAgentReply("整体架构如下：\n\n---\n\n## 故事圣经\n\n内容完整。")).toBe(
			"整体架构如下：\n\n---\n\n## 故事圣经\n\n内容完整。",
		);
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

	it("preserves provider thinking as a separate execution event", () => {
		const events: AgentTurnEvent[] = [];
		captureEvent(
			{
				type: "message_update",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "先读取画布，再确认生成成本。" },
						{ type: "text", text: "我先检查现有内容。" },
					],
				},
				assistantMessageEvent: {} as never,
			} as unknown as AgentEvent,
			events,
			() => undefined,
			() => undefined,
		);

		expect(events).toEqual([
			{ type: "thinking", content: "先读取画布，再确认生成成本。" },
			{ type: "assistant_message", content: "我先检查现有内容。" },
		]);
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

	it("maps tool-schema validation failures to INVALID_INPUT so a run cannot loop", () => {
		const events: AgentTurnEvent[] = [];
		captureEvent(
			{
				type: "tool_execution_end",
				toolCallId: "tool-3",
				toolName: "delete_nodes",
				isError: true,
				result: {
					content: [{ type: "text", text: 'Validation failed for tool "delete_nodes": nodes must be an array' }],
					details: {},
				},
			} as unknown as AgentEvent,
			events,
			() => undefined,
			() => undefined,
		);

		expect(events[0]).toMatchObject({
			type: "tool",
			toolName: "delete_nodes",
			ok: false,
			errorCode: "INVALID_INPUT",
		});
	});

	it("forces the requested canvas tool only on the initial model request", () => {
		const choices: unknown[] = [];
		const forced = forceInitialToolCall("create_nodes", ((_, __, options) => {
			choices.push(options?.toolChoice);
			return {} as ReturnType<typeof import("@earendil-works/pi-ai").streamSimple>;
		}) as typeof import("@earendil-works/pi-ai").streamSimple);
		forced({} as never, {} as never, {});
		forced({} as never, {} as never, {});
		expect(choices).toEqual([{ type: "function", function: { name: "create_nodes" } }, undefined]);
	});
});
