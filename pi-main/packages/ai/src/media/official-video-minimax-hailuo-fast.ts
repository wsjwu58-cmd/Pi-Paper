import { endpoint, OfficialProviderError, referenceValue, requireApiKey, resolveBaseUrl, safeBase64 } from "./http.ts";
import { type OfficialVideoTaskProtocol, runOfficialVideoTask, videoJsonHeaders } from "./official-video-task.ts";
import type {
	OfficialGenerationInput,
	OfficialGenerationOptions,
	OfficialGenerationResult,
	OfficialMediaReference,
} from "./types.ts";

export const MINIMAX_HAILUO_23_FAST_MODEL_ID = "MiniMax-Hailuo-2.3-Fast";
export const MINIMAX_HAILUO_PROVIDER_ID = "minimax";
export const MINIMAX_HAILUO_VIDEO_BASE_URL = "https://api.minimax.io/v1";

const MAX_PROMPT_CHARS = 2_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

interface HailuoTaskResponse {
	task_id?: string | number;
	status?: string;
	file_id?: string | number;
	video_url?: unknown;
	base_resp?: { status_code?: number; status_msg?: string };
}

export interface Hailuo23FastRequest {
	model: typeof MINIMAX_HAILUO_23_FAST_MODEL_ID;
	prompt: string;
	first_frame_image: string;
	duration: 6 | 10;
	resolution: "768P" | "1080P";
	prompt_optimizer: boolean;
	fast_pretreatment: boolean;
}

export function buildHailuo23FastRequest(input: OfficialGenerationInput): Hailuo23FastRequest {
	if (
		input.providerId !== MINIMAX_HAILUO_PROVIDER_ID ||
		input.modelId !== MINIMAX_HAILUO_23_FAST_MODEL_ID ||
		input.modality !== "video"
	) {
		throw new OfficialProviderError(
			"MODEL_UNAVAILABLE",
			"The configured MiniMax Hailuo 2.3 Fast video model is unavailable.",
		);
	}
	if (input.operation !== undefined && input.operation !== "task")
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured MiniMax Hailuo operation is unavailable.");
	const params = input.params ?? {};
	if (input.params !== undefined && (!input.params || typeof input.params !== "object" || Array.isArray(input.params)))
		throw new OfficialProviderError("INVALID_INPUT", "MiniMax video parameters must be an object.");
	assertAllowedParams(params);
	const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
	if (!prompt || prompt.length > MAX_PROMPT_CHARS)
		throw new OfficialProviderError("INVALID_INPUT", "Hailuo 2.3 Fast prompts must contain 1–2,000 characters.");
	const images = collectFirstFrame(input.references ?? [], params);
	if (images.length !== 1)
		throw new OfficialProviderError(
			"INVALID_MEDIA_REFERENCE",
			"Hailuo 2.3 Fast requires exactly one starting frame image.",
		);
	const resolution = String(params.resolution ?? params.size ?? "768P")
		.trim()
		.toUpperCase();
	if (resolution !== "768P" && resolution !== "1080P")
		throw new OfficialProviderError("INVALID_INPUT", "Hailuo 2.3 Fast resolution must be 768P or 1080P.");
	const duration = Number(params.duration ?? params.seconds ?? 6);
	if (duration !== 6 && duration !== 10)
		throw new OfficialProviderError("INVALID_INPUT", "Hailuo 2.3 Fast duration must be 6 or 10 seconds.");
	if (resolution === "1080P" && duration !== 6)
		throw new OfficialProviderError("INVALID_INPUT", "Hailuo 2.3 Fast supports 1080P only at 6 seconds.");
	const ratioValues = [params.ratio, params.aspectRatio, params.aspect_ratio, params.imageAspectRatio].filter(
		(value) => value !== undefined,
	);
	if (ratioValues.some((value) => typeof value !== "string" || value.trim().toLowerCase() !== "adaptive")) {
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"Hailuo image-to-video aspect ratio is derived from the starting image; only adaptive is supported.",
		);
	}
	const promptOptimizer = readBoolean(params.prompt_optimizer ?? params.promptOptimizer, "prompt_optimizer", true);
	const fastPretreatment = readBoolean(
		params.fast_pretreatment ?? params.fastPretreatment,
		"fast_pretreatment",
		false,
	);
	if (fastPretreatment && !promptOptimizer)
		throw new OfficialProviderError("INVALID_INPUT", "fast_pretreatment requires prompt_optimizer to be enabled.");
	const fullPrompt = appendStyleAndCamera(prompt, params);
	return {
		model: MINIMAX_HAILUO_23_FAST_MODEL_ID,
		prompt: fullPrompt,
		first_frame_image: imageValue(images[0]),
		duration: duration as 6 | 10,
		resolution: resolution as Hailuo23FastRequest["resolution"],
		prompt_optimizer: promptOptimizer,
		fast_pretreatment: fastPretreatment,
	};
}

