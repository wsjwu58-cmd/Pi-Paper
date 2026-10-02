import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalService, InMemoryApprovalRepository } from "../src/application/approval-service.ts";
import { SessionRunService } from "../src/application/session-run-service.ts";
import { DesktopAgentControlStore } from "../src/desktop/control-store.ts";
import { DesktopLocalToolGateway } from "../src/desktop/local-tool-gateway.ts";
import { createRuntimeTools } from "../src/tools/runtime-tools.ts";

type DesktopModelDirectoryEntry = {
	name: string;
	modelType: string;
	modalities: string[];
	providerId: string;
};

const desktopRequire = createRequire(import.meta.url);
const { buildDesktopAgentModelDirectory } = desktopRequire(
	"../../../../vibepaper-desktop/src/agent-model-directory.cjs",
) as {
	buildDesktopAgentModelDirectory: (
		agnes: { apiKeyConfigured: boolean },
		localTextModel: null,
		localAudioModel: null,
	) => DesktopModelDirectoryEntry[];
};

describe("original Agent desktop canvas commands", () => {
	it("preserves Main's canonical model IDs and modality DTO through the Agent gateway", async () => {
		const produced = buildDesktopAgentModelDirectory({ apiKeyConfigured: true }, null, null);
		const gateway = new DesktopLocalToolGateway({ request: async () => produced }, "p");
		const models = await gateway.listModels();
		const agnesModels = models.filter((model) => model.providerId === "agnes");

		expect(agnesModels.map(({ name, modelType, modalities }) => ({ name, modelType, modalities }))).toEqual([
			{ name: "agnes-2.5-flash", modelType: "text", modalities: ["text"] },
			{ name: "agnes-image-2.5-flash", modelType: "image", modalities: ["image"] },
			{ name: "agnes-video-2.5-flash", modelType: "video", modalities: ["video"] },
		]);
		expect(agnesModels.some((model) => model.modalities.includes("audio"))).toBe(false);
	});
	it("rejects an internally inconsistent modelType and modalities directory", async () => {
		const gateway = new DesktopLocalToolGateway(
			{
				request: async () => [
					{
						name: "agnes-2.5-flash",
						modelType: "text",
						modalities: ["audio"],
						providerId: "agnes",
						providerType: "cloud",
						enabled: true,
					},
				],
			},
			"p",
		);
		await expect(gateway.listModels()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
	});

	it("accepts only exact enabled desktop model names and reports canonical choices for an unknown ID", async () => {
		const models = [
			{
				name: "compose-1.0",
				displayName: "视频合成",
				modelType: "compose",
				modalities: ["compose"],
				providerId: "local-compose",
				providerType: "local",
				enabled: true,
			},
			{
				name: "agnes-image-2.5-flash",
				displayName: "agnes-image-2.5-flash",
				modelType: "image",
				modalities: ["image"],
				providerId: "agnes",
				providerType: "cloud",
				enabled: true,
			},
		];
		const gateway = new DesktopLocalToolGateway({ request: async () => models }, "p");
		expect(await gateway.resolveGenerationModel("p", "compose-1.0")).toBe("compose-1.0");
		expect(await gateway.resolveGenerationModel("p", "agnes-image-2.5-flash")).toBe("agnes-image-2.5-flash");
		await expect(gateway.resolveGenerationModel("p", "compose")).rejects.toMatchObject({
			code: "MODEL_NOT_FOUND",
			message: expect.stringContaining('"compose-1.0"'),
		});
		await expect(gateway.resolveGenerationModel("p", "agen-image-2.5-flash")).rejects.toMatchObject({
			code: "MODEL_NOT_FOUND",
			message: expect.stringContaining('"agnes-image-2.5-flash"'),
			details: {
				requestedModel: "agen-image-2.5-flash",
				availableModels: expect.arrayContaining([
					{ name: "agnes-image-2.5-flash", modelType: "image", modalities: ["image"] },
				]),
			},
		});
	});
	it("surfaces strict model and modality feedback through the original desktop generation tool", async () => {
		const models = [
			{
				name: "agnes-2.5-flash",
				displayName: "agnes-2.5-flash",
				modelType: "text",
				modalities: ["text"],
				providerId: "agnes",
				providerType: "cloud",
				enabled: true,
			},
			{
				name: "agnes-image-2.5-flash",
				displayName: "agnes-image-2.5-flash",
				modelType: "image",
				modalities: ["image"],
				providerId: "agnes",
				providerType: "cloud",
				enabled: true,
			},
			{
				name: "local-sapi-tts",
				displayName: "Windows SAPI 语音合成",
				modelType: "audio",
				modalities: ["audio"],
				providerId: "local-sapi-tts",
				providerType: "local",
				enabled: true,
			},
		];
		const calls: string[] = [];
		const gateway = new DesktopLocalToolGateway(
			{
				request: async (method) => {
					calls.push(method);
					if (method === "agent:core:list-models") return models;
					if (method === "agent:core:load-canvas")
						return {
							projectId: "p",
							canvasId: "c",
							version: 4,
							nodes: [{ id: "audio-target", type: "audio", position: { x: 0, y: 0 }, data: {} }],
							edges: [],
						};
					throw new Error(`unexpected method: ${method}`);
				},
			},
			"p",
		);
		const tools = createRuntimeTools({
			userId: "p",
			sessionId: "s",
			canvasId: "c",
			canvasVersion: 4,
			desktopMode: true,
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway,
		});
		const submit = tools.find((tool) => tool.name === "submit_generation");
		expect(submit).toBeDefined();
		await expect(
			submit!.execute("call-1", {
				nodeId: "audio-target",
				modelType: "agen-image-2.5-flash",
				modelParams: { prompt: "voice" },
				overwrite: false,
			}),
		).rejects.toMatchObject({
			code: "MODEL_NOT_FOUND",
			message: expect.stringContaining('"agnes-image-2.5-flash"'),
		});
		expect(calls).toEqual(["agent:core:list-models"]);

		await expect(
			submit!.execute("call-2", {
				nodeId: "audio-target",
				modelType: "agnes-2.5-flash",
				modelParams: { prompt: "voice" },
				overwrite: false,
			}),
		).rejects.toMatchObject({
			code: "MODEL_MODALITY_MISMATCH",
			message: expect.stringContaining('"local-sapi-tts"'),
			details: { targetType: "audio", model: { modelType: "text", modalities: ["text"] } },
		});
		expect(calls).toEqual(["agent:core:list-models", "agent:core:list-models", "agent:core:load-canvas"]);
	});
	it("persists write intent before dispatch and reconciles a lost response without replaying the write", async () => {
		const directory = await mkdtemp(join(tmpdir(), "vp-agent-operation-"));
		const control = new DesktopAgentControlStore(join(directory, "control.sqlite"));
		try {
			const run = await new SessionRunService(control).startRun({ sessionId: "s", idempotencyKey: "run" });
			control.updateStatus(run.runId, "running");
			let writes = 0;
			const gateway = new DesktopLocalToolGateway(
				{
					request: async (method) => {
						if (method === "agent:core:lookup-operation")
							return { node: { id: "a", type: "text", data: {} }, version: 4 };
						writes++;
						expect(control.listRecoverableOperations("s")[0].state).toBe("dispatched");
						throw new Error("AGENT_LOCAL_CORE_TIMEOUT");
					},
				},
				"p",
			);
			gateway.attachRun({ control, sessionId: "s", runId: run.runId });
			const command = {
				userId: "p",
				canvasId: "c",
				requestId: "r",
				expectedVersion: 3,
				idempotencyKey: "update",
				operation: "update_node_config" as const,
				payload: { nodeId: "a", config: { prompt: "private prompt" } },
			};
			await expect(gateway.execute(command)).rejects.toThrow();
			expect(control.listRecoverableOperations("s")[0].state).toBe("uncertain");
			expect(await gateway.execute(command)).toMatchObject({ canvasVersion: 4 });
			expect(writes).toBe(1);
			expect(control.listRecoverableOperations("s")).toHaveLength(0);
			control.cancelIfActiveAtomic(run.runId);
			await expect(gateway.execute({ ...command, idempotencyKey: "after-stop" })).rejects.toThrow("当前回合已停止");
			expect(writes).toBe(1);
		} finally {
			control.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("previews desktop deletion for confirmation and preserves the original Web delete command", async () => {
		const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
		const gateway = new DesktopLocalToolGateway(
			{
				request: async (method, payload) => {
					calls.push({ method, payload });
					if (method === "agent:core:load-canvas")
						return {
							projectId: "p",
							canvasId: "c",
							version: 3,
							nodes: [
								{ id: "a", type: "text", position: { x: 0, y: 0 }, data: { label: "脚本" } },
								{ id: "b", type: "image", position: { x: 100, y: 0 }, data: { label: "海报" } },
							],
							edges: [{ id: "edge-ab", source: "a", target: "b" }],
							groups: [],
							stacks: [],
						};
					return { operation: "delete_nodes", canvasVersion: 5, results: [] };
				},
			},
			"p",
		);
		const context = { userId: "p", sessionId: "s", canvasId: "c", canvasVersion: 3, requestId: "r", gateway };
		let approvalAction: { actionId: string; toolName: string; params: Record<string, unknown> } | undefined;
		const desktopTools = createRuntimeTools({
			...context,
			desktopMode: true,
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			onApprovalRequired: async (action) => {
				approvalAction = action;
			},
		});
		const desktopDelete = desktopTools.find((entry) => entry.name === "delete_nodes");
		expect(desktopDelete).toBeDefined();
		const desktopCallStart = calls.length;
		const preview = await desktopDelete!.execute("desktop-call", { nodeIds: ["a"] });
		expect(preview).toMatchObject({
			details: { kind: "canvas_delete", preview: { connectedEdgeCount: 1 } },
			terminate: true,
		});
		expect(approvalAction).toMatchObject({ toolName: "delete_nodes", params: { nodeIds: ["a"] } });
		expect(calls.slice(desktopCallStart).map((call) => call.method)).toEqual(["agent:core:load-canvas"]);

		const tools = createRuntimeTools(context);
		const tool = tools.find((entry) => entry.name === "delete_nodes");
		expect(tool).toBeDefined();
		await tool!.execute("call", { nodeIds: ["a", "b"] });
		expect(calls.at(-1)).toMatchObject({
			method: "agent:core:delete-nodes",
			payload: {
				projectId: "p",
				canvasId: "c",
				expectedVersion: 3,
				nodeIds: ["a", "b"],
			},
		});
	});

	it("submits compose by authoritative input node identities without requiring a text prompt", async () => {
		const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
		const gateway = new DesktopLocalToolGateway(
			{
				request: async (method, payload) => {
					calls.push({ method, payload });
					if (method.endsWith("list-models"))
						return [
							{
								name: "compose-1.0",
								modelType: "compose",
								modalities: ["compose"],
								providerType: "local",
								providerId: "mock-compose",
								enabled: true,
							},
						];
					if (method.endsWith("load-canvas"))
						return {
							projectId: "p",
							canvasId: "c",
							version: 3,
							nodes: [{ id: "target", type: "compose", position: { x: 0, y: 0 }, data: {} }],
							edges: [],
						};
					return { taskId: "task", status: "queued" };
				},
			},
			"p",
		);
		expect(
			await gateway.createGenerationTask({
				userId: "p",
				canvasId: "c",
				canvasVersion: 3,
				nodeId: "target",
				modelType: "compose-1.0",
				modelParams: { inputNodeIds: ["a", "b"] },
				idempotencyKey: "confirmed",
			}),
		).toMatchObject({ taskId: "task", modality: "compose" });
		expect(calls[2]).toMatchObject({
			method: "agent:core:create-generation-task",
			payload: {
				modality: "compose",
				prompt: "",
				parameters: { inputNodeIds: ["a", "b"] },
			},
		});
	});
});
