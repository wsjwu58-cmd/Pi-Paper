import {
	endpoint,
	OfficialProviderError,
	officialBytes,
	officialJson,
	requireApiKey,
	resolveBaseUrl,
	safeBase64,
	toBase64,
} from "./http.ts";
import type { OfficialVideoRuntimeOptions } from "./official-video-task.ts";
import type {
	OfficialGenerationInput,
	OfficialGenerationOptions,
	OfficialGenerationResult,
	OfficialMediaReference,
} from "./types.ts";

export const GOOGLE_VEO_31_MODEL_ID = "veo-3.1-generate-preview";
export const GOOGLE_VEO_31_LITE_MODEL_ID = "veo-3.1-lite-generate-preview";
export const GOOGLE_VEO_VIDEO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const MODELS = [GOOGLE_VEO_31_MODEL_ID, GOOGLE_VEO_31_LITE_MODEL_ID] as const;
const DURATIONS = [4, 6, 8] as const;
const ASPECT_RATIOS = ["16:9", "9:16"] as const;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_TASK_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_QUERY_FAILURES = 5;
const SUPPORTED_PARAMS = new Set([
	"durationSeconds",
	"duration",
	"seconds",
	"aspectRatio",
	"aspect_ratio",
	"ratio",
	"resolution",
	"size",
	"seed",
	"generate_audio",
	"generateAudio",
	"style",
	"camera",
	"cameraMovement",
	"camera_movement",
	"firstFrameUrl",
	"first_frame",
	"lastFrameUrl",
	"last_frame",
	"referenceImages",
	"reference_images",
	"imageBase64",
	"image",
]);

type GoogleVeoRuntimeOptions = OfficialVideoRuntimeOptions;

interface GoogleVeoOperation {
	name?: string;
	done?: boolean;
	error?: { message?: string; code?: number | string };
	response?: {
		generateVideoResponse?: {
			generatedSamples?: Array<{ video?: { uri?: unknown } }>;
		};
	};
}

interface GoogleVeoImage {
	inlineData: { mimeType: string; data: string };
}

export interface GoogleVeoRequest {
	instances: Array<{
		prompt: string;
		image?: GoogleVeoImage;
		lastFrame?: GoogleVeoImage;
		referenceImages?: Array<{ image: GoogleVeoImage; referenceType: "asset" }>;
	}>;
	parameters: {
		aspectRatio: string;
		durationSeconds: string;
		resolution: string;
		personGeneration: "allow_all" | "allow_adult";
	};
}

