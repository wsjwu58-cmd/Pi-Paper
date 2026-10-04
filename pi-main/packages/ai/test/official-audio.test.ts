import { describe, expect, it, vi } from "vitest";
import { executeOfficialGeneration } from "../src/media/index.ts";

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

describe("official audio adapters", () => {
	it("calls MiniMax Speech 2.8 HTTP T2A and decodes the documented hex audio response", async () => {
		let calledUrl = "";
		let calledHeaders: RequestInit["headers"] | undefined;
		let requestBody = "";
		const audio = new Uint8Array(16).map((_value, index) => index + 1);
		const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			calledUrl = String(input);
			calledHeaders = init?.headers;
			requestBody = String(init?.body);
			return jsonResponse({
				data: { audio: Buffer.from(audio).toString("hex"), status: 2 },
				base_resp: { status_code: 0, status_msg: "success" },
			});
		});

		const result = await executeOfficialGeneration(
			{
				providerId: "minimax",
				modelId: "speech-2.8-hd",
				modality: "audio",
				operation: "speech",
				prompt: "Hello there",
				params: { voiceId: "English_expressive_narrator", speed: 1.1, format: "mp3" },
			},
			{ apiKey: "mm-secret", fetch },
		);

		expect(calledUrl).toBe("https://api.minimax.io/v1/t2a_v2");
		expect(new Headers(calledHeaders).get("Authorization")).toBe("Bearer mm-secret");
		expect(JSON.parse(requestBody)).toMatchObject({
			model: "speech-2.8-hd",
			text: "Hello there",
			stream: false,
			output_format: "hex",
			voice_setting: { voice_id: "English_expressive_narrator", speed: 1.1 },
			audio_setting: { format: "mp3" },
		});
		expect(result.outputs?.[0]).toMatchObject({
			mimeType: "audio/mpeg",
			base64: Buffer.from(audio).toString("base64"),
		});
	});

	it("rejects MiniMax reference audio and unsupported model aliases before submitting", async () => {
		const fetch = vi.fn(async () =>
			jsonResponse({ data: { audio: "010203040506070809101112" }, base_resp: { status_code: 0 } }),
		);
		await expect(
			executeOfficialGeneration(
				{
					providerId: "minimax",
					modelId: "speech-2.8-turbo",
					modality: "audio",
					prompt: "hello",
					params: { voiceId: "voice" },
					references: [{ type: "audio", base64: "AQIDBA==", mimeType: "audio/mpeg" }],
				},
				{ apiKey: "mm-secret", fetch },
			),
		).rejects.toMatchObject({ code: "REFERENCE_MEDIA_UNSUPPORTED" });
		await expect(
			executeOfficialGeneration(
				{
					providerId: "minimax",
					modelId: "speech-2.6-hd",
					modality: "audio",
					prompt: "hello",
					params: { voiceId: "voice" },
				},
				{ apiKey: "mm-secret", fetch },
			),
		).rejects.toMatchObject({ code: "UNSUPPORTED_MODEL" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("requires explicit MiniMax voice ID and rejects unsuccessful upstream envelopes", async () => {
		const fetch = vi.fn(async () =>
			jsonResponse({ data: { audio: "010203040506070809101112" }, base_resp: { status_code: 0 } }),
		);
		await expect(
			executeOfficialGeneration(
				{
					providerId: "minimax",
					modelId: "speech-2.8-turbo",
					modality: "audio",
					prompt: "hello",
				},
				{ apiKey: "mm-secret", fetch },
			),
		).rejects.toMatchObject({ code: "VOICE_REQUIRED" });
		const failed = vi.fn(async () =>
			jsonResponse({ base_resp: { status_code: 1004, status_msg: "voice unavailable" } }),
		);
		await expect(
			executeOfficialGeneration(
				{
					providerId: "minimax",
					modelId: "speech-2.8-turbo",
					modality: "audio",
					prompt: "hello",
					params: { voiceId: "voice" },
				},
				{ apiKey: "mm-secret", fetch: failed },
			),
		).rejects.toMatchObject({ code: "PROVIDER_GENERATION_FAILED" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("uploads exactly one base64 source audio to ElevenLabs Voice Changer", async () => {
		let calledUrl = "";
		let calledHeaders: RequestInit["headers"] | undefined;
		let form: FormData | undefined;
		const audio = new Uint8Array(16).fill(7);
		const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			calledUrl = String(input);
			calledHeaders = init?.headers;
			form = init?.body as FormData;
			return new Response(audio, { headers: { "content-type": "audio/mpeg" } });
		});

		const result = await executeOfficialGeneration(
			{
				providerId: "elevenlabs",
				modelId: "eleven_multilingual_sts_v2",
				modality: "audio",
				operation: "voice-change",
				prompt: "",
				references: [
					{ type: "audio", base64: Buffer.from([1, 2, 3, 4]).toString("base64"), mimeType: "audio/wav" },
				],
			},
			{ apiKey: "xi-secret", credentials: { voiceId: "target-voice" }, fetch },
		);

		expect(calledUrl).toBe("https://api.elevenlabs.io/v1/speech-to-speech/target-voice?output_format=mp3_44100_128");
		expect(new Headers(calledHeaders).get("xi-api-key")).toBe("xi-secret");
		expect(form?.get("model_id")).toBe("eleven_multilingual_sts_v2");
		expect(form?.get("audio")).toBeInstanceOf(Blob);
		expect((form?.get("audio") as File).type).toBe("audio/wav");
		expect(result.outputs?.[0]).toMatchObject({
			mimeType: "audio/mpeg",
			base64: Buffer.from(audio).toString("base64"),
		});
	});

	it("refuses missing, URL-only, multiple, or non-audio Voice Changer references", async () => {
		const fetch = vi.fn(async () => new Response(new Uint8Array(16), { headers: { "content-type": "audio/mpeg" } }));
		const base = {
			providerId: "elevenlabs",
			modelId: "eleven_english_sts_v2",
			modality: "audio" as const,
			prompt: "Transform",
		};
		const options = { apiKey: "xi-secret", credentials: { voiceId: "voice" }, fetch };
		await expect(executeOfficialGeneration(base, options)).rejects.toMatchObject({
			code: "AUDIO_REFERENCE_REQUIRED",
		});
		await expect(
			executeOfficialGeneration(
				{ ...base, references: [{ type: "audio", url: "https://assets.example/audio.wav" }] },
				options,
			),
		).rejects.toMatchObject({ code: "INVALID_MEDIA_REFERENCE" });
		await expect(
			executeOfficialGeneration(
				{
					...base,
					references: [
						{ type: "audio", base64: "AQIDBA==" },
						{ type: "audio", base64: "AQIDBA==" },
					],
				},
				options,
			),
		).rejects.toMatchObject({ code: "AUDIO_REFERENCE_REQUIRED" });
		await expect(
			executeOfficialGeneration({ ...base, references: [{ type: "image", base64: "AQIDBA==" }] }, options),
		).rejects.toMatchObject({ code: "AUDIO_REFERENCE_REQUIRED" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does not silently discard source audio on the existing ElevenLabs TTS route", async () => {
		const fetch = vi.fn(async () => new Response(new Uint8Array(16), { headers: { "content-type": "audio/mpeg" } }));
		await expect(
			executeOfficialGeneration(
				{
					providerId: "elevenlabs",
					modelId: "eleven_flash_v2_5",
					modality: "audio",
					prompt: "Hello",
					params: { voiceId: "voice" },
					references: [{ type: "audio", base64: "AQIDBA==" }],
				},
				{ apiKey: "xi-secret", fetch },
			),
		).rejects.toMatchObject({ code: "REFERENCE_MEDIA_UNSUPPORTED" });
		expect(fetch).not.toHaveBeenCalled();
	});
});
