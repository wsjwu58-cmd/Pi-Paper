import { describe, expect, it, vi } from "vitest";
import {
	ARK_SEEDANCE_25_MODEL_ID,
	ARK_VIDEO_BASE_URL,
	ARK_VIDEO_PROVIDER_ID,
	buildArkVideoRequest,
	generateOfficialVideo,
} from "../src/media/official-videos.ts";
import type { OfficialGenerationInput } from "../src/media/types.ts";

const API_KEY = "ark-test-key-do-not-log";

function videoInput(overrides: Partial<OfficialGenerationInput> = {}): OfficialGenerationInput {
	return {
		providerId: ARK_VIDEO_PROVIDER_ID,
		modelId: ARK_SEEDANCE_25_MODEL_ID,
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

const publicResolver = async () => [{ address: "93.184.216.34" }];

describe("Ark Seedance 2.5 video adapter", () => {
	it("uses adaptive 480p, 15 seconds, and audio by default", () => {
		const request = buildArkVideoRequest(videoInput());
		expect(request.model).toBe(ARK_SEEDANCE_25_MODEL_ID);
		expect(request.ratio).toBe("adaptive");
		expect(request.resolution).toBe("480p");
		expect(request.duration).toBe(15);
		expect(request.generate_audio).toBe(true);
	});

	it("keeps the 4–30 second duration boundary and requires checkpoint support before submission", async () => {
		expect(buildArkVideoRequest(videoInput({ params: { duration: 4 } })).duration).toBe(4);
		expect(buildArkVideoRequest(videoInput({ params: { duration: 30 } })).duration).toBe(30);
		for (const duration of [3, 31]) {
			expect(() => buildArkVideoRequest(videoInput({ params: { duration } }))).toThrow(/4 and 30 seconds/u);
		}
		const fetch = vi.fn();
		await expect(generateOfficialVideo(videoInput(), { apiKey: API_KEY, fetch } as any)).rejects.toMatchObject({
			code: "TASK_CHECKPOINT_REQUIRED",
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("preserves first and last frame behavior, mixed references, and node parameters", () => {
		const input = videoInput({
			params: {
				ratio: "16:9",
				size: "1080P",
				duration: 30,
				generate_audio: false,
				watermark: true,
				camera: "slow push-in",
				style: "ink wash",
			},
			references: [
				{ type: "image", url: "https://images.example.net/first.png?signature=one", role: "first_frame" },
				{ type: "image", url: "https://images.example.net/last.png?signature=two", role: "last_frame" },
				{ type: "video", url: "https://media.example.net/reference.mp4?signature=three", role: "reference_video" },
				{ type: "audio", url: "https://media.example.net/reference.wav?signature=four", role: "reference_audio" },
			],
		});
		const request = buildArkVideoRequest(input);
		expect(request.ratio).toBe("adaptive");
		expect(request.resolution).toBe("1080p");
		expect(request.duration).toBe(30);
		expect(request.generate_audio).toBe(false);
		expect(request.watermark).toBe(true);
		expect((request.content[0] as { text: string }).text).toContain("运镜：slow push-in");
		expect((request.content[0] as { text: string }).text).toContain("风格：ink wash");
		expect(request.content.slice(1)).toEqual([
			{
				type: "image_url",
				image_url: { url: "https://images.example.net/first.png?signature=one" },
				role: "first_frame",
			},
			{
				type: "image_url",
				image_url: { url: "https://images.example.net/last.png?signature=two" },
				role: "last_frame",
			},
			{
				type: "video_url",
				video_url: { url: "https://media.example.net/reference.mp4?signature=three" },
				role: "reference_video",
			},
			{
				type: "audio_url",
				audio_url: { url: "https://media.example.net/reference.wav?signature=four" },
				role: "reference_audio",
			},
		]);
	});

	it("awaits durable submission checkpoint before polling and returns the result URL", async () => {
		const order: string[] = [];
		const requests: Array<{ url: string; method: string; body?: string }> = [];
		const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			requests.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
			if (method === "POST") {
				order.push("POST");
				return jsonResponse({ id: "ark-task-123" }, 202);
			}
			order.push("GET");
			return jsonResponse({
				data: {
					status: "succeeded",
					content: { video_url: { url: "https://results.example.net/output.mp4?token=signed" } },
				},
			});
		});
		const onSubmitted = vi.fn(async (id: string) => {
			order.push(`checkpoint:${id}`);
		});
		const result = await generateOfficialVideo(videoInput(), {
			apiKey: API_KEY,
			baseUrl: ARK_VIDEO_BASE_URL,
			timeoutMs: 5_000,
			fetch,
			onSubmitting: async () => {
				order.push("submitting");
			},
			onSubmitted,
			...({ resolveReferenceHost: publicResolver, pollIntervalMs: 0 } as object),
		} as any);

		expect(order).toEqual(["submitting", "POST", "checkpoint:ark-task-123", "GET"]);
		expect(onSubmitted).toHaveBeenCalledWith("ark-task-123");
		expect(requests[0].url).toBe(`${ARK_VIDEO_BASE_URL}/contents/generations/tasks`);
		expect(JSON.parse(requests[0].body ?? "{}")).toMatchObject({
			model: ARK_SEEDANCE_25_MODEL_ID,
			ratio: "adaptive",
			resolution: "480p",
			duration: 15,
			generate_audio: true,
		});
		expect(requests[0].body).not.toContain(API_KEY);
		expect(result).toEqual({
			outputs: [{ url: "https://results.example.net/output.mp4?token=signed", mimeType: "video/mp4" }],
			remoteTaskId: "ark-task-123",
			status: "succeeded",
		});
	});

	it("resumes by querying an existing task without posting again", async () => {
		const methods: string[] = [];
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			methods.push(init?.method ?? "GET");
			return jsonResponse({ data: { status: "completed", video_url: "https://results.example.net/resumed.mp4" } });
		});
		const onSubmitted = vi.fn();
		const result = await generateOfficialVideo(videoInput({ remoteTaskId: "persisted-task-9" }), {
			apiKey: API_KEY,
			fetch,
			onSubmitted,
			...({ resolveReferenceHost: publicResolver, pollIntervalMs: 0 } as object),
		} as any);
		expect(methods).toEqual(["GET"]);
		expect(onSubmitted).not.toHaveBeenCalled();
		expect(result.remoteTaskId).toBe("persisted-task-9");
	});

	it("retries transient task-query failures without resubmitting", async () => {
		let getCount = 0;
		const methods: string[] = [];
		const delays: number[] = [];
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			methods.push(method);
			if (method === "POST") return jsonResponse({ id: "retry-task" }, 202);
			getCount += 1;
			if (getCount === 1) return jsonResponse({ error: { message: "temporary overload" } }, 503);
			return jsonResponse({ data: { status: "succeeded", url: "https://results.example.net/retry.mp4" } });
		});
		await generateOfficialVideo(videoInput(), {
			apiKey: API_KEY,
			fetch,
			onSubmitted: async () => undefined,
			onSubmitting: async () => undefined,
			...({
				resolveReferenceHost: publicResolver,
				pollIntervalMs: 0,
				sleep: async (ms: number) => {
					delays.push(ms);
				},
				now: () => 0,
			} as object),
		} as any);
		expect(methods).toEqual(["POST", "GET", "GET"]);
		expect(delays).toEqual([1_000]);
	});

	it("does not poll if task checkpoint persistence fails", async () => {
		let gets = 0;
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			if (init?.method === "POST") return jsonResponse({ id: "checkpoint-task" }, 202);
			gets += 1;
			return jsonResponse({ data: { status: "running" } });
		});
		await expect(
			generateOfficialVideo(videoInput(), {
				apiKey: API_KEY,
				fetch,
				onSubmitted: async () => {
					throw new Error("sqlite checkpoint failed");
				},
				onSubmitting: async () => undefined,
				...({ resolveReferenceHost: publicResolver } as object),
			} as any),
		).rejects.toThrow("sqlite checkpoint failed");
		expect(gets).toBe(0);
	});

	it("rejects private references and unsafe result URLs before returning them", async () => {
		const privateInput = videoInput({ references: [{ type: "video", url: "https://127.0.0.1/private.mp4" }] });
		expect(() => buildArkVideoRequest(privateInput)).toThrow(/public HTTPS/u);

		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
			init?.method === "POST"
				? jsonResponse({ id: "bad-result-task" }, 202)
				: jsonResponse({ data: { status: "succeeded", url: "https://127.0.0.1/private.mp4" } }),
		);
		await expect(
			generateOfficialVideo(videoInput(), {
				apiKey: API_KEY,
				fetch,
				onSubmitted: async () => undefined,
				onSubmitting: async () => undefined,
				...({ resolveReferenceHost: publicResolver, pollIntervalMs: 0 } as object),
			} as any),
		).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
	});

	it("rejects non-official API roots and DNS names resolving to private addresses before submission", async () => {
		const fetch = vi.fn();
		const onSubmitted = vi.fn();
		await expect(
			generateOfficialVideo(videoInput(), {
				apiKey: API_KEY,
				baseUrl: "https://attacker.example/api/v3",
				fetch,
				onSubmitted,
			}),
		).rejects.toMatchObject({ code: "INVALID_BASE_URL" });
		expect(fetch).not.toHaveBeenCalled();

		const referenceInput = videoInput({ references: [{ type: "video", url: "https://media.example.net/ref.mp4" }] });
		await expect(
			generateOfficialVideo(referenceInput, {
				apiKey: API_KEY,
				fetch,
				onSubmitted,
				...({ resolveReferenceHost: async () => [{ address: "10.0.0.7" }] } as object),
			} as any),
		).rejects.toMatchObject({ code: "INVALID_MEDIA_REFERENCE" });
		expect(fetch).not.toHaveBeenCalled();
		expect(onSubmitted).not.toHaveBeenCalled();
	});
});
