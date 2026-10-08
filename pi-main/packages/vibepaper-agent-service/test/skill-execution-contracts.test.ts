import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseEvalCase } from "../evals/eval-schema.ts";

const requiredSkillIds = [
	"vertical-episode",
	"short-video-script",
	"shot-storyboard",
	"dialogue-polish",
	"longform-adaptation",
	"continuity-audit",
	"character-consistency",
	"story-bible",
	"six-panel-comic",
	"product-visual",
	"product-spray-ad",
	"anti-gravity-product",
	"ecommerce-operation",
	"trend-pv",
	"vital-portrait",
	"minimal-poster",
	"film-poster",
	"cinematic-still",
	"cinematic-triptych",
	"real-scene-paper",
	"interface-design",
];

function loadSkillCases() {
	return [
		"skills-short-video-drama.json",
		"skills-comic-character.json",
		"skills-commercial-visual.json",
		"skills-portrait-poster-ui.json",
	].map((name) =>
		parseEvalCase(JSON.parse(readFileSync(new URL(`../evals/cases/${name}`, import.meta.url), "utf8")), name),
	);
}

describe("Appendix B Skill execution contracts", () => {
	it("fails closed unless all 21 Skill IDs have positive and boundary coverage", () => {
		const cases = loadSkillCases();
		const positive = new Set(cases.flatMap((value) => value.skillIds ?? []));
		const boundary = new Set(cases.flatMap((value) => value.skillBoundaryIds ?? []));
		expect(requiredSkillIds.filter((skillId) => !positive.has(skillId))).toEqual([]);
		expect(requiredSkillIds.filter((skillId) => !boundary.has(skillId))).toEqual([]);
	});

	it("keeps generation Skills confirmation-backed and audit turns read-only", () => {
		for (const value of loadSkillCases()) {
			const hasGeneration = value.tags.includes("generate");
			if (hasGeneration) expect(value.assertions.some((assertion) => assertion.type === "confirmation")).toBe(true);
			if (value.tags.includes("short-drama")) {
				const auditTurns = value.turns.filter((turn) => turn.entrypoint === "audit");
				expect(auditTurns.length).toBeGreaterThan(0);
				expect(auditTurns.every((turn) => turn.confirmation === "none")).toBe(true);
			}
		}
	});
});
