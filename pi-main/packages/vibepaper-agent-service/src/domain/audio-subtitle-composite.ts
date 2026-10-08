export type TimelineSegment = { startMs: number; endMs: number; text: string };
export type PostProductionArtifact = {
	id: string;
	ownerId: string;
	kind: "video" | "tts" | "subtitle" | "composite";
	status: "draft" | "accepted" | "failed";
	durationMs: number;
	language?: string;
	voiceId?: string;
	taskId: string;
	lineageIds: readonly string[];
	segments?: readonly TimelineSegment[];
};
