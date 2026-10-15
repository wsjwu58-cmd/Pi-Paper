import {
	endpoint,
	jsonHeaders,
	OfficialProviderError,
	officialJson,
	requireApiKey,
	resolveBaseUrl,
	safeBase64,
} from "./http.ts";
import type {
	OfficialGenerationInput,
	OfficialGenerationOptions,
	OfficialGenerationResult,
	OfficialMediaOutput,
} from "./types.ts";

const COMMON_IMAGE_PARAMS = [
	"operation",
	"aspect",
	"ratio",
	"aspectRatio",
	"aspect_ratio",
	"resKey",
	"resolution",
	"size",
	"count",
	"n",
	"num_images",
	"style",
	"camera",
	"referenceImages",
	"referenceUrls",
	"referenceTexts",
	"firstFrameUrl",
	"imageUrl",
	"upstreamNodeIds",
] as const;

export async function generateGptImage25(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	if (input.providerId !== "openai" || !["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"].includes(input.modelId)) {
		throw new OfficialProviderError("UNSUPPORTED_MODEL", "Choose a verified GPT-Image-2.5 Flare or Sunburst model.");
	}
	const params = input.params ?? {};
	assertParams(params, [
		...COMMON_IMAGE_PARAMS,
		"quality",
		"background",
		"output_format",
		"output_compression",
		"moderation",
	]);
	const request = normalizeCanvas(input, params);
	const operation = imageOperation(input, params);
	const references = request.references.filter((reference) => reference.role !== "mask");
	const masks = request.references.filter((reference) => reference.role === "mask");
	if (masks.length > 1)
		throw new OfficialProviderError("REFERENCE_LIMIT", "GPT-Image-2.5 accepts at most one mask image.");
	const edit = operation === "edit" || references.length > 0;
	if (operation === "edit" && references.length === 0)
		throw new OfficialProviderError("IMAGE_REQUIRED", "GPT-Image-2.5 editing requires at least one source image.");
	const count = integerAlias(params, ["count", "n", "num_images"], 1, 4) ?? 1;
	if (references.length > 16)
		throw new OfficialProviderError("REFERENCE_LIMIT", "GPT-Image-2.5 accepts at most 16 source images.");
	const size = imageSize(params);
	const quality = stringEnum(params.quality, "quality", ["auto", "low", "medium", "high", "xhigh", "max"]);
	const background = stringEnum(params.background, "background", ["auto", "transparent", "opaque"]);
	const outputFormat = stringEnum(params.output_format, "output_format", ["png", "jpeg", "webp"]);
	const moderation = stringEnum(params.moderation, "moderation", ["auto", "low"]);
	const compression = params.output_compression;
	if (
		compression !== undefined &&
		(typeof compression !== "number" || !Number.isInteger(compression) || compression < 0 || compression > 100)
	) {
		throw new OfficialProviderError(
			"INVALID_IMAGE_PARAMETER",
			"output_compression must be an integer from 0 to 100.",
		);
	}
	const body = {
		model: input.modelId,
		prompt: request.prompt,
		n: count,
		...(size ? { size } : {}),
		...(quality ? { quality } : {}),
		...(background ? { background } : {}),
		...(outputFormat ? { output_format: outputFormat } : {}),
		...(compression !== undefined ? { output_compression: compression } : {}),
		...(moderation ? { moderation } : {}),
	};
	const apiKey = requireApiKey(options, input.providerId);
	const baseUrl = resolveBaseUrl(options, "https://api.openai.com/v1", input.providerId);
	let init: RequestInit;
	if (edit) {
		const form = new FormData();
		for (const [key, value] of Object.entries(body)) form.append(key, String(value));
		for (const [index, reference] of references.entries()) {
			if (!reference.base64)
				throw new OfficialProviderError(
					"REFERENCE_UPLOAD_REQUIRED",
					"GPT-Image-2.5 edits require validated local image bytes; URL references must first be imported into the project.",
				);
			const mimeType = imageMime(reference);
			if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType))
				throw new OfficialProviderError(
					"INVALID_MEDIA_REFERENCE",
					"GPT-Image-2.5 edit references must be PNG, JPEG, or WebP.",
				);
			form.append(
				"image[]",
				new Blob([Buffer.from(safeBase64(reference.base64, `Reference image ${index + 1}`))], { type: mimeType }),
				`reference-${index + 1}.${mimeType.split("/")[1]}`,
			);
		}
		if (masks[0]) {
			if (!masks[0].base64 || imageMime(masks[0]) !== "image/png")
				throw new OfficialProviderError(
					"INVALID_MEDIA_REFERENCE",
					"GPT-Image-2.5 masks must be validated PNG bytes.",
				);
			form.append(
				"mask",
				new Blob([Buffer.from(safeBase64(masks[0].base64, "Image mask"))], { type: "image/png" }),
				"mask.png",
			);
		}
		init = { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form };
	} else {
		if (masks.length)
			throw new OfficialProviderError(
				"UNSUPPORTED_REFERENCE_ROLE",
				"Image masks require an edit request with a source image.",
			);
		init = { method: "POST", headers: jsonHeaders(apiKey), body: JSON.stringify(body) };
	}
	const response = await officialJson<{
		data?: Array<{ b64_json?: unknown; url?: unknown; output_format?: unknown }>;
		usage?: Record<string, unknown>;
	}>(endpoint(baseUrl, edit ? "images/edits" : "images/generations"), init, options, apiKey);
	const outputs: OfficialMediaOutput[] = (response.data ?? []).flatMap((item): OfficialMediaOutput[] => {
		const mimeType =
			item.output_format === "jpeg" ? "image/jpeg" : item.output_format === "webp" ? "image/webp" : "image/png";
		if (typeof item.b64_json === "string" && item.b64_json) return [{ base64: item.b64_json, mimeType }];
		if (typeof item.url === "string" && item.url) return [{ url: item.url, mimeType }];
		return [];
	});
	if (!outputs.length)
		throw new OfficialProviderError("EMPTY_PROVIDER_RESPONSE", "OpenAI returned no GPT-Image-2.5 output.");
	return { outputs, ...(response.usage ? { usage: numericUsage(response.usage) } : {}) };
}

