import { errorSchema } from "./schemas/common.ts";
import { dramaSeriesSchema } from "./schemas/drama.ts";
import { agentEventEnvelopeSchema } from "./schemas/events.ts";
import { memoryCandidateSchema, memorySchema } from "./schemas/memories.ts";
import { sessionMessageSchema } from "./schemas/sessions.ts";
import { skillAttachSchema } from "./schemas/skills.ts";

export type AgentOpenApiDocument = {
	openapi: "3.1.0";
	info: { title: string; version: string };
	paths: Record<string, Record<string, unknown>>;
	components: { schemas: Record<string, { required?: readonly string[]; [key: string]: unknown }> };
};

export function createAgentOpenApi(): AgentOpenApiDocument {
	return {
		openapi: "3.1.0",
		info: { title: "VibePaper Pi Agent Service", version: "1.0.0" },
		paths: {
			"/api/v1/agent/sessions": { get: {}, post: {} },
			"/api/v1/agent/sessions/{sessionId}": { get: {}, patch: {}, delete: {} },
			"/api/v1/agent/sessions/{sessionId}/events": { get: {} },
			"/api/v1/agent/sessions/{sessionId}/cancel": { post: {} },
			"/api/v1/agent/sessions/{sessionId}/skills/{skillId}:attach": { post: {} },
			"/api/v1/agent/sessions/{sessionId}/plans": { post: {} },
			"/api/v1/agent/plans/{planId}": { get: {} },
			"/api/v1/agent/plans/{planId}/ready-set": { get: {} },
			"/api/v1/agent/plans/{planId}/rerun": { post: {} },
			"/api/v1/memories": { get: {}, post: {} },
			"/api/v1/memory-candidates": { get: {} },
			"/api/v1/memory-candidates/{candidateId}/accept": { post: {} },
			"/api/v1/memory-candidates/{candidateId}/reject": { post: {} },
			"/api/v1/drama/series": { post: {} },
			"/api/v1/drama/story-bibles": { post: {} },
			"/api/v1/drama/story-bibles/{bibleId}": { get: {} },
			"/api/v1/drama/story-bibles/{bibleId}/canon": { patch: {} },
			"/api/v1/drama/story-bibles/{bibleId}/episodes": { post: {} },
			"/api/v1/drama/story-episodes/{episodeId}/scenes": { post: {} },
			"/api/v1/drama/story-scenes/{sceneId}/facts": { get: {}, post: {} },
			"/api/v1/drama/story-scenes/{sceneId}/foreshadows": { post: {} },
			"/api/v1/drama/foreshadows/{foreshadowId}/resolve": { post: {} },
			"/api/v1/drama/post-production/videos": { post: {} },
			"/api/v1/drama/post-production/videos/{videoId}/tts": { post: {} },
			"/api/v1/drama/post-production/videos/{videoId}/subtitles": { post: {} },
			"/api/v1/drama/post-production/composites": { post: {} },
			"/api/v1/drama/post-production/artifacts": { get: {} },
			"/api/v1/drama/render-batches": { get: {}, post: {} },
			"/api/v1/drama/render-batches/{batchId}": { get: {} },
			"/api/v1/drama/render-batches/{batchId}/submit": { post: {} },
			"/api/v1/drama/render-batches/{batchId}/jobs/{jobId}/status": { post: {} },
			"/api/v1/drama/render-batches/{batchId}/jobs/{jobId}/rerun": { post: {} },
			"/api/v1/render-reviews": { get: {}, post: {} },
		},
		components: {
			schemas: {
				Error: errorSchema,
				AgentEventEnvelope: agentEventEnvelopeSchema,
				SessionMessage: sessionMessageSchema,
				SkillAttach: skillAttachSchema,
				Memory: memorySchema,
				MemoryCandidate: memoryCandidateSchema,
				DramaSeries: dramaSeriesSchema,
			},
		},
	};
}
