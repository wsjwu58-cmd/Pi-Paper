import { describe, expect, it } from "vitest";
import { EvaluationService } from "../src/application/evaluation-service.ts";

describe("agent evaluation", () => {
	it("produces a structured trace diff and quality/cost attribution", () => {
		const service = new EvaluationService();
		const diff = service.diff(
			{
				caseId: "case-1",
				modelVersion: "m1",
				skillVersion: "s1",
				tools: ["get_canvas_summary"],
				confirmations: 1,
				quality: 0.8,
				points: 3,
				latencyMs: 100,
			},
			{
				caseId: "case-1",
				modelVersion: "m2",
				skillVersion: "s1",
				tools: ["get_canvas_summary", "create_nodes"],
				confirmations: 1,
				quality: 0.9,
				points: 4,
				latencyMs: 120,
			},
		);
		expect(diff.changedVariables).toEqual(["modelVersion", "tools", "quality", "points", "latencyMs"]);
		expect(diff.delta.quality).toBeCloseTo(0.1);
		expect(service.gate(diff, { minQualityDelta: 0, maxPointIncrease: 1, maxLatencyIncreaseMs: 30 })).toBe(true);
	});
});
