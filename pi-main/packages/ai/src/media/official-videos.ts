import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
	endpoint,
	jsonHeaders,
	OfficialProviderError,
	officialJson,
	redactSecret,
	requireApiKey,
	resolveBaseUrl,
	safeBase64,
} from "./http.ts";
import { ALIBABA_27_VIDEO_MODEL_IDS, generateAlibaba27Video } from "./official-video-alibaba-27.ts";
import { generateKlingVideo } from "./official-video-kling.ts";
import { generateMiniMaxVideo } from "./official-video-minimax.ts";
import { generateHailuo23FastVideo, MINIMAX_HAILUO_23_FAST_MODEL_ID } from "./official-video-minimax-hailuo-fast.ts";
import { generatePixVerseV6Video, PIXVERSE_V6_API_MODEL_ID } from "./official-video-pixverse.ts";
import { generateSeedance20Video, SEEDANCE_20_MODELS } from "./official-video-seedance-20.ts";
import { GOOGLE_VEO_31_LITE_MODEL_ID, GOOGLE_VEO_31_MODEL_ID, generateGoogleVeoVideo } from "./official-video-veo.ts";
import { generateViduVideo, VIDU_Q3_PRO_MODEL_ID } from "./official-video-vidu.ts";
import { generateWanVideo } from "./official-video-wan.ts";
import { generateXaiVideo } from "./official-video-xai.ts";
import type {
	OfficialGenerationInput,
	OfficialGenerationOptions,
	OfficialGenerationResult,
	OfficialMediaReference,
} from "./types.ts";

export const ARK_VIDEO_PROVIDER_ID = "volcengine-ark";
export const ARK_SEEDANCE_25_MODEL_ID = "doubao-seedance-2-5-260628";
export const ARK_VIDEO_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

const MAX_PROMPT_CHARS = 200_000;
const MAX_REFERENCE_URL_CHARS = 4_096;
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REFERENCE_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAX_REFERENCE_COUNT = 50;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_CONSECUTIVE_QUERY_FAILURES = 5;

interface ArkVideoRequest {
	model: string;
	content: Array<Record<string, unknown>>;
	generate_audio: boolean;
	resolution: "480p" | "720p" | "1080p";
	ratio: string;
	duration: number;
	watermark: boolean;
}

interface ArkVideoTaskResponse {
	id?: string | number;
	task_id?: string | number;
	status?: string;
	data?: ArkVideoTaskResponse;
	content?: unknown;
	video_url?: unknown;
	url?: unknown;
	output_url?: unknown;
	output?: Record<string, unknown>;
	error?: unknown;
	message?: unknown;
}

type ResolvableAddress = string | { address: string };
type ArkVideoOptions = OfficialGenerationOptions & {
	/** Test seams for polling and DNS checks; production callers should omit these. */
	pollIntervalMs?: number;
	taskTimeoutMs?: number;
	now?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
	resolveReferenceHost?: (hostname: string) => Promise<ResolvableAddress[]>;
};

/**
 * Submit or resume the existing Ark Seedance 2.5 task protocol. Results remain
 * provider URLs; the desktop worker owns safe downloading and local persistence.
 */
