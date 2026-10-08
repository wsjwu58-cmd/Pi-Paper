import type { QueryResultRow } from "pg";
import { buildRenderInputHash } from "../domain/render-input-hash.ts";
import { nextId } from "./ids.ts";
import type { MigrationDatabase } from "./migrations.ts";

export type PersistentRenderJob = {
	id: string;
	shotId: string;
	keyframeRenderId: string;
	canvasNodeId?: string;
	durationSeconds: number;
	modelType: string;
	modelParams: Record<string, unknown>;
	estimatedCost: number;
	inputHash: string;
	status: "draft" | "running" | "completed" | "failed";
	taskId?: string;
	errorCode?: string;
};

export type PersistentRenderBatch = {
	id: string;
	ownerId: string;
	canvasId: string;
	seriesId: string;
	episodeNo: number;
	costCap: number;
	estimatedCost: number;
	status: "draft" | "awaiting_approval" | "running" | "partial" | "completed" | "failed";
	sessionId?: string;
	canvasVersion?: number;
	approvalActionId?: string;
	jobs: readonly PersistentRenderJob[];
};

export class RenderBatchError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = "RenderBatchError";
		this.code = code;
	}
}

type BatchRow = QueryResultRow & {
	id: string;
	owner_id: string;
	canvas_id: string;
	series_id: string;
	episode_no: number;
	cost_cap: number;
	estimated_cost: number;
	status: PersistentRenderBatch["status"];
	session_id: string | null;
	canvas_version: number | null;
	approval_action_id: string | null;
};

type JobRow = QueryResultRow & {
	id: string;
	shot_id: string;
	keyframe_render_id: string;
	canvas_node_id: string | null;
	duration_seconds: number;
	model_type: string;
	model_params: unknown;
	estimated_cost: number;
	status: PersistentRenderJob["status"];
	task_id: string | null;
	error_code: string | null;
	input_hash: string;
};

export class PgRenderBatchRepository {
	private readonly database: MigrationDatabase;

	constructor(database: MigrationDatabase) {
		this.database = database;
	}

