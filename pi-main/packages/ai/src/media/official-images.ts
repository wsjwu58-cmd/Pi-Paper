import { registerImagesApiProvider } from "../images-api-registry.ts";
import type {
	ImageContent,
	ImagesContext,
	ImagesFunction,
	ImagesModel,
	ImagesOptions,
	TextContent,
	Usage,
} from "../types.ts";
import {
	endpoint,
	jsonHeaders,
	OfficialProviderError,
	officialJson,
	pickString,
	referenceValue,
	requireApiKey,
	resolveBaseUrl,
	safeBase64,
} from "./http.ts";
import { generateAgnesFlashImage, generateGptImage25, generateGrokImagine } from "./official-images-next-models.ts";
import { generateZhipuImage } from "./official-images-zhipu.ts";
import type {
	OfficialGenerationInput,
	OfficialGenerationOptions,
	OfficialGenerationResult,
	OfficialMediaOutput,
} from "./types.ts";

const OPENAI_IMAGE_API = "official-images";

export async function generateOfficialImage(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	switch (input.providerId) {
		case "zhipu":
			return generateZhipuImage(input, options);
		case "openai":
			if (["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"].includes(input.modelId))
				return generateGptImage25(input, options);
			return generateOpenAiImage(input, options);
		case "xai":
			return generateGrokImagine(input, options);
		case "agnes":
			if (["agnes-image-2.0-flash", "agnes-image-2.1-flash"].includes(input.modelId))
				return generateAgnesFlashImage(input, options);
			throw new OfficialProviderError(
				"UNSUPPORTED_MODEL",
				`No verified Agnes image protocol is registered for ${input.modelId}.`,
			);
		case "google":
			return generateGoogleImage(input, options);
		case "volcengine":
		case "byteplus":
		case "doubao":
			return generateArkImage(input, options);
		case "alibaba":
			return generateAlibabaImage(input, options);
		default:
			throw new OfficialProviderError(
				"UNSUPPORTED_PROVIDER",
				`Official image generation is not implemented for ${input.providerId}.`,
			);
	}
}

async function generateOpenAiImage(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	const apiKey = requireApiKey(options, input.providerId);
	const baseUrl = resolveBaseUrl(options, "https://api.openai.com/v1", input.providerId);
	const params = input.params ?? {};
	assertOnlyParams(params, [
		"operation",
		"aspect",
		"ratio",
		"aspectRatio",
		"aspect_ratio",
		"resKey",
		"resolution",
		"size",
		"count",
		"style",
		"camera",
		"referenceImages",
		"referenceUrls",
		"referenceTexts",
		"firstFrameUrl",
		"imageUrl",
		"upstreamNodeIds",
		"n",
		"num_images",
		"quality",
		"background",
		"output_format",
		"output_compression",
		"moderation",
	]);
	const canvas = normalizeCanvasImageInput(input, params);
	const refs = (canvas.references ?? []).filter(
		(reference) => reference.type === "image" && reference.role !== "mask",
	);
	const requestedOperation = requestedImageOperation(input, params);
	if (requestedOperation && !["generation", "edit"].includes(requestedOperation)) {
		throw new OfficialProviderError(
			"UNSUPPORTED_OPERATION",
			`OpenAI GPT image models do not support the requested operation: ${requestedOperation}.`,
		);
	}
	// A supplied image reference selects the verified edit endpoint even when a
	// generic job operation was labeled "generation" by the caller.
	const edit = requestedOperation === "edit" || refs.length > 0;
	const n = imageCount(params);
	if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 4)) {
		throw new OfficialProviderError(
			"INVALID_IMAGE_PARAMETER",
			"Image count must be an integer from 1 to 4 in the desktop pipeline.",
		);
	}
	if (refs.length > 16)
		throw new OfficialProviderError("REFERENCE_LIMIT", "GPT-Image-2 accepts at most 16 image references.");
	if (params.input_fidelity !== undefined)
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_PARAMETER",
			"input_fidelity is not supported by the configured GPT-Image-2 adapter.",
		);
	const size = openAiImageSize(params);
	const url = endpoint(baseUrl, edit ? "images/edits" : "images/generations");
	const common = {
		model: input.modelId,
		prompt: canvas.prompt,
		...(n !== undefined ? { n } : {}),
		...(size ? { size } : {}),
		...(enumParam(params, "quality", ["auto", "low", "medium", "high"])
			? { quality: enumParam(params, "quality", ["auto", "low", "medium", "high"]) }
			: {}),
		...(enumParam(params, "background", ["auto", "transparent", "opaque"])
			? { background: enumParam(params, "background", ["auto", "transparent", "opaque"]) }
			: {}),
		...(enumParam(params, "output_format", ["png", "jpeg", "webp"])
			? { output_format: enumParam(params, "output_format", ["png", "jpeg", "webp"]) }
			: {}),
		...(numberParam(params, "output_compression") !== undefined
			? { output_compression: validatedCompression(params) }
			: {}),
		...(enumParam(params, "moderation", ["auto", "low"])
			? { moderation: enumParam(params, "moderation", ["auto", "low"]) }
			: {}),
	};
	let init: RequestInit;
	if (edit) {
		if (refs.length === 0)
			throw new OfficialProviderError("IMAGE_REQUIRED", "Image editing requires at least one reference image.");
		const form = new FormData();
		for (const [key, value] of Object.entries(common)) {
			if (value !== undefined) form.append(key, String(value));
		}
		for (const [index, reference] of refs.entries()) {
			if (!reference.base64) {
				throw new OfficialProviderError(
					"REFERENCE_UPLOAD_REQUIRED",
					"OpenAI image editing requires reference image bytes; remote URL references must be downloaded into the project before submission.",
				);
			}
			const mimeType = reference.mimeType ?? "image/png";
			if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
				throw new OfficialProviderError(
					"INVALID_MEDIA_REFERENCE",
					`Reference image ${index + 1} must be PNG, JPEG, or WebP.`,
				);
			}
			const bytes = safeBase64(reference.base64, `Reference image ${index + 1}`);
			const ext = mimeType.split("/")[1]?.replace(/[^a-z0-9]/giu, "") || "png";
			form.append("image[]", new Blob([Buffer.from(bytes)], { type: mimeType }), `reference-${index + 1}.${ext}`);
		}
		const mask = input.references?.find((reference) => reference.type === "image" && reference.role === "mask");
		if (mask) {
			if (!mask.base64)
				throw new OfficialProviderError(
					"REFERENCE_UPLOAD_REQUIRED",
					"OpenAI masks must be supplied as validated base64 media.",
				);
			const mimeType = mask.mimeType ?? "image/png";
			if (mimeType !== "image/png")
				throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", "OpenAI image masks must be PNG.");
			form.append(
				"mask",
				new Blob([Buffer.from(safeBase64(mask.base64, "Image mask"))], { type: mimeType }),
				`mask.${mimeType.split("/")[1] ?? "png"}`,
			);
		}
		init = { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form };
	} else {
		init = { method: "POST", headers: jsonHeaders(apiKey), body: JSON.stringify(common) };
	}
	const response = await officialJson<OpenAiImageResponse>(url, init, options, apiKey);
	const outputs = (response.data ?? []).flatMap((item): OfficialMediaOutput[] => {
		if (typeof item.b64_json === "string" && item.b64_json.length > 0) {
			return [{ base64: item.b64_json, mimeType: outputMime(input.params, item.output_format) }];
		}
		if (typeof item.url === "string" && item.url.length > 0)
			return [{ url: item.url, mimeType: outputMime(input.params, item.output_format) }];
		return [];
	});
	if (outputs.length === 0)
		throw new OfficialProviderError("EMPTY_PROVIDER_RESPONSE", "The image provider returned no image output.");
	return { outputs, usage: numericRecord(response.usage) };
}