export async function generateOfficialVideo(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	if (
		input.providerId === "google" &&
		[GOOGLE_VEO_31_MODEL_ID, GOOGLE_VEO_31_LITE_MODEL_ID].includes(
			input.modelId as typeof GOOGLE_VEO_31_MODEL_ID | typeof GOOGLE_VEO_31_LITE_MODEL_ID,
		)
	) {
		return generateGoogleVeoVideo(input, options);
	}
	if (
		(input.providerId === "volcengine-ark" || input.providerId === "byteplus") &&
		SEEDANCE_20_MODELS[input.modelId]
	) {
		return generateSeedance20Video(input, options);
	}
	if (input.providerId === "vidu" && input.modelId === VIDU_Q3_PRO_MODEL_ID) return generateViduVideo(input, options);
	if (input.providerId === "pixverse" && input.modelId === PIXVERSE_V6_API_MODEL_ID)
		return generatePixVerseV6Video(input, options);
	if (input.providerId === "kling") return generateKlingVideo(input, options);
	if (input.providerId === "xai") return generateXaiVideo(input, options);
	if (
		input.providerId === "alibaba-video" &&
		(ALIBABA_27_VIDEO_MODEL_IDS as readonly string[]).includes(input.modelId)
	)
		return generateAlibaba27Video(input, options);
	if (input.providerId === "alibaba-video") return generateWanVideo(input, options);
	if (input.providerId === "minimax" && input.modelId === MINIMAX_HAILUO_23_FAST_MODEL_ID)
		return generateHailuo23FastVideo(input, options);
	if (input.providerId === "minimax") return generateMiniMaxVideo(input, options);
	const runtime = options as ArkVideoOptions;
	assertArkVideoInput(input);
	if (!input.remoteTaskId && typeof options.onSubmitted !== "function") {
		throw new OfficialProviderError(
			"TASK_CHECKPOINT_REQUIRED",
			"Ark video submission requires a durable task checkpoint before polling.",
		);
	}
	const apiKey = requireApiKey(options, input.providerId);
	const baseUrl = resolveArkBaseUrl(options);
	const request = buildArkVideoRequest(input);
	const referenceUrls = urlsIn(request);
	await assertPublicReferenceHosts(referenceUrls, runtime);

	let remoteTaskId = input.remoteTaskId;
	if (remoteTaskId !== undefined) remoteTaskId = normalizeTaskId(remoteTaskId);
	if (!remoteTaskId) {
		if (options.signal?.aborted)
			throw new OfficialProviderError("REQUEST_ABORTED", "The provider request was cancelled.");
		if (typeof options.onSubmitting !== "function") {
			throw new OfficialProviderError(
				"TASK_CHECKPOINT_REQUIRED",
				"Ark video submission requires a durable checkpoint before POST.",
			);
		}
		await options.onSubmitting();
		let created: ArkVideoTaskResponse;
		try {
			created = await officialJson<ArkVideoTaskResponse>(
				endpoint(baseUrl, "contents/generations/tasks"),
				{ method: "POST", headers: jsonHeaders(apiKey), body: JSON.stringify(request) },
				options,
				apiKey,
			);
		} catch (error) {
			throw sanitizeTaskError(error, apiKey, referenceUrls);
		}
		remoteTaskId = normalizeTaskId(created?.id ?? created?.task_id ?? created?.data?.id ?? created?.data?.task_id);
		await options.onSubmitted!(remoteTaskId);
	}

	const now = runtime.now ?? Date.now;
	const sleep = runtime.sleep ?? defaultSleep;
	const deadline = now() + (runtime.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS);
	let lastStatus = "";
	while (now() < deadline) {
		const pollDelay = Math.min(runtime.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, Math.max(0, deadline - now()));
		if (pollDelay > 0) await sleep(pollDelay);
		if (options.signal?.aborted)
			throw new OfficialProviderError("REQUEST_ABORTED", "The provider request was cancelled.");
		let payload: ArkVideoTaskResponse;
		try {
			payload = await queryWithTransientRetry(remoteTaskId, baseUrl, apiKey, options, runtime, deadline);
		} catch (error) {
			throw sanitizeTaskError(error, apiKey, referenceUrls);
		}
		const data = objectValue(payload.data) ?? payload;
		lastStatus = String(data.status ?? payload.status ?? "").toLowerCase();
		if (["failed", "error", "cancelled", "canceled"].includes(lastStatus)) {
			const detail = readProviderDetail(data);
			throw new OfficialProviderError(
				"GENERATION_FAILED",
				detail
					? `Ark video generation failed: ${sanitizeMessage(detail, apiKey, referenceUrls)}`
					: "Ark video generation failed.",
			);
		}
		if (["succeeded", "success", "completed", "done"].includes(lastStatus)) {
			const videoUrl = extractVideoUrl(payload);
			if (!videoUrl)
				throw new OfficialProviderError(
					"EMPTY_PROVIDER_RESPONSE",
					"Ark completed the task without returning a video URL.",
				);
			const normalizedOutputUrl = normalizeArkHttpsReference(videoUrl, "output");
			await assertPublicReferenceHosts([normalizedOutputUrl], runtime, "output");
			return {
				outputs: [{ url: normalizedOutputUrl, mimeType: "video/mp4" }],
				remoteTaskId,
				status: "succeeded",
			};
		}
	}
	throw new OfficialProviderError(
		"REQUEST_TIMEOUT",
		`Ark video task timed out (last status: ${lastStatus || "unknown"}).`,
	);
}

