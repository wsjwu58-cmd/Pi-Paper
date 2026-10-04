import { randomUUID } from "node:crypto";
import { getOfficialProviderCatalog } from "./catalog.ts";
import { endpoint, OfficialProviderError, officialJson, requireApiKey, resolveBaseUrl } from "./http.ts";
import { generateOfficialAudio } from "./official-audio.ts";
import { generateOfficialImage } from "./official-images.ts";
import { generateOfficialText } from "./official-text.ts";
import { createKlingAuthorizationToken } from "./official-video-kling.ts";
import { generateOfficialVideo } from "./official-videos.ts";
import type { OfficialGenerationInput, OfficialGenerationOptions, OfficialGenerationResult } from "./types.ts";

export { getOfficialProviderCatalog, OFFICIAL_TARGET_COUNTS } from "./catalog.ts";
export { OfficialProviderError } from "./http.ts";
export { generateOfficialAudio } from "./official-audio.ts";
export { generateOfficialImage } from "./official-images.ts";
export { resolveOfficialTextModel } from "./official-text.ts";
export { generateOfficialVideo } from "./official-videos.ts";
export type {
	OfficialGenerationInput,
	OfficialGenerationOptions,
	OfficialGenerationResult,
	OfficialMediaOutput,
	OfficialMediaReference,
	OfficialModality,
} from "./types.ts";

/**
 * Dispatch only the protocol/model families implemented by this package.
 * Catalog entries marked legacy-agnes are intentionally handled by the desktop
 * compatibility boundary, not by a guessed Pi provider protocol.
 */
export async function executeOfficialGeneration(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
): Promise<OfficialGenerationResult> {
	if (!input.modelId.trim() || (!input.prompt.trim() && input.operation !== "voice-change")) {
		throw new OfficialProviderError("INVALID_GENERATION_INPUT", "A model and prompt are required.");
	}
	const modelOptions = input.apiBaseUrl ? { ...options, baseUrl: input.apiBaseUrl } : options;
	switch (input.modality) {
		case "text": {
			const result = await generateOfficialText(input, modelOptions);
			return { text: result.text, ...(result.usage ? { usage: result.usage } : {}) };
		}
		case "image":
			return generateOfficialImage(input, modelOptions);
		case "audio":
			return generateOfficialAudio(input, modelOptions);
		case "video":
			return generateOfficialVideo(input, modelOptions);
		default:
			throw new OfficialProviderError(
				"UNSUPPORTED_MODALITY",
				`Official ${String(input.modality)} generation is not implemented.`,
			);
	}
}

/**
 * Verify credentials with documented, non-generating endpoints. Providers
 * without a safe authenticated probe are explicitly reported as unsupported.
 */
