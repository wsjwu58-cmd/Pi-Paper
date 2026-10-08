import { endpoint, OfficialProviderError, requireApiKey, resolveBaseUrl } from "./http.ts";
import { runOfficialVideoTask, videoJsonHeaders } from "./official-video-task.ts";
import type { OfficialGenerationInput, OfficialGenerationOptions } from "./types.ts";

export const WAN_VIDEO_PROVIDER_ID = "alibaba-video";
export const WAN_30_VIDEO_MODEL_ID = "wan3.0-video";
export const WAN_30_VIDEO_PRIME_MODEL_ID = "wan3.0-video-prime";
export const WAN_VIDEO_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";

const WAN_REGIONS = [
	"cn-beijing",
	"ap-southeast-1",
	"ap-northeast-1",
	"eu-central-1",
	"us-east-1",
	"cn-hongkong",
] as const;
const WAN_RATIOS = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;

interface WanVideoRequest {
	model: string;
	input: { prompt: string };
	parameters: {
		resolution: "480P" | "720P" | "1080P";
		ratio: string;
		duration: number;
		audio?: boolean;
		seed?: number;
		prompt_extend?: boolean;
		watermark?: boolean;
	};
}

interface WanCreatedTask {
	output?: { task_id?: string | number };
}

interface WanVideoTask {
	output?: { task_status?: string; video_url?: unknown };
}

/** Submit or resume text-to-video using the documented Wan 3.0 workspace API. */
export async function generateWanVideo(input: OfficialGenerationInput, options: OfficialGenerationOptions) {
	const request = buildWanVideoRequest(input);
	const apiKey = requireApiKey(options, WAN_VIDEO_PROVIDER_ID);
	const baseUrl = resolveWanBaseUrl(options);
	return runOfficialVideoTask<WanCreatedTask, WanVideoTask>(input, options, apiKey, {
		providerName: "Wan",
		baseUrl,
		submitPath: "services/aigc/video-generation/video-synthesis",
		queryPath: (taskId) => `tasks/${encodeURIComponent(taskId)}`,
		request,
		pollIntervalMs: 15_000,
		submitHeaders: (key) => videoJsonHeaders(key, { "X-DashScope-Async": "enable" }),
		queryHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
		readTaskId: (payload) => payload.output?.task_id,
		readTask: (payload) => ({ status: payload.output?.task_status, videoUrl: payload.output?.video_url }),
		activeStatuses: ["pending", "running"],
		succeededStatuses: ["succeeded"],
		failedStatuses: ["failed", "canceled", "cancelled", "unknown"],
	});
}

