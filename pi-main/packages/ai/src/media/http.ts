import type { OfficialGenerationOptions } from "./types.ts";

export class OfficialProviderError extends Error {
	readonly code: string;
	readonly status?: number;

	constructor(code: string, message: string, status?: number, options?: ErrorOptions) {
		super(message, options);
		this.name = "OfficialProviderError";
		this.code = code;
		this.status = status;
	}
}

export function requireApiKey(options: OfficialGenerationOptions, providerId: string): string {
	const key = options.apiKey ?? options.credentials?.apiKey ?? options.credentials?.api_key;
	if (typeof key !== "string" || key.trim().length === 0) {
		throw new OfficialProviderError("API_KEY_REQUIRED", `Configure an API key for ${providerId}.`);
	}
	return key;
}

export function resolveBaseUrl(options: OfficialGenerationOptions, defaultBaseUrl: string, providerId: string): string {
	const value = options.baseUrl ?? defaultBaseUrl;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new OfficialProviderError("INVALID_BASE_URL", `The ${providerId} API URL is invalid.`);
	}
	if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new OfficialProviderError(
			"INVALID_BASE_URL",
			`The ${providerId} API URL must be an HTTP(S) URL without credentials or query parameters.`,
		);
	}
	if (!options.fetch && url.protocol !== "https:") {
		throw new OfficialProviderError("INVALID_BASE_URL", `The ${providerId} API URL must use HTTPS.`);
	}
	if (
		!options.fetch &&
		((url.port && url.port !== "443") ||
			!isAllowedOfficialHost(providerId, url.hostname.toLowerCase(), options.credentials))
	) {
		throw new OfficialProviderError(
			"INVALID_BASE_URL",
			`The ${providerId} API host is not an approved official endpoint.`,
		);
	}
	return url.toString().replace(/\/$/u, "");
}

function isAllowedOfficialHost(providerId: string, hostname: string, credentials?: Record<string, string>): boolean {
	if (providerId === "alibaba-video") {
		const workspace = credentials?.workspaceId;
		const region = credentials?.region;
		return Boolean(
			workspace &&
				/^[a-z0-9][a-z0-9-]{0,62}$/u.test(workspace) &&
				region &&
				["cn-beijing", "ap-southeast-1", "ap-northeast-1", "eu-central-1", "us-east-1", "cn-hongkong"].includes(
					region,
				) &&
				hostname === `${workspace}.${region}.maas.aliyuncs.com`,
		);
	}
	const hosts: Record<string, string[]> = {
		openai: ["api.openai.com"],
		anthropic: ["api.anthropic.com"],
		google: ["generativelanguage.googleapis.com"],
		deepseek: ["api.deepseek.com"],
		moonshot: ["api.moonshot.ai", "api.moonshot.cn"],
		xai: ["api.x.ai"],
		volcengine: ["ark.cn-beijing.volces.com", "ark.cn-shanghai.volces.com", "ark.us-east-1.volces.com"],
		"volcengine-ark": ["ark.cn-beijing.volces.com", "ark.cn-shanghai.volces.com", "ark.us-east-1.volces.com"],
		byteplus: ["ark.ap-southeast.bytepluses.com", "ark.us-east-1.bytepluses.com"],
		doubao: ["ark.cn-beijing.volces.com"],
		alibaba: ["dashscope.aliyuncs.com"],
		minimax: ["api.minimax.io", "api.minimax.chat"],
		agnes: ["apihub.agnes-ai.com"],
		elevenlabs: ["api.elevenlabs.io"],
		"fish-audio": ["api.fish.audio"],
		"doubao-voice": ["openspeech.bytedance.com"],
		"doubao-voice-v1": ["openspeech.bytedance.com"],
		kling: ["api-singapore.klingai.com"],
		vidu: ["api.vidu.com"],
		pixverse: ["app-api.pixverse.ai"],
	};
	return hosts[providerId]?.includes(hostname) ?? false;
}

/** Append a provider-relative path to an API root while preserving a custom regional prefix. */
export function endpoint(baseUrl: string, relativePath: string): string {
	return `${baseUrl.replace(/\/$/u, "")}/${relativePath.replace(/^\//u, "")}`;
}

