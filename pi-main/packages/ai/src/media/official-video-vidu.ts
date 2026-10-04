import { OfficialProviderError, referenceValue, requireApiKey, resolveBaseUrl, safeBase64 } from "./http.ts";
import { type OfficialVideoTaskProtocol, runOfficialVideoTask } from "./official-video-task.ts";
import type {
	OfficialGenerationInput,
	OfficialGenerationOptions,
	OfficialGenerationResult,
	OfficialMediaReference,
} from "./types.ts";

export const VIDU_VIDEO_PROVIDER_ID = "vidu";
export const VIDU_Q3_PRO_MODEL_ID = "viduq3-pro";
export const VIDU_VIDEO_BASE_URL = "https://api.vidu.com/ent/v2";

const ASPECT_RATIOS = ["16:9", "9:16", "3:4", "4:3", "1:1"] as const;
const RESOLUTIONS = ["540p", "720p", "1080p"] as const;
const MAX_PROMPT_CHARS = 5_000;
const MAX_IMAGE_INLINE_BYTES = 14 * 1024 * 1024;

interface ViduTaskResponse {
	task_id?: string;
	state?: string;
	creations?: Array<{ url?: unknown }>;
	data?: ViduTaskResponse;
	err_code?: string | number;
}

export interface ViduQ3Request {
	model: typeof VIDU_Q3_PRO_MODEL_ID;
	prompt: string;
	duration: number;
	resolution: string;
	audio: boolean;
	seed?: number;
	aspect_ratio?: string;
	off_peak?: boolean;
	images?: string[];
}

interface ViduBuiltRequest {
	path: "text2video" | "img2video" | "start-end2video";
	request: ViduQ3Request;
}

/** Translate text, one-image, and first/last-frame Q3 Pro requests to Vidu's documented APIs. */
export function buildViduQ3Request(input: OfficialGenerationInput): ViduBuiltRequest {
	if (
		input.providerId !== VIDU_VIDEO_PROVIDER_ID ||
		input.modelId !== VIDU_Q3_PRO_MODEL_ID ||
		input.modality !== "video"
	) {
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured Vidu Q3 Pro video model is unavailable.");
	}
	if (input.operation !== undefined && input.operation !== "task") {
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured Vidu Q3 Pro operation is unavailable.");
	}
	const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
	if (!prompt || prompt.length > MAX_PROMPT_CHARS)
		throw new OfficialProviderError("INVALID_INPUT", "Vidu Q3 Pro prompts must contain 1–5,000 characters.");
	const params = input.params ?? {};
	if (input.params !== undefined && (!input.params || Array.isArray(input.params) || typeof input.params !== "object"))
		throw new OfficialProviderError("INVALID_INPUT", "Vidu parameters must be an object.");
	assertAllowedParams(params);
	const refs = collectImages(input.references ?? [], params);
	const firstFrames = refs.filter((reference) => reference.role === "first_frame");
	const lastFrames = refs.filter((reference) => reference.role === "last_frame");
	let path: ViduBuiltRequest["path"] = "text2video";
	let images: string[] | undefined;
	if (firstFrames.length || lastFrames.length) {
		if (firstFrames.length !== 1 || lastFrames.length > 1 || refs.length !== firstFrames.length + lastFrames.length) {
			throw new OfficialProviderError(
				"INVALID_MEDIA_REFERENCE",
				"Vidu Q3 Pro start/end input requires one first frame and optionally one last frame.",
			);
		}
		if (lastFrames.length) {
			path = "start-end2video";
			images = [imageValue(firstFrames[0]), imageValue(lastFrames[0])];
		} else {
			path = "img2video";
			images = [imageValue(firstFrames[0])];
		}
	} else if (refs.length) {
		if (refs.length !== 1)
			throw new OfficialProviderError(
				"UNSUPPORTED_INPUT_MODE",
				"Vidu Q3 Pro accepts one starting image for image-to-video generation.",
			);
		path = "img2video";
		images = [imageValue(refs[0])];
	}
	if (path !== "text2video") {
		const imageRatioValues = [params.aspectRatio, params.aspect_ratio, params.ratio].filter(
			(value) => value !== undefined,
		);
		if (imageRatioValues.some((value) => typeof value !== "string" || value.trim().toLowerCase() !== "adaptive")) {
			throw new OfficialProviderError(
				"UNSUPPORTED_INPUT_MODE",
				"Vidu image-to-video aspect ratio is derived from the input frame; only adaptive is supported.",
			);
		}
	}
	const rawDuration = Number(params.duration ?? params.seconds ?? 5);
	if (!Number.isInteger(rawDuration) || rawDuration < 1 || rawDuration > 16)
		throw new OfficialProviderError("INVALID_INPUT", "Vidu Q3 Pro duration must be between 1 and 16 seconds.");
	const resolution = String(params.resolution ?? params.size ?? "720p")
		.trim()
		.toLowerCase();
	if (!(RESOLUTIONS as readonly string[]).includes(resolution))
		throw new OfficialProviderError("INVALID_INPUT", "Vidu Q3 Pro resolution must be 540p, 720p, or 1080p.");
	const audioValues = [params.audio, params.generate_audio, params.generateAudio].filter(
		(value) => value !== undefined,
	);
	if (audioValues.some((value) => typeof value !== "boolean"))
		throw new OfficialProviderError("INVALID_INPUT", "Vidu Q3 Pro audio must be a boolean.");
	if (new Set(audioValues).size > 1)
		throw new OfficialProviderError("INVALID_INPUT", "Vidu audio aliases contain conflicting values.");
	const request: ViduQ3Request = {
		model: VIDU_Q3_PRO_MODEL_ID,
		prompt: withExplicitStyleAndCamera(prompt, params),
		duration: rawDuration,
		resolution,
		audio: (audioValues[0] as boolean | undefined) ?? true,
		...(path === "text2video" ? { aspect_ratio: readAspectRatio(params) } : {}),
		...(params.seed === undefined ? {} : { seed: readSeed(params.seed) }),
		...(params.off_peak === undefined && params.offPeak === undefined
			? {}
			: { off_peak: readBoolean(params.off_peak ?? params.offPeak, "off_peak") }),
		...(images ? { images } : {}),
	};
	if (params.bgm !== undefined)
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"Vidu Q3 models do not expose the background-music parameter.",
		);
	if (params.voice_id !== undefined || params.voiceId !== undefined)
		throw new OfficialProviderError("UNSUPPORTED_INPUT_MODE", "Vidu Q3 does not use a selectable voice_id.");
	return { path, request };
}

