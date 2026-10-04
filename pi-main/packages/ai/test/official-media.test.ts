import { describe, expect, it, vi } from "vitest";
import { OfficialProviderError, redactSecret, resolveBaseUrl } from "../src/media/http.ts";
import {
	executeOfficialGeneration,
	getOfficialProviderCatalog,
	OFFICIAL_TARGET_COUNTS,
	resolveOfficialTextModel,
	testOfficialProviderConnection,
} from "../src/media/index.ts";

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

describe("official provider catalog", () => {
	it("keeps the 72 targets and only marks verified routes implemented", () => {
		expect(OFFICIAL_TARGET_COUNTS).toEqual({ total: 72, text: 20, image: 16, video: 25, audio: 11 });
		const catalog = getOfficialProviderCatalog();
		const byName = (name: string) => catalog.models.find((model) => model.name === name)!;
		expect(catalog.providers.find((provider) => provider.id === "openai")?.credentialFields[0]).toMatchObject({
			name: "apiKey",
			required: true,
			secret: true,
		});
		expect(catalog.providers.some((provider) => provider.id === "banana")).toBe(false);
		expect(byName("GPT-Image-2")).toMatchObject({
			implemented: true,
			apiModelId: "gpt-image-2",
			inputModes: ["text", "image"],
			defaults: { size: "1K", ratio: "1:1", count: 1 },
		});
		expect(byName("DeepSeek V4.1 Flash")).toMatchObject({
			implemented: true,
			apiModelId: "deepseek-flash",
			contextWindow: 1_000_000,
			maxTokens: 8192,
			metadataStatus: "verified",
		});
		expect(byName("Eleven Flash v2.5")).toMatchObject({
			implemented: true,
			apiModelId: "eleven_flash_v2_5",
			operation: "speech",
		});
		expect(byName("Agnes Image 2.5 Flash")).toMatchObject({
			implemented: true,
			route: "legacy-agnes",
			apiModelId: "agnes-image-2.5-flash",
			inputModes: ["text", "image"],
		});
		expect(byName("Seedance 2.5")).toMatchObject({
			implemented: true,
			route: "legacy-ark",
			inputModes: ["text", "image", "video", "audio"],
			defaults: { resolution: "480p", ratio: "adaptive", duration: 15, generate_audio: true },
		});
		expect(byName("Banana 2")).toMatchObject({
			implemented: true,
			providerId: "google",
			apiModelId: "gemini-3.1-flash-image",
		});
	});

	it("resolves a known DeepSeek model with verified context and a conservative output cap", () => {
		const resolved = resolveOfficialTextModel(
			{ providerId: "deepseek", modelId: "deepseek-flash" },
			{ apiKey: "secret" },
		);
		expect(resolved.model).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			contextWindow: 1_000_000,
			maxTokens: 8192,
		});
		expect(JSON.stringify(resolved.model)).not.toContain("secret");
		expect(resolved.apiKey).toBe("secret");
	});
});

