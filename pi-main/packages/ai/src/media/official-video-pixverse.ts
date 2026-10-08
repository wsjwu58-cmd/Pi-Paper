import { randomUUID } from "node:crypto";
import { OfficialProviderError, requireApiKey, resolveBaseUrl } from "./http.ts";
import { type OfficialVideoTaskProtocol, runOfficialVideoTask } from "./official-video-task.ts";
import type { OfficialGenerationInput, OfficialGenerationOptions, OfficialGenerationResult } from "./types.ts";

export const PIXVERSE_VIDEO_PROVIDER_ID = "pixverse";
export const PIXVERSE_V6_API_MODEL_ID = "v6";
export const PIXVERSE_VIDEO_BASE_URL = "https://app-api.pixverse.ai/openapi/v2";

const ASPECT_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "2:3", "3:2", "21:9"] as const;
const QUALITIES = ["360p", "540p", "720p", "1080p"] as const;
const MAX_PROMPT_CHARS = 5_000;

interface PixVerseEnvelope {
	ErrCode?: number | string;
	ErrMsg?: string;
	Resp?: {
		video_id?: number | string;
		status?: number | string;
		url?: unknown;
	};
}

export interface PixVerseV6Request {
	model: typeof PIXVERSE_V6_API_MODEL_ID;
	prompt: string;
	duration: number;
	quality: string;
	aspect_ratio: string;
	seed?: number;
	generate_audio_switch?: boolean;
	generate_multi_clip_switch?: boolean;
}

/** PixVerse V6 text generation is the verified path implemented in this adapter. */
export function buildPixVerseV6Request(input: OfficialGenerationInput): PixVerseV6Request {
	if (
		input.providerId !== PIXVERSE_VIDEO_PROVIDER_ID ||
		input.modelId !== PIXVERSE_V6_API_MODEL_ID ||
		input.modality !== "video"
	) {
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured PixVerse V6 video model is unavailable.");
	}
	if (input.operation !== undefined && input.operation !== "task")
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured PixVerse V6 operation is unavailable.");
	if (input.references?.length)
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"PixVerse V6 is currently enabled here for text-to-video only.",
		);
	const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
	if (!prompt || prompt.length > MAX_PROMPT_CHARS)
		throw new OfficialProviderError("INVALID_INPUT", "PixVerse V6 prompts must contain 1–5,000 characters.");
	const params = input.params ?? {};
	if (input.params !== undefined && (!input.params || Array.isArray(input.params) || typeof input.params !== "object"))
		throw new OfficialProviderError("INVALID_INPUT", "PixVerse parameters must be an object.");
	assertAllowedParams(params);
	const duration = Number(params.duration ?? params.seconds ?? 5);
	if (!Number.isInteger(duration) || duration < 1 || duration > 15)
		throw new OfficialProviderError("INVALID_INPUT", "PixVerse V6 duration must be between 1 and 15 seconds.");
	const quality = String(params.quality ?? params.resolution ?? params.size ?? "720p")
		.trim()
		.toLowerCase();
	if (!(QUALITIES as readonly string[]).includes(quality))
		throw new OfficialProviderError("INVALID_INPUT", "PixVerse V6 quality must be 360p, 540p, 720p, or 1080p.");
	const aspectRatio = String(params.aspect_ratio ?? params.aspectRatio ?? params.ratio ?? "16:9").trim();
	if (!(ASPECT_RATIOS as readonly string[]).includes(aspectRatio))
		throw new OfficialProviderError("INVALID_INPUT", "PixVerse V6 aspect ratio is invalid.");
	const seed = params.seed === undefined ? undefined : Number(params.seed);
	if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647))
		throw new OfficialProviderError(
			"INVALID_INPUT",
			"PixVerse V6 seed must be an integer between 0 and 2,147,483,647.",
		);
	const audioValues = [params.generate_audio_switch, params.generateAudio, params.generate_audio].filter(
		(value) => value !== undefined,
	);
	if (audioValues.some((value) => typeof value !== "boolean"))
		throw new OfficialProviderError("INVALID_INPUT", "PixVerse generate_audio_switch must be a boolean.");
	if (new Set(audioValues).size > 1)
		throw new OfficialProviderError("INVALID_INPUT", "PixVerse audio aliases contain conflicting values.");
	const audioValue = audioValues[0];
	const multiClipValue = params.generate_multi_clip_switch ?? params.generateMultiClip;
	if (audioValue !== undefined && typeof audioValue !== "boolean")
		throw new OfficialProviderError("INVALID_INPUT", "PixVerse generate_audio_switch must be a boolean.");
	if (multiClipValue !== undefined && typeof multiClipValue !== "boolean")
		throw new OfficialProviderError("INVALID_INPUT", "PixVerse generate_multi_clip_switch must be a boolean.");
	const fullPrompt = withExplicitStyleAndCamera(prompt, params);
	if (fullPrompt.length > MAX_PROMPT_CHARS)
		throw new OfficialProviderError(
			"INVALID_INPUT",
			"PixVerse V6 prompts, including style and camera directions, must be at most 5,000 characters.",
		);
	return {
		model: PIXVERSE_V6_API_MODEL_ID,
		prompt: fullPrompt,
		duration,
		quality,
		aspect_ratio: aspectRatio,
		...(seed === undefined ? {} : { seed }),
		...(audioValue === undefined ? {} : { generate_audio_switch: audioValue as boolean }),
		...(multiClipValue === undefined ? {} : { generate_multi_clip_switch: multiClipValue as boolean }),
	};
}