export async function generateHailuo23FastVideo(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	const request = buildHailuo23FastRequest(input);
	const apiKey = requireApiKey(options, MINIMAX_HAILUO_PROVIDER_ID);
	const baseUrl = resolveMiniMaxHailuoBaseUrl(options);
	const fetchOptions: OfficialGenerationOptions = {
		...options,
		fetch: createVideoUrlResolvingFetch(options, apiKey, baseUrl),
	};
	const protocol: OfficialVideoTaskProtocol<HailuoTaskResponse, HailuoTaskResponse> = {
		providerName: "MiniMax Hailuo 2.3 Fast",
		baseUrl,
		submitPath: "video_generation",
		queryPath: (taskId) => `query/video_generation?task_id=${encodeURIComponent(taskId)}`,
		request,
		pollIntervalMs: 5_000,
		submitHeaders: (key) => videoJsonHeaders(key),
		queryHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
		readTaskId: (payload) => {
			assertMiniMaxSuccessCode(payload, "task submission");
			return payload.task_id;
		},
		readTask: (payload) => {
			assertMiniMaxSuccessCode(payload, "task query");
			return { status: payload.status, videoUrl: payload.video_url };
		},
		activeStatuses: ["preparing", "queueing", "processing"],
		succeededStatuses: ["success"],
		failedStatuses: ["fail", "failed", "cancelled", "canceled"],
	};
	return runOfficialVideoTask(input, fetchOptions, apiKey, protocol);
}

function createVideoUrlResolvingFetch(
	options: OfficialGenerationOptions,
	apiKey: string,
	baseUrl: string,
): typeof globalThis.fetch {
	const originalFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	const queryPath = new URL(endpoint(baseUrl, "query/video_generation")).pathname;
	return async (request: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const response = await originalFetch(request, init);
		let url: URL;
		try {
			url = new URL(request instanceof Request ? request.url : String(request));
		} catch {
			return response;
		}
		if (
			url.origin !== "https://api.minimax.io" ||
			url.pathname !== queryPath ||
			(init?.method ?? "GET").toUpperCase() !== "GET" ||
			!response.ok
		)
			return response;
		let query: HailuoTaskResponse;
		try {
			query = (await response.clone().json()) as HailuoTaskResponse;
		} catch {
			return response;
		}
		assertMiniMaxSuccessCode(query, "task query");
		if (String(query.status ?? "").toLowerCase() !== "success") return response;
		const fileId = query.file_id;
		if (
			(typeof fileId !== "string" && typeof fileId !== "number") ||
			!String(fileId).trim() ||
			!/^\d{1,20}$/u.test(String(fileId))
		) {
			throw new OfficialProviderError(
				"INVALID_PROVIDER_RESPONSE",
				"MiniMax completed the task without a valid video file ID.",
			);
		}
		const fileUrl = new URL(endpoint(baseUrl, "files/retrieve"));
		fileUrl.searchParams.set("file_id", String(fileId));
		const fileResponse = await originalFetch(fileUrl.toString(), {
			method: "GET",
			headers: { Authorization: `Bearer ${apiKey}` },
			redirect: "error",
			...(init?.signal ? { signal: init.signal } : {}),
		});
		if (fileResponse.status >= 300 && fileResponse.status < 400)
			throw new OfficialProviderError(
				"PROVIDER_REDIRECT_BLOCKED",
				"MiniMax file retrieval redirected; the API key was not forwarded.",
				fileResponse.status,
			);
		if (!fileResponse.ok)
			throw new OfficialProviderError(
				"PROVIDER_HTTP_ERROR",
				`MiniMax file retrieval failed (${fileResponse.status}).`,
				fileResponse.status,
			);
		let filePayload: {
			file?: { file_id?: string | number; purpose?: string; download_url?: string };
			base_resp?: { status_code?: number; status_msg?: string };
		};
		try {
			filePayload = (await fileResponse.json()) as typeof filePayload;
		} catch {
			throw new OfficialProviderError(
				"INVALID_PROVIDER_RESPONSE",
				"MiniMax returned an invalid file-retrieval response.",
			);
		}
		assertMiniMaxSuccessCode(filePayload, "file retrieval");
		const file = filePayload.file;
		if (
			!file ||
			String(file.file_id) !== String(fileId) ||
			file.purpose !== "video_generation" ||
			typeof file.download_url !== "string" ||
			!file.download_url.trim()
		) {
			throw new OfficialProviderError(
				"INVALID_PROVIDER_RESPONSE",
				"MiniMax file retrieval did not return the requested generated video.",
			);
		}
		return new Response(JSON.stringify({ ...query, video_url: file.download_url }), {
			status: response.status,
			headers: { "Content-Type": "application/json" },
		});
	};
}

