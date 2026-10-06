import { OFFICIAL_MEDIA_MODELS } from "./official-media-models.ts";
import { OFFICIAL_TEXT_MODELS } from "./official-text-models.ts";
import { ZHIPU_MEDIA_MODELS } from "./official-zhipu-models.ts";
import type { OfficialModality } from "./types.ts";

export interface OfficialProviderCatalogProvider {
	id: string;
	name: string;
	baseUrl: string;
	allowedHosts?: string[];
	providerType: "cloud";
	modalities: OfficialModality[];
	credentialFields: Array<{ name: string; label: string; required: boolean; secret?: boolean }>;
	connectionTest:
		| {
				kind: "models-list";
				path: string;
				auth: "bearer" | "anthropic-key" | "google-key" | "elevenlabs-key";
				listField: "data" | "models" | "items" | "root";
				idField: "id" | "name" | "model_id" | "_id";
				envelope?: "openai-list";
				pathMode?: "base-url" | "origin";
		  }
		| {
				kind: "account-check";
				path: string;
				auth: "vidu-token" | "pixverse-key" | "elevenlabs-key" | "bearer";
				response: "vidu-credits" | "pixverse-balance" | "elevenlabs-user" | "minimax-files";
				pathMode?: "base-url" | "origin";
		  }
		| { kind: "ark-task-list" }
		| { kind: "kling-task-list" }
		| { kind: "format-only" };
	configurable: boolean;
	unavailableReason?: string;
}

export interface OfficialProviderCatalogModel {
	id: string;
	name: string;
	displayName: string;
	providerId: string;
	modelType: OfficialModality;
	apiModelId: string;
	implemented: boolean;
	enabled: boolean;
	inputModes: string[];
	toolCalling: boolean;
	streaming: boolean;
	cancellation: boolean;
	apiBaseUrl?: string;
	operation?: "chat" | "generation" | "edit" | "speech" | "voice-change" | "music" | "task";
	route?: "legacy-agnes" | "legacy-ark";
	brandId?: string;
	unavailableReason?: string;
	brand?: string;
	target?: boolean;
	metadataStatus?: "verified" | "unknown";
	contextWindow?: number;
	contextMetadataStatus?: "verified" | "application-budget";
	maxTokensMetadataStatus?: "verified" | "application-cap";
	maxTokens?: number;
	defaults?: Record<string, unknown>;
	constraints?: Record<string, unknown>;
	requiredCredentials?: string[];
}

const key = (label: string) => [{ name: "apiKey", label, required: true, secret: true }];

