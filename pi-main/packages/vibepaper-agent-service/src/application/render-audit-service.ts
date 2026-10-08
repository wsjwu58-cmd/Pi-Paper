import { type AuditFinding, type AuditInput, evaluateContinuity } from "../domain/continuity-rules.ts";

export type RenderAuditReport = {
	id: string;
	ownerId: string;
	verdict: "pass" | "fail";
	findings: readonly AuditFinding[];
	ruleVersion: string;
	modelSuggestion?: string;
};

export class RenderAuditService {
	audit(input: AuditInput & { ownerId: string }): RenderAuditReport {
		const findings = evaluateContinuity(input);
		return {
			id: `audit-${input.ownerId}-${input.shotDurationSeconds}-${input.videoDurationMs}`,
			ownerId: input.ownerId,
			verdict: findings.some((finding) => finding.severity === "error") ? "fail" : "pass",
			findings,
			ruleVersion: "continuity-v1",
		};
	}

	attachModelSuggestion(report: RenderAuditReport, modelSuggestion: string): RenderAuditReport {
		return { ...report, modelSuggestion: modelSuggestion.trim() };
	}
}

export class AuditReadOnlyAgent {
	writeCanvas(): never {
		throw new Error("PERMISSION_DENIED");
	}
	writeReview(): never {
		throw new Error("PERMISSION_DENIED");
	}
}
