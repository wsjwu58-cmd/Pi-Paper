import type { Agent, AgentEvent, AgentMessage, AgentOptions, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";

import type { ServiceConfig } from "../config.ts";
import type { DramaStateStore } from "../domain/drama-state.ts";
import type { AgentProfile } from "../domain/tool-manifest.ts";
import type { SessionContext } from "../domain/session-context.ts";
import { createDramaAgent } from "../pi/drama-agent.ts";
import { createLoadSkillTool, type LoadedSkillResource } from "../tools/skill-tools.ts";
import { compactContext } from "./context-compaction-service.ts";
import { resolveInstructionPrecedence } from "./instruction-precedence.ts";
import { composeUserContent, type NodeReferenceSnapshot, nodeReferencesFromMeta } from "./node-reference-context.ts";

// A drama-planning turn can legitimately make several read/write tool calls
// before the model returns its final acknowledgement.  90 seconds truncated
// real short-drama plans mid-workflow; retain a bounded timeout while allowing
// the complete planning phase to finish.
const MODEL_TURN_TIMEOUT_MS = 240_000;

export interface StoredAgentMessage {
	role: "user" | "assistant" | "system";
	content: string;
	meta: Record<string, unknown>;
	createdAt: Date;
}

export interface AgentTurnEvent {
	type: "thinking" | "assistant_message" | "tool_started" | "tool" | "tool_retry" | "usage" | "error";
	content?: string;
	toolName?: string;
	details?: unknown;
	totalTokens?: number;
	errorCode?: string;
	ok?: boolean;
}

export interface AgentRuntimeHooks {
	onAgent?: (agent: Agent) => void;
	onEvent?: (event: AgentTurnEvent) => void | Promise<void>;
	runtimeTools?: AgentTool[];
	profile?: AgentProfile;
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	shouldStopAfterTurn?: NonNullable<AgentOptions["shouldStopAfterTurn"]>;
	modelId?: string;
	memoryContext?: string;
	sessionContext?: SessionContext;
	intentContext?: string;
	/** Force the first model request to make one verified low-risk tool call. */
	requiredToolName?: string;
}

export interface AgentSkillContext {
	indexLines: readonly string[];
	skills: readonly LoadedSkillResource[];
	loadedSkillIds: readonly string[];
	loadedSkills: readonly LoadedSkillResource[];
	onLoad(skill: LoadedSkillResource): Promise<void>;
}

const MAX_REHYDRATED_SKILLS = 4;
const MAX_REHYDRATED_SKILL_CHARACTERS = 1_200;

export function rehydratedSkillInstructions(skills: readonly LoadedSkillResource[]): string | undefined {
	const visible = skills.slice(0, MAX_REHYDRATED_SKILLS).map((skill) => {
		const instructions = skill.instructions.trim().slice(0, MAX_REHYDRATED_SKILL_CHARACTERS);
		return `【已加载 Skill：${skill.name}】\n${instructions}`;
	});
	return visible.length > 0 ? `以下 Skill 已在此前轮次加载，必须遵循其方法论：\n${visible.join("\n\n")}` : undefined;
}

export function agnesModel(config: ServiceConfig, modelId = config.llmModel): Model<"openai-completions"> {
	return {
		id: modelId,
		name: modelId,
		api: "openai-completions",
		provider: "agnes",
		baseUrl: config.llmBaseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

export async function runDramaTurn(
	config: ServiceConfig,
	store: DramaStateStore,
	sessionId: string,
	history: readonly StoredAgentMessage[],
	content: string,
	skillContext: AgentSkillContext,
	nodeReferences: readonly NodeReferenceSnapshot[] = [],
	hooks: AgentRuntimeHooks = {},
): Promise<{ events: AgentTurnEvent[]; assistantText: string; totalTokens: number }> {
	if (!config.llmApiKey) {
		throw new AgentRuntimeError("MODEL_UNAVAILABLE", "未配置 VIBEPAPER_LLM_API_KEY 或 VIBEPAPER_AGNES_API_KEY");
	}
	const compacted = compactContext(
		history.map((message, sourceIndex) => ({
			role: message.role,
			content: message.content,
			meta: message.meta,
			sourceIndex,
		})),
		{ maxTokens: 24_000, sessionContext: hooks.sessionContext },
	);
	const recentIndexes = new Set(compacted.recentMessages.map((message) => message.sourceIndex));
	const initialMessages: AgentMessage[] = [];
	for (const [index, message] of history.entries()) {
		if (!recentIndexes.has(index)) continue;
		if (message.role === "user") {
			initialMessages.push({
				role: "user",
				content: [
					{ type: "text", text: composeUserContent(message.content, nodeReferencesFromMeta(message.meta)) },
				],
				timestamp: message.createdAt.getTime(),
			});
		}
		if (message.role === "assistant") {
			const assistant: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: message.content }],
				api: "openai-completions",
				provider: "agnes",
				model: hooks.modelId ?? config.llmModel,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: message.createdAt.getTime(),
			};
			initialMessages.push(assistant);
		}
	}
	const protectedFacts =
		compacted.protectedFacts.length > 0
			? `受保护业务事实（不可被模型删除）：\n${compacted.protectedFacts.join("\n")}`
			: undefined;
	const orderedInstructions = resolveInstructionPrecedence([
		{ source: "confirmed-fact", text: protectedFacts ?? "" },
		{ source: "skill", text: rehydratedSkillInstructions(skillContext.loadedSkills) ?? "" },
		{
			source: "profile-default",
			text:
				skillContext.indexLines.length > 0
					? `可用 Skill 索引（正文未预载）：\n${skillContext.indexLines.join("\n")}`
					: "",
		},
	]);
	const agent = createDramaAgent(store, {
		initialState: { model: agnesModel(config, hooks.modelId), messages: initialMessages },
		streamFn: hooks.requiredToolName ? forceInitialToolCall(hooks.requiredToolName) : streamSimple,
		sessionId,
		getApiKey: async (provider) => (provider === "agnes" ? config.llmApiKey : undefined),
		systemPromptSuffix:
			[
				compacted.summary ? `会话压缩摘要：${compacted.summary}` : undefined,
				...orderedInstructions,
				hooks.intentContext,
				hooks.memoryContext,
			]
				.filter(Boolean)
				.join("\n\n") || undefined,
		extraTools: createLoadSkillTool(skillContext.skills, skillContext.loadedSkillIds, skillContext.onLoad),
		runtimeTools: hooks.runtimeTools,
		profile: hooks.profile,
		transformContext: hooks.transformContext,
		shouldStopAfterTurn: hooks.shouldStopAfterTurn,
	});
	hooks.onAgent?.(agent);
	const events: AgentTurnEvent[] = [];
	let assistantText = "";
	let totalTokens = 0;
	agent.subscribe(async (event) => {
		const before = events.length;
		captureEvent(
			event,
			events,
			(text) => {
				assistantText = text;
			},
			(tokens) => {
				totalTokens += tokens;
			},
		);
		if (hooks.onEvent) {
			for (const captured of events.slice(before)) await hooks.onEvent(captured);
		}
	});
	await awaitAgentTurn(
		agent.prompt(composeUserContent(content, nodeReferences)),
		() => agent.abort(),
		MODEL_TURN_TIMEOUT_MS,
	);
	return { events, assistantText, totalTokens };
}