function openAiImageSize(params: Record<string, unknown>): string | undefined {
	const raw = aliasedString(params, "resolution", "resKey", "resolution", "size");
	const ratio = aliasedString(params, "aspect ratio", "aspect", "ratio", "aspectRatio", "aspect_ratio");
	const ratioSizes: Record<string, string> = { "1:1": "1024x1024", "2:3": "1024x1536", "3:2": "1536x1024" };
	const oneKResolutionHint = raw?.toUpperCase() === "1K";
	if (ratio && !ratioSizes[ratio]) {
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_ASPECT_RATIO",
			`OpenAI GPT image models do not support the requested aspect ratio: ${ratio}.`,
		);
	}
	let size: string | undefined;
	if (raw) {
		const aliases: Record<string, string> = {
			"1K": "1024x1024",
			"1024X1024": "1024x1024",
			"1024X1536": "1024x1536",
			"1536X1024": "1536x1024",
			AUTO: "auto",
		};
		size = aliases[raw.toUpperCase()];
		if (!size) {
			if (/^[234]K$/iu.test(raw))
				throw new OfficialProviderError(
					"UNSUPPORTED_IMAGE_SIZE",
					"This GPT-Image-2 adapter currently supports only its validated 1K size subset; choose 1K or auto.",
				);
			throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", `Unsupported OpenAI image size: ${raw}.`);
		}
	}
	if (ratio) {
		const ratioSize = ratioSizes[ratio];
		if (size && size !== "auto" && size !== ratioSize && !oneKResolutionHint) {
			throw new OfficialProviderError(
				"IMAGE_SIZE_RATIO_MISMATCH",
				"The requested size conflicts with the selected aspect ratio.",
			);
		}
		size = ratioSize;
	}
	return size;
}

function enumParam<T extends string>(
	params: Record<string, unknown>,
	key: string,
	allowed: readonly T[],
): T | undefined {
	const value = params[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", `${key} must be one of: ${allowed.join(", ")}.`);
	}
	return value as T;
}

function validatedCompression(params: Record<string, unknown>): number {
	const value = params.output_compression;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
		throw new OfficialProviderError(
			"INVALID_IMAGE_PARAMETER",
			"Image output compression must be an integer from 0 to 100.",
		);
	}
	return value;
}

async function generateGoogleImage(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	const model = googleImageModel(input.modelId);
	const apiKey = requireApiKey(options, input.providerId);
	const baseUrl = resolveBaseUrl(options, "https://generativelanguage.googleapis.com/v1beta", input.providerId);
	const params = input.params ?? {};
	assertOnlyParams(params, [
		"operation",
		"aspect",
		"aspect_ratio",
		"aspectRatio",
		"ratio",
		"image_size",
		"imageSize",
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
		"mime_type",
		"mimeType",
		"output_format",
	]);
	const canvas = normalizeCanvasImageInput(input, params);
	const normalizedInput = { ...input, prompt: canvas.prompt, references: canvas.references };
	const operation = requestedImageOperation(input, params);
	const refs = imageReferences(normalizedInput, model.maximumReferences, [
		"image/png",
		"image/jpeg",
		"image/webp",
		"image/heic",
		"image/heif",
	]);
	if (operation === "edit" && refs.length === 0)
		throw new OfficialProviderError("IMAGE_REQUIRED", "Google image editing requires at least one reference image.");
	validateGoogleReferenceRoles(refs, model);
	const parts: Array<Record<string, unknown>> = [{ type: "text", text: canvas.prompt }];
	for (const [index, reference] of refs.entries()) {
		if (!reference.base64)
			throw new OfficialProviderError(
				"REFERENCE_UPLOAD_REQUIRED",
				"Google Interactions image input requires validated base64 image bytes.",
			);
		const mimeType = referenceMimeType(reference);
		parts.push({
			type: "image",
			mime_type: mimeType,
			data: Buffer.from(safeBase64(reference.base64, `Reference image ${index + 1}`)).toString("base64"),
		});
	}
	const aspectRatio = aliasedString(params, "aspect ratio", "aspect", "aspect_ratio", "aspectRatio", "ratio");
	const imageSize = aliasedString(params, "image size", "image_size", "imageSize", "resKey", "resolution", "size");
	const count = imageCount(params);
	if (count !== undefined && count !== 1)
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_COUNT",
			"Google Interactions image generation returns one image per request.",
		);
	const requestedMimeType = aliasedString(params, "output MIME type", "mime_type", "mimeType");
	const formatMimeType = outputFormatMime(params.output_format);
	if (requestedMimeType && formatMimeType && requestedMimeType !== formatMimeType) {
		throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", "mime_type conflicts with output_format.");
	}
	const mimeType = requestedMimeType ?? formatMimeType;
	if (mimeType && !["image/png", "image/jpeg"].includes(mimeType)) {
		throw new OfficialProviderError(
			"INVALID_IMAGE_PARAMETER",
			"Google image output MIME type must be image/png or image/jpeg.",
		);
	}
	if (aspectRatio && !model.aspectRatios.includes(aspectRatio)) {
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_ASPECT_RATIO",
			`${input.modelId} does not support aspect ratio ${aspectRatio}.`,
		);
	}
	if (imageSize && !model.imageSizes.includes(imageSize)) {
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_SIZE",
			`${input.modelId} does not support image size ${imageSize}.`,
		);
	}
	const payload = {
		model: input.modelId,
		input: parts,
		response_format: {
			type: "image",
			...(mimeType ? { mime_type: mimeType } : {}),
			...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
			...(imageSize ? { image_size: imageSize } : {}),
		},
	};
	const requestBody = JSON.stringify(payload);
	if (Buffer.byteLength(requestBody, "utf8") > 20 * 1024 * 1024) {
		throw new OfficialProviderError(
			"REFERENCE_LIMIT",
			"Google inline image requests, including prompt and JSON encoding, must not exceed 20 MB.",
		);
	}
	const response = await officialJson<GoogleInteractionResponse>(
		endpoint(baseUrl, "interactions"),
		{ method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey }, body: requestBody },
		options,
		apiKey,
	);
	const outputs: OfficialMediaOutput[] = [];
	const texts: string[] = [];
	for (const step of response.steps ?? []) {
		if (step.type !== "model_output") continue;
		for (const content of step.content ?? []) {
			if (content.type === "text" && typeof content.text === "string") texts.push(content.text);
			if (content.type === "image" && typeof content.data === "string" && content.data.length > 0) {
				outputs.push({ base64: content.data, mimeType: content.mime_type ?? "image/png" });
			}
		}
	}
	if (outputs.length === 0 && response.output_image?.data) {
		outputs.push({ base64: response.output_image.data, mimeType: response.output_image.mime_type ?? "image/png" });
	}
	if (texts.length === 0 && typeof response.output_text === "string") texts.push(response.output_text);
	if (outputs.length === 0)
		throw new OfficialProviderError("EMPTY_PROVIDER_RESPONSE", "Google returned no generated image.");
	return { ...(texts.length ? { text: texts.join("\n") } : {}), outputs, usage: numericRecord(response.usage) };
}