export async function generateGrokImagine(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	if (input.providerId !== "xai" || !["grok-imagine-image", "grok-imagine-image-2.0"].includes(input.modelId))
		throw new OfficialProviderError(
			"UNSUPPORTED_MODEL",
			"This adapter implements the exact xAI Grok Imagine image model only.",
		);
	const params = input.params ?? {};
	assertParams(params, [...COMMON_IMAGE_PARAMS, "quality"]);
	const request = normalizeCanvas(input, params);
	if (request.references.length)
		throw new OfficialProviderError(
			"REFERENCE_MEDIA_UNSUPPORTED",
			"This verified Grok Imagine route is text-to-image only; image editing is not enabled here.",
		);
	const operation = imageOperation(input, params);
	if (operation === "edit")
		throw new OfficialProviderError(
			"UNSUPPORTED_OPERATION",
			"This adapter implements Grok Imagine text-to-image generation only.",
		);
	if (params.quality !== undefined && input.modelId !== "grok-imagine-image-2.0")
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_PARAMETER",
			"The xAI Grok Imagine v1 route does not expose the Grok Imagine 2.0 quality parameter.",
		);
	const count = integerAlias(params, ["count", "n", "num_images"], 1, 4) ?? 1;
	if (params.quality !== undefined && !["low", "medium", "auto"].includes(String(params.quality)))
		throw new OfficialProviderError(
			"INVALID_IMAGE_PARAMETER",
			"Grok Imagine Image 2.0 quality must be low, medium, or auto.",
		);
	const ratio = aliasString(params, ["aspect", "ratio", "aspectRatio", "aspect_ratio"]);
	if (ratio && !["1:1", "3:2", "2:3", "16:9", "9:16"].includes(ratio))
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_ASPECT_RATIO",
			`Grok Imagine does not support aspect ratio ${ratio} in this adapter.`,
		);
	const resolution = aliasString(params, ["resKey", "resolution", "size"]);
	if (resolution && !["1K", "2K", "1k", "2k"].includes(resolution))
		throw new OfficialProviderError("UNSUPPORTED_IMAGE_SIZE", "Grok Imagine resolution must be 1K or 2K.");
	const apiKey = requireApiKey(options, input.providerId);
	const baseUrl = resolveBaseUrl(options, "https://api.x.ai/v1", input.providerId);
	const response = await officialJson<{
		data?: Array<{ b64_json?: unknown; url?: unknown }>;
		usage?: Record<string, unknown>;
	}>(
		endpoint(baseUrl, "images/generations"),
		{
			method: "POST",
			headers: jsonHeaders(apiKey),
			body: JSON.stringify({
				model: input.modelId,
				prompt: request.prompt,
				n: count,
				...(ratio ? { aspect_ratio: ratio } : {}),
				...(resolution ? { resolution: resolution.toLowerCase() } : {}),
				...(params.quality !== undefined ? { quality: params.quality } : {}),
			}),
		},
		options,
		apiKey,
	);
	const outputs: OfficialMediaOutput[] = (response.data ?? []).flatMap((item): OfficialMediaOutput[] => {
		if (typeof item.b64_json === "string" && item.b64_json) return [{ base64: item.b64_json, mimeType: "image/png" }];
		if (typeof item.url === "string" && item.url) return [{ url: item.url, mimeType: "image/png" }];
		return [];
	});
	if (!outputs.length)
		throw new OfficialProviderError("EMPTY_PROVIDER_RESPONSE", "xAI returned no Grok Imagine image output.");
	return { outputs, ...(response.usage ? { usage: numericUsage(response.usage) } : {}) };
}

