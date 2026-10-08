import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveEvalFiles, resolveEvidenceRoot } from "../evals/case-loader.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const monorepoRoot = resolve(packageRoot, "..", "..");
const repositoryRoot = resolve(monorepoRoot, "..");

describe("evaluation case CLI paths", () => {
	it("expands the plan's Windows wildcard from the monorepo root", async () => {
		const files = await resolveEvalFiles(["packages/vibepaper-agent-service/evals/cases/*.json"], monorepoRoot);

		expect(files).toHaveLength(16);
		expect(files.every((file) => file.endsWith(".json"))).toBe(true);
	});

	it("writes default evidence below the repository output directory", () => {
		const evidenceRoot = resolveEvidenceRoot(packageRoot, "2026-08-29").replaceAll("\\", "/");
		expect(evidenceRoot).toBe(resolve(repositoryRoot, "output", "evals", "2026-08-29").replaceAll("\\", "/"));
	});
});