async function generateArkImage(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	const model = arkImageModel(input.modelId);
	const apiKey = requireApiKey(options, input.providerId);
	const fallback =
		input.providerId === "byteplus"
			? "https://ark.ap-southeast.bytepluses.com/api/v3"
			: "https://ark.cn-beijing.volces.com/api/v3";
	const baseUrl = resolveBaseUrl(options, fallback, input.providerId);
	const params = input.params ?? {};
	assertOnlyParams(params, [
		"operation",
		"aspect",
		"ratio",
		"aspectRatio",
		"aspect_ratio",
		"resKey",
		"size",
		"resolution",
		"style",
		"camera",
		"referenceImages",
		"referenceUrls",
		"referenceTexts",
		"firstFrameUrl",
		"imageUrl",
		"upstreamNodeIds",
		"output_format",
		"outputFormat",
		"response_format",
		"responseFormat",
		"watermark",
		"sequential_image_generation",
		"sequential_image_generation_options",
		"n",
		"count",
		"num_images",
	]);
	const canvas = normalizeCanvasImageInput(input, params);
	const normalizedInput = { ...input, prompt: canvas.prompt, references: canvas.references };
	const refs = imageReferences(
		normalizedInput,
		model.maximumReferences,
		["image/png", "image/jpeg", "image/webp", "image/bmp", "image/tiff", "image/gif", "image/heic", "image/heif"],
		30 * 1024 * 1024,
	);
	const operation = requestedImageOperation(input, params);
	if (operation === "edit" && refs.length === 0)
		throw new OfficialProviderError(
			"IMAGE_REQUIRED",
			"Seedream image editing requires at least one reference image.",
		);
	const images = refs.map((reference, index) => referenceValue(reference, `Reference image ${index + 1}`));
	const aspectRatio = aliasedString(params, "aspect ratio", "aspect", "ratio", "aspectRatio", "aspect_ratio");
	const requestedSize = aliasedString(params, "image size", "resKey", "resolution", "size");
	const size = seedreamSizeForAspect(requestedSize, aspectRatio, model);
	validateSeedreamSize(size, model);
	const n = imageCount(params);
	const sequential = params.sequential_image_generation;
	if (sequential !== undefined && sequential !== "auto" && sequential !== "disabled") {
		throw new OfficialProviderError(
			"INVALID_IMAGE_PARAMETER",
			"sequential_image_generation must be auto or disabled.",
		);
	}
	if (model.kind === "pro" && sequential !== undefined)
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_PARAMETER",
			"Seedream 5.0 Pro does not support sequential image generation.",
		);
	const sequentialOptions = validateSequentialOptions(params.sequential_image_generation_options, refs.length, model);
	if (model.kind === "pro" && sequentialOptions)
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_PARAMETER",
			"Seedream 5.0 Pro does not support sequential image generation options.",
		);
	if (model.kind === "pro" && n !== undefined && n !== 1)
		throw new OfficialProviderError("UNSUPPORTED_IMAGE_COUNT", "Seedream 5.0 Pro generates one image per request.");
	if (model.kind === "lite" && n !== undefined && n !== 1 && sequential !== "auto") {
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_COUNT",
			"Seedream 5.0 Lite requires sequential_image_generation=auto for multiple images.",
		);
	}
	const outputFormat = aliasedString(params, "output format", "output_format", "outputFormat");
	if (outputFormat !== undefined && !["png", "jpeg"].includes(outputFormat))
		throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", "Seedream output_format must be png or jpeg.");
	if (outputFormat && model.kind === "lite")
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_PARAMETER",
			"Seedream 5.0 Lite does not document output_format support.",
		);
	const responseFormat = aliasedString(params, "response format", "response_format", "responseFormat") ?? "b64_json";
	if (responseFormat !== "url" && responseFormat !== "b64_json")
		throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", "Seedream response_format must be url or b64_json.");
	const watermark = booleanParam(params, "watermark");
	const body: Record<string, unknown> = {
		model: input.modelId,
		prompt: canvas.prompt,
		...(images.length === 1 ? { image: images[0] } : images.length > 1 ? { image: images } : {}),
		...(size ? { size } : {}),
		...(outputFormat ? { output_format: outputFormat } : {}),
		response_format: responseFormat,
		...(watermark !== undefined ? { watermark } : {}),
		stream: false,
	};
	if (model.kind === "lite") {
		body.sequential_image_generation = sequential ?? "disabled";
		if (sequential === "auto") {
			const maxImages = n ?? sequentialOptions?.max_images ?? 1;
			if (sequentialOptions?.max_images !== undefined && n !== undefined && sequentialOptions.max_images !== n) {
				throw new OfficialProviderError(
					"INVALID_IMAGE_PARAMETER",
					"n and sequential_image_generation_options.max_images must match.",
				);
			}
			if (refs.length + maxImages > 15)
				throw new OfficialProviderError(
					"REFERENCE_LIMIT",
					"Seedream group output plus input references must not exceed 15 images.",
				);
			body.sequential_image_generation_options = { max_images: maxImages };
		} else if (sequentialOptions || (n !== undefined && n !== 1)) {
			throw new OfficialProviderError(
				"UNSUPPORTED_IMAGE_PARAMETER",
				"Seedream Lite sequential image options require sequential_image_generation=auto.",
			);
		}
	} else if (sequentialOptions) {
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_PARAMETER",
			"Seedream 5.0 Pro does not support sequential image generation options.",
		);
	}
	const response = await officialJson<ArkImageResponse>(
		endpoint(baseUrl, "images/generations"),
		{ method: "POST", headers: jsonHeaders(apiKey), body: JSON.stringify(body) },
		options,
		apiKey,
	);
	const outputs = parseOpenAiStyleOutputs(response.data, input.params);
	if (outputs.length === 0)
		throw new OfficialProviderError("EMPTY_PROVIDER_RESPONSE", "Ark returned no generated image.");
	return { outputs, usage: numericRecord(response.usage) };
}

