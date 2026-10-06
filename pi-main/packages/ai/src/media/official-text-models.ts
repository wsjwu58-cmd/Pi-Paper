import type { Api, Model } from "../types.ts";

/** Verified first-party request IDs; keep product names separate from transport IDs. */
export interface OfficialTextDefinition {
	name: string;
	providerId: string;
	apiModelId: string;
	api: Api;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	compat?: Model<Api>["compat"];
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	source: string;
	/** Whether the supplied context/output figures are official limits or conservative application budgets. */
	contextMetadataStatus?: "verified" | "application-budget";
	maxTokensMetadataStatus?: "verified" | "application-cap";
}

const claude = (name: string, id: string, contextWindow = 1_000_000, maxTokens = 128_000): OfficialTextDefinition => ({
	name,
	providerId: "anthropic",
	apiModelId: id,
	api: "anthropic-messages",
	contextWindow,
	maxTokens,
	reasoning: true,
	...(id.includes("haiku") ? {} : { compat: { forceAdaptiveThinking: true, supportsTemperature: false } }),
	...(/fable|opus-5-5/.test(id) ? { thinkingLevelMap: { off: null } } : {}),
	source: "https://platform.claude.com/docs/en/models/overview",
});
const openai = (name: string, id: string): OfficialTextDefinition => ({
	name,
	providerId: "openai",
	apiModelId: id,
	api: "openai-responses",
	contextWindow: 1_050_000,
	maxTokens: 128_000,
	reasoning: true,
	source: `https://developers.openai.com/api/docs/models/${id}`,
});
const gemini = (name: string, id: string): OfficialTextDefinition => ({
	name,
	providerId: "google",
	apiModelId: id,
	api: "google-generative-ai",
	contextWindow: 1_048_576,
	maxTokens: 65_536,
	reasoning: true,
	...(id === "gemini-3.8-flash" ? { thinkingLevelMap: { minimal: "low", off: null } } : {}),
	source: `https://ai.google.dev/gemini-api/docs/models/${id}`,
});
const volcengineSeed = (
	name: string,
	id: string,
	contextWindow: number,
	maxTokens: number,
	source: string,
): OfficialTextDefinition => ({
	name,
	providerId: "volcengine",
	apiModelId: id,
	api: "openai-completions",
	contextWindow,
	maxTokens,
	reasoning: true,
	compat: { supportsReasoningEffort: true, maxTokensField: "max_tokens" },
	thinkingLevelMap: {
		off: null,
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "high",
		max: "high",
	},
	source,
});