/** Preserve the desktop Ark request contract while using its new defaults. */
export function buildArkVideoRequest(input: OfficialGenerationInput): ArkVideoRequest {
	assertArkVideoInput(input);
	if (
		input.params !== undefined &&
		(!input.params || typeof input.params !== "object" || Array.isArray(input.params))
	) {
		throw new OfficialProviderError("INVALID_INPUT", "Ark video parameters must be an object.");
	}
	const params = input.params ?? {};
	const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
	if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
		throw new OfficialProviderError("INVALID_INPUT", "The Ark video prompt is empty or too long.");
	}

	const references = collectReferences(input, params);
	const images = references.filter((reference) => reference.type === "image");
	const videos = references.filter((reference) => reference.type === "video");
	const audios = references.filter((reference) => reference.type === "audio");
	if (references.some((reference) => reference.role === "mask")) {
		throw new OfficialProviderError("UNSUPPORTED_INPUT_MODE", "Ark Seedance 2.5 does not accept image masks.");
	}

	const normalizedImages: Array<{ url: string; role: string }> = [];
	const appendImage = (reference: OfficialMediaReference, fallbackRole = "reference_image") => {
		const url = normalizeArkImageReference(reference);
		if (!normalizedImages.some((entry) => entry.url === url)) {
			normalizedImages.push({ url, role: reference.role || fallbackRole });
		}
	};
	for (const reference of images) appendImage(reference);

	const normalizedVideos = normalizeMediaReferences(videos, "video");
	const normalizedAudios = normalizeMediaReferences(audios, "audio");
	const allMediaCount = normalizedImages.length + normalizedVideos.length + normalizedAudios.length;
	if (allMediaCount > MAX_REFERENCE_COUNT) {
		throw new OfficialProviderError(
			"REFERENCE_LIMIT",
			`Ark video supports at most ${MAX_REFERENCE_COUNT} mixed media references.`,
		);
	}

	const keyframe =
		images.some((reference) => reference.role === "first_frame" || reference.role === "last_frame") ||
		(typeof params.firstFrameUrl === "string" && params.firstFrameUrl.trim().length > 0) ||
		(typeof params.lastFrameUrl === "string" && params.lastFrameUrl.trim().length > 0);
	const ratioByResolution: Record<string, string> = {
		"1280x720": "16:9",
		"1920x1080": "16:9",
		"720x1280": "9:16",
		"1080x1920": "9:16",
		"1024x1024": "1:1",
	};
	const ratio = keyframe
		? "adaptive"
		: (stringParam(params, "ratio", "aspectRatio", "aspect") ??
			ratioByResolution[String(params.resolution ?? "")] ??
			"adaptive");
	if (!["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"].includes(ratio)) {
		throw new OfficialProviderError("INVALID_INPUT", "The Ark video aspect ratio is invalid.");
	}

	const resolutionInput = (params.size ?? params.resolution ?? "480p").toString().trim().toLowerCase();
	const resolution = /^(480|720|1080)p$/u.test(resolutionInput)
		? resolutionInput
		: (
				{
					"854x480": "480p",
					"480x854": "480p",
					"1280x720": "720p",
					"720x1280": "720p",
					"1920x1080": "1080p",
					"1080x1920": "1080p",
				} as Record<string, string>
			)[resolutionInput];
	if (!resolution) throw new OfficialProviderError("INVALID_INPUT", "The Ark video resolution is invalid.");

	const rawDuration = Number(params.duration ?? params.seconds ?? 15);
	const duration = Number.isFinite(rawDuration) ? Math.floor(rawDuration) : 0;
	if (duration < 4 || duration > 30)
		throw new OfficialProviderError(
			"INVALID_INPUT",
			"Ark Seedance 2.5 video duration must be between 4 and 30 seconds.",
		);

	let promptText = prompt;
	const camera = stringParam(params, "camera");
	const style = stringParam(params, "style");
	if (camera) promptText += `\n运镜：${camera}`;
	if (style) promptText += `\n风格：${style}`;
	const content: Array<Record<string, unknown>> = [{ type: "text", text: promptText.slice(0, 2_000) }];
	for (const image of normalizedImages) {
		content.push({ type: "image_url", image_url: { url: image.url }, role: image.role });
	}
	for (const video of normalizedVideos) {
		content.push({ type: "video_url", video_url: { url: video }, role: "reference_video" });
	}
	for (const audio of normalizedAudios) {
		content.push({ type: "audio_url", audio_url: { url: audio }, role: "reference_audio" });
	}
	if (content.length > 1 + MAX_REFERENCE_COUNT) {
		throw new OfficialProviderError("REFERENCE_LIMIT", "Ark video supports at most 50 mixed media references.");
	}
	const dataImageBytes = normalizedImages.reduce((total, reference) => {
		if (!reference.url.startsWith("data:image/")) return total;
		const data = reference.url.slice(reference.url.indexOf(",") + 1);
		return total + Buffer.from(data, "base64").length;
	}, 0);
	if (dataImageBytes > MAX_REFERENCE_PAYLOAD_BYTES) {
		throw new OfficialProviderError(
			"INVALID_MEDIA_REFERENCE",
			"Ark image references exceed the local payload limit.",
		);
	}

	const paramsAudio = params.generate_audio ?? params.generateAudio;
	return {
		model: ARK_SEEDANCE_25_MODEL_ID,
		content,
		generate_audio: paramsAudio !== false,
		resolution: resolution as ArkVideoRequest["resolution"],
		ratio,
		duration,
		watermark: params.watermark === true,
	};
}