/** Build a Gemini API request for the verified Veo 3.1 preview or Lite preview model. */
export function buildGoogleVeoRequest(input: OfficialGenerationInput): GoogleVeoRequest {
	if (
		input.providerId !== "google" ||
		input.modality !== "video" ||
		!(MODELS as readonly string[]).includes(input.modelId)
	) {
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured Google Veo 3.1 video model is unavailable.");
	}
	if (input.operation !== undefined && input.operation !== "task")
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured Google Veo operation is unavailable.");
	const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
	if (!prompt) throw new OfficialProviderError("INVALID_INPUT", "The Veo prompt is required.");
	const params = input.params ?? {};
	if (input.params !== undefined && (!input.params || Array.isArray(input.params) || typeof input.params !== "object"))
		throw new OfficialProviderError("INVALID_INPUT", "Veo parameters must be an object.");
	assertAllowedParams(params);
	if (params.seed !== undefined)
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"Seed control is not documented for the selected Gemini Veo 3.1 API models.",
		);
	if (params.generate_audio !== undefined || params.generateAudio !== undefined)
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"Gemini Veo 3.1 always generates synchronized audio and does not expose an audio toggle.",
		);
	const duration = Number(params.durationSeconds ?? params.duration ?? params.seconds ?? 8);
	if (!(DURATIONS as readonly number[]).includes(duration))
		throw new OfficialProviderError("INVALID_INPUT", "Veo duration must be 4, 6, or 8 seconds.");
	const aspectRatio = String(params.aspectRatio ?? params.aspect_ratio ?? params.ratio ?? "16:9").trim();
	if (!(ASPECT_RATIOS as readonly string[]).includes(aspectRatio))
		throw new OfficialProviderError("INVALID_INPUT", "Veo aspect ratio must be 16:9 or 9:16.");
	const resolution = String(params.resolution ?? params.size ?? "720p")
		.trim()
		.toLowerCase();
	const isLite = input.modelId === GOOGLE_VEO_31_LITE_MODEL_ID;
	const acceptedResolutions = isLite ? ["720p", "1080p"] : ["720p", "1080p", "4k"];
	if (!acceptedResolutions.includes(resolution))
		throw new OfficialProviderError("INVALID_INPUT", `Veo ${isLite ? "3.1 Lite" : "3.1"} resolution is unsupported.`);
	if ((resolution === "1080p" || resolution === "4k") && duration !== 8) {
		throw new OfficialProviderError("INVALID_INPUT", "Veo 1080p and 4k output requires an 8-second video.");
	}

	const references = collectImageReferences(input, params);
	const first = references.filter((reference) => reference.role === "first_frame");
	const last = references.filter((reference) => reference.role === "last_frame");
	const identityRefs = references.filter((reference) => reference.role === "reference_image");
	const unassignedRefs = references.filter((reference) => !reference.role);
	if (references.some((reference) => reference.type !== "image"))
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"This Veo adapter currently supports image references, not video extension inputs.",
		);
	if (unassignedRefs.length && (first.length || last.length || identityRefs.length))
		throw new OfficialProviderError(
			"INVALID_MEDIA_REFERENCE",
			"Veo image references must use one supported role; do not mix unassigned and explicitly-role inputs.",
		);
	if (first.length > 1 || last.length > 1 || (last.length === 1 && first.length !== 1)) {
		throw new OfficialProviderError(
			"INVALID_MEDIA_REFERENCE",
			"Veo interpolation requires one first-frame image and an optional last-frame image.",
		);
	}
	if (first.length && identityRefs.length)
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"Veo first/last frames cannot be combined with reference images in this adapter.",
		);
	if (unassignedRefs.length && (isLite || unassignedRefs.length > 3)) {
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"Unassigned Veo image references require the standard 3.1 model and allow at most three images.",
		);
	}
	if (identityRefs.length && (isLite || identityRefs.length > 3)) {
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"Veo reference images require the standard 3.1 model and allow at most three images.",
		);
	}
	if ((last.length || identityRefs.length || unassignedRefs.length) && duration !== 8)
		throw new OfficialProviderError(
			"INVALID_INPUT",
			"Veo interpolation and reference-image generation requires an 8-second video.",
		);
	const totalBytes: number[] = [];
	const toImage = (reference: OfficialMediaReference) => makeVeoImage(reference, totalBytes);
	const instance: GoogleVeoRequest["instances"][number] = {
		prompt: withExplicitStyleAndCamera(prompt, params),
		...(first.length ? { image: toImage(first[0]) } : {}),
		...(last.length ? { lastFrame: toImage(last[0]) } : {}),
		...(identityRefs.length || unassignedRefs.length
			? {
					referenceImages: [...identityRefs, ...unassignedRefs].map((reference) => ({
						image: toImage(reference),
						referenceType: "asset" as const,
					})),
				}
			: {}),
	};
	if (totalBytes.reduce((sum, value) => sum + value, 0) > MAX_TOTAL_IMAGE_BYTES) {
		throw new OfficialProviderError(
			"INVALID_MEDIA_REFERENCE",
			"Veo inline image references exceed the safe request size.",
		);
	}
	const personGeneration =
		first.length || last.length || identityRefs.length || unassignedRefs.length ? "allow_adult" : "allow_all";
	return {
		instances: [instance],
		parameters: { aspectRatio, durationSeconds: String(duration), resolution, personGeneration },
	};
}

/**
 * Submit and poll Gemini's long-running Veo operation. The authenticated output URI is
 * validated before key use, downloaded without redirects, size-limited, and returned as
 * base64 so the general-purpose desktop downloader never receives the Google API key.
 */
