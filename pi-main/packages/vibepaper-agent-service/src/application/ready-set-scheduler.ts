import type { AgentPlan, PlanStep, PlanStepEffect } from "../domain/agent-plan.ts";
import { type ToolManifestEntry, getToolsForProfile } from "../domain/tool-manifest.ts";

export type ReadyExecutionPartition = {
	effect: PlanStepEffect;
	concurrencyKey: string;
	stepIds: readonly string[];
	maxParallelism: number;
	requiresConfirmation: boolean;
};

export function effectForTool(tool: ToolManifestEntry): PlanStepEffect {
	if (tool.risk === "read") return "read";
	if (tool.risk === "canvas_write") return "write_canvas";
	return "create_task";
}

/**
 * Produces a safe execution contract; it does not execute any tool. Read work
 * is bounded and grouped, while every canvas write and generation submission
 * keeps an isolated partition until a persistent scheduler owns its lease.
 */
export function partitionReadySteps(
	plan: AgentPlan,
	readyStepIds: readonly string[],
	profile: Parameters<typeof getToolsForProfile>[0],
): readonly ReadyExecutionPartition[] {
	const tools = new Map(getToolsForProfile(profile).map((tool) => [tool.name, tool]));
	const steps = readyStepIds
		.map((id) => plan.steps.find((step) => step.id === id))
		.filter((step): step is PlanStep => step !== undefined);
	const partitions: ReadyExecutionPartition[] = [];
	const reads: PlanStep[] = [];
	for (const step of steps) {
		const tool = tools.get(step.tool);
		if (!tool) continue;
		const effect = effectForTool(tool);
		if (effect === "read") {
			reads.push(step);
			continue;
		}
		partitions.push({
			effect,
			concurrencyKey: step.concurrencyKey?.trim() || `${effect}:${step.id}`,
			stepIds: [step.id],
			maxParallelism: 1,
			requiresConfirmation: tool.approvalPolicy === "required",
		});
	}
	const readPartitions = chunks(reads, 4).map((group) =>
		({
			effect: "read",
			concurrencyKey: "read",
			stepIds: group.map((step) => step.id),
			maxParallelism: group.length,
			requiresConfirmation: false,
		}) satisfies ReadyExecutionPartition,
	);
	return [...readPartitions, ...partitions];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
	return result;
}