function assertArkVideoInput(input: OfficialGenerationInput): void {
	if (
		input.providerId !== ARK_VIDEO_PROVIDER_ID ||
		input.modality !== "video" ||
		input.modelId !== ARK_SEEDANCE_25_MODEL_ID
	) {
		throw new OfficialProviderError(
			"MODEL_UNAVAILABLE",
			"The configured Ark Seedance 2.5 video model is unavailable.",
		);
	}
	const operation = (input as OfficialGenerationInput & { operation?: string }).operation;
	if (operation !== undefined && operation !== "task") {
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured Ark Seedance 2.5 operation is unavailable.");
	}
}

function resolveArkBaseUrl(options: OfficialGenerationOptions): string {
	const baseUrl = resolveBaseUrl(options, ARK_VIDEO_BASE_URL, ARK_VIDEO_PROVIDER_ID);
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new OfficialProviderError("INVALID_BASE_URL", "The Ark API URL is invalid.");
	}
	if (
		url.protocol !== "https:" ||
		url.hostname !== new URL(ARK_VIDEO_BASE_URL).hostname ||
		url.port ||
		url.pathname.replace(/\/$/u, "") !== "/api/v3"
	) {
		throw new OfficialProviderError(
			"INVALID_BASE_URL",
			"Ark video generation must use the official Ark API endpoint.",
		);
	}
	return baseUrl;
}

function collectReferences(input: OfficialGenerationInput, params: Record<string, unknown>): OfficialMediaReference[] {
	const result: OfficialMediaReference[] = [];
	if (Array.isArray(input.references)) {
		if (input.references.length > 200) {
			throw new OfficialProviderError("REFERENCE_LIMIT", "Ark video received too many media references.");
		}
		for (const reference of input.references) {
			if (!reference || typeof reference !== "object" || !["image", "video", "audio"].includes(reference.type)) {
				throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", "An Ark media reference has an invalid type.");
			}
		}
		result.push(...input.references);
	}
	const add = (value: unknown, type: OfficialMediaReference["type"], role: string) => {
		const values = Array.isArray(value) ? value : value ? [value] : [];
		for (const item of values) {
			if (typeof item !== "string")
				throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", "Ark media references must be strings.");
			const data = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/u.exec(item.trim());
			result.push(data ? { type, base64: data[2], mimeType: data[1], role } : { type, url: item, role });
		}
	};
	add(params.firstFrameUrl, "image", "first_frame");
	add(params.lastFrameUrl, "image", "last_frame");
	add(
		params.referenceImages ??
			params.reference_images ??
			params.referenceUrls ??
			params.image ??
			params.imageUrl ??
			params.image_url ??
			params.sourceUrl,
		"image",
		"reference_image",
	);
	add(params.referenceVideos ?? params.reference_videos, "video", "reference_video");
	add(params.referenceAudios ?? params.reference_audios, "audio", "reference_audio");
	return result;
}

function normalizeArkImageReference(reference: OfficialMediaReference): string {
	if (reference.base64) {
		const mimeType = reference.mimeType ?? "image/png";
		if (!/^image\/(png|jpeg|webp)$/iu.test(mimeType)) {
			throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", "Ark image references must be PNG, JPEG, or WebP.");
		}
		const bytes = safeBase64(reference.base64, "Ark image reference");
		if (bytes.byteLength > MAX_REFERENCE_IMAGE_BYTES || !hasImageSignature(bytes, mimeType.toLowerCase())) {
			throw new OfficialProviderError(
				"INVALID_MEDIA_REFERENCE",
				"Ark image reference content does not match its declared format or size.",
			);
		}
		return `data:${mimeType.toLowerCase()};base64,${Buffer.from(bytes).toString("base64")}`;
	}
	if (typeof reference.url === "string" && reference.url.startsWith("data:")) {
		const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/iu.exec(reference.url);
		if (!match) throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", "Ark image reference data is invalid.");
		return normalizeArkImageReference({ ...reference, url: undefined, base64: match[2], mimeType: match[1] });
	}
	if (!reference.url)
		throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", "Ark image reference is missing its media URL.");
	return normalizeArkHttpsReference(reference.url, "reference");
}

