import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
	jsonHeaders,
	OfficialProviderError,
	referenceValue,
	requireApiKey,
	resolveBaseUrl,
	safeBase64,
} from "./http.ts";
import {
	type OfficialVideoRuntimeOptions,
	type OfficialVideoTaskProtocol,
	runOfficialVideoTask,
} from "./official-video-task.ts";
import type {
	OfficialGenerationInput,
	OfficialGenerationOptions,
	OfficialGenerationResult,
	OfficialMediaReference,
} from "./types.ts";

export const SEEDANCE_20_ARK_MODEL_ID = "doubao-seedance-2-0-260128";
export const SEEDANCE_20_FAST_ARK_MODEL_ID = "doubao-seedance-2-0-fast-260128";
export const SEEDANCE_20_MINI_ARK_MODEL_ID = "doubao-seedance-2-0-mini-260615";
export const SEEDANCE_20_BYTEPLUS_MODEL_ID = "dreamina-seedance-2-0-260128";
export const SEEDANCE_20_FAST_BYTEPLUS_MODEL_ID = "dreamina-seedance-2-0-fast-260128";
export const SEEDANCE_20_MINI_BYTEPLUS_MODEL_ID = "dreamina-seedance-2-0-mini-260615";

export const SEEDANCE_20_MODELS: Readonly<
	Record<string, Readonly<{ providerId: string; maxResolution: "720p" | "1080p" | "4k" }>>
> = {
	[SEEDANCE_20_ARK_MODEL_ID]: { providerId: "volcengine-ark", maxResolution: "4k" },
	[SEEDANCE_20_FAST_ARK_MODEL_ID]: { providerId: "volcengine-ark", maxResolution: "720p" },
	[SEEDANCE_20_MINI_ARK_MODEL_ID]: { providerId: "volcengine-ark", maxResolution: "720p" },
	[SEEDANCE_20_BYTEPLUS_MODEL_ID]: { providerId: "byteplus", maxResolution: "4k" },
	[SEEDANCE_20_FAST_BYTEPLUS_MODEL_ID]: { providerId: "byteplus", maxResolution: "720p" },
	[SEEDANCE_20_MINI_BYTEPLUS_MODEL_ID]: { providerId: "byteplus", maxResolution: "720p" },
};

export const ARK_SEEDANCE_20_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const BYTEPLUS_SEEDANCE_20_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3";

const MAX_PROMPT_CHARS = 200_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_INLINE_REFERENCE_BYTES = 48 * 1024 * 1024;
const ASPECT_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "adaptive"] as const;
const RESOLUTIONS = ["480p", "720p", "1080p", "4k"] as const;

interface SeedanceTaskResponse {
	id?: string | number;
	task_id?: string | number;
	status?: string;
	data?: SeedanceTaskResponse;
	content?: { video_url?: { url?: unknown } | string };
	video_url?: unknown;
	url?: unknown;
	output?: { video_url?: unknown; url?: unknown };
	error?: unknown;
}

export interface Seedance20Request {
	model: string;
	content: Array<Record<string, unknown>>;
	generate_audio: boolean;
	resolution: string;
	ratio: string;
	duration: number;
	watermark: boolean;
	seed?: number;
	camera_fixed?: boolean;
}

type SeedanceRuntimeOptions = OfficialVideoRuntimeOptions & {
	resolveReferenceHost?: (hostname: string) => Promise<Array<string | { address: string }>>;
};

