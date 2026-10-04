import { createHmac } from "node:crypto";
import { OfficialProviderError, resolveBaseUrl } from "./http.ts";
import { runOfficialVideoTask, videoJsonHeaders } from "./official-video-task.ts";
import type { OfficialGenerationInput, OfficialGenerationOptions } from "./types.ts";

export const KLING_VIDEO_PROVIDER_ID = "kling";
export const KLING_V3_MODEL_ID = "kling-v3";
export const KLING_V3_OMNI_MODEL_ID = "kling-v3-omni";
export const KLING_VIDEO_BASE_URL = "https://api-singapore.klingai.com";

const MAX_PROMPT_CHARS = 2_500;
const POLL_INTERVAL_MS = 5_000;
const ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
const VIDEO_MODES = ["std", "pro", "4k"] as const;

type KlingModelId = typeof KLING_V3_MODEL_ID | typeof KLING_V3_OMNI_MODEL_ID;
type KlingVideoMode = (typeof VIDEO_MODES)[number];

export interface KlingVideoRequest {
	model_name: KlingModelId;
	prompt: string;
	duration: string;
	mode: KlingVideoMode;
	sound: "on" | "off";
	aspect_ratio: (typeof ASPECT_RATIOS)[number];
	watermark_info?: { enabled: boolean };
}

interface KlingTaskEnvelope {
	code?: number;
	message?: string;
	data?: {
		task_id?: string | number;
		task_status?: string;
		task_status_msg?: string;
		task_result?: { videos?: Array<{ url?: unknown }> };
	};
}

/** Submit a verified Kling V3 text-to-video request or resume its existing task. */
export async function generateKlingVideo(input: OfficialGenerationInput, options: OfficialGenerationOptions) {
	const request = buildKlingVideoRequest(input);
	const authorizationToken = klingAuthorizationToken(options);
	const baseUrl = resolveKlingBaseUrl(options);
	const omni = input.modelId === KLING_V3_OMNI_MODEL_ID;
	const taskPath = omni ? "videos/omni-video" : "videos/text2video";
	return runOfficialVideoTask<KlingTaskEnvelope, KlingTaskEnvelope>(input, options, authorizationToken, {
		providerName: "Kling",
		baseUrl,
		submitPath: `v1/${taskPath}`,
		queryPath: (taskId) => `v1/${taskPath}/${encodeURIComponent(taskId)}`,
		request,
		pollIntervalMs: POLL_INTERVAL_MS,
		submitHeaders: (token) => videoJsonHeaders(token),
		queryHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
		readTaskId: (payload) => {
			assertKlingSuccess(payload);
			return payload.data?.task_id;
		},
		readTask: (payload) => {
			assertKlingSuccess(payload);
			return {
				status: payload.data?.task_status,
				videoUrl: payload.data?.task_result?.videos?.[0]?.url,
			};
		},
		activeStatuses: ["submitted", "processing"],
		succeededStatuses: ["succeed"],
		failedStatuses: ["failed", "cancelled", "canceled"],
	});
}

/** Build only the documented v1 text-to-video fields for the two verified IDs. */
export function buildKlingVideoRequest(input: OfficialGenerationInput): KlingVideoRequest {
	assertKlingInput(input);
	const params = input.params ?? {};
	const allowed = [
		"duration",
		"seconds",
		"mode",
		"resolution",
		"size",
		"resKey",
		"ratio",
		"aspect",
		"aspectRatio",
		"aspect_ratio",
		"sound",
		"generate_audio",
		"generateAudio",
		"watermark",
		"watermark_info",
		"count",
		"n",
		"num_images",
		"style",
		"camera",
		"referenceTexts",
		"referenceImages",
		"referenceUrls",
		"referenceVideos",
		"referenceAudios",
		"firstFrameUrl",
		"lastFrameUrl",
		"imageUrl",
		"videoUrl",
		"upstreamNodeIds",
	];
	const unsupported = Object.keys(params).find((key) => !allowed.includes(key));
	if (unsupported)
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_PARAMETER",
			`Kling video parameter ${unsupported} is not supported by this verified route.`,
		);
	if (input.references?.length || hasReferenceValues(params)) {
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"This Kling adapter currently supports text-to-video only; reference media is not sent.",
		);
	}
	const count = numberAlias(params, "count", "n", "num_images");
	if (count !== undefined && count !== 1)
		throw new OfficialProviderError("UNSUPPORTED_IMAGE_COUNT", "Kling V3 creates one video per task.");
	const prompt = withPromptOptions(input.prompt, params);
	if (!prompt || [...prompt].length > MAX_PROMPT_CHARS) {
		throw new OfficialProviderError(
			"INVALID_INPUT",
			`Kling prompts must contain 1 to ${MAX_PROMPT_CHARS} characters.`,
		);
	}
	const duration = durationValue(params);
	const aspectRatio = stringAlias(params, "aspect ratio", "ratio", "aspect", "aspectRatio", "aspect_ratio") ?? "16:9";
	if (!(ASPECT_RATIOS as readonly string[]).includes(aspectRatio)) {
		throw new OfficialProviderError("INVALID_INPUT", "Kling text-to-video aspect_ratio must be 16:9, 9:16, or 1:1.");
	}
	const mode = videoMode(params);
	const sound = soundMode(params);
	const watermark = watermarkOption(params);
	return {
		model_name: input.modelId as KlingModelId,
		prompt,
		duration,
		mode,
		sound,
		aspect_ratio: aspectRatio as KlingVideoRequest["aspect_ratio"],
		...(watermark ? { watermark_info: watermark } : {}),
	};
}

