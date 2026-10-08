import { describe, expect, it, vi } from "vitest";
import {
	buildAlibaba27VideoRequest,
	HAPPYHORSE_11_I2V_MODEL_ID,
	HAPPYHORSE_11_R2V_MODEL_ID,
	HAPPYHORSE_11_T2V_MODEL_ID,
	WAN_27_I2V_MODEL_IDS,
	WAN_27_R2V_MODEL_ID,
	WAN_27_T2V_MODEL_IDS,
} from "../src/media/official-video-alibaba-27.ts";
import {
	buildHailuo23FastRequest,
	MINIMAX_HAILUO_23_FAST_MODEL_ID,
} from "../src/media/official-video-minimax-hailuo-fast.ts";
import { buildPixVerseV6Request, PIXVERSE_V6_API_MODEL_ID } from "../src/media/official-video-pixverse.ts";
import {
	buildSeedance20Request,
	SEEDANCE_20_ARK_MODEL_ID,
	SEEDANCE_20_BYTEPLUS_MODEL_ID,
	SEEDANCE_20_FAST_ARK_MODEL_ID,
	SEEDANCE_20_FAST_BYTEPLUS_MODEL_ID,
	SEEDANCE_20_MINI_ARK_MODEL_ID,
	SEEDANCE_20_MINI_BYTEPLUS_MODEL_ID,
} from "../src/media/official-video-seedance-20.ts";
import {
	buildGoogleVeoRequest,
	GOOGLE_VEO_31_LITE_MODEL_ID,
	GOOGLE_VEO_31_MODEL_ID,
	generateGoogleVeoVideo,
} from "../src/media/official-video-veo.ts";
import { buildViduQ3Request, VIDU_Q3_PRO_MODEL_ID } from "../src/media/official-video-vidu.ts";
import { generateOfficialVideo } from "../src/media/official-videos.ts";
import type { OfficialGenerationInput, OfficialGenerationOptions } from "../src/media/types.ts";

const API_KEY = "remaining-video-test-key-do-not-log";
const publicResolver = async () => [{ address: "93.184.216.34" }];

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

function runtimeOptions(
	fetch: typeof globalThis.fetch,
	extra: Record<string, unknown> = {},
): OfficialGenerationOptions & Record<string, unknown> {
	return {
		apiKey: API_KEY,
		fetch,
		pollIntervalMs: 0,
		resolveOutputHost: publicResolver,
		onSubmitting: vi.fn(async () => undefined),
		onSubmitted: vi.fn(async () => undefined),
		...extra,
	};
}