export function buildWanVideoRequest(input: OfficialGenerationInput): WanVideoRequest {
	assertWanVideoInput(input);
	if (input.references?.length) {
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"This Wan video adapter currently supports text-to-video requests only.",
		);
	}
	const params = getParams(input.params);
	const unsupported = Object.keys(params).filter(
		(key) =>
			![
				"resolution",
				"size",
				"ratio",
				"aspectRatio",
				"aspect_ratio",
				"duration",
				"seconds",
				"audio",
				"generate_audio",
				"generateAudio",
				"seed",
				"prompt_extend",
				"promptExtend",
				"watermark",
			].includes(key),
	);
	if (unsupported.length) {
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"The Wan video request includes parameters not supported by this adapter.",
		);
	}
	const prompt = input.prompt.trim();
	if (!prompt || prompt.length > 20_000) {
		throw new OfficialProviderError("INVALID_INPUT", "The Wan video prompt is empty or too long.");
	}
	const rawResolution = String(params.resolution ?? params.size ?? "1080P")
		.trim()
		.toUpperCase();
	const resolutionBySize: Record<string, WanVideoRequest["parameters"]["resolution"]> = {
		"480P": "480P",
		"720P": "720P",
		"1080P": "1080P",
		"854X480": "480P",
		"480X854": "480P",
		"1280X720": "720P",
		"720X1280": "720P",
		"1920X1080": "1080P",
		"1080X1920": "1080P",
	};
	const resolution = resolutionBySize[rawResolution];
	if (!resolution) throw new OfficialProviderError("INVALID_INPUT", "The Wan video resolution is invalid.");
	const ratioValue = params.ratio ?? params.aspectRatio ?? params.aspect_ratio ?? "adaptive";
	if (typeof ratioValue !== "string" || !(WAN_RATIOS as readonly string[]).includes(ratioValue)) {
		throw new OfficialProviderError("INVALID_INPUT", "The Wan video aspect ratio is invalid.");
	}
	const rawDuration = Number(params.duration ?? params.seconds ?? 5);
	if (!Number.isInteger(rawDuration) || (rawDuration !== -1 && (rawDuration < 2 || rawDuration > 30))) {
		throw new OfficialProviderError(
			"INVALID_INPUT",
			"Wan 3.0 video duration must be -1 or an integer from 2 to 30 seconds.",
		);
	}
	const parameters: WanVideoRequest["parameters"] = { resolution, ratio: ratioValue, duration: rawDuration };
	const audio = params.audio ?? params.generate_audio ?? params.generateAudio;
	if (audio !== undefined) {
		if (typeof audio !== "boolean")
			throw new OfficialProviderError("INVALID_INPUT", "The Wan audio parameter must be a boolean.");
		parameters.audio = audio;
	}
	if (params.seed !== undefined) {
		const seed = Number(params.seed);
		if (!Number.isInteger(seed) || (seed !== -1 && (seed < 0 || seed > 2_147_483_647))) {
			throw new OfficialProviderError(
				"INVALID_INPUT",
				"The Wan seed must be -1 or an integer from 0 to 2147483647.",
			);
		}
		parameters.seed = seed;
	}
	const promptExtend = params.prompt_extend ?? params.promptExtend;
	if (promptExtend !== undefined) {
		if (typeof promptExtend !== "boolean")
			throw new OfficialProviderError("INVALID_INPUT", "The Wan prompt_extend parameter must be a boolean.");
		parameters.prompt_extend = promptExtend;
	}
	if (params.watermark !== undefined) {
		if (typeof params.watermark !== "boolean")
			throw new OfficialProviderError("INVALID_INPUT", "The Wan watermark parameter must be a boolean.");
		parameters.watermark = params.watermark;
	}
	return { model: input.modelId, input: { prompt }, parameters };
}

function assertWanVideoInput(input: OfficialGenerationInput): void {
	if (
		input.providerId !== WAN_VIDEO_PROVIDER_ID ||
		input.modality !== "video" ||
		![WAN_30_VIDEO_MODEL_ID, WAN_30_VIDEO_PRIME_MODEL_ID].includes(input.modelId)
	) {
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured Wan video model is unavailable.");
	}
	if (input.operation !== undefined && input.operation !== "task") {
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured Wan video operation is unavailable.");
	}
}

function resolveWanBaseUrl(options: OfficialGenerationOptions): string {
	const credentials = options.credentials ?? {};
	const workspaceId = credentials.workspaceId ?? credentials.workspace_id;
	const region = credentials.region;
	if (
		typeof workspaceId !== "string" ||
		!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/u.test(workspaceId) ||
		typeof region !== "string" ||
		!(WAN_REGIONS as readonly string[]).includes(region)
	) {
		throw new OfficialProviderError(
			"PROVIDER_CONFIGURATION_REQUIRED",
			"Configure a valid Wan workspace ID and supported region.",
		);
	}
	const derivedBaseUrl = `https://${workspaceId}.${region}.maas.aliyuncs.com/api/v1`;
	if (options.baseUrl !== undefined && options.baseUrl !== WAN_VIDEO_BASE_URL && options.baseUrl !== derivedBaseUrl) {
		throw new OfficialProviderError(
			"INVALID_BASE_URL",
			"Wan video generation requires the configured workspace and region endpoint.",
		);
	}
	const baseUrl = resolveBaseUrl({ ...options, baseUrl: derivedBaseUrl }, WAN_VIDEO_BASE_URL, WAN_VIDEO_PROVIDER_ID);
	const url = new URL(baseUrl);
	if (
		url.protocol !== "https:" ||
		url.hostname !== `${workspaceId}.${region}.maas.aliyuncs.com` ||
		url.port ||
		url.pathname.replace(/\/$/u, "") !== "/api/v1"
	) {
		throw new OfficialProviderError(
			"INVALID_BASE_URL",
			"Wan video generation must use the configured official workspace endpoint.",
		);
	}
	return endpoint(baseUrl, "");
}

function getParams(value: Record<string, unknown> | undefined): Record<string, unknown> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new OfficialProviderError("INVALID_INPUT", "Wan video parameters must be an object.");
	}
	return value;
}
