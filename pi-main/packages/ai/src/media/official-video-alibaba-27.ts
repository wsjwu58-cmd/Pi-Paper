import { endpoint, OfficialProviderError, referenceValue, requireApiKey, resolveBaseUrl } from "./http.ts";
import { type OfficialVideoTaskProtocol, runOfficialVideoTask, videoJsonHeaders } from "./official-video-task.ts";
import type { OfficialGenerationInput, OfficialGenerationOptions, OfficialMediaReference } from "./types.ts";

export const ALIBABA_VIDEO_PROVIDER_ID = "alibaba-video";
export const WAN_27_T2V_MODEL_IDS = ["wan2.7-t2v", "wan2.7-t2v-2026-06-12", "wan2.7-t2v-2026-04-25"] as const;
export const WAN_27_I2V_MODEL_IDS = ["wan2.7-i2v", "wan2.7-i2v-2026-04-25"] as const;
export const WAN_27_R2V_MODEL_ID = "wan2.7-r2v-2026-06-12";
export const HAPPYHORSE_11_T2V_MODEL_ID = "happyhorse-1.1-t2v";
export const HAPPYHORSE_11_I2V_MODEL_ID = "happyhorse-1.1-i2v";
export const HAPPYHORSE_11_R2V_MODEL_ID = "happyhorse-1.1-r2v";
export const ALIBABA_27_VIDEO_MODEL_IDS = [
	...WAN_27_T2V_MODEL_IDS,
	...WAN_27_I2V_MODEL_IDS,
	WAN_27_R2V_MODEL_ID,
	HAPPYHORSE_11_T2V_MODEL_ID,
	HAPPYHORSE_11_I2V_MODEL_ID,
	HAPPYHORSE_11_R2V_MODEL_ID,
] as const;
export const ALIBABA_VIDEO_WORKSPACE_DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";

const WAN_REGIONS = [
	"cn-beijing",
	"ap-southeast-1",
	"ap-northeast-1",
	"eu-central-1",
	"us-east-1",
	"cn-hongkong",
] as const;
const WAN_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;
const HAPPYHORSE_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "5:4", "9:21", "21:9"] as const;
const RESOLUTIONS = ["480P", "720P", "1080P"] as const;
const MAX_PROMPT_CHARS = 5_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

type AlibabaVideoKind = "wan-t2v" | "wan-i2v" | "wan-r2v" | "happyhorse-t2v" | "happyhorse-i2v" | "happyhorse-r2v";

interface AlibabaVideoTask {
	output?: { task_id?: string | number; task_status?: string; video_url?: unknown };
	code?: string;
	message?: string;
}

export interface Alibaba27VideoRequest {
	model: string;
	input: { prompt: string; negative_prompt?: string; media?: Array<{ type: string; url: string }> };
	parameters: {
		resolution: string;
		duration: number;
		ratio?: string;
		prompt_extend?: boolean;
		watermark?: boolean;
		seed?: number;
	};
}

