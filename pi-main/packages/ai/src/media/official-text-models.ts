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
	gemini("Gemini 3.1 Pro", "gemini-3.1-pro-preview"),
	gemini("Gemini 3.6 Flash", "gemini-3.6-flash"),
	gemini("Gemini 3.8 Flash", "gemini-3.8-flash"),
	openai("GPT-5.6 Sol", "gpt-5.6-sol"),
	openai("GPT-5.6 Terra", "gpt-5.6-terra"),
	openai("GPT-5.6 Luna", "gpt-5.6-luna"),
	openai("GPT-6 Astra", "gpt-6-astra"),
	openai("GPT-6 Sol", "gpt-6-sol"),
	openai("GPT-6 Luna", "gpt-6-luna"),
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
