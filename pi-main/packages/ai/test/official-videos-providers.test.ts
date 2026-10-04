import { describe, expect, it, vi } from "vitest";
import {
	buildMiniMaxVideoRequest,
	MINIMAX_H3_MAX_MODEL_ID,
	MINIMAX_H3_MODEL_ID,
} from "../src/media/official-video-minimax.ts";
import {
	buildWanVideoRequest,
	WAN_30_VIDEO_MODEL_ID,
	WAN_30_VIDEO_PRIME_MODEL_ID,
} from "../src/media/official-video-wan.ts";
import {
	buildXaiVideoRequest,
	XAI_GROK_IMAGINE_VIDEO_15_MODEL_ID,
	XAI_GROK_IMAGINE_VIDEO_MODEL_ID,
} from "../src/media/official-video-xai.ts";
import { generateOfficialVideo } from "../src/media/official-videos.ts";
import type { OfficialGenerationInput, OfficialGenerationOptions } from "../src/media/types.ts";

const API_KEY = "video-provider-test-key-do-not-log";
const outputResolver = async () => [{ address: "93.184.216.34" }];

function videoInput(
	providerId: string,
	modelId: string,
	overrides: Partial<OfficialGenerationInput> = {},
): OfficialGenerationInput {
	return {
		providerId,
		modelId,
		modality: "video",
		prompt: "A paper lantern floats through a rainy street.",
		params: {},
		references: [],
		...overrides,
	};
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

type TestRuntimeOptions = OfficialGenerationOptions & {
	pollIntervalMs: number;
	resolveOutputHost: typeof outputResolver;
};

function runtimeOptions(fetch: typeof globalThis.fetch, extra: Partial<TestRuntimeOptions> = {}): TestRuntimeOptions {
	return {
		apiKey: API_KEY,
		fetch,
		pollIntervalMs: 0,
		onSubmitting: vi.fn(async () => undefined),
		onSubmitted: vi.fn(async () => undefined),
		resolveOutputHost: outputResolver,
		...extra,
	} as TestRuntimeOptions;
}

describe("official video provider protocols", () => {
	it("builds requests from documented xAI model IDs and supported text parameters", () => {
		const input = videoInput("xai", XAI_GROK_IMAGINE_VIDEO_15_MODEL_ID, {
			params: { duration: 10, aspectRatio: "16:9", resolution: "720p", generate_audio: false },
		});
		expect(buildXaiVideoRequest(input)).toEqual({
			model: "grok-imagine-video-1.5",
			prompt: "A paper lantern floats through a rainy street.",
			duration: 10,
			aspect_ratio: "16:9",
			resolution: "720p",
			generate_audio: false,
		});
		expect(() => buildXaiVideoRequest(videoInput("xai", "grok-imagine-video-1-5"))).toThrow(/unavailable/u);
		expect(() =>
			buildXaiVideoRequest(
				videoInput("xai", XAI_GROK_IMAGINE_VIDEO_MODEL_ID, {
					references: [{ type: "image", url: "https://images.example.net/ref.png" }],
				}),
			),
		).toThrow(/text-to-video/u);
	});

	it("builds Wan 3.0 request using verified API model IDs and exact documented region parameters", () => {
		const request = buildWanVideoRequest(
			videoInput("alibaba-video", WAN_30_VIDEO_PRIME_MODEL_ID, {
				params: { resolution: "720p", ratio: "16:9", duration: 10, audio: false, seed: -1, prompt_extend: true },
			}),
		);
		expect(request).toEqual({
			model: "wan3.0-video-prime",
			input: { prompt: "A paper lantern floats through a rainy street." },
			parameters: { resolution: "720P", ratio: "16:9", duration: 10, audio: false, seed: -1, prompt_extend: true },
		});
		expect(buildWanVideoRequest(videoInput("alibaba-video", WAN_30_VIDEO_MODEL_ID)).parameters).toMatchObject({
			resolution: "1080P",
			ratio: "adaptive",
			duration: 5,
		});
		expect(() => buildWanVideoRequest(videoInput("alibaba-video", "wan3.0"))).toThrow(/unavailable/u);
		expect(() =>
			buildWanVideoRequest(
				videoInput("alibaba-video", WAN_30_VIDEO_MODEL_ID, {
					references: [{ type: "video", url: "https://media.example.net/ref.mp4" }],
				}),
			),
		).toThrow(/text-to-video/u);
	});

	it("builds MiniMax H3 and H3 Max text requests with model-specific constraints", () => {
		expect(buildMiniMaxVideoRequest(videoInput("minimax", MINIMAX_H3_MODEL_ID))).toEqual({
			model: "MiniMax-H3",
			content: [{ type: "text", text: "A paper lantern floats through a rainy street." }],
			resolution: "768P",
			duration: 6,
			ratio: "16:9",
		});
		expect(
			buildMiniMaxVideoRequest(
				videoInput("minimax", MINIMAX_H3_MAX_MODEL_ID, {
					params: { resolution: "480p", duration: 5, ratio: "9:16" },
				}),
			),
		).toMatchObject({ model: "MiniMax-H3-Max", resolution: "480P", duration: 5, ratio: "9:16" });
		expect(
			buildMiniMaxVideoRequest(videoInput("minimax", MINIMAX_H3_MODEL_ID, { params: { ratio: "21:9" } })),
		).toMatchObject({ ratio: "21:9" });
		expect(() => buildMiniMaxVideoRequest(videoInput("minimax", "Hailuo-2.3-Fast"))).toThrow(/unavailable/u);
		expect(() =>
			buildMiniMaxVideoRequest(videoInput("minimax", MINIMAX_H3_MODEL_ID, { params: { ratio: "adaptive" } })),
		).toThrow(/fixed aspect ratio/u);
	});

	it("awaits xAI's checkpoint before polling and uses the documented REST request and response", async () => {
		const order: string[] = [];
		const calls: Array<{ url: string; method: string; body?: string; headers?: Headers }> = [];
		const fetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({
				url: String(request),
				method,
				body: typeof init?.body === "string" ? init.body : undefined,
				headers: new Headers(init?.headers),
			});
			if (method === "POST") {
				order.push("POST");
				return jsonResponse({ request_id: "a0aa0a0a-2345-4bcd-8765-123456789abc" }, 202);
			}
			order.push("GET");
			return jsonResponse({ status: "done", video: { url: "https://vidgen.x.ai/generated/video.mp4" } });
		});
		const options = runtimeOptions(fetch, {
			baseUrl: "https://api.x.ai/v1",
			onSubmitting: async () => {
				order.push("preflight");
			},
			onSubmitted: async (id: string) => {
				order.push(`checkpoint:${id}`);
			},
		});

		const result = await generateOfficialVideo(videoInput("xai", XAI_GROK_IMAGINE_VIDEO_MODEL_ID), options);
		expect(order).toEqual(["preflight", "POST", "checkpoint:a0aa0a0a-2345-4bcd-8765-123456789abc", "GET"]);
		expect(calls[0].url).toBe("https://api.x.ai/v1/videos/generations");
		expect(calls[0].headers?.get("authorization")).toBe(`Bearer ${API_KEY}`);
		expect(JSON.parse(calls[0].body ?? "{}")).toEqual({
			model: "grok-imagine-video",
			prompt: "A paper lantern floats through a rainy street.",
			aspect_ratio: "16:9",
			resolution: "480p",
			generate_audio: true,
		});
		expect(calls[1].url).toBe("https://api.x.ai/v1/videos/a0aa0a0a-2345-4bcd-8765-123456789abc");
		expect(result).toEqual({
			outputs: [{ url: "https://vidgen.x.ai/generated/video.mp4", mimeType: "video/mp4" }],
			remoteTaskId: "a0aa0a0a-2345-4bcd-8765-123456789abc",
			status: "succeeded",
		});
	});

	it("submits and polls Wan on the precise workspace endpoint with the asynchronous header", async () => {
		const calls: Array<{ url: string; method: string; headers?: Headers; body?: string }> = [];
		const fetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({
				url: String(request),
				method,
				headers: new Headers(init?.headers),
				body: typeof init?.body === "string" ? init.body : undefined,
			});
			return method === "POST"
				? jsonResponse({ output: { task_id: "wan-task-1", task_status: "PENDING" } }, 200)
				: jsonResponse({
						output: {
							task_id: "wan-task-1",
							task_status: "SUCCEEDED",
							video_url: "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/video.mp4?Expires=2030",
						},
					});
		});
		const result = await generateOfficialVideo(
			videoInput("alibaba-video", WAN_30_VIDEO_MODEL_ID),
			runtimeOptions(fetch, {
				credentials: { workspaceId: "workspace-123", region: "cn-beijing" },
			}),
		);
		expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
		expect(calls[0].url).toBe(
			"https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
		);
		expect(calls[0].headers?.get("x-dashscope-async")).toBe("enable");
		expect(JSON.parse(calls[0].body ?? "{}")).toMatchObject({
			model: "wan3.0-video",
			parameters: { resolution: "1080P", ratio: "adaptive", duration: 5 },
		});
		expect(calls[1].url).toBe("https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/tasks/wan-task-1");
		expect(result).toMatchObject({
			remoteTaskId: "wan-task-1",
			status: "succeeded",
			outputs: [{ mimeType: "video/mp4" }],
		});
	});

	it("uses MiniMax H3 V2 paths, exact model casing, and query response fields", async () => {
		const calls: Array<{ url: string; method: string; body?: string }> = [];
		const fetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({ url: String(request), method, body: typeof init?.body === "string" ? init.body : undefined });
			return method === "POST"
				? jsonResponse({ task_id: "424010985738629" })
				: jsonResponse({
						task: {
							id: "424010985738629",
							model: "MiniMax-H3",
							status: "succeeded",
							content: { url: "https://cdn.hailuoai.com/generated/video.mp4" },
						},
					});
		});
		const result = await generateOfficialVideo(
			videoInput("minimax", MINIMAX_H3_MODEL_ID),
			runtimeOptions(fetch, { baseUrl: "https://api.minimax.io" }),
		);
		expect(calls.map((call) => call.url)).toEqual([
			"https://api.minimax.io/v2/video_generation",
			"https://api.minimax.io/v2/query/video_generation/424010985738629",
		]);
		expect(JSON.parse(calls[0].body ?? "{}")).toMatchObject({
			model: "MiniMax-H3",
			resolution: "768P",
			duration: 6,
			ratio: "16:9",
		});
		expect(result).toMatchObject({
			remoteTaskId: "424010985738629",
			status: "succeeded",
			outputs: [{ url: "https://cdn.hailuoai.com/generated/video.mp4" }],
		});
	});

	it("resumes persisted provider tasks with GET only and does not invoke submission checkpoints", async () => {
		const cases: Array<{
			input: OfficialGenerationInput;
			baseUrl: string;
			credentials?: Record<string, string>;
			response: unknown;
			expected: string;
		}> = [
			{
				input: videoInput("xai", XAI_GROK_IMAGINE_VIDEO_15_MODEL_ID, { remoteTaskId: "xai-resume-2" }),
				baseUrl: "https://api.x.ai/v1",
				response: { status: "done", video: { url: "https://vidgen.x.ai/resume.mp4" } },
				expected: "https://api.x.ai/v1/videos/xai-resume-2",
			},
			{
				input: videoInput("alibaba-video", WAN_30_VIDEO_MODEL_ID, { remoteTaskId: "wan-resume-2" }),
				baseUrl: "https://dashscope.aliyuncs.com/api/v1",
				credentials: { workspaceId: "workspace-123", region: "cn-beijing" },
				response: {
					output: {
						task_status: "SUCCEEDED",
						video_url: "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/resume.mp4",
					},
				},
				expected: "https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/tasks/wan-resume-2",
			},
			{
				input: videoInput("minimax", MINIMAX_H3_MODEL_ID, { remoteTaskId: "424010985738629" }),
				baseUrl: "https://api.minimax.io",
				response: { task: { status: "succeeded", content: { url: "https://cdn.hailuoai.com/resume.mp4" } } },
				expected: "https://api.minimax.io/v2/query/video_generation/424010985738629",
			},
		];
		for (const entry of cases) {
			const methods: string[] = [];
			const fetch = vi.fn(async (_request: string | URL | Request, init?: RequestInit) => {
				methods.push(init?.method ?? "GET");
				return jsonResponse(entry.response);
			});
			const onSubmitting = vi.fn();
			const onSubmitted = vi.fn();
			const options = runtimeOptions(fetch, {
				baseUrl: entry.baseUrl,
				credentials: entry.credentials,
				onSubmitting,
				onSubmitted,
			});
			await generateOfficialVideo(entry.input, options);
			expect(methods).toEqual(["GET"]);
			expect(String(fetch.mock.calls[0][0])).toBe(entry.expected);
			expect(onSubmitting).not.toHaveBeenCalled();
			expect(onSubmitted).not.toHaveBeenCalled();
		}
	});

	it("does not query if task ID persistence fails and never repeats the POST", async () => {
		const fetch = vi.fn(async (_request: string | URL | Request, _init?: RequestInit) =>
			jsonResponse({ task_id: "unpersisted-task" }),
		);
		const onSubmitted = vi.fn(async () => {
			throw new Error("local database unavailable");
		});
		await expect(
			generateOfficialVideo(
				videoInput("minimax", MINIMAX_H3_MODEL_ID),
				runtimeOptions(fetch, {
					baseUrl: "https://api.minimax.io",
					onSubmitted,
				}),
			),
		).rejects.toThrow("local database unavailable");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(String(fetch.mock.calls[0][0])).toBe("https://api.minimax.io/v2/video_generation");
	});

	it("redacts provider error bodies and refuses non-public output URLs", async () => {
		const failedPost = vi.fn(async () =>
			jsonResponse({ error: { message: `invalid request with ${API_KEY} and prompt details` } }, 401),
		);
		await expect(
			generateOfficialVideo(
				videoInput("xai", XAI_GROK_IMAGINE_VIDEO_MODEL_ID),
				runtimeOptions(failedPost, { baseUrl: "https://api.x.ai/v1" }),
			),
		).rejects.toThrow("xAI request failed (401).");
		await expect(
			generateOfficialVideo(
				videoInput("xai", XAI_GROK_IMAGINE_VIDEO_MODEL_ID),
				runtimeOptions(
					async (_request: string | URL | Request, init?: RequestInit) =>
						init?.method === "POST"
							? jsonResponse({ request_id: "unsafe-output-task" })
							: jsonResponse({ status: "done", video: { url: "http://127.0.0.1/private.mp4" } }),
					{
						baseUrl: "https://api.x.ai/v1",
					},
				),
			),
		).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
	});

	it("requires Wan workspace credentials and rejects undocumented regions before network access", async () => {
		const fetch = vi.fn();
		await expect(
			generateOfficialVideo(videoInput("alibaba-video", WAN_30_VIDEO_MODEL_ID), runtimeOptions(fetch)),
		).rejects.toMatchObject({ code: "PROVIDER_CONFIGURATION_REQUIRED" });
		await expect(
			generateOfficialVideo(
				videoInput("alibaba-video", WAN_30_VIDEO_MODEL_ID),
				runtimeOptions(fetch, {
					credentials: { workspaceId: "workspace-123", region: "unknown-region" },
				}),
			),
		).rejects.toMatchObject({ code: "PROVIDER_CONFIGURATION_REQUIRED" });
		expect(fetch).not.toHaveBeenCalled();
	});
});