export const OFFICIAL_TEXT_MODELS: readonly OfficialTextDefinition[] = [
	claude("Claude Fable 5.1", "claude-fable-5-1"),
	claude("Claude Haiku 4.5", "claude-haiku-4-5-20251001", 200_000, 64_000),
	claude("Claude Opus 5", "claude-opus-5"),
	claude("Claude Opus 5.5", "claude-opus-5-5"),
	claude("Claude Sonnet 4.6", "claude-sonnet-4-6"),
	claude("Claude Sonnet 5.5", "claude-sonnet-5-5"),
	{
		name: "DeepSeek V4.1 Flash",
		providerId: "deepseek",
		apiModelId: "deepseek-flash",
		api: "openai-completions",
		contextWindow: 1_000_000,
		maxTokens: 8192,
		reasoning: false,
		source: "https://api-docs.deepseek.com/quick_start/pricing/",
	},
	{
		name: "GLM-5.3",
		providerId: "zhipu",
		apiModelId: "glm-5.3",
		api: "openai-completions",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		reasoning: true,
		compat: {
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
			supportsTemperature: false,
			thinkingFormat: "deepseek",
		},
		thinkingLevelMap: {
			off: null,
			minimal: "low",
			low: "low",
			medium: "low",
			high: "high",
			xhigh: "max",
			max: "max",
		},
		source: "https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3",
	},
	...["glm-5.3-flash", "glm-5.3-flashx"].map(
		(id): OfficialTextDefinition => ({
			name: id.endsWith("flashx") ? "GLM-5.3 FlashX" : "GLM-5.3 Flash",
			providerId: "zhipu",
			apiModelId: id,
			api: "openai-completions",
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			reasoning: true,
			compat: { supportsReasoningEffort: true, maxTokensField: "max_tokens", thinkingFormat: "deepseek" },
			thinkingLevelMap: {
				off: null,
				minimal: "low",
				low: "low",
				medium: "low",
				high: "high",
				xhigh: "max",
				max: "max",
			},
			source: "https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash",
		}),
	),
	gemini("Gemini 3.1 Pro", "gemini-3.1-pro-preview"),
	gemini("Gemini 3.6 Flash", "gemini-3.6-flash"),
	gemini("Gemini 3.8 Flash", "gemini-3.8-flash"),
	openai("GPT-5.6 Sol", "gpt-5.6-sol"),
	openai("GPT-5.6 Terra", "gpt-5.6-terra"),
	openai("GPT-5.6 Luna", "gpt-5.6-luna"),
	openai("GPT-6 Astra", "gpt-6-astra"),
	openai("GPT-6 Sol", "gpt-6-sol"),
	openai("GPT-6.1 Sol", "gpt-6.1-sol"),
	openai("GPT-6 Luna", "gpt-6-luna"),
	{
		name: "Kimi K3",
		providerId: "moonshot",
		apiModelId: "kimi-k3",
		api: "openai-completions",
		contextWindow: 1_000_000,
		maxTokens: 1_048_576,
		reasoning: true,
		compat: {
			supportsReasoningEffort: true,
			maxTokensField: "max_completion_tokens",
			thinkingFormat: "deepseek",
			supportsTemperature: false,
		},
		thinkingLevelMap: {
			off: null,
			minimal: "low",
			low: "low",
			medium: "low",
			high: "high",
			xhigh: "max",
			max: "max",
		},
		source: "https://platform.kimi.ai/docs/guide/kimi-k3-quickstart",
	},
	...["kimi-k2.7-code", "kimi-k2.7-code-highspeed"].map(
		(id): OfficialTextDefinition => ({
			name: id.endsWith("highspeed") ? "Kimi K2.7 Code Highspeed" : "Kimi K2.7 Code",
			providerId: "moonshot",
			apiModelId: id,
			api: "openai-completions",
			contextWindow: 256_000,
			maxTokens: 32_768,
			maxTokensMetadataStatus: "application-cap",
			reasoning: true,
			compat: {
				thinkingFormat: "deepseek",
				maxTokensField: "max_tokens",
				supportsReasoningEffort: false,
				supportsTemperature: false,
			},
			thinkingLevelMap: { off: null },
			source: "https://platform.kimi.ai/docs/guide/kimi-k2-7-code-quickstart",
		}),
	),
	...["qwen3.8-max", "qwen3.8-flash"].map(
		(id): OfficialTextDefinition => ({
			name: id.endsWith("max") ? "Qwen 3.8 Max" : "Qwen 3.8 Flash",
			providerId: "alibaba",
			apiModelId: id,
			api: "openai-completions",
			contextWindow: 1_000_000,
			maxTokens: 8192,
			maxTokensMetadataStatus: "application-cap",
			reasoning: true,
			compat: { thinkingFormat: "qwen", supportsReasoningEffort: false, maxTokensField: "max_tokens" },
			source: "https://www.alibabacloud.com/help/en/model-studio/text-generation-model",
		}),
	),
	{
		name: "MiniMax M3",
		providerId: "minimax",
		apiModelId: "MiniMax-M3",
		api: "anthropic-messages",
		contextWindow: 1_000_000,
		maxTokens: 524_288,
		reasoning: true,
		compat: { forceAdaptiveThinking: true },
		source: "https://platform.minimax.io/docs/api-reference/text-chat-anthropic",
	},
	{
		name: "Grok 4.3",
		providerId: "xai",
		apiModelId: "grok-4.3",
		api: "openai-responses",
		contextWindow: 1_000_000,
		maxTokens: 8192,
		reasoning: true,
		source: "https://docs.x.ai/developers/models/grok-4.3",
	},
	{
		name: "Grok 4.7",
		providerId: "xai",
		apiModelId: "grok-4.7",
		api: "openai-responses",
		contextWindow: 500_000,
		maxTokens: 8192,
		reasoning: true,
		source: "https://docs.x.ai/developers/models/grok-4.7",
	},
	// The public model card confirms the ID and reasoning support but does not
	// publish Mini's context limit. Keep the Agent accounting budget conservative.
	{
		...volcengineSeed(
			"Seed 2.0 Mini",
			"doubao-seed-2-0-mini-260428",
			8192,
			2048,
			"https://docs.volcengine.com/docs/ark/model-release-announcement?lang=zh",
		),
		contextMetadataStatus: "application-budget",
		maxTokensMetadataStatus: "application-cap",
	},
	{
		...volcengineSeed(
			"Seed 2.1 Pro",
			"doubao-seed-2-1-pro-260628",
			256_000,
			32_768,
			"https://docs.volcengine.com/docs/ark/responses-api-text-generation?lang=zh",
		),
		contextMetadataStatus: "verified",
		maxTokensMetadataStatus: "verified",
	},
];

export function getOfficialTextDefinition(providerId: string, modelId: string): OfficialTextDefinition | undefined {
	return OFFICIAL_TEXT_MODELS.find((model) => model.providerId === providerId && model.apiModelId === modelId);
}