export function redactSecret(message: string, apiKey?: string): string {
	let result = message;
	if (apiKey) result = result.split(apiKey).join("[redacted]");
	return result
		.replace(/\bBearer\s+[^\s,;"']+/giu, "Bearer [redacted]")
		.replace(/\b(xi-api-key|x-api-key|api-key)\s*[:=]\s*[^\s,;"']+/giu, "$1=[redacted]");
}

function createRequestSignal(parent: AbortSignal | undefined, timeoutMs: number | undefined) {
	if (parent?.aborted) return { signal: parent, dispose: () => undefined };
	if (timeoutMs === undefined || timeoutMs <= 0) return { signal: parent, dispose: () => undefined };
	const controller = new AbortController();
	const onAbort = () => controller.abort(parent?.reason);
	parent?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onAbort);
		},
	};
}

export async function officialFetch(
	input: string | URL,
	init: RequestInit,
	options: OfficialGenerationOptions,
	apiKey?: string,
): Promise<Response> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const requestSignal = createRequestSignal(options.signal, options.timeoutMs ?? 180_000);
	let disposeOnExit = true;
	try {
		const response = await fetchImpl(input, {
			...init,
			redirect: "error",
			...(requestSignal.signal ? { signal: requestSignal.signal } : {}),
		});
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel().catch(() => undefined);
			throw new OfficialProviderError(
				"PROVIDER_REDIRECT_BLOCKED",
				"The provider redirected the request; redirects are blocked to protect credentials.",
				response.status,
			);
		}
		if (!response.ok) {
			const body = await readResponseText(response, 16 * 1024);
			throw responseError(response.status, body, apiKey);
		}
		if (!response.body) {
			requestSignal.dispose();
			disposeOnExit = false;
			return response;
		}
		disposeOnExit = false;
		return keepSignalUntilBodyConsumed(response, requestSignal.dispose);
	} catch (error) {
		if (error instanceof OfficialProviderError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		if (requestSignal.signal?.aborted && options.signal?.aborted) {
			throw new OfficialProviderError("REQUEST_ABORTED", "The provider request was cancelled.", undefined, {
				cause: error,
			});
		}
		if (requestSignal.signal?.aborted) {
			throw new OfficialProviderError("REQUEST_TIMEOUT", "The provider request timed out.", undefined, {
				cause: error,
			});
		}
		throw new OfficialProviderError("NETWORK_ERROR", redactSecret(message, apiKey), undefined, { cause: error });
	} finally {
		if (disposeOnExit) requestSignal.dispose();
	}
}

function keepSignalUntilBodyConsumed(response: Response, dispose: () => void): Response {
	const reader = response.body!.getReader();
	let closed = false;
	const finish = () => {
		if (!closed) {
			closed = true;
			dispose();
		}
	};
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await reader.read();
				if (next.done) {
					finish();
					controller.close();
				} else controller.enqueue(next.value);
			} catch (error) {
				finish();
				controller.error(error);
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason);
			} finally {
				finish();
			}
		},
	});
	return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		await response.body?.cancel().catch(() => undefined);
		throw new OfficialProviderError(
			"RESPONSE_TOO_LARGE",
			"The provider response exceeded the allowed size.",
			response.status,
		);
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new OfficialProviderError(
					"RESPONSE_TOO_LARGE",
					"The provider response exceeded the allowed size.",
					response.status,
				);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
	try {
		return new TextDecoder().decode(await readResponseBytes(response, maxBytes)).slice(0, maxBytes);
	} catch (error) {
		if (error instanceof OfficialProviderError && error.code === "RESPONSE_TOO_LARGE")
			return "Provider error response exceeded the safe display limit.";
		throw error;
	}
}

export async function officialBytes(
	input: string | URL,
	init: RequestInit,
	options: OfficialGenerationOptions,
	apiKey?: string,
	maxBytes = 128 * 1024 * 1024,
): Promise<{ bytes: Uint8Array; response: Response }> {
	const response = await officialFetch(input, init, options, apiKey);
	try {
		return { bytes: await readResponseBytes(response, maxBytes), response };
	} catch (error) {
		throw mapBodyReadError(error, options, apiKey);
	}
}

