import type { QueryResultRow } from "pg";
import { PostProductionError } from "../application/post-production-service.ts";
import type { PostProductionArtifact, TimelineSegment } from "../domain/audio-subtitle-composite.ts";
import type { SqlExecutor } from "./database.ts";
import { nextId } from "./ids.ts";

type ArtifactRow = QueryResultRow & {
	id: string;
	owner_id: string;
	kind: PostProductionArtifact["kind"];
	status: PostProductionArtifact["status"];
	duration_ms: number;
	language: string | null;
	voice_id: string | null;
	task_id: string;
	lineage_ids: unknown;
	segments: unknown;
};

export class PgPostProductionService {
	private readonly database: SqlExecutor;

	constructor(database: SqlExecutor) {
		this.database = database;
	}

	async registerVideo(input: {
		ownerId: string;
		durationMs: number;
		taskId: string;
		lineageIds: readonly string[];
		idempotencyKey: string;
	}): Promise<PostProductionArtifact> {
		const replay = await this.findByIdempotency(input.ownerId, input.idempotencyKey);
		if (replay) return replay;
		if (!Number.isInteger(input.durationMs) || input.durationMs <= 0) throw new PostProductionError("INVALID_INPUT");
		return await this.insert({
			ownerId: input.ownerId,
			kind: "video",
			status: "accepted",
			durationMs: input.durationMs,
			taskId: input.taskId,
			lineageIds: input.lineageIds,
			idempotencyKey: input.idempotencyKey,
		});
	}

	async createTts(input: {
		ownerId: string;
		videoId: string;
		durationMs: number;
		language: string;
		voiceId: string;
		taskId: string;
		idempotencyKey: string;
	}): Promise<PostProductionArtifact> {
		const replay = await this.findByIdempotency(input.ownerId, input.idempotencyKey);
		if (replay) return replay;
		const video = await this.require(input.videoId, input.ownerId, "video");
		this.assertDuration(video, input.durationMs);
		const key = `tts:${video.id}:${input.language}:${input.voiceId}:${input.durationMs}`;
		const existing = await this.findByDedupe(input.ownerId, key);
		if (existing) return existing;
		return await this.insert({
			ownerId: input.ownerId,
			kind: "tts",
			status: "accepted",
			durationMs: input.durationMs,
			language: input.language,
			voiceId: input.voiceId,
			taskId: input.taskId,
			lineageIds: [video.id],
			dedupeKey: key,
			idempotencyKey: input.idempotencyKey,
		});
	}

	async createSubtitle(input: {
		ownerId: string;
		videoId: string;
		durationMs: number;
		language: string;
		segments: readonly TimelineSegment[];
		taskId: string;
		idempotencyKey: string;
	}): Promise<PostProductionArtifact> {
		const replay = await this.findByIdempotency(input.ownerId, input.idempotencyKey);
		if (replay) return replay;
		const video = await this.require(input.videoId, input.ownerId, "video");
		this.assertDuration(video, input.durationMs);
		if (
			input.segments.some(
				(segment) =>
					segment.startMs < 0 ||
					segment.endMs <= segment.startMs ||
					segment.endMs > input.durationMs ||
					!segment.text.trim(),
			)
		)
			throw new PostProductionError("SUBTITLE_OUT_OF_BOUNDS");
		return await this.insert({
			ownerId: input.ownerId,
			kind: "subtitle",
			status: "accepted",
			durationMs: input.durationMs,
			language: input.language,
			taskId: input.taskId,
			lineageIds: [video.id],
			segments: input.segments,
			idempotencyKey: input.idempotencyKey,
		});
	}

	async createComposite(input: {
		ownerId: string;
		videoId: string;
		ttsId: string;
		subtitleId: string;
		taskId: string;
		idempotencyKey: string;
	}): Promise<PostProductionArtifact> {
		const replay = await this.findByIdempotency(input.ownerId, input.idempotencyKey);
		if (replay) return replay;
		const video = await this.require(input.videoId, input.ownerId, "video");
		const tts = await this.require(input.ttsId, input.ownerId, "tts");
		const subtitle = await this.require(input.subtitleId, input.ownerId, "subtitle");
		if (tts.status !== "accepted" || subtitle.status !== "accepted")
			throw new PostProductionError("UPSTREAM_NOT_ACCEPTED");
		if (video.durationMs !== tts.durationMs || video.durationMs !== subtitle.durationMs)
			throw new PostProductionError("DURATION_MISMATCH");
		return await this.insert({
			ownerId: input.ownerId,
			kind: "composite",
			status: "accepted",
			durationMs: video.durationMs,
			taskId: input.taskId,
			lineageIds: [video.id, tts.id, subtitle.id],
			idempotencyKey: input.idempotencyKey,
		});
	}

