import type { AgentEvent, AgentOptions, AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	type AgentRuntimeHooks,
	type AgentSkillContext,
	type AgentTurnEvent,
	agnesModel,
	awaitAgentTurn,
	captureEvent,
	forceInitialToolCall,
	runDramaTurn,
	sanitizeAgentReply,
	sanitizeAssistantMessage,
} from "../src/application/agent-runtime.ts";
import type { ServiceConfig } from "../src/config.ts";

describe("Pi runtime event mapping", () => {
	it("sends the documented thinking opt-in only for desktop Agnes runs", async () => {
		const config = {
			llmModel: "agnes-2.5-flash",
			llmBaseUrl: "https://api.agnes.ai/v1",
		} as ServiceConfig;
		let request: unknown;
		const capturePayload = async (enableThinking: boolean) => {
			request = undefined;
			const stream = streamSimple(
				agnesModel(config, config.llmModel, enableThinking),
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				{
					apiKey: "test-key",
					reasoning: enableThinking ? "low" : undefined,
					onPayload: (payload) => {
						request = payload;
						// Stop before the provider request; this test verifies the exact
						// request contract without making a network call.
						throw new Error("REQUEST_CAPTURED");
					},
				},
			);
			await stream.result();
			return request as Record<string, unknown>;
		};

		const desktopRequest = await capturePayload(true);
		expect(desktopRequest).toMatchObject({ chat_template_kwargs: { enable_thinking: true } });
		expect(desktopRequest).not.toHaveProperty("reasoning_effort");

		const legacyWebRequest = await capturePayload(false);
		expect(legacyWebRequest).not.toHaveProperty("chat_template_kwargs");
		expect(legacyWebRequest).not.toHaveProperty("reasoning_effort");
	});

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
		expect(message.content[1]).toEqual({
			type: "text",
			text: "已整理节点 ID: node_12345678，并调用 get_canvas_summary。",
		});
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

	it("classifies desktop connection failures while preserving the legacy Web error code", () => {
		const event = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "Connection error.",
			},
		} as unknown as AgentEvent;
		const desktopEvents: AgentTurnEvent[] = [];
		const webEvents: AgentTurnEvent[] = [];
		const ignore = () => undefined;

		captureEvent(event, desktopEvents, ignore, ignore, true);
		captureEvent(event, webEvents, ignore, ignore);

		expect(desktopEvents[0]).toMatchObject({ type: "error", errorCode: "AGENT_MODEL_CONNECTION_FAILED" });
		expect(webEvents[0]).toMatchObject({ type: "error", errorCode: "MODEL_UNAVAILABLE" });
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
		).rejects.toMatchObject({ code: "MODEL_TIMEOUT" });
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
		const forced = forceInitialToolCall("create_nodes", ((...args: Parameters<typeof streamSimple>) => {
			const [, , options] = args;
			choices.push(options?.toolChoice);
			return {} as ReturnType<typeof streamSimple>;
		}) as typeof streamSimple);
		forced({} as never, {} as never, {});
		forced({} as never, {} as never, {});
		expect(choices).toEqual([{ type: "function", function: { name: "create_nodes" } }, undefined]);
	});

	it("continues a desktop response that was truncated after thinking only", async () => {
		const faux = createFauxRuntime([
			assistantResponse([{ type: "thinking", thinking: "规划中" }], "length"),
			assistantResponse([{ type: "text", text: "故事概览已整理。" }]),
		]);
		const result = await runDesktopTurn(faux.streamFn);

		expect(faux.requests).toHaveLength(2);
		expect(result.assistantText).toBe("故事概览已整理。");
		expect(faux.requests[1]?.filter((message) => message.role === "user")).toHaveLength(2);
		expect(faux.requests[1]?.at(-1)?.text).toContain("上一条尚未完成的回复继续");
		expect(result.events.some((event) => event.type === "error")).toBe(false);
	});

	it("joins partial text with a bounded desktop continuation", async () => {
		const faux = createFauxRuntime([
			assistantResponse([{ type: "text", text: "故事标题" }], "length"),
			assistantResponse([{ type: "text", text: "和主要人物已整理。" }]),
		]);
		const result = await runDesktopTurn(faux.streamFn);

		expect(result.assistantText).toBe("故事标题和主要人物已整理。");
		expect(faux.requests).toHaveLength(2);
	});

	it("preserves word boundaries across truncated reply fragments", async () => {
		const faux = createFauxRuntime([
			assistantResponse([{ type: "text", text: "Hello" }], "length"),
			assistantResponse([{ type: "text", text: " world." }]),
		]);
		const result = await runDesktopTurn(faux.streamFn);
		expect(result.assistantText).toBe("Hello world.");
	});

	it("does not execute a tool call truncated by the provider", async () => {
		const schema = Type.Object({}, { additionalProperties: false });
		let executions = 0;
		const createNodes: AgentTool<typeof schema> = {
			name: "create_nodes",
			label: "创建节点",
			description: "创建节点",
			parameters: schema,
			async execute() {
				executions += 1;
				return { content: [{ type: "text", text: "written" }], details: {} };
			},
		};
		const faux = createFauxRuntime([
			assistantResponse(
				[
					{
						type: "toolCall",
						id: "call-truncated",
						name: "create_nodes",
						arguments: {},
					},
				],
				"length",
			),
			assistantResponse([{ type: "text", text: "已完成。" }]),
		]);
		const result = await runDesktopTurn(faux.streamFn, { runtimeTools: [createNodes] });

		expect(executions).toBe(0);
		expect(faux.requests).toHaveLength(2);
		expect(faux.requests[1]?.at(-1)?.role).toBe("toolResult");
		expect(result.assistantText).toBe("已完成。");
	});

	it("does not replay a completed tool when resuming after a later length response", async () => {
		const schema = Type.Object({}, { additionalProperties: false });
		let executions = 0;
		const createNodes: AgentTool<typeof schema> = {
			name: "create_nodes",
			label: "创建节点",
			description: "创建节点",
			parameters: schema,
			async execute() {
				executions += 1;
				return { content: [{ type: "text", text: "written" }], details: {} };
			},
		};
		const faux = createFauxRuntime([
			assistantResponse(
				[
					{
						type: "toolCall",
						id: "call-complete",
						name: "create_nodes",
						arguments: {},
					},
				],
				"toolUse",
			),
			assistantResponse([{ type: "text", text: "回复开头" }], "length"),
			assistantResponse([{ type: "text", text: "已完成。" }]),
		]);
		const result = await runDesktopTurn(faux.streamFn, { runtimeTools: [createNodes] });

		expect(executions).toBe(1);
		expect(faux.requests).toHaveLength(3);
		expect(result.assistantText).toBe("回复开头已完成。");
	});

	it("honors the caller stop hook before recovering a truncated response", async () => {
		const faux = createFauxRuntime([
			assistantResponse([{ type: "text", text: "等待确认" }], "length"),
			assistantResponse([{ type: "text", text: "不应请求" }]),
		]);
		const shouldStopAfterTurn: NonNullable<AgentRuntimeHooks["shouldStopAfterTurn"]> = () => true;
		const result = await runDesktopTurn(faux.streamFn, { shouldStopAfterTurn });

		expect(faux.requests).toHaveLength(1);
		expect(result.assistantText).toBe("等待确认");
		expect(result.events.some((event) => event.errorCode === "AGENT_MODEL_OUTPUT_LIMIT")).toBe(false);
	});

	it("emits a terminal output-limit error after two continuations", async () => {
		const faux = createFauxRuntime([
			assistantResponse([{ type: "text", text: "一" }], "length"),
			assistantResponse([{ type: "text", text: "二" }], "length"),
			assistantResponse([{ type: "text", text: "三" }], "length"),
		]);
		const result = await runDesktopTurn(faux.streamFn);

		expect(faux.requests).toHaveLength(3);
		expect(result.assistantText).toBe("一二三");
		expect(result.events.at(-1)).toMatchObject({ type: "error", errorCode: "AGENT_MODEL_OUTPUT_LIMIT" });
	});

	it("does not retry a connection failure after an output-limit continuation", async () => {
		const faux = createFauxRuntime([
			assistantResponse([{ type: "thinking", thinking: "规划中" }], "length"),
			assistantResponse([], "error", "Connection error."),
			assistantResponse([{ type: "text", text: "不应重试" }]),
		]);
		const result = await runDesktopTurn(faux.streamFn);

		expect(faux.requests).toHaveLength(2);
		expect(result.events.filter((event) => event.type === "error").at(-1)).toMatchObject({
			type: "error",
			errorCode: "AGENT_MODEL_CONNECTION_FAILED",
		});
	});
});