export function buildAlibaba27VideoRequest(input: OfficialGenerationInput): Alibaba27VideoRequest {
	const kind = resolveModelKind(input);
	if (input.operation !== undefined && input.operation !== "task")
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "This Alibaba video operation is unavailable.");
	const params = getParams(input.params);
	assertAllowedParams(params, kind);
	const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
	if (!prompt || prompt.length > MAX_PROMPT_CHARS)
		throw new OfficialProviderError("INVALID_INPUT", "Alibaba video prompts must contain 1–5,000 characters.");
	const isWan = kind.startsWith("wan-");
	const isText = kind.endsWith("t2v");
	const isI2v = kind.endsWith("i2v");
	const refs = collectImages(input, params, isI2v);
	if (isText && refs.length)
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"This text-to-video model does not accept image references.",
		);
	if (isI2v && refs.some((reference) => reference.role !== "first_frame" && reference.role !== "last_frame")) {
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"This image-to-video model accepts only first and optional last frames.",
		);
	}
	if (kind === "happyhorse-i2v" && refs.some((reference) => reference.role === "last_frame")) {
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"HappyHorse 1.1 image-to-video accepts only a first-frame image.",
		);
	}
	if (
		isI2v &&
		(refs.filter((reference) => reference.role === "first_frame").length !== 1 ||
			refs.length > 2 ||
			(refs.some((reference) => reference.role === "last_frame") &&
				refs.filter((reference) => reference.role === "last_frame").length !== 1))
	) {
		throw new OfficialProviderError(
			"INVALID_MEDIA_REFERENCE",
			"Image-to-video requires one first frame and optionally one different last frame.",
		);
	}
	if (kind.endsWith("r2v")) {
		const maxReferences = kind === "happyhorse-r2v" ? 9 : 5;
		const referenceImages = refs.filter((reference) => normalizedRole(reference.role) === "reference_image");
		const firstFrames = refs.filter((reference) => reference.role === "first_frame");
		if (
			referenceImages.length < 1 ||
			referenceImages.length > maxReferences ||
			firstFrames.length > 1 ||
			refs.some((reference) => !["reference_image", "first_frame"].includes(reference.role ?? "reference_image"))
		) {
			throw new OfficialProviderError(
				"INVALID_MEDIA_REFERENCE",
				`Reference-to-video requires 1–${maxReferences} reference images and at most one first frame.`,
			);
		}
	}
	if (!isText && !refs.length)
		throw new OfficialProviderError(
			"INVALID_MEDIA_REFERENCE",
			"This image-to-video model requires an image reference.",
		);

	const imageRatio = readImageRatio(params, isText, kind.startsWith("happyhorse-"));
	const rawResolution = String(params.resolution ?? params.size ?? "1080P")
		.trim()
		.toUpperCase();
	const allowedResolutions = isWan ? ["720P", "1080P"] : RESOLUTIONS;
	if (!(allowedResolutions as readonly string[]).includes(rawResolution))
		throw new OfficialProviderError("INVALID_INPUT", `Resolution must be ${allowedResolutions.join(", ")}.`);
	const duration = Number(params.duration ?? params.seconds ?? 5);
	const maximumDuration = kind === "wan-r2v" ? 10 : 15;
	if (!Number.isInteger(duration) || duration < (isWan ? 2 : 3) || duration > maximumDuration) {
		throw new OfficialProviderError(
			"INVALID_INPUT",
			`${input.modelId} duration must be ${isWan ? `2–${maximumDuration}` : "3–15"} seconds.`,
		);
	}
	const seed = params.seed === undefined ? undefined : Number(params.seed);
	if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647))
		throw new OfficialProviderError("INVALID_INPUT", "Seed must be an integer from 0 to 2147483647.");
	const watermark =
		params.watermark === undefined ? kind.startsWith("happyhorse-") : readBoolean(params.watermark, "watermark");
	const negativePrompt = readOptionalText(params.negative_prompt ?? params.negativePrompt, "negative_prompt", 500);
	const promptExtendValue = params.prompt_extend ?? params.promptExtend;
	if (promptExtendValue !== undefined && typeof promptExtendValue !== "boolean")
		throw new OfficialProviderError("INVALID_INPUT", "prompt_extend must be a boolean.");
	if (!isWan && promptExtendValue !== undefined)
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"HappyHorse does not expose the Wan prompt_extend option.",
		);
	const media = refs.map((reference) => ({ type: mediaTypeFor(reference, kind), url: imageValue(reference) }));
	const fullPrompt = withExplicitStyleAndCamera(
		prompt,
		params,
		kind.endsWith("r2v")
			? refs.filter((reference) => normalizedRole(reference.role) === "reference_image").length
			: 0,
	);
	const request: Alibaba27VideoRequest = {
		model: input.modelId,
		input: {
			prompt: fullPrompt,
			...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
			...(media.length ? { media } : {}),
		},
		parameters: {
			resolution: rawResolution,
			duration,
			...(imageRatio ? { ratio: imageRatio } : {}),
			...(isWan ? { prompt_extend: (promptExtendValue as boolean | undefined) ?? true } : {}),
			watermark,
			...(seed === undefined ? {} : { seed }),
		},
	};
	return request;
}

