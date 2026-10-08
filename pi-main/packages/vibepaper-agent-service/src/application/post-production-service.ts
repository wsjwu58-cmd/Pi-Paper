import type { PostProductionArtifact, TimelineSegment } from "../domain/audio-subtitle-composite.ts";
import { nextId } from "../infrastructure/ids.ts";

export class PostProductionService {
	private readonly artifacts = new Map<string, PostProductionArtifact>();
	private readonly byLineage = new Map<string, string>();

	registerVideo(input: {
		ownerId: string;
		durationMs: number;
		taskId: string;
		lineageIds: readonly string[];
	}): PostProductionArtifact {
		const video = {
			id: nextId(),
			ownerId: input.ownerId,
			kind: "video" as const,
			status: "accepted" as const,
			durationMs: input.durationMs,
			taskId: input.taskId,
			lineageIds: input.lineageIds,
		};
		this.artifacts.set(video.id, video);
		return video;
	}

	async createTts(input: {
		ownerId: string;
		videoId: string;
		durationMs: number;
		language: string;
		voiceId: string;
		taskId: string;
	}): Promise<PostProductionArtifact> {
		const video = this.require(input.videoId, input.ownerId, "video");
		if (video.durationMs !== input.durationMs) throw new Error("DURATION_MISMATCH");
		const key = `tts:${video.id}:${input.language}:${input.voiceId}:${input.durationMs}`;
		const existing = this.byLineage.get(key);
		if (existing) return this.require(existing, input.ownerId, "tts");
		const artifact = {
			id: nextId(),
			ownerId: input.ownerId,
			kind: "tts" as const,
			status: "accepted" as const,
			durationMs: input.durationMs,
			language: input.language,
			voiceId: input.voiceId,
			taskId: input.taskId,
			lineageIds: [video.id],
		};
		this.artifacts.set(artifact.id, artifact);
		this.byLineage.set(key, artifact.id);
		return artifact;
	}

	async createSubtitle(input: {
		ownerId: string;
		videoId: string;
		durationMs: number;
		language: string;
		segments: readonly TimelineSegment[];
		taskId: string;
	}): Promise<PostProductionArtifact> {
		const video = this.require(input.videoId, input.ownerId, "video");
		if (video.durationMs !== input.durationMs) throw new Error("DURATION_MISMATCH");
		if (
			input.segments.some(
				(segment) =>
					segment.startMs < 0 ||
					segment.endMs <= segment.startMs ||
					segment.endMs > input.durationMs ||
					!segment.text.trim(),
			)
		)
			throw new Error("SUBTITLE_OUT_OF_BOUNDS");
		const artifact = {
			id: nextId(),
			ownerId: input.ownerId,
			kind: "subtitle" as const,
			status: "accepted" as const,
			durationMs: input.durationMs,
			language: input.language,
			taskId: input.taskId,
			lineageIds: [video.id],
			segments: input.segments,
		};
		this.artifacts.set(artifact.id, artifact);
		return artifact;
	}

	async createComposite(input: {
		ownerId: string;
		videoId: string;
		ttsId: string;
		subtitleId: string;
		taskId: string;
	}): Promise<PostProductionArtifact> {
		const video = this.require(input.videoId, input.ownerId, "video");
		const tts = this.require(input.ttsId, input.ownerId, "tts");
		const subtitle = this.require(input.subtitleId, input.ownerId, "subtitle");
		if (tts.status !== "accepted" || subtitle.status !== "accepted") throw new Error("UPSTREAM_NOT_ACCEPTED");
		if (video.durationMs !== tts.durationMs || video.durationMs !== subtitle.durationMs)
			throw new Error("DURATION_MISMATCH");
		const artifact = {
			id: nextId(),
			ownerId: input.ownerId,
			kind: "composite" as const,
			status: "accepted" as const,
			durationMs: video.durationMs,
			taskId: input.taskId,
			lineageIds: [video.id, tts.id, subtitle.id],
		};
		this.artifacts.set(artifact.id, artifact);
		return artifact;
	}

	private require(id: string, ownerId: string, kind: PostProductionArtifact["kind"]): PostProductionArtifact {
		const artifact = this.artifacts.get(id);
		if (!artifact || artifact.ownerId !== ownerId || artifact.kind !== kind) throw new Error("NOT_FOUND");
		return artifact;
	}
}

export class PostProductionError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = "PostProductionError";
		this.code = code;
	}
}