async function generateAlibabaImage(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	const model = alibabaImageModel(input.modelId);
	const apiKey = requireApiKey(options, input.providerId);
	const fallback = "https://dashscope.aliyuncs.com/api/v1";
	const configuredBaseUrl = options.baseUrl?.replace(/\/compatible-mode\/v1\/?$/u, "/api/v1");
	const baseUrl = resolveBaseUrl(
		configuredBaseUrl ? { ...options, baseUrl: configuredBaseUrl } : options,
		fallback,
		input.providerId,
	);
	const params = input.params ?? {};
	const canvas = normalizeCanvasImageInput(input, params);
	const normalizedInput = { ...input, prompt: canvas.prompt, references: canvas.references };
	const refs = imageReferences(
		normalizedInput,
		model.maximumReferences,
		["image/png", "image/jpeg", "image/webp", "image/bmp", "image/tiff", "image/gif"],
		model.kind === "qwen-edit" ? 10 * 1024 * 1024 : 20 * 1024 * 1024,
	);
	const operation = requestedImageOperation(input, params);
	if (model.generationOnly && operation === "edit")
		throw new OfficialProviderError("UNSUPPORTED_OPERATION", `${input.modelId} does not support image editing.`);
	if (model.editOnly && operation === "generation")
		throw new OfficialProviderError("UNSUPPORTED_OPERATION", `${input.modelId} only supports image editing.`);
	if (model.editOnly && refs.length === 0)
		throw new OfficialProviderError("IMAGE_REQUIRED", `${input.modelId} requires at least one reference image.`);
	if (model.generationOnly && refs.length > 0)
		throw new OfficialProviderError("UNSUPPORTED_OPERATION", `${input.modelId} does not accept reference images.`);
	const values = refs.map((reference, index) => referenceValue(reference, `Reference image ${index + 1}`));
	const allowedParams =
		model.kind === "qwen-edit"
			? [
					"operation",
					"aspect",
					"ratio",
					"aspectRatio",
					"aspect_ratio",
					"resKey",
					"resolution",
					"size",
					"n",
					"count",
					"num_images",
					"style",
					"camera",
					"referenceImages",
					"referenceUrls",
					"referenceTexts",
					"firstFrameUrl",
					"imageUrl",
					"upstreamNodeIds",
					"negative_prompt",
					"prompt_extend",
					"watermark",
					"seed",
				]
			: model.kind === "wan-pro"
				? [
						"operation",
						"aspect",
						"ratio",
						"aspectRatio",
						"aspect_ratio",
						"resKey",
						"resolution",
						"size",
						"n",
						"count",
						"num_images",
						"style",
						"camera",
						"referenceImages",
						"referenceUrls",
						"referenceTexts",
						"firstFrameUrl",
						"imageUrl",
						"upstreamNodeIds",
						"watermark",
						"seed",
						"enable_sequential",
						"thinking_mode",
						"bbox_list",
						"color_palette",
					]
				: [
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
						"prompt_extend",
						"seed",
					];
	assertOnlyParams(params, allowedParams);
	const aspectRatio = aliasedString(params, "aspect ratio", "aspect", "ratio", "aspectRatio", "aspect_ratio");
	const requestedSize = aliasedString(params, "image size", "resKey", "resolution", "size");
	const size = alibabaSizeForAspect(requestedSize, aspectRatio, model);
	const sequential = model.kind === "wan-pro" ? booleanParam(params, "enable_sequential") : undefined;
	validateAlibabaSize(size, model, refs.length, sequential === true);
	const requestedCount = imageCount(params);
	if (model.kind === "z-image" && requestedCount !== undefined && requestedCount !== 1)
		throw new OfficialProviderError("UNSUPPORTED_IMAGE_COUNT", "Z-Image Turbo generates one image per request.");
	const n = model.kind === "z-image" ? undefined : requestedCount;
	const watermark =
		model.kind === "wan-pro" || model.kind === "qwen-edit" ? booleanParam(params, "watermark") : undefined;
	const promptExtend =
		model.kind === "qwen-edit" || model.kind === "z-image" ? booleanParam(params, "prompt_extend") : undefined;
	const seed =
		model.kind === "qwen-edit" || model.kind === "wan-pro" || model.kind === "z-image"
			? integerParam(params, "seed", 0, 2_147_483_647)
			: undefined;
	const parameters: Record<string, unknown> = {
		...(size ? { size: normalizeAlibabaSize(size) } : {}),
		...(n !== undefined ? { n } : {}),
		...(watermark !== undefined ? { watermark } : {}),
		...(promptExtend !== undefined ? { prompt_extend: promptExtend } : {}),
		...(seed !== undefined ? { seed } : {}),
	};
	if (model.kind === "qwen-edit") {
		const negativePrompt = stringParam(params, "negative_prompt");
		if (negativePrompt !== undefined) parameters.negative_prompt = negativePrompt;
	}
	if (model.kind === "wan-pro") {
		assertPromptLength(canvas.prompt, 5000, "Wan 2.7 Image Pro");
		if (sequential !== undefined) parameters.enable_sequential = sequential;
		const thinking = booleanParam(params, "thinking_mode");
		if (thinking !== undefined) {
			if (sequential || refs.length > 0)
				throw new OfficialProviderError(
					"UNSUPPORTED_IMAGE_PARAMETER",
					"Wan thinking_mode applies only to text-to-image single-image requests.",
				);
			parameters.thinking_mode = thinking;
		}
		const bboxList = params.bbox_list;
		if (bboxList !== undefined) parameters.bbox_list = validateWanBboxList(bboxList, refs.length);
		const palette = params.color_palette;
		if (palette !== undefined) {
			if (sequential)
				throw new OfficialProviderError(
					"UNSUPPORTED_IMAGE_PARAMETER",
					"Wan color_palette is only supported when sequential generation is disabled.",
				);
			parameters.color_palette = validateWanPalette(palette);
		}
		if (n !== undefined && n > (sequential ? 12 : 4))
			throw new OfficialProviderError(
				"INVALID_IMAGE_COUNT",
				`Wan image count must not exceed ${sequential ? 12 : 4}.`,
			);
		if (refs.length > 0 && thinking !== undefined)
			throw new OfficialProviderError(
				"UNSUPPORTED_IMAGE_PARAMETER",
				"Wan thinking_mode is not supported when reference images are provided.",
			);
	}
	if (model.kind === "qwen-edit" && n !== undefined && n > 6)
		throw new OfficialProviderError("INVALID_IMAGE_COUNT", "Qwen Image Edit Plus supports at most 6 outputs.");
	if (model.kind === "z-image") assertPromptLength(canvas.prompt, 800, "Z-Image Turbo");
	const content: Array<Record<string, string>> = values.map((image) => ({ image }));
	content.push({ text: canvas.prompt });
	const payload: Record<string, unknown> = {
		model: input.modelId,
		input: { messages: [{ role: "user", content }] },
		parameters,
	};
	const url = endpoint(baseUrl, "services/aigc/multimodal-generation/generation");
	const response = await officialJson<AlibabaImageResponse>(
		url,
		{ method: "POST", headers: jsonHeaders(apiKey), body: JSON.stringify(payload) },
		options,
		apiKey,
	);
	const outputs = parseAlibabaOutputs(response);
	if (outputs.length === 0)
		throw new OfficialProviderError("EMPTY_PROVIDER_RESPONSE", "Alibaba returned no generated image.");
	return { outputs, usage: numericRecord(response.usage ?? response.output?.usage) };
}

function parseOpenAiStyleOutputs(
	data: OpenAiImageResponse["data"],
	params?: Record<string, unknown>,
): OfficialMediaOutput[] {
	return (data ?? []).flatMap((item): OfficialMediaOutput[] => {
		if (typeof item.b64_json === "string" && item.b64_json.length > 0)
			return [{ base64: item.b64_json, mimeType: outputMime(params, item.output_format) }];
		if (typeof item.url === "string" && item.url.length > 0)
			return [{ url: item.url, mimeType: outputMime(params, item.output_format) }];
		return [];
	});
}

