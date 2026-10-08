import { describe, expect, it } from "vitest";

import { InMemorySessionRepository, SessionService } from "../src/application/session-service.ts";

describe("session lifecycle", () => {
	it("paginates stable owner-scoped sessions and supports search", async () => {
		const repository = new InMemorySessionRepository();
		const service = new SessionService(repository);
		await service.create({ id: "s1", userId: "101", canvasId: "301", title: "Storyboard", updatedAt: 3 });
		await service.create({ id: "s2", userId: "101", canvasId: "301", title: "Notes", updatedAt: 2 });
		await service.create({ id: "s3", userId: "202", canvasId: "301", title: "Storyboard", updatedAt: 1 });
		const page = await service.list("101", { limit: 1 });
		expect(page.items).toHaveLength(1);
		expect(page.nextCursor).toBeDefined();
		expect((await service.list("101", { limit: 10, cursor: page.nextCursor, search: "notes" })).items).toHaveLength(
			1,
		);
	});

	it("soft deletes, archives and copies explicitly to another canvas", async () => {
		const service = new SessionService(new InMemorySessionRepository());
		await service.create({ id: "s1", userId: "101", canvasId: "301", title: "Original", updatedAt: 1 });
		await service.rename("s1", "101", "Renamed");
		await service.archive("s1", "101");
		const copy = await service.copyToCanvas("s1", "101", "302");
		expect(copy.canvasId).toBe("302");
		await service.remove("s1", "101");
		expect((await service.list("101", { limit: 10 })).items.map((item) => item.id)).toEqual([copy.id]);
	});
});
