import { describe, expect, it } from "vitest";

import { AGENT_TOOL_MANIFEST, getToolsForProfile, validateToolManifest } from "../src/domain/tool-manifest.ts";
import { assertToolAllowed } from "../src/domain/tool-policy.ts";
import { createDramaAgent } from "../src/pi/drama-agent.ts";

describe("ToolManifest", () => {
	it("contains unique versioned tools with bounded risk and batch policy", () => {
		expect(() => validateToolManifest(AGENT_TOOL_MANIFEST)).not.toThrow();
		expect(new Set(AGENT_TOOL_MANIFEST.map((entry) => entry.name)).size).toBe(AGENT_TOOL_MANIFEST.length);
		for (const entry of AGENT_TOOL_MANIFEST) expect(entry.maxBatch).toBeGreaterThan(0);
	});

	it("exposes only the deterministic profile subset and rejects dynamic tools", () => {
		const names = getToolsForProfile("audit-readonly").map((entry) => entry.name);
		expect(names).not.toContain("create_nodes");
		expect(() => assertToolAllowed("audit-readonly", "create_nodes")).toThrow("TOOL_NOT_ALLOWED");
		expect(() => assertToolAllowed("canvas-general", "model_supplied_tool")).toThrow("TOOL_NOT_ALLOWED");
	});

	it("does not expose canvas writes to the audit-only agent", () => {
		const agent = createDramaAgent({} as never, {
			profile: "audit-readonly",
			streamFn: (() => undefined) as never,
			runtimeTools: [
				{
					name: "get_canvas_summary",
					label: "summary",
					description: "summary",
					parameters: {},
					execute: async () => ({ content: [], details: {} }),
				},
				{
					name: "create_nodes",
					label: "create",
					description: "create",
					parameters: {},
					execute: async () => ({ content: [], details: {} }),
				},
			],
		});
		expect(agent.state.tools.map((tool) => tool.name)).toEqual(["get_canvas_summary"]);
	});
});
