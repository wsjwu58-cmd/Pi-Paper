import { completeSimple } from "../compat.ts";
import type { Api, Model } from "../types.ts";
import { OfficialProviderError, requireApiKey, resolveBaseUrl } from "./http.ts";
import { getOfficialTextDefinition } from "./official-text-models.ts";
import type { OfficialGenerationInput, OfficialGenerationOptions, ResolvedOfficialTextModel } from "./types.ts";

interface TextProviderDefinition {
	api: Api;
	baseUrl: string;
}

const TEXT_PROVIDERS: Record<string, TextProviderDefinition> = {
	zhipu: { api: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
	openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
	anthropic: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
	google: { api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
	deepseek: { api: "openai-completions", baseUrl: "https://api.deepseek.com" },
	moonshot: { api: "openai-completions", baseUrl: "https://api.moonshot.ai/v1" },
	xai: { api: "openai-responses", baseUrl: "https://api.x.ai/v1" },
	volcengine: { api: "openai-completions", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
	byteplus: { api: "openai-completions", baseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3" },
	doubao: { api: "openai-completions", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
	alibaba: { api: "openai-completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
	minimax: { api: "anthropic-messages", baseUrl: "https://api.minimax.io/anthropic" },
	agnes: { api: "openai-completions", baseUrl: "https://apihub.agnes-ai.com/v1" },
};

/**
 * Resolve a user-configured official text model to a Pi model descriptor. The
 * returned descriptor contains no credential; callers pass the key separately
 * to Pi's `completeSimple`/`streamSimple` APIs.
 */
export function resolveOfficialTextModel(
	input: Pick<OfficialGenerationInput, "providerId" | "modelId" | "apiBaseUrl">,
	options: OfficialGenerationOptions,
): ResolvedOfficialTextModel {
	const definition = TEXT_PROVIDERS[input.providerId];
	if (!definition) {
		throw new OfficialProviderError(
			"UNSUPPORTED_PROVIDER",
			`Official text generation is not implemented for ${input.providerId}.`,
		);
	}
	const apiKey = requireApiKey(options, input.providerId);
	const metadata = getOfficialTextDefinition(input.providerId, input.modelId);
	const baseUrl = resolveBaseUrl(
		input.apiBaseUrl ? { ...options, baseUrl: input.apiBaseUrl } : options,
		definition.baseUrl,
		input.providerId,
	);
	const model: Model<Api> = {
		id: input.modelId,
		name: input.modelId,
		api: metadata?.api ?? definition.api,
		provider: input.providerId,
		baseUrl,
		reasoning: metadata?.reasoning ?? false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: metadata?.contextWindow ?? 4096,
		maxTokens: metadata?.maxTokens ?? 1024,
		...(metadata?.compat ? { compat: metadata.compat } : {}),
		...(metadata?.thinkingLevelMap ? { thinkingLevelMap: metadata.thinkingLevelMap } : {}),
	};
	return { model, apiKey };
}

export async function generateOfficialText(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<{ text: string; usage?: Record<string, number> }> {
	const { model, apiKey } = resolveOfficialTextModel(input, options);
	const params = input.params ?? {};
	assertSupportedTextParams(params);
	if (typeof params.maxTokens === "number" && params.maxTokens > model.maxTokens) {
		throw new OfficialProviderError(
			"INVALID_PARAMETER",
			`maxTokens exceeds the configured model cap of ${model.maxTokens}.`,
		);
	}
	if (input.references?.length)
		throw new OfficialProviderError("UNSUPPORTED_REFERENCE", "This text adapter currently supports text input only.");
	if (
		params.temperature !== undefined &&
		model.compat &&
		"supportsTemperature" in model.compat &&
		model.compat.supportsTemperature === false
	) {
		throw new OfficialProviderError("UNSUPPORTED_PARAMETER", "This model does not accept a temperature override.");
	}
	const systemPrompt = typeof params.systemPrompt === "string" ? params.systemPrompt : undefined;
	const messages = [{ role: "user" as const, content: input.prompt, timestamp: Date.now() }];
	const result = await completeSimple(
		model,
		{ ...(systemPrompt ? { systemPrompt } : {}), messages },
		{
			apiKey,
			...(options.fetch ? { fetch: options.fetch } : {}),
			...(options.signal ? { signal: options.signal } : {}),
			...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
			maxRetries: 0,
			...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
			maxTokens: typeof params.maxTokens === "number" ? params.maxTokens : Math.min(model.maxTokens, 8192),
			...(model.reasoning ? { reasoning: "medium" as const } : {}),
			...(params.samplingParams && typeof params.samplingParams === "object"
				? { samplingParams: params.samplingParams as Record<string, unknown> }
				: {}),
		},
	);
	if (result.stopReason === "error" || result.stopReason === "aborted") {
		throw new OfficialProviderError(
			result.stopReason === "aborted" ? "REQUEST_ABORTED" : "PROVIDER_REQUEST_FAILED",
			result.errorMessage ? sanitizeTextError(result.errorMessage, apiKey) : "The text provider request failed.",
		);
	}
	const text = result.content
		.filter((part): part is Extract<(typeof result.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("");
	if (!text) throw new OfficialProviderError("EMPTY_PROVIDER_RESPONSE", "The provider returned no text.");
	return {
		text,
		usage: {
			input: result.usage.input,
			output: result.usage.output,
			total: result.usage.totalTokens,
		},
	};
}

function assertSupportedTextParams(params: Record<string, unknown>): void {
	const allowed = new Set(["systemPrompt", "temperature", "maxTokens", "samplingParams"]);
	const unknown = Object.keys(params).find((key) => !allowed.has(key));
	if (unknown)
		throw new OfficialProviderError(
			"UNSUPPORTED_PARAMETER",
			`The official text adapter does not implement parameter ${unknown}.`,
		);
	if (params.systemPrompt !== undefined && typeof params.systemPrompt !== "string") {
		throw new OfficialProviderError("INVALID_PARAMETER", "systemPrompt must be text.");
	}
	if (
		params.temperature !== undefined &&
		(typeof params.temperature !== "number" ||
			!Number.isFinite(params.temperature) ||
			params.temperature < 0 ||
			params.temperature > 2)
	) {
		throw new OfficialProviderError("INVALID_PARAMETER", "temperature must be a number from 0 to 2.");
	}
	if (
		params.maxTokens !== undefined &&
		(typeof params.maxTokens !== "number" || !Number.isInteger(params.maxTokens) || params.maxTokens < 1)
	) {
		throw new OfficialProviderError("INVALID_PARAMETER", "maxTokens must be a positive integer.");
	}
	if (params.samplingParams !== undefined) {
		if (!params.samplingParams || typeof params.samplingParams !== "object" || Array.isArray(params.samplingParams)) {
			throw new OfficialProviderError("INVALID_PARAMETER", "samplingParams must be an object.");
		}
		const sampling = params.samplingParams as Record<string, unknown>;
		const supportedSamplingKeys = new Set([
			"topP",
			"top_p",
			"presencePenalty",
			"presence_penalty",
			"frequencyPenalty",
			"frequency_penalty",
			"stop",
		]);
		const unsupported = Object.keys(sampling).find((key) => !supportedSamplingKeys.has(key));
		if (unsupported)
			throw new OfficialProviderError(
				"UNSUPPORTED_PARAMETER",
				`The official text adapter does not implement sampling parameter ${unsupported}.`,
			);
		for (const key of [
			"topP",
			"top_p",
			"presencePenalty",
			"presence_penalty",
			"frequencyPenalty",
			"frequency_penalty",
		]) {
			const value = sampling[key];
			if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value)))
				throw new OfficialProviderError("INVALID_PARAMETER", `${key} must be a finite number.`);
		}
		if (
			sampling.stop !== undefined &&
			!(
				typeof sampling.stop === "string" ||
				(Array.isArray(sampling.stop) && sampling.stop.every((item) => typeof item === "string"))
			)
		) {
			throw new OfficialProviderError("INVALID_PARAMETER", "stop must be a string or an array of strings.");
		}
	}
}

function sanitizeTextError(message: string, apiKey: string): string {
	return message
		.split(apiKey)
		.join("[redacted]")
		.replace(/\bBearer\s+[^\s,;"']+/giu, "Bearer [redacted]");
}