	async list(ownerId: string): Promise<readonly PostProductionArtifact[]> {
		const result = await this.database.query<ArtifactRow>(
			"SELECT id, owner_id, kind, status, duration_ms, language, voice_id, task_id, lineage_ids, segments FROM media_artifacts WHERE owner_id = $1 ORDER BY created_at DESC, id DESC",
			[ownerId],
		);
		return result.rows.map(toArtifact);
	}

	private async insert(input: {
		ownerId: string;
		kind: PostProductionArtifact["kind"];
		status: PostProductionArtifact["status"];
		durationMs: number;
		language?: string;
		voiceId?: string;
		taskId: string;
		lineageIds: readonly string[];
		idempotencyKey: string;
		segments?: readonly TimelineSegment[];
		dedupeKey?: string;
	}): Promise<PostProductionArtifact> {
		try {
			const result = await this.database.query<ArtifactRow>(
				`INSERT INTO media_artifacts
				 (id, owner_id, kind, status, duration_ms, language, voice_id, task_id, idempotency_key, lineage_ids, segments, dedupe_key)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
				 RETURNING id, owner_id, kind, status, duration_ms, language, voice_id, task_id, lineage_ids, segments`,
				[
					nextId(),
					input.ownerId,
					input.kind,
					input.status,
					input.durationMs,
					input.language ?? null,
					input.voiceId ?? null,
					input.taskId,
					input.idempotencyKey,
					JSON.stringify(input.lineageIds),
					JSON.stringify(input.segments ?? []),
					input.dedupeKey ?? null,
				],
			);
			return toArtifact(result.rows[0]);
		} catch (error) {
			if (isUniqueViolation(error)) {
				const existing = await this.findByIdempotency(input.ownerId, input.idempotencyKey);
				if (existing) return existing;
			}
			throw error;
		}
	}

	private async require(
		id: string,
		ownerId: string,
		kind: PostProductionArtifact["kind"],
	): Promise<PostProductionArtifact> {
		const result = await this.database.query<ArtifactRow>(
			"SELECT id, owner_id, kind, status, duration_ms, language, voice_id, task_id, lineage_ids, segments FROM media_artifacts WHERE id = $1 AND owner_id = $2 AND kind = $3",
			[id, ownerId, kind],
		);
		const artifact = result.rows[0];
		if (!artifact) throw new PostProductionError("NOT_FOUND");
		return toArtifact(artifact);
	}

	private async findByDedupe(ownerId: string, dedupeKey: string): Promise<PostProductionArtifact | undefined> {
		const result = await this.database.query<ArtifactRow>(
			"SELECT id, owner_id, kind, status, duration_ms, language, voice_id, task_id, lineage_ids, segments FROM media_artifacts WHERE owner_id = $1 AND dedupe_key = $2",
			[ownerId, dedupeKey],
		);
		return result.rows[0] ? toArtifact(result.rows[0]) : undefined;
	}

	private async findByIdempotency(
		ownerId: string,
		idempotencyKey: string,
	): Promise<PostProductionArtifact | undefined> {
		if (!idempotencyKey.trim() || idempotencyKey.length > 128) throw new PostProductionError("INVALID_INPUT");
		const result = await this.database.query<ArtifactRow>(
			"SELECT id, owner_id, kind, status, duration_ms, language, voice_id, task_id, lineage_ids, segments FROM media_artifacts WHERE owner_id = $1 AND idempotency_key = $2",
			[ownerId, idempotencyKey],
		);
		return result.rows[0] ? toArtifact(result.rows[0]) : undefined;
	}

	private assertDuration(video: PostProductionArtifact, durationMs: number): void {
		if (video.durationMs !== durationMs) throw new PostProductionError("DURATION_MISMATCH");
	}
}

function toArtifact(row: ArtifactRow): PostProductionArtifact {
	if (!row) throw new PostProductionError("INVALID_STATE");
	return {
		id: String(row.id),
		ownerId: String(row.owner_id),
		kind: row.kind,
		status: row.status,
		durationMs: Number(row.duration_ms),
		language: row.language ?? undefined,
		voiceId: row.voice_id ?? undefined,
		taskId: row.task_id,
		lineageIds: stringArray(row.lineage_ids),
		segments: row.kind === "subtitle" ? timelineArray(row.segments) : undefined,
	};
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
		throw new PostProductionError("INVALID_STATE");
	return value;
}

function timelineArray(value: unknown): TimelineSegment[] {
	if (!Array.isArray(value)) throw new PostProductionError("INVALID_STATE");
	return value.filter(
		(item): item is TimelineSegment =>
			typeof item === "object" &&
			item !== null &&
			typeof (item as TimelineSegment).startMs === "number" &&
			typeof (item as TimelineSegment).endMs === "number" &&
			typeof (item as TimelineSegment).text === "string",
	);
}

function isUniqueViolation(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
