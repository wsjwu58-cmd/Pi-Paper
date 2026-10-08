import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { endpoint, jsonHeaders, OfficialProviderError, officialJson } from "./http.ts";
import type { OfficialGenerationInput, OfficialGenerationOptions, OfficialGenerationResult } from "./types.ts";

const DEFAULT_TASK_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_QUERY_FAILURES = 5;

export type OfficialVideoRuntimeOptions = OfficialGenerationOptions & {
	pollIntervalMs?: number;
	taskTimeoutMs?: number;
	now?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
	resolveOutputHost?: (hostname: string) => Promise<Array<string | { address: string }>>;
};

export interface OfficialVideoTaskProtocol<TCreated, TTask> {
	providerName: string;
	baseUrl: string;
	submitPath: string;
	queryPath: (taskId: string) => string;
	request: unknown;
	pollIntervalMs: number;
	submitHeaders: (apiKey: string) => Record<string, string>;
	queryHeaders: (apiKey: string) => Record<string, string>;
	readTaskId: (payload: TCreated) => unknown;
	readTask: (payload: TTask) => { status: unknown; videoUrl?: unknown };
	activeStatuses: readonly string[];
	succeededStatuses: readonly string[];
	failedStatuses: readonly string[];
}

/**
 * Shared checkpointed submit/poll flow for official asynchronous video APIs.
 * Existing task IDs are query-only; a POST is never retried.
 */
export async function runOfficialVideoTask<TCreated, TTask>(
	input: OfficialGenerationInput,
	options: OfficialGenerationOptions,
	apiKey: string,
	protocol: OfficialVideoTaskProtocol<TCreated, TTask>,
): Promise<OfficialGenerationResult> {
	const runtime = options as OfficialVideoRuntimeOptions;
	let taskId =
		input.remoteTaskId === undefined ? undefined : normalizeTaskId(input.remoteTaskId, protocol.providerName);
	if (!taskId) {
		if (typeof options.onSubmitting !== "function" || typeof options.onSubmitted !== "function") {
			throw new OfficialProviderError(
				"TASK_CHECKPOINT_REQUIRED",
				`${protocol.providerName} video submission requires durable checkpoints before and after POST.`,
			);
		}
		throwIfAborted(options.signal, protocol.providerName);
		await options.onSubmitting();
		throwIfAborted(options.signal, protocol.providerName);

		let created: TCreated;
		try {
			created = await officialJson<TCreated>(
				endpoint(protocol.baseUrl, protocol.submitPath),
				{ method: "POST", headers: protocol.submitHeaders(apiKey), body: JSON.stringify(protocol.request) },
				options,
				apiKey,
			);
		} catch (error) {
			throw safeProviderError(error, protocol.providerName);
		}
		taskId = normalizeTaskId(protocol.readTaskId(created), protocol.providerName);
		// This must finish before the first status query. Persistence failures must not
		// cause a second billable submission or hide an uncheckpointed task.
		await options.onSubmitted(taskId);
	}

	const now = runtime.now ?? Date.now;
	const sleep = runtime.sleep ?? defaultSleep;
	const deadline = now() + (runtime.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS);
	let lastStatus = "unknown";
	while (now() < deadline) {
		const pause = Math.min(runtime.pollIntervalMs ?? protocol.pollIntervalMs, Math.max(0, deadline - now()));
		if (pause > 0) await sleepOrAbort(pause, sleep, options.signal, protocol.providerName);
		throwIfAborted(options.signal, protocol.providerName);

		let payload: TTask;
		try {
			payload = await queryWithTransientRetry(taskId, options, apiKey, protocol, deadline, now, sleep);
		} catch (error) {
			throw safeProviderError(error, protocol.providerName);
		}
		const result = protocol.readTask(payload);
		lastStatus = normalizeStatus(result.status);
		if (protocol.succeededStatuses.includes(lastStatus)) {
			if (typeof result.videoUrl !== "string" || !result.videoUrl.trim()) {
				throw new OfficialProviderError(
					"EMPTY_PROVIDER_RESPONSE",
					`${protocol.providerName} completed the task without a video URL.`,
				);
			}
			const url = await validatePublicVideoUrl(result.videoUrl, runtime);
			return {
				outputs: [{ url, mimeType: "video/mp4" }],
				remoteTaskId: taskId,
				status: "succeeded",
			};
		}
		if (protocol.failedStatuses.includes(lastStatus)) {
			throw new OfficialProviderError(
				"GENERATION_FAILED",
				`${protocol.providerName} video generation ended with status ${lastStatus}.`,
			);
		}
		if (!protocol.activeStatuses.includes(lastStatus)) {
			throw new OfficialProviderError(
				"INVALID_PROVIDER_RESPONSE",
				`${protocol.providerName} returned an unrecognized video task status.`,
			);
		}
	}
	throw new OfficialProviderError(
		"REQUEST_TIMEOUT",
		`${protocol.providerName} video task timed out (last status: ${lastStatus}).`,
	);
}

async function queryWithTransientRetry<TCreated, TTask>(
	taskId: string,
	options: OfficialGenerationOptions,
	apiKey: string,
	protocol: OfficialVideoTaskProtocol<TCreated, TTask>,
	deadline: number,
	now: () => number,
	sleep: (milliseconds: number) => Promise<void>,
): Promise<TTask> {
	let failures = 0;
	while (true) {
		throwIfAborted(options.signal, protocol.providerName);
		try {
			return await officialJson<TTask>(
				endpoint(protocol.baseUrl, protocol.queryPath(taskId)),
				{ method: "GET", headers: protocol.queryHeaders(apiKey) },
				options,
				apiKey,
			);
		} catch (error) {
			if (!isTransientQueryError(error) || failures >= MAX_QUERY_FAILURES) throw error;
			const delay = Math.min(1_000 * 2 ** failures, 8_000, Math.max(0, deadline - now()));
			if (delay <= 0) throw error;
			failures += 1;
			await sleepOrAbort(delay, sleep, options.signal, protocol.providerName);
		}
	}
}