const PROVIDERS: OfficialProviderCatalogProvider[] = [
	{
		id: "zhipu",
		name: "智谱 AI",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		providerType: "cloud",
		modalities: ["text", "image", "video"],
		credentialFields: key("智谱 API Key"),
		connectionTest: { kind: "format-only" },
		configurable: true,
	},
	{
		id: "anthropic",
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		providerType: "cloud",
		modalities: ["text"],
		credentialFields: key("Anthropic API Key"),
		connectionTest: {
			kind: "models-list",
			path: "v1/models?limit=1",
			auth: "anthropic-key",
			listField: "data",
			idField: "id",
		},
		configurable: true,
	},
	{
		id: "deepseek",
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com",
		providerType: "cloud",
		modalities: ["text"],
		credentialFields: key("DeepSeek API Key"),
		connectionTest: {
			kind: "models-list",
			path: "models",
			auth: "bearer",
			listField: "data",
			idField: "id",
			envelope: "openai-list",
		},
		configurable: true,
	},
	{
		id: "google",
		name: "Google AI Studio",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		providerType: "cloud",
		modalities: ["text", "image", "video"],
		credentialFields: key("Google AI API Key"),
		connectionTest: {
			kind: "models-list",
			path: "models?pageSize=10",
			auth: "google-key",
			listField: "models",
			idField: "name",
		},
		configurable: true,
	},
	{
		id: "openai",
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		providerType: "cloud",
		modalities: ["text", "image", "audio"],
		credentialFields: key("OpenAI API Key"),
		connectionTest: {
			kind: "models-list",
			path: "models",
			auth: "bearer",
			listField: "data",
			idField: "id",
			envelope: "openai-list",
		},
		configurable: true,
	},
	{
		id: "xai",
		name: "xAI",
		baseUrl: "https://api.x.ai/v1",
		providerType: "cloud",
		modalities: ["text", "image", "video"],
		credentialFields: key("xAI API Key"),
		connectionTest: {
			kind: "models-list",
			path: "models",
			auth: "bearer",
			listField: "data",
			idField: "id",
			envelope: "openai-list",
		},
		configurable: true,
	},
	{
		id: "moonshot",
		name: "Moonshot",
		baseUrl: "https://api.moonshot.ai/v1",
		providerType: "cloud",
		modalities: ["text"],
		credentialFields: key("Moonshot API Key"),
		connectionTest: {
			kind: "models-list",
			path: "models",
			auth: "bearer",
			listField: "data",
			idField: "id",
			envelope: "openai-list",
		},
		configurable: true,
	},
	{
		id: "volcengine",
		name: "火山方舟",
		baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		allowedHosts: ["ark.cn-beijing.volces.com"],
		providerType: "cloud",
		modalities: ["text", "image"],
		credentialFields: key("火山方舟 API Key"),
		connectionTest: { kind: "format-only" },
		configurable: true,
	},
	{
		id: "byteplus",
		name: "BytePlus",
		baseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3",
		providerType: "cloud",
		modalities: ["text", "image", "video"],
		credentialFields: key("BytePlus API Key"),
		connectionTest: { kind: "ark-task-list" },
		configurable: true,
	},
	{
		id: "doubao",
		name: "豆包",
		baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		providerType: "cloud",
		modalities: ["text", "image"],
		credentialFields: key("火山方舟 API Key"),
		connectionTest: { kind: "format-only" },
		configurable: true,
	},
	{
		id: "volcengine-ark",
		name: "火山方舟 Seedance",
		baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		allowedHosts: ["ark.cn-beijing.volces.com"],
		providerType: "cloud",
		modalities: ["video"],
		credentialFields: key("火山方舟 API Key"),
		connectionTest: { kind: "ark-task-list" },
		configurable: true,
	},
	{
		id: "alibaba",
		name: "阿里云百炼",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		allowedHosts: ["dashscope.aliyuncs.com"],
		providerType: "cloud",
		modalities: ["text", "image"],
		credentialFields: key("阿里云百炼 API Key"),
		connectionTest: { kind: "format-only" },
		configurable: true,
	},
	{
		id: "minimax",
		name: "MiniMax",
		baseUrl: "https://api.minimax.io/anthropic",
		allowedHosts: ["api.minimax.io", "api.minimax.chat"],
		providerType: "cloud",
		modalities: ["text", "video", "audio"],
		credentialFields: [
			...key("MiniMax API Key"),
			{ name: "voiceId", label: "Voice ID（语音模型必填）", required: false, secret: false },
		],
		connectionTest: {
			kind: "account-check",
			path: "v1/files/list?purpose=voice_clone",
			pathMode: "origin",
			auth: "bearer",
			response: "minimax-files",
		},
		configurable: true,
	},
	{
		id: "agnes",
		name: "Agnes",
		baseUrl: "https://apihub.agnes-ai.com/v1",
		providerType: "cloud",
		modalities: ["text", "image", "video"],
		credentialFields: key("Agnes API Key"),
		connectionTest: { kind: "format-only" },
		configurable: true,
	},
	{
		id: "elevenlabs",
		name: "ElevenLabs",
		baseUrl: "https://api.elevenlabs.io/v1",
		allowedHosts: ["api.elevenlabs.io"],
		providerType: "cloud",
		modalities: ["audio"],
		credentialFields: [
			...key("ElevenLabs API Key"),
			{ name: "voiceId", label: "Voice ID", required: true, secret: false },
		],
		connectionTest: { kind: "account-check", path: "user", auth: "elevenlabs-key", response: "elevenlabs-user" },
		configurable: true,
	},
	{
		id: "alibaba-video",
		name: "阿里云百炼视频",
		baseUrl: "https://dashscope.aliyuncs.com/api/v1",
		providerType: "cloud",
		modalities: ["video"],
		credentialFields: [
			...key("百炼 API Key"),
			{ name: "workspaceId", label: "Workspace ID", required: true, secret: false },
			{ name: "region", label: "Region（如 cn-beijing）", required: true, secret: false },
		],
		connectionTest: { kind: "format-only" },
		configurable: true,
	},
	{
		id: "doubao-voice",
		name: "豆包语音",
		baseUrl: "https://openspeech.bytedance.com/api/v3",
		providerType: "cloud",
		modalities: ["audio"],
		credentialFields: [
			...key("豆包语音 API Key"),
			{ name: "voiceId", label: "Speaker ID（2.0 音色）", required: true, secret: false },
		],
		connectionTest: { kind: "format-only" },
		configurable: true,
	},
	{
		id: "doubao-voice-v1",
		name: "豆包语音 v1（兼容）",
		baseUrl: "https://openspeech.bytedance.com/api/v1",
		providerType: "cloud",
		modalities: ["audio"],
		credentialFields: [
			{ name: "accessToken", label: "Access Token（v1）", required: true, secret: true },
			{ name: "appId", label: "AppID", required: true, secret: false },
			{ name: "voiceId", label: "Voice Type（v1 音色）", required: true, secret: false },
		],
		connectionTest: { kind: "format-only" },
		configurable: true,
	},
	{
		id: "fish-audio",
		name: "Fish Audio",
		baseUrl: "https://api.fish.audio/v1",
		providerType: "cloud",
		modalities: ["audio"],
		credentialFields: [
			...key("Fish Audio API Key"),
			{ name: "voiceId", label: "Reference ID（可选音色）", required: false, secret: false },
		],
		connectionTest: {
			kind: "models-list",
			path: "/model?page_size=1",
			pathMode: "origin",
			auth: "bearer",
			listField: "items",
			idField: "_id",
		},
		configurable: true,
	},
	{
		id: "kling",
		name: "Kling（官方 API Key / AK/SK 兼容）",
		baseUrl: "https://api-singapore.klingai.com",
		allowedHosts: ["api-singapore.klingai.com"],
		providerType: "cloud",
		modalities: ["video"],
		credentialFields: [
			{ name: "apiKey", label: "Kling API Key（官方；或使用下方旧版 AK/SK）", required: false, secret: true },
			{ name: "accessKey", label: "Kling Access Key（旧版）", required: false, secret: true },
			{ name: "secretKey", label: "Kling Secret Key（旧版）", required: false, secret: true },
		],
		connectionTest: { kind: "kling-task-list" },
		configurable: true,
	},
	{
		id: "vidu",
		name: "Vidu",
		baseUrl: "https://api.vidu.com/ent/v2",
		providerType: "cloud",
		modalities: ["video"],
		credentialFields: key("Vidu API Key"),
		connectionTest: { kind: "account-check", path: "credits", auth: "vidu-token", response: "vidu-credits" },
		configurable: true,
	},
	{
		id: "pixverse",
		name: "PixVerse",
		baseUrl: "https://app-api.pixverse.ai/openapi/v2",
		providerType: "cloud",
		modalities: ["video"],
		credentialFields: key("PixVerse API Key"),
		connectionTest: {
			kind: "account-check",
			path: "account/balance",
			auth: "pixverse-key",
			response: "pixverse-balance",
		},
		configurable: true,
	},
	{
		id: "midjourney",
		name: "Midjourney",
		baseUrl: "",
		providerType: "cloud",
		modalities: ["image"],
		credentialFields: [],
		connectionTest: { kind: "format-only" },
		configurable: false,
		unavailableReason: "官方未提供公开生成 API，官方条款限制自动化；不能通过填写 API Key 启用。",
	},
	{
		id: "happyhorse",
		name: "HappyHorse",
		baseUrl: "",
		providerType: "cloud",
		modalities: ["video"],
		credentialFields: [],
		connectionTest: { kind: "format-only" },
		configurable: false,
		unavailableReason:
			"阿里云官方品牌已核验；此旧型号的精确调用 ID 和任务协议尚未核验。已实现的版本使用阿里云百炼视频配置。",
	},
];