export async function generateAlibaba27Video(input: OfficialGenerationInput, options: OfficialGenerationOptions) {
	const request = buildAlibaba27VideoRequest(input);
	const apiKey = requireApiKey(options, ALIBABA_VIDEO_PROVIDER_ID);
	const baseUrl = resolveAlibabaWorkspaceBaseUrl(options);
	const protocol: OfficialVideoTaskProtocol<AlibabaVideoTask, AlibabaVideoTask> = {
		providerName: input.modelId.startsWith("happyhorse-") ? "HappyHorse 1.1" : "Wan 2.7",
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
	};
	return runOfficialVideoTask(input, options, apiKey, protocol);
}

function resolveModelKind(input: OfficialGenerationInput): AlibabaVideoKind {
	if (input.providerId !== ALIBABA_VIDEO_PROVIDER_ID || input.modality !== "video")
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured Alibaba video model is unavailable.");
	if ((WAN_27_T2V_MODEL_IDS as readonly string[]).includes(input.modelId)) return "wan-t2v";
	if ((WAN_27_I2V_MODEL_IDS as readonly string[]).includes(input.modelId)) return "wan-i2v";
	if (input.modelId === WAN_27_R2V_MODEL_ID) return "wan-r2v";
	if (input.modelId === HAPPYHORSE_11_T2V_MODEL_ID) return "happyhorse-t2v";
	if (input.modelId === HAPPYHORSE_11_I2V_MODEL_ID) return "happyhorse-i2v";
	if (input.modelId === HAPPYHORSE_11_R2V_MODEL_ID) return "happyhorse-r2v";
	throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured Alibaba video model is unavailable.");
}

function collectImages(
	input: OfficialGenerationInput,
	params: Record<string, unknown>,
	isI2v: boolean,
): OfficialMediaReference[] {
	const result: OfficialMediaReference[] = [];
	for (const reference of input.references ?? []) {
		if (!reference || reference.type !== "image")
			throw new OfficialProviderError(
				"UNSUPPORTED_INPUT_MODE",
				"This Alibaba video adapter accepts image references only.",
			);
		appendImage(result, normalizeImageReference(reference));
	}
	const add = (value: unknown, role: string) => {
		const values = Array.isArray(value)
			? value
			: value === undefined || value === null || value === ""
				? []
				: [value];
		for (const item of values) {
			if (typeof item !== "string")
				throw new OfficialProviderError(
					"INVALID_MEDIA_REFERENCE",
					"Alibaba image parameters must be URL or base64 strings.",
				);
			const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/iu.exec(item.trim());
			appendImage(
				result,
				normalizeImageReference(
					match
						? { type: "image", base64: match[2], mimeType: match[1].toLowerCase(), role }
						: { type: "image", url: item.trim(), role },
				),
			);
		}
	};
	add(params.firstFrameUrl ?? params.first_frame, "first_frame");
	add(params.lastFrameUrl ?? params.last_frame, "last_frame");
	add(
		params.referenceImages ?? params.reference_images ?? params.imageUrl ?? params.image_url ?? params.image,
		"reference_image",
	);
	if (isI2v) {
		for (const reference of result) {
			if (reference.role === "first_frame" || reference.role === "last_frame") continue;
			if (!result.some((candidate) => candidate.role === "first_frame")) reference.role = "first_frame";
			else if (!result.some((candidate) => candidate.role === "last_frame")) reference.role = "last_frame";
			else
				throw new OfficialProviderError(
					"REFERENCE_LIMIT",
					"Image-to-video accepts only one first frame and one last frame.",
				);
		}
	}
	return result;
}

function normalizeImageReference(reference: OfficialMediaReference): OfficialMediaReference {
	if (reference.base64) return reference;
	if (typeof reference.url !== "string") return reference;
	const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/iu.exec(reference.url.trim());
	return match ? { ...reference, url: undefined, base64: match[2], mimeType: match[1].toLowerCase() } : reference;
}

