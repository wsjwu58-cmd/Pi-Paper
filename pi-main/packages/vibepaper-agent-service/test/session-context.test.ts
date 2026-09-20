import { describe, expect, it } from "vitest";

import { InMemorySessionContextRepository, SessionContextService } from "../src/application/session-context-service.ts";
import { compactContext } from "../src/application/context-compaction-service.ts";
import type { AgentRunEvent } from "../src/domain/agent-run.ts";
import { createSessionContext, reduceSessionEvent } from "../src/domain/session-context.ts";

function event(type: AgentRunEvent["type"], eventSeq: number, data: Record<string, unknown>): AgentRunEvent {
	return {
		eventId: String(eventSeq),
		runId: "run-1",
		sessionId: "session-1",
		eventSeq,
		type,
		runtime: "pi",
		runtimeVersion: "0.1.0",
		data,
		createdAt: new Date(eventSeq * 1_000),
	};
}

describe("session context checkpoint", () => {
	it("rebuilds canvas, task and approval state from authoritative events", () => {
		let context = createSessionContext("session-1", "canvas-1");
		context = reduceSessionEvent(
			context,
			event("tool_completed", 1, { details: { canvasVersion: 580 }, nodeId: "node-ref" }),
		);
		context = reduceSessionEvent(
			context,
			event("confirmation_required", 2, {
				actionId: "action-1",
				tool: "submit_generation_batch",
				canvasVersion: 580,
			}),
		);
		context = reduceSessionEvent(
			context,
			event("task_status", 3, { task_id: "task-1", status: "succeeded", node_id: "node-video", canvas_version: 581 }),
		);
		expect(context.canvasVersion).toBe(581);
		expect(context.nodeRefs).toEqual(expect.arrayContaining(["node-ref", "node-video"]));
		expect(context.tasks["task-1"]?.status).toBe("succeeded");
		expect(context.pendingApproval?.actionId).toBe("action-1");
		expect(context.compactedToEventSeq).toBe(3);
	});

	it("persists and reloads a session snapshot", async () => {
		const service = new SessionContextService(new InMemorySessionContextRepository());
		await service.recordPrompt("session-1", "完成第一集短剧", "canvas-1");
		const loaded = await service.load("session-1", "canvas-1");
		expect(loaded.goal).toBe("完成第一集短剧");
		expect(loaded.canvasId).toBe("canvas-1");
	});

	it("keeps the structured checkpoint when compacting history", () => {
		const context = createSessionContext("session-1", "canvas-1");
		context.canvasVersion = 581;
		context.pendingSteps.push("generate_video");
		const result = compactContext([{ role: "user", content: "old ".repeat(1000) }], {
			maxTokens: 100,
			sessionContext: context,
		});
		expect(result.state?.canvasVersion).toBe(581);
		expect(result.summary).toContain("generate_video");
	});
});
