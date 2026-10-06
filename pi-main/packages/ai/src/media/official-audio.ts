import {
	endpoint,
	OfficialProviderError,
	officialBytes,
	officialJson,
	pickString,
	redactSecret,
	requireApiKey,
	resolveBaseUrl,
	safeBase64,
} from "./http.ts";
import { generateDoubaoSpeech } from "./official-audio-doubao.ts";
import { generateDoubaoV1Speech } from "./official-audio-doubao-v1.ts";
import { generateElevenMusic } from "./official-audio-eleven-music.ts";
import { generateFishAudio } from "./official-audio-fish.ts";
import { generateMiniMaxMusic } from "./official-audio-minimax-music.ts";
import type { OfficialGenerationInput, OfficialGenerationOptions, OfficialGenerationResult } from "./types.ts";

const SUPPORTED_FORMATS = new Set(["mp3", "wav"]);
const MINIMAX_MODELS = new Set(["speech-2.8-hd", "speech-2.8-turbo"]);
const ELEVENLABS_VOICE_CONVERSION_MODELS = new Set(["eleven_multilingual_sts_v2", "eleven_english_sts_v2"]);

/** OpenAI text-to-speech through its documented `/v1/audio/speech` endpoint. */
export async function generateOfficialAudio(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	if (
		input.operation &&
		input.operation !== "speech" &&
		input.operation !== "voice-change" &&
		input.operation !== "music"
	) {
		throw new OfficialProviderError(
			"UNSUPPORTED_OPERATION",
			`Official speech generation is not implemented for ${input.providerId}.`,
		);
	}
	if (input.operation === "music") {
		if (input.providerId === "elevenlabs") return generateElevenMusic(input, options);
		if (input.providerId !== "minimax")
			throw new OfficialProviderError(
				"UNSUPPORTED_OPERATION",
				`Official music generation is not implemented for ${input.providerId}.`,
			);
		return generateMiniMaxMusic(input, options);
	}
	if (input.providerId === "elevenlabs") {
		if (ELEVENLABS_VOICE_CONVERSION_MODELS.has(input.modelId)) return generateElevenLabsVoiceChange(input, options);
		if (input.operation === "voice-change")
			throw new OfficialProviderError(
				"UNSUPPORTED_MODEL",
				"Choose a verified speech-to-speech model for voice conversion.",
			);
		return generateElevenLabsSpeech(input, options);
	}
	if (input.operation === "voice-change")
		throw new OfficialProviderError(
			"UNSUPPORTED_OPERATION",
			"Only the verified ElevenLabs voice conversion adapter supports this operation.",
		);
	if (input.providerId === "fish-audio") return generateFishAudio(input, options);
	if (input.providerId === "doubao-voice") return generateDoubaoSpeech(input, options);
	if (input.providerId === "doubao-voice-v1") return generateDoubaoV1Speech(input, options);
	if (input.providerId === "minimax") return generateMiniMaxSpeech(input, options);
	if (input.providerId !== "openai") {
		throw new OfficialProviderError(
			"UNSUPPORTED_PROVIDER",
			`Official speech generation is not implemented for ${input.providerId}.`,
		);
	}
	rejectUnconsumedReferences(input, "OpenAI text-to-speech does not accept reference media.");
	const apiKey = requireApiKey(options, input.providerId);
	const baseUrl = resolveBaseUrl(options, "https://api.openai.com/v1", input.providerId);
	const params = input.params ?? {};
	const voice = pickString(params, "voice");
	if (!voice) throw new OfficialProviderError("VOICE_REQUIRED", "Choose a voice for speech generation.");
	const responseFormat = pickString(params, "response_format", "responseFormat") ?? "mp3";
	if (!SUPPORTED_FORMATS.has(responseFormat)) {
		throw new OfficialProviderError(
			"UNSUPPORTED_AUDIO_FORMAT",
			"OpenAI audio output is limited to MP3 or WAV in this desktop pipeline.",
		);
	}
	const speed = typeof params.speed === "number" ? params.speed : undefined;
	if (speed !== undefined && (!Number.isFinite(speed) || speed < 0.25 || speed > 4)) {
		throw new OfficialProviderError("INVALID_AUDIO_PARAMETER", "Speech speed must be between 0.25 and 4.");
	}
	const body = {
		model: input.modelId,
		input: input.prompt,
		voice,
		response_format: responseFormat,
		...(speed !== undefined ? { speed } : {}),
		...(typeof params.instructions === "string" && params.instructions.trim()
			? { instructions: params.instructions }
			: {}),
	};
	const { bytes, response } = await officialBytes(
		endpoint(baseUrl, "audio/speech"),
		{
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "audio/*" },
			body: JSON.stringify(body),
		},
		options,
		apiKey,
		128 * 1024 * 1024,
	);
	const responseMime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	const mimeType = responseFormat === "wav" ? "audio/wav" : "audio/mpeg";
	if (responseMime && !responseMime.startsWith("audio/") && responseMime !== "application/octet-stream") {
		throw new OfficialProviderError(
			"INVALID_PROVIDER_RESPONSE",
			"The speech provider returned a non-audio response.",
			response.status,
		);
	}
	if (bytes.length < 12)
		throw new OfficialProviderError(
			"INVALID_PROVIDER_RESPONSE",
			"The speech provider returned empty audio.",
			response.status,
		);
	return {
		outputs: [
			{
				base64: Buffer.from(bytes).toString("base64"),
				mimeType: responseMime?.startsWith("audio/") ? responseMime : mimeType,
			},
		],
	};
}