function normalizeMediaReferences(references: OfficialMediaReference[], kind: "video" | "audio"): string[] {
	const values = new Set<string>();
	for (const reference of references) {
		if (reference.base64 || !reference.url) {
			throw new OfficialProviderError(
				"UNSUPPORTED_INPUT_MODE",
				`Ark ${kind} references require publicly accessible HTTPS URLs.`,
			);
		}
		values.add(normalizeArkHttpsReference(reference.url, "reference"));
	}
	return [...values];
}

function normalizeArkHttpsReference(value: string, purpose: "reference" | "output"): string {
	if (typeof value !== "string" || !value.trim() || value.length > MAX_REFERENCE_URL_CHARS) {
		throw new OfficialProviderError(
			purpose === "output" ? "INVALID_PROVIDER_RESPONSE" : "INVALID_MEDIA_REFERENCE",
			`Ark ${purpose} URL is invalid or too long.`,
		);
	}
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new OfficialProviderError(
			purpose === "output" ? "INVALID_PROVIDER_RESPONSE" : "INVALID_MEDIA_REFERENCE",
			`Ark ${purpose} URL must use public HTTPS.`,
		);
	}
	const hostname = url.hostname
		.replace(/^\[|\]$/gu, "")
		.toLowerCase()
		.replace(/\.$/u, "");
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		!hostname ||
		(url.port && url.port !== "443") ||
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal") ||
		hostname.endsWith(".test") ||
		hostname.endsWith(".invalid") ||
		(isIP(hostname) !== 0 && !isPublicAddress(hostname))
	) {
		throw new OfficialProviderError(
			purpose === "output" ? "INVALID_PROVIDER_RESPONSE" : "INVALID_MEDIA_REFERENCE",
			`Ark ${purpose} URL must use public HTTPS without local hosts or URL credentials.`,
		);
	}
	return url.toString();
}

async function assertPublicReferenceHosts(
	urls: string[],
	options: ArkVideoOptions,
	purpose: "reference" | "output" = "reference",
): Promise<void> {
	const resolver = options.resolveReferenceHost ?? resolveHost;
	for (const hostname of new Set(urls.map((value) => new URL(value).hostname))) {
		let addresses: ResolvableAddress[];
		try {
			addresses = await resolver(hostname);
		} catch (error) {
			if (error instanceof OfficialProviderError) throw error;
			throw new OfficialProviderError(
				purpose === "output" ? "INVALID_PROVIDER_RESPONSE" : "INVALID_MEDIA_REFERENCE",
				`Ark ${purpose} host could not be verified as public.`,
			);
		}
		if (
			!addresses.length ||
			addresses.some((entry) => !isPublicAddress(typeof entry === "string" ? entry : entry.address))
		) {
			throw new OfficialProviderError(
				purpose === "output" ? "INVALID_PROVIDER_RESPONSE" : "INVALID_MEDIA_REFERENCE",
				`Ark ${purpose} host resolved to a non-public address.`,
			);
		}
	}
}

async function resolveHost(hostname: string): Promise<ResolvableAddress[]> {
	const literal = hostname.replace(/^\[|\]$/gu, "");
	if (isIP(literal)) return [literal];
	return lookup(literal, { all: true, verbatim: true });
}

function isPublicAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) {
		const octets = address.split(".").map(Number);
		const [a, b, c] = octets;
		if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
		if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
		if (a === 100 && b >= 64 && b <= 127) return false;
		if (a === 169 && b === 254) return false;
		if (a === 172 && b >= 16 && b <= 31) return false;
		if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) return false;
		if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
		if (a === 203 && b === 0 && c === 113) return false;
		return true;
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

function urlsIn(request: ArkVideoRequest): string[] {
	const urls: string[] = [];
	for (const item of request.content.slice(1)) {
		if (item.type === "image_url") urls.push((item.image_url as { url: string }).url);
		if (item.type === "video_url") urls.push((item.video_url as { url: string }).url);
		if (item.type === "audio_url") urls.push((item.audio_url as { url: string }).url);
	}
	return urls.filter((value) => !value.startsWith("data:"));
}