/** Build the Ark/BytePlus Seedance 2.0 request using the documented content-generation schema. */
export function buildSeedance20Request(input: OfficialGenerationInput): Seedance20Request {
	const model = SEEDANCE_20_MODELS[input.modelId];
	if (input.modality !== "video" || !model || input.providerId !== model.providerId) {
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured Seedance 2.0 video model is unavailable.");
	}
	if (input.operation !== undefined && input.operation !== "task") {
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured Seedance 2.0 operation is unavailable.");
	}
	const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
	if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
		throw new OfficialProviderError("INVALID_INPUT", "The Seedance 2.0 prompt is empty or too long.");
	}
	const params = input.params ?? {};
	if (
		input.params !== undefined &&
		(!input.params || Array.isArray(input.params) || typeof input.params !== "object")
	) {
		throw new OfficialProviderError("INVALID_INPUT", "Seedance 2.0 parameters must be an object.");
	}
	assertAllowedParams(params);
	const references = collectReferences(input, params);
	const images = references.filter((reference) => reference.type === "image");
	const videos = references.filter((reference) => reference.type === "video");
	const audios = references.filter((reference) => reference.type === "audio");
	if (images.length > 9 || videos.length > 3 || audios.length > 3) {
		throw new OfficialProviderError(
			"REFERENCE_LIMIT",
			"Seedance 2.0 accepts at most 9 images, 3 videos, and 3 audio references.",
		);
	}
	if (audios.length && !images.length && !videos.length) {
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"Seedance 2.0 audio references must be accompanied by an image or video reference.",
		);
	}
	const keyframeImages = images.filter(
		(reference) => reference.role === "first_frame" || reference.role === "last_frame",
	);
	if (keyframeImages.length && (images.length > 2 || videos.length > 0 || audios.length > 0)) {
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"Seedance 2.0 keyframe input cannot be combined with multimodal reference input.",
		);
	}
	if (
		keyframeImages.length > 0 &&
		(keyframeImages.length > 2 ||
			keyframeImages.filter((reference) => reference.role === "first_frame").length !== 1 ||
			(keyframeImages.length === 2 &&
				keyframeImages.filter((reference) => reference.role === "last_frame").length !== 1))
	) {
		throw new OfficialProviderError(
			"INVALID_MEDIA_REFERENCE",
			"Seedance 2.0 keyframes require one first frame and optionally one last frame.",
		);
	}
	const referenceBytes: number[] = [];
	const content: Array<Record<string, unknown>> = [{ type: "text", text: withExplicitStyleAndCamera(prompt, params) }];
	for (const reference of images) {
		const url = normalizeReference(reference, "image", referenceBytes);
		content.push({ type: "image_url", image_url: { url }, ...(reference.role ? { role: reference.role } : {}) });
	}
	for (const reference of videos) {
		const url = normalizeReference(reference, "video", referenceBytes);
		content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
	}
	for (const reference of audios) {
		const url = normalizeReference(reference, "audio", referenceBytes);
		content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });
	}
	if (referenceBytes.reduce((sum, value) => sum + value, 0) > MAX_INLINE_REFERENCE_BYTES) {
		throw new OfficialProviderError(
			"INVALID_MEDIA_REFERENCE",
			"Inline Seedance 2.0 references exceed the safe request size.",
		);
	}
	const resolution = String(params.resolution ?? params.size ?? "720p")
		.trim()
		.toLowerCase();
	if (
		!(RESOLUTIONS as readonly string[]).includes(resolution) ||
		resolutionRank(resolution) > resolutionRank(model.maxResolution)
	) {
		throw new OfficialProviderError(
			"INVALID_INPUT",
			`This Seedance 2.0 model supports resolutions up to ${model.maxResolution}.`,
		);
	}
	const ratioValues = [params.ratio, params.aspectRatio, params.aspect].filter((value) => value !== undefined);
	if (
		ratioValues.some((value) => typeof value !== "string") ||
		new Set(ratioValues.map((value) => String(value).trim())).size > 1
	) {
		throw new OfficialProviderError(
			"INVALID_INPUT",
			"Seedance 2.0 aspect ratio aliases must be strings with one matching value.",
		);
	}
	const ratio = String(ratioValues[0] ?? "adaptive").trim();
	if (!(ASPECT_RATIOS as readonly string[]).includes(ratio)) {
		throw new OfficialProviderError(
			"INVALID_INPUT",
			"Seedance 2.0 aspect ratio must be one of the documented values.",
		);
	}
	if (keyframeImages.length && ratioValues.some((value) => value !== "adaptive")) {
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"Seedance 2.0 first/last-frame aspect ratio is derived from the input frames; only adaptive is supported.",
		);
	}
	const durationValue = Number(params.duration ?? params.seconds ?? 5);
	if (!Number.isInteger(durationValue) || (durationValue !== -1 && (durationValue < 4 || durationValue > 15))) {
		throw new OfficialProviderError(
			"INVALID_INPUT",
			"Seedance 2.0 duration must be 4–15 seconds or -1 for automatic duration.",
		);
	}
	const seed = params.seed === undefined ? undefined : Number(params.seed);
	if (seed !== undefined && (!Number.isInteger(seed) || seed < -1 || seed > 4_294_967_295)) {
		throw new OfficialProviderError(
			"INVALID_INPUT",
			"Seedance 2.0 seed must be -1 or a non-negative 32-bit integer.",
		);
	}
	const cameraFixed = params.camera_fixed ?? params.cameraFixed;
	if (cameraFixed !== undefined && typeof cameraFixed !== "boolean") {
		throw new OfficialProviderError("INVALID_INPUT", "Seedance 2.0 camera_fixed must be a boolean.");
	}
	if (
		(params.generate_audio !== undefined && typeof params.generate_audio !== "boolean") ||
		(params.generateAudio !== undefined && typeof params.generateAudio !== "boolean")
	) {
		throw new OfficialProviderError("INVALID_INPUT", "Seedance 2.0 generate_audio must be a boolean.");
	}
	if (params.watermark !== undefined && typeof params.watermark !== "boolean") {
		throw new OfficialProviderError("INVALID_INPUT", "Seedance 2.0 watermark must be a boolean.");
	}
	return {
		model: input.modelId,
		content,
		generate_audio: params.generate_audio !== false && params.generateAudio !== false,
		resolution,
		ratio,
		duration: durationValue,
		watermark: params.watermark === true,
		...(seed === undefined ? {} : { seed }),
		...(cameraFixed === undefined ? {} : { camera_fixed: cameraFixed as boolean }),
	};
}