describe("remaining official video protocol fixtures", () => {
	it("uses only the six published Seedance 2.0 Ark and BytePlus IDs with version-specific limits", () => {
		const cases = [
			["volcengine-ark", SEEDANCE_20_ARK_MODEL_ID, "4k"],
			["volcengine-ark", SEEDANCE_20_FAST_ARK_MODEL_ID, "720p"],
			["volcengine-ark", SEEDANCE_20_MINI_ARK_MODEL_ID, "720p"],
			["byteplus", SEEDANCE_20_BYTEPLUS_MODEL_ID, "4k"],
			["byteplus", SEEDANCE_20_FAST_BYTEPLUS_MODEL_ID, "720p"],
			["byteplus", SEEDANCE_20_MINI_BYTEPLUS_MODEL_ID, "720p"],
		] as const;
		for (const [providerId, modelId, maxResolution] of cases) {
			const built = buildSeedance20Request(videoInput(providerId, modelId));
			expect(built).toMatchObject({
				model: modelId,
				duration: 5,
				resolution: "720p",
				ratio: "adaptive",
				generate_audio: true,
			});
			if (maxResolution === "720p")
				expect(() =>
					buildSeedance20Request(videoInput(providerId, modelId, { params: { resolution: "1080p" } })),
				).toThrow(/up to 720p/u);
		}
		expect(() => buildSeedance20Request(videoInput("volcengine-ark", "doubao-seedance-1-5-pro-251215"))).toThrow(
			/unavailable/u,
		);
		expect(() =>
			buildSeedance20Request(
				videoInput("volcengine-ark", SEEDANCE_20_ARK_MODEL_ID, { params: { unsupported: true } }),
			),
		).toThrow(/unsupported/u);
	});

	it("submits Seedance on the documented Bearer task endpoint and checkpoints before polling", async () => {
		const order: string[] = [];
		const calls: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
		const fetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({
				url: String(request),
				method,
				headers: new Headers(init?.headers),
				body: typeof init?.body === "string" ? init.body : undefined,
			});
			if (method === "POST") {
				order.push("POST");
				return jsonResponse({ id: "seedance-task-1", status: "queued" });
			}
			order.push("GET");
			return jsonResponse({
				id: "seedance-task-1",
				status: "succeeded",
				content: { video_url: { url: "https://media.example.net/seedance.mp4" } },
			});
		});
		const options = runtimeOptions(fetch, {
			onSubmitting: async () => {
				order.push("preflight");
			},
			onSubmitted: async (id: string) => {
				order.push(`checkpoint:${id}`);
			},
		});
		const result = await generateOfficialVideo(videoInput("volcengine-ark", SEEDANCE_20_ARK_MODEL_ID), options);
		expect(order).toEqual(["preflight", "POST", "checkpoint:seedance-task-1", "GET"]);
		expect(calls[0].url).toBe("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks");
		expect(calls[0].headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
		expect(JSON.parse(calls[0].body ?? "{}")).toMatchObject({
			model: SEEDANCE_20_ARK_MODEL_ID,
			duration: 5,
			resolution: "720p",
			ratio: "adaptive",
			generate_audio: true,
		});
		expect(calls[1].url).toBe("https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/seedance-task-1");
		expect(result).toMatchObject({
			remoteTaskId: "seedance-task-1",
			status: "succeeded",
			outputs: [{ mimeType: "video/mp4" }],
		});
	});

	it("restores Seedance by querying the persisted remote task without resubmitting", async () => {
		const calls: string[] = [];
		const fetch = vi.fn(async (request: string | URL | Request) => {
			calls.push(String(request));
			return jsonResponse({ status: "succeeded", url: "https://media.example.net/restored.mp4" });
		});
		await generateOfficialVideo(
			videoInput("volcengine-ark", SEEDANCE_20_ARK_MODEL_ID, { remoteTaskId: "seedance-task-recovered" }),
			runtimeOptions(fetch),
		);
		expect(calls).toEqual([
			"https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/seedance-task-recovered",
		]);
	});

	it("builds Vidu Q3 text, image, and start/end requests and validates audio aliases", () => {
		const text = buildViduQ3Request(videoInput("vidu", VIDU_Q3_PRO_MODEL_ID));
		expect(text).toMatchObject({
			path: "text2video",
			request: { model: "viduq3-pro", duration: 5, resolution: "720p", audio: true, aspect_ratio: "16:9" },
		});
		const image = buildViduQ3Request(
			videoInput("vidu", VIDU_Q3_PRO_MODEL_ID, {
				references: [{ type: "image", url: "https://images.example.net/start.png" }],
			}),
		);
		expect(image).toMatchObject({ path: "img2video", request: { images: ["https://images.example.net/start.png"] } });
		const frames = buildViduQ3Request(
			videoInput("vidu", VIDU_Q3_PRO_MODEL_ID, {
				references: [
					{ type: "image", url: "https://images.example.net/start.png", role: "first_frame" },
					{ type: "image", url: "https://images.example.net/end.png", role: "last_frame" },
				],
			}),
		);
		expect(frames).toMatchObject({
			path: "start-end2video",
			request: { images: ["https://images.example.net/start.png", "https://images.example.net/end.png"] },
		});
		expect(() =>
			buildViduQ3Request(videoInput("vidu", VIDU_Q3_PRO_MODEL_ID, { params: { audio: "false" } })),
		).toThrow(/boolean/u);
		expect(() =>
			buildViduQ3Request(
				videoInput("vidu", VIDU_Q3_PRO_MODEL_ID, { params: { audio: true, generate_audio: false } }),
			),
		).toThrow(/conflicting/u);
		expect(() => buildViduQ3Request(videoInput("vidu", VIDU_Q3_PRO_MODEL_ID, { params: { mystery: 1 } }))).toThrow(
			/does not support/u,
		);
		expect(() =>
			buildViduQ3Request(
				videoInput("vidu", VIDU_Q3_PRO_MODEL_ID, {
					params: { ratio: "16:9" },
					references: [{ type: "image", url: "https://images.example.net/start.png" }],
				}),
			),
		).toThrow(/derived from the input frame/u);
	});

	it("submits Vidu with Token authentication, the official operation route, and query status", async () => {
		const calls: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
		const fetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({
				url: String(request),
				method,
				headers: new Headers(init?.headers),
				body: typeof init?.body === "string" ? init.body : undefined,
			});
			return method === "POST"
				? jsonResponse({ task_id: "vidu-task-1", state: "created" })
				: jsonResponse({ state: "success", creations: [{ url: "https://media.example.net/vidu.mp4" }] });
		});
		const result = await generateOfficialVideo(videoInput("vidu", VIDU_Q3_PRO_MODEL_ID), runtimeOptions(fetch));
		expect(calls.map((call) => call.url)).toEqual([
			"https://api.vidu.com/ent/v2/text2video",
			"https://api.vidu.com/ent/v2/tasks/vidu-task-1/creations",
		]);
		expect(calls[0].headers.get("authorization")).toBe(`Token ${API_KEY}`);
		expect(JSON.parse(calls[0].body ?? "{}")).toMatchObject({
			model: "viduq3-pro",
			duration: 5,
			resolution: "720p",
			audio: true,
		});
		expect(result).toMatchObject({
			remoteTaskId: "vidu-task-1",
			status: "succeeded",
			outputs: [{ mimeType: "video/mp4" }],
		});
	});

	it("builds exact PixVerse V6 parameters and requires a fresh trace ID for each request", async () => {
		const built = buildPixVerseV6Request(
			videoInput("pixverse", PIXVERSE_V6_API_MODEL_ID, {
				params: { duration: 8, quality: "1080p", ratio: "21:9", generate_audio_switch: false },
			}),
		);
		expect(built).toMatchObject({
			model: "v6",
			duration: 8,
			quality: "1080p",
			aspect_ratio: "21:9",
			generate_audio_switch: false,
		});
		expect(() =>
			buildPixVerseV6Request(videoInput("pixverse", PIXVERSE_V6_API_MODEL_ID, { params: { unknown: true } })),
		).toThrow(/does not support/u);
		const calls: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
		const fetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({
				url: String(request),
				method,
				headers: new Headers(init?.headers),
				body: typeof init?.body === "string" ? init.body : undefined,
			});
			return method === "POST"
				? jsonResponse({ ErrCode: 0, Resp: { video_id: "20261003001" } })
				: jsonResponse({ ErrCode: 0, Resp: { status: 1, url: "https://media.example.net/pixverse.mp4" } });
		});
		const result = await generateOfficialVideo(
			videoInput("pixverse", PIXVERSE_V6_API_MODEL_ID),
			runtimeOptions(fetch),
		);
		expect(calls.map((call) => call.url)).toEqual([
			"https://app-api.pixverse.ai/openapi/v2/video/text/generate",
			"https://app-api.pixverse.ai/openapi/v2/video/result/20261003001",
		]);
		expect(calls[0].headers.get("api-key")).toBe(API_KEY);
		expect(calls[0].headers.get("ai-trace-id")).toMatch(/^[0-9a-f-]{36}$/iu);
		expect(calls[1].headers.get("ai-trace-id")).not.toBe(calls[0].headers.get("ai-trace-id"));
		expect(JSON.parse(calls[0].body ?? "{}")).toMatchObject({
			model: "v6",
			duration: 5,
			quality: "720p",
			aspect_ratio: "16:9",
		});
		expect(result).toMatchObject({
			remoteTaskId: "20261003001",
			status: "succeeded",
			outputs: [{ mimeType: "video/mp4" }],
		});
	});

	it("builds Veo 3.1/Lite requests with exact preview IDs and duration-resolution combinations", () => {
		expect(buildGoogleVeoRequest(videoInput("google", GOOGLE_VEO_31_MODEL_ID))).toMatchObject({
			parameters: { aspectRatio: "16:9", durationSeconds: "8", resolution: "720p" },
		});
		expect(
			buildGoogleVeoRequest(
				videoInput("google", GOOGLE_VEO_31_LITE_MODEL_ID, { params: { duration: 4, resolution: "720p" } }),
			),
		).toMatchObject({ parameters: { durationSeconds: "4", resolution: "720p" } });
		expect(() =>
			buildGoogleVeoRequest(
				videoInput("google", GOOGLE_VEO_31_MODEL_ID, { params: { duration: 6, resolution: "1080p" } }),
			),
		).toThrow(/requires an 8-second/u);
		expect(() =>
			buildGoogleVeoRequest(videoInput("google", GOOGLE_VEO_31_LITE_MODEL_ID, { params: { resolution: "4k" } })),
		).toThrow(/resolution is unsupported/u);
		expect(() =>
			buildGoogleVeoRequest(videoInput("google", GOOGLE_VEO_31_MODEL_ID, { params: { generate_audio: false } })),
		).toThrow(/does not expose an audio toggle/u);
		expect(() =>
			buildGoogleVeoRequest(videoInput("google", GOOGLE_VEO_31_MODEL_ID, { params: { generate_audio: true } })),
		).toThrow(/does not expose an audio toggle/u);
		expect(() =>
			buildGoogleVeoRequest(videoInput("google", GOOGLE_VEO_31_MODEL_ID, { params: { unverifiedParameter: true } })),
		).toThrow(/does not support/u);
	});

	it("checkpoints Veo before submit, downloads from the exact authenticated Google host, and returns MP4 bytes", async () => {
		const order: string[] = [];
		const calls: Array<{
			url: string;
			method: string;
			headers: Headers;
			body?: string;
			redirect?: RequestInit["redirect"];
		}> = [];
		const file = new Uint8Array(12);
		file.set([0x66, 0x74, 0x79, 0x70], 4);
		const fetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({
				url: String(request),
				method,
				headers: new Headers(init?.headers),
				body: typeof init?.body === "string" ? init.body : undefined,
				redirect: init?.redirect,
			});
			if (method === "POST") {
				order.push("POST");
				return jsonResponse({ name: `models/${GOOGLE_VEO_31_MODEL_ID}/operations/op-123` });
			}
			if (String(request).endsWith("/operations/op-123")) {
				order.push("GET-operation");
				return jsonResponse({
					done: true,
					response: {
						generateVideoResponse: {
							generatedSamples: [
								{
									video: {
										uri: "https://generativelanguage.googleapis.com/v1beta/files/file-123:download?alt=media",
									},
								},
							],
						},
					},
				});
			}
			order.push("GET-file");
			return new Response(file, { status: 200, headers: { "Content-Type": "video/mp4" } });
		});
		const options = runtimeOptions(fetch, {
			onSubmitting: async () => {
				order.push("preflight");
			},
			onSubmitted: async (id: string) => {
				order.push(`checkpoint:${id}`);
			},
		});
		const result = await generateOfficialVideo(videoInput("google", GOOGLE_VEO_31_MODEL_ID), options);
		expect(order).toEqual([
			"preflight",
			"POST",
			`checkpoint:models/${GOOGLE_VEO_31_MODEL_ID}/operations/op-123`,
			"GET-operation",
			"GET-file",
		]);
		expect(calls[0].url).toBe(
			`https://generativelanguage.googleapis.com/v1beta/models/${GOOGLE_VEO_31_MODEL_ID}:predictLongRunning`,
		);
		expect(calls.every((call) => call.headers.get("x-goog-api-key") === API_KEY)).toBe(true);
		expect(calls[2].redirect).toBe("error");
		expect(result).toMatchObject({ status: "succeeded", outputs: [{ mimeType: "video/mp4" }] });
		expect(result.outputs?.[0].base64).toBe(Buffer.from(file).toString("base64"));
	});

	it("refuses arbitrary Veo output hosts before placing the Google key on a download request", async () => {
		const calls: string[] = [];
		const fetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			calls.push(`${String(request)} ${new Headers(init?.headers).get("x-goog-api-key") ? "key" : "no-key"}`);
			return init?.method === "POST"
				? jsonResponse({ name: `models/${GOOGLE_VEO_31_MODEL_ID}/operations/op-123` })
				: jsonResponse({
						done: true,
						response: {
							generateVideoResponse: {
								generatedSamples: [
									{ video: { uri: "https://attacker.example.net/v1beta/files/leak:download?alt=media" } },
								],
							},
						},
					});
		});
		await expect(
			generateGoogleVeoVideo(videoInput("google", GOOGLE_VEO_31_MODEL_ID), runtimeOptions(fetch)),
		).rejects.toThrow(/outside the official Gemini file-download path/u);
		expect(calls).toEqual([
			`https://generativelanguage.googleapis.com/v1beta/models/${GOOGLE_VEO_31_MODEL_ID}:predictLongRunning key`,
			`https://generativelanguage.googleapis.com/v1beta/models/${GOOGLE_VEO_31_MODEL_ID}/operations/op-123 key`,
		]);
	});

	it("blocks Google file redirects and resumes Veo with GET-only after a persisted operation", async () => {
		const calls: Array<{ url: string; method: string }> = [];
		const fetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({ url: String(request), method });
			if (String(request).includes("/operations/"))
				return jsonResponse({
					done: true,
					response: {
						generateVideoResponse: {
							generatedSamples: [
								{
									video: {
										uri: "https://generativelanguage.googleapis.com/v1beta/files/file-123:download?alt=media",
									},
								},
							],
						},
					},
				});
			return new Response(null, { status: 302, headers: { Location: "https://cdn.example.net/file.mp4" } });
		});
		await expect(
			generateGoogleVeoVideo(
				videoInput("google", GOOGLE_VEO_31_MODEL_ID, {
					remoteTaskId: `models/${GOOGLE_VEO_31_MODEL_ID}/operations/op-123`,
				}),
				runtimeOptions(fetch),
			),
		).rejects.toThrow(/redirected/u);
		expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
	});

	it("builds exact Wan 2.7 and HappyHorse 1.1 model-specific request shapes and constraints", () => {
		const wanText = buildAlibaba27VideoRequest(videoInput("alibaba-video", WAN_27_T2V_MODEL_IDS[0]));
		expect(wanText).toMatchObject({
			model: "wan2.7-t2v",
			input: { prompt: expect.any(String) },
			parameters: { resolution: "1080P", ratio: "16:9", duration: 5, prompt_extend: true, watermark: false },
		});
		const wanImage = buildAlibaba27VideoRequest(
			videoInput("alibaba-video", WAN_27_I2V_MODEL_IDS[0], {
				params: {
					firstFrameUrl: "https://images.example.net/first.png",
					lastFrameUrl: "https://images.example.net/last.png",
					ratio: "adaptive",
				},
				references: [
					{ type: "image", url: "https://images.example.net/first.png", role: "first_frame" },
					{ type: "image", url: "https://images.example.net/last.png", role: "last_frame" },
				],
			}),
		);
		expect(wanImage.input.media).toEqual([
			{ type: "first_frame", url: "https://images.example.net/first.png" },
			{ type: "last_frame", url: "https://images.example.net/last.png" },
		]);
		expect(wanImage.parameters).not.toHaveProperty("ratio");
		expect(() =>
			buildAlibaba27VideoRequest(
				videoInput("alibaba-video", WAN_27_I2V_MODEL_IDS[0], {
					params: { firstFrameUrl: "https://images.example.net/a.png", ratio: "16:9" },
				}),
			),
		).toThrow(/derived from the input frame/u);
		expect(() =>
			buildAlibaba27VideoRequest(
				videoInput("alibaba-video", WAN_27_R2V_MODEL_ID, {
					params: { duration: 11 },
					references: [{ type: "image", url: "https://images.example.net/ref.png" }],
				}),
			),
		).toThrow(/2–10/u);
		expect(
			buildAlibaba27VideoRequest(
				videoInput("alibaba-video", HAPPYHORSE_11_T2V_MODEL_ID, { params: { ratio: "9:21" } }),
			),
		).toMatchObject({
			model: "happyhorse-1.1-t2v",
			parameters: { resolution: "1080P", duration: 5, ratio: "9:21", watermark: true },
		});
		expect(
			buildAlibaba27VideoRequest(
				videoInput("alibaba-video", HAPPYHORSE_11_I2V_MODEL_ID, {
					params: { firstFrameUrl: "https://images.example.net/start.png", imageAspectRatio: "adaptive" },
				}),
			),
		).toMatchObject({
			model: "happyhorse-1.1-i2v",
			input: { media: [{ type: "first_frame" }] },
			parameters: { duration: 5 },
		});
		expect(
			buildAlibaba27VideoRequest(
				videoInput("alibaba-video", HAPPYHORSE_11_R2V_MODEL_ID, {
					references: Array.from({ length: 9 }, (_, index) => ({
						type: "image" as const,
						url: `https://images.example.net/ref-${index}.png`,
					})),
				}),
			),
		).toMatchObject({
			model: "happyhorse-1.1-r2v",
			input: { media: Array.from({ length: 9 }, () => ({ type: "reference_image", url: expect.any(String) })) },
		});
		expect(() => buildAlibaba27VideoRequest(videoInput("alibaba-video", "happyhorse-1.0-t2v"))).toThrow(
			/unavailable/u,
		);
	});

	it("submits Alibaba video tasks after durable checkpoints and restores them with GET-only polling", async () => {
		const order: string[] = [];
		const calls: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
		const fetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({
				url: String(request),
				method,
				headers: new Headers(init?.headers),
				body: typeof init?.body === "string" ? init.body : undefined,
			});
			if (method === "POST") return jsonResponse({ output: { task_id: "wan27-task-1", task_status: "PENDING" } });
			return jsonResponse({
				output: {
					task_id: "wan27-task-1",
					task_status: "SUCCEEDED",
					video_url: "https://media.example.net/wan27.mp4",
				},
			});
		});
		const options = runtimeOptions(fetch, {
			baseUrl: "https://dashscope.aliyuncs.com/api/v1",
			credentials: { workspaceId: "workspace1", region: "ap-southeast-1" },
			onSubmitting: async () => {
				order.push("preflight");
			},
			onSubmitted: async (id: string) => {
				order.push(`checkpoint:${id}`);
			},
		});
		const result = await generateOfficialVideo(videoInput("alibaba-video", WAN_27_T2V_MODEL_IDS[1]), options);
		expect(order).toEqual(["preflight", "checkpoint:wan27-task-1"]);
		expect(calls[0].url).toBe(
			"https://workspace1.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
		);
		expect(calls[0].headers.get("x-dashscope-async")).toBe("enable");
		expect(calls[0].headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
		expect(calls[1].url).toBe("https://workspace1.ap-southeast-1.maas.aliyuncs.com/api/v1/tasks/wan27-task-1");
		expect(result).toMatchObject({
			remoteTaskId: "wan27-task-1",
			status: "succeeded",
			outputs: [{ url: "https://media.example.net/wan27.mp4", mimeType: "video/mp4" }],
		});
		const recoveredCalls: string[] = [];
		const recoveryFetch = vi.fn(async (request: string | URL | Request) => {
			recoveredCalls.push(String(request));
			return jsonResponse({
				output: { task_status: "SUCCEEDED", video_url: "https://media.example.net/restored-wan.mp4" },
			});
		});
		await generateOfficialVideo(
			videoInput("alibaba-video", WAN_27_T2V_MODEL_IDS[0], { remoteTaskId: "wan27-task-recovered" }),
			runtimeOptions(recoveryFetch, { credentials: { workspaceId: "workspace1", region: "ap-southeast-1" } }),
		);
		expect(recoveredCalls).toEqual([
			"https://workspace1.ap-southeast-1.maas.aliyuncs.com/api/v1/tasks/wan27-task-recovered",
		]);
	});

	it("dispatches HappyHorse 1.1 through its exact official text-to-video model and checkpoints before querying", async () => {
		const order: string[] = [];
		const calls: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
		const fetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			const url = String(request);
			calls.push({
				url,
				method,
				headers: new Headers(init?.headers),
				body: typeof init?.body === "string" ? init.body : undefined,
			});
			if (method === "POST") {
				order.push("POST");
				return jsonResponse({ output: { task_id: "happyhorse11-task-1", task_status: "PENDING" } });
			}
			order.push("GET");
			return jsonResponse({
				output: {
					task_id: "happyhorse11-task-1",
					task_status: "SUCCEEDED",
					video_url: "https://media.example.net/happyhorse11.mp4",
				},
			});
		});
		const options = runtimeOptions(fetch, {
			baseUrl: "https://dashscope.aliyuncs.com/api/v1",
			credentials: { workspaceId: "workspace1", region: "ap-southeast-1" },
			onSubmitting: async () => {
				order.push("preflight");
			},
			onSubmitted: async (id: string) => {
				order.push(`checkpoint:${id}`);
			},
		});
		const result = await generateOfficialVideo(videoInput("alibaba-video", HAPPYHORSE_11_T2V_MODEL_ID), options);
		expect(order).toEqual(["preflight", "POST", "checkpoint:happyhorse11-task-1", "GET"]);
		expect(calls.map((call) => call.url)).toEqual([
			"https://workspace1.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
			"https://workspace1.ap-southeast-1.maas.aliyuncs.com/api/v1/tasks/happyhorse11-task-1",
		]);
		expect(calls[0].headers.get("x-dashscope-async")).toBe("enable");
		expect(calls[0].headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
		expect(JSON.parse(calls[0].body ?? "{}")).toMatchObject({
			model: "happyhorse-1.1-t2v",
			input: { prompt: expect.any(String) },
			parameters: { resolution: "1080P", duration: 5, ratio: "16:9", watermark: true },
		});
		expect(result).toMatchObject({
			remoteTaskId: "happyhorse11-task-1",
			status: "succeeded",
			outputs: [{ url: "https://media.example.net/happyhorse11.mp4", mimeType: "video/mp4" }],
		});
	});

	it("builds the official Hailuo 2.3 Fast image request and rejects unsupported combinations", () => {
		const built = buildHailuo23FastRequest(
			videoInput("minimax", MINIMAX_HAILUO_23_FAST_MODEL_ID, {
				params: { firstFrameUrl: "https://images.example.net/hailuo.png", duration: 10 },
				references: [
					{ type: "image", url: "https://images.example.net/hailuo.png", role: "first_frame" },
					{ type: "image", url: "https://images.example.net/hailuo.png", role: "reference_image" },
				],
			}),
		);
		expect(built).toMatchObject({
			model: MINIMAX_HAILUO_23_FAST_MODEL_ID,
			first_frame_image: "https://images.example.net/hailuo.png",
			duration: 10,
			resolution: "768P",
			prompt_optimizer: true,
			fast_pretreatment: false,
		});
		expect(() =>
			buildHailuo23FastRequest(
				videoInput("minimax", MINIMAX_HAILUO_23_FAST_MODEL_ID, {
					params: { firstFrameUrl: "https://images.example.net/a.png", duration: 10, resolution: "1080P" },
				}),
			),
		).toThrow(/only at 6 seconds/u);
		expect(() =>
			buildHailuo23FastRequest(
				videoInput("minimax", MINIMAX_HAILUO_23_FAST_MODEL_ID, {
					params: { firstFrameUrl: "https://images.example.net/a.png", ratio: "16:9" },
				}),
			),
		).toThrow(/derived from the starting image/u);
		expect(() =>
			buildHailuo23FastRequest(
				videoInput("minimax", MINIMAX_HAILUO_23_FAST_MODEL_ID, {
					params: { firstFrameUrl: "https://images.example.net/a.png", generate_audio: false },
				}),
			),
		).toThrow(/does not expose a generated-audio control/u);
		expect(() =>
			buildHailuo23FastRequest(
				videoInput("minimax", MINIMAX_HAILUO_23_FAST_MODEL_ID, {
					references: [{ type: "image", url: "https://images.example.net/a.png", role: "last_frame" }],
				}),
			),
		).toThrow(/starting frame/u);
		expect(() => buildHailuo23FastRequest(videoInput("minimax", "MiniMax-Hailuo-2.3"))).toThrow(/unavailable/u);
	});

	it("uses MiniMax Bearer auth for Hailuo submit/query/file lookup and returns only the public URL to the Worker", async () => {
		const order: string[] = [];
		const calls: Array<{
			url: string;
			method: string;
			headers: Headers;
			body?: string;
			redirect?: RequestInit["redirect"];
		}> = [];
		const fetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			const url = String(request);
			calls.push({
				url,
				method,
				headers: new Headers(init?.headers),
				body: typeof init?.body === "string" ? init.body : undefined,
				redirect: init?.redirect,
			});
			if (method === "POST") {
				order.push("POST");
				return jsonResponse({ task_id: "hailuo-task-1", base_resp: { status_code: 0 } });
			}
			if (url.includes("/query/video_generation")) {
				order.push("QUERY");
				return jsonResponse({
					task_id: "hailuo-task-1",
					status: "Success",
					file_id: "987654321",
					base_resp: { status_code: 0, status_msg: "success" },
				});
			}
			order.push("FILE");
			return jsonResponse({
				file: {
					file_id: "987654321",
					purpose: "video_generation",
					download_url: "https://media.example.net/hailuo.mp4",
				},
				base_resp: { status_code: 0, status_msg: "success" },
			});
		});
		const options = runtimeOptions(fetch, {
			onSubmitting: async () => {
				order.push("preflight");
			},
			onSubmitted: async (id: string) => {
				order.push(`checkpoint:${id}`);
			},
		});
		const result = await generateOfficialVideo(
			videoInput("minimax", MINIMAX_HAILUO_23_FAST_MODEL_ID, {
				params: { firstFrameUrl: "https://images.example.net/start.png" },
			}),
			options,
		);
		expect(order).toEqual(["preflight", "POST", "checkpoint:hailuo-task-1", "QUERY", "FILE"]);
		expect(calls.map((call) => call.url)).toEqual([
			"https://api.minimax.io/v1/video_generation",
			"https://api.minimax.io/v1/query/video_generation?task_id=hailuo-task-1",
			"https://api.minimax.io/v1/files/retrieve?file_id=987654321",
		]);
		expect(calls.every((call) => call.headers.get("authorization") === `Bearer ${API_KEY}`)).toBe(true);
		expect(calls[0].body).toContain(`"model":"${MINIMAX_HAILUO_23_FAST_MODEL_ID}"`);
		expect(calls[2].redirect).toBe("error");
		expect(result).toMatchObject({
			remoteTaskId: "hailuo-task-1",
			status: "succeeded",
			outputs: [{ url: "https://media.example.net/hailuo.mp4", mimeType: "video/mp4" }],
		});
	});

	it("rejects Hailuo task and file responses unless official base_resp status is zero", async () => {
		const calls: string[] = [];
		const fetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const url = String(request);
			calls.push(url);
			if (init?.method === "POST")
				return jsonResponse({ task_id: "hailuo-task-invalid", base_resp: { status_code: 0 } });
			if (url.includes("/query/video_generation"))
				return jsonResponse({
					status: "Success",
					file_id: "987654322",
					base_resp: { status_code: 11, status_msg: "error" },
				});
			return jsonResponse({
				file: {
					file_id: "987654322",
					purpose: "video_generation",
					download_url: "https://media.example.net/hailuo.mp4",
				},
				base_resp: { status_code: 11, status_msg: "error" },
			});
		});
		const input = videoInput("minimax", MINIMAX_HAILUO_23_FAST_MODEL_ID, {
			params: { firstFrameUrl: "https://images.example.net/start.png" },
		});
		await expect(generateOfficialVideo(input, runtimeOptions(fetch))).rejects.toThrow(/request failed/u);
		expect(calls).toHaveLength(2);
		const fileFetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const url = String(request);
			if (init?.method === "POST")
				return jsonResponse({ task_id: "hailuo-task-invalid-file", base_resp: { status_code: 0 } });
			if (url.includes("/query/video_generation"))
				return jsonResponse({ status: "Success", file_id: "987654323", base_resp: { status_code: 0 } });
			return jsonResponse({
				file: {
					file_id: "987654323",
					purpose: "video_generation",
					download_url: "https://media.example.net/hailuo.mp4",
				},
				base_resp: { status_code: 11, status_msg: "error" },
			});
		});
		await expect(generateOfficialVideo(input, runtimeOptions(fileFetch))).rejects.toThrow(/request failed/u);
		expect(fileFetch).toHaveBeenCalledTimes(3);
	});
});