export async function generateGoogleVeoVideo(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	const request = buildGoogleVeoRequest(input);
	const apiKey = requireApiKey(options, "google");
	const baseUrl = resolveBaseUrl(options, GOOGLE_VEO_VIDEO_BASE_URL, "google");
	const base = new URL(baseUrl);
	if (
		base.protocol !== "https:" ||
		base.hostname !== "generativelanguage.googleapis.com" ||
		base.port ||
		base.pathname.replace(/\/$/u, "") !== "/v1beta"
	) {
		throw new OfficialProviderError("INVALID_BASE_URL", "Veo generation requires the official Gemini API endpoint.");
	}
	const runtime = options as GoogleVeoRuntimeOptions;
	let operationName = input.remoteTaskId ? normalizeOperationName(input.remoteTaskId, input.modelId) : undefined;
	if (!operationName) {
		if (typeof options.onSubmitting !== "function" || typeof options.onSubmitted !== "function") {
			throw new OfficialProviderError(
				"TASK_CHECKPOINT_REQUIRED",
				"Veo video submission requires durable checkpoints before and after POST.",
			);
		}
		throwIfAborted(options.signal);
		await options.onSubmitting();
		throwIfAborted(options.signal);
		const created = await officialJson<GoogleVeoOperation>(
			endpoint(baseUrl, `models/${input.modelId}:predictLongRunning`),
			{
				method: "POST",
				headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
				body: JSON.stringify(request),
			},
			options,
			apiKey,
		);
		operationName = normalizeOperationName(created.name, input.modelId);
		await options.onSubmitted(operationName);
	}

	const now = runtime.now ?? Date.now;
	const sleep = runtime.sleep ?? defaultSleep;
	const deadline = now() + (runtime.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS);
	while (now() < deadline) {
		const pause = Math.min(runtime.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, Math.max(0, deadline - now()));
		if (pause > 0) await sleepOrAbort(pause, sleep, options.signal);
		throwIfAborted(options.signal);
		const operation = await queryOperation(operationName, baseUrl, apiKey, options, runtime, deadline, now, sleep);
		if (operation.error) {
			throw new OfficialProviderError("GENERATION_FAILED", "Google Veo video generation failed.");
		}
		if (operation.done === true) {
			const uri = operation.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
			if (typeof uri !== "string" || !uri.trim())
				throw new OfficialProviderError(
					"EMPTY_PROVIDER_RESPONSE",
					"Veo completed without returning a video file URI.",
				);
			const safeUri = validateGoogleOutputUri(uri);
			const { bytes, response } = await officialBytes(
				safeUri,
				{ method: "GET", headers: { "x-goog-api-key": apiKey } },
				options,
				apiKey,
				MAX_OUTPUT_BYTES,
			);
			const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
			if (contentType && contentType !== "video/mp4" && contentType !== "application/octet-stream") {
				throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "Google returned a non-MP4 Veo output.");
			}
			if (!isMp4(bytes))
				throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "Google Veo output is not a valid MP4 file.");
			return {
				outputs: [{ base64: toBase64(bytes), mimeType: "video/mp4" }],
				remoteTaskId: operationName,
				status: "succeeded",
			};
		}
	}
	throw new OfficialProviderError(
		"REQUEST_TIMEOUT",
		"Google Veo video task timed out while the operation remained active.",
	);
}

function collectImageReferences(
	input: OfficialGenerationInput,
	params: Record<string, unknown>,
): OfficialMediaReference[] {
	const references = [...(input.references ?? [])];
	const add = (value: unknown, role: string) => {
		if (value === undefined || value === null || value === "") return;
		for (const entry of Array.isArray(value) ? value : [value]) {
			if (typeof entry !== "string")
				throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", "Veo image inputs must be base64 data strings.");
			const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/iu.exec(entry.trim());
			references.push(
				match
					? { type: "image", base64: match[2], mimeType: match[1].toLowerCase(), role }
					: { type: "image", base64: entry.trim(), mimeType: "image/png", role },
			);
		}
	};
	add(params.firstFrameUrl ?? params.first_frame, "first_frame");
	add(params.lastFrameUrl ?? params.last_frame, "last_frame");
	add(params.referenceImages ?? params.reference_images, "reference_image");
	add(params.imageBase64 ?? params.image, "first_frame");
	if (references.length > 5)
		throw new OfficialProviderError(
			"REFERENCE_LIMIT",
			"Veo accepts one first/last frame pair or up to three reference images.",
		);
	return references;
}

function assertAllowedParams(params: Record<string, unknown>): void {
	const unknown = Object.keys(params).find((key) => !SUPPORTED_PARAMS.has(key));
	if (unknown)
		throw new OfficialProviderError("INVALID_INPUT", `Gemini Veo does not support the ${unknown} parameter.`);
}

function makeVeoImage(reference: OfficialMediaReference, totalBytes: number[]): GoogleVeoImage {
	if (reference.type !== "image" || !reference.base64 || reference.url) {
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"Gemini Veo image inputs must be locally validated base64 image bytes.",
		);
	}
	const mimeType = (reference.mimeType ?? "image/png").toLowerCase();
	if (!/^image\/(png|jpeg|webp)$/u.test(mimeType))
		throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", "Veo image references must be PNG, JPEG, or WebP.");
	const bytes = safeBase64(reference.base64, "Veo image reference");
	if (bytes.byteLength > MAX_IMAGE_BYTES)
		throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", "A Veo image reference exceeds the 8 MB local limit.");
	totalBytes.push(bytes.byteLength);
	return { inlineData: { mimeType, data: Buffer.from(bytes).toString("base64") } };
}