type Target = [
	name: string,
	brand: string,
	providerId: string,
	modality: OfficialModality,
	apiModelId?: string,
	operation?: OfficialProviderCatalogModel["operation"],
];

const TARGETS: Target[] = [
	["GLM-5.3", "智谱", "zhipu", "text"],
	["GLM-5.3 Flash", "智谱", "zhipu", "text"],
	["GLM-5.3 FlashX", "智谱", "zhipu", "text"],
	["GLM-Image", "智谱", "zhipu", "image"],
	["CogView 4", "智谱", "zhipu", "image"],
	["CogView 4 250304", "智谱", "zhipu", "image"],
	["CogView 3 Flash", "智谱", "zhipu", "image"],
	["CogVideoX-3", "智谱", "zhipu", "video"],
	["GPT-6.1 Sol", "OpenAI", "openai", "text"],
	["Claude Sonnet 5.5", "Anthropic", "anthropic", "text"],
	["Kimi K3", "Moonshot", "moonshot", "text"],
	["Kimi K2.7 Code", "Moonshot", "moonshot", "text"],
	["Kimi K2.7 Code Highspeed", "Moonshot", "moonshot", "text"],
	["Qwen 3.8 Max", "Qwen", "alibaba", "text"],
	["Qwen 3.8 Flash", "Qwen", "alibaba", "text"],
	["MiniMax M3", "MiniMax", "minimax", "text"],
	["MiniMax Music 3.0", "MiniMax", "minimax", "audio"],
	["Grok Imagine Image 2.0", "xAI", "xai", "image"],
	["Eleven v4", "ElevenLabs", "elevenlabs", "audio"],
	["Eleven v4 Turbo", "ElevenLabs", "elevenlabs", "audio"],
	["Eleven Music 2.5", "ElevenLabs", "elevenlabs", "audio"],
	["Claude Fable 5.1", "Anthropic", "anthropic", "text"],
	["Claude Haiku 4.5", "Anthropic", "anthropic", "text", "claude-haiku-4-5"],
	["Claude Opus 5", "Anthropic", "anthropic", "text", "claude-opus-5"],
	["Claude Opus 5.5", "Anthropic", "anthropic", "text"],
	["Claude Sonnet 4.6", "Anthropic", "anthropic", "text", "claude-sonnet-4-6"],
	["DeepSeek V4.1 Flash", "DeepSeek", "deepseek", "text", "deepseek-flash", "chat"],
	["Gemini 3.1 Pro", "Google", "google", "text", "gemini-3.1-pro-preview"],
	["Gemini 3.6 Flash", "Google", "google", "text"],
	["Gemini 3.8 Flash", "Google", "google", "text"],
	["Veo 3.1", "Google", "google", "video"],
	["Veo 3.1 Lite", "Google", "google", "video"],
	["Gemini Omni Flash", "Google", "google", "video"],
	["GPT-5.6 Sol", "OpenAI", "openai", "text"],
	["GPT-5.6 Terra", "OpenAI", "openai", "text"],
	["GPT-5.6 Luna", "OpenAI", "openai", "text"],
	["GPT-6 Astra", "OpenAI", "openai", "text"],
	["GPT-6 Sol", "OpenAI", "openai", "text"],
	["GPT-6 Luna", "OpenAI", "openai", "text"],
	["GPT-Image-2", "OpenAI", "openai", "image", "gpt-image-2"],
	["GPT-Image-2.5 Flare", "OpenAI", "openai", "image"],
	["GPT-Image-2.5 Sunburst", "OpenAI", "openai", "image"],
	["Grok 4.3", "xAI", "xai", "text"],
	["Grok 4.7", "xAI", "xai", "text"],
	["Grok Imagine", "xAI", "xai", "image"],
	["Grok Imagine Video", "xAI", "xai", "video"],
	["Grok Imagine Video 1.5", "xAI", "xai", "video"],
	["Kimi K2.5", "Moonshot", "moonshot", "text"],
	["Seed 2.0 Mini", "ByteDance", "volcengine", "text"],
	["Seed 2.1 Pro", "ByteDance", "volcengine", "text"],
	["Seedream 5.0", "ByteDance", "volcengine", "image"],
	["Seedream 5.0 Pro", "ByteDance", "volcengine", "image"],
	["Seedance 2.0", "ByteDance", "volcengine-ark", "video"],
	["Seedance 2.5", "ByteDance", "volcengine-ark", "video", "doubao-seedance-2-5-260628", "task"],
	["Seedance 2.0 Fast", "ByteDance", "volcengine-ark", "video"],
	["Seedance 2.0 Mini", "ByteDance", "volcengine-ark", "video"],
	["BytePlus Seedance 2.0", "ByteDance", "byteplus", "video"],
	["BytePlus Seedance 2.0 Fast", "ByteDance", "byteplus", "video"],
	["BytePlus Seedance 2.0 Mini", "ByteDance", "byteplus", "video"],
	["Seedance 1.5 Pro", "ByteDance", "volcengine-ark", "video"],
	["Doubao Voice Creation", "ByteDance", "volcengine", "audio"],
	["Doubao TTS v1", "ByteDance", "volcengine", "audio"],
	["Doubao TTS v2", "ByteDance", "volcengine", "audio"],
	["Agnes Image 2.0 Flash", "Agnes", "agnes", "image"],
	["Agnes Image 2.1 Flash", "Agnes", "agnes", "image"],
	["Agnes Image 2.5 Flash", "Agnes", "agnes", "image", "agnes-image-2.5-flash"],
	["Agnes Video 2.5 Flash", "Agnes", "agnes", "video", "agnes-video-2.5-flash", "task"],
	["Qwen Image Edit Plus", "Qwen", "alibaba", "image"],
	["Wan 2.7 Image Pro", "Wan", "alibaba", "image", undefined, "edit"],
	["Z-Image Turbo", "Z-Image", "alibaba", "image"],
	["Wan 2.7", "Wan", "alibaba", "video"],
	["Wan 3.0", "Wan", "alibaba", "video"],
	["Kling 3.0 Omni", "Kling", "kling", "video"],
	["Kling V3", "Kling", "kling", "video"],
	["MiniMax Hailuo 2.3 Fast", "MiniMax", "minimax", "video"],
	["MiniMax H3", "MiniMax", "minimax", "video"],
	["MiniMax H3 Local", "MiniMax", "minimax", "video"],
	["MiniMax Music 2.6", "MiniMax", "minimax", "audio"],
	["MiniMax Speech 2.8 HD", "MiniMax", "minimax", "audio"],
	["MiniMax Speech 2.8 Turbo", "MiniMax", "minimax", "audio"],
	["ElevenLabs Voice Changer", "ElevenLabs", "elevenlabs", "audio"],
	["Eleven Flash v2.5", "ElevenLabs", "elevenlabs", "audio", "eleven_flash_v2_5", "speech"],
	["Eleven Multilingual v2", "ElevenLabs", "elevenlabs", "audio", "eleven_multilingual_v2", "speech"],
	["Fish Audio S1", "Fish Audio", "fish-audio", "audio"],
	["Fish Audio S2 Pro", "Fish Audio", "fish-audio", "audio"],
	["Vidu Q3 Pro", "Vidu", "vidu", "video"],
	["PixVerse V6", "PixVerse", "pixverse", "video"],
	["Midjourney V8.2", "Midjourney", "midjourney", "image"],
	["Banana 2", "Google", "google", "image", "gemini-3.1-flash-image", "generation"],
	["Banana 2 Lite", "Google", "google", "image"],
	["Banana Pro", "Google", "google", "image", "gemini-3-pro-image", "generation"],
	["Happyhorse", "Happyhorse", "happyhorse", "video"],
	["Happyhorse 1.1", "Happyhorse", "happyhorse", "video"],
];

