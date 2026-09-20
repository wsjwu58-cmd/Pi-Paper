import { describe, expect, it } from "vitest";

import { compactContext } from "../src/application/context-compaction-service.ts";

describe("business-fact protected compaction", () => {
	it("retains pending approvals, terminal tasks, canon and cost facts under budget", () => {
		const messages = [
			{ role: "user", content: "old context ".repeat(100), meta: {} },
			{
				role: "system",
				content: "canon revision: 4; estimated cost: 3",
				meta: { protectedFact: "canon revision: 4; estimated cost: 3" },
			},
			{
				role: "assistant",
				content: "waiting confirmation action-1",
				meta: { protectedFact: "pending approval action-1" },
			},
			{ role: "tool", content: "task-1 succeeded", meta: { protectedFact: "task-1 succeeded" } },
		];
		const result = compactContext(messages, { maxTokens: 40 });
		expect(result.protectedFacts).toEqual(
			expect.arrayContaining([
				"canon revision: 4; estimated cost: 3",
				"pending approval action-1",
				"task-1 succeeded",
			]),
		);
		expect(result.tokenEstimate).toBeLessThanOrEqual(40);
	});

	it("keeps a bounded preview for oversized tool results", () => {
		const result = compactContext([{ role: "tool", content: "a".repeat(20_000) }], { maxTokens: 2_000 });
		const message = result.recentMessages[0];
		expect(message?.meta?.compacted).toBe(true);
		expect(message?.content.length).toBeLessThan(6_000);
	});
});
