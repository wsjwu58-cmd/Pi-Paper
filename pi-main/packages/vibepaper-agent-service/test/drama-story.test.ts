import { describe, expect, it } from "vitest";
import { DramaStoryService, InMemoryDramaStoryRepository } from "../src/application/drama-story-service.ts";

describe("drama story facts", () => {
	it("enforces owner scope, revisioned canon and episode/scene order", async () => {
		const service = new DramaStoryService(new InMemoryDramaStoryRepository());
		const bible = await service.createBible({ ownerId: "7", title: "雨夜", canon: "主角寻找失踪的姐姐" });
		await expect(service.getBible(bible.id, "8")).rejects.toThrow("NOT_FOUND");
		const revised = await service.reviseCanon(bible.id, "7", "主角寻找失踪的姐姐，发现线索在旧车站");
		expect(revised.revision).toBe(2);
		const episode = await service.createEpisode({ ownerId: "7", bibleId: bible.id, number: 1, title: "车站" });
		await expect(
			service.createEpisode({ ownerId: "7", bibleId: bible.id, number: 1, title: "重复" }),
		).rejects.toThrow("CONFLICT");
		const scene = await service.createScene({ ownerId: "7", episodeId: episode.id, number: 1, summary: "雨中等待" });
		expect(scene.status).toBe("draft");
	});

	it("tracks continuity facts and foreshadowing without mixing tenants", async () => {
		const service = new DramaStoryService(new InMemoryDramaStoryRepository());
		const bible = await service.createBible({ ownerId: "7", title: "谜案", canon: "钥匙会打开真相" });
		const episode = await service.createEpisode({ ownerId: "7", bibleId: bible.id, number: 1, title: "线索" });
		const scene = await service.createScene({ ownerId: "7", episodeId: episode.id, number: 1, summary: "发现钥匙" });
		const fact = await service.addContinuityFact({ ownerId: "7", sceneId: scene.id, statement: "钥匙在主角手中" });
		const planted = await service.plantForeshadow({
			ownerId: "7",
			sceneId: scene.id,
			clue: "钥匙刻着月亮",
			payoff: "打开地下室",
		});
		expect(await service.listContinuityFacts(scene.id, "7")).toEqual([fact]);
		expect((await service.resolveForeshadow(planted.id, "7")).status).toBe("resolved");
		await expect(service.listContinuityFacts(scene.id, "8")).rejects.toThrow("NOT_FOUND");
	});
});
