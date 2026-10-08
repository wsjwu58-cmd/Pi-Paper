export type EvaluationTrace = {
	caseId: string;
	modelVersion: string;
	skillVersion: string;
	tools: readonly string[];
	confirmations: number;
	quality: number;
	points: number;
	latencyMs: number;
};
export type TraceDiff = {
	changedVariables: readonly string[];
	delta: { quality: number; points: number; latencyMs: number };
};

export class EvaluationService {
	diff(before: EvaluationTrace, after: EvaluationTrace): TraceDiff {
		const changedVariables: string[] = [];
		if (before.modelVersion !== after.modelVersion) changedVariables.push("modelVersion");
		if (before.skillVersion !== after.skillVersion) changedVariables.push("skillVersion");
		if (before.tools.join("\u0000") !== after.tools.join("\u0000")) changedVariables.push("tools");
		if (before.confirmations !== after.confirmations) changedVariables.push("confirmations");
		if (before.quality !== after.quality) changedVariables.push("quality");
		if (before.points !== after.points) changedVariables.push("points");
		if (before.latencyMs !== after.latencyMs) changedVariables.push("latencyMs");
		return {
			changedVariables,
			delta: {
				quality: after.quality - before.quality,
				points: after.points - before.points,
				latencyMs: after.latencyMs - before.latencyMs,
			},
		};
	}

	gate(
		diff: TraceDiff,
		limits: { minQualityDelta: number; maxPointIncrease: number; maxLatencyIncreaseMs: number },
	): boolean {
		return (
			diff.delta.quality >= limits.minQualityDelta &&
			diff.delta.points <= limits.maxPointIncrease &&
			diff.delta.latencyMs <= limits.maxLatencyIncreaseMs
		);
	}
}