export async function officialJson<T>(
	input: string | URL,
	init: RequestInit,
	options: OfficialGenerationOptions,
	apiKey?: string,
	maxBytes = 128 * 1024 * 1024,
): Promise<T> {
	const response = await officialFetch(input, init, options, apiKey);
	let bytes: Uint8Array;
	try {
		bytes = await readResponseBytes(response, maxBytes);
	} catch (error) {
		throw mapBodyReadError(error, options, apiKey);
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as T;
	} catch (error) {
		throw new OfficialProviderError(
			"INVALID_PROVIDER_RESPONSE",
			"The provider returned an invalid JSON response.",
			response.status,
			{ cause: error },
		);
	}
}

function mapBodyReadError(error: unknown, options: OfficialGenerationOptions, apiKey?: string): OfficialProviderError {
	if (error instanceof OfficialProviderError) return error;
	if (options.signal?.aborted)
		return new OfficialProviderError("REQUEST_ABORTED", "The provider request was cancelled.", undefined, {
			cause: error,
		});
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
		return new OfficialProviderError("REQUEST_TIMEOUT", "The provider request timed out.", undefined, {
			cause: error,
		});
	}
	const message = error instanceof Error ? error.message : String(error);
	return new OfficialProviderError("NETWORK_ERROR", redactSecret(message, apiKey), undefined, { cause: error });
}

export function responseError(status: number, body: string, apiKey?: string): OfficialProviderError {
	let detail = body;
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		const error = parsed.error;
		if (typeof error === "string") detail = error;
		else if (error && typeof error === "object") {
			const record = error as Record<string, unknown>;
			detail =
				([record.message, record.code, parsed.message].find((value) => typeof value === "string") as
					| string
					| undefined) ?? body;
		} else if (typeof parsed.message === "string") detail = parsed.message;
	} catch {
		// Keep short text responses useful; do not include arbitrary response headers.
	}
	return new OfficialProviderError(
		"PROVIDER_HTTP_ERROR",
		`Provider request failed (${status})${detail ? `: ${redactSecret(detail.slice(0, 800), apiKey)}` : "."}`,
		status,
	);
}

export function jsonHeaders(apiKey: string, extras?: Record<string, string>): Record<string, string> {
	return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...extras };
}

export function safeBase64(value: string, label: string): Uint8Array {
	const payload = value.replace(/^data:[^;,]+;base64,/iu, "");
	if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(payload) || payload.length % 4 === 1) {
		throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", `${label} is not valid base64 media.`);
	}
	const bytes = Buffer.from(payload, "base64");
	if (bytes.length === 0 || bytes.length > 40 * 1024 * 1024) {
		throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", `${label} must be between 1 byte and 40 MB.`);
	}
	return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function referenceValue(reference: { url?: string; base64?: string; mimeType?: string }, label: string): string {
	if (reference.url) {
		let url: URL;
		try {
			url = new URL(reference.url);
		} catch {
			throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", `${label} URL is invalid.`);
		}
		if (url.protocol !== "https:") {
			throw new OfficialProviderError(
				"INVALID_MEDIA_REFERENCE",
				`${label} must use an HTTPS URL or validated base64 data.`,
			);
		}
		return url.toString();
	}
	if (reference.base64) {
		const mimeType = reference.mimeType ?? "image/png";
		if (!/^(image|audio|video)\/[a-z0-9.+-]+$/iu.test(mimeType)) {
			throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", `${label} has an unsupported MIME type.`);
		}
		const payload = reference.base64.replace(/^data:[^;,]+;base64,/iu, "");
		safeBase64(payload, label);
		return `data:${mimeType};base64,${payload}`;
	}
	throw new OfficialProviderError("INVALID_MEDIA_REFERENCE", `${label} is missing its media data.`);
}

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
	return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64");
}

export function pickString(params: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = params?.[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

export function pickBoolean(params: Record<string, unknown> | undefined, key: string): boolean | undefined {
	const value = params?.[key];
	return typeof value === "boolean" ? value : undefined;
}