function isTransientQueryError(error: unknown): boolean {
	if (!(error instanceof OfficialProviderError)) return false;
	return (
		error.code === "NETWORK_ERROR" ||
		error.status === 408 ||
		error.status === 425 ||
		error.status === 429 ||
		(error.status !== undefined && error.status >= 500)
	);
}

function safeProviderError(error: unknown, providerName: string): OfficialProviderError {
	if (!(error instanceof OfficialProviderError)) {
		return new OfficialProviderError("NETWORK_ERROR", `${providerName} request failed.`);
	}
	if (error.code === "REQUEST_ABORTED") {
		return new OfficialProviderError("REQUEST_ABORTED", `The ${providerName} request was cancelled.`);
	}
	if (error.code === "REQUEST_TIMEOUT") {
		return new OfficialProviderError("REQUEST_TIMEOUT", `The ${providerName} request timed out.`);
	}
	if (error.code === "PROVIDER_HTTP_ERROR") {
		return new OfficialProviderError(
			error.code,
			`${providerName} request failed${error.status ? ` (${error.status})` : ""}.`,
			error.status,
		);
	}
	if (error.code === "NETWORK_ERROR") {
		return new OfficialProviderError(error.code, `${providerName} network request failed.`);
	}
	return new OfficialProviderError(error.code, `${providerName} request failed.`, error.status);
}

function normalizeTaskId(value: unknown, providerName: string): string {
	const candidate = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
	if (!candidate || candidate.length > 200 || !/^[A-Za-z0-9._:-]+$/u.test(candidate)) {
		throw new OfficialProviderError(
			"INVALID_PROVIDER_RESPONSE",
			`${providerName} did not return a valid video task ID.`,
		);
	}
	return candidate;
}

function normalizeStatus(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function throwIfAborted(signal: AbortSignal | undefined, providerName: string): void {
	if (signal?.aborted)
		throw new OfficialProviderError("REQUEST_ABORTED", `The ${providerName} request was cancelled.`);
}

async function sleepOrAbort(
	milliseconds: number,
	sleep: (milliseconds: number) => Promise<void>,
	signal: AbortSignal | undefined,
	providerName: string,
): Promise<void> {
	throwIfAborted(signal, providerName);
	if (!signal) {
		await sleep(milliseconds);
		return;
	}
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<void>((resolve) => {
		onAbort = () => resolve();
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		await Promise.race([sleep(milliseconds), aborted]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
	throwIfAborted(signal, providerName);
}

async function validatePublicVideoUrl(value: string, runtime: OfficialVideoRuntimeOptions): Promise<string> {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new OfficialProviderError(
			"INVALID_PROVIDER_RESPONSE",
			"The video provider returned an invalid output URL.",
		);
	}
	const hostname = url.hostname
		.replace(/^\[|\]$/gu, "")
		.toLowerCase()
		.replace(/\.$/u, "");
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		!hostname ||
		(url.port && url.port !== "443") ||
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal") ||
		hostname.endsWith(".test") ||
		hostname.endsWith(".invalid") ||
		(isIP(hostname) !== 0 && !isPublicAddress(hostname))
	) {
		throw new OfficialProviderError(
			"INVALID_PROVIDER_RESPONSE",
			"The video provider returned a non-public HTTPS output URL.",
		);
	}
	const resolver = runtime.resolveOutputHost ?? resolveOutputHost;
	let addresses: Array<string | { address: string }>;
	try {
		addresses = await resolver(hostname);
	} catch {
		throw new OfficialProviderError(
			"INVALID_PROVIDER_RESPONSE",
			"The video output host could not be verified as public.",
		);
	}
	if (
		!addresses.length ||
		addresses.some((entry) => !isPublicAddress(typeof entry === "string" ? entry : entry.address))
	) {
		throw new OfficialProviderError(
			"INVALID_PROVIDER_RESPONSE",
			"The video output host resolved to a non-public address.",
		);
	}
	return url.toString();
}

async function resolveOutputHost(hostname: string): Promise<Array<string | { address: string }>> {
	return lookup(hostname, { all: true, verbatim: true });
}

function isPublicAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) {
		const octets = address.split(".").map(Number);
		const [a, b, c] = octets;
		if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
		if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
		if (a === 100 && b >= 64 && b <= 127) return false;
		if (a === 169 && b === 254) return false;
		if (a === 172 && b >= 16 && b <= 31) return false;
		if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) return false;
		if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
		if (a === 203 && b === 0 && c === 113) return false;
		return true;
	}
	if (family === 6) {
		const normalized = address.toLowerCase().split("%", 1)[0];
		const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
		return (
			first >= 0x2000 &&
			first <= 0x3fff &&
			!normalized.startsWith("2001:db8:") &&
			!normalized.startsWith("2001:0000:") &&
			!normalized.startsWith("2001:0:")
		);
	}
	return false;
}

function defaultSleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Build the standard task protocol headers without putting keys in URLs. */
export function videoJsonHeaders(apiKey: string, extras?: Record<string, string>): Record<string, string> {
	return jsonHeaders(apiKey, extras);
}
