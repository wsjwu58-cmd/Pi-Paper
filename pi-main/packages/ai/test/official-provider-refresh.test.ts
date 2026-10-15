import { describe, expect, it, vi } from "vitest";
import { executeOfficialGeneration, getOfficialProviderCatalog } from "../src/media/index.ts";

const json = (body: unknown) => Response.json(body);
const audio = () => new Response(new Uint8Array(32).fill(42), { headers: { "content-type": "audio/mpeg" } });

describe("October official provider protocol refresh", () => {
	it("uses the exact Zhipu chat ID, authentication and completion endpoint", async () => {
		const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			expect(String(url)).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-key");
			expect(JSON.parse(String(init?.body))).toMatchObject({ model: "glm-5.3", stream: true, max_tokens: 256 });
			return new Response(
				'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			);
		});
		const result = await executeOfficialGeneration(
			{ providerId: "zhipu", modelId: "glm-5.3", modality: "text", prompt: "hello", params: { maxTokens: 256 } },
			{ apiKey: "fixture-key", fetch },
		);
		expect(result.text).toBe("hello");
	});

	it("submits exact image dimensions and refuses mismatched or unsupported image choices before networking", async () => {
		const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			expect(JSON.parse(String(init?.body))).toMatchObject({
				model: "glm-image",
				size: "1536x1024",
				quality: "hd",
				watermark_enabled: true,
			});
			return json({ data: [{ url: "https://cdn.example/image.png" }] });
		});
		const input = {
			providerId: "zhipu",
			modelId: "glm-image",
			modality: "image" as const,
			prompt: "A quiet field",
			params: { ratio: "3:2", size: "1536x1024" },
		};
		const result = await executeOfficialGeneration(input, { apiKey: "fixture-key", fetch });
		expect(result.outputs?.[0].url).toBe("https://cdn.example/image.png");
		for (const params of [
			{ ratio: "1:1", size: "1536x1024" },
			{ size: "1537x1024" },
			{ count: 2 },
			{ watermark_enabled: false },
		]) {
			await expect(
				executeOfficialGeneration({ ...input, params }, { apiKey: "fixture-key", fetch }),
			).rejects.toThrow();
		}
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("persists CogVideoX submission before polling and recovers without a second submission", async () => {
		const events: string[] = [];
		const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			if (init?.method === "POST") {
				expect(String(url)).toContain("/videos/generations");
				expect(events).toEqual(["submitting"]);
				expect(JSON.parse(String(init.body))).toMatchObject({
					model: "cogvideox-3",
					size: "1080x1920",
					duration: 10,
					with_audio: false,
				});
				return json({ id: "fixture-video", task_status: "PROCESSING" });
			}
			expect(String(url)).toContain("/async-result/fixture-video");
			return json({ task_status: "SUCCESS", video_result: [{ url: "https://cdn.example/video.mp4" }] });
		});
		const input = {
			providerId: "zhipu",
			modelId: "cogvideox-3",
			modality: "video" as const,
			operation: "task" as const,
			prompt: "A quiet field",
			params: { ratio: "9:16", resolution: "1080p", duration: 10, generate_audio: false },
		};
		const options = {
			apiKey: "fixture-key",
			fetch,
			pollIntervalMs: 0,
			sleep: async () => {},
			resolveOutputHost: async () => ["93.184.216.34"],
			onSubmitting: async () => {
				events.push("submitting");
			},
			onSubmitted: async () => {
				events.push("submitted");
			},
		};
		expect((await executeOfficialGeneration(input, options)).outputs?.[0].url).toBe("https://cdn.example/video.mp4");
		expect(events.slice(0, 2)).toEqual(["submitting", "submitted"]);
		await executeOfficialGeneration({ ...input, remoteTaskId: "fixture-video" }, options);
		expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
		await expect(
			executeOfficialGeneration({ ...input, params: { ...input.params, resolution: "4K" } }, options),
		).rejects.toThrow();
	});

	it("routes current Eleven voice and music modes to their documented request bodies", async () => {
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			return audio();
		});
		await executeOfficialGeneration(
			{
				providerId: "elevenlabs",
				modelId: "eleven_v4_turbo",
				modality: "audio",
				operation: "speech",
				prompt: "hello",
				params: { voiceId: "fixture-voice" },
			},
			{ apiKey: "fixture-key", fetch },
		);
		await executeOfficialGeneration(
			{
				providerId: "elevenlabs",
				modelId: "music_v2_5",
				modality: "audio",
				operation: "music",
				prompt: "Gentle acoustic folk",
				params: { lyrics_optimizer: false, lyrics: "Sing beneath the moon", music_length_ms: 20_000 },
			},
			{ apiKey: "fixture-key", fetch },
		);
		await executeOfficialGeneration(
			{
				providerId: "elevenlabs",
				modelId: "music_v2_5",
				modality: "audio",
				operation: "music",
				prompt: "Gentle piano",
				params: { is_instrumental: true },
			},
			{ apiKey: "fixture-key", fetch },
		);
		expect(requests[0]).toMatchObject({
			url: expect.stringContaining("/text-to-dialogue"),
			body: { model_id: "eleven_v4_turbo", inputs: [{ text: "hello", voice_id: "fixture-voice" }] },
		});
		expect(requests[1].body).toMatchObject({
			model_id: "music_v2_5",
			composition_plan: { chunks: [{ text: "Sing beneath the moon", duration_ms: 20_000 }] },
		});
		expect(requests[2].body).toMatchObject({ model_id: "music_v2_5", force_instrumental: true });
	});

	it("marks new exact IDs as implemented without changing the original 72 targets", () => {
		const catalog = getOfficialProviderCatalog();
		expect(catalog.models.filter((model) => model.target)).toHaveLength(72);
		for (const id of [
			"glm-5.3",
			"glm-5.3-flash",
			"glm-5.3-flashx",
			"gpt-6.1-sol",
			"claude-sonnet-5-5",
			"kimi-k3",
			"kimi-k2.7-code",
			"qwen3.8-max",
			"MiniMax-M3",
			"music-3.0",
			"grok-imagine-image-2.0",
			"eleven_v4",
			"music_v2_5",
		]) {
			expect(catalog.models.find((model) => model.apiModelId === id)?.implemented, id).toBe(true);
		}
	});
});