async function generateElevenLabsSpeech(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	rejectUnconsumedReferences(input, "ElevenLabs text-to-speech does not accept source audio references.");
	if (!["eleven_flash_v2_5", "eleven_multilingual_v2", "eleven_v4", "eleven_v4_turbo"].includes(input.modelId)) {
		throw new OfficialProviderError(
			"UNSUPPORTED_MODEL",
			"Only the verified Eleven Flash v2.5 and Multilingual v2 speech models are supported.",
		);
	}
	const apiKey = requireApiKey(options, input.providerId);
	const params = input.params ?? {};
	assertAudioParams(params, ["voiceId", "voice_id", "voice", "output_format", "outputFormat"]);
	const voiceId = options.credentials?.voiceId ?? pickString(params, "voiceId", "voice_id", "voice");
	if (!voiceId?.trim()) throw new OfficialProviderError("VOICE_REQUIRED", "Configure an ElevenLabs Voice ID.");
	const outputFormat = pickString(params, "output_format", "outputFormat") ?? "mp3_44100_128";
	if (!/^mp3_[0-9]+_[0-9]+$/u.test(outputFormat)) {
		throw new OfficialProviderError(
			"UNSUPPORTED_AUDIO_FORMAT",
			"This desktop pipeline currently accepts ElevenLabs MP3 output only.",
		);
	}
	const baseUrl = resolveBaseUrl(options, "https://api.elevenlabs.io/v1", input.providerId);
	const dialogue = input.modelId.startsWith("eleven_v4");
	if (dialogue && [...input.prompt].length > 10_000)
		throw new OfficialProviderError(
			"INVALID_AUDIO_PARAMETER",
			"Eleven v4 text must contain at most 10000 characters.",
		);
	const url = new URL(
		endpoint(baseUrl, dialogue ? "text-to-dialogue" : `text-to-speech/${encodeURIComponent(voiceId)}`),
	);
	url.searchParams.set("output_format", outputFormat);
	const { bytes, response } = await officialBytes(
		url,
		{
			method: "POST",
			headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
			body: JSON.stringify(
				dialogue
					? { inputs: [{ text: input.prompt, voice_id: voiceId }], model_id: input.modelId }
					: { text: input.prompt, model_id: input.modelId },
			),
		},
		options,
		apiKey,
		128 * 1024 * 1024,
	);
	const responseMime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (responseMime && !responseMime.startsWith("audio/") && responseMime !== "application/octet-stream") {
		throw new OfficialProviderError(
			"INVALID_PROVIDER_RESPONSE",
			"ElevenLabs returned a non-audio response.",
			response.status,
		);
	}
	if (bytes.length < 12)
		throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "ElevenLabs returned empty audio.", response.status);
	return {
		outputs: [
			{
				base64: Buffer.from(bytes).toString("base64"),
				mimeType: responseMime?.startsWith("audio/") ? responseMime : "audio/mpeg",
			},
		],
	};
}

/**
 * MiniMax documents HTTP T2A for the exact 2.8 HD/Turbo IDs. It returns hex
 * encoded audio in JSON, so decode it here instead of treating it as a binary
 * HTTP response. This endpoint does not take reference audio; fail explicitly
 * if references are present so callers never believe they were applied.
 */