function appendImage(result: OfficialMediaReference[], reference: OfficialMediaReference): void {
	const key = imageIdentity(reference);
	const existingIndex = result.findIndex((candidate) => imageIdentity(candidate) === key);
	if (existingIndex < 0) {
		result.push(reference);
		return;
	}
	const current = result[existingIndex];
	const currentRole = normalizedRole(current.role);
	const nextRole = normalizedRole(reference.role);
	if (
		(currentRole === "first_frame" && nextRole === "last_frame") ||
		(currentRole === "last_frame" && nextRole === "first_frame")
	) {
		throw new OfficialProviderError(
			"INVALID_MEDIA_REFERENCE",
			"First and last frames must come from different images.",
		);
	}
	if (currentRole === "reference_image" && nextRole !== "reference_image") result[existingIndex] = reference;
}

function imageIdentity(reference: OfficialMediaReference): string {
	if (reference.base64)
		return `data:${(reference.mimeType ?? "image/png").toLowerCase()}:${reference.base64.replace(/\s/gu, "")}`;
	if (typeof reference.url !== "string")
		throw new OfficialProviderError(
			"INVALID_MEDIA_REFERENCE",
			"An Alibaba image reference is missing its media data.",
		);
	const value = reference.url.trim();
	const dataUri = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/iu.exec(value);
	if (dataUri) return `data:${dataUri[1].toLowerCase()}:${dataUri[2]}`;
	try {
		return `url:${new URL(value).toString()}`;
	} catch {
		return `url:${value}`;
	}
}

function normalizedRole(role: string | undefined): string {
	if (role === "first_frame" || role === "last_frame") return role;
	return role === "reference_image" || role === "reference" || role === "subject"
		? "reference_image"
		: "reference_image";
}

function mediaTypeFor(reference: OfficialMediaReference, kind: AlibabaVideoKind): string {
	if (kind.endsWith("t2v"))
		throw new OfficialProviderError("UNSUPPORTED_INPUT_MODE", "Text-to-video cannot carry image references.");
	if (kind.endsWith("r2v"))
		return normalizedRole(reference.role) === "first_frame" ? "first_frame" : "reference_image";
	if (reference.role === "last_frame") return "last_frame";
	return "first_frame";
}

function imageValue(reference: OfficialMediaReference): string {
	if (reference.base64) {
		const mimeType = (reference.mimeType ?? "image/png").toLowerCase();
		if (!["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(mimeType))
			throw new OfficialProviderError(
				"INVALID_MEDIA_REFERENCE",
				"Alibaba video images must be PNG, JPEG, JPG, or WebP.",
			);
		const bytes = Buffer.from(reference.base64.replace(/^data:[^;,]+;base64,/iu, ""), "base64");
		if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES)
			throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", "Alibaba video images must be at most 20 MB.");
		return referenceValue({ base64: reference.base64, mimeType }, "Alibaba video image reference");
	}
	if (!reference.url)
		throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", "Alibaba video image URL is missing.");
	return referenceValue({ url: reference.url }, "Alibaba video image reference");
}

function assertAllowedParams(params: Record<string, unknown>, kind: AlibabaVideoKind): void {
	const supported = new Set([
		"duration",
		"seconds",
		"resolution",
		"size",
		"watermark",
		"seed",
		"negative_prompt",
		"negativePrompt",
		"firstFrameUrl",
		"first_frame",
		"lastFrameUrl",
		"last_frame",
		"referenceImages",
		"reference_images",
		"imageUrl",
		"image_url",
		"image",
		"style",
		"camera",
		"cameraMovement",
		"camera_movement",
		"ratio",
		"aspectRatio",
		"aspect_ratio",
		"imageAspectRatio",
		...(kind.startsWith("wan-") ? ["prompt_extend", "promptExtend"] : []),
	]);
	const unknown = Object.keys(params).find((key) => !supported.has(key));
	if (unknown)
		throw new OfficialProviderError(
			"INVALID_INPUT",
			`${kind.startsWith("happyhorse-") ? "HappyHorse 1.1" : "Wan 2.7"} does not support the ${unknown} parameter.`,
		);
	for (const key of ["audio", "generate_audio", "generateAudio", "audio_url", "audioUrl"]) {
		if (params[key] !== undefined)
			throw new OfficialProviderError(
				"UNSUPPORTED_INPUT_MODE",
				`${kind.startsWith("happyhorse-") ? "HappyHorse 1.1" : "Wan 2.7"} does not expose a controllable generated-audio option in this adapter.`,
			);
	}
}

function readImageRatio(params: Record<string, unknown>, isText: boolean, isHappyHorse: boolean): string | undefined {
	const value = params.ratio ?? params.aspectRatio ?? params.aspect_ratio ?? params.imageAspectRatio;
	if (!isText) {
		if (value === undefined) return undefined;
		if (typeof value !== "string" || value.trim().toLowerCase() !== "adaptive")
			throw new OfficialProviderError(
				"UNSUPPORTED_INPUT_MODE",
				"This image-to-video aspect ratio is derived from the input frame or reference images; only adaptive is supported.",
			);
		return undefined;
	}
	const ratios = isHappyHorse ? HAPPYHORSE_RATIOS : WAN_RATIOS;
	const ratio = value ?? "16:9";
	if (typeof ratio !== "string" || !(ratios as readonly string[]).includes(ratio))
		throw new OfficialProviderError(
			"INVALID_INPUT",
			"The text-to-video aspect ratio is not supported for this model.",
		);
	return ratio;
}

function readBoolean(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") throw new OfficialProviderError("INVALID_INPUT", `${name} must be a boolean.`);
	return value;
}

function readOptionalText(value: unknown, name: string, maximum: number): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || value.length > maximum)
		throw new OfficialProviderError("INVALID_INPUT", `${name} must be a string of at most ${maximum} characters.`);
	return value.trim() || undefined;
}