export async function generateSeedance20Video(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	const request = buildSeedance20Request(input);
	const providerId = input.providerId;
	const apiKey = requireApiKey(options, providerId);
	const defaultBaseUrl = providerId === "byteplus" ? BYTEPLUS_SEEDANCE_20_BASE_URL : ARK_SEEDANCE_20_BASE_URL;
	const baseUrl = resolveBaseUrl(options, defaultBaseUrl, providerId);
	const base = new URL(baseUrl);
	const expectedHosts =
		providerId === "byteplus"
			? ["ark.ap-southeast.bytepluses.com", "ark.us-east-1.bytepluses.com"]
			: ["ark.cn-beijing.volces.com", "ark.cn-shanghai.volces.com", "ark.us-east-1.volces.com"];
	if (
		base.protocol !== "https:" ||
		!expectedHosts.includes(base.hostname) ||
		base.pathname.replace(/\/$/u, "") !== "/api/v3" ||
		base.port
	) {
		throw new OfficialProviderError("INVALID_BASE_URL", "Seedance 2.0 requires the official HTTPS /api/v3 endpoint.");
	}
	const runtime = options as SeedanceRuntimeOptions;
	await validateReferenceHosts(urlsIn(request), runtime);
	const protocol: OfficialVideoTaskProtocol<SeedanceTaskResponse, SeedanceTaskResponse> = {
		providerName: providerId === "byteplus" ? "BytePlus Seedance 2.0" : "Ark Seedance 2.0",
		baseUrl,
		submitPath: "contents/generations/tasks",
		queryPath: (taskId) => `contents/generations/tasks/${encodeURIComponent(taskId)}`,
		request,
		pollIntervalMs: 3_000,
		submitHeaders: (key) => jsonHeaders(key),
		queryHeaders: (key) => jsonHeaders(key),
		readTaskId: (payload) => payload.id ?? payload.task_id ?? payload.data?.id ?? payload.data?.task_id,
		readTask: (payload) => {
			const data = payload.data ?? payload;
			if (data.error)
				throw new OfficialProviderError("GENERATION_FAILED", `${providerId} Seedance 2.0 generation failed.`);
			return { status: data.status, videoUrl: extractVideoUrl(payload) };
		},
		activeStatuses: ["created", "queued", "queueing", "pending", "submitted", "running", "processing"],
		succeededStatuses: ["succeeded", "success", "completed", "done"],
		failedStatuses: ["failed", "error", "cancelled", "canceled"],
	};
	return runOfficialVideoTask(input, options, apiKey, protocol);
}

