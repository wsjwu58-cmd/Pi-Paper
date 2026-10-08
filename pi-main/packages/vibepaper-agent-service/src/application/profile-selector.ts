import type { AgentProfile } from "../domain/tool-manifest.ts";

export type ProfileSelectionInput = {
	entrypoint?: "canvas" | "assets" | "audit";
	canvasDomain?: "general" | "short-drama" | "assets";
	pendingActionType?: "generation" | "audit";
};

export function selectProfile(input: ProfileSelectionInput): AgentProfile {
	if (input.entrypoint === "audit" || input.pendingActionType === "audit") return "audit-readonly";
	if (input.canvasDomain === "short-drama") return "vertical-short-drama";
	if (input.entrypoint === "assets" || input.canvasDomain === "assets") return "asset-assistant";
	return "canvas-general";
}
