import { endpoint, OfficialProviderError, requireApiKey, resolveBaseUrl } from "./http.ts";
import { runOfficialVideoTask, videoJsonHeaders } from "./official-video-task.ts";
import type { OfficialGenerationInput, OfficialGenerationOptions } from "./types.ts";

export const XAI_VIDEO_PROVIDER_ID = "xai";
export const XAI_GROK_IMAGINE_VIDEO_MODEL_ID = "grok-imagine-video";
export const XAI_GROK_IMAGINE_VIDEO_15_MODEL_ID = "grok-imagine-video-1.5";
export const XAI_VIDEO_BASE_URL = "https://api.x.ai/v1";

interface XaiVideoRequest {
	model: string;
	prompt: string;
	duration?: number;
	aspect_ratio?: string;
	resolution?: string;
	generate_audio?: boolean;
}

interface XaiCreatedTask {
	request_id?: string | number;
}

interface XaiVideoTask {
	status?: string;
	video?: { url?: unknown };
}

const ACCEPTED_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
const ACCEPTED_RESOLUTIONS = ["480p", "720p", "1080p"] as const;

/** Submit or resume a text-to-video task using the official xAI REST API. */
export async function generateXaiVideo(input: OfficialGenerationInput, options: OfficialGenerationOptions) {
	const request = buildXaiVideoRequest(input);
	const apiKey = requireApiKey(options, XAI_VIDEO_PROVIDER_ID);
	const baseUrl = resolveXaiBaseUrl(options);
	return runOfficialVideoTask<XaiCreatedTask, XaiVideoTask>(input, options, apiKey, {
		providerName: "xAI",
		baseUrl,
		submitPath: "videos/generations",
		queryPath: (taskId) => `videos/${encodeURIComponent(taskId)}`,
		request,
		pollIntervalMs: 5_000,
		submitHeaders: (key) => videoJsonHeaders(key),
		queryHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
		readTaskId: (payload) => payload.request_id,
		readTask: (payload) => ({ status: payload.status, videoUrl: payload.video?.url }),
		activeStatuses: ["pending"],
		succeededStatuses: ["done"],
		failedStatuses: ["failed", "expired"],
	});
}

export function buildXaiVideoRequest(input: OfficialGenerationInput): XaiVideoRequest {
	assertXaiVideoInput(input);
	if (input.references?.length) {
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"This xAI video adapter currently supports text-to-video requests only.",
		);
	}
	const params = getParams(input.params);
	const unsupported = Object.keys(params).filter(
		(key) =>
			![
				"duration",
				"seconds",
				"aspectRatio",
				"aspect_ratio",
				"ratio",
				"resolution",
				"generate_audio",
				"generateAudio",
			].includes(key),
	);
	if (unsupported.length) {
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"The xAI video request includes parameters not supported by this adapter.",
		);
	}
	const prompt = input.prompt.trim();
	if (!prompt || prompt.length > 200_000) {
		throw new OfficialProviderError("INVALID_INPUT", "The xAI video prompt is empty or too long.");
	}
	const request: XaiVideoRequest = {
		model: input.modelId,
		prompt,
		aspect_ratio: "16:9",
		resolution: "480p",
		generate_audio: true,
	};
	const durationInput = params.duration ?? params.seconds;
	if (durationInput !== undefined) {
		const duration = Number(durationInput);
		if (!Number.isInteger(duration) || duration < 1 || duration > 15) {
			throw new OfficialProviderError(
				"INVALID_INPUT",
				"xAI video duration must be an integer from 1 to 15 seconds.",
			);
		}
		request.duration = duration;
	}
	const ratioInput = params.aspectRatio ?? params.aspect_ratio ?? params.ratio;
	if (ratioInput !== undefined) {
		if (typeof ratioInput !== "string" || !(ACCEPTED_ASPECT_RATIOS as readonly string[]).includes(ratioInput)) {
			throw new OfficialProviderError("INVALID_INPUT", "The xAI video aspect ratio is invalid.");
		}
		request.aspect_ratio = ratioInput;
	}
	if (params.resolution !== undefined) {
		if (
			typeof params.resolution !== "string" ||
			!(ACCEPTED_RESOLUTIONS as readonly string[]).includes(params.resolution.toLowerCase())
		) {
			throw new OfficialProviderError("INVALID_INPUT", "The xAI video resolution is invalid.");
		}
		const resolution = params.resolution.toLowerCase();
		if (resolution === "1080p" && input.modelId !== XAI_GROK_IMAGINE_VIDEO_15_MODEL_ID) {
			throw new OfficialProviderError(
				"UNSUPPORTED_INPUT_MODE",
				"xAI 1080p video output is only available for Grok Imagine Video 1.5.",
			);
		}
		request.resolution = resolution;
	}
	const audio = params.generate_audio ?? params.generateAudio;
	if (audio !== undefined) {
		if (typeof audio !== "boolean")
			throw new OfficialProviderError("INVALID_INPUT", "The xAI generate_audio parameter must be a boolean.");
		request.generate_audio = audio;
	}
	return request;
}

function assertXaiVideoInput(input: OfficialGenerationInput): void {
	if (
		input.providerId !== XAI_VIDEO_PROVIDER_ID ||
		input.modality !== "video" ||
		![XAI_GROK_IMAGINE_VIDEO_MODEL_ID, XAI_GROK_IMAGINE_VIDEO_15_MODEL_ID].includes(input.modelId)
	) {
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured xAI video model is unavailable.");
	}
	if (input.operation !== undefined && input.operation !== "task") {
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured xAI video operation is unavailable.");
	}
}

function resolveXaiBaseUrl(options: OfficialGenerationOptions): string {
	const baseUrl = resolveBaseUrl(options, XAI_VIDEO_BASE_URL, XAI_VIDEO_PROVIDER_ID);
	const url = new URL(baseUrl);
	if (
		url.protocol !== "https:" ||
		url.hostname !== "api.x.ai" ||
		url.port ||
		url.pathname.replace(/\/$/u, "") !== "/v1"
	) {
		throw new OfficialProviderError("INVALID_BASE_URL", "xAI video generation must use the official xAI API root.");
	}
	return endpoint(baseUrl, "");
}

function getParams(value: Record<string, unknown> | undefined): Record<string, unknown> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new OfficialProviderError("INVALID_INPUT", "xAI video parameters must be an object.");
	}
	return value;
}
