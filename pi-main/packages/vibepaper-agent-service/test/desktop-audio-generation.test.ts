import { describe, expect, it } from "vitest";

import { DesktopLocalToolGateway } from "../src/desktop/local-tool-gateway.ts";

const availableSapiModel = {
	name: "local-sapi-tts",
	displayName: "Windows SAPI 语音合成",
	modelType: "audio",
	providerId: "local-sapi-tts",
	providerType: "local",
	enabled: true,
	modalities: ["audio"],
	inputModes: ["text"],
	toolCalling: false,
	streaming: false,
	cancellation: false,
};

describe("desktop Agent local audio generation adapter", () => {
	it("submits a nonempty audio prompt and preserves SAPI parameters in a queued local task", async () => {
		const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
		const gateway = new DesktopLocalToolGateway(
			{
				request: async (method, payload) => {
					calls.push({ method, payload });
					if (method === "agent:core:list-models") return [availableSapiModel];
					if (method === "agent:core:create-generation-task")
						return { taskId: "task-audio-1", status: "queued" };
					throw new Error(`unexpected method: ${method}`);
				},
			},
			"project-1",
		);

		await expect(
			gateway.createGenerationTask({
				userId: "project-1",
				canvasId: "canvas-1",
				canvasVersion: 6,
				nodeId: "audio-node-1",
				modelType: "local-sapi-tts",
				modelParams: {
					prompt: "请用温和语气朗读这段文字。",
					voice: "female",
					language: "zh-CN",
					speed: 0.95,
					tone: "calm",
				},
				idempotencyKey: "action-audio-1:0",
			}),
		).resolves.toEqual({ taskId: "task-audio-1", status: "queued", modality: "audio", nodeId: "audio-node-1" });

		expect(calls[1]).toEqual({
			method: "agent:core:create-generation-task",
			payload: {
				projectId: "project-1",
				canvasId: "canvas-1",
				canvasVersion: 6,
				nodeId: "audio-node-1",
				modality: "audio",
				providerType: "local",
				providerId: "local-sapi-tts",
				modelId: "local-sapi-tts",
				idempotencyKey: "action-audio-1:0",
				prompt: "请用温和语气朗读这段文字。",
				parameters: { voice: "female", language: "zh-CN", speed: 0.95, tone: "calm" },
			},
		});
	});

	it("rejects a disabled SAPI model and keeps the Agent prompt nonempty requirement", async () => {
		const disabledGateway = new DesktopLocalToolGateway(
			{
				request: async () => [{ ...availableSapiModel, enabled: false, unavailableReason: "Windows only" }],
			},
			"project-1",
		);
		await expect(disabledGateway.resolveGenerationModel("project-1", "local-sapi-tts")).rejects.toMatchObject({
			code: "MODEL_UNAVAILABLE",
		});

		const gateway = new DesktopLocalToolGateway(
			{
				request: async (method) => method === "agent:core:list-models" ? [availableSapiModel] : null,
			},
			"project-1",
		);
		await expect(
			gateway.createGenerationTask({
				userId: "project-1",
				canvasId: "canvas-1",
				canvasVersion: 1,
				nodeId: "audio-node-1",
				modelType: "local-sapi-tts",
				modelParams: { prompt: "  " },
				idempotencyKey: "action-audio-empty:0",
			}),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
	});
});
