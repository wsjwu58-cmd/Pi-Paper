import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { assertEvalCase, buildCoverage, coverageGaps, type EvalCase } from "../evals/eval-schema.ts";

const requiredModalities = new Set(["text", "image", "video", "audio", "compose", "director"]);
const requiredOperations = [
	"img2img",
	"keyframe",
	"clip_video",
	"extract_frame",
	"upscale_image",
	"upscale_video",
	"outpaint_image",
	"mux_audio",
];

const validCase: EvalCase = {
	caseId: "core-text-001",
	profile: "canvas-general",
	turns: [
		{ turnId: "turn-1", content: "写一段产品文案", confirmation: "none" },
		{ turnId: "turn-2", content: "把上一段文案放到图片节点", confirmation: "manual" },
	],
	assertions: [
		{ type: "node", nodeType: "text" },
		{ type: "confirmation", required: true },
		{ type: "task", terminal: true },
		{ type: "media", kind: "text" },
		{ type: "error", code: "INVALID_INPUT" },
	],
	browserCheckpoints: [],
	tags: ["text", "generate", "failure"],
};

describe("evaluation case schema", () => {
	it("counts the five core scenarios as a real 32-turn full-chain matrix", () => {
		const names = [
			"core-product-visual.json",
			"keyframe-compose.json",
			"tts-subtitle.json",
			"director-stage.json",
			"vertical-short-drama-full-episode.json",
		];
		const cases = names.map(
			(name) => JSON.parse(readFileSync(new URL(`../evals/cases/${name}`, import.meta.url), "utf8")) as EvalCase,
		);
		const coverage = buildCoverage(cases);
		expect(coverage.modalities).toEqual(new Set(["text", "image", "video", "audio", "compose", "director"]));
		expect([...coverage.operations]).toEqual(
			expect.arrayContaining([
				"img2img",
				"keyframe",
				"clip_video",
				"extract_frame",
				"upscale_image",
				"upscale_video",
				"outpaint_image",
				"mux_audio",
			]),
		);
		expect(coverage.totalTurns).toBeGreaterThanOrEqual(32);
	});

	it("rejects a one-turn generation case without lifecycle assertions", () => {
		expect(() =>
			assertEvalCase({
				...validCase,
				turns: [validCase.turns[0]],
				assertions: [{ type: "node", nodeType: "text" }],
			}),
		).toThrow(/AT_LEAST_2_TURNS|confirmation|task|media/i);
	});

	it("computes modality and operation coverage from executable cases", () => {
		const coverage = buildCoverage([
			validCase,
			{
				...validCase,
				caseId: "core-image-001",
				turns: validCase.turns.map((turn, index) => ({
					...turn,
					turnId: `image-${index + 1}`,
				})),
				assertions: [
					{ type: "node", nodeType: "image" },
					{ type: "confirmation", required: true },
					{ type: "task", terminal: true },
					{ type: "media", kind: "image" },
				],
				tags: ["image", "img2img"],
			},
		]);

		expect(coverage.modalities).toEqual(new Set(["text", "image"]));
		expect(coverage.caseIds).toEqual(["core-text-001", "core-image-001"]);
		expect(coverage.operations).toContain("img2img");
		expect(coverage.totalTurns).toBe(4);
	});

	it("requires the full-chain matrix to cover all media stages and at least 32 turns", () => {
		const cases: EvalCase[] = Array.from(requiredModalities, (modality, index) => ({
			...validCase,
			caseId: `matrix-${modality}`,
			turns: Array.from({ length: 6 }, (_, turnIndex) => ({
				...validCase.turns[turnIndex % validCase.turns.length],
				turnId: `${modality}-${turnIndex + 1}`,
			})),
			tags: [modality, "generate", ...(index === 0 ? requiredOperations : [])],
		}));
		const coverage = buildCoverage(cases);

		expect(coverage.modalities).toEqual(requiredModalities);
		expect(coverage.operations).toEqual(new Set(requiredOperations));
		expect(coverage.totalTurns).toBeGreaterThanOrEqual(32);
	});

	it("reports missing full-chain coverage instead of allowing a false pass", () => {
		const coverage = buildCoverage([validCase]);
		const gaps = coverageGaps(coverage);
		expect(gaps.modalities).toEqual(expect.arrayContaining(["director", "audio", "compose"]));
		expect(gaps.operations).toEqual(expect.arrayContaining(["keyframe", "mux_audio"]));
		expect(gaps.minimumTurns).toBe(true);
		expect(gaps.skillIds).toContain("interface-design");
	});
});