export async function generateViduVideo(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	const built = buildViduQ3Request(input);
	const apiKey = requireApiKey(options, VIDU_VIDEO_PROVIDER_ID);
	const baseUrl = resolveBaseUrl(options, VIDU_VIDEO_BASE_URL, VIDU_VIDEO_PROVIDER_ID);
	const base = new URL(baseUrl);
	if (
		base.protocol !== "https:" ||
		base.hostname !== "api.vidu.com" ||
		base.port ||
		base.pathname.replace(/\/$/u, "") !== "/ent/v2"
	) {
		throw new OfficialProviderError(
			"INVALID_BASE_URL",
			"Vidu video generation requires the official HTTPS API endpoint.",
		);
	}
	const protocol: OfficialVideoTaskProtocol<ViduTaskResponse, ViduTaskResponse> = {
		providerName: "Vidu Q3 Pro",
		baseUrl,
		submitPath: built.path,
		queryPath: (taskId) => `tasks/${encodeURIComponent(taskId)}/creations`,
		request: built.request,
		pollIntervalMs: 3_000,
		submitHeaders: (key) => ({ Authorization: `Token ${key}`, "Content-Type": "application/json" }),
		queryHeaders: (key) => ({ Authorization: `Token ${key}`, "Content-Type": "application/json" }),
		readTaskId: (payload) => payload.task_id ?? payload.data?.task_id,
		readTask: (payload) => {
			const data = payload.data ?? payload;
			if (data.err_code && data.err_code !== "0")
				throw new OfficialProviderError("GENERATION_FAILED", "Vidu rejected the video task.");
			const creation = data.creations?.[0];
			return { status: data.state, videoUrl: creation?.url };
		},
		activeStatuses: ["created", "queueing", "processing"],
		succeededStatuses: ["success"],
		failedStatuses: ["failed", "error", "cancelled", "canceled"],
	};
	return runOfficialVideoTask(input, options, apiKey, protocol);
}

function collectImages(
	references: OfficialMediaReference[],
	params: Record<string, unknown>,
): OfficialMediaReference[] {
	const result: OfficialMediaReference[] = [];
	if (references.some((reference) => reference.type !== "image"))
		throw new OfficialProviderError("UNSUPPORTED_INPUT_MODE", "Vidu Q3 Pro accepts image references only.");
	const addReference = (reference: OfficialMediaReference) => {
		reference = normalizeImageReference(reference);
		const key = imageIdentity(reference);
		const existingIndex = result.findIndex((candidate) => imageIdentity(candidate) === key);
		if (existingIndex < 0) {
			result.push(reference);
			return;
		}
		const existing = result[existingIndex];
		const existingRole = existing.role;
		const nextRole = reference.role;
		if (isFrameRole(existingRole) && isFrameRole(nextRole) && existingRole !== nextRole) {
			throw new OfficialProviderError(
				"INVALID_MEDIA_REFERENCE",
				"Vidu Q3 Pro first and last frames must come from different images.",
			);
		}
		if (!isFrameRole(existingRole) && isFrameRole(nextRole)) result[existingIndex] = reference;
	};
	for (const reference of references) addReference(reference);
	const add = (value: unknown, role: string) => {
		if (value === undefined || value === null || value === "") return;
		if (typeof value !== "string")
			throw new OfficialProviderError(
				"INVALID_MEDIA_REFERENCE",
				"Vidu image references must be URL or base64 strings.",
			);
		const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/iu.exec(value.trim());
		addReference(
			match
				? { type: "image", base64: match[2], mimeType: match[1].toLowerCase(), role }
				: { type: "image", url: value.trim(), role },
		);
	};
	add(params.firstFrameUrl ?? params.first_frame, "first_frame");
	add(params.lastFrameUrl ?? params.last_frame, "last_frame");
	add(params.imageUrl ?? params.image_url ?? params.image, "first_frame");
	if (result.length > 2)
		throw new OfficialProviderError("REFERENCE_LIMIT", "Vidu Q3 Pro accepts at most a start and end image.");
	return result;
}

