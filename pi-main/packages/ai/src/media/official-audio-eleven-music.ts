import { endpoint, OfficialProviderError, officialBytes, requireApiKey, resolveBaseUrl } from "./http.ts";
import type { OfficialGenerationInput, OfficialGenerationOptions, OfficialGenerationResult } from "./types.ts";

/** Eleven Music 2.5; manual lyrics use the documented chunk composition plan. */
export async function generateElevenMusic(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	if (input.providerId !== "elevenlabs" || input.modelId !== "music_v2_5" || input.operation !== "music")
		throw new OfficialProviderError("UNSUPPORTED_MODEL", "Select the verified Eleven Music 2.5 binding.");
	if (input.references?.length)
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"Reference audio is not implemented for this music binding.",
		);
	const params = input.params ?? {};
	const allowed = ["lyrics", "lyrics_optimizer", "is_instrumental", "music_length_ms"];
	if (Object.keys(params).some((key) => !allowed.includes(key)))
		throw new OfficialProviderError(
			"UNSUPPORTED_AUDIO_PARAMETER",
			"The Eleven Music request contains unsupported parameters.",
		);
	const prompt = input.prompt.trim();
	if (!prompt || [...prompt].length > 4100)
		throw new OfficialProviderError("INVALID_AUDIO_PARAMETER", "Eleven Music requires 1–4100 prompt characters.");
	for (const key of ["lyrics_optimizer", "is_instrumental"]) {
		if (params[key] !== undefined && typeof params[key] !== "boolean")
			throw new OfficialProviderError("INVALID_AUDIO_PARAMETER", "Music mode flags must be boolean.");
	}
	const length = params.music_length_ms ?? 30_000;
	if (typeof length !== "number" || !Number.isInteger(length) || length < 3000 || length > 600_000)
		throw new OfficialProviderError(
			"INVALID_AUDIO_PARAMETER",
			"Eleven Music length must be 3000–600000 milliseconds.",
		);
	const manual = params.is_instrumental !== true && params.lyrics_optimizer === false;
	if (manual && (typeof params.lyrics !== "string" || !params.lyrics.trim() || [...params.lyrics].length > 3500))
		throw new OfficialProviderError("LYRICS_REQUIRED", "Provide 1–3500 characters of manual lyrics.");
	const request = manual
		? {
				model_id: input.modelId,
				composition_plan: {
					chunks: [
						{
							text: params.lyrics,
							duration_ms: length,
							positive_styles: [prompt],
							negative_styles: [],
							context_adherence: "high",
						},
					],
				},
			}
		: {
				model_id: input.modelId,
				prompt,
				music_length_ms: length,
				force_instrumental: params.is_instrumental === true,
			};
	const key = requireApiKey(options, "elevenlabs");
	const base = resolveBaseUrl(options, "https://api.elevenlabs.io/v1", "elevenlabs");
	const { bytes, response } = await officialBytes(
		endpoint(base, "music?output_format=mp3_44100_128"),
		{
			method: "POST",
			headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
			body: JSON.stringify(request),
		},
		options,
		key,
		128 * 1024 * 1024,
	);
	const mime = response.headers.get("content-type")?.split(";", 1)[0];
	if (bytes.length < 12 || (mime && !mime.startsWith("audio/") && mime !== "application/octet-stream"))
		throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "Eleven Music returned no usable audio.");
	return {
		outputs: [
			{ base64: Buffer.from(bytes).toString("base64"), mimeType: mime?.startsWith("audio/") ? mime : "audio/mpeg" },
		],
	};
}
