import { describe, expect, it } from "vitest";

import { createAgentOpenApi } from "../src/api/openapi.ts";

describe("Agent OpenAPI contract", () => {
	it("declares the frontend session, event, Skill, memory and drama paths", () => {
		const document = createAgentOpenApi();
		expect(document.openapi).toBe("3.1.0");
		for (const path of [
			"/api/v1/agent/sessions",
			"/api/v1/agent/sessions/{sessionId}",
			"/api/v1/agent/sessions/{sessionId}/events",
			"/api/v1/agent/sessions/{sessionId}/cancel",
			"/api/v1/agent/sessions/{sessionId}/skills/{skillId}:attach",
			"/api/v1/memories",
			"/api/v1/memory-candidates",
			"/api/v1/memory-candidates/{candidateId}/accept",
			"/api/v1/memory-candidates/{candidateId}/reject",
			"/api/v1/drama/series",
			"/api/v1/render-reviews",
		])
			expect(document.paths[path]).toBeDefined();
	});

	it("keeps stable error fields and event envelope fields", () => {
		const document = createAgentOpenApi();
		expect(document.components.schemas.Error.required).toEqual(["code", "message", "request_id", "retryable"]);
		expect(document.components.schemas.MemoryCandidate.required).toEqual([
			"id",
			"content",
			"memoryType",
			"scope",
			"confidence",
			"createdAt",
		]);
		expect(document.components.schemas.AgentEventEnvelope.required).toEqual([
			"eventId",
			"runId",
			"sessionId",
			"eventSeq",
			"type",
			"runtime",
			"runtimeVersion",
			"data",
		]);
	});
});