function assertMiniMaxSuccessCode(
	payload: { base_resp?: { status_code?: number; status_msg?: string } },
	action: string,
): void {
	if (payload.base_resp?.status_code !== 0)
		throw new OfficialProviderError(
			"PROVIDER_REQUEST_FAILED",
			`MiniMax ${action} did not return base_resp.status_code 0.`,
		);
}

function collectFirstFrame(
	references: OfficialMediaReference[],
	params: Record<string, unknown>,
): OfficialMediaReference[] {
	const result: OfficialMediaReference[] = [];
	for (const reference of references) {
		if (!reference || reference.type !== "image")
			throw new OfficialProviderError("UNSUPPORTED_INPUT_MODE", "Hailuo 2.3 Fast accepts image references only.");
		appendImage(result, normalizeDataImage(reference));
	}
	const add = (value: unknown) => {
		if (value === undefined || value === null || value === "") return;
		if (typeof value !== "string")
			throw new OfficialProviderError(
				"INVALID_MEDIA_REFERENCE",
				"Hailuo image inputs must be URL or base64 strings.",
			);
		const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/iu.exec(value.trim());
		appendImage(
			result,
			normalizeDataImage(
				match
					? { type: "image", base64: match[2], mimeType: match[1].toLowerCase(), role: "first_frame" }
					: { type: "image", url: value.trim(), role: "first_frame" },
			),
		);
	};
	add(params.firstFrameUrl ?? params.first_frame ?? params.imageUrl ?? params.image_url ?? params.image);
	if (result.length > 1)
		throw new OfficialProviderError("REFERENCE_LIMIT", "Hailuo 2.3 Fast accepts exactly one starting image.");
	if (result.length === 1 && result[0].role === "last_frame")
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"Hailuo 2.3 Fast accepts a starting frame, not an ending frame.",
		);
	if (result.length === 1) result[0].role = "first_frame";
	return result;
}

function appendImage(result: OfficialMediaReference[], reference: OfficialMediaReference): void {
	const key = imageIdentity(reference);
	const existingIndex = result.findIndex((candidate) => imageIdentity(candidate) === key);
	if (existingIndex < 0) {
		result.push(reference);
		return;
	}
	const existing = result[existingIndex];
	if (
		(existing.role === "last_frame" && reference.role === "first_frame") ||
		(existing.role === "first_frame" && reference.role === "last_frame")
	) {
		throw new OfficialProviderError(
			"INVALID_MEDIA_REFERENCE",
			"Hailuo 2.3 Fast starting frame cannot also be used as a different keyframe.",
		);
	}
	if (existing.role !== "first_frame" && reference.role === "first_frame") result[existingIndex] = reference;
}

