import { describe, expect, it } from "vitest";

import {
	InMemoryMemoryCandidateRepository,
	InMemoryMemoryRepository,
	MemoryCandidateService,
	MemoryService,
} from "../src/application/memory-service.ts";

describe("memory candidate pipeline", () => {
	it("deduplicates candidates before they become durable memory", async () => {
		const memory = new MemoryService(new InMemoryMemoryRepository());
		const candidates = new MemoryCandidateService(new InMemoryMemoryCandidateRepository(), memory);
		const input = { userId: "user-1", scope: "long_term" as const, content: "默认使用 9:16 画幅", confidence: 0.9 };
		const first = await candidates.propose(input);
		const second = await candidates.propose(input);
		expect(second.id).toBe(first.id);
		expect(await candidates.listPending("user-1")).toHaveLength(1);
		const saved = await candidates.accept(first.id, "user-1");
		expect(saved.content).toBe(input.content);
		expect(await candidates.listPending("user-1")).toHaveLength(0);
	});

	it("rejects sensitive candidate content", async () => {
		const memory = new MemoryService(new InMemoryMemoryRepository());
		const candidates = new MemoryCandidateService(new InMemoryMemoryCandidateRepository(), memory);
		await expect(
			candidates.propose({ userId: "user-1", scope: "long_term", content: "api_key: secret", confidence: 1 }),
		).rejects.toThrow("SENSITIVE_MEMORY_REJECTED");
	});
});
