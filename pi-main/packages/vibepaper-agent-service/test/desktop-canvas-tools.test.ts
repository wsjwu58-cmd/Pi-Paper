import { describe, expect, it } from "vitest";
import { DesktopLocalToolGateway } from "../src/desktop/local-tool-gateway.ts";
import { createRuntimeTools } from "../src/tools/runtime-tools.ts";
import { DesktopAgentControlStore } from "../src/desktop/control-store.ts";
import { SessionRunService } from "../src/application/session-run-service.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("original Agent desktop canvas commands", () => {
	it("persists write intent before dispatch and reconciles a lost response without replaying the write", async () => {
		const directory = await mkdtemp(join(tmpdir(), "vp-agent-operation-"));
		const control = new DesktopAgentControlStore(join(directory, "control.sqlite"));
		try {
			const run = await new SessionRunService(control).startRun({ sessionId: "s", idempotencyKey: "run" });
			let writes = 0;
			const gateway = new DesktopLocalToolGateway({ request: async (method) => {
				if (method === "agent:core:lookup-operation") return { node: { id: "a", type: "text", data: {} }, version: 4 };
				writes++;
				expect(control.listRecoverableOperations("s")[0].state).toBe("dispatched");
				throw new Error("AGENT_LOCAL_CORE_TIMEOUT");
			} }, "p");
			gateway.attachRun({ control, sessionId: "s", runId: run.runId });
			const command = { userId: "p", canvasId: "c", requestId: "r", expectedVersion: 3,
				idempotencyKey: "update", operation: "update_node_config" as const, payload: { nodeId: "a", config: { prompt: "private prompt" } } };
			await expect(gateway.execute(command)).rejects.toThrow();
			expect(control.listRecoverableOperations("s")[0].state).toBe("uncertain");
			expect(await gateway.execute(command)).toMatchObject({ canvasVersion: 4 });
			expect(writes).toBe(1);
			expect(control.listRecoverableOperations("s")).toHaveLength(0);
		} finally {
			control.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("retains the original delete tool and routes its scoped command to the preview boundary", async () => {
		const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
		const gateway = new DesktopLocalToolGateway({ request: async (method, payload) => {
			calls.push({ method, payload });
			return { operation: "delete_nodes", canvasVersion: 5, results: [] };
		} }, "p");
		const tools = createRuntimeTools({ userId: "p", sessionId: "s", canvasId: "c", canvasVersion: 3,
			requestId: "r", desktopMode: true, gateway });
		const tool = tools.find((entry) => entry.name === "delete_nodes");
		expect(tool).toBeDefined();
		await tool!.execute("call", { nodeIds: ["a", "b"] });
		expect(calls[0]).toMatchObject({ method: "agent:core:delete-nodes", payload: {
			projectId: "p", canvasId: "c", expectedVersion: 3, nodeIds: ["a", "b"],
		} });
	});

	it("submits compose by authoritative input node identities without requiring a text prompt", async () => {
		const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
		const gateway = new DesktopLocalToolGateway({ request: async (method, payload) => {
			calls.push({ method, payload });
			if (method.endsWith("list-models")) return [{ name: "compose-1.0", modelType: "compose", providerType: "local", providerId: "mock-compose", enabled: true }];
			return { taskId: "task", status: "queued" };
		} }, "p");
		expect(await gateway.createGenerationTask({ userId: "p", canvasId: "c", canvasVersion: 3,
			nodeId: "target", modelType: "compose-1.0", modelParams: { inputNodeIds: ["a", "b"] }, idempotencyKey: "confirmed" }))
			.toMatchObject({ taskId: "task", modality: "compose" });
		expect(calls[1]).toMatchObject({ method: "agent:core:create-generation-task", payload: {
			modality: "compose", prompt: "", parameters: { inputNodeIds: ["a", "b"] },
		} });
	});
});