/**
 * The upstream Agent loop does not expose toolChoice. Keep that contract
 * untouched and wrap the VibePaper model stream instead. Only the first
 * request is forced; follow-up turns can consume the tool result naturally.
 */
export function forceInitialToolCall(
	toolName: string,
	stream: typeof streamSimple = streamSimple,
): typeof streamSimple {
	let firstRequest = true;
	return (model, context, options) => {
		const toolChoice: SimpleStreamOptions["toolChoice"] = firstRequest
			? ({ type: "function", function: { name: toolName } } as unknown as SimpleStreamOptions["toolChoice"])
			: options?.toolChoice;
		firstRequest = false;
		return stream(model, context, { ...options, toolChoice });
	};
}

export function awaitAgentTurn<T>(turn: Promise<T>, abort: () => void, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeout = setTimeout(() => {
			abort();
			reject(new AgentRuntimeError("MODEL_TIMEOUT", "文本模型响应超时"));
		}, timeoutMs);
		void turn.then(resolve, reject).finally(() => clearTimeout(timeout));
	});
}

export function captureEvent(
	event: AgentEvent,
	events: AgentTurnEvent[],
	setAssistantText: (text: string) => void,
	setTotalTokens: (tokens: number) => void,
): void {
	if (event.type === "message_update" && event.message.role === "assistant") {
		const thinking = thinkingText(event.message);
		if (thinking) events.push({ type: "thinking", content: thinking });
		const text = sanitizeAgentReply(contentText(event.message));
		if (text) events.push({ type: "assistant_message", content: text });
		return;
	}
	if (event.type === "message_end" && event.message.role === "assistant") {
		const text = sanitizeAgentReply(contentText(event.message));
		const assistant = event.message as AssistantMessage;
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			events.push({
				type: "error",
				content: assistant.errorMessage ?? (assistant.stopReason === "aborted" ? "运行已停止" : "模型调用失败"),
				errorCode: assistant.stopReason === "aborted" ? "RUN_ABORTED" : "MODEL_UNAVAILABLE",
			});
		} else {
			setAssistantText(text);
			if (text) events.push({ type: "assistant_message", content: text });
		}
		const usage = event.message.usage;
		if (usage) {
			setTotalTokens(usage.totalTokens);
			events.push({ type: "usage", totalTokens: usage.totalTokens });
		}
		return;
	}
	if (event.type === "tool_execution_start") {
		events.push({ type: "tool_started", toolName: event.toolName, details: event.args });
		return;
	}
	if (event.type === "tool_execution_update") {
		const details = event.partialResult.details;
		if (isRetryUpdate(details)) events.push({ type: "tool_retry", toolName: event.toolName, details });
		return;
	}
	if (event.type === "tool_execution_end") {
		events.push({
			type: "tool",
			toolName: event.toolName,
			details: event.result,
			ok: !event.isError,
			...(event.isError ? { errorCode: toolErrorCode(event.result) } : {}),
		});
	}
}

