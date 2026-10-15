import { OfficialProviderError, referenceValue, requireApiKey, resolveBaseUrl } from "./http.ts";
import { runOfficialVideoTask, videoJsonHeaders } from "./official-video-task.ts";
import { ZHIPU_VIDEO_DIMENSIONS } from "./official-zhipu-models.ts";
import type { OfficialGenerationInput, OfficialGenerationOptions } from "./types.ts";

interface ZhipuVideoResponse {
	id?: unknown;
	task_status?: unknown;
	video_result?: Array<{ url?: unknown }>;
}

export async function generateZhipuVideo(input: OfficialGenerationInput, options: OfficialGenerationOptions) {
	const request = buildZhipuVideoRequest(input);
	const key = requireApiKey(options, "zhipu");
	const baseUrl = resolveBaseUrl(options, "https://open.bigmodel.cn/api/paas/v4", "zhipu");
	return runOfficialVideoTask<ZhipuVideoResponse, ZhipuVideoResponse>(input, options, key, {
		providerName: "智谱",
		baseUrl,
		submitPath: "videos/generations",
		queryPath: (id) => `async-result/${encodeURIComponent(id)}`,
		request,
		pollIntervalMs: 5_000,
		submitHeaders: videoJsonHeaders,
		queryHeaders: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
		readTaskId: (payload) => payload.id,
		readTask: (payload) => ({ status: payload.task_status, videoUrl: payload.video_result?.[0]?.url }),
		activeStatuses: ["processing"],
		succeededStatuses: ["success"],
		failedStatuses: ["fail"],
	});
}

export function buildZhipuVideoRequest(input: OfficialGenerationInput) {
	if (input.providerId !== "zhipu" || input.modelId !== "cogvideox-3" || input.modality !== "video")
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured Zhipu video model is unavailable.");
	if (input.operation !== undefined && input.operation !== "task")
		throw new OfficialProviderError("UNSUPPORTED_OPERATION", "CogVideoX-3 requires asynchronous video generation.");
	const params = input.params ?? {};
	const allowed = ["ratio", "resolution", "size", "duration", "generate_audio", "with_audio", "fps", "quality"];
	if (
		!params ||
		typeof params !== "object" ||
		Array.isArray(params) ||
		Object.keys(params).some((key) => !allowed.includes(key))
	)
		throw new OfficialProviderError("INVALID_INPUT", "The CogVideoX-3 request contains unsupported parameters.");
	const prompt = input.prompt.trim();
	if ([...prompt].length > 512)
		throw new OfficialProviderError("INVALID_INPUT", "CogVideoX-3 prompts must contain at most 512 characters.");
	const references = input.references ?? [];
	if (references.length > 2 || references.some((ref) => ref.type !== "image"))
		throw new OfficialProviderError("UNSUPPORTED_INPUT_MODE", "CogVideoX-3 accepts up to two image references.");
	if (!prompt && !references.length)
		throw new OfficialProviderError("INVALID_INPUT", "CogVideoX-3 requires a prompt or image reference.");
	const images = references.map((reference) => {
		if (reference.base64 && (!reference.mimeType || !["image/png", "image/jpeg"].includes(reference.mimeType)))
			throw new OfficialProviderError("UNSUPPORTED_INPUT_MODE", "CogVideoX-3 supports PNG or JPEG references.");
		if (reference.base64 && Buffer.from(reference.base64, "base64").byteLength > 5 * 1024 * 1024)
			throw new OfficialProviderError("INVALID_INPUT", "CogVideoX-3 references cannot exceed 5 MB.");
		return referenceValue(reference, "CogVideoX-3 image");
	});
	const ratio = params.ratio ?? "16:9";
	const dimensions = typeof ratio === "string" ? ZHIPU_VIDEO_DIMENSIONS[ratio] : undefined;
	const resolution = params.resolution ?? params.size ?? "1080p";
	const size =
		typeof resolution === "string"
			? Object.entries(dimensions ?? {}).find(
					([key, value]) => key.toLowerCase() === resolution.toLowerCase() || value === resolution,
				)?.[1]
			: undefined;
	if (!dimensions || !size)
		throw new OfficialProviderError(
			"INVALID_VIDEO_PARAMETER",
			"This CogVideoX-3 ratio and resolution combination is unsupported.",
		);
	if (params.resolution !== undefined && params.size !== undefined && params.resolution !== params.size)
		throw new OfficialProviderError("INVALID_VIDEO_PARAMETER", "CogVideoX-3 resolution and size conflict.");
	const duration = params.duration ?? 5;
	if (duration !== 5 && duration !== 10)
		throw new OfficialProviderError("INVALID_VIDEO_PARAMETER", "CogVideoX-3 duration must be 5 or 10 seconds.");
	const fps = params.fps ?? 30;
	if (fps !== 30 && fps !== 60)
		throw new OfficialProviderError("INVALID_VIDEO_PARAMETER", "CogVideoX-3 FPS must be 30 or 60.");
	const quality = params.quality ?? "speed";
	if (quality !== "speed" && quality !== "quality")
		throw new OfficialProviderError("INVALID_VIDEO_PARAMETER", "CogVideoX-3 quality must be speed or quality.");
	const withAudio = params.generate_audio ?? params.with_audio ?? false;
	if (
		typeof withAudio !== "boolean" ||
		(params.generate_audio !== undefined &&
			params.with_audio !== undefined &&
			params.generate_audio !== params.with_audio)
	)
		throw new OfficialProviderError(
			"INVALID_VIDEO_PARAMETER",
			"CogVideoX-3 audio flags must be boolean and consistent.",
		);
	return {
		model: input.modelId,
		prompt,
		size,
		duration,
		fps,
		quality,
		with_audio: withAudio,
		...(images.length ? { image_url: images.length === 1 ? images[0] : images } : {}),
	};
}