function collectReferences(input: OfficialGenerationInput, params: Record<string, unknown>): OfficialMediaReference[] {
	const references: OfficialMediaReference[] = [];
	if (input.references) references.push(...input.references);
	const add = (value: unknown, type: OfficialMediaReference["type"], role: string) => {
		for (const item of Array.isArray(value) ? value : value ? [value] : []) {
			if (typeof item !== "string")
				throw new OfficialProviderError(
					"INVALID_MEDIA_REFERENCE",
					"Seedance 2.0 reference values must be strings.",
				);
			const data = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/iu.exec(item.trim());
			references.push(
				data ? { type, base64: data[2], mimeType: data[1].toLowerCase(), role } : { type, url: item.trim(), role },
			);
		}
	};
	add(params.firstFrameUrl ?? params.first_frame, "image", "first_frame");
	add(params.lastFrameUrl ?? params.last_frame, "image", "last_frame");
	add(
		params.referenceImages ?? params.reference_images ?? params.referenceUrls ?? params.imageUrl ?? params.image_url,
		"image",
		"reference_image",
	);
	add(params.referenceVideos ?? params.reference_videos, "video", "reference_video");
	add(params.referenceAudios ?? params.reference_audios, "audio", "reference_audio");
	if (references.length > 15)
		throw new OfficialProviderError("REFERENCE_LIMIT", "Seedance 2.0 received too many media references.");
	return references;
}

function normalizeReference(
	reference: OfficialMediaReference,
	kind: "image" | "video" | "audio",
	inlineBytes: number[],
): string {
	if (reference.type !== kind)
		throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", "Seedance 2.0 media reference type is inconsistent.");
	if (reference.base64) {
		if (kind === "video")
			throw new OfficialProviderError(
				"UNSUPPORTED_INPUT_MODE",
				"Seedance 2.0 video references require a public HTTPS URL.",
			);
		const mimeType = (reference.mimeType ?? (kind === "image" ? "image/png" : "audio/wav")).toLowerCase();
		const allowed =
			kind === "image" ? /^image\/(png|jpeg|webp|bmp|tiff|gif|heic|heif)$/u : /^audio\/(wav|mpeg|mp3)$/u;
		if (!allowed.test(mimeType))
			throw new OfficialProviderError(
				"INVALID_MEDIA_REFERENCE",
				`Seedance 2.0 ${kind} reference MIME type is unsupported.`,
			);
		const bytes = safeBase64(reference.base64, `Seedance 2.0 ${kind} reference`);
		const maxBytes = kind === "image" ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES;
		if (bytes.byteLength > maxBytes)
			throw new OfficialProviderError(
				"INVALID_MEDIA_REFERENCE",
				`Seedance 2.0 ${kind} reference exceeds its size limit.`,
			);
		inlineBytes.push(bytes.byteLength);
		return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
	}
	if (!reference.url)
		throw new OfficialProviderError(
			"INVALID_MEDIA_REFERENCE",
			`Seedance 2.0 ${kind} reference is missing its URL or base64 data.`,
		);
	if (reference.url.startsWith("asset://")) {
		if (!/^asset:\/\/[A-Za-z0-9._:-]{1,180}$/u.test(reference.url))
			throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", "Seedance 2.0 asset reference ID is invalid.");
		return reference.url;
	}
	return referenceValue(reference, `Seedance 2.0 ${kind} reference`);
}

