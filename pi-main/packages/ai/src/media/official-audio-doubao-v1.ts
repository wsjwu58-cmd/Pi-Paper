import { randomUUID } from "node:crypto";
import { endpoint, OfficialProviderError, officialJson, redactSecret, resolveBaseUrl, safeBase64 } from "./http.ts";
import type { OfficialGenerationInput, OfficialGenerationOptions, OfficialGenerationResult } from "./types.ts";

/** Legacy HTTP TTS v1 route. Credentials are intentionally separate from v2. */
export async function generateDoubaoV1Speech(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	if (input.providerId !== "doubao-voice-v1" || input.modelId !== "seed-tts-1.1")
		throw new OfficialProviderError(
			"UNSUPPORTED_MODEL",
			"This adapter implements the exact Doubao Seed TTS 1.1 model only.",
		);
	if (input.operation && input.operation !== "speech")
		throw new OfficialProviderError("UNSUPPORTED_OPERATION", "Doubao TTS v1 implements text-to-speech only.");
	if (input.references?.length)
		throw new OfficialProviderError("REFERENCE_MEDIA_UNSUPPORTED", "Doubao TTS v1 does not accept reference media.");
	const params = input.params ?? {};
	const allowed = new Set([
		"voice",
		"voiceId",
		"speaker",
		"speed",
		"speed_ratio",
		"speedRatio",
		"format",
		"encoding",
		"sample_rate",
		"sampleRate",
	]);
	const unknown = Object.keys(params).find((key) => !allowed.has(key));
	if (unknown)
		throw new OfficialProviderError(
			"UNSUPPORTED_AUDIO_PARAMETER",
			`Doubao TTS v1 does not implement parameter ${unknown}.`,
		);
	const token = options.credentials?.accessToken ?? options.credentials?.token ?? options.apiKey;
	if (!token?.trim())
		throw new OfficialProviderError("CLOUD_CREDENTIAL_MISSING", "Configure a Doubao TTS v1 access token.");
	const appId = options.credentials?.appId;
	if (!appId?.trim() || appId.length > 128)
		throw new OfficialProviderError("CLOUD_CREDENTIAL_MISSING", "Configure the Doubao TTS v1 App ID.");
	const voiceValues = [params.voice, params.voiceId, params.speaker].filter(
		(value) => value !== undefined && value !== "",
	);
	if (
		voiceValues.some((value) => typeof value !== "string" || !value.trim() || value.length > 200) ||
		new Set(voiceValues).size > 1
	)
		throw new OfficialProviderError("INVALID_AUDIO_PARAMETER", "Provide one consistent Doubao voice_type.");
	const voiceId = (voiceValues[0] as string | undefined) ?? options.credentials?.voiceId;
	if (!voiceId?.trim())
		throw new OfficialProviderError(
			"VOICE_REQUIRED",
			"Configure a Doubao TTS v1 voice_type from the v1 voice catalog.",
		);
	const format = params.format ?? params.encoding ?? "mp3";
	if (format !== "mp3" && format !== "wav")
		throw new OfficialProviderError(
			"UNSUPPORTED_AUDIO_FORMAT",
			"Doubao TTS v1 output is limited to MP3 or WAV in this desktop pipeline.",
		);
	const speedValues = [params.speed, params.speed_ratio, params.speedRatio].filter((value) => value !== undefined);
	if (
		speedValues.some((value) => typeof value !== "number" || !Number.isFinite(value)) ||
		new Set(speedValues).size > 1
	)
		throw new OfficialProviderError("INVALID_AUDIO_PARAMETER", "Speech speed must be one consistent finite number.");
	const speed = speedValues[0] as number | undefined;
	if (speed !== undefined && (speed < 0.1 || speed > 2))
		throw new OfficialProviderError(
			"INVALID_AUDIO_PARAMETER",
			"Doubao TTS v1 speed_ratio must be between 0.1 and 2.",
		);
	const sampleRate = params.sample_rate ?? params.sampleRate ?? 16000;
	if (typeof sampleRate !== "number" || ![8000, 16000].includes(sampleRate))
		throw new OfficialProviderError("INVALID_AUDIO_PARAMETER", "Doubao TTS v1 sample rate must be 8000 or 16000 Hz.");
	if (Buffer.byteLength(input.prompt, "utf8") > 1024)
		throw new OfficialProviderError("PROMPT_TOO_LONG", "Doubao TTS v1 text is limited to 1024 UTF-8 bytes.");
	const apiBaseUrl = resolveBaseUrl(options, "https://openspeech.bytedance.com/api/v1", input.providerId);
	const response = await officialJson<DoubaoV1Response>(
		endpoint(apiBaseUrl, "tts"),
		{
			method: "POST",
			headers: { Authorization: `Bearer;${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				app: { appid: appId, token: "pi-paper-desktop", cluster: "volcano_tts" },
				user: { uid: "pi-paper-desktop" },
				audio: {
					voice_type: voiceId,
					encoding: format,
					rate: sampleRate,
					...(speed !== undefined ? { speed_ratio: speed } : {}),
				},
				request: {
					reqid: randomUUID(),
					text: input.prompt,
					operation: "query",
					...(input.modelId ? { model: input.modelId } : {}),
				},
			}),
		},
		options,
		token,
	);
	if (response.code !== 3000) {
		const error =
			typeof response.message === "string" ? response.message.slice(0, 800) : "Doubao TTS v1 generation failed.";
		throw new OfficialProviderError("PROVIDER_GENERATION_FAILED", redactSecret(error, token));
	}
	if (typeof response.data !== "string")
		throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "Doubao TTS v1 returned no audio payload.");
	const audio = safeBase64(response.data, "Doubao TTS v1 audio");
	if (audio.byteLength < 12)
		throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "Doubao TTS v1 returned empty audio.");
	return {
		outputs: [
			{ base64: Buffer.from(audio).toString("base64"), mimeType: format === "mp3" ? "audio/mpeg" : "audio/wav" },
		],
	};
}

interface DoubaoV1Response {
	code?: unknown;
	message?: unknown;
	data?: unknown;
}