function parseAlibabaOutputs(response: AlibabaImageResponse): OfficialMediaOutput[] {
	const candidates = [
		...(response.output?.choices?.flatMap((choice) => choice.message?.content ?? []) ?? []),
		...(response.output?.results ?? []),
		...(response.data ?? []),
	];
	return candidates.flatMap((item): OfficialMediaOutput[] => {
		const image = typeof item.image === "string" ? item.image : undefined;
		const url = typeof item.url === "string" ? item.url : image && !image.startsWith("data:") ? image : undefined;
		const b64 = typeof item.b64_json === "string" ? item.b64_json : image?.match(/^data:[^;,]+;base64,(.+)$/iu)?.[1];
		if (b64) return [{ base64: b64, mimeType: image?.match(/^data:([^;,]+)/iu)?.[1] ?? "image/png" }];
		if (url) return [{ url, mimeType: item.mime_type ?? "image/png" }];
		return [];
	});
}

type GoogleImageModel = {
	maximumReferences: number;
	maximumObjects: number;
	maximumCharacters: number;
	maximumStyles: number;
	aspectRatios: readonly string[];
	imageSizes: readonly string[];
};

const GOOGLE_COMMON_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;

function googleImageModel(modelId: string): GoogleImageModel {
	if (modelId === "gemini-3.1-flash-image") {
		return {
			maximumReferences: 14,
			maximumObjects: 10,
			maximumCharacters: 4,
			maximumStyles: 0,
			aspectRatios: [...GOOGLE_COMMON_RATIOS, "1:4", "1:8", "4:1", "8:1"],
			imageSizes: ["0.5K", "1K", "2K", "4K"],
		};
	}
	if (modelId === "gemini-3.1-flash-lite-image") {
		return {
			maximumReferences: 14,
			maximumObjects: 14,
			maximumCharacters: 0,
			maximumStyles: 0,
			aspectRatios: GOOGLE_COMMON_RATIOS,
			imageSizes: ["1K"],
		};
	}
	if (modelId === "gemini-3-pro-image") {
		return {
			maximumReferences: 14,
			maximumObjects: 6,
			maximumCharacters: 5,
			maximumStyles: 3,
			aspectRatios: GOOGLE_COMMON_RATIOS,
			imageSizes: ["1K", "2K", "4K"],
		};
	}
	throw new OfficialProviderError(
		"UNSUPPORTED_MODEL",
		`No verified Google image protocol is registered for ${modelId}.`,
	);
}

type ArkImageModel = { kind: "pro" | "lite"; maximumReferences: number; sizes: readonly string[] };

function arkImageModel(modelId: string): ArkImageModel {
	if (modelId === "doubao-seedream-5-0-pro-260628") {
		return { kind: "pro", maximumReferences: 10, sizes: ["1K", "1.5K", "2K"] };
	}
	if (["doubao-seedream-5-0-260128", "doubao-seedream-5-0-lite-260128"].includes(modelId)) {
		return { kind: "lite", maximumReferences: 14, sizes: ["2K", "3K", "4K"] };
	}
	throw new OfficialProviderError(
		"UNSUPPORTED_MODEL",
		`No verified Ark Seedream image protocol is registered for ${modelId}.`,
	);
}

type AlibabaImageModel = {
	kind: "qwen-edit" | "wan-pro" | "z-image";
	maximumReferences: number;
	editOnly?: boolean;
	generationOnly?: boolean;
};

function alibabaImageModel(modelId: string): AlibabaImageModel {
	if (modelId === "qwen-image-edit-plus") return { kind: "qwen-edit", maximumReferences: 3, editOnly: true };
	if (modelId === "wan2.7-image-pro") return { kind: "wan-pro", maximumReferences: 9 };
	if (modelId === "z-image-turbo") return { kind: "z-image", maximumReferences: 0, generationOnly: true };
	throw new OfficialProviderError(
		"UNSUPPORTED_MODEL",
		`No verified Alibaba image protocol is registered for ${modelId}.`,
	);
}

function assertOnlyParams(params: Record<string, unknown>, allowed: readonly string[]): void {
	const unknown = Object.keys(params).find((key) => !allowed.includes(key));
	if (unknown)
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_PARAMETER",
			`Image parameter ${unknown} is not supported by this verified model adapter.`,
		);
}

const CANVAS_REFERENCE_KEYS = ["referenceImages", "referenceUrls", "firstFrameUrl", "imageUrl"] as const;

/** Normalize the canvas parameter vocabulary before applying provider-specific validation. */
function normalizeCanvasImageInput(
	input: OfficialGenerationInput,
	params: Record<string, unknown>,
): { prompt: string; references: NonNullable<OfficialGenerationInput["references"]> } {
	const style = stringParam(params, "style")?.trim();
	const camera = stringParam(params, "camera")?.trim();
	const referenceTexts = stringListParam(params.referenceTexts, "referenceTexts", 32);
	const upstreamNodeIds = params.upstreamNodeIds;
	if (
		upstreamNodeIds !== undefined &&
		(!Array.isArray(upstreamNodeIds) ||
			upstreamNodeIds.length > 32 ||
			upstreamNodeIds.some((value) => typeof value !== "string" || !value.trim()))
	) {
		throw new OfficialProviderError(
			"INVALID_IMAGE_PARAMETER",
			"upstreamNodeIds must be an array of non-empty strings with at most 32 entries.",
		);
	}
	const promptNotes = [
		...(style ? [`Style: ${style}`] : []),
		...(camera ? [`Camera or framing: ${camera}`] : []),
		...(referenceTexts.length
			? [`Reference descriptions:\n${referenceTexts.map((text) => `- ${text}`).join("\n")}`]
			: []),
	];
	const prompt = [input.prompt.trim(), ...promptNotes].filter(Boolean).join("\n");
	const references: NonNullable<OfficialGenerationInput["references"]> = [...(input.references ?? [])];
	const seen = new Set(references.map(referenceIdentity).filter((value): value is string => Boolean(value)));
	for (const key of CANVAS_REFERENCE_KEYS) {
		for (const value of stringListParam(params[key], key, 16)) {
			const reference = parseCanvasImageReference(value, key);
			const identity = referenceIdentity(reference);
			if (!identity || seen.has(identity)) continue;
			seen.add(identity);
			references.push(reference);
		}
	}
	return { prompt, references };
}

function stringListParam(value: unknown, key: string, maximum: number): string[] {
	if (value === undefined || value === null || value === "") return [];
	const values = Array.isArray(value) ? value : [value];
	if (values.length > maximum || values.some((item) => typeof item !== "string" || !item.trim())) {
		throw new OfficialProviderError(
			"INVALID_IMAGE_PARAMETER",
			`${key} must be a string or an array of at most ${maximum} non-empty strings.`,
		);
	}
	return values.map((item) => (item as string).trim());
}

function parseCanvasImageReference(
	value: string,
	label: string,
): NonNullable<OfficialGenerationInput["references"]>[number] {
	if (value.length > 32 * 1024 * 1024)
		throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", `${label} is too large.`);
	const data = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/iu.exec(value);
	if (data) {
		const bytes = safeBase64(data[2], label);
		if (bytes.byteLength > 24 * 1024 * 1024)
			throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", `${label} exceeds the 24 MB inline image limit.`);
		return {
			type: "image",
			base64: Buffer.from(bytes).toString("base64"),
			mimeType: data[1].toLowerCase(),
			role: "object",
		};
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new OfficialProviderError(
			"INVALID_MEDIA_REFERENCE",
			`${label} must be a validated HTTPS URL or image data URI.`,
		);
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.hostname === "localhost" ||
		url.hostname.endsWith(".local")
	) {
		throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", `${label} must use a public HTTPS URL.`);
	}
	return { type: "image", url: url.toString(), role: "object" };
}