export async function testOfficialProviderConnection(
	providerId: string,
	options: OfficialGenerationOptions,
): Promise<{ status: "connected" | "unsupported"; success: boolean; models?: string[]; message: string }> {
	const catalog = getOfficialProviderCatalog();
	const provider = catalog.providers.find((item) => item.id === providerId);
	if (!provider) throw new OfficialProviderError("UNSUPPORTED_PROVIDER", `Unknown provider: ${providerId}.`);
	if (!provider.configurable)
		throw new OfficialProviderError("UNSUPPORTED_PROVIDER", "This provider adapter is not available.");
	const probe = provider.connectionTest;
	if (probe.kind === "format-only") {
		return {
			status: "unsupported",
			success: false,
			message: "该提供方暂没有已核实的安全鉴权检测接口；未发送请求，当前无法确认 Key 是否有效。",
		};
	}
	const baseUrl = resolveBaseUrl(options, provider.baseUrl, providerId);
	if (probe.kind === "kling-task-list") {
		const credentials = { ...(options.credentials ?? {}) };
		const hasNestedApiKey = typeof credentials.apiKey === "string" && Boolean(credentials.apiKey.trim());
		const hasNestedLegacy = Boolean(credentials.accessKey?.trim()) || Boolean(credentials.secretKey?.trim());
		if (hasNestedApiKey && options.apiKey && options.apiKey !== credentials.apiKey) {
			throw new OfficialProviderError("API_CREDENTIALS_INVALID", "Kling 顶层 API Key 与凭据中的 API Key 不一致。");
		}
		if (!hasNestedApiKey && !hasNestedLegacy && options.apiKey) credentials.apiKey = options.apiKey;
		const hasApiKey = Boolean(credentials.apiKey?.trim());
		const hasAccessKey = Boolean(credentials.accessKey?.trim());
		const hasSecretKey = Boolean(credentials.secretKey?.trim());
		if (hasAccessKey !== hasSecretKey || (hasApiKey && (hasAccessKey || hasSecretKey))) {
			throw new OfficialProviderError(
				"API_CREDENTIALS_INVALID",
				"Kling 请使用单独的新版 API Key，或同时填写旧版 Access Key 与 Secret Key。",
			);
		}
		if (!hasApiKey && !hasAccessKey) {
			throw new OfficialProviderError("API_KEY_REQUIRED", "请填写 Kling API Key，或填写完整的旧版 AK/SK。");
		}
		const token = createKlingAuthorizationToken(credentials);
		const response = await officialJson<Record<string, unknown>>(
			endpoint(baseUrl, "v1/videos/text2video?pageNum=1&pageSize=1"),
			{ method: "GET", headers: { Authorization: `Bearer ${token}` } },
			options,
			token,
			1024 * 1024,
		);
		if (response.code !== 0 || !Array.isArray(response.data)) {
			throw new OfficialProviderError(
				"INVALID_PROVIDER_RESPONSE",
				"Kling returned an unexpected task-list response.",
			);
		}
		return { status: "connected", success: true, models: [], message: "官方已接受凭据；未创建生成任务。" };
	}
	if (probe.kind === "ark-task-list") {
		const key = requireApiKey(options, providerId);
		const response = await officialJson<unknown>(
			endpoint(baseUrl, "contents/generations/tasks?page_num=1&page_size=1"),
			{ method: "GET", headers: { Authorization: `Bearer ${key}` } },
			options,
			key,
			1024 * 1024,
		);
		if (!isRecord(response) || !Array.isArray(response.items)) {
			throw new OfficialProviderError("INVALID_PROVIDER_RESPONSE", "火山方舟返回了无法识别的任务列表响应。");
		}
		return { status: "connected", success: true, models: [], message: "官方已接受凭据；未创建生成任务。" };
	}
	const key = requireApiKey(options, providerId);

	const pathMode = probe.kind === "models-list" || probe.kind === "account-check" ? probe.pathMode : undefined;
	const requestUrl =
		pathMode === "origin"
			? new URL(probe.path, `${new URL(baseUrl).origin}/`).toString()
			: endpoint(baseUrl, probe.path);
	const headers: Record<string, string> = {};
	switch (probe.auth) {
		case "bearer":
			headers.Authorization = `Bearer ${key}`;
			break;
		case "anthropic-key":
			headers["x-api-key"] = key;
			headers["anthropic-version"] = "2023-06-01";
			break;
		case "google-key":
			headers["x-goog-api-key"] = key;
			break;
		case "elevenlabs-key":
			headers["xi-api-key"] = key;
			break;
		case "vidu-token":
			headers.Authorization = `Token ${key}`;
			break;
		case "pixverse-key":
			headers["API-KEY"] = key;
			headers["Ai-trace-id"] = randomUUID();
			break;
	}
	const response = await officialJson<unknown>(requestUrl, { method: "GET", headers }, options, key, 1024 * 1024);
	if (probe.kind === "account-check") {
		const record = isRecord(response) ? response : undefined;
		const baseResp = isRecord(record?.base_resp) ? record.base_resp : undefined;
		const valid =
			probe.response === "vidu-credits"
				? Array.isArray(record?.remains) || Array.isArray(record?.remaining_credits)
				: probe.response === "pixverse-balance"
					? record?.ErrCode === 0 && isRecord(record.Resp)
					: probe.response === "elevenlabs-user"
						? typeof record?.user_id === "string" && record.user_id.length > 0
						: baseResp?.status_code === 0 && Array.isArray(record?.files);
		if (!valid)
			throw new OfficialProviderError(
				"INVALID_PROVIDER_RESPONSE",
				"The provider returned an unexpected account-check response.",
			);
		return { status: "connected", success: true, message: "官方已接受凭据；未创建生成任务。" };
	}
	if (probe.kind !== "models-list")
		throw new OfficialProviderError("UNSUPPORTED_PROVIDER", "此提供方暂不支持连接检测。");
	if (probe.envelope === "openai-list" && (!isRecord(response) || response.object !== "list")) {
		throw new OfficialProviderError(
			"INVALID_PROVIDER_RESPONSE",
			"The provider returned an unexpected model-list envelope.",
		);
	}
	const list = readModelList(response, probe.listField);
	if (!list)
		throw new OfficialProviderError(
			"INVALID_PROVIDER_RESPONSE",
			"The provider returned an unexpected model-list response.",
		);
	const modelIds = list.map((model) => (isRecord(model) ? model[probe.idField] : undefined));
	if (modelIds.some((modelId) => typeof modelId !== "string" || modelId.length === 0)) {
		throw new OfficialProviderError(
			"INVALID_PROVIDER_RESPONSE",
			"The provider returned an invalid model-list entry.",
		);
	}
	const models = modelIds.map((modelId) => (modelId as string).slice(0, 200)).slice(0, 100);
	return { status: "connected", success: true, models, message: "官方已接受凭据；未发送生成请求。" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readModelList(value: unknown, field: "data" | "models" | "items" | "root"): unknown[] | undefined {
	if (field === "root") return Array.isArray(value) ? value : undefined;
	if (!isRecord(value)) return undefined;
	const list = value[field];
	return Array.isArray(list) ? list : undefined;
}
