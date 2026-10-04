import { endpoint, OfficialProviderError, officialJson, redactSecret, requireApiKey, resolveBaseUrl } from "./http.ts";
import type { OfficialGenerationInput, OfficialGenerationOptions, OfficialGenerationResult } from "./types.ts";

/** MiniMax Music 2.6; deliberately does not alias the newer Music 3 model. */
export async function generateMiniMaxMusic(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	if (input.providerId !== "minimax" || input.modelId !== "music-2.6") {
		throw new OfficialProviderError(
			"UNSUPPORTED_MODEL",
			"This adapter implements the exact MiniMax Music 2.6 model only.",
		);
	}
	if (input.operation !== "music")
		throw new OfficialProviderError("UNSUPPORTED_OPERATION", "MiniMax Music 2.6 requires the music operation.");
	if (input.references?.length)
		throw new OfficialProviderError(
			"REFERENCE_MEDIA_UNSUPPORTED",
			"MiniMax Music 2.6 does not accept reference media in this adapter.",
		);
	const params = input.params ?? {};
	const allowed = new Set([
		"lyrics",
		"is_instrumental",
		"isInstrumental",
		"lyrics_optimizer",
		"lyricsOptimizer",
		"format",
		"sample_rate",
		"sampleRate",
		"bitrate",
	]);
	const unknown = Object.keys(params).find((key) => !allowed.has(key));
	if (unknown)
		throw new OfficialProviderError(
			"UNSUPPORTED_AUDIO_PARAMETER",
			`MiniMax Music 2.6 does not implement parameter ${unknown}.`,
		);
	const prompt = input.prompt.trim();
	if (!prompt || [...prompt].length > 2000)
		throw new OfficialProviderError(
			"INVALID_AUDIO_PARAMETER",
			"MiniMax Music 2.6 prompt must contain 1 to 2000 characters.",
		);
	const lyrics = params.lyrics;
	if (lyrics !== undefined && (typeof lyrics !== "string" || [...lyrics].length > 3500))
		throw new OfficialProviderError("INVALID_AUDIO_PARAMETER", "Lyrics must be text of at most 3500 characters.");
	const isInstrumental = readBoolean(params, "is_instrumental", "isInstrumental");
	const lyricsOptimizer = readBoolean(params, "lyrics_optimizer", "lyricsOptimizer");
	if (!lyrics && isInstrumental !== true && lyricsOptimizer !== true) {
		throw new OfficialProviderError(
			"LYRICS_REQUIRED",
			"Provide lyrics, enable the official lyrics optimizer, or explicitly request an instrumental track.",
		);
	}
	const format = params.format ?? "mp3";
	if (format !== "mp3" && format !== "wav")
		throw new OfficialProviderError(
			"UNSUPPORTED_AUDIO_FORMAT",
			"MiniMax Music 2.6 output is limited to MP3 or WAV in this desktop pipeline.",
		);
	const sampleRate = readInteger(params, "sample_rate", "sampleRate");
	if (sampleRate !== undefined && ![16000, 24000, 32000, 44100].includes(sampleRate))
		throw new OfficialProviderError("INVALID_AUDIO_PARAMETER", "sample_rate must be 16000, 24000, 32000, or 44100.");
	const bitrate = readInteger(params, "bitrate");
	if (bitrate !== undefined && ![64000, 128000, 192000, 256000].includes(bitrate))
		throw new OfficialProviderError("INVALID_AUDIO_PARAMETER", "bitrate must be 64000, 128000, 192000, or 256000.");
	const apiKey = requireApiKey(options, input.providerId);
	const baseUrl = resolveBaseUrl(
		{ ...options, baseUrl: "https://api.minimax.io/v1" },
		"https://api.minimax.io/v1",
		input.providerId,
	);
	const response = await officialJson<MiniMaxMusicResponse>(
		endpoint(baseUrl, "music_generation"),
		{
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "music-2.6",
				prompt,
				stream: false,
				output_format: "hex",
				...(typeof lyrics === "string" ? { lyrics } : {}),
				...(isInstrumental !== undefined ? { is_instrumental: isInstrumental } : {}),
				...(lyricsOptimizer !== undefined ? { lyrics_optimizer: lyricsOptimizer } : {}),
				audio_setting: { format, sample_rate: sampleRate ?? 44100, bitrate: bitrate ?? 256000 },
			}),
		},
		options,
		apiKey,
	);
	if (response.base_resp?.status_code !== 0) {
		const message = response.base_resp?.status_msg;
		throw new OfficialProviderError(
			"PROVIDER_GENERATION_FAILED",
			typeof message === "string" && message
				? `MiniMax Music generation failed: ${redactSecret(message.slice(0, 800), apiKey)}`
				: "MiniMax Music generation failed.",
		);
	}
	const audioHex = response.data?.audio;
	if (typeof audioHex !== "string" || !audioHex || audioHex.length % 2 !== 0 || !/^[\da-f]+$/iu.test(audioHex)) {
		throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "MiniMax returned invalid hex-encoded music audio.");
	}
	const audio = Buffer.from(audioHex, "hex");
	if (audio.length < 12 || audio.length > 128 * 1024 * 1024)
		throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "MiniMax returned empty or oversized music audio.");
	return { outputs: [{ base64: audio.toString("base64"), mimeType: format === "mp3" ? "audio/mpeg" : "audio/wav" }] };
}

function readBoolean(params: Record<string, unknown>, ...keys: string[]): boolean | undefined {
	const values = keys.filter((key) => params[key] !== undefined).map((key) => params[key]);
	if (values.some((value) => typeof value !== "boolean") || new Set(values).size > 1)
		throw new OfficialProviderError("INVALID_AUDIO_PARAMETER", `${keys[0]} must be a consistent boolean.`);
	return values[0] as boolean | undefined;
}

function readInteger(params: Record<string, unknown>, ...keys: string[]): number | undefined {
	const values = keys.filter((key) => params[key] !== undefined).map((key) => params[key]);
	if (values.some((value) => typeof value !== "number" || !Number.isInteger(value)) || new Set(values).size > 1)
		throw new OfficialProviderError("INVALID_AUDIO_PARAMETER", `${keys[0]} must be a consistent integer.`);
	return values[0] as number | undefined;
}

interface MiniMaxMusicResponse {
	base_resp?: { status_code?: unknown; status_msg?: unknown };
	data?: { audio?: unknown };
}