function referenceIdentity(reference: { url?: string; base64?: string; mimeType?: string }): string | undefined {
	if (reference.base64) return `base64:${reference.mimeType?.toLowerCase() ?? "image/png"}:${reference.base64}`;
	if (reference.url) return `url:${reference.url}`;
	return undefined;
}

function _resolutionAspectRatio(params: Record<string, unknown>): string | undefined {
	return aliasedString(params, "aspect ratio", "aspect", "ratio", "aspectRatio", "aspect_ratio");
}

function dimensionsForArea(area: number, ratio: number): string {
	const width = Math.max(1, Math.round(Math.sqrt(area * ratio)));
	const height = Math.max(1, Math.round(Math.sqrt(area / ratio)));
	return `${width}x${height}`;
}

function parsedRatio(value: string): number {
	const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/u.exec(value);
	if (!match)
		throw new OfficialProviderError("UNSUPPORTED_IMAGE_ASPECT_RATIO", `Invalid image aspect ratio ${value}.`);
	const width = Number(match[1]);
	const height = Number(match[2]);
	const ratio = width / height;
	if (!Number.isFinite(ratio) || ratio < 1 / 16 || ratio > 16)
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_ASPECT_RATIO",
			`Image aspect ratio ${value} is outside this adapter's supported bounds.`,
		);
	return ratio;
}

function assertDimensionsMatchRatio(size: string, aspectRatio: string, label: string): void {
	const dimensions = parseDimensions(size);
	if (!dimensions) return;
	const actual = dimensions[0] / dimensions[1];
	const requested = parsedRatio(aspectRatio);
	if (Math.abs(actual - requested) / requested > 0.015) {
		throw new OfficialProviderError(
			"IMAGE_SIZE_RATIO_MISMATCH",
			`${label} dimensions conflict with the selected aspect ratio.`,
		);
	}
}

function requestedImageOperation(
	input: OfficialGenerationInput,
	params: Record<string, unknown>,
): "generation" | "edit" | undefined {
	const paramOperation = params.operation;
	if (paramOperation !== undefined && typeof paramOperation !== "string") {
		throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", "operation must be generation or edit.");
	}
	if (input.operation && paramOperation && input.operation !== paramOperation) {
		throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", "operation was specified with conflicting values.");
	}
	const operation = input.operation ?? paramOperation;
	if (operation === undefined) return undefined;
	if (operation !== "generation" && operation !== "edit") {
		throw new OfficialProviderError(
			"UNSUPPORTED_OPERATION",
			`Image operation ${operation} is not supported by this adapter.`,
		);
	}
	return operation;
}

function imageReferences(
	input: OfficialGenerationInput,
	maximum: number,
	allowedMimeTypes: readonly string[],
	maximumBytes = 40 * 1024 * 1024,
): NonNullable<OfficialGenerationInput["references"]> {
	const references = input.references ?? [];
	for (const [index, reference] of references.entries()) {
		if (reference.type !== "image")
			throw new OfficialProviderError(
				"UNSUPPORTED_REFERENCE_TYPE",
				`${input.modelId} accepts image references only.`,
			);
		if (reference.role === "mask")
			throw new OfficialProviderError(
				"UNSUPPORTED_REFERENCE_ROLE",
				`${input.modelId} does not support image masks.`,
			);
		if (reference.url && reference.base64)
			throw new OfficialProviderError(
				"INVALID_MEDIA_REFERENCE",
				`Reference image ${index + 1} must use either a URL or base64 data, not both.`,
			);
		if (reference.base64) {
			const bytes = safeBase64(reference.base64, `Reference image ${index + 1}`);
			if (bytes.byteLength > maximumBytes)
				throw new OfficialProviderError(
					"INVALID_MEDIA_REFERENCE",
					`Reference image ${index + 1} exceeds this model's ${Math.floor(maximumBytes / (1024 * 1024))} MB limit.`,
				);
		}
		const mimeType = referenceMimeType(reference);
		if (!allowedMimeTypes.includes(mimeType))
			throw new OfficialProviderError(
				"INVALID_MEDIA_REFERENCE",
				`Reference image ${index + 1} has unsupported MIME type ${mimeType}.`,
			);
	}
	if (references.length > maximum)
		throw new OfficialProviderError(
			"REFERENCE_LIMIT",
			`${input.modelId} accepts at most ${maximum} image references.`,
		);
	return references;
}

function referenceMimeType(reference: { base64?: string; mimeType?: string }): string {
	const embeddedMime = reference.base64?.match(/^data:([^;,]+);base64,/iu)?.[1];
	if (reference.mimeType && embeddedMime && reference.mimeType.toLowerCase() !== embeddedMime.toLowerCase()) {
		throw new OfficialProviderError(
			"INVALID_MEDIA_REFERENCE",
			"The reference MIME type conflicts with its embedded data URI.",
		);
	}
	return (reference.mimeType ?? embeddedMime ?? "image/png").toLowerCase();
}

function assertPromptLength(prompt: string, maximumCharacters: number, modelName: string): void {
	if ([...prompt].length > maximumCharacters)
		throw new OfficialProviderError(
			"PROMPT_TOO_LONG",
			`${modelName} prompts are limited to ${maximumCharacters} characters.`,
		);
}

function validateGoogleReferenceRoles(
	refs: NonNullable<OfficialGenerationInput["references"]>,
	model: GoogleImageModel,
): void {
	let objects = 0;
	let characters = 0;
	let styles = 0;
	for (const reference of refs) {
		switch ((reference.role ?? "object").toLowerCase()) {
			case "object":
			case "reference":
				objects++;
				break;
			case "character":
				characters++;
				break;
			case "style":
				styles++;
				break;
			default:
				throw new OfficialProviderError(
					"UNSUPPORTED_REFERENCE_ROLE",
					"Google image references must use object, character, or style roles.",
				);
		}
	}
	if (objects > model.maximumObjects || characters > model.maximumCharacters || styles > model.maximumStyles) {
		throw new OfficialProviderError(
			"REFERENCE_LIMIT",
			"The selected Google image model's object, character, or style reference limit was exceeded.",
		);
	}
}

function aliasedString(params: Record<string, unknown>, label: string, ...keys: string[]): string | undefined {
	const values: string[] = [];
	for (const key of keys) {
		const value = params[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || !value.trim())
			throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", `${key} must be a non-empty string.`);
		values.push(value.trim());
	}
	if (new Set(values).size > 1)
		throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", `Conflicting ${label} values were supplied.`);
	return values[0];
}