async function generateMiniMaxSpeech(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	rejectUnconsumedReferences(input, "MiniMax Speech 2.8 text-to-speech does not accept source audio references.");
	if (!MINIMAX_MODELS.has(input.modelId)) {
		throw new OfficialProviderError(
			"UNSUPPORTED_MODEL",
			"Only the verified MiniMax Speech 2.8 HD and Turbo models are supported.",
		);
	}
	const apiKey = requireApiKey(options, input.providerId);
	const params = input.params ?? {};
	assertAudioParams(params, [
		"voiceId",
		"voice_id",
		"voice",
		"format",
		"audio_format",
		"audioFormat",
		"speed",
		"pitch",
		"vol",
		"volume",
		"sample_rate",
		"sampleRate",
		"bitrate",
		"channel",
	]);
	const voiceId = options.credentials?.voiceId ?? pickString(params, "voiceId", "voice_id", "voice");
	if (!voiceId) throw new OfficialProviderError("VOICE_REQUIRED", "Choose a MiniMax voice for speech generation.");
	const format = pickString(params, "format", "audio_format", "audioFormat") ?? "mp3";
	if (!["mp3", "wav"].includes(format)) {
		throw new OfficialProviderError(
			"UNSUPPORTED_AUDIO_FORMAT",
			"The desktop MiniMax pipeline supports MP3 or WAV output.",
		);
	}
	const speed = readFiniteNumber(params, "speed");
	if (speed !== undefined && (speed < 0.5 || speed > 2)) {
		throw new OfficialProviderError("INVALID_AUDIO_PARAMETER", "MiniMax speech speed must be between 0.5 and 2.");
	}
	const pitch = readFiniteNumber(params, "pitch");
	const volume = readFiniteNumber(params, "vol", "volume");
	const sampleRate = readFiniteNumber(params, "sample_rate", "sampleRate");
	const bitrate = readFiniteNumber(params, "bitrate");
	const channel = readFiniteNumber(params, "channel");
	const baseUrl = resolveBaseUrl(
		{ ...options, baseUrl: "https://api.minimax.io/v1" },
		"https://api.minimax.io/v1",
		input.providerId,
	);
	const body = await officialJson<MiniMaxSpeechResponse>(
		endpoint(baseUrl, "t2a_v2"),
		{
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				model: input.modelId,
				text: input.prompt,
				stream: false,
				output_format: "hex",
				voice_setting: {
					voice_id: voiceId,
					...(speed !== undefined ? { speed } : {}),
					...(volume !== undefined ? { vol: volume } : {}),
					...(pitch !== undefined ? { pitch } : {}),
				},
				audio_setting: {
					format,
					...(sampleRate !== undefined ? { sample_rate: sampleRate } : {}),
					...(bitrate !== undefined ? { bitrate } : {}),
					...(channel !== undefined ? { channel } : {}),
				},
			}),
		},
		options,
		apiKey,
	);
	if (body.base_resp?.status_code !== 0) {
		const message = body.base_resp?.status_msg;
		throw new OfficialProviderError(
			"PROVIDER_GENERATION_FAILED",
			typeof message === "string" && message
				? `MiniMax speech generation failed: ${redactSecret(message.slice(0, 800), apiKey)}`
				: "MiniMax speech generation failed.",
		);
	}
	const audioHex = body.data?.audio;
	if (
		typeof audioHex !== "string" ||
		audioHex.length === 0 ||
		audioHex.length % 2 !== 0 ||
		!/^[\da-f]+$/iu.test(audioHex)
	) {
		throw new OfficialProviderError(
			"INVALID_PROVIDER_RESPONSE",
			"MiniMax returned invalid hex-encoded speech audio.",
		);
	}
	const audio = Buffer.from(audioHex, "hex");
	if (audio.length < 12 || audio.length > 128 * 1024 * 1024) {
		throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "MiniMax returned empty or oversized speech audio.");
	}
	return { outputs: [{ base64: audio.toString("base64"), mimeType: `audio/${format === "mp3" ? "mpeg" : format}` }] };
}

