import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareDesktopAgentTurnContext } from "../src/application/agent-runtime.ts";
import { type DesktopAgentRole, desktopRoleToolNames, isDesktopAgentRoleBinding } from "../src/desktop/agent-role.ts";
import { DesktopAgentControlStore } from "../src/desktop/control-store.ts";
import { createDesktopAgentSkillContext, listDesktopAgentSkills } from "../src/desktop/skill-context.ts";

const dirs: string[] = [];
const role: DesktopAgentRole = {
	binding: { packageId: "short-drama-workbench", componentId: "shot-reviewer", digest: "a".repeat(64) },
	name: "审片员",
	profile: "audit-readonly",
	tools: ["get_canvas_summary", "get_selected_nodes", "create_nodes", "submit_generation", "read_project_memory"],
	skills: ["shot-storyboard"],
	contexts: ["canvas", "history"],
	instructions: "只读检查。",
};

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("desktop Agent role restrictions", () => {
	it("intersects host and role profiles and narrows reads to declared context", () => {
		expect(desktopRoleToolNames(role, "canvas-general")).toEqual(["get_canvas_summary"]);
		expect(
			desktopRoleToolNames(
				{ ...role, profile: "vertical-short-drama", contexts: ["canvas", "selection", "memory"] },
				"audit-readonly",
			),
		).toEqual(["get_canvas_summary", "get_selected_nodes", "read_project_memory"]);
		expect(() => desktopRoleToolNames({ ...role, tools: ["execute_arbitrary_code"] }, "canvas-general")).toThrow(
			"AGENT_ROLE_TOOL_UNAVAILABLE",
		);
		expect(isDesktopAgentRoleBinding(role.binding)).toBe(true);
		expect(isDesktopAgentRoleBinding({ ...role.binding, digest: "bad" })).toBe(false);
	});

	it("limits the model Skill index and refuses disabled declared Skills", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agent-role-context-"));
		dirs.push(directory);
		const control = new DesktopAgentControlStore(join(directory, "control.sqlite"));
		try {
			const context = createDesktopAgentSkillContext(control, "session", undefined, [], role.skills);
			expect(context.skills.map((item) => item.id)).toEqual(
				expect.arrayContaining(["canvas-cookbook", "director-stage", "shot-storyboard"]),
			);
			expect(context.skills.some((item) => item.id === "product-visual")).toBe(false);
			expect(() => createDesktopAgentSkillContext(control, "session", "product-visual", [], role.skills)).toThrow(
				"AGENT_ROLE_SKILL_NOT_ALLOWED",
			);
			const dynamic = listDesktopAgentSkills().find((item) => item.id === "shot-storyboard")!;
			expect(() =>
				createDesktopAgentSkillContext(
					control,
					"session",
					undefined,
					[{ ...dynamic, enabled: false }],
					role.skills,
				),
			).toThrow("AGENT_ROLE_SKILL_UNAVAILABLE");
			const turn = prepareDesktopAgentTurnContext([], "检查", context, [], {
				profile: "canvas-general",
				allowedToolNames: ["get_canvas_summary"],
			});
			expect(turn.toolSchemas.map((item) => (item as { name: string }).name)).not.toContain("load_skill");
		} finally {
			control.close();
		}
	});
});
