import { describe, expect, it } from "vitest";
import { isExpiredConfirmation, parseConfirmationExpiry } from "../src/application/confirmation-expiry.ts";

const updatedAt = new Date("2026-09-22T12:00:00.000Z");
const expiresAt = Date.parse("2026-09-22T12:01:00.000Z");

describe("confirmation expiry", () => {
	it("parses millisecond, second, and ISO timestamps", () => {
		expect(parseConfirmationExpiry(expiresAt)).toBe(expiresAt);
		expect(parseConfirmationExpiry(expiresAt / 1000)).toBe(expiresAt);
		expect(parseConfirmationExpiry(new Date(expiresAt).toISOString())).toBe(expiresAt);
	});

	it("releases an expired confirmation run", () => {
		const events = [{ type: "confirmation_required", data: { expiresAt } }] as never[];
		expect(isExpiredConfirmation(events, updatedAt, expiresAt + 1)).toBe(true);
		expect(isExpiredConfirmation(events, updatedAt, expiresAt - 1)).toBe(false);
	});

	it("uses the configured TTL for legacy events without expiry", () => {
		const events = [{ type: "confirmation_required", data: {} }] as never[];
		expect(isExpiredConfirmation(events, updatedAt, updatedAt.getTime() + 300_001, 300_000)).toBe(true);
	});
});
