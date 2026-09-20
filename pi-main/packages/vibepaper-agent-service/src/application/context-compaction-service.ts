import { extractProtectedFacts } from "../domain/protected-facts.ts";
import { formatSessionContext, type SessionContext } from "../domain/session-context.ts";

export type ContextMessage = { role: string; content: string; meta?: Record<string, unknown>; sourceIndex?: number };
export type CompactedContext = {
	summary: string;
	protectedFacts: readonly string[];
	recentMessages: readonly ContextMessage[];
	tokenEstimate: number;
	state?: SessionContext;
};

export function compactContext(
	messages: readonly ContextMessage[],
	options: { maxTokens: number; sessionContext?: SessionContext; summaryMaxCharacters?: number },
): CompactedContext {
	const protectedFacts = extractProtectedFacts(messages);
	const factTokens = estimate(protectedFacts.join("\n"));
	const summary = options.sessionContext
		? `当前会话权威状态：${formatSessionContext(options.sessionContext, options.summaryMaxCharacters ?? 8_000)}`
		: messages.length > 0
			? `Compacted ${messages.length} messages`
			: "";
	const summaryTokens = estimate(summary);
	const recentMessages: ContextMessage[] = [];
	let remaining = Math.max(0, options.maxTokens - factTokens - summaryTokens);
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const candidate = compactLargeToolResult(messages[index]);
		const messageTokens = estimate(candidate.content);
		if (messageTokens > remaining) continue;
		recentMessages.unshift(candidate);
		remaining -= messageTokens;
	}
	return {
		summary,
		protectedFacts,
		recentMessages,
		tokenEstimate: summaryTokens + factTokens + estimate(recentMessages.map((message) => message.content).join("\n")),
		...(options.sessionContext ? { state: options.sessionContext } : {}),
	};
}

function estimate(value: string): number {
	let weightedCharacters = 0;
	for (const character of value) weightedCharacters += /\p{Script=Han}/u.test(character) ? 2 : 1;
	return Math.ceil(weightedCharacters / 4);
}

function compactLargeToolResult(message: ContextMessage): ContextMessage {
	if (message.role !== "tool" || message.content.length <= 6_000) return message;
	const head = message.content.slice(0, 3_500);
	const tail = message.content.slice(-1_500);
	return {
		...message,
		content: `${head}\n…工具结果已压缩，完整结果应通过原工具重新读取…\n${tail}`,
		meta: { ...message.meta, compacted: true, originalCharacters: message.content.length },
	};
}
