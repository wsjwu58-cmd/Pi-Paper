export type AuditInput = {
	shotDurationSeconds: number;
	expectedDurationSeconds: number;
	characterConsistent: boolean;
	audioDurationMs: number;
	videoDurationMs: number;
	previousCamera: string;
	currentCamera: string;
};
export type AuditFinding = {
	ruleId: "SHOT_DURATION" | "CHARACTER_CONTINUITY" | "AUDIO_VIDEO_SYNC";
	severity: "error" | "warning";
	evidence: string;
};

export function evaluateContinuity(input: AuditInput): readonly AuditFinding[] {
	const findings: AuditFinding[] = [];
	if (input.shotDurationSeconds !== input.expectedDurationSeconds)
		findings.push({
			ruleId: "SHOT_DURATION",
			severity: "error",
			evidence: `${input.shotDurationSeconds} != ${input.expectedDurationSeconds}`,
		});
	if (!input.characterConsistent)
		findings.push({
			ruleId: "CHARACTER_CONTINUITY",
			severity: "error",
			evidence: "character identity anchors differ",
		});
	if (Math.abs(input.audioDurationMs - input.videoDurationMs) > 100)
		findings.push({
			ruleId: "AUDIO_VIDEO_SYNC",
			severity: "error",
			evidence: `${input.audioDurationMs}ms vs ${input.videoDurationMs}ms`,
		});
	return findings;
}
