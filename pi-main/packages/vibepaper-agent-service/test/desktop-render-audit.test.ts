import { describe, expect, it } from "vitest";

import { selectProfile } from "../src/application/profile-selector.ts";
import { DesktopLocalToolGateway } from "../src/desktop/local-tool-gateway.ts";
import type { AgentProfile } from "../src/domain/tool-manifest.ts";
import { createDramaAgent } from "../src/pi/drama-agent.ts";
import { createRuntimeTools } from "../src/tools/runtime-tools.ts";

const auditInput = {
	targetNodeId: "clip-node-1",
	shotDurationSeconds: 4,
	expectedDurationSeconds: 3,
	characterConsistent: false,
	audioDurationMs: 4_100,
	videoDurationMs: 4_000,
	previousCamera: "wide",
	currentCamera: "close",
};

describe("desktop Agent render audit adapter", () => {
	it("makes the original audit tool visible only in an explicitly selected short-drama profile", () => {
		const runtimeTools = createRuntimeTools({
			userId: "project-1",
			sessionId: "session-1",
			canvasId: "canvas-1",
			canvasVersion: 8,
			gateway: {} as never,
			onAuditRequested: async () => ({ verdict: "pass", findings: [], ruleVersion: "continuity-v1" }),
		});
		const makeAgent = (profile: AgentProfile) =>
			createDramaAgent({} as never, {
				profile,
				streamFn: (() => undefined) as never,
				runtimeTools,
			});

		expect(makeAgent(selectProfile({ canvasDomain: "general" })).state.tools.map((tool) => tool.name)).not.toContain(
			"request_render_audit",
		);
		expect(makeAgent(selectProfile({ canvasDomain: "short-drama" })).state.tools.map((tool) => tool.name)).toContain(
			"request_render_audit",
		);
	});

	it("sends the captured project, canvas, version, and target to Local Core and hides record IDs", async () => {
		const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
		const gateway = new DesktopLocalToolGateway(
			{
				request: async (method, payload) => {
					calls.push({ method, payload });
					if (method === "agent:core:load-canvas") {
						return { canvasId: "canvas-1", version: 8, nodes: [{ id: "clip-node-1" }], edges: [] };
					}
					if (method === "agent:core:create-render-review") {
						return {
							id: "review-internal-id",
							ownerId: "project-1",
							verdict: "fail",
							findings: [{ ruleId: "SHOT_DURATION", severity: "error", evidence: "4 != 3" }],
							ruleVersion: "continuity-v1",
							sourceTaskId: "task-internal-id",
							modelSuggestion: "ignored",
						};
					}
					throw new Error(`unexpected method: ${method}`);
				},
			},
			"project-1",
		);

		await expect(gateway.requestRenderAudit("project-1", "canvas-1", 8, auditInput)).resolves.toEqual({
			verdict: "fail",
			findings: [{ ruleId: "SHOT_DURATION", severity: "error", evidence: "4 != 3" }],
			ruleVersion: "continuity-v1",
		});
		expect(calls).toEqual([
			{ method: "agent:core:load-canvas", payload: { projectId: "project-1", canvasId: "canvas-1" } },
			{
				method: "agent:core:create-render-review",
				payload: { projectId: "project-1", canvasId: "canvas-1", canvasVersion: 8, ...auditInput },
			},
		]);
	});

	it("uses the current tool-context version after an earlier write in the same Agent turn", async () => {
		const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
		const gateway = new DesktopLocalToolGateway(
			{
				request: async (method, payload) => {
					calls.push({ method, payload });
					if (method === "agent:core:load-canvas") {
						return { canvasId: "canvas-1", version: 9, nodes: [{ id: "clip-node-1" }], edges: [] };
					}
					return { id: "private-review-id", verdict: "pass", findings: [], ruleVersion: "continuity-v1" };
				},
			},
			"project-1",
		);
		const context: Parameters<typeof createRuntimeTools>[0] = {
			userId: "project-1",
			sessionId: "session-1",
			canvasId: "canvas-1",
			canvasVersion: 8,
			gateway: {} as never,
			onAuditRequested: async (input: typeof auditInput) =>
				gateway.requestRenderAudit("project-1", "canvas-1", context.canvasVersion, input),
		};
		const auditTool = createRuntimeTools(context).find((tool) => tool.name === "request_render_audit");
		if (!auditTool) throw new Error("request_render_audit tool missing");

		// Runtime writes update this shared context before a later audit tool call.
		context.canvasVersion = 9;
		await auditTool.execute("audit-call", auditInput);

		expect(calls.at(-1)).toMatchObject({
			method: "agent:core:create-render-review",
			payload: { canvasVersion: 9 },
		});
	});

	it("rejects a cross-project request and a target outside the captured canvas", async () => {
		const methods: string[] = [];
		const gateway = new DesktopLocalToolGateway(
			{
				request: async (method) => {
					methods.push(method);
					return { canvasId: "canvas-1", version: 8, nodes: [{ id: "other-node" }], edges: [] };
				},
			},
			"project-1",
		);

		await expect(gateway.requestRenderAudit("other-project", "canvas-1", 8, auditInput)).rejects.toMatchObject({
			code: "PERMISSION_DENIED",
		});
		await expect(gateway.requestRenderAudit("project-1", "canvas-1", 8, auditInput)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(methods).toEqual(["agent:core:load-canvas"]);
	});
});