/** Sign the documented legacy Access Key / Secret Key JWT for one request sequence. */
export function createKlingJwt(
	accessKey: string,
	secretKey: string,
	nowSeconds = Math.floor(Date.now() / 1_000),
): string {
	if (!credentialValue(accessKey) || !credentialValue(secretKey)) {
		throw new OfficialProviderError("API_CREDENTIALS_REQUIRED", "Configure both Kling Access Key and Secret Key.");
	}
	const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payload = base64Url(JSON.stringify({ iss: accessKey, exp: nowSeconds + 1_800, nbf: nowSeconds - 5 }));
	const signingInput = `${header}.${payload}`;
	const signature = createHmac("sha256", secretKey).update(signingInput).digest("base64url");
	return `${signingInput}.${signature}`;
}

function klingCredentials(options: OfficialGenerationOptions): { accessKey: string; secretKey: string } {
	const credentials = options.credentials ?? {};
	const accessKey = credentials.accessKey ?? credentials.access_key ?? "";
	const secretKey = credentials.secretKey ?? credentials.secret_key ?? "";
	if (!credentialValue(accessKey) || !credentialValue(secretKey)) {
		throw new OfficialProviderError("API_CREDENTIALS_REQUIRED", "Configure both Kling Access Key and Secret Key.");
	}
	return { accessKey, secretKey };
}

/** Prefer Kling's current single API Key; preserve the documented legacy AK/SK JWT flow. */
export function createKlingAuthorizationToken(credentials: Record<string, string>): string {
	const apiKey = credentials.apiKey ?? credentials.api_key;
	const accessKey = credentials.accessKey ?? credentials.access_key;
	const secretKey = credentials.secretKey ?? credentials.secret_key;
	const hasLegacyCredential = accessKey !== undefined || secretKey !== undefined;
	if (apiKey !== undefined) {
		if (!credentialValue(apiKey)) {
			throw new OfficialProviderError("API_CREDENTIALS_REQUIRED", "Configure a valid Kling API Key.");
		}
		if (hasLegacyCredential) {
			throw new OfficialProviderError(
				"API_CREDENTIALS_REQUIRED",
				"Configure either a Kling API Key or the legacy Access Key and Secret Key pair.",
			);
		}
		return apiKey;
	}
	const { accessKey: legacyAccessKey, secretKey: legacySecretKey } = klingCredentials({ credentials });
	return createKlingJwt(legacyAccessKey, legacySecretKey);
}

function klingAuthorizationToken(options: OfficialGenerationOptions): string {
	const credentials = options.credentials ?? {};
	const configuredApiKey = credentials.apiKey ?? credentials.api_key;
	if (configuredApiKey !== undefined) {
		if (options.apiKey !== undefined && configuredApiKey !== options.apiKey) {
			throw new OfficialProviderError("API_CREDENTIALS_REQUIRED", "Kling API Key values do not match.");
		}
		return createKlingAuthorizationToken(credentials);
	}
	const accessKey = credentials.accessKey ?? credentials.access_key;
	const secretKey = credentials.secretKey ?? credentials.secret_key;
	const hasLegacyCredential =
		(accessKey !== undefined && accessKey !== "") || (secretKey !== undefined && secretKey !== "");
	if (hasLegacyCredential || options.apiKey === undefined) {
		return createKlingAuthorizationToken(credentials);
	}
	return createKlingAuthorizationToken({ apiKey: options.apiKey });
}

