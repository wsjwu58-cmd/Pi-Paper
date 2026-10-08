import { type AgentProfile, getToolsForProfile } from "./tool-manifest.ts";

export function assertToolAllowed(profile: AgentProfile, toolName: string): void {
	if (!getToolsForProfile(profile).some((entry) => entry.name === toolName)) throw new Error("TOOL_NOT_ALLOWED");
}

export function toolEntry(profile: AgentProfile, toolName: string) {
	assertToolAllowed(profile, toolName);
	return getToolsForProfile(profile).find((entry) => entry.name === toolName)!;
}