function normalizeDataImage(reference: OfficialMediaReference): OfficialMediaReference {
	if (reference.base64 || typeof reference.url !== "string") return reference;
	const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/iu.exec(reference.url.trim());
	return match ? { ...reference, url: undefined, base64: match[2], mimeType: match[1].toLowerCase() } : reference;
}

function imageIdentity(reference: OfficialMediaReference): string {
	if (reference.base64)
		return `data:${(reference.mimeType ?? "image/png").toLowerCase()}:${reference.base64.replace(/\s/gu, "")}`;
	if (typeof reference.url !== "string")
		throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", "Hailuo image reference has no data.");
	const value = reference.url.trim();
	try {
		return `url:${new URL(value).toString()}`;
	} catch {
		return `url:${value}`;
	}
}

function imageValue(reference: OfficialMediaReference): string {
	if (reference.base64) {
		const mimeType = (reference.mimeType ?? "image/jpeg").toLowerCase();
		if (!["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(mimeType))
			throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", "Hailuo image must be PNG, JPEG, JPG, or WebP.");
		const bytes = safeBase64(reference.base64, "Hailuo first-frame image");
		if (bytes.byteLength >= MAX_IMAGE_BYTES)
			throw new OfficialProviderError(
				"INVALID_MEDIA_REFERENCE",
				"Hailuo first-frame image must be smaller than 20 MB.",
			);
		return referenceValue({ base64: reference.base64, mimeType }, "Hailuo first-frame image");
	}
	if (!reference.url)
		throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", "Hailuo first-frame image is missing.");
	return referenceValue({ url: reference.url }, "Hailuo first-frame image");
}

function assertAllowedParams(params: Record<string, unknown>): void {
	const supported = new Set([
		"duration",
		"seconds",
		"resolution",
		"size",
		"prompt_optimizer",
		"promptOptimizer",
		"fast_pretreatment",
		"fastPretreatment",
		"firstFrameUrl",
		"first_frame",
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
		"audio",
		"generate_audio",
		"generateAudio",
	]);
	const unknown = Object.keys(params).find((key) => !supported.has(key));
	if (unknown)
		throw new OfficialProviderError("INVALID_INPUT", `Hailuo 2.3 Fast does not support the ${unknown} parameter.`);
	if (["audio", "generate_audio", "generateAudio"].some((key) => params[key] !== undefined)) {
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"The Hailuo API does not expose a generated-audio control through this adapter.",
		);
	}
}

function readBoolean(value: unknown, name: string, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new OfficialProviderError("INVALID_INPUT", `${name} must be a boolean.`);
	return value;
}

function appendStyleAndCamera(prompt: string, params: Record<string, unknown>): string {
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
	const fullPrompt = values.join("\n");
	if (fullPrompt.length > MAX_PROMPT_CHARS)
		throw new OfficialProviderError(
			"INVALID_INPUT",
			"Hailuo prompt with style and camera directions exceeds 2,000 characters.",
		);
	return fullPrompt;
}

function resolveMiniMaxHailuoBaseUrl(options: OfficialGenerationOptions): string {
	const configured = resolveBaseUrl(options, MINIMAX_HAILUO_VIDEO_BASE_URL, MINIMAX_HAILUO_PROVIDER_ID);
	const url = new URL(configured);
	if (
		url.protocol !== "https:" ||
		url.hostname !== "api.minimax.io" ||
		url.port ||
		url.search ||
		url.hash ||
		!["", "/", "/v1"].includes(url.pathname)
	) {
		throw new OfficialProviderError(
			"INVALID_BASE_URL",
			"Hailuo video generation requires the official MiniMax API endpoint.",
		);
	}
	return "https://api.minimax.io/v1";
}