function credentialValue(value: unknown): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.length <= 1_024 && !/[\u0000-\u001f\u007f]/u.test(value)
	);
}

function resolveKlingBaseUrl(options: OfficialGenerationOptions): string {
	const resolved = resolveBaseUrl(options, KLING_VIDEO_BASE_URL, KLING_VIDEO_PROVIDER_ID);
	const url = new URL(resolved);
	if (
		url.protocol !== "https:" ||
		url.hostname !== "api-singapore.klingai.com" ||
		url.port ||
		!["", "/"].includes(url.pathname)
	) {
		throw new OfficialProviderError(
			"INVALID_BASE_URL",
			"Kling video requests must use the official Singapore API host.",
		);
	}
	return url.origin;
}

function assertKlingInput(input: OfficialGenerationInput): void {
	if (
		input.providerId !== KLING_VIDEO_PROVIDER_ID ||
		input.modality !== "video" ||
		![KLING_V3_MODEL_ID, KLING_V3_OMNI_MODEL_ID].includes(input.modelId as KlingModelId)
	) {
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured Kling video model is unavailable.");
	}
	if (input.operation !== undefined && input.operation !== "task") {
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured Kling video operation is unavailable.");
	}
	if (typeof input.prompt !== "string")
		throw new OfficialProviderError("INVALID_INPUT", "Kling video prompts must be text.");
	if (
		input.params !== undefined &&
		(!input.params || typeof input.params !== "object" || Array.isArray(input.params))
	) {
		throw new OfficialProviderError("INVALID_INPUT", "Kling video parameters must be an object.");
	}
}

function assertKlingSuccess(payload: KlingTaskEnvelope): void {
	if (payload.code !== 0) {
		throw new OfficialProviderError("PROVIDER_HTTP_ERROR", "Kling rejected the video task request.");
	}
}

function hasReferenceValues(params: Record<string, unknown>): boolean {
	for (const key of [
		"referenceImages",
		"referenceUrls",
		"referenceVideos",
		"referenceAudios",
		"firstFrameUrl",
		"lastFrameUrl",
		"imageUrl",
		"videoUrl",
	]) {
		const value = params[key];
		if (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "") return true;
	}
	return false;
}

function withPromptOptions(promptValue: string, params: Record<string, unknown>): string {
	const notes: string[] = [];
	for (const [key, label] of [
		["style", "Style"],
		["camera", "Camera movement"],
	] as const) {
		const value = params[key];
		if (value === undefined || value === "") continue;
		if (typeof value !== "string" || value.length > 1_000)
			throw new OfficialProviderError("INVALID_INPUT", `Kling ${key} must be a string of at most 1000 characters.`);
		notes.push(`${label}: ${value.trim()}`);
	}
	const referenceTexts = params.referenceTexts;
	if (referenceTexts !== undefined) {
		const values = Array.isArray(referenceTexts) ? referenceTexts : [referenceTexts];
		if (values.length > 32 || values.some((value) => typeof value !== "string" || !value.trim())) {
			throw new OfficialProviderError("INVALID_INPUT", "Kling referenceTexts must be non-empty strings.");
		}
		if (values.length)
			notes.push(`Reference descriptions:\n${values.map((value) => `- ${String(value).trim()}`).join("\n")}`);
	}
	return [promptValue.trim(), ...notes].filter(Boolean).join("\n");
}

function durationValue(params: Record<string, unknown>): string {
	const values: number[] = [];
	for (const key of ["duration", "seconds"]) {
		const value = params[key];
		if (value === undefined) continue;
		if (!(typeof value === "number" && Number.isFinite(value)) && typeof value !== "string") {
			throw new OfficialProviderError("INVALID_INPUT", `${key} must be a number or string.`);
		}
		const durationValue = Number(value);
		if (!Number.isFinite(durationValue)) throw new OfficialProviderError("INVALID_INPUT", `${key} must be numeric.`);
		values.push(durationValue);
	}
	if (new Set(values).size > 1)
		throw new OfficialProviderError("INVALID_INPUT", "Conflicting duration values were supplied.");
	const duration = values[0] ?? 5;
	if (!Number.isInteger(duration) || duration < 3 || duration > 15) {
		throw new OfficialProviderError(
			"INVALID_INPUT",
			"Kling V3 video duration must be an integer from 3 to 15 seconds.",
		);
	}
	return String(duration);
}

