export type AgentProfile = "canvas-general" | "vertical-short-drama" | "asset-assistant" | "audit-readonly";
export type ToolRisk = "read" | "canvas_write" | "high";

export type ToolManifestEntry = {
	name: string;
	profiles: readonly AgentProfile[];
	version: number;
	schema: Record<string, unknown>;
	risk: ToolRisk;
	maxBatch: number;
	costPolicy: "none" | "estimate_required";
	approvalPolicy: "none" | "required";
	auditFields: readonly string[];
};

const readTools: readonly AgentProfile[] = [
	"canvas-general",
	"vertical-short-drama",
	"asset-assistant",
	"audit-readonly",
];

export const AGENT_TOOL_MANIFEST: readonly ToolManifestEntry[] = [
	entry("get_canvas_summary", readTools, "read"),
	entry("get_selected_nodes", readTools, "read"),
	entry("get_node_detail", readTools, "read"),
	entry("list_models", ["canvas-general", "vertical-short-drama", "asset-assistant", "audit-readonly"], "read"),
	entry("search_assets", ["canvas-general", "vertical-short-drama", "asset-assistant", "audit-readonly"], "read"),
	entry("check_task_status", readTools, "read"),
	entry("create_nodes", ["canvas-general", "vertical-short-drama"], "canvas_write"),
	entry("connect_nodes", ["canvas-general", "vertical-short-drama"], "canvas_write"),
	entry("layout_nodes", ["canvas-general", "vertical-short-drama"], "canvas_write"),
	entry("update_node_config", ["canvas-general", "vertical-short-drama"], "canvas_write"),
	entry("delete_nodes", ["canvas-general", "vertical-short-drama"], "canvas_write"),
	entry("submit_generation", ["canvas-general", "vertical-short-drama"], "high", "estimate_required", "required"),
	entry(
		"submit_generation_batch",
		["canvas-general", "vertical-short-drama"],
		"high",
		"estimate_required",
		"required",
	),
	entry("request_render_audit", ["vertical-short-drama", "audit-readonly"], "read"),
	entry("load_skill", ["canvas-general", "vertical-short-drama", "asset-assistant"], "read"),
];

export function validateToolManifest(manifest: readonly ToolManifestEntry[]): void {
	const names = new Set<string>();
	for (const item of manifest) {
		if (names.has(item.name)) throw new Error("DUPLICATE_TOOL_MANIFEST_ENTRY");
		if (!item.name || item.version < 1 || item.maxBatch < 1) throw new Error("INVALID_TOOL_MANIFEST_ENTRY");
		if (item.profiles.length === 0) throw new Error("TOOL_WITHOUT_PROFILE");
		if (item.risk === "high" && item.costPolicy !== "estimate_required")
			throw new Error("HIGH_RISK_TOOL_MUST_ESTIMATE");
		names.add(item.name);
	}
}

export function getToolsForProfile(profile: AgentProfile): readonly ToolManifestEntry[] {
	return AGENT_TOOL_MANIFEST.filter((entry) => entry.profiles.includes(profile));
}

function entry(
	name: string,
	profiles: readonly AgentProfile[],
	risk: ToolRisk,
	costPolicy: "none" | "estimate_required" = "none",
	approvalPolicy: "none" | "required" = "none",
): ToolManifestEntry {
	return {
		name,
		profiles,
		version: 1,
		schema: { type: "object", additionalProperties: false },
		risk,
		maxBatch: name === "create_nodes" || name === "submit_generation_batch" ? 20 : 1,
		costPolicy,
		approvalPolicy,
		auditFields: ["request_id", "user_id", "session_id", "canvas_id"],
	};
}

validateToolManifest(AGENT_TOOL_MANIFEST);
