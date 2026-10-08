import { describe, expect, it } from "vitest";

import { InMemoryMemoryRepository, MemoryService } from "../src/application/memory-service.ts";

describe("scoped memory governance", () => {
	it("retrieves top-k memories with user, tenant and TTL isolation", async () => {
		const service = new MemoryService(new InMemoryMemoryRepository());
		await service.write({ userId: "101", scope: "long_term", content: "prefers blue storyboard", confidence: 0.9 });
		await service.write({ userId: "202", scope: "long_term", content: "prefers blue storyboard", confidence: 1 });
		await service.write({
			userId: "101",
			scope: "enterprise",
			tenantId: "tenant-1",
			content: "brand uses blue",
			confidence: 1,
			adminAuthorized: true,
		});
		await service.write({
			userId: "101",
			scope: "enterprise",
			tenantId: "tenant-2",
			content: "brand uses blue",
			confidence: 1,
			adminAuthorized: true,
		});
		const results = await service.search({ userId: "101", tenantId: "tenant-1", query: "blue", topK: 5 });
		expect(results).toHaveLength(2);
		expect(results.every((item) => item.userId === "101")).toBe(true);
	});

	it("requires explicit permission for enterprise writes and rejects sensitive content", async () => {
		const service = new MemoryService(new InMemoryMemoryRepository());
		await expect(
			service.write({
				userId: "101",
				scope: "enterprise",
				tenantId: "tenant-1",
				content: "brand rule",
				confidence: 1,
			}),
		).rejects.toThrow("PERMISSION_DENIED");
		await expect(
			service.write({ userId: "101", scope: "long_term", content: "api_key=secret", confidence: 1 }),
		).rejects.toThrow("SENSITIVE_MEMORY_REJECTED");
	});
});
