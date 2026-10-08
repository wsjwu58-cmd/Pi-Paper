import { describe, expect, it } from "vitest";
import { RenderBatchService } from "../src/application/render-batch-service.ts";

describe("keyframe-first render batches", () => {
	it("requires accepted keyframes and enforces cost caps before running", async () => {
		const service = new RenderBatchService();
		await expect(
			service.createBatch({
				ownerId: "7",
				canvasId: "c1",
				costCap: 3,
				jobs: [{ shotId: "s1", durationSeconds: 4, keyframeAccepted: false, estimatedCost: 1 }],
			}),
		).rejects.toThrow("KEYFRAME_NOT_ACCEPTED");
		await expect(
			service.createBatch({
				ownerId: "7",
				canvasId: "c1",
				costCap: 1,
				jobs: [
					{ shotId: "s1", durationSeconds: 4, keyframeAccepted: true, estimatedCost: 1 },
					{ shotId: "s2", durationSeconds: 4, keyframeAccepted: true, estimatedCost: 1 },
				],
			}),
		).rejects.toThrow("COST_CAP_EXCEEDED");
	});

	it("tracks partial failure and local reruns without changing unrelated jobs", async () => {
		const service = new RenderBatchService();
		const batch = await service.createBatch({
			ownerId: "7",
			canvasId: "c1",
			costCap: 5,
			jobs: [
				{ shotId: "s1", durationSeconds: 2, keyframeAccepted: true, estimatedCost: 1 },
				{ shotId: "s2", durationSeconds: 5, keyframeAccepted: true, estimatedCost: 1 },
			],
		});
		await service.markJob(batch.id, batch.jobs[0].id, "completed");
		await service.markJob(batch.id, batch.jobs[1].id, "failed");
		expect((await service.get(batch.id)).status).toBe("partial");
		const rerun = await service.rerun(batch.id, batch.jobs[1].id);
		expect(rerun.jobs.find((job) => job.shotId === "s1")?.status).toBe("completed");
		expect(rerun.jobs.find((job) => job.shotId === "s2")?.status).toBe("draft");
	});
});