describe("official media HTTP adapters", () => {
	it("maps OpenAI image count and aspect ratio to the documented request size", async () => {
		let calledUrl = "";
		let requestBody = "";
		const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			calledUrl = String(input);
			requestBody = String(init?.body);
			return jsonResponse({
				data: [
					{ b64_json: "aGVsbG8=", output_format: "png" },
					{ b64_json: "aGVsbG8=", output_format: "png" },
				],
			});
		});
		const result = await executeOfficialGeneration(
			{
				providerId: "openai",
				modelId: "gpt-image-2",
				modality: "image",
				prompt: "a paper kite",
				params: { ratio: "3:2", count: 2 },
			},
			{ apiKey: "sk-test", fetch },
		);
		expect(calledUrl).toBe("https://api.openai.com/v1/images/generations");
		expect(JSON.parse(requestBody)).toMatchObject({ model: "gpt-image-2", n: 2, size: "1536x1024" });
		expect(result.outputs).toHaveLength(2);
	});

	it("routes references to multipart edits and separates the PNG mask", async () => {
		let calledUrl = "";
		let form: FormData | undefined;
		const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			calledUrl = String(input);
			form = init?.body as FormData;
			return jsonResponse({ data: [{ b64_json: "aGVsbG8=" }] });
		});
		await executeOfficialGeneration(
			{
				providerId: "openai",
				modelId: "gpt-image-2",
				modality: "image",
				operation: "generation",
				prompt: "replace the sky",
				references: [
					{ type: "image", base64: "aGVsbG8=", mimeType: "image/png" },
					{ type: "image", role: "mask", base64: "aGVsbG8=", mimeType: "image/png" },
				],
			},
			{ apiKey: "sk-test", fetch },
		);
		expect(calledUrl).toBe("https://api.openai.com/v1/images/edits");
		expect(form?.getAll("image[]")).toHaveLength(1);
		expect(form?.get("mask")).toBeTruthy();
		expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer sk-test" });
	});

	it("rejects unimplemented image operations and unsupported canvas sizes before sending", async () => {
		const fetch = vi.fn(async () => jsonResponse({ data: [{ b64_json: "aGVsbG8=" }] }));
		await expect(
			executeOfficialGeneration(
				{
					providerId: "openai",
					modelId: "gpt-image-2",
					modality: "image",
					prompt: "extend",
					params: { operation: "outpaint_image" },
				},
				{ apiKey: "sk-test", fetch },
			),
		).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
		await expect(
			executeOfficialGeneration(
				{
					providerId: "openai",
					modelId: "gpt-image-2",
					modality: "image",
					prompt: "large",
					params: { size: "2K" },
				},
				{ apiKey: "sk-test", fetch },
			),
		).rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE_SIZE" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("calls ElevenLabs synchronous TTS with voice credentials and returns bounded audio bytes", async () => {
		let calledUrl = "";
		let calledHeaders: RequestInit["headers"] | undefined;
		let requestBody = "";
		const audio = new Uint8Array(16).fill(7);
		const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			calledUrl = String(input);
			calledHeaders = init?.headers;
			requestBody = String(init?.body);
			return new Response(audio, { headers: { "content-type": "audio/mpeg" } });
		});
		const result = await executeOfficialGeneration(
			{
				providerId: "elevenlabs",
				modelId: "eleven_flash_v2_5",
				modality: "audio",
				operation: "speech",
				prompt: "Hello there",
			},
			{
				apiKey: "xi-secret",
				credentials: { voiceId: "voice-123" },
				fetch,
			},
		);
		expect(calledUrl).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice-123?output_format=mp3_44100_128");
		expect(new Headers(calledHeaders).get("xi-api-key")).toBe("xi-secret");
		expect(JSON.parse(requestBody)).toEqual({ text: "Hello there", model_id: "eleven_flash_v2_5" });
		expect(result.outputs?.[0]).toMatchObject({
			mimeType: "audio/mpeg",
			base64: Buffer.from(audio).toString("base64"),
		});
	});

	it("matches the provider-settings connection-probe contract for OpenAI", async () => {
		const fetch = vi.fn(async () => jsonResponse({ object: "list", data: [{ id: "gpt-image-2" }] }));
		await expect(testOfficialProviderConnection("openai", { apiKey: "sk-test", fetch })).resolves.toMatchObject({
			status: "connected",
			success: true,
			models: ["gpt-image-2"],
		});
	});

	it("uses authenticated, non-generating vendor endpoints and validates response envelopes", async () => {
		const checks: Array<{
			providerId: string;
			key: string;
			url: string;
			header: string;
			response: unknown;
			baseUrl?: string;
			credentials?: Record<string, string>;
		}> = [
			{
				providerId: "anthropic",
				key: "anthropic-secret",
				url: "https://api.anthropic.com/v1/models?limit=1",
				header: "x-api-key",
				response: { data: [{ id: "claude" }] },
			},
			{
				providerId: "deepseek",
				key: "deepseek-secret",
				url: "https://api.deepseek.com/models",
				header: "authorization",
				response: { object: "list", data: [{ id: "deepseek-chat" }] },
			},
			{
				providerId: "google",
				key: "google-secret",
				url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=10",
				header: "x-goog-api-key",
				response: { models: [] },
			},
			{
				providerId: "openai",
				key: "openai-secret",
				url: "https://api.openai.com/v1/models",
				header: "authorization",
				response: { object: "list", data: [{ id: "gpt-5" }] },
			},
			{
				providerId: "xai",
				key: "xai-secret",
				url: "https://api.x.ai/v1/models",
				header: "authorization",
				response: { object: "list", data: [{ id: "grok" }] },
			},
			{
				providerId: "moonshot",
				key: "moonshot-secret",
				url: "https://api.moonshot.ai/v1/models",
				header: "authorization",
				response: { object: "list", data: [{ id: "kimi" }] },
			},
			{
				providerId: "elevenlabs",
				key: "eleven-secret",
				url: "https://api.elevenlabs.io/v1/user",
				header: "xi-api-key",
				response: { user_id: "identity-is-discarded" },
			},
			{
				providerId: "fish-audio",
				key: "fish-secret",
				url: "https://api.fish.audio/model?page_size=1",
				header: "authorization",
				response: { items: [{ _id: "fish-model" }] },
			},
			{
				providerId: "vidu",
				key: "vidu-secret",
				url: "https://api.vidu.com/ent/v2/credits",
				header: "authorization",
				response: { remains: [] },
			},
			{
				providerId: "pixverse",
				key: "pixverse-secret",
				url: "https://app-api.pixverse.ai/openapi/v2/account/balance",
				header: "api-key",
				response: { ErrCode: 0, Resp: { balance: 0 } },
			},
			{
				providerId: "minimax",
				key: "minimax-secret",
				url: "https://api.minimax.io/v1/files/list?purpose=voice_clone",
				header: "authorization",
				response: { files: [], base_resp: { status_code: 0, status_msg: "success" } },
			},
			{
				providerId: "volcengine-ark",
				key: "ark-secret",
				url: "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks?page_num=1&page_size=1",
				header: "authorization",
				response: { items: [] },
			},
			{
				providerId: "byteplus",
				key: "byteplus-secret",
				url: "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks?page_num=1&page_size=1",
				header: "authorization",
				response: { items: [] },
			},
		];
		for (const check of checks) {
			const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				expect(String(url)).toBe(check.url);
				expect(init?.method).toBe("GET");
				const headers = new Headers(init?.headers);
				expect(headers.get(check.header)).toContain(check.key);
				return jsonResponse(check.response);
			});
			const result = await testOfficialProviderConnection(check.providerId, {
				apiKey: check.key,
				credentials: check.credentials ?? { apiKey: check.key },
				...(check.baseUrl ? { baseUrl: check.baseUrl } : {}),
				fetch,
			});
			expect(result).toMatchObject({ status: "connected", success: true });
			expect(fetch).toHaveBeenCalledTimes(1);
			if (["elevenlabs", "vidu", "pixverse", "minimax", "volcengine-ark", "byteplus"].includes(check.providerId)) {
				expect(result).not.toHaveProperty("account");
				expect(JSON.stringify(result)).not.toContain(check.key);
			}
		}
	});

	it("probes Kling with either current API Key or legacy AK/SK, redacting the derived JWT", async () => {
		for (const credentials of [
			{ apiKey: "kling-api-secret" },
			{ accessKey: "kling-access-secret", secretKey: "kling-signing-secret" },
		] as Record<string, string>[]) {
			let authorization = "";
			const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				expect(String(url)).toBe("https://api-singapore.klingai.com/v1/videos/text2video?pageNum=1&pageSize=1");
				authorization = new Headers(init?.headers).get("authorization") ?? "";
				return jsonResponse({ code: 0, data: [] });
			});
			await expect(testOfficialProviderConnection("kling", { credentials, fetch })).resolves.toMatchObject({
				status: "connected",
				success: true,
			});
			if (credentials.apiKey) expect(authorization).toBe(`Bearer ${credentials.apiKey}`);
			else expect(authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/u);
			const token = authorization.replace(/^Bearer /u, "");
			const failingFetch = vi.fn(
				async () => new Response(JSON.stringify({ message: `rejected ${token}` }), { status: 401 }),
			);
			await expect(
				testOfficialProviderConnection("kling", { credentials, fetch: failingFetch }),
			).rejects.toMatchObject({
				code: "PROVIDER_HTTP_ERROR",
				message: expect.not.stringContaining(token),
			});
		}
	});

	it("does not treat HTTP 200 error or malformed vendor bodies as valid credentials", async () => {
		await expect(
			testOfficialProviderConnection("openai", {
				apiKey: "test",
				fetch: async () => jsonResponse({ data: [{ message: "no model id" }] }),
			}),
		).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
		await expect(
			testOfficialProviderConnection("openai", {
				apiKey: "test",
				fetch: async () => jsonResponse({ error: "invalid key" }),
			}),
		).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
		await expect(
			testOfficialProviderConnection("pixverse", {
				apiKey: "test",
				fetch: async () => jsonResponse({ ErrCode: 1001, Resp: {} }),
			}),
		).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
		await expect(
			testOfficialProviderConnection("minimax", {
				apiKey: "test",
				fetch: async () => jsonResponse({ files: [], base_resp: { status_code: 401 } }),
			}),
		).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
		await expect(
			testOfficialProviderConnection("kling", {
				apiKey: "test",
				fetch: async () => jsonResponse({ code: 1, data: [] }),
			}),
		).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
	});

	it("reports unsupported probes without sending a request", async () => {
		const fetch = vi.fn(async () => jsonResponse({}));
		await expect(testOfficialProviderConnection("agnes", { apiKey: "agnes-secret", fetch })).resolves.toMatchObject({
			status: "unsupported",
			success: false,
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("blocks credential redirects and redacts provider key headers", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			expect(init?.redirect).toBe("error");
			return new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } });
		});
		await expect(testOfficialProviderConnection("openai", { apiKey: "sk-test", fetch })).rejects.toMatchObject({
			code: "PROVIDER_REDIRECT_BLOCKED",
		});
		expect(redactSecret("xi-api-key: super-secret", "super-secret")).toBe("xi-api-key=[redacted]");
	});

	it("keeps the request timeout active while the response body is being consumed", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const signal = init?.signal as AbortSignal;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
				},
			});
			return new Response(body);
		});
		await expect(
			testOfficialProviderConnection("openai", { apiKey: "sk-test", timeoutMs: 20, fetch }),
		).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
	});

	it("rejects untrusted production endpoints but permits an injected HTTP fixture", () => {
		expect(() =>
			resolveBaseUrl({ baseUrl: "https://attacker.example/v1" }, "https://api.openai.com/v1", "openai"),
		).toThrow(OfficialProviderError);
		expect(
			resolveBaseUrl(
				{ baseUrl: "http://127.0.0.1:9000/v1", fetch: globalThis.fetch },
				"https://api.openai.com/v1",
				"openai",
			),
		).toBe("http://127.0.0.1:9000/v1");
	});
});