export async function generatePixVerseV6Video(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	const request = buildPixVerseV6Request(input);
	const apiKey = requireApiKey(options, PIXVERSE_VIDEO_PROVIDER_ID);
	const baseUrl = resolveBaseUrl(options, PIXVERSE_VIDEO_BASE_URL, PIXVERSE_VIDEO_PROVIDER_ID);
	const base = new URL(baseUrl);
	if (
		base.protocol !== "https:" ||
		base.hostname !== "app-api.pixverse.ai" ||
		base.port ||
		base.pathname.replace(/\/$/u, "") !== "/openapi/v2"
	) {
		throw new OfficialProviderError("INVALID_BASE_URL", "PixVerse V6 requires the official HTTPS OpenAPI endpoint.");
	}
	const traceId = () => randomUUID();
	const protocol: OfficialVideoTaskProtocol<PixVerseEnvelope, PixVerseEnvelope> = {
		providerName: "PixVerse V6",
		baseUrl,
		submitPath: "video/text/generate",
		queryPath: (taskId) => `video/result/${encodeURIComponent(taskId)}`,
		request,
		pollIntervalMs: 3_000,
		submitHeaders: (key) => ({ "API-KEY": key, "Ai-trace-id": traceId(), "Content-Type": "application/json" }),
		queryHeaders: (key) => ({ "API-KEY": key, "Ai-trace-id": traceId(), "Content-Type": "application/json" }),
		readTaskId: (payload) => {
			assertPixVerseSuccess(payload);
			return payload.Resp?.video_id;
		},
		readTask: (payload) => {
			assertPixVerseSuccess(payload);
			return { status: String(payload.Resp?.status ?? ""), videoUrl: payload.Resp?.url };
		},
		activeStatuses: ["5"],
		succeededStatuses: ["1"],
		failedStatuses: ["7", "8"],
	};
	return runOfficialVideoTask(input, options, apiKey, protocol);
}

function assertPixVerseSuccess(payload: PixVerseEnvelope): void {
	if (payload.ErrCode !== undefined && Number(payload.ErrCode) !== 0) {
		const message = typeof payload.ErrMsg === "string" ? payload.ErrMsg.slice(0, 300) : "unknown provider error";
		throw new OfficialProviderError("GENERATION_FAILED", `PixVerse rejected the video task (${message}).`);
	}
}

function withExplicitStyleAndCamera(prompt: string, params: Record<string, unknown>): string {
	const values = [prompt];
	for (const [keys, label] of [
		[["style"], "Style"],
		[["camera", "cameraMovement", "camera_movement"], "Camera movement"],
	] as const) {
		const value = keys.map((key) => params[key]).find((entry) => typeof entry === "string" && entry.trim());
		if (typeof value === "string") values.push(`${label}: ${value.trim()}`);
	}
	return values.join("\n");
}

function assertAllowedParams(params: Record<string, unknown>): void {
	const supported = new Set([
		"duration",
		"seconds",
		"quality",
		"resolution",
		"size",
		"aspect_ratio",
		"aspectRatio",
		"ratio",
		"seed",
		"generate_audio_switch",
		"generateAudio",
		"generate_audio",
		"generate_multi_clip_switch",
		"generateMultiClip",
		"style",
		"camera",
		"cameraMovement",
		"camera_movement",
	]);
	const unknown = Object.keys(params).find((key) => !supported.has(key));
	if (unknown)
		throw new OfficialProviderError("INVALID_INPUT", `PixVerse V6 does not support the ${unknown} parameter.`);
}
