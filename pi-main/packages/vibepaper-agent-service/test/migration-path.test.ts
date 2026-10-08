import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { migrationDirectoryFromUrl } from "../src/infrastructure/migrations.ts";

describe("migration path resolution", () => {
	it("converts a Windows file URL without duplicating the drive prefix", () => {
		const serverUrl = "file:///E:/VibePaperProject/pi-main/packages/vibepaper-agent-service/dist/server.js";
		const path = migrationDirectoryFromUrl(serverUrl);

		expect(path.replaceAll("\\", "/")).toBe(
			fileURLToPath(new URL("../migrations/", serverUrl)).replaceAll("\\", "/"),
		);
	});
});