function withExplicitStyleAndCamera(prompt: string, params: Record<string, unknown>, referenceCount: number): string {
	const values = [prompt];
	for (const [keys, label] of [
		[["style"], "风格"],
		[["camera", "cameraMovement", "camera_movement"], "运镜"],
	] as const) {
		const value = keys.map((key) => params[key]).find((entry) => entry !== undefined);
		if (value !== undefined && (typeof value !== "string" || !value.trim()))
			throw new OfficialProviderError("INVALID_INPUT", `${label} must be a non-empty string.`);
		if (typeof value === "string") values.push(`${label}：${value.trim()}`);
	}
	if (referenceCount)
		values.push(
			`参考图按输入顺序标记为 ${Array.from({ length: referenceCount }, (_, index) => `[Image ${index + 1}]`).join(", ")}。`,
		);
	const result = values.join("\n");
	if (result.length > MAX_PROMPT_CHARS)
		throw new OfficialProviderError(
			"INVALID_INPUT",
			"The prompt plus style and camera directions exceeds 5,000 characters.",
		);
	return result;
}

function resolveAlibabaWorkspaceBaseUrl(options: OfficialGenerationOptions): string {
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
			"Configure a valid Alibaba Model Studio workspace ID and supported region.",
		);
	}
	const derived = `https://${workspaceId}.${region}.maas.aliyuncs.com/api/v1`;
	if (
		options.baseUrl !== undefined &&
		options.baseUrl !== ALIBABA_VIDEO_WORKSPACE_DEFAULT_BASE_URL &&
		options.baseUrl !== derived
	)
		throw new OfficialProviderError(
			"INVALID_BASE_URL",
			"Alibaba video generation must use the configured workspace and region endpoint.",
		);
	const baseUrl = resolveBaseUrl(
		{ ...options, baseUrl: derived },
		ALIBABA_VIDEO_WORKSPACE_DEFAULT_BASE_URL,
		ALIBABA_VIDEO_PROVIDER_ID,
	);
	const url = new URL(baseUrl);
	if (
		url.protocol !== "https:" ||
		url.hostname !== `${workspaceId}.${region}.maas.aliyuncs.com` ||
		url.port ||
		url.pathname.replace(/\/$/u, "") !== "/api/v1"
	) {
		throw new OfficialProviderError(
			"INVALID_BASE_URL",
			"Alibaba video generation must use the official workspace API endpoint.",
		);
	}
	return endpoint(baseUrl, "");
}

function getParams(value: Record<string, unknown> | undefined): Record<string, unknown> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new OfficialProviderError("INVALID_INPUT", "Alibaba video parameters must be an object.");
	return value;
}