export function sanitizeAgentReply(content: string): string {
	return (
		content
			.replace(
				/[，,;；]?\s*(?:节点|任务|会话|画布)?\s*(?:ID|id|nodeId|taskId|sessionId|canvasId)\s*[:：]?\s*[`"']?[A-Za-z0-9_-]{6,}[`"']?/gi,
				"",
			)
			.replace(/(?:节点|任务|会话|画布)\s*[`"']?\d{6,}[`"']?/gi, "")
			.replace(/(?:审校|报告|结果)\s*\/\s*\d{6,}/gi, "")
			// Snowflake identifiers can appear as bare cells in a status table,
			// without the nearby "节点 ID" label. They are still implementation
			// details and must never reach the user-facing Agent reply.
			.replace(/\b\d{15,}\b/g, "")
			.replace(/[，,;；]?\s*(?:并)?\s*(?:调用|使用)\s*[`"']?[a-z][a-z0-9_]{2,}[`"']?/gi, "")
			// Agent replies are Markdown; retain newlines so headings and dividers
			// continue to render as structure instead of becoming inline text.
			.replace(/[ \t]{2,}/g, " ")
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n[ \t]+/g, "\n")
			.replace(/[，,;；]\s*。/g, "。")
			.trim()
	);
}

function toolErrorCode(result: unknown): string | undefined {
	if (typeof result !== "object" || result === null || Array.isArray(result)) return undefined;
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	for (const item of content) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const text = (item as { text?: unknown }).text;
		if (typeof text !== "string") continue;
		const match = /^\[([A-Z][A-Z0-9_]{2,63})\]\s/.exec(text);
		if (match) return match[1];
		// Tool-schema validation happens before our execute wrapper, so providers
		// return a plain diagnostic instead of the normal [CODE] envelope. It is
		// still terminal for this turn: retrying the exact malformed call only
		// causes a loop and leaves the run in `running`.
		if (/^Validation failed for tool\b/.test(text)) return "INVALID_INPUT";
	}
	return undefined;
}

function contentText(message: AgentMessage): string {
	if (message.role !== "assistant" && message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("");
}

function thinkingText(message: AgentMessage): string {
	if (message.role !== "assistant" || typeof message.content === "string") return "";
	return message.content
		.filter(
			(item): item is Extract<AssistantMessage["content"][number], { type: "thinking" }> => item.type === "thinking",
		)
		.map((item) => item.thinking)
		.join("\n")
		.trim();
}

function isRetryUpdate(details: unknown): details is { retrying: true; attempt: number; maxAttempts: number } {
	return (
		typeof details === "object" &&
		details !== null &&
		(details as { retrying?: unknown }).retrying === true &&
		typeof (details as { attempt?: unknown }).attempt === "number" &&
		typeof (details as { maxAttempts?: unknown }).maxAttempts === "number"
	);
}

export class AgentRuntimeError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "AgentRuntimeError";
		this.code = code;
	}
}
