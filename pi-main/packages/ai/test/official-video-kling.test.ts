import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { getOfficialProviderCatalog } from "../src/media/catalog.ts";
import {
	buildKlingVideoRequest,
	createKlingAuthorizationToken,
	createKlingJwt,
	generateKlingVideo,
} from "../src/media/official-video-kling.ts";
import type { OfficialVideoRuntimeOptions } from "../src/media/official-video-task.ts";
import type { OfficialGenerationInput, OfficialGenerationOptions } from "../src/media/types.ts";

const API_KEY = "kling-single-api-key-fixture";
const ACCESS_KEY = "kling-access-fixture";
const SECRET_KEY = "kling-secret-fixture";

function input(overrides: Partial<OfficialGenerationInput> = {}): OfficialGenerationInput {
	return {
		providerId: "kling",
		modelId: "kling-v3",
		modality: "video",
		operation: "task",
		prompt: "A paper boat drifting beneath a lantern.",
		params: {},
		references: [],
		...overrides,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function options(fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}): OfficialGenerationOptions {
	return {
		credentials: { accessKey: ACCESS_KEY, secretKey: SECRET_KEY },
		fetch,
		...extra,
	} as OfficialGenerationOptions;
}

function decodeJwt(token: string): {
	header: Record<string, unknown>;
	payload: Record<string, unknown>;
	validSignature: boolean;
} {
	const [header, payload, signature] = token.split(".");
	const signingInput = `${header}.${payload}`;
	const expected = createHmac("sha256", SECRET_KEY).update(signingInput).digest("base64url");
	return {
		header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Record<string, unknown>,
		payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>,
		validSignature: signature === expected,
	};
}

describe("official Kling V3 video protocol", () => {
	it("offers the current single API Key and keeps legacy AK/SK as an alternative", () => {
		const kling = getOfficialProviderCatalog().providers.find((provider) => provider.id === "kling");
		expect(kling?.credentialFields).toEqual([
			{ name: "apiKey", label: "Kling API Key（官方；或使用下方旧版 AK/SK）", required: false, secret: true },
			{ name: "accessKey", label: "Kling Access Key（旧版）", required: false, secret: true },
			{ name: "secretKey", label: "Kling Secret Key（旧版）", required: false, secret: true },
		]);
		expect(createKlingAuthorizationToken({ apiKey: API_KEY })).toBe(API_KEY);
		const legacyToken = createKlingAuthorizationToken({ accessKey: ACCESS_KEY, secretKey: SECRET_KEY });
		expect(decodeJwt(legacyToken).validSignature).toBe(true);
		expect(() =>
			createKlingAuthorizationToken({ apiKey: API_KEY, accessKey: ACCESS_KEY, secretKey: SECRET_KEY }),
		).toThrow(/either a Kling API Key/u);
	});

	it("builds the documented v1 text-to-video request and authenticates with Access Key JWT", async () => {
		const calls: Array<{ url: string; method: string; headers: Headers; body?: Record<string, unknown> }> = [];
		const events: string[] = [];
		const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
			const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
			calls.push({
				url: String(url),
				method: init.method ?? "GET",
				headers: new Headers(init.headers),
				...(body ? { body } : {}),
			});
			if (init.method === "POST")
				return jsonResponse({ code: 0, data: { task_id: "kling-v3-task-001", task_status: "submitted" } });
			if (calls.length === 2)
				return jsonResponse({ code: 0, data: { task_id: "kling-v3-task-001", task_status: "processing" } });
			return jsonResponse({
				code: 0,
				data: {
					task_status: "succeed",
					task_result: { videos: [{ url: "https://cdn.kling.ai/generated/clip.mp4" }] },
				},
			});
		});
		const result = await generateKlingVideo(
			input({
				params: {
					duration: 8,
					resolution: "1080p",
					ratio: "9:16",
					generate_audio: true,
					style: "soft paper-cut animation",
					camera: "slow tracking shot",
					count: 1,
				},
			}),
			options(fetch, {
				apiKey: "unused-generic-api-key",
				sleep: async () => undefined,
				resolveOutputHost: async () => ["93.184.216.34"],
				onSubmitting: async () => {
					events.push("submitting");
				},
				onSubmitted: async (taskId: string) => {
					events.push(`submitted:${taskId}`);
				},
			}),
		);

		expect(calls).toHaveLength(3);
		expect(calls[0].url).toBe("https://api-singapore.klingai.com/v1/videos/text2video");
		expect(calls[0].method).toBe("POST");
		expect(calls[0].body).toMatchObject({
			model_name: "kling-v3",
			prompt:
				"A paper boat drifting beneath a lantern.\nStyle: soft paper-cut animation\nCamera movement: slow tracking shot",
			duration: "8",
			mode: "pro",
			sound: "on",
			aspect_ratio: "9:16",
		});
		const auth = calls[0].headers.get("authorization");
		expect(auth).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/u);
		const jwt = decodeJwt(auth!.slice("Bearer ".length));
		expect(jwt.header).toEqual({ alg: "HS256", typ: "JWT" });
		expect(jwt.payload).toMatchObject({ iss: ACCESS_KEY });
		expect(Number(jwt.payload.exp) - Number(jwt.payload.nbf)).toBe(1_805);
		expect(jwt.validSignature).toBe(true);
		for (const call of calls) {
			const requestAuth = call.headers.get("authorization");
			expect(requestAuth).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/u);
			expect(decodeJwt(requestAuth!.slice("Bearer ".length)).validSignature).toBe(true);
		}
		expect(events).toEqual(["submitting", "submitted:kling-v3-task-001"]);
		expect(calls.slice(1).map((call) => [call.method, call.url])).toEqual([
			["GET", "https://api-singapore.klingai.com/v1/videos/text2video/kling-v3-task-001"],
			["GET", "https://api-singapore.klingai.com/v1/videos/text2video/kling-v3-task-001"],
		]);
		expect(result).toEqual({
			outputs: [{ url: "https://cdn.kling.ai/generated/clip.mp4", mimeType: "video/mp4" }],
			remoteTaskId: "kling-v3-task-001",
			status: "succeeded",
		});
	});

	it("sends the current single Kling API Key verbatim for submit and poll requests", async () => {
		const calls: Array<{ method: string; authorization: string | null }> = [];
		const fetch = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
			calls.push({ method: init.method ?? "GET", authorization: new Headers(init.headers).get("authorization") });
			if (init.method === "POST")
				return jsonResponse({ code: 0, data: { task_id: "single-key-task", task_status: "submitted" } });
			return jsonResponse({
				code: 0,
				data: { task_status: "succeed", task_result: { videos: [{ url: "https://cdn.kling.ai/single-key.mp4" }] } },
			});
		});

		const runtime: OfficialVideoRuntimeOptions = {
			apiKey: API_KEY,
			fetch,
			sleep: async () => undefined,
			resolveOutputHost: async () => ["93.184.216.34"],
			onSubmitting: async () => undefined,
			onSubmitted: async () => undefined,
		};
		const result = await generateKlingVideo(input(), runtime);

		expect(calls).toEqual([
			{ method: "POST", authorization: `Bearer ${API_KEY}` },
			{ method: "GET", authorization: `Bearer ${API_KEY}` },
		]);
		expect(result.status).toBe("succeeded");
	});

	it("uses the verified Omni route and its native mode/sound/aspect fields", async () => {
		let body: Record<string, unknown> | undefined;
		const fetch = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
			if (init.method === "POST") {
				body = JSON.parse(String(init.body)) as Record<string, unknown>;
				return jsonResponse({ code: 0, data: { task_id: "omni-01", task_status: "submitted" } });
			}
			return jsonResponse({
				code: 0,
				data: { task_status: "succeed", task_result: { videos: [{ url: "https://cdn.kling.ai/omni.mp4" }] } },
			});
		});
		const result = await generateKlingVideo(
			input({ modelId: "kling-v3-omni", params: { seconds: "15", size: "4K", aspect_ratio: "1:1", sound: "off" } }),
			options(fetch, {
				sleep: async () => undefined,
				resolveOutputHost: async () => ["93.184.216.34"],
				onSubmitting: async () => undefined,
				onSubmitted: async () => undefined,
			}),
		);
		expect(callsUrl(fetch)).toBe("https://api-singapore.klingai.com/v1/videos/omni-video");
		expect(body).toMatchObject({
			model_name: "kling-v3-omni",
			duration: "15",
			mode: "4k",
			aspect_ratio: "1:1",
			sound: "off",
		});
		expect(result.status).toBe("succeeded");
	});

	it("keeps local cancellation local and resumes checkpointed jobs with GET only", async () => {
		const controller = new AbortController();
		const calls: Array<{ method: string; authorization: string | null }> = [];
		const fetch = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
			calls.push({ method: init.method ?? "GET", authorization: new Headers(init.headers).get("authorization") });
			return jsonResponse({ code: 0, data: { task_id: "cancel-me", task_status: "submitted" } });
		});
		await expect(
			generateKlingVideo(
				input(),
				options(fetch, {
					signal: controller.signal,
					sleep: async () => undefined,
					onSubmitting: async () => undefined,
					onSubmitted: async () => {
						controller.abort();
					},
				}),
			),
		).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
		expect(calls.map(({ method }) => method)).toEqual(["POST"]);
		const cancellationJwt = calls[0].authorization!.slice("Bearer ".length);
		expect(cancellationJwt.split(".")).toHaveLength(3);
		expect(decodeJwt(cancellationJwt).validSignature).toBe(true);

		const resumedMethods: string[] = [];
		const resumeFetch = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
			resumedMethods.push(init.method ?? "GET");
			return jsonResponse({
				code: 0,
				data: { task_status: "succeed", task_result: { videos: [{ url: "https://cdn.kling.ai/resumed.mp4" }] } },
			});
		});
		const result = await generateKlingVideo(
			input({ remoteTaskId: "already-submitted" }),
			options(resumeFetch, {
				sleep: async () => undefined,
				resolveOutputHost: async () => ["93.184.216.34"],
			}),
		);
		expect(resumedMethods).toEqual(["GET"]);
		const resumedJwt = new Headers(resumeFetch.mock.calls[0][1]?.headers)
			.get("authorization")!
			.slice("Bearer ".length);
		expect(decodeJwt(resumedJwt).validSignature).toBe(true);
		expect(String(resumeFetch.mock.calls[0][0])).toBe(
			"https://api-singapore.klingai.com/v1/videos/text2video/already-submitted",
		);
		expect(result.remoteTaskId).toBe("already-submitted");

		const newKeyController = new AbortController();
		const newKeyCalls: Array<{ method: string; authorization: string | null }> = [];
		const newKeyFetch = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
			newKeyCalls.push({
				method: init.method ?? "GET",
				authorization: new Headers(init.headers).get("authorization"),
			});
			return jsonResponse({ code: 0, data: { task_id: "single-key-cancel-me", task_status: "submitted" } });
		});
		await expect(
			generateKlingVideo(
				input(),
				options(newKeyFetch, {
					credentials: { apiKey: API_KEY },
					signal: newKeyController.signal,
					sleep: async () => undefined,
					onSubmitting: async () => undefined,
					onSubmitted: async () => {
						newKeyController.abort();
					},
				}),
			),
		).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
		expect(newKeyCalls).toEqual([{ method: "POST", authorization: `Bearer ${API_KEY}` }]);
	});

	it("rejects unsupported route inputs, bad credentials, and uncheckpointed submissions", async () => {
		const fetch = vi.fn(async () => jsonResponse({ code: 0, data: { task_id: "should-not-submit" } }));
		expect(() => buildKlingVideoRequest(input({ params: { duration: 2 } }))).toThrow(/3 to 15/u);
		expect(() => buildKlingVideoRequest(input({ params: { resolution: "1440p" } }))).toThrow(/720p, 1080p, or 4K/u);
		expect(() => buildKlingVideoRequest(input({ params: { aspect_ratio: "2:3" } }))).toThrow(/16:9, 9:16, or 1:1/u);
		expect(() =>
			buildKlingVideoRequest(input({ references: [{ type: "image", url: "https://images.example/ref.png" }] })),
		).toThrow(/text-to-video only/u);
		await expect(generateKlingVideo(input(), { fetch, apiKey: "" })).rejects.toMatchObject({
			code: "API_CREDENTIALS_REQUIRED",
		});
		await expect(
			generateKlingVideo(input(), options(fetch, { credentials: { accessKey: ACCESS_KEY } })),
		).rejects.toMatchObject({ code: "API_CREDENTIALS_REQUIRED" });
		await expect(
			generateKlingVideo(
				input(),
				options(fetch, { credentials: { apiKey: API_KEY, accessKey: ACCESS_KEY, secretKey: SECRET_KEY } }),
			),
		).rejects.toMatchObject({ code: "API_CREDENTIALS_REQUIRED" });
		await expect(
			generateKlingVideo(
				input(),
				options(fetch, { credentials: { apiKey: API_KEY }, apiKey: "different-generic-api-key" }),
			),
		).rejects.toMatchObject({ code: "API_CREDENTIALS_REQUIRED" });
		await expect(generateKlingVideo(input(), options(fetch))).rejects.toMatchObject({
			code: "TASK_CHECKPOINT_REQUIRED",
		});
		await expect(
			generateKlingVideo(
				input(),
				options(fetch, {
					baseUrl: "https://attacker.example",
					onSubmitting: async () => undefined,
					onSubmitted: async () => undefined,
				}),
			),
		).rejects.toMatchObject({ code: "INVALID_BASE_URL" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("matches the official JWT claim window", () => {
		const now = 1_800_000_000;
		const jwt = decodeJwt(createKlingJwt(ACCESS_KEY, SECRET_KEY, now));
		expect(jwt.payload).toEqual({ iss: ACCESS_KEY, exp: now + 1_800, nbf: now - 5 });
		expect(jwt.validSignature).toBe(true);
	});
});

function callsUrl(fetch: ReturnType<typeof vi.fn>): string | undefined {
	return String(fetch.mock.calls[0]?.[0] ?? "");
}