function withExplicitStyleAndCamera(prompt: string, params: Record<string, unknown>): string {
	const values = [prompt];
	for (const [keys, label] of [
		[["style"], "风格"],
		[["camera", "cameraMovement", "camera_movement"], "运镜"],
	] as const) {
		const value = keys.map((key) => params[key]).find((entry) => typeof entry === "string" && entry.trim());
		if (typeof value === "string") values.push(`${label}：${value.trim()}`);
	}
	return values.join("\n");
}

function extractVideoUrl(payload: SeedanceTaskResponse): unknown {
	const data = payload.data ?? payload;
	const contentVideoUrl = data.content?.video_url;
	return (
		(typeof contentVideoUrl === "object" && contentVideoUrl !== null ? contentVideoUrl.url : contentVideoUrl) ??
		data.video_url ??
		data.output?.video_url ??
		data.output?.url ??
		data.url
	);
}

function urlsIn(request: Seedance20Request): string[] {
	const urls: string[] = [];
	for (const item of request.content) {
		for (const key of ["image_url", "video_url", "audio_url"]) {
			const value = item[key];
			if (value && typeof value === "object") {
				const url = (value as { url?: unknown }).url;
				if (typeof url === "string" && url.startsWith("https://")) urls.push(url);
			}
		}
	}
	return urls;
}

async function validateReferenceHosts(urls: string[], runtime: SeedanceRuntimeOptions): Promise<void> {
	const resolver =
		runtime.resolveReferenceHost ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
	for (const hostname of new Set(urls.map((value) => new URL(value).hostname.toLowerCase()))) {
		let addresses: Array<string | { address: string }>;
		try {
			addresses = await resolver(hostname);
		} catch {
			throw new OfficialProviderError(
				"INVALID_MEDIA_REFERENCE",
				"A Seedance 2.0 reference host could not be verified as public.",
			);
		}
		if (
			!addresses.length ||
			addresses.some((entry) => !isPublicAddress(typeof entry === "string" ? entry : entry.address))
		) {
			throw new OfficialProviderError(
				"INVALID_MEDIA_REFERENCE",
				"A Seedance 2.0 reference resolves to a non-public address.",
			);
		}
	}
}

function resolutionRank(value: string): number {
	return ({ "480p": 1, "720p": 2, "1080p": 3, "4k": 4 } as Record<string, number>)[value] ?? 0;
}

function assertAllowedParams(params: Record<string, unknown>): void {
	const supported = new Set([
		"duration",
		"seconds",
		"resolution",
		"size",
		"ratio",
		"aspectRatio",
		"aspect",
		"generate_audio",
		"generateAudio",
		"watermark",
		"seed",
		"camera_fixed",
		"cameraFixed",
		"camera",
		"cameraMovement",
		"camera_movement",
		"style",
		"firstFrameUrl",
		"first_frame",
		"lastFrameUrl",
		"last_frame",
		"referenceImages",
		"reference_images",
		"referenceUrls",
		"imageUrl",
		"image_url",
		"referenceVideos",
		"reference_videos",
		"referenceAudios",
		"reference_audios",
	]);
	const unknown = Object.keys(params).find((key) => !supported.has(key));
	if (unknown)
		throw new OfficialProviderError("INVALID_INPUT", `Seedance 2.0 does not support the ${unknown} parameter.`);
}

function isPublicAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) {
		const [a, b, c] = address.split(".").map(Number);
		const isPrivate =
			a === 0 ||
			a === 10 ||
			a === 127 ||
			a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
			(a === 198 && (b === 18 || b === 19 || b === 51)) ||
			(a === 203 && b === 0 && c === 113);
		return !isPrivate;
	}
	if (family === 6) {
		const normalized = address.toLowerCase().split("%", 1)[0];
		const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
		return (
			first >= 0x2000 &&
			first <= 0x3fff &&
			!normalized.startsWith("2001:db8:") &&
			!normalized.startsWith("2001:0000:") &&
			!normalized.startsWith("2001:0:")
		);
	}
	return false;
}