function outputFormatMime(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (value === "png") return "image/png";
	if (value === "jpeg" || value === "jpg") return "image/jpeg";
	throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", "Google output_format must be png or jpeg.");
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
	const value = params[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string")
		throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", `${key} must be a string.`);
	return value;
}

function booleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
	const value = params[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean")
		throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", `${key} must be a boolean.`);
	return value;
}

function integerParam(
	params: Record<string, unknown>,
	key: string,
	minimum: number,
	maximum: number,
): number | undefined {
	const value = params[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
		throw new OfficialProviderError(
			"INVALID_IMAGE_PARAMETER",
			`${key} must be an integer from ${minimum} to ${maximum}.`,
		);
	}
	return value;
}

function imageCount(params: Record<string, unknown>): number | undefined {
	const values: number[] = [];
	for (const key of ["n", "count", "num_images"]) {
		if (params[key] === undefined) continue;
		const value = params[key];
		if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 15) {
			throw new OfficialProviderError("INVALID_IMAGE_COUNT", `${key} must be an integer from 1 to 15.`);
		}
		values.push(value);
	}
	if (new Set(values).size > 1)
		throw new OfficialProviderError("INVALID_IMAGE_COUNT", "Conflicting image counts were supplied.");
	return values[0];
}

function validateSeedreamSize(size: string | undefined, model: ArkImageModel): void {
	if (size === undefined) return;
	if (model.sizes.includes(size)) return;
	const dimensions = parseDimensions(size);
	if (!dimensions)
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_SIZE",
			`${model.kind === "pro" ? "Seedream 5.0 Pro" : "Seedream 5.0 Lite"} does not support size ${size}.`,
		);
	const [width, height] = dimensions;
	const pixels = width * height;
	const minimum = model.kind === "pro" ? 921_600 : 3_686_400;
	const maximum = model.kind === "pro" ? 4_624_220 : 16_777_216;
	const ratio = width / height;
	if (pixels < minimum || pixels > maximum || ratio < 1 / 16 || ratio > 16) {
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_SIZE",
			`${model.kind === "pro" ? "Seedream 5.0 Pro" : "Seedream 5.0 Lite"} custom dimensions exceed the documented pixel or aspect-ratio bounds.`,
		);
	}
}

const SEEDREAM_RATIOS: Record<string, Record<string, string>> = {
	"1K": {
		"1:1": "1024x1024",
		"4:3": "1152x864",
		"3:4": "864x1152",
		"16:9": "1424x800",
		"9:16": "800x1424",
		"3:2": "1248x832",
		"2:3": "832x1248",
		"21:9": "1568x672",
	},
	"1.5K": {
		"1:1": "1536x1536",
		"4:3": "1792x1344",
		"3:4": "1344x1792",
		"16:9": "2048x1152",
		"9:16": "1152x2048",
		"3:2": "1872x1248",
		"2:3": "1248x1872",
		"21:9": "2352x1008",
	},
	"2K": {
		"1:1": "2048x2048",
		"4:3": "2368x1776",
		"3:4": "1776x2368",
		"16:9": "2816x1584",
		"9:16": "1584x2816",
		"3:2": "2496x1664",
		"2:3": "1664x2496",
		"21:9": "3136x1344",
	},
	"3K": {
		"1:1": "3072x3072",
		"4:3": "3456x2592",
		"3:4": "2592x3456",
		"16:9": "4096x2304",
		"9:16": "2304x4096",
		"3:2": "3744x2496",
		"2:3": "2496x3744",
		"21:9": "4704x2016",
	},
	"4K": {
		"1:1": "4096x4096",
		"4:3": "4704x3520",
		"3:4": "3520x4704",
		"16:9": "5504x3040",
		"9:16": "3040x5504",
		"3:2": "4992x3328",
		"2:3": "3328x4992",
		"21:9": "6240x2656",
	},
};

function seedreamSizeForAspect(
	size: string | undefined,
	aspectRatio: string | undefined,
	model: ArkImageModel,
): string | undefined {
	if (!aspectRatio) return size;
	const ratio = parsedRatio(aspectRatio);
	if (size && parseDimensions(size)) {
		const [width, height] = parseDimensions(size)!;
		if (Math.abs(width / height - ratio) / ratio <= 0.015) return size;
		if (width !== height) assertDimensionsMatchRatio(size, aspectRatio, "Seedream");
		return dimensionsForArea(width * height, ratio);
	}
	const tier = size ?? "2K";
	if (!model.sizes.includes(tier))
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_SIZE",
			`Seedream does not support resolution ${tier} with an explicit aspect ratio.`,
		);
	const exact = SEEDREAM_RATIOS[tier]?.[aspectRatio];
	if (exact) return exact;
	const side = Number.parseFloat(tier) * 1024;
	return dimensionsForArea(side * side, ratio);
}

function validateSequentialOptions(
	value: unknown,
	referenceCount: number,
	model: ArkImageModel,
): { max_images?: number } | undefined {
	if (value === undefined) return undefined;
	if (model.kind !== "lite")
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_PARAMETER",
			"Only Seedream 5.0 Lite supports sequential image options.",
		);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new OfficialProviderError(
			"INVALID_IMAGE_PARAMETER",
			"sequential_image_generation_options must be an object.",
		);
	const record = value as Record<string, unknown>;
	assertOnlyParams(record, ["max_images"]);
	const maxImages = integerParam(record, "max_images", 1, 15);
	if (maxImages !== undefined && referenceCount + maxImages > 15)
		throw new OfficialProviderError(
			"REFERENCE_LIMIT",
			"Seedream group output plus input references must not exceed 15 images.",
		);
	return maxImages === undefined ? {} : { max_images: maxImages };
}

function validateAlibabaSize(
	size: string | undefined,
	model: AlibabaImageModel,
	referenceCount: number,
	sequential = false,
): void {
	if (size === undefined) return;
	if (model.kind === "qwen-edit") {
		const dimensions = parseDimensions(size);
		if (!dimensions || dimensions.some((value) => value < 512 || value > 2048)) {
			throw new OfficialProviderError(
				"UNSUPPORTED_IMAGE_SIZE",
				"Qwen Image Edit Plus size must use width and height from 512 through 2048 pixels.",
			);
		}
		return;
	}
	if (model.kind === "wan-pro") {
		if (["1K", "2K"].includes(size) || (size === "4K" && referenceCount === 0 && !sequential)) return;
		const dimensions = parseDimensions(size);
		if (!dimensions)
			throw new OfficialProviderError(
				"UNSUPPORTED_IMAGE_SIZE",
				"Wan 2.7 Image Pro size must be 1K, 2K, eligible 4K, or width*height pixels.",
			);
		const [width, height] = dimensions;
		const pixels = width * height;
		const maximum = referenceCount === 0 && !sequential ? 4096 * 4096 : 2048 * 2048;
		if (pixels < 768 * 768 || pixels > maximum || width / height < 1 / 8 || width / height > 8) {
			throw new OfficialProviderError(
				"UNSUPPORTED_IMAGE_SIZE",
				"Wan 2.7 Image Pro custom dimensions exceed the documented pixel or aspect-ratio bounds for this operation.",
			);
		}
		return;
	}
	const dimensions = parseDimensions(size);
	if (!dimensions || dimensions[0] * dimensions[1] < 512 * 512 || dimensions[0] * dimensions[1] > 2048 * 2048) {
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_SIZE",
			"Z-Image Turbo size must be width*height with 512*512 to 2048*2048 total pixels.",
		);
	}
}

