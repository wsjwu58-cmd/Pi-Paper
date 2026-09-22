import type { AgentRunEvent } from "../domain/agent-run.ts";

/** Parse the timestamp formats accepted from the approval event payload. */
export function parseConfirmationExpiry(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value))
		return value < 1_000_000_000_000 ? value * 1000 : value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	if (!normalized) return undefined;
	if (/^\d+(?:\.\d+)?$/.test(normalized)) {
		const numeric = Number(normalized);
		if (!Number.isFinite(numeric)) return undefined;
		return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
	}
	const parsed = Date.parse(normalized);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * A waiting-confirmation run must not strand a session after its token expires.
 * Legacy events without an expiry use the run's last update plus the configured
 * approval TTL as a conservative fallback.
 */
export function isExpiredConfirmation(
	events: readonly AgentRunEvent[],
	runUpdatedAt: Date,
	now = Date.now(),
	ttlMs = 300_000,
): boolean {
	const event = [...events].reverse().find((candidate) => candidate.type === "confirmation_required");
	if (!event) return false;
	const expiresAt = parseConfirmationExpiry(event.data.expiresAt);
	const fallbackExpiry = runUpdatedAt.getTime() + ttlMs;
	return (expiresAt ?? fallbackExpiry) <= now;
}
