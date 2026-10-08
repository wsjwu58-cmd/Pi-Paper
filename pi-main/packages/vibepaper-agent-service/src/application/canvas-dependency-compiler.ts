import type { AgentPlan, PlanStep } from "../domain/agent-plan.ts";
import { clonePlanStep } from "./plan-compiler.ts";

export class CanvasDependencyCompiler {
	impactSet(steps: readonly PlanStep[], changedStepIds: readonly string[]): readonly string[] {
		const impacted = new Set(changedStepIds);
		let changed = true;
		while (changed) {
			changed = false;
			for (const step of steps) {
				if (!impacted.has(step.id) && step.dependsOn.some((dependency) => impacted.has(dependency))) {
					impacted.add(step.id);
					changed = true;
				}
			}
		}
		return steps.filter((step) => impacted.has(step.id)).map((step) => step.id);
	}

	rerun(plan: AgentPlan, changedStepId: string): AgentPlan & { estimatedCost: number } {
		const impacted = new Set(this.impactSet(plan.steps, [changedStepId]));
		const steps = plan.steps.map((step) =>
			impacted.has(step.id) ? clonePlanStep(step, { status: "pending" }) : step,
		);
		return {
			...plan,
			version: plan.version + 1,
			steps,
			estimatedCost: steps
				.filter((step) => impacted.has(step.id))
				.reduce((total, step) => total + step.estimatedCost, 0),
		};
	}
}