function alibabaSizeForAspect(
	size: string | undefined,
	aspectRatio: string | undefined,
	model: AlibabaImageModel,
): string | undefined {
	if (!aspectRatio) return size;
	const ratio = parsedRatio(aspectRatio);
	const tier = size ?? (model.kind === "wan-pro" ? "2K" : "1024x1024");
	const parsed = parseDimensions(tier);
	if (parsed) {
		if (Math.abs(parsed[0] / parsed[1] - ratio) / ratio <= 0.015) return tier;
		if (parsed[0] !== parsed[1]) assertDimensionsMatchRatio(tier, aspectRatio, "Alibaba image");
		return dimensionsForArea(parsed[0] * parsed[1], ratio);
	}
	const sideByTier: Record<string, number> = { "1K": 1024, "2K": 2048, "4K": 4096 };
	const side = sideByTier[tier];
	if (!side)
		throw new OfficialProviderError(
			"UNSUPPORTED_IMAGE_SIZE",
			`Alibaba image size ${tier} cannot be combined with an explicit aspect ratio.`,
		);
	return dimensionsForArea(side * side, ratio);
}

function parseDimensions(value: string): [number, number] | undefined {
	const match = /^(\d{2,5})\s*[x*]\s*(\d{2,5})$/iu.exec(value);
	if (!match) return undefined;
	const width = Number(match[1]);
	const height = Number(match[2]);
	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return undefined;
	return [width, height];
}

function normalizeAlibabaSize(value: string): string {
	return value.replace(/^(\d+)\s*x\s*(\d+)$/iu, "$1*$2");
}

function validateWanBboxList(value: unknown, referenceCount: number): number[][][] {
	if (!Array.isArray(value) || value.length !== referenceCount)
		throw new OfficialProviderError(
			"INVALID_IMAGE_PARAMETER",
			"Wan bbox_list must contain one entry per reference image.",
		);
	return value.map((imageBoxes, imageIndex) => {
		if (!Array.isArray(imageBoxes) || imageBoxes.length > 2)
			throw new OfficialProviderError(
				"INVALID_IMAGE_PARAMETER",
				`Wan bbox_list image ${imageIndex + 1} may contain at most two boxes.`,
			);
		return imageBoxes.map((box) => {
			if (
				!Array.isArray(box) ||
				box.length !== 4 ||
				box.some((value) => typeof value !== "number" || !Number.isInteger(value) || value < 0)
			) {
				throw new OfficialProviderError(
					"INVALID_IMAGE_PARAMETER",
					"Each Wan bounding box must contain four non-negative integer pixel coordinates.",
				);
			}
			if (box[2] < box[0] || box[3] < box[1])
				throw new OfficialProviderError(
					"INVALID_IMAGE_PARAMETER",
					"Wan bounding-box coordinates must be ordered as top-left then bottom-right.",
				);
			return box as number[];
		});
	});
}

function validateWanPalette(value: unknown): Array<{ hex: string; ratio: string }> {
	if (!Array.isArray(value) || value.length < 3 || value.length > 10)
		throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", "Wan color_palette must contain 3 to 10 colors.");
	const palette = value.map((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			throw new OfficialProviderError(
				"INVALID_IMAGE_PARAMETER",
				"Wan palette entries must contain hex and ratio fields.",
			);
		const item = entry as Record<string, unknown>;
		assertOnlyParams(item, ["hex", "ratio"]);
		if (typeof item.hex !== "string" || !/^#[0-9a-f]{6}$/iu.test(item.hex))
			throw new OfficialProviderError(
				"INVALID_IMAGE_PARAMETER",
				"Wan palette colors must be six-digit hexadecimal values.",
			);
		if (typeof item.ratio !== "string" || !/^\d+(?:\.\d{2})?%$/u.test(item.ratio))
			throw new OfficialProviderError("INVALID_IMAGE_PARAMETER", "Wan palette ratios must be percentage strings.");
		return { hex: item.hex, ratio: item.ratio };
	});
	const sum = palette.reduce((total, item) => total + Number(item.ratio.slice(0, -1)), 0);
	if (Math.abs(sum - 100) > 0.001)
		throw new OfficialProviderError(
			"INVALID_IMAGE_PARAMETER",
			"Wan color_palette ratios must add up to 100 percent.",
		);
	return palette;
}

function outputMime(params?: Record<string, unknown>, responseFormat?: string): string {
	const format = responseFormat ?? pickString(params, "output_format", "outputFormat") ?? "png";
	return format === "jpeg" || format === "jpg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
}

function numberParam(params: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
	for (const key of keys) {
		const value = params?.[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function numericRecord(value: unknown): Record<string, number> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const entries = Object.entries(value).filter(
		([, item]) => typeof item === "number" && Number.isFinite(item),
	) as Array<[string, number]>;
	return entries.length ? Object.fromEntries(entries) : undefined;
}

interface OpenAiImageResponse {
	data?: Array<{ url?: string; b64_json?: string; output_format?: string; mime_type?: string }>;
	usage?: Record<string, unknown>;
}
interface ArkImageResponse extends OpenAiImageResponse {}
interface GoogleInteractionResponse {
	steps?: Array<{
		type?: string;
		content?: Array<{ type?: string; text?: string; data?: string; mime_type?: string }>;
	}>;
	output_image?: { data?: string; mime_type?: string };
	output_text?: string;
	usage?: Record<string, unknown>;
}
interface AlibabaImageResponse {
	data?: Array<{ image?: string; url?: string; b64_json?: string; mime_type?: string }>;
	usage?: Record<string, unknown>;
	output?: {
		usage?: Record<string, unknown>;
		choices?: Array<{
			message?: { content?: Array<{ image?: string; url?: string; b64_json?: string; mime_type?: string }> };
		}>;
		results?: Array<{ image?: string; url?: string; b64_json?: string; mime_type?: string }>;
	};
}

const officialImagesAdapter: ImagesFunction<typeof OPENAI_IMAGE_API, ImagesOptions> = async (
	model: ImagesModel<typeof OPENAI_IMAGE_API>,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	const text = context.input
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n");
	const refs = context.input
		.filter((item): item is ImageContent => item.type === "image")
		.map((item) => ({ type: "image" as const, base64: item.data, mimeType: item.mimeType }));
	const result = await generateOfficialImage(
		{ providerId: model.provider, modelId: model.id, modality: "image", prompt: text, references: refs },
		{
			apiKey: options?.apiKey,
			baseUrl: model.baseUrl,
			...(options?.signal ? { signal: options.signal } : {}),
			...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
			...(options?.fetch ? { fetch: options.fetch } : {}),
		},
	);
	const output = (result.outputs ?? []).flatMap(
		(item): Array<ImageContent | TextContent> => [
			...(item.base64 ? [{ type: "image" as const, data: item.base64, mimeType: item.mimeType }] : []),
			...(item.url ? [{ type: "text" as const, text: item.url }] : []),
		],
	);
	const usage = imageUsage(result.usage);
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output,
		...(usage ? { usage } : {}),
		stopReason: "stop",
		timestamp: Date.now(),
	};
};

function imageUsage(usage?: Record<string, number>): Usage | undefined {
	if (!usage) return undefined;
	const input = usage.input_tokens ?? usage.prompt_tokens ?? 0;
	const output = usage.output_tokens ?? usage.completion_tokens ?? usage.total_tokens ?? 0;
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: usage.total_tokens ?? input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Register the official-provider adapter with Pi's existing image API registry. */
export function registerOfficialImagesApiProvider(): void {
	registerImagesApiProvider({ api: OPENAI_IMAGE_API, generateImages: officialImagesAdapter });
}

registerOfficialImagesApiProvider();
