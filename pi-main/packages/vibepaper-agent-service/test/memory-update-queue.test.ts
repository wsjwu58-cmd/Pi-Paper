import { describe, expect, it } from "vitest";

import {
	InMemoryMemoryUpdateQueue,
	MemoryUpdateWorker,
} from "../src/application/memory-update-queue.ts";
import {
	InMemoryMemoryCandidateRepository,
	InMemoryMemoryRepository,
	MemoryCandidateService,
	MemoryService,
} from "../src/application/memory-service.ts";

describe("asynchronous memory update queue", () => {
	it("persists queued candidates without blocking the caller", async () => {
		const memory = new MemoryService(new InMemoryMemoryRepository());
		const candidates = new MemoryCandidateService(new InMemoryMemoryCandidateRepository(), memory);
		const queue = new InMemoryMemoryUpdateQueue();
		const worker = new MemoryUpdateWorker(queue, candidates);
		worker.start();
		await queue.enqueue({
			userId: "user-1",
			scope: "long_term",
			content: "偏好冷色调",
			confidence: 0.95,
			persist: true,
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		await worker.stop();
		expect(await memory.search({ userId: "user-1", query: "冷色调", topK: 5 })).toHaveLength(1);
	});
});
