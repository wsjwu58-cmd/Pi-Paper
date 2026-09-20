import { describe, expect, it } from "vitest";

import {
	DailyMemoryService,
	extractDailyMemory,
	InMemoryDailyMemoryRepository,
} from "../src/application/daily-memory-service.ts";

describe("daily memory", () => {
	it("stores only the current day and deduplicates by canvas", async () => {
		const repository = new InMemoryDailyMemoryRepository();
		const service = new DailyMemoryService(repository, () => new Date("2026-09-20T10:00:00Z"));
		await service.remember({ userId: "user-1", canvasId: "canvas-1", content: "先完成角色设定" });
		await service.remember({ userId: "user-1", canvasId: "canvas-1", content: "先完成角色设定" });
		await service.remember({ userId: "user-1", canvasId: "canvas-2", content: "先完成角色设定" });
		expect(await service.search("user-1", "角色设定", "canvas-1")).toHaveLength(1);
		expect(await service.search("user-1", "角色设定", "canvas-2")).toHaveLength(1);
		expect(await service.search("user-1", "角色设定", "canvas-1", 5, new Date("2026-09-21T10:00:00Z"))).toEqual([]);
	});

	it("extracts transient instructions without promoting them to long-term memory", () => {
		expect(extractDailyMemory("这次：先完成关键帧，再生成视频。"),).toBe("先完成关键帧，再生成视频");
		expect(extractDailyMemory("默认使用 9:16 画幅")).toBeUndefined();
	});
});