type ObservedRequestMessage = { role: string; text: string };

function createFauxRuntime(responses: AssistantMessage[]) {
	const requests: ObservedRequestMessage[][] = [];
	let responseIndex = 0;
	const streamFn: AgentOptions["streamFn"] = (_model, context) => {
		requests.push(context.messages.map((message) => ({ role: message.role, text: textContent(message.content) })));
		const response = responses[responseIndex];
		if (!response) throw new Error("FAUX_RESPONSE_MISSING");
		responseIndex += 1;
		const stream = createAssistantMessageEventStream();
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			stream.push({ type: "error", reason: response.stopReason, error: response });
		} else {
			stream.push({
				type: "done",
				reason: response.stopReason as "length" | "stop" | "toolUse",
				message: response,
			});
		}
		return stream;
	};
	return { requests, streamFn };
}

async function runDesktopTurn(
	streamFn: AgentOptions["streamFn"],
	options: Partial<AgentRuntimeHooks> = {},
): Promise<Awaited<ReturnType<typeof runDramaTurn>>> {
	const skillContext: AgentSkillContext = {
		indexLines: [],
		skills: [],
		loadedSkillIds: [],
		loadedSkills: [],
		onLoad: async () => undefined,
	};
	const desktopTurnContext = {
		initialMessages: [],
		currentUserInput: "帮我完成这轮创作。",
		systemPrompt: "测试系统提示词",
		toolSchemas: [],
		extraTools: [],
	};
	return runDramaTurn(
		{
			llmApiKey: "test-key",
			llmBaseUrl: "https://api.example.test/v1",
			llmModel: "agnes-2.5-flash",
		} as ServiceConfig,
		undefined,
		"session-test",
		[],
		"帮我完成这轮创作。",
		skillContext,
		[],
		{
			desktopMode: true,
			profile: "canvas-general",
			desktopTurnContext,
			streamFn,
			...options,
		},
	);
}

function assistantResponse(
	content: AssistantMessage["content"],
	stopReason: "stop" | "length" | "toolUse" | "error" = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "agnes",
		model: "agnes-2.5-flash",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("");
}