export async function generateAgnesFlashImage(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	if (input.providerId !== "agnes" || !["agnes-image-2.0-flash", "agnes-image-2.1-flash"].includes(input.modelId)) {
		throw new OfficialProviderError(
			"UNSUPPORTED_MODEL",
			"This adapter implements Agnes Image 2.0 Flash and 2.1 Flash only.",
		);
	}
	const params = input.params ?? {};
	assertParams(params, [...COMMON_IMAGE_PARAMS]);
	const request = normalizeCanvas(input, params);
	if (request.references.length)
		throw new OfficialProviderError(
			"REFERENCE_MEDIA_UNSUPPORTED",
			"Agnes Image 2.0/2.1 editing has not been verified; use text-to-image generation.",
		);
	if (imageOperation(input, params) === "edit")
		throw new OfficialProviderError("UNSUPPORTED_OPERATION", "Agnes Image 2.0/2.1 editing has not been verified.");
	const count = integerAlias(params, ["count", "n", "num_images"], 1, 1) ?? 1;
	const size = aliasString(params, ["size", "resKey", "resolution"]);
	if (size && !["1K", "2K", "4K", "1024x1024", "2048x2048", "4096x4096"].includes(size))
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_SIZE",
			"Agnes Image 2.0/2.1 accepts only 1K, 2K, or 4K in this adapter.",
		);
	const ratio = aliasString(params, ["aspect", "ratio", "aspectRatio", "aspect_ratio"]);
	if (ratio && !["1:1", "2:3", "3:2", "9:16", "16:9"].includes(ratio))
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_ASPECT_RATIO",
			`Agnes Image 2.0/2.1 does not support ${ratio} in this adapter.`,
		);
	const apiKey = requireApiKey(options, input.providerId);
	const baseUrl = resolveBaseUrl(options, "https://apihub.agnes-ai.com/v1", input.providerId);
	const response = await officialJson<{
		data?: Array<{ b64_json?: unknown; url?: unknown }>;
		usage?: Record<string, unknown>;
	}>(
		endpoint(baseUrl, "images/generations"),
		{
			method: "POST",
			headers: jsonHeaders(apiKey),
			body: JSON.stringify({
				model: input.modelId,
				prompt: request.prompt,
				n: count,
				...(size ? { size } : {}),
				...(ratio ? { ratio } : {}),
				extra_body: { response_format: "url" },
			}),
		},
		options,
		apiKey,
	);
	const outputs: OfficialMediaOutput[] = (response.data ?? []).flatMap((item): OfficialMediaOutput[] => {
		if (typeof item.b64_json === "string" && item.b64_json) return [{ base64: item.b64_json, mimeType: "image/png" }];
		if (typeof item.url === "string" && item.url) return [{ url: item.url, mimeType: "image/png" }];
		return [];
	});
	if (!outputs.length) throw new OfficialProviderError("EMPTY_PROVIDER_RESPONSE", "Agnes returned no image output.");
	return { outputs, ...(response.usage ? { usage: numericUsage(response.usage) } : {}) };
}

