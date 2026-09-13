import type { ReadPlanStepExecutor } from "./plan-execution-service.ts";
import type { ReadTools } from "../tools/read-tools.ts";

/** Adapter which exposes the already-sanitised Tool Gateway read surface to plans. */
export class ToolGatewayReadPlanStepExecutor implements ReadPlanStepExecutor {
	private readonly readTools: ReadTools;

	constructor(readTools: ReadTools) {
		this.readTools = readTools;
	}

	async execute(input: Parameters<ReadPlanStepExecutor["execute"]>[0]): Promise<{ outputRef: string; result: unknown }> {
		const args = input.step.input ?? {};
		const result = await this.executeTool(input.step.tool, input.ownerId, input.canvasId, args, input.requestId);
		return {
			outputRef: `read-result://${input.planId}/${input.step.id}/${input.step.attemptCount ?? 1}`,
			result,
		};
	}

	private async executeTool(
		tool: string,
		ownerId: string,
		canvasId: string,
		args: Record<string, unknown>,
		requestId?: string,
	): Promise<unknown> {
		switch (tool) {
			case "get_canvas_summary":
				return await this.readTools.getCanvasSummary(ownerId, canvasId, requestId);
			case "get_selected_nodes":
				return await this.readTools.getSelectedNodes(ownerId, canvasId, requiredStringArray(args, "nodeIds"), requestId);
			case "get_node_detail":
				return await this.readTools.getNodeDetail(ownerId, canvasId, requiredString(args, "nodeId"), requestId);
			case "list_models":
				return await this.readTools.listModels(ownerId, requestId);
			case "search_assets":
				return await this.readTools.searchAssets(ownerId, requiredString(args, "query"), requestId);
			case "check_task_status":
				return await this.readTools.checkTaskStatus(ownerId, requiredString(args, "taskId"), requestId);
			default:
				throw new Error("TOOL_NOT_ALLOWED");
		}
	}
}

function requiredString(input: Record<string, unknown>, key: string): string {
	const value = input[key];
	if (typeof value !== "string" || !value.trim()) throw new Error("INVALID_INPUT");
	return value;
}

function requiredStringArray(input: Record<string, unknown>, key: string): readonly string[] {
	const value = input[key];
	if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim()))
		throw new Error("INVALID_INPUT");
	return value;
}
