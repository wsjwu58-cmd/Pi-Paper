import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { type EvalCase, parseEvalCase } from "../evals/eval-schema.ts";

const requiredCaseIds = [
	...Array.from({ length: 11 }, (_, index) => `SEC-${String(index + 1).padStart(2, "0")}`),
	...Array.from({ length: 8 }, (_, index) => `REC-${String(index + 1).padStart(2, "0")}`),
	...Array.from({ length: 4 }, (_, index) => `CON-${String(index + 1).padStart(2, "0")}`),
	...Array.from({ length: 10 }, (_, index) => `FAIL-${String(index + 1).padStart(2, "0")}`),
];

function loadSecurityCases(): EvalCase[] {
	return ["security-and-recovery.json", "concurrency-and-idempotency.json", "provider-failures.json"].map((name) => {
		const source = new URL(`../evals/cases/${name}`, import.meta.url);
		return parseEvalCase(JSON.parse(readFileSync(source, "utf8")), name);
	});
}

describe("Appendix C coverage", () => {
	it("fails closed when any security, recovery, concurrency, or failure ID is missing", () => {
		const cases = loadSecurityCases();
		const covered = new Set(cases.flatMap((value) => value.coverageCaseIds ?? []));
		expect(requiredCaseIds.filter((caseId) => !covered.has(caseId))).toEqual([]);
	});

	it("keeps coverage IDs unique and preserves stable failure codes", () => {
		const cases = loadSecurityCases();
		const ids = cases.flatMap((value) => value.coverageCaseIds ?? []);
		expect(new Set(ids).size).toBe(ids.length);
		for (const value of cases) {
			for (const assertion of value.assertions) {
				if (assertion.type === "error") expect(assertion.code).toMatch(/^[A-Z][A-Z0-9_]{2,63}$/);
			}
		}
	});
});
