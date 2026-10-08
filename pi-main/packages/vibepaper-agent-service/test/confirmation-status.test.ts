import { describe, expect, it } from "vitest";

import { persistConfirmationStatus } from "../src/application/confirmation-status.ts";
import type { SqlExecutor } from "../src/infrastructure/database.ts";

describe("persistConfirmationStatus", () => {
	it("persists the accepted state for the matching confirmation card", async () => {
		const calls: Array<{ text: string; values: unknown[] }> = [];
		const database: SqlExecutor = {
			query: async (text, values = []) => {
				calls.push({ text, values });
				return { rows: [] };
			},
		};

		await persistConfirmationStatus(database, "session-1", "action-1", "accepted");

		expect(calls).toHaveLength(1);
		expect(calls[0]?.text).toContain("jsonb_set");
		expect(calls[0]?.values).toEqual(["accepted", "session-1", "action-1"]);
	});
});
