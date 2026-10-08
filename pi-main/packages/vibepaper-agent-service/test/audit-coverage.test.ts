import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type TrackerEntry = {
	auditId: string;
	taskIds: number[];
	status: "planned" | "in_progress" | "verified";
	evidence: string[];
};

function readAuditIds(markdown: string): string[] {
	return [...new Set(markdown.match(/AGT-PI-P[01]-\d{2}/g) ?? [])].sort();
}

function readTrackerEntries(markdown: string): TrackerEntry[] {
	const jsonBlock = markdown.match(/```json\s*([\s\S]*?)```/);
	if (!jsonBlock) {
		throw new Error("Tracker must contain a JSON coverage block");
	}
	return JSON.parse(jsonBlock[1]) as TrackerEntry[];
}

function unmappedAuditIds(trackerMarkdown: string, auditMarkdown: string): string[] {
	const entries = readTrackerEntries(trackerMarkdown);
	const mapped = new Set(entries.map((entry) => entry.auditId));
	return readAuditIds(auditMarkdown).filter((auditId) => !mapped.has(auditId));
}

describe("Pi audit remediation coverage", () => {
	it("maps every P0 and P1 audit issue to at least one executable task", () => {
		const root = resolve(import.meta.dirname, "../../../../");
		const tracker = readFileSync(resolve(root, "docs/audits/pi-agent-remediation-tracker.md"), "utf8");
		const audit = readFileSync(
			resolve(root, "docs/audits/pi-agent-secondary-development-comprehensive-review-2026-08-28.md"),
			"utf8",
		);

		expect(unmappedAuditIds(tracker, audit)).toEqual([]);
	});

	it("keeps every coverage entry executable and evidence-aware", () => {
		const root = resolve(import.meta.dirname, "../../../../");
		const tracker = readFileSync(resolve(root, "docs/audits/pi-agent-remediation-tracker.md"), "utf8");
		const entries = readTrackerEntries(tracker);

		expect(entries).toHaveLength(48);
		for (const entry of entries) {
			expect(entry.auditId).toMatch(/^AGT-PI-P[012]-\d{2}$/);
			expect(entry.taskIds.length).toBeGreaterThan(0);
			expect(["planned", "in_progress", "verified"]).toContain(entry.status);
			expect(entry.evidence.length).toBeGreaterThan(0);
		}
	});
});
