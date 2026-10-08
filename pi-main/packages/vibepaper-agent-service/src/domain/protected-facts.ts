export type ProtectedFact = {
	category: "approval" | "task" | "canon" | "cost" | "other";
	value: string;
};

export function extractProtectedFacts(
	messages: readonly { content: string; meta?: Record<string, unknown> }[],
): string[] {
	const facts = new Set<string>();
	for (const message of messages) {
		if (typeof message.meta?.protectedFact === "string" && message.meta.protectedFact.trim())
			facts.add(message.meta.protectedFact.trim());
		for (const match of message.content.match(
			/(?:canon revision|estimated cost|pending approval|task-[\w-]+\s+(?:succeeded|failed|cancelled|expired))[^\n]*/gi,
		) ?? [])
			facts.add(match.trim());
	}
	return [...facts];
}
