import type { AgentOptions } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

/** Retry one model request, never the Agent turn or its completed tools. */
export function withModelStreamRetry(
	stream: AgentOptions["streamFn"],
	settings: {
		maxRetries?: number;
		firstOutputTimeoutMs?: number;
		baseDelayMs?: number;
		onRetry?: (attempt: number, delayMs: number) => void | Promise<void>;
	} = {},
): AgentOptions["streamFn"] {
	return (model, context, options) => {
		const output = createAssistantMessageEventStream();
		const emptyMessage = (): AssistantMessage => ({
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			timestamp: Date.now(),
		});
		void (async () => {
			let lastError = emptyMessage();
			try {
				for (let attempt = 0; attempt <= (settings.maxRetries ?? 2); attempt++) {
					if (options?.signal?.aborted) throw new Error("Request aborted");
					const controller = new AbortController();
					const abort = () => controller.abort();
					options?.signal?.addEventListener("abort", abort, { once: true });
					let timedOut = false;
					let emitted = false;
					let start: Extract<AssistantMessageEvent, { type: "start" }> | undefined;
					const timer = setTimeout(() => {
						timedOut = true;
						controller.abort();
					}, settings.firstOutputTimeoutMs ?? 60_000);
					try {
						// Disable nested SDK retries so the request count stays bounded.
						const upstream = await stream(model, context, {
							...options,
							signal: controller.signal,
							maxRetries: 0,
						});
						for await (const event of upstream) {
							if (options?.signal?.aborted) throw new Error("Request aborted");
							if (timedOut && event.type !== "error") throw new Error("Model response timeout");
							if (event.type === "start") {
								start = event;
								continue;
							}
							if (event.type === "error") {
								lastError =
									timedOut && !options?.signal?.aborted
										? { ...event.error, stopReason: "error", errorMessage: "Model response timeout" }
										: event.error;
								if (emitted) {
									output.push({
										...event,
										reason: lastError.stopReason === "aborted" ? "aborted" : "error",
										error: lastError,
									});
									return;
								}
								break;
							}
							emitted = true;
							clearTimeout(timer);
							if (start) {
								output.push(start);
								start = undefined;
							}
							output.push(event);
							if (event.type === "done") return;
						}
						if (emitted) throw new Error("Connection closed during model response");
					} catch (error) {
						lastError = {
							...lastError,
							stopReason: "error",
							errorMessage: timedOut
								? "Model response timeout"
								: error instanceof Error
									? error.message
									: "Model request failed",
						};
						if (emitted) throw error;
					} finally {
						clearTimeout(timer);
						options?.signal?.removeEventListener("abort", abort);
					}
					const message = lastError.errorMessage ?? "";
					const permanent =
						/\b(?:400|401|403|404|422)\b|invalid.?api.?key|authentication|permission|insufficient.quota|billing|credit|certificate|ENOTFOUND/i.test(
							message,
						);
					const transient =
						/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|connection|network|socket|\b(?:408|429|500|502|503|504)\b|overloaded/i.test(
							message,
						);
					if (
						options?.signal?.aborted ||
						lastError.stopReason === "aborted" ||
						permanent ||
						!transient ||
						lastError.content.length > 0 ||
						lastError.usage.totalTokens > 0 ||
						attempt >= (settings.maxRetries ?? 2)
					)
						break;
					const delayMs = (settings.baseDelayMs ?? 1_000) * 2 ** attempt;
					await settings.onRetry?.(attempt + 1, delayMs);
					await new Promise<void>((resolve, reject) => {
						const cancel = () => {
							clearTimeout(wait);
							reject(new Error("Request aborted"));
						};
						const wait = setTimeout(() => {
							options?.signal?.removeEventListener("abort", cancel);
							resolve();
						}, delayMs);
						if (options?.signal?.aborted) cancel();
						else options?.signal?.addEventListener("abort", cancel, { once: true });
					});
				}
			} catch (error) {
				lastError = { ...lastError, errorMessage: error instanceof Error ? error.message : "Model request failed" };
			}
			const aborted = options?.signal?.aborted === true;
			output.push({
				type: "error",
				reason: aborted ? "aborted" : "error",
				error: { ...lastError, stopReason: aborted ? "aborted" : "error" },
			});
		})().finally(() => output.end());
		return output;
	};
}
