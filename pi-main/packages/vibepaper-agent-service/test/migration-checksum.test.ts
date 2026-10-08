import { describe, expect, it } from "vitest";

import { isKnownLegacyMigrationChecksum } from "../src/infrastructure/migrations.ts";

describe("migration checksum compatibility", () => {
	it("only accepts the recorded legacy baseline checksum", () => {
		expect(
			isKnownLegacyMigrationChecksum(
				"001_baseline.sql",
				"f7b5d9e13ae951f083474afef84299e6b68825cce8e4c6f6332eaf3ec65bb2f3",
			),
		).toBe(true);
		expect(isKnownLegacyMigrationChecksum("001_baseline.sql", "different")).toBe(false);
		expect(
			isKnownLegacyMigrationChecksum(
				"002_control_plane_constraints.sql",
				"f7b5d9e13ae951f083474afef84299e6b68825cce8e4c6f6332eaf3ec65bb2f3",
			),
		).toBe(false);
	});
});
