import { nextId } from "../infrastructure/ids.ts";

export type RenderJobStatus = "draft" | "running" | "completed" | "failed";
export type RenderBatchStatus = "draft" | "awaiting_approval" | "running" | "partial" | "completed" | "failed";
export type RenderJobInput = {
	shotId: string;
	durationSeconds: number;
	keyframeAccepted: boolean;
	estimatedCost: number;
};
export type RenderJob = RenderJobInput & { id: string; status: RenderJobStatus; errorCode?: string };
export type RenderBatch = {
	id: string;
	ownerId: string;
	canvasId: string;
	costCap: number;
	status: RenderBatchStatus;
	jobs: readonly RenderJob[];
	estimatedCost: number;
};

export class RenderBatchService {
	private readonly batches = new Map<string, RenderBatch>();

	async createBatch(input: {
		ownerId: string;
		canvasId: string;
		costCap: number;
		jobs: readonly RenderJobInput[];
	}): Promise<RenderBatch> {
		if (input.jobs.length === 0 || input.jobs.length > 90) throw new Error("INVALID_SHOT_COUNT");
		for (const job of input.jobs) {
			if (!job.keyframeAccepted) throw new Error("KEYFRAME_NOT_ACCEPTED");
			if (job.durationSeconds < 2 || job.durationSeconds > 5) throw new Error("INVALID_SHOT_DURATION");
		}
		const estimatedCost = input.jobs.reduce((sum, job) => sum + job.estimatedCost, 0);
		if (!Number.isInteger(input.costCap) || input.costCap < estimatedCost) throw new Error("COST_CAP_EXCEEDED");
		const jobs = input.jobs.map((job) => ({ ...job, id: nextId(), status: "draft" as const }));
		const batch = {
			id: nextId(),
			...input,
			status: estimatedCost > 0 ? ("awaiting_approval" as const) : ("draft" as const),
			jobs,
			estimatedCost,
		};
		this.batches.set(batch.id, batch);
		return batch;
	}

	async get(id: string): Promise<RenderBatch> {
		const batch = this.batches.get(id);
		if (!batch) throw new Error("NOT_FOUND");
		return batch;
	}

	async markJob(batchId: string, jobId: string, status: RenderJobStatus, errorCode?: string): Promise<RenderBatch> {
		const batch = await this.get(batchId);
		if (!batch.jobs.some((job) => job.id === jobId)) throw new Error("NOT_FOUND");
		const jobs = batch.jobs.map((job) =>
			job.id === jobId ? { ...job, status, ...(errorCode ? { errorCode } : {}) } : job,
		);
		const completed = jobs.filter((job) => job.status === "completed").length;
		const failed = jobs.filter((job) => job.status === "failed").length;
		const nextStatus: RenderBatchStatus =
			completed === jobs.length
				? "completed"
				: failed > 0 && completed > 0
					? "partial"
					: failed === jobs.length
						? "failed"
						: "running";
		const updated = { ...batch, jobs, status: nextStatus };
		this.batches.set(batchId, updated);
		return updated;
	}

	async rerun(batchId: string, jobId: string): Promise<RenderBatch> {
		const batch = await this.get(batchId);
		if (!batch.jobs.some((job) => job.id === jobId)) throw new Error("NOT_FOUND");
		const jobs = batch.jobs.map((job) =>
			job.id === jobId ? { ...job, status: "draft" as const, errorCode: undefined } : job,
		);
		const updated = { ...batch, jobs, status: "awaiting_approval" as const };
		this.batches.set(batchId, updated);
		return updated;
	}
}
