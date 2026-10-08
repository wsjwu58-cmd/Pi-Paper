import { OfficialProviderError, requireApiKey, resolveBaseUrl } from "./http.ts";
import { runOfficialVideoTask, videoJsonHeaders } from "./official-video-task.ts";
import type { OfficialGenerationInput, OfficialGenerationOptions } from "./types.ts";

export const MINIMAX_VIDEO_PROVIDER_ID = "minimax";
export const MINIMAX_H3_MODEL_ID = "MiniMax-H3";
export const MINIMAX_H3_MAX_MODEL_ID = "MiniMax-H3-Max";
export const MINIMAX_VIDEO_BASE_URL = "https://api.minimax.io";

const H3_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;

interface MiniMaxVideoRequest {
	model: string;
	content: [{ type: "text"; text: string }];
	resolution: "480P" | "768P" | "2K";
	duration: number;
	ratio: string;
}

interface MiniMaxCreatedTask {
	task_id?: string | number;
}

interface MiniMaxVideoTask {
	task?: {
		status?: string;
		content?: { url?: unknown };
	};
}

/** Submit or resume a text-to-video task through the MiniMax H3 V2 API. */
export async function generateMiniMaxVideo(input: OfficialGenerationInput, options: OfficialGenerationOptions) {
	const request = buildMiniMaxVideoRequest(input);
	const apiKey = requireApiKey(options, MINIMAX_VIDEO_PROVIDER_ID);
	const baseUrl = resolveMiniMaxVideoBaseUrl(options);
	return runOfficialVideoTask<MiniMaxCreatedTask, MiniMaxVideoTask>(input, options, apiKey, {
		providerName: "MiniMax",
		baseUrl,
		submitPath: "v2/video_generation",
		queryPath: (taskId) => `v2/query/video_generation/${encodeURIComponent(taskId)}`,
		request,
		pollIntervalMs: 5_000,
		submitHeaders: (key) => videoJsonHeaders(key),
		queryHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
		readTaskId: (payload) => payload.task_id,
		readTask: (payload) => ({ status: payload.task?.status, videoUrl: payload.task?.content?.url }),
		activeStatuses: ["queued", "running"],
		succeededStatuses: ["succeeded"],
		failedStatuses: ["failed", "cancelled", "canceled"],
	});
}

export function buildMiniMaxVideoRequest(input: OfficialGenerationInput): MiniMaxVideoRequest {
	assertMiniMaxVideoInput(input);
	if (input.references?.length) {
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"This MiniMax video adapter currently supports text-to-video requests only.",
		);
	}
	const params = getParams(input.params);
	const unsupported = Object.keys(params).filter(
		(key) => !["resolution", "size", "duration", "seconds", "ratio", "aspectRatio", "aspect_ratio"].includes(key),
	);
	if (unsupported.length) {
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"The MiniMax video request includes parameters not supported by this adapter.",
		);
	}
	const prompt = input.prompt.trim();
	if (!prompt || prompt.length > 20_000) {
		throw new OfficialProviderError("INVALID_INPUT", "The MiniMax video prompt is empty or too long.");
	}
	const isMax = input.modelId === MINIMAX_H3_MAX_MODEL_ID;
	const resolutionInput = String(params.resolution ?? params.size ?? "768P")
		.trim()
		.toUpperCase();
	const allowedResolutions = isMax ? ["480P", "768P"] : ["768P", "2K"];
	if (!allowedResolutions.includes(resolutionInput)) {
		throw new OfficialProviderError("INVALID_INPUT", `The ${input.modelId} resolution is unsupported.`);
	}
	const duration = Number(params.duration ?? params.seconds ?? 6);
	const minimumDuration = isMax ? 5 : 4;
	if (!Number.isInteger(duration) || duration < minimumDuration || duration > 15) {
		throw new OfficialProviderError(
			"INVALID_INPUT",
			`The ${input.modelId} duration must be an integer from ${minimumDuration} to 15 seconds.`,
		);
	}
	const ratio = params.ratio ?? params.aspectRatio ?? params.aspect_ratio ?? "16:9";
	if (typeof ratio !== "string" || !(H3_RATIOS as readonly string[]).includes(ratio)) {
		throw new OfficialProviderError(
			"INVALID_INPUT",
			"MiniMax text-to-video requires a supported fixed aspect ratio.",
		);
	}
	return {
		model: input.modelId,
		content: [{ type: "text", text: prompt }],
		resolution: resolutionInput as MiniMaxVideoRequest["resolution"],
		duration,
		ratio,
	};
}

function assertMiniMaxVideoInput(input: OfficialGenerationInput): void {
	if (
		input.providerId !== MINIMAX_VIDEO_PROVIDER_ID ||
		input.modality !== "video" ||
		![MINIMAX_H3_MODEL_ID, MINIMAX_H3_MAX_MODEL_ID].includes(input.modelId)
	) {
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured MiniMax video model is unavailable.");
	}
	if (input.operation !== undefined && input.operation !== "task") {
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured MiniMax video operation is unavailable.");
	}
}

function resolveMiniMaxVideoBaseUrl(options: OfficialGenerationOptions): string {
	const configured = resolveBaseUrl(options, MINIMAX_VIDEO_BASE_URL, MINIMAX_VIDEO_PROVIDER_ID);
	const url = new URL(configured);
	if (
		url.protocol !== "https:" ||
		url.hostname !== "api.minimax.io" ||
		url.port ||
		url.search ||
		url.hash ||
		!["", "/", "/v1", "/v2", "/anthropic"].includes(url.pathname)
	) {
		throw new OfficialProviderError(
			"INVALID_BASE_URL",
			"MiniMax video generation must use the official MiniMax API root.",
		);
	}
	return url.origin;
}

function getParams(value: Record<string, unknown> | undefined): Record<string, unknown> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new OfficialProviderError("INVALID_INPUT", "MiniMax video parameters must be an object.");
	}
	return value;
}