function videoMode(params: Record<string, unknown>): KlingVideoMode {
	const modeRaw = params.mode;
	if (
		modeRaw !== undefined &&
		(typeof modeRaw !== "string" || !(VIDEO_MODES as readonly string[]).includes(modeRaw.toLowerCase()))
	) {
		throw new OfficialProviderError("INVALID_INPUT", "Kling video mode must be std, pro, or 4k.");
	}
	const mode = typeof modeRaw === "string" ? (modeRaw.toLowerCase() as KlingVideoMode) : undefined;
	const sizeRaw = stringAlias(params, "resolution", "resolution", "size", "resKey");
	const resolutionMode: Record<string, KlingVideoMode> = { "720P": "std", "1080P": "pro", "4K": "4k" };
	const selectedResolution = sizeRaw?.toUpperCase();
	const fromResolution = selectedResolution ? resolutionMode[selectedResolution] : undefined;
	if (sizeRaw && !fromResolution)
		throw new OfficialProviderError("INVALID_INPUT", "Kling resolution must be 720p, 1080p, or 4K.");
	if (mode && fromResolution && mode !== fromResolution)
		throw new OfficialProviderError("INVALID_INPUT", "Kling mode conflicts with the selected resolution.");
	return mode ?? fromResolution ?? "std";
}

function soundMode(params: Record<string, unknown>): "on" | "off" {
	const soundRaw = params.sound;
	if (soundRaw !== undefined && soundRaw !== "on" && soundRaw !== "off")
		throw new OfficialProviderError("INVALID_INPUT", "Kling sound must be on or off.");
	const audioRaw = params.generate_audio ?? params.generateAudio;
	if (audioRaw !== undefined && typeof audioRaw !== "boolean")
		throw new OfficialProviderError("INVALID_INPUT", "Kling generate_audio must be a boolean.");
	const fromAudio = typeof audioRaw === "boolean" ? (audioRaw ? "on" : "off") : undefined;
	if (soundRaw !== undefined && fromAudio !== undefined && soundRaw !== fromAudio)
		throw new OfficialProviderError("INVALID_INPUT", "Kling sound conflicts with generate_audio.");
	return soundRaw ?? fromAudio ?? "off";
}

function watermarkOption(params: Record<string, unknown>): { enabled: boolean } | undefined {
	let objectOption: { enabled: boolean } | undefined;
	if (params.watermark_info !== undefined) {
		if (!params.watermark_info || typeof params.watermark_info !== "object" || Array.isArray(params.watermark_info)) {
			throw new OfficialProviderError("INVALID_INPUT", "Kling watermark_info must contain an enabled boolean.");
		}
		const record = params.watermark_info as Record<string, unknown>;
		if (Object.keys(record).some((key) => key !== "enabled") || typeof record.enabled !== "boolean") {
			throw new OfficialProviderError("INVALID_INPUT", "Kling watermark_info must contain only an enabled boolean.");
		}
		objectOption = { enabled: record.enabled };
	}
	const alias = params.watermark;
	if (alias !== undefined && typeof alias !== "boolean")
		throw new OfficialProviderError("INVALID_INPUT", "Kling watermark must be a boolean.");
	if (objectOption && typeof alias === "boolean" && objectOption.enabled !== alias)
		throw new OfficialProviderError("INVALID_INPUT", "Kling watermark fields conflict.");
	return objectOption ?? (typeof alias === "boolean" ? { enabled: alias } : undefined);
}

function numberAlias(params: Record<string, unknown>, ...keys: string[]): number | undefined {
	const values: number[] = [];
	for (const key of keys) {
		if (params[key] === undefined) continue;
		const value = params[key];
		if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1) {
			throw new OfficialProviderError("INVALID_IMAGE_COUNT", "Kling tasks support exactly one output per request.");
		}
		values.push(value);
	}
	if (new Set(values).size > 1)
		throw new OfficialProviderError("INVALID_IMAGE_COUNT", "Conflicting Kling output counts were supplied.");
	return values[0];
}

function stringAlias(params: Record<string, unknown>, label: string, ...keys: string[]): string | undefined {
	const values: string[] = [];
	for (const key of keys) {
		const value = params[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || !value.trim())
			throw new OfficialProviderError("INVALID_INPUT", `${key} must be a non-empty string.`);
		values.push(value.trim());
	}
	if (new Set(values).size > 1)
		throw new OfficialProviderError("INVALID_INPUT", `Conflicting ${label} values were supplied.`);
	return values[0];
}

function base64Url(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}
