import { describe, expect, it } from "vitest";
import { AuditReadOnlyAgent, RenderAuditService } from "../src/application/render-audit-service.ts";

describe("read-only render audit", () => {
	it("produces deterministic rule evidence and keeps client writes forbidden", () => {
		const service = new RenderAuditService();
		const report = service.audit({
			ownerId: "7",
			shotDurationSeconds: 6,
			expectedDurationSeconds: 5,
			characterConsistent: false,
			audioDurationMs: 5000,
			videoDurationMs: 5000,
			previousCamera: "wide",
			currentCamera: "close",
		});
		expect(report.verdict).toBe("fail");
		expect(report.findings.map((finding) => finding.ruleId)).toEqual(["SHOT_DURATION", "CHARACTER_CONTINUITY"]);
		expect(() => new AuditReadOnlyAgent().writeCanvas()).toThrow("PERMISSION_DENIED");
	});

	it("does not let an LLM suggestion overwrite deterministic findings", () => {
		const service = new RenderAuditService();
		const report = service.audit({
			ownerId: "7",
			shotDurationSeconds: 4,
			expectedDurationSeconds: 5,
			characterConsistent: true,
			audioDurationMs: 4000,
			videoDurationMs: 5000,
			previousCamera: "wide",
			currentCamera: "close",
		});
		const withSuggestion = service.attachModelSuggestion(report, "Looks acceptable");
		expect(withSuggestion.verdict).toBe("fail");
		expect(withSuggestion.modelSuggestion).toBe("Looks acceptable");
	});
});
