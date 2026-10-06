import { randomUUID } from "node:crypto";
import {
	endpoint,
	OfficialProviderError,
	officialBytes,
	redactSecret,
	requireApiKey,
	resolveBaseUrl,
	safeBase64,
} from "./http.ts";
import type { OfficialGenerationInput, OfficialGenerationOptions, OfficialGenerationResult } from "./types.ts";

/** Doubao Speech v3 SSE with the new speech-console API Key, separate from Ark. */
export async function generateDoubaoSpeech(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	if (input.providerId !== "doubao-voice" || input.modelId !== "seed-tts-2.0")
		throw new OfficialProviderError("UNSUPPORTED_MODEL", "This adapter supports Doubao TTS v2 only.");
	if ((input.operation && input.operation !== "speech") || input.references?.length)
		throw new OfficialProviderError(
			"UNSUPPORTED_OPERATION",
			"Doubao TTS v2 does not implement reference uploads or voice creation.",
		);
	const params = input.params ?? {};
	for (const key of Object.keys(params))
		if (!["format", "speaker", "voice", "voiceId", "speed"].includes(key))
			throw new OfficialProviderError(
				"UNSUPPORTED_AUDIO_PARAMETER",
				`Doubao TTS does not implement the parameter ${key}.`,
			);
	if (params.format !== undefined && params.format !== "mp3")
		throw new OfficialProviderError("UNSUPPORTED_AUDIO_FORMAT", "Doubao TTS desktop output is currently MP3 only.");
	const voices = [params.speaker, params.voice, params.voiceId].filter((value) => value !== undefined && value !== "");
	if (new Set(voices).size > 1)
		throw new OfficialProviderError("INVALID_AUDIO_PARAMETER", "Conflicting Doubao Speaker IDs.");
	const voice = voices[0] ?? options.credentials?.voiceId;
	if (typeof voice !== "string" || !voice.trim() || voice.length > 200)
		throw new OfficialProviderError("VOICE_REQUIRED", "Configure a Doubao 2.0 Speaker ID from the speech console.");
	const speed = params.speed;
	if (speed !== undefined && (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0.5 || speed > 2))
		throw new OfficialProviderError("INVALID_AUDIO_PARAMETER", "Speech speed must be between 0.5 and 2.");
	const apiKey = requireApiKey(options, input.providerId);
	const baseUrl = resolveBaseUrl(options, "https://openspeech.bytedance.com/api/v3", input.providerId);
	const { bytes, response } = await officialBytes(
		endpoint(baseUrl, "tts/unidirectional/sse"),
		{
			method: "POST",
			headers: {
				"X-Api-Key": apiKey,
				"X-Api-Resource-Id": input.modelId,
				"X-Api-Request-Id": randomUUID(),
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			},
			body: JSON.stringify({
				user: { uid: "pi-paper-desktop" },
				req_params: {
					text: input.prompt,
					speaker: voice,
					audio_params: {
						format: "mp3",
						...(typeof speed === "number" ? { speech_rate: Math.round((speed - 1) * 100) } : {}),
					},
				},
			}),
		},
		options,
		apiKey,
		128 * 1024 * 1024,
	);
	if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream"))
		throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "Doubao returned a non-SSE response.");
	const chunks: Uint8Array[] = [];
	let completed = false;
	let totalBytes = 0;
	for (const block of new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n").split("\n\n")) {
		const data = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (!data) continue;
		let event: { code?: unknown; data?: unknown; message?: unknown };
		try {
			event = JSON.parse(data);
		} catch {
			throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "Doubao returned malformed SSE data.");
		}
		if (!event || typeof event !== "object" || completed)
			throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "Doubao returned invalid SSE event ordering.");
		if (event.code !== 0 && event.code !== 20000000)
			throw new OfficialProviderError(
				"PROVIDER_GENERATION_FAILED",
				redactSecret(
					typeof event.message === "string" ? event.message.slice(0, 800) : "Doubao speech generation failed.",
					apiKey,
				),
			);
		if (event.data !== undefined && event.data !== null && event.data !== "") {
			if (typeof event.data !== "string")
				throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "Doubao returned invalid audio data.");
			const chunk = safeBase64(event.data, "Speech audio");
			totalBytes += chunk.byteLength;
			if (totalBytes > 128 * 1024 * 1024)
				throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "Doubao speech output is too large.");
			chunks.push(chunk);
		}
		completed = event.code === 20000000;
	}
	if (!completed || totalBytes < 12)
		throw new OfficialProviderError(
			"INCOMPLETE_PROVIDER_RESPONSE",
			"Doubao speech did not complete; partial audio was not saved.",
		);
	return { outputs: [{ base64: Buffer.concat(chunks).toString("base64"), mimeType: "audio/mpeg" }] };
}