const ADAPTER_READY = new Set([
	"deepseek:DeepSeek V4.1 Flash",
	"openai:GPT-Image-2",
	"volcengine-ark:Seedance 2.5",
	"elevenlabs:Eleven Flash v2.5",
	"elevenlabs:Eleven Multilingual v2",
	...OFFICIAL_TEXT_MODELS.map((model) => `${model.providerId}:${model.name}`),
]);
const PENDING_REASON = "产品目标型号已登记；真实官方 API ID、账户权限或逐项能力尚未完成核验，暂不可用。";

function stableId(name: string): string {
	return `target-${name
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-|-$/gu, "")}`;
}

const MODELS: OfficialProviderCatalogModel[] = TARGETS.map(
	([name, brand, providerId, modelType, apiModelId, operation]) => {
		const route: OfficialProviderCatalogModel["route"] =
			providerId === "agnes" && (name === "Agnes Image 2.5 Flash" || name === "Agnes Video 2.5 Flash")
				? "legacy-agnes"
				: providerId === "volcengine-ark" && name === "Seedance 2.5"
					? "legacy-ark"
					: undefined;
		const implemented = ADAPTER_READY.has(`${providerId}:${name}`) || route === "legacy-agnes";
		const model: OfficialProviderCatalogModel = {
			id: stableId(name),
			name,
			displayName: name,
			providerId,
			modelType,
			apiModelId: apiModelId ?? "",
			implemented,
			enabled: false,
			inputModes:
				modelType === "text" || modelType === "audio"
					? ["text"]
					: providerId === "volcengine-ark" && name === "Seedance 2.5"
						? ["text", "image", "video", "audio"]
						: route === "legacy-agnes"
							? ["text", "image"]
							: modelType === "image" && providerId === "openai"
								? ["text", "image"]
								: ["text"],
			toolCalling: modelType === "text" && providerId === "deepseek",
			streaming: modelType === "text",
			cancellation: false,
			target:
				providerId !== "zhipu" &&
				![
					"GPT-6.1 Sol",
					"Claude Sonnet 5.5",
					"Kimi K3",
					"Kimi K2.7 Code",
					"Kimi K2.7 Code Highspeed",
					"Qwen 3.8 Max",
					"Qwen 3.8 Flash",
					"MiniMax M3",
					"MiniMax Music 3.0",
					"Grok Imagine Image 2.0",
					"Eleven v4",
					"Eleven v4 Turbo",
					"Eleven Music 2.5",
				].includes(name),
			metadataStatus: "unknown",
			contextWindow: modelType === "text" ? 4096 : undefined,
			maxTokens: modelType === "text" ? 1024 : undefined,
			...(operation ? { operation } : {}),
			brand,
			...(route ? { route } : {}),
			...(providerId === "volcengine-ark" ? { brandId: "volcengine" } : {}),
			...(route === "legacy-agnes"
				? modelType === "image"
					? {
							defaults: { size: "2K", ratio: "1:1", count: 1 },
							constraints: {
								acceptedSizes: ["1K", "2K", "3K", "4K"],
								acceptedAspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"],
								maximumOutputs: 4,
							},
						}
					: {
							defaults: { resolution: "720P", ratio: "16:9", duration: 5 },
							constraints: {
								acceptedResolutions: ["720P"],
								acceptedAspectRatios: ["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"],
								minimumDuration: 4,
								maximumDuration: 12,
								maximumReferences: 5,
							},
						}
				: {}),
			...(providerId === "volcengine-ark" && name === "Seedance 2.5"
				? {
						defaults: { resolution: "480p", ratio: "adaptive", duration: 15, generate_audio: true },
						constraints: {
							minimumDuration: 4,
							maximumDuration: 30,
							maximumReferences: 50,
							acceptedResolutions: ["480p", "720p", "1080p"],
							supportsGenerateAudio: true,
							firstLastFrameAspectRatio: "adaptive",
						},
					}
				: {}),
			...(providerId === "openai" && name === "GPT-Image-2"
				? {
						defaults: { size: "1K", ratio: "1:1", count: 1 },
						constraints: {
							maximumReferences: 16,
							maximumOutputs: 4,
							acceptedSizes: ["1K"],
							acceptedAspectRatios: ["1:1", "2:3", "3:2"],
						},
					}
				: {}),
			...(providerId === "alibaba" && modelType === "image"
				? { apiBaseUrl: "https://dashscope.aliyuncs.com/api/v1" }
				: {}),
			...(implemented
				? { unavailableReason: "适配协议及调用 ID 已就绪；仍需用户账户权限和真实请求验证。" }
				: { unavailableReason: PENDING_REASON }),
		};
		if (providerId === "deepseek" && apiModelId === "deepseek-flash") {
			model.contextWindow = 1_000_000;
			model.maxTokens = 8192;
			model.metadataStatus = "verified";
		}
		const text = OFFICIAL_TEXT_MODELS.find(
			(definition) => definition.providerId === providerId && definition.name === name,
		);
		if (text) {
			model.apiModelId = text.apiModelId;
			model.contextWindow = text.contextWindow;
			model.maxTokens = text.maxTokens;
			model.contextMetadataStatus = text.contextMetadataStatus ?? "verified";
			model.maxTokensMetadataStatus = text.maxTokensMetadataStatus ?? "verified";
			model.metadataStatus = "verified";
			model.toolCalling = true;
			model.operation = "chat";
		}
		if (name === "Kimi K2.5") {
			model.apiModelId = "kimi-k2.5";
			model.unavailableReason = "官方已于 2026-08-31 停用 Kimi K2.5，请勿将其他型号映射为此型号。";
		}
		if (name === "Seedance 1.5 Pro") {
			model.apiModelId = "doubao-seedance-1-5-pro-251215";
			model.unavailableReason = "官方已于 2026-09-21 下线该型号，不能替换为其他 Seedance 型号。";
		}
		const unsupportedReasons: Record<string, string> = {
			"Gemini Omni Flash": "尚未核验此展示名称对应的官方视频调用 ID 和请求协议，暂不能启用。",
			"Doubao Voice Creation":
				"声音创建涉及音色槽位、训练、激活及持久音色资产；当前未实现其生命周期与恢复契约，不能以 TTS 或独立 LAS 产品冒充。",
			"MiniMax H3 Local": "当前未实现 H3 的本地模型运行适配；官方云端 Key 不能替代本地运行时。",
			"Midjourney V8.2": "官方未提供公开生成 API，官方条款限制自动化；暂不能启用。",
			Happyhorse: "阿里云官方品牌已核验；此旧型号的精确调用 ID 尚未核验，不能用 1.1 版本代替。",
		};
		if (unsupportedReasons[name]) model.unavailableReason = unsupportedReasons[name];
		const media = OFFICIAL_MEDIA_MODELS[name] ?? ZHIPU_MEDIA_MODELS[name];
		if (media) {
			Object.assign(model, media, {
				implemented: true,
				metadataStatus: "verified",
				unavailableReason: media.unavailableReason ?? "官方协议适配已实现；仍需用户账户权限和真实请求验证。",
			});
			if (!model.operation) model.operation = modelType === "video" ? "task" : "generation";
		}
		return model;
	},
);

/** Product target catalog. Unverified targets remain visible to setup but disabled. */
export function getOfficialProviderCatalog(): {
	providers: OfficialProviderCatalogProvider[];
	models: OfficialProviderCatalogModel[];
} {
	return {
		providers: PROVIDERS.map((provider) => ({
			...provider,
			modalities: [...provider.modalities],
			credentialFields: provider.credentialFields.map((field) => ({ ...field })),
			...(provider.allowedHosts ? { allowedHosts: [...provider.allowedHosts] } : {}),
		})),
		models: MODELS.map((model) => ({ ...model, inputModes: [...model.inputModes] })),
	};
}

export const OFFICIAL_TARGET_COUNTS = Object.freeze({
	total: MODELS.filter((model) => model.target).length,
	text: MODELS.filter((model) => model.target && model.modelType === "text").length,
	image: MODELS.filter((model) => model.target && model.modelType === "image").length,
	video: MODELS.filter((model) => model.target && model.modelType === "video").length,
	audio: MODELS.filter((model) => model.target && model.modelType === "audio").length,
});