function normalizeOperationName(value: unknown, modelId: string): string {
	if (typeof value !== "string")
		throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "Google returned an invalid Veo operation name.");
	const normalized = value.trim().replace(/^\/+|\/+$/gu, "");
	if (!new RegExp(`^models/${escapeRegExp(modelId)}/operations/[A-Za-z0-9_-]{1,180}$`, "u").test(normalized)) {
		throw new OfficialProviderError(
			"INVALID_PROVIDER_RESPONSE",
			"Google returned a Veo operation name outside the expected model path.",
		);
	}
	return normalized;
}

function validateGoogleOutputUri(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "Google returned an invalid Veo output URI.");
	}
	if (
		url.protocol !== "https:" ||
		url.hostname !== "generativelanguage.googleapis.com" ||
		url.port ||
		url.username ||
		url.password ||
		url.hash ||
		!/^\/v1beta\/files\/[A-Za-z0-9_-]{1,180}:download$/u.test(url.pathname)
	) {
		throw new OfficialProviderError(
			"INVALID_PROVIDER_RESPONSE",
			"Google Veo output URI is outside the official Gemini file-download path.",
		);
	}
	const queryEntries = [...url.searchParams.entries()];
	if (
		queryEntries.length > 1 ||
		(queryEntries.length === 1 && (queryEntries[0][0] !== "alt" || queryEntries[0][1] !== "media"))
	) {
		throw new OfficialProviderError(
			"INVALID_PROVIDER_RESPONSE",
			"Google Veo output URI contains unexpected query parameters.",
		);
	}
	return url.toString();
}

async function queryOperation(
	operationName: string,
	baseUrl: string,
	apiKey: string,
	options: OfficialGenerationOptions,
	_runtime: GoogleVeoRuntimeOptions,
	deadline: number,
	now: () => number,
	sleep: (milliseconds: number) => Promise<void>,
): Promise<GoogleVeoOperation> {
	let failures = 0;
	while (true) {
		throwIfAborted(options.signal);
		try {
			return await officialJson<GoogleVeoOperation>(
				endpoint(baseUrl, operationName),
				{ method: "GET", headers: { "x-goog-api-key": apiKey } },
				options,
				apiKey,
			);
		} catch (error) {
			if (!isTransientQueryError(error) || failures >= MAX_QUERY_FAILURES) throw sanitizeGoogleError(error);
			const delay = Math.min(1_000 * 2 ** failures, 8_000, Math.max(0, deadline - now()));
			if (delay <= 0) throw sanitizeGoogleError(error);
			failures += 1;
			await sleepOrAbort(delay, sleep, options.signal);
		}
	}
}

function isTransientQueryError(error: unknown): boolean {
	if (!(error instanceof OfficialProviderError)) return false;
	return (
		error.code === "NETWORK_ERROR" ||
		error.status === 408 ||
		error.status === 425 ||
		error.status === 429 ||
		(error.status !== undefined && error.status >= 500)
	);
}

function sanitizeGoogleError(error: unknown): OfficialProviderError {
	if (!(error instanceof OfficialProviderError))
		return new OfficialProviderError("NETWORK_ERROR", "Google Veo request failed.");
	if (error.code === "REQUEST_ABORTED")
		return new OfficialProviderError("REQUEST_ABORTED", "The Google Veo request was cancelled.");
	if (error.code === "REQUEST_TIMEOUT")
		return new OfficialProviderError("REQUEST_TIMEOUT", "The Google Veo request timed out.");
	return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new OfficialProviderError("REQUEST_ABORTED", "The Google Veo request was cancelled.");
}

async function sleepOrAbort(
	milliseconds: number,
	sleep: (milliseconds: number) => Promise<void>,
	signal: AbortSignal | undefined,
): Promise<void> {
	throwIfAborted(signal);
	if (!signal) {
		await sleep(milliseconds);
		return;
	}
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<void>((resolve) => {
		onAbort = () => resolve();
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		await Promise.race([sleep(milliseconds), aborted]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
	throwIfAborted(signal);
}

function isMp4(bytes: Uint8Array): boolean {
	return bytes.byteLength >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function defaultSleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
