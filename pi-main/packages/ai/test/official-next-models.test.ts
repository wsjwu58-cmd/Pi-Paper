import { describe, expect, it, vi } from "vitest";
import { executeOfficialGeneration } from "../src/media/index.ts";
import { OFFICIAL_TEXT_MODELS } from "../src/media/official-text-models.ts";

const jsonResponse = (body: unknown) =>
	new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const completionSseResponse = () =>
	new Response(
		[
			'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
			'data: {"choices":[{"delta":{"content":"fixture response"},"finish_reason":null}]}\n\n',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
			"data: [DONE]\n\n",
		].join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
const audioHex = Buffer.from(new Uint8Array(32).map((_value, index) => index + 1)).toString("hex");

describe("new official model protocol fixtures", () => {
	it("uses the exact Seed text IDs and distinguishes Mini's application budget from Pro's verified limits", async () => {
		const mini = OFFICIAL_TEXT_MODELS.find((model) => model.name === "Seed 2.0 Mini")!;
		const pro = OFFICIAL_TEXT_MODELS.find((model) => model.name === "Seed 2.1 Pro")!;
		expect(mini).toMatchObject({
			apiModelId: "doubao-seed-2-0-mini-260428",
			contextWindow: 8192,
			maxTokens: 2048,
			contextMetadataStatus: "application-budget",
			maxTokensMetadataStatus: "application-cap",
		});
		expect(pro).toMatchObject({
			apiModelId: "doubao-seed-2-1-pro-260628",
			contextWindow: 256000,
			maxTokens: 32768,
			contextMetadataStatus: "verified",
			maxTokensMetadataStatus: "verified",
		});

		let url = "";
		let body: Record<string, unknown> = {};
		const fetch = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
			url = String(target);
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return completionSseResponse();
		});
		const result = await executeOfficialGeneration(
			{
				providerId: "volcengine",
				modelId: mini.apiModelId,
				modality: "text",
				prompt: "Write a short title",
				params: { maxTokens: 512 },
			},
			{ apiKey: "ark-fixture-key", fetch },
		);
		expect(url).toBe("https://ark.cn-beijing.volces.com/api/v3/chat/completions");
		expect(body).toMatchObject({ model: "doubao-seed-2-0-mini-260428", max_tokens: 512 });
		expect(result.text).toBe("fixture response");
		await expect(
			executeOfficialGeneration(
				{
					providerId: "volcengine",
					modelId: mini.apiModelId,
					modality: "text",
					prompt: "hello",
					params: { undocumentedMode: true },
				},
				{ apiKey: "ark-fixture-key", fetch },
			),
		).rejects.toMatchObject({ code: "UNSUPPORTED_PARAMETER" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("calls GPT-Image-2.5 and xAI Grok Imagine with exact model IDs; rejects unimplemented Grok references", async () => {
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		const fetch = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(target), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
			return jsonResponse({ data: [{ b64_json: "aW1hZ2U=" }] });
		});
		await executeOfficialGeneration(
			{
				providerId: "openai",
				modelId: "gpt-image-2.5-flare",
				modality: "image",
				prompt: "A paper kite",
				params: { size: "1K", ratio: "1:1", count: 1, quality: "high" },
			},
			{ apiKey: "openai-fixture-key", fetch },
		);
		await executeOfficialGeneration(
			{
				providerId: "xai",
				modelId: "grok-imagine-image",
				modality: "image",
				prompt: "A kite above water",
				params: { aspect_ratio: "3:2", resolution: "1K" },
			},
			{ apiKey: "xai-fixture-key", fetch },
		);
		expect(requests[0]).toMatchObject({
			url: "https://api.openai.com/v1/images/generations",
			body: { model: "gpt-image-2.5-flare", prompt: "A paper kite", quality: "high" },
		});
		expect(requests[1]).toMatchObject({
			url: "https://api.x.ai/v1/images/generations",
			body: { model: "grok-imagine-image", aspect_ratio: "3:2", resolution: "1k" },
		});
		await expect(
			executeOfficialGeneration(
				{
					providerId: "xai",
					modelId: "grok-imagine-image",
					modality: "image",
					prompt: "Edit this",
					references: [{ type: "image", base64: "aGVsbG8=" }],
				},
				{ apiKey: "xai-fixture-key", fetch },
			),
		).rejects.toMatchObject({ code: "REFERENCE_MEDIA_UNSUPPORTED" });
		expect(fetch).toHaveBeenCalledTimes(2);

		let editForm: FormData | undefined;
		const editFetch = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
			expect(String(target)).toBe("https://api.openai.com/v1/images/edits");
			editForm = init?.body as FormData;
			return jsonResponse({ data: [{ b64_json: "aW1hZ2U=" }] });
		});
		await executeOfficialGeneration(
			{
				providerId: "openai",
				modelId: "gpt-image-2.5-sunburst",
				modality: "image",
				operation: "edit",
				prompt: "Change the sky",
				references: [{ type: "image", base64: "aGVsbG8=", mimeType: "image/png" }],
			},
			{ apiKey: "openai-fixture-key", fetch: editFetch },
		);
		expect(editForm?.get("model")).toBe("gpt-image-2.5-sunburst");
		expect(editForm?.getAll("image[]")).toHaveLength(1);
	});

	it("routes Agnes Image 2.0/2.1 only through its exact generation IDs and refuses unverified edits", async () => {
		let body: Record<string, unknown> = {};
		const fetch = vi.fn(async (_target: string | URL | Request, init?: RequestInit) => {
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({ data: [{ url: "https://media.example.test/agnes.png" }] });
		});
		const result = await executeOfficialGeneration(
			{
				providerId: "agnes",
				modelId: "agnes-image-2.1-flash",
				modality: "image",
				prompt: "A paper kite",
				params: { count: 1, size: "2K" },
			},
			{ apiKey: "agnes-fixture-key", fetch },
		);
		expect(body).toMatchObject({
			model: "agnes-image-2.1-flash",
			n: 1,
			size: "2K",
			extra_body: { response_format: "url" },
		});
		expect(result.outputs?.[0]).toMatchObject({ url: "https://media.example.test/agnes.png" });
		await expect(
			executeOfficialGeneration(
				{
					providerId: "agnes",
					modelId: "agnes-image-2.0-flash",
					modality: "image",
					operation: "edit",
					prompt: "Edit",
					references: [{ type: "image", base64: "aGVsbG8=" }],
				},
				{ apiKey: "agnes-fixture-key", fetch },
			),
		).rejects.toMatchObject({ code: "REFERENCE_MEDIA_UNSUPPORTED" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("calls exact MiniMax Music 2.6 and redacts upstream status text", async () => {
		let body: Record<string, unknown> = {};
		let headers: RequestInit["headers"] | undefined;
		const fetch = vi.fn(async (_target: string | URL | Request, init?: RequestInit) => {
			headers = init?.headers;
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({ base_resp: { status_code: 0, status_msg: "success" }, data: { audio: audioHex } });
		});
		const result = await executeOfficialGeneration(
			{
				providerId: "minimax",
				modelId: "music-2.6",
				modality: "audio",
				operation: "music",
				prompt: "Gentle folk tune",
				params: { lyrics: "Sing beneath the moon", format: "mp3" },
			},
			{ apiKey: "mm-fixture-secret", fetch },
		);
		expect(new Headers(headers).get("Authorization")).toBe("Bearer mm-fixture-secret");
		expect(body).toMatchObject({
			model: "music-2.6",
			output_format: "hex",
			audio_setting: { format: "mp3", sample_rate: 44100, bitrate: 256000 },
		});
		expect(result.outputs?.[0]).toMatchObject({
			mimeType: "audio/mpeg",
			base64: Buffer.from(new Uint8Array(32).map((_value, index) => index + 1)).toString("base64"),
		});

		const failure = vi.fn(async () =>
			jsonResponse({ base_resp: { status_code: 1, status_msg: "token mm-failure-secret rejected" } }),
		);
		await expect(
			executeOfficialGeneration(
				{
					providerId: "minimax",
					modelId: "music-2.6",
					modality: "audio",
					operation: "music",
					prompt: "Tune",
					params: { lyrics: "Words" },
				},
				{ apiKey: "mm-failure-secret", fetch: failure },
			),
		).rejects.toMatchObject({
			code: "PROVIDER_GENERATION_FAILED",
			message: expect.not.stringContaining("mm-failure-secret"),
		});
		await expect(
			executeOfficialGeneration(
				{
					providerId: "minimax",
					modelId: "music-2.6",
					modality: "audio",
					operation: "music",
					prompt: "Tune",
					params: { lyrics: "Words" },
					references: [{ type: "audio", base64: "AQIDBA==", mimeType: "audio/mpeg" }],
				},
				{ apiKey: "mm-fixture-secret", fetch },
			),
		).rejects.toMatchObject({ code: "REFERENCE_MEDIA_UNSUPPORTED" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("calls the distinct Doubao TTS v1 token/appId/voice endpoint and rejects unsupported audio controls", async () => {
		let requestUrl = "";
		let requestHeaders: RequestInit["headers"] | undefined;
		let body: Record<string, unknown> = {};
		const fetch = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
			requestUrl = String(target);
			requestHeaders = init?.headers;
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({
				code: 3000,
				message: "success",
				data: Buffer.from(new Uint8Array(32)).toString("base64"),
			});
		});
		const result = await executeOfficialGeneration(
			{
				providerId: "doubao-voice-v1",
				modelId: "seed-tts-1.1",
				modality: "audio",
				operation: "speech",
				prompt: "你好",
				params: { speed_ratio: 1.1, format: "mp3" },
			},
			{ credentials: { accessToken: "doubao-v1-token", appId: "app-123", voiceId: "voice-456" }, fetch },
		);
		expect(requestUrl).toBe("https://openspeech.bytedance.com/api/v1/tts");
		expect(new Headers(requestHeaders).get("Authorization")).toBe("Bearer;doubao-v1-token");
		expect(body).toMatchObject({
			app: { appid: "app-123", cluster: "volcano_tts" },
			audio: { voice_type: "voice-456", encoding: "mp3", speed_ratio: 1.1 },
			request: { model: "seed-tts-1.1", operation: "query", text: "你好" },
		});
		expect(result.outputs?.[0]?.mimeType).toBe("audio/mpeg");
		await expect(
			executeOfficialGeneration(
				{
					providerId: "doubao-voice-v1",
					modelId: "seed-tts-1.1",
					modality: "audio",
					prompt: "你好",
					params: { tone: "bright" },
				},
				{ credentials: { accessToken: "token", appId: "app", voiceId: "voice" }, fetch },
			),
		).rejects.toMatchObject({ code: "UNSUPPORTED_AUDIO_PARAMETER" });
		await expect(
			executeOfficialGeneration(
				{ providerId: "doubao-voice-v1", modelId: "seed-tts-1.1", modality: "audio", prompt: "界".repeat(400) },
				{ credentials: { accessToken: "token", appId: "app", voiceId: "voice" }, fetch },
			),
		).rejects.toMatchObject({ code: "PROMPT_TOO_LONG" });
		await expect(
			executeOfficialGeneration(
				{
					providerId: "doubao-voice-v1",
					modelId: "seed-tts-1.1",
					modality: "audio",
					prompt: "你好",
					references: [{ type: "audio", base64: "AQIDBA==" }],
				},
				{ credentials: { accessToken: "token", appId: "app", voiceId: "voice" }, fetch },
			),
		).rejects.toMatchObject({ code: "REFERENCE_MEDIA_UNSUPPORTED" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