	async create(input: {
		ownerId: string;
		canvasId: string;
		seriesId: string;
		episodeNo: number;
		costCap: number;
		idempotencyKey: string;
		sessionId?: string;
		canvasVersion?: number;
		jobs: readonly Omit<PersistentRenderJob, "id" | "status" | "inputHash">[];
	}): Promise<PersistentRenderBatch> {
		if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 128)
			throw new RenderBatchError("INVALID_INPUT");
		const replay = await this.findByKey(input.ownerId, input.idempotencyKey);
		if (replay) return replay;
		if (input.jobs.length === 0 || input.jobs.length > 90) throw new RenderBatchError("INVALID_SHOT_COUNT");
		if (!Number.isInteger(input.costCap) || input.costCap < 0) throw new RenderBatchError("INVALID_INPUT");
		const estimatedCost = input.jobs.reduce((sum, job) => sum + job.estimatedCost, 0);
		if (estimatedCost > input.costCap) throw new RenderBatchError("COST_CAP_EXCEEDED");
		const jobs: PersistentRenderJob[] = [];
		for (const job of input.jobs) {
			if (!Number.isInteger(job.durationSeconds) || job.durationSeconds < 2 || job.durationSeconds > 5)
				throw new RenderBatchError("INVALID_SHOT_DURATION");
			if (!Number.isInteger(job.estimatedCost) || job.estimatedCost < 0) throw new RenderBatchError("INVALID_INPUT");
			if (!job.modelType.trim()) throw new RenderBatchError("INVALID_INPUT");
			const inputHash = await this.assertAcceptedKeyframe(
				input.ownerId,
				input.seriesId,
				input.canvasId,
				input.episodeNo,
				job.shotId,
				job.keyframeRenderId,
				job.durationSeconds,
				input.canvasVersion ?? 0,
			);
			jobs.push({ ...job, inputHash, id: nextId(), status: "draft" });
		}
		if (new Set(jobs.map((job) => job.shotId)).size !== jobs.length) throw new RenderBatchError("DUPLICATE_SHOT");
		const batch: PersistentRenderBatch = {
			id: nextId(),
			ownerId: input.ownerId,
			canvasId: input.canvasId,
			seriesId: input.seriesId,
			episodeNo: input.episodeNo,
			costCap: input.costCap,
			estimatedCost,
			status: estimatedCost > 0 ? "awaiting_approval" : "draft",
			sessionId: input.sessionId,
			canvasVersion: input.canvasVersion,
			jobs,
		};
		try {
			await this.database.transaction(async (client) => {
				await client.query(
					`INSERT INTO agent_render_batches
					 (id, owner_id, canvas_id, series_id, episode_no, cost_cap, estimated_cost, status, idempotency_key, session_id, canvas_version)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
					[
						batch.id,
						batch.ownerId,
						batch.canvasId,
						batch.seriesId,
						batch.episodeNo,
						batch.costCap,
						batch.estimatedCost,
						batch.status,
						input.idempotencyKey,
						batch.sessionId ?? null,
						batch.canvasVersion ?? null,
					],
				);
				for (const job of jobs) {
					await client.query(
						`INSERT INTO agent_render_jobs
						 (id, batch_id, owner_id, shot_id, keyframe_render_id, canvas_node_id, duration_seconds, model_type, model_params, estimated_cost, status, input_hash)
						 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)`,
						[
							job.id,
							batch.id,
							batch.ownerId,
							job.shotId,
							job.keyframeRenderId,
							job.canvasNodeId ?? null,
							job.durationSeconds,
							job.modelType,
							JSON.stringify(job.modelParams),
							job.estimatedCost,
							job.status,
							job.inputHash,
						],
					);
				}
			});
		} catch (error) {
			if (isUniqueViolation(error)) {
				const existing = await this.findByKey(input.ownerId, input.idempotencyKey);
				if (existing) return existing;
			}
			throw error;
		}
		return batch;
	}

	async get(batchId: string, ownerId: string): Promise<PersistentRenderBatch> {
		const result = await this.database.query<BatchRow>(
			"SELECT id, owner_id, canvas_id, series_id, episode_no, cost_cap, estimated_cost, status, session_id, canvas_version, approval_action_id FROM agent_render_batches WHERE id = $1 AND owner_id = $2",
			[batchId, ownerId],
		);
		if (!result.rows[0]) throw new RenderBatchError("NOT_FOUND");
		return await this.withJobs(result.rows[0]);
	}

	async list(ownerId: string): Promise<readonly PersistentRenderBatch[]> {
		const result = await this.database.query<BatchRow>(
			"SELECT id, owner_id, canvas_id, series_id, episode_no, cost_cap, estimated_cost, status, session_id, canvas_version, approval_action_id FROM agent_render_batches WHERE owner_id = $1 ORDER BY created_at DESC, id DESC",
			[ownerId],
		);
		return await Promise.all(result.rows.map((row) => this.withJobs(row)));
	}

	async markJob(input: {
		batchId: string;
		ownerId: string;
		jobId: string;
		status: PersistentRenderJob["status"];
		taskId?: string;
		errorCode?: string;
	}): Promise<PersistentRenderBatch> {
		await this.database.transaction(async (client) => {
			const batch = await client.query<{ id: string }>(
				"SELECT id FROM agent_render_batches WHERE id = $1 AND owner_id = $2 FOR UPDATE",
				[input.batchId, input.ownerId],
			);
			if (!batch.rows[0]) throw new RenderBatchError("NOT_FOUND");
			const updated = await client.query<{ id: string }>(
				`UPDATE agent_render_jobs SET status = $1, task_id = COALESCE($2, task_id), error_code = $3, updated_at = now()
				 WHERE id = $4 AND batch_id = $5 AND owner_id = $6 RETURNING id`,
				[input.status, input.taskId ?? null, input.errorCode ?? null, input.jobId, input.batchId, input.ownerId],
			);
			if (!updated.rows[0]) throw new RenderBatchError("NOT_FOUND");
			const counts = await client.query<{ total: string; completed: string; failed: string }>(
				`SELECT COUNT(*)::text AS total,
						COUNT(*) FILTER (WHERE status = 'completed')::text AS completed,
						COUNT(*) FILTER (WHERE status = 'failed')::text AS failed
				 FROM agent_render_jobs WHERE batch_id = $1 AND owner_id = $2`,
				[input.batchId, input.ownerId],
			);
			const count = counts.rows[0];
			if (!count) throw new RenderBatchError("NOT_FOUND");
			const total = Number(count.total);
			const completed = Number(count.completed);
			const failed = Number(count.failed);
			const status =
				completed === total
					? "completed"
					: failed === total
						? "failed"
						: failed > 0 && completed > 0
							? "partial"
							: "running";
			await client.query(
				"UPDATE agent_render_batches SET status = $1, updated_at = now() WHERE id = $2 AND owner_id = $3",
				[status, input.batchId, input.ownerId],
			);
		});
		return await this.get(input.batchId, input.ownerId);
	}

	async markTask(
		taskId: string,
		status: "succeeded" | "failed" | "cancelled" | "expired" | "settlement_error",
		errorCode?: string,
	): Promise<PersistentRenderBatch | undefined> {
		const result = await this.database.query<{ id: string; batch_id: string; owner_id: string }>(
			"SELECT id, batch_id, owner_id FROM agent_render_jobs WHERE task_id = $1",
			[taskId],
		);
		const job = result.rows[0];
		if (!job) return undefined;
		return await this.markJob({
			batchId: String(job.batch_id),
			ownerId: String(job.owner_id),
			jobId: String(job.id),
			status: status === "succeeded" ? "completed" : "failed",
			taskId,
			errorCode: status === "succeeded" ? undefined : (errorCode ?? status),
		});
	}

	async findByIdempotencyKey(ownerId: string, idempotencyKey: string): Promise<PersistentRenderBatch | undefined> {
		return await this.findByKey(ownerId, idempotencyKey);
	}

	async attachApproval(batchId: string, ownerId: string, approvalActionId: string): Promise<PersistentRenderBatch> {
		const result = await this.database.query<{ id: string }>(
			"UPDATE agent_render_batches SET approval_action_id = $1, updated_at = now() WHERE id = $2 AND owner_id = $3 RETURNING id",
			[approvalActionId, batchId, ownerId],
		);
		if (!result.rows[0]) throw new RenderBatchError("NOT_FOUND");
		return await this.get(batchId, ownerId);
	}

	async rerun(batchId: string, ownerId: string, jobId: string): Promise<PersistentRenderBatch> {
		await this.database.transaction(async (client) => {
			const job = await client.query<{ status: PersistentRenderJob["status"] }>(
				"SELECT status FROM agent_render_jobs WHERE id = $1 AND batch_id = $2 AND owner_id = $3 FOR UPDATE",
				[jobId, batchId, ownerId],
			);
			if (!job.rows[0]) throw new RenderBatchError("NOT_FOUND");
			if (job.rows[0].status !== "failed") throw new RenderBatchError("JOB_NOT_FAILED");
			await client.query(
				"UPDATE agent_render_jobs SET status = 'draft', task_id = NULL, error_code = NULL, updated_at = now() WHERE id = $1 AND batch_id = $2 AND owner_id = $3",
				[jobId, batchId, ownerId],
			);
			await client.query(
				"UPDATE agent_render_batches SET status = 'awaiting_approval', approval_action_id = NULL, updated_at = now() WHERE id = $1 AND owner_id = $2",
				[batchId, ownerId],
			);
		});
		return await this.get(batchId, ownerId);
	}

	private async findByKey(ownerId: string, idempotencyKey: string): Promise<PersistentRenderBatch | undefined> {
		const result = await this.database.query<BatchRow>(
			"SELECT id, owner_id, canvas_id, series_id, episode_no, cost_cap, estimated_cost, status, session_id, canvas_version, approval_action_id FROM agent_render_batches WHERE owner_id = $1 AND idempotency_key = $2",
			[ownerId, idempotencyKey],
		);
		return result.rows[0] ? await this.withJobs(result.rows[0]) : undefined;
	}

	private async withJobs(row: BatchRow): Promise<PersistentRenderBatch> {
		const result = await this.database.query<JobRow>(
			"SELECT id, shot_id, keyframe_render_id, canvas_node_id, duration_seconds, model_type, model_params, estimated_cost, status, task_id, error_code, input_hash FROM agent_render_jobs WHERE batch_id = $1 ORDER BY created_at, id",
			[row.id],
		);
		return {
			id: String(row.id),
			ownerId: String(row.owner_id),
			canvasId: String(row.canvas_id),
			seriesId: row.series_id,
			episodeNo: Number(row.episode_no),
			costCap: Number(row.cost_cap),
			estimatedCost: Number(row.estimated_cost),
			status: row.status,
			...(row.session_id == null ? {} : { sessionId: String(row.session_id) }),
			...(row.canvas_version == null ? {} : { canvasVersion: Number(row.canvas_version) }),
			...(row.approval_action_id == null ? {} : { approvalActionId: String(row.approval_action_id) }),
			jobs: result.rows.map((job) => ({
				id: String(job.id),
				shotId: job.shot_id,
				keyframeRenderId: job.keyframe_render_id,
				canvasNodeId: job.canvas_node_id == null ? undefined : String(job.canvas_node_id),
				durationSeconds: Number(job.duration_seconds),
				modelType: job.model_type,
				modelParams: objectValue(job.model_params),
				estimatedCost: Number(job.estimated_cost),
				inputHash: job.input_hash,
				status: job.status,
				taskId: job.task_id ?? undefined,
				errorCode: job.error_code ?? undefined,
			})),
		};
	}

	private async assertAcceptedKeyframe(
		ownerId: string,
		seriesId: string,
		canvasId: string,
		episodeNo: number,
		shotId: string,
		keyframeRenderId: string,
		durationSeconds: number,
		canvasVersion: number,
	): Promise<string> {
		const result = await this.database.query<{
			id: string;
			canon_revision: number;
			prompt_revision: number;
			character_look_revision: number;
		}>(
			`SELECT keyframe.id,
					series.active_canon_revision AS canon_revision,
					shot.prompt_revision,
					COALESCE(MAX(CASE WHEN (binding.value->>'lookRevision') ~ '^[0-9]+$' THEN (binding.value->>'lookRevision')::integer ELSE 0 END), 0)::integer AS character_look_revision
			 FROM drama_keyframes keyframe
			 JOIN drama_shots shot ON shot.id = keyframe.shot_id
			 JOIN drama_series series ON series.id = shot.series_id
			 LEFT JOIN LATERAL jsonb_array_elements(shot.character_bindings) binding ON TRUE
			 WHERE series.id = $1 AND series.owner_id = $2 AND series.canvas_id = $3 AND shot.id = $4 AND shot.episode_no = $5
			   AND shot.duration_seconds = $6 AND keyframe.id = $7 AND keyframe.status = 'accepted'
			 GROUP BY keyframe.id, series.active_canon_revision, shot.prompt_revision`,
			[seriesId, ownerId, canvasId, shotId, episodeNo, durationSeconds, keyframeRenderId],
		);
		const row = result.rows[0];
		if (!row) throw new RenderBatchError("KEYFRAME_NOT_ACCEPTED");
		return buildRenderInputHash({
			canonRevision: Number(row.canon_revision),
			characterLookRevision: Number(row.character_look_revision),
			promptRevision: Number(row.prompt_revision),
			canvasVersion,
			lineageInputs: [keyframeRenderId],
		});
	}
}

function objectValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function isUniqueViolation(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