/** ElevenLabs voice conversion requires exactly one uploaded source audio file. */
async function generateElevenLabsVoiceChange(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	const apiKey = requireApiKey(options, input.providerId);
	const params = input.params ?? {};
	assertAudioParams(params, [
		"voiceId",
		"voice_id",
		"voice",
		"output_format",
		"outputFormat",
		"removeBackgroundNoise",
		"remove_background_noise",
	]);
	const voiceId = options.credentials?.voiceId ?? pickString(params, "voiceId", "voice_id", "voice");
	if (!voiceId) throw new OfficialProviderError("VOICE_REQUIRED", "Configure the target ElevenLabs Voice ID.");
	if (input.references?.length !== 1 || input.references[0]?.type !== "audio") {
		throw new OfficialProviderError(
			"AUDIO_REFERENCE_REQUIRED",
			"ElevenLabs Voice Changer requires exactly one source audio reference.",
		);
	}
	const reference = input.references[0];
	if (!reference.base64) {
		throw new OfficialProviderError(
			"INVALID_MEDIA_REFERENCE",
			"ElevenLabs Voice Changer needs source audio bytes; URL-only references are not supported by this adapter.",
		);
	}
	const audioBytes = safeBase64(reference.base64, "Source audio");
	const mimeType = normalizeAudioMimeType(reference.mimeType);
	const outputFormat = pickString(params, "output_format", "outputFormat") ?? "mp3_44100_128";
	if (!/^mp3_[0-9]+_[0-9]+$/u.test(outputFormat)) {
		throw new OfficialProviderError(
			"UNSUPPORTED_AUDIO_FORMAT",
			"This desktop pipeline currently accepts ElevenLabs MP3 output only.",
		);
	}
	const baseUrl = resolveBaseUrl(options, "https://api.elevenlabs.io/v1", input.providerId);
	const url = new URL(endpoint(baseUrl, `speech-to-speech/${encodeURIComponent(voiceId)}`));
	url.searchParams.set("output_format", outputFormat);
	const form = new FormData();
	form.append("audio", new Blob([Uint8Array.from(audioBytes).buffer], { type: mimeType }), audioFileName(mimeType));
	form.append("model_id", input.modelId);
	if (params.removeBackgroundNoise === true || params.remove_background_noise === true)
		form.append("remove_background_noise", "true");
	const { bytes, response } = await officialBytes(
		url,
		{ method: "POST", headers: { "xi-api-key": apiKey, Accept: "audio/mpeg" }, body: form },
		options,
		apiKey,
		128 * 1024 * 1024,
	);
	const responseMime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (responseMime && !responseMime.startsWith("audio/") && responseMime !== "application/octet-stream") {
		throw new OfficialProviderError(
			"INVALID_PROVIDER_RESPONSE",
			"ElevenLabs Voice Changer returned a non-audio response.",
			response.status,
		);
	}
	if (bytes.length < 12)
		throw new OfficialProviderError(
			"INVALID_PROVIDER_RESPONSE",
			"ElevenLabs Voice Changer returned empty audio.",
			response.status,
		);
	return {
		outputs: [
			{
				base64: Buffer.from(bytes).toString("base64"),
				mimeType: responseMime?.startsWith("audio/") ? responseMime : "audio/mpeg",
			},
		],
	};
}

function rejectUnconsumedReferences(input: OfficialGenerationInput, message: string): void {
	if (input.references?.length) throw new OfficialProviderError("REFERENCE_MEDIA_UNSUPPORTED", message);
}

function readFiniteNumber(params: Record<string, unknown>, ...keys: string[]): number | undefined {
	for (const key of keys) {
		const value = params[key];
		if (value !== undefined && typeof value !== "number")
			throw new OfficialProviderError("INVALID_AUDIO_PARAMETER", `${key} must be a number.`);
		if (typeof value === "number") {
			if (!Number.isFinite(value))
				throw new OfficialProviderError("INVALID_AUDIO_PARAMETER", `${key} must be a finite number.`);
			return value;
		}
	}
	return undefined;
}

function assertAudioParams(params: Record<string, unknown>, allowed: string[]): void {
	for (const [key, value] of Object.entries(params)) {
		if (!allowed.includes(key) && value !== undefined && !(typeof value === "string" && !value.trim()))
			throw new OfficialProviderError(
				"UNSUPPORTED_AUDIO_PARAMETER",
				`This audio adapter does not implement the parameter ${key}.`,
			);
	}
}

function normalizeAudioMimeType(value: string | undefined): string {
	const mimeType = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "audio/mpeg";
	if (!/^audio\/[a-z0-9.+-]+$/u.test(mimeType)) {
		throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", "Source audio has an invalid audio MIME type.");
	}
	return mimeType;
}

function audioFileName(mimeType: string): string {
	const extension =
		mimeType === "audio/mpeg"
			? "mp3"
			: mimeType === "audio/wav" || mimeType === "audio/x-wav"
				? "wav"
				: mimeType === "audio/flac"
					? "flac"
					: "audio";
	return `source.${extension}`;
}

interface MiniMaxSpeechResponse {
	data?: { audio?: unknown } | null;
	base_resp?: { status_code?: unknown; status_msg?: unknown } | null;
}
