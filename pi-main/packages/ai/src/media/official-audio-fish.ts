import { endpoint, OfficialProviderError, officialBytes, requireApiKey, resolveBaseUrl } from "./http.ts";
import type { OfficialGenerationInput, OfficialGenerationOptions, OfficialGenerationResult } from "./types.ts";

/** Fish Audio JSON TTS; inline cloning references require a separate MessagePack implementation. */
export async function generateFishAudio(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	if (input.providerId !== "fish-audio" || !["s1", "s2-pro"].includes(input.modelId))
		throw new OfficialProviderError("UNSUPPORTED_MODEL", "Choose a verified Fish Audio S1 or S2 Pro model.");
	if (input.operation && input.operation !== "speech")
		throw new OfficialProviderError(
			"UNSUPPORTED_OPERATION",
			"This Fish Audio adapter implements text-to-speech only.",
		);
	if (input.references?.length)
		throw new OfficialProviderError(
			"REFERENCE_MEDIA_UNSUPPORTED",
			"Fish Audio inline voice cloning requires MessagePack and is not implemented; use a configured voice model ID.",
		);
	const params = input.params ?? {};
	for (const name of Object.keys(params)) {
		if (!["format", "speed", "reference_id", "referenceId", "voice", "voiceId"].includes(name))
			throw new OfficialProviderError(
				"UNSUPPORTED_AUDIO_PARAMETER",
				`Fish Audio does not implement the parameter ${name}.`,
			);
	}
	const format = params.format ?? "mp3";
	if (format !== "mp3" && format !== "wav")
		throw new OfficialProviderError(
			"UNSUPPORTED_AUDIO_FORMAT",
			"The desktop Fish Audio pipeline supports MP3 or WAV output.",
		);
	const speed = params.speed;
	if (speed !== undefined && (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0.5 || speed > 2))
		throw new OfficialProviderError("INVALID_AUDIO_PARAMETER", "Fish Audio speed must be between 0.5 and 2.");
	const voiceValues = [params.reference_id, params.referenceId, params.voice, params.voiceId].filter(
		(value) => value !== undefined && value !== "",
	);
	if (
		voiceValues.some((value) => typeof value !== "string" || !value.trim() || value.length > 200) ||
		new Set(voiceValues).size > 1
	)
		throw new OfficialProviderError("INVALID_AUDIO_PARAMETER", "Choose one consistent Fish Audio reference ID.");
	const referenceId = voiceValues[0] ?? options.credentials?.voiceId;
	if (
		referenceId !== undefined &&
		(typeof referenceId !== "string" || !referenceId.trim() || referenceId.length > 200)
	)
		throw new OfficialProviderError("INVALID_AUDIO_PARAMETER", "The configured Fish Audio reference ID is invalid.");
	const apiKey = requireApiKey(options, input.providerId);
	const baseUrl = resolveBaseUrl(options, "https://api.fish.audio/v1", input.providerId);
	const { bytes, response } = await officialBytes(
		endpoint(baseUrl, "tts"),
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				model: input.modelId,
				Accept: "audio/*",
			},
			body: JSON.stringify({
				text: input.prompt,
				format,
				...(referenceId ? { reference_id: referenceId } : {}),
				...(speed !== undefined ? { prosody: { speed } } : {}),
			}),
		},
		options,
		apiKey,
		128 * 1024 * 1024,
	);
	const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (mime && !["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "application/octet-stream"].includes(mime))
		throw new OfficialProviderError(
			"INVALID_PROVIDER_RESPONSE",
			"Fish Audio returned an unsupported audio response.",
		);
	if (bytes.length < 12)
		throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "Fish Audio returned empty audio.");
	return {
		outputs: [
			{ base64: Buffer.from(bytes).toString("base64"), mimeType: format === "mp3" ? "audio/mpeg" : "audio/wav" },
		],
	};
}