function normalizeCanvas(
	input: OfficialGenerationInput,
	params: Record<string, unknown>,
): { prompt: string; references: NonNullable<OfficialGenerationInput["references"]> } {
	const notes = [
		textParam(params, "style") ? `Style: ${textParam(params, "style")}` : undefined,
		textParam(params, "camera") ? `Camera or framing: ${textParam(params, "camera")}` : undefined,
		...(stringList(params.referenceTexts, "referenceTexts", 32).length
			? [
					`Reference descriptions:\n${stringList(params.referenceTexts, "referenceTexts", 32)
						.map((text) => `- ${text}`)
						.join("\n")}`,
				]
			: []),
	].filter((item): item is string => Boolean(item));
	const references = [...(input.references ?? [])];
	const seen = new Set(
		references.map((reference) =>
			reference.url ? `url:${reference.url}` : reference.base64 ? `base64:${reference.base64}` : "",
		),
	);
	for (const key of ["referenceImages", "referenceUrls", "firstFrameUrl", "imageUrl"]) {
		for (const value of stringList(params[key], key, 16)) {
			const reference = parseReference(value, key);
			const identity = reference.url ? `url:${reference.url}` : `base64:${reference.base64}`;
			if (!seen.has(identity)) {
				references.push(reference);
				seen.add(identity);
			}
		}
	}
	if (
		params.upstreamNodeIds !== undefined &&
		(!Array.isArray(params.upstreamNodeIds) ||
			params.upstreamNodeIds.length > 32 ||
			params.upstreamNodeIds.some((value) => typeof value !== "string" || !value.trim()))
	) {
		throw new OfficialProviderError(
			"INVALID_IMAGE_PARAMETER",
			"upstreamNodeIds must be an array of at most 32 non-empty strings.",
		);
	}
	return { prompt: [input.prompt.trim(), ...notes].filter(Boolean).join("\n"), references };
}

function parseReference(value: string, label: string): NonNullable<OfficialGenerationInput["references"]>[number] {
	const data = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/iu.exec(value);
	if (data)
		return {
			type: "image",
			mimeType: data[1].toLowerCase(),
			base64: Buffer.from(safeBase64(data[2], label)).toString("base64"),
			role: "object",
		};
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new OfficialProviderError(
			"INVALID_MEDIA_REFERENCE",
			`${label} must be a public HTTPS URL or image data URI.`,
		);
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.hostname === "localhost" ||
		url.hostname.endsWith(".local")
	)
		throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", `${label} must use a public HTTPS URL.`);
	return { type: "image", url: url.toString(), role: "object" };
}

function imageOperation(
	input: OfficialGenerationInput,
	params: Record<string, unknown>,
): "generation" | "edit" | undefined {
	const value = params.operation ?? input.operation;
	if (params.operation !== undefined && input.operation && params.operation !== input.operation)
		throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", "Conflicting image operations were supplied.");
	if (value !== undefined && value !== "generation" && value !== "edit")
		throw new OfficialProviderError("UNSUPPORTED_OPERATION", `Image operation ${String(value)} is not supported.`);
	return value as "generation" | "edit" | undefined;
}

function assertParams(params: Record<string, unknown>, allowed: readonly string[]): void {
	const unknown = Object.keys(params).find((key) => !allowed.includes(key));
	if (unknown)
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_PARAMETER",
			`This image adapter does not implement parameter ${unknown}.`,
		);
}

function textParam(params: Record<string, unknown>, key: string): string | undefined {
	const value = params[key];
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", `${key} must be text.`);
	return value.trim();
}

function stringList(value: unknown, key: string, maximum: number): string[] {
	if (value === undefined || value === null || value === "") return [];
	const values = Array.isArray(value) ? value : [value];
	if (values.length > maximum || values.some((item) => typeof item !== "string" || !item.trim()))
		throw new OfficialProviderError(
			"INVALID_IMAGE_PARAMETER",
			`${key} must contain at most ${maximum} non-empty strings.`,
		);
	return values.map((item) => (item as string).trim());
}

function aliasString(params: Record<string, unknown>, keys: string[]): string | undefined {
	const values = keys.filter((key) => params[key] !== undefined && params[key] !== "").map((key) => params[key]);
	if (values.some((value) => typeof value !== "string") || new Set(values).size > 1)
		throw new OfficialProviderError(
			"INVALID_IMAGE_PARAMETER",
			`${keys[0]} aliases must have one consistent text value.`,
		);
	return values[0] as string | undefined;
}

