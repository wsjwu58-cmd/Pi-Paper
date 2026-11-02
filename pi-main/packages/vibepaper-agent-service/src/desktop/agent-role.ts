import { AGENT_TOOL_MANIFEST, type AgentProfile, getToolsForProfile } from "../domain/tool-manifest.ts";

export type DesktopAgentRoleBinding = { packageId: string; componentId: string; digest: string };
export type DesktopAgentRole = {
	binding: DesktopAgentRoleBinding;
	name: string;
	profile: AgentProfile;
	tools: readonly string[];
	skills: readonly string[];
	contexts: readonly ("canvas" | "selection" | "memory" | "history")[];
	instructions: string;
};

const memoryTools = [
	"read_project_memory",
	"remember_project_preference",
	"edit_project_memory",
	"delete_project_memory",
];
const knownTools = new Set([...AGENT_TOOL_MANIFEST.map((entry) => entry.name), ...memoryTools]);

/** A role can only remove host permissions, including for memory and context reads. */
export function desktopRoleToolNames(role: DesktopAgentRole, hostProfile: AgentProfile): string[] {
	if (role.tools.some((tool) => !knownTools.has(tool))) throw new Error("AGENT_ROLE_TOOL_UNAVAILABLE");
	const host = new Set(getToolsForProfile(hostProfile).map((entry) => entry.name));
	const roleProfile = new Set(getToolsForProfile(role.profile).map((entry) => entry.name));
	const contexts = new Set(role.contexts);
	return role.tools.filter((tool) => {
		if (memoryTools.includes(tool)) {
			return (
				contexts.has("memory") &&
				(role.profile !== "audit-readonly" || tool === "read_project_memory") &&
				(hostProfile !== "audit-readonly" || tool === "read_project_memory")
			);
		}
		if (!host.has(tool) || !roleProfile.has(tool)) return false;
		if (tool === "get_selected_nodes" && !contexts.has("selection")) return false;
		if (
			[
				"marketplace_commands",
				"marketplace_preview",
				"marketplace_command_apply",
				"marketplace_command_undo",
			].includes(tool) &&
			(!contexts.has("canvas") || !contexts.has("selection"))
		)
			return false;
		if (
			["get_canvas_summary", "get_node_detail", "check_task_status", "search_assets"].includes(tool) &&
			!contexts.has("canvas")
		)
			return false;
		return true;
	});
}

export function isDesktopAgentRoleBinding(value: unknown): value is DesktopAgentRoleBinding {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const item = value as Record<string, unknown>;
	const id = /^[a-z0-9][a-z0-9-]{0,79}$/u;
	return (
		Object.keys(item).every((key) => ["packageId", "componentId", "digest"].includes(key)) &&
		typeof item.packageId === "string" &&
		id.test(item.packageId) &&
		typeof item.componentId === "string" &&
		id.test(item.componentId) &&
		typeof item.digest === "string" &&
		/^[a-f0-9]{64}$/u.test(item.digest)
	);
}