function isFrameRole(role: string | undefined): role is "first_frame" | "last_frame" {
	return role === "first_frame" || role === "last_frame";
}

function imageIdentity(reference: OfficialMediaReference): string {
	if (reference.base64)
		return `data:${(reference.mimeType ?? "image/png").toLowerCase()}:${reference.base64.replace(/\s/gu, "")}`;
	if (typeof reference.url !== "string")
		throw new OfficialProviderError(
			"INVALID_MEDIA_REFERENCE",
			"Vidu image references must contain a URL or base64 data.",
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

function normalizeImageReference(reference: OfficialMediaReference): OfficialMediaReference {
	if (reference.base64 || typeof reference.url !== "string") return reference;
	const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/iu.exec(reference.url.trim());
	return match ? { ...reference, url: undefined, base64: match[2], mimeType: match[1].toLowerCase() } : reference;
}

function imageValue(reference: OfficialMediaReference): string {
	if (reference.base64) {
		const mimeType = reference.mimeType?.toLowerCase() ?? "image/png";
		if (!/^image\/(png|jpeg|jpg|webp)$/u.test(mimeType))
			throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", "Vidu images must be PNG, JPEG, JPG, or WebP.");
		const bytes = safeBase64(reference.base64, "Vidu image reference");
		if (bytes.byteLength > MAX_IMAGE_INLINE_BYTES)
			throw new OfficialProviderError(
				"INVALID_MEDIA_REFERENCE",
				"Vidu inline image exceeds the 20 MB request-body limit.",
			);
		return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
	}
	if (!reference.url)
		throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", "Vidu image reference is missing its data.");
	return referenceValue(reference, "Vidu image reference");
}

function readAspectRatio(params: Record<string, unknown>): string {
	const value = String(params.aspectRatio ?? params.aspect_ratio ?? params.ratio ?? "16:9").trim();
	if (!(ASPECT_RATIOS as readonly string[]).includes(value))
		throw new OfficialProviderError("INVALID_INPUT", "Vidu Q3 Pro text-to-video aspect ratio is invalid.");
	return value;
}

function readSeed(value: unknown): number {
	const seed = Number(value);
	if (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647)
		throw new OfficialProviderError("INVALID_INPUT", "Vidu seed must be a non-negative 32-bit integer.");
	return seed;
}

function readBoolean(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") throw new OfficialProviderError("INVALID_INPUT", `Vidu ${name} must be a boolean.`);
	return value;
}

function withExplicitStyleAndCamera(prompt: string, params: Record<string, unknown>): string {
	const values = [prompt];
	const style = params.style;
	if (typeof style === "string" && style.trim()) values.push(`风格：${style.trim()}`);
	const camera = params.camera ?? params.cameraMovement ?? params.camera_movement;
	if (typeof camera === "string" && camera.trim()) values.push(`运镜：${camera.trim()}`);
	return values.join("\n");
}

function assertAllowedParams(params: Record<string, unknown>): void {
	const supported = new Set([
		"duration",
		"seconds",
		"resolution",
		"size",
		"audio",
		"generate_audio",
		"generateAudio",
		"aspectRatio",
		"aspect_ratio",
		"ratio",
		"seed",
		"off_peak",
		"offPeak",
		"bgm",
		"voice_id",
		"voiceId",
		"firstFrameUrl",
		"first_frame",
		"lastFrameUrl",
		"last_frame",
		"imageUrl",
		"image_url",
		"image",
		"style",
		"camera",
		"cameraMovement",
		"camera_movement",
	]);
	const unknown = Object.keys(params).find((key) => !supported.has(key));
	if (unknown)
		throw new OfficialProviderError("INVALID_INPUT", `Vidu Q3 Pro does not support the ${unknown} parameter.`);
}