function integerAlias(
	params: Record<string, unknown>,
	keys: string[],
	minimum: number,
	maximum: number,
): number | undefined {
	const values = keys.filter((key) => params[key] !== undefined).map((key) => params[key]);
	if (values.some((value) => typeof value !== "number" || !Number.isInteger(value)) || new Set(values).size > 1)
		throw new OfficialProviderError(
			"INVALID_IMAGE_PARAMETER",
			`${keys[0]} aliases must have one consistent integer value.`,
		);
	const value = values[0] as number | undefined;
	if (value !== undefined && (value < minimum || value > maximum))
		throw new OfficialProviderError("INVALID_IMAGE_COUNT", `Image count must be from ${minimum} to ${maximum}.`);
	return value;
}

function stringEnum<T extends string>(value: unknown, name: string, values: readonly T[]): T | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !values.includes(value as T))
		throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", `${name} must be one of ${values.join(", ")}.`);
	return value as T;
}

function imageSize(params: Record<string, unknown>): string | undefined {
	const raw = aliasString(params, ["size", "resKey", "resolution"]);
	const ratio = aliasString(params, ["aspect", "ratio", "aspectRatio", "aspect_ratio"]);
	if (raw === undefined) return undefined;
	if (raw.toLowerCase() === "auto") return "auto";
	if (/^[12]k$/iu.test(raw)) {
		const [width, height] = parseRatio(ratio ?? "1:1");
		const area = raw.toLowerCase() === "1k" ? 1_048_576 : 4_194_304;
		return fitOpenAiDimensions(width, height, area);
	}
	const match = /^(\d{2,4})x(\d{2,4})$/iu.exec(raw);
	if (!match)
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_SIZE",
			"GPT-Image-2.5 size must be auto, 1K, 2K, or validated WxH dimensions.",
		);
	const width = Number(match[1]);
	const height = Number(match[2]);
	if (
		width % 16 ||
		height % 16 ||
		Math.max(width, height) > 3840 ||
		width / height < 1 / 3 ||
		width / height > 3 ||
		width * height < 655_360 ||
		width * height > 8_294_400
	) {
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_SIZE",
			"GPT-Image-2.5 dimensions must meet the documented multiple-of-16, size, and aspect-ratio bounds.",
		);
	}
	if (ratio) {
		const [ratioWidth, ratioHeight] = parseRatio(ratio);
		if (Math.abs(width / height - ratioWidth / ratioHeight) > 0.015)
			throw new OfficialProviderError(
				"IMAGE_SIZE_RATIO_MISMATCH",
				"Image size conflicts with the requested aspect ratio.",
			);
	}
	return `${width}x${height}`;
}

function parseRatio(value: string): [number, number] {
	const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/u.exec(value);
	if (!match || Number(match[2]) === 0)
		throw new OfficialProviderError("UNSUPPORTED_IMAGE_ASPECT_RATIO", `Invalid aspect ratio ${value}.`);
	const width = Number(match[1]);
	const height = Number(match[2]);
	if (width / height < 1 / 3 || width / height > 3)
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_ASPECT_RATIO",
			"GPT-Image-2.5 aspect ratio must be from 1:3 to 3:1.",
		);
	return [width, height];
}

function fitOpenAiDimensions(ratioWidth: number, ratioHeight: number, area: number): string {
	const multiplier = Math.sqrt(area / (ratioWidth * ratioHeight));
	const width = Math.round((ratioWidth * multiplier) / 16) * 16;
	const height = Math.round((ratioHeight * multiplier) / 16) * 16;
	if (Math.max(width, height) > 3840 || width * height < 655_360 || width * height > 8_294_400)
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_SIZE",
			"The requested image size exceeds documented GPT-Image-2.5 bounds.",
		);
	return `${width}x${height}`;
}

function imageMime(reference: { base64?: string; mimeType?: string }): string {
	const embedded = reference.base64?.match(/^data:([^;,]+);base64,/iu)?.[1];
	if (embedded && reference.mimeType && embedded.toLowerCase() !== reference.mimeType.toLowerCase())
		throw new OfficialProviderError(
			"INVALID_MEDIA_REFERENCE",
			"Reference image MIME type conflicts with its data URI.",
		);
	return (reference.mimeType ?? embedded ?? "image/png").toLowerCase();
}

function numericUsage(value: Record<string, unknown>): Record<string, number> {
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
		),
	);
}