async function queryWithTransientRetry(
	taskId: string,
	baseUrl: string,
	apiKey: string,
	options: OfficialGenerationOptions,
	runtime: ArkVideoOptions,
	deadline: number,
): Promise<ArkVideoTaskResponse> {
	let consecutiveFailures = 0;
	let lastError: unknown;
	while (consecutiveFailures < MAX_CONSECUTIVE_QUERY_FAILURES) {
		try {
			return await officialJson<ArkVideoTaskResponse>(
				endpoint(baseUrl, `contents/generations/tasks/${encodeURIComponent(taskId)}`),
				{ method: "GET", headers: jsonHeaders(apiKey) },
				options,
				apiKey,
			);
		} catch (error) {
			lastError = error;
			if (!isTransientQueryError(error) || consecutiveFailures + 1 >= MAX_CONSECUTIVE_QUERY_FAILURES) throw error;
			consecutiveFailures += 1;
			const waitMs = Math.min(1_000 * 2 ** (consecutiveFailures - 1), 8_000);
			if ((runtime.now ?? Date.now)() + waitMs >= deadline) throw error;
			await (runtime.sleep ?? defaultSleep)(waitMs);
			if (options.signal?.aborted)
				throw new OfficialProviderError("REQUEST_ABORTED", "The provider request was cancelled.");
		}
	}
	throw lastError;
}

function isTransientQueryError(error: unknown): boolean {
	if (!(error instanceof OfficialProviderError)) return false;
	return (
		error.code === "NETWORK_ERROR" ||
		error.code === "REQUEST_TIMEOUT" ||
		error.status === 408 ||
		error.status === 429 ||
		Boolean(error.status && error.status >= 500)
	);
}

function sanitizeTaskError(error: unknown, apiKey: string, urls: string[]): OfficialProviderError {
	if (error instanceof OfficialProviderError) {
		return new OfficialProviderError(error.code, sanitizeMessage(error.message, apiKey, urls), error.status, {
			cause: error,
		});
	}
	return new OfficialProviderError("PROVIDER_REQUEST_FAILED", sanitizeMessage(String(error), apiKey, urls));
}

function sanitizeMessage(message: string, apiKey: string, urls: string[]): string {
	let result = redactSecret(message, apiKey);
	for (const url of urls) result = result.split(url).join("[redacted reference URL]");
	return result
		.replace(/[\u0000-\u001f\u007f]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, 800);
}

function normalizeTaskId(value: unknown): string {
	if (
		(typeof value !== "string" && typeof value !== "number") ||
		!String(value).trim() ||
		String(value).length > 200 ||
		!/^[a-z0-9_-]+$/iu.test(String(value))
	) {
		throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "Ark did not return a valid video task ID.");
	}
	return String(value);
}

function extractVideoUrl(payload: ArkVideoTaskResponse): string | null {
	const data = objectValue(payload.data) ?? payload;
	const content = data.content;
	const items = Array.isArray(content) ? content : [content];
	for (const item of items) {
		const record = objectValue(item);
		if (!record) continue;
		for (const candidate of [record.video_url, record.url, record.output_url]) {
			const url = extractUrlValue(candidate);
			if (url) return url;
		}
	}
	for (const candidate of [data.video_url, data.url, data.output_url, data.output?.video_url, data.output?.url]) {
		const url = extractUrlValue(candidate);
		if (url) return url;
	}
	return null;
}

function extractUrlValue(value: unknown): string | null {
	if (typeof value === "string" && value.startsWith("https://")) return value;
	const record = objectValue(value);
	return typeof record?.url === "string" && record.url.startsWith("https://") ? record.url : null;
}

function readProviderDetail(payload: ArkVideoTaskResponse): string | null {
	const error = objectValue(payload.error);
	const candidates = [error?.message, error?.code, payload.message];
	return candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? null;
}

function objectValue(value: unknown): Record<string, any> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function stringParam(params: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function hasImageSignature(bytes: Uint8Array, mimeType: string): boolean {
	if (mimeType === "image/png")
		return (
			bytes.length >= 8 &&
			Buffer.from(bytes.slice(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		);
	if (mimeType === "image/jpeg")
		return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	if (mimeType === "image/webp")
		return (
			bytes.length >= 12 &&
			Buffer.from(bytes.slice(0, 4)).toString("ascii") === "RIFF" &&
			Buffer.from(bytes.slice(8, 12)).toString("ascii") === "WEBP"
		);
	return false;
}

async function defaultSleep(milliseconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
