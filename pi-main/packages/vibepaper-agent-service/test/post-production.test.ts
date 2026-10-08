import { describe, expect, it } from "vitest";
import { PostProductionService } from "../src/application/post-production-service.ts";

describe("post-production lineage", () => {
	it("builds Video → TTS → Subtitle → Composite with bounded timing", async () => {
		const service = new PostProductionService();
		const video = service.registerVideo({
			ownerId: "7",
			durationMs: 5000,
			taskId: "task-video",
			lineageIds: ["lineage-1"],
		});
		const tts = await service.createTts({
			ownerId: "7",
			videoId: video.id,
			durationMs: 5000,
			language: "zh-CN",
			voiceId: "voice-1",
			taskId: "task-tts",
		});
		const subtitle = await service.createSubtitle({
			ownerId: "7",
			videoId: video.id,
			durationMs: 5000,
			language: "zh-CN",
			segments: [{ startMs: 0, endMs: 1200, text: "你好" }],
			taskId: "task-sub",
		});
		const composite = await service.createComposite({
			ownerId: "7",
			videoId: video.id,
			ttsId: tts.id,
			subtitleId: subtitle.id,
			taskId: "task-comp",
		});
		expect(composite.status).toBe("accepted");
		expect(composite.lineageIds).toContain(tts.id);
	});

	it("rejects out-of-bounds subtitles, cross-owner reuse and reuses the same lineage", async () => {
		const service = new PostProductionService();
		const video = service.registerVideo({ ownerId: "7", durationMs: 5000, taskId: "task-video", lineageIds: [] });
		await expect(
			service.createSubtitle({
				ownerId: "7",
				videoId: video.id,
				durationMs: 5000,
				language: "en",
				segments: [{ startMs: 4500, endMs: 5100, text: "late" }],
				taskId: "task-sub",
			}),
		).rejects.toThrow("SUBTITLE_OUT_OF_BOUNDS");
		await expect(
			service.createTts({
				ownerId: "8",
				videoId: video.id,
				durationMs: 5000,
				language: "en",
				voiceId: "v",
				taskId: "t",
			}),
		).rejects.toThrow("NOT_FOUND");
		const first = await service.createTts({
			ownerId: "7",
			videoId: video.id,
			durationMs: 5000,
			language: "en",
			voiceId: "v",
			taskId: "t",
		});
		const second = await service.createTts({
			ownerId: "7",
			videoId: video.id,
			durationMs: 5000,
			language: "en",
			voiceId: "v",
			taskId: "t",
		});
		expect(second.id).toBe(first.id);
	});
});
