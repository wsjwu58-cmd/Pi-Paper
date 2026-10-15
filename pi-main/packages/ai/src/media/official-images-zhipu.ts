import { endpoint, jsonHeaders, OfficialProviderError, officialJson, requireApiKey, resolveBaseUrl } from "./http.ts";
import type { OfficialGenerationInput, OfficialGenerationOptions, OfficialGenerationResult } from "./types.ts";

export const ZHIPU_IMAGE_MODEL_IDS = ["glm-image", "cogview-4-250304", "cogview-4", "cogview-3-flash"] as const;
export const ZHIPU_IMAGE_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";

interface ZhipuImageResponse {
	data?: Array<{ url?: unknown }>;
}

/** Text-to-image for the exact model IDs published by Zhipu's image API. */
export async function generateZhipuImage(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	const request = buildZhipuImageRequest(input);
	const apiKey = requireApiKey(options, "zhipu");
	const baseUrl = resolveBaseUrl(options, ZHIPU_IMAGE_BASE_URL, "zhipu");
	const response = await officialJson<ZhipuImageResponse>(
		endpoint(baseUrl, "images/generations"),
		{ method: "POST", headers: jsonHeaders(apiKey), body: JSON.stringify(request) },
		options,
		apiKey,
	);
	const outputs = (response.data ?? []).flatMap((item) => {
		if (typeof item.url !== "string" || !item.url.trim()) return [];
		let url: URL;
		try {
			url = new URL(item.url);
		} catch {
			throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "Zhipu returned an invalid image URL.");
		}
		if (url.protocol !== "https:")
			throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "Zhipu returned a non-HTTPS image URL.");
		return [{ url: url.toString(), mimeType: "image/png" }];
	});
	if (outputs.length === 0)
		throw new OfficialProviderError("EMPTY_PROVIDER_RESPONSE", "Zhipu returned no generated image URL.");
	return { outputs };
}

export interface ZhipuImageRequest {
	model: (typeof ZHIPU_IMAGE_MODEL_IDS)[number];
	prompt: string;
	size: string;
	quality: "hd" | "standard";
	watermark_enabled: true;
}

export function buildZhipuImageRequest(input: OfficialGenerationInput): ZhipuImageRequest {
	if (
		input.providerId !== "zhipu" ||
		input.modality !== "image" ||
		!(ZHIPU_IMAGE_MODEL_IDS as readonly string[]).includes(input.modelId)
	) {
		throw new OfficialProviderError("MODEL_UNAVAILABLE", "The configured Zhipu image model is unavailable.");
	}
	if (input.operation !== undefined && input.operation !== "generation")
		throw new OfficialProviderError(
			"UNSUPPORTED_OPERATION",
			"Zhipu image models are enabled for text-to-image generation only.",
		);
	if (input.remoteTaskId !== undefined)
		throw new OfficialProviderError(
			"UNSUPPORTED_OPERATION",
			"Zhipu image generation does not use asynchronous task IDs.",
		);
	if (input.references?.length)
		throw new OfficialProviderError(
			"UNSUPPORTED_INPUT_MODE",
			"The configured Zhipu image models accept text input only.",
		);

	const params = input.params ?? {};
	if (!params || typeof params !== "object" || Array.isArray(params))
		throw new OfficialProviderError("INVALID_INPUT", "Zhipu image parameters must be an object.");
	const allowed = new Set([
		"operation",
		"size",
		"quality",
		"watermark_enabled",
		"style",
		"camera",
		"cameraMovement",
		"ratio",
		"count",
	]);
	const unknown = Object.keys(params).find((key) => !allowed.has(key));
	if (unknown)
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_PARAMETER",
			`Zhipu image generation does not implement parameter ${unknown}.`,
		);
	if (params.watermark_enabled !== undefined && params.watermark_enabled !== true)
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_PARAMETER",
			"Zhipu watermark removal requires a signed provider disclaimer; this adapter keeps the official watermark enabled.",
		);

	let prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
	for (const [key, label] of [
		["style", "Style"],
		["camera", "Camera movement"],
		["cameraMovement", "Camera movement"],
	] as const) {
		const value = params[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || !value.trim())
			throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", `${label} must be non-empty text.`);
		if (key === "cameraMovement" && params.camera !== undefined) continue;
		prompt += `${prompt ? "\n" : ""}${label}: ${value.trim()}`;
	}
	if (!prompt) throw new OfficialProviderError("INVALID_INPUT", "Zhipu image generation requires a text prompt.");
	if (input.modelId === "glm-image" && [...prompt].length > 1000)
		throw new OfficialProviderError("INVALID_INPUT", "GLM-Image prompts must contain at most 1,000 characters.");
	if ([...prompt].length > 10_000)
		throw new OfficialProviderError("INVALID_INPUT", "Zhipu image prompts must contain at most 10,000 characters.");

	const quality = params.quality ?? (input.modelId === "glm-image" ? "hd" : "standard");
	if (quality !== "hd" && quality !== "standard")
		throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", "Zhipu image quality must be hd or standard.");
	if (input.modelId === "glm-image" && quality !== "hd")
		throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", "GLM-Image only supports hd quality.");

	const size = params.size ?? (input.modelId === "glm-image" ? "1280x1280" : "1024x1024");
	if (typeof size !== "string")
		throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", "Zhipu image size must be text.");
	validateZhipuImageSize(input.modelId, size);
	if (params.count !== undefined && params.count !== 1)
		throw new OfficialProviderError(
			"INVALID_IMAGE_PARAMETER",
			"Zhipu image generation supports one output per request.",
		);
	if (params.ratio !== undefined) {
		const ratio = typeof params.ratio === "string" ? /^(\d+):(\d+)$/u.exec(params.ratio) : null;
		const [width, height] = size.split("x").map(Number);
		if (
			!ratio ||
			Number(ratio[1]) <= 0 ||
			Number(ratio[2]) <= 0 ||
			width * Number(ratio[2]) !== height * Number(ratio[1])
		)
			throw new OfficialProviderError(
				"INVALID_IMAGE_PARAMETER",
				"The selected Zhipu size does not match its aspect ratio.",
			);
	}
	return { model: input.modelId as ZhipuImageRequest["model"], prompt, size, quality, watermark_enabled: true };
}

function validateZhipuImageSize(modelId: string, size: string): void {
	const match = /^(\d{3,4})x(\d{3,4})$/u.exec(size.trim());
	if (!match)
		throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", "Zhipu image size must use WIDTHxHEIGHT format.");
	const width = Number(match[1]);
	const height = Number(match[2]);
	const isGlmImage = modelId === "glm-image";
	const multiple = isGlmImage ? 32 : 16;
	const maximumPixels = isGlmImage ? 2 ** 22 : 2 ** 21;
	const minimum = isGlmImage ? 1024 : 512;
	if (
		width < minimum ||
		height < minimum ||
		width > 2048 ||
		height > 2048 ||
		width % multiple !== 0 ||
		height % multiple !== 0 ||
		width * height > maximumPixels
	)
		throw new OfficialProviderError(
			"INVALID_IMAGE_PARAMETER",
			isGlmImage
				? "GLM-Image dimensions must be 1024–2048 pixels, multiples of 32, and within 2^22 pixels."
				: "CogView dimensions must be 512–2048 pixels, multiples of 16, and within 2^21 pixels.",
		);
}
