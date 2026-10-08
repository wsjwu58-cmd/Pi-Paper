import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("legacy database reconciliation migration", () => {
	it("reconciles columns required by the current Agent runtime before later indexes", async () => {
		const sql = await readFile(new URL("../migrations/003_legacy_schema_reconcile.sql", import.meta.url), "utf8");

		expect(sql).toContain("user_memories ADD COLUMN IF NOT EXISTS tenant_id");
		expect(sql).toContain("user_memories ADD COLUMN IF NOT EXISTS canvas_id");
		expect(sql).toContain("user_memories ADD COLUMN IF NOT EXISTS confidence");
		expect(sql).toContain("user_memories ADD COLUMN IF NOT EXISTS version");
		expect(sql).toContain("user_memories ADD COLUMN IF NOT EXISTS source");
		expect(sql).toContain("user_memories ADD COLUMN IF NOT EXISTS deleted");
		expect(sql).toContain("user_memories ADD COLUMN IF NOT EXISTS session_id");
		expect(sql).toContain("agent_actions ADD COLUMN IF NOT EXISTS task_id");
	});

	it("widens legacy action status storage for awaiting_approval", async () => {
		const migrations = await readdir(new URL("../migrations/", import.meta.url));

		expect(migrations).toContain("014_agent_action_status_reconcile.sql");
		const sql = await readFile(
			new URL("../migrations/014_agent_action_status_reconcile.sql", import.meta.url),
			"utf8",
		);
		expect(sql).toContain("ALTER COLUMN status TYPE VARCHAR(32)");
	});
});
