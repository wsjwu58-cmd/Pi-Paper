import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { rehydratedSkillInstructions } from "../src/application/agent-runtime.ts";
import { DesktopAgentControlStore } from "../src/desktop/control-store.ts";
import { createDesktopAgentSkillContext, listDesktopAgentSkills } from "../src/desktop/skill-context.ts";
import { SYSTEM_SKILLS } from "../src/domain/skill-manifest.ts";
import { createLoadSkillTool } from "../src/tools/skill-tools.ts";

const temporaryDirectories: string[] = [];

async function createStore() {
	const directory = await mkdtemp(join(tmpdir(), "vibepaper-agent-skills-"));
	temporaryDirectories.push(directory);
	const databasePath = join(directory, "control.sqlite");
	return { directory, databasePath, store: new DesktopAgentControlStore(databasePath) };
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("desktop system Skill context", () => {
	it("lists the original manifest and filters the picker results", () => {
		const skills = listDesktopAgentSkills();
		expect(skills).toHaveLength(SYSTEM_SKILLS.length);
		expect(skills.find((skill) => skill.id === "canvas-cookbook")).toMatchObject({
			key: "canvas-cookbook",
			source: "builtin",
			category: "canvas",
			version: 1,
			enabled: true,
		});
		expect(listDesktopAgentSkills("分镜与镜头清单").map((skill) => skill.key)).toContain("shot-storyboard");
		expect(listDesktopAgentSkills("absent-skill-query")).toEqual([]);
	});

	it("loads selected and tool-loaded skills into the next turn from SQLite", async () => {
		const { databasePath, store } = await createStore();
		try {
			const context = createDesktopAgentSkillContext(store, "session-1", "canvas-cookbook");
			expect(context.loadedSkillIds).toEqual(["canvas-cookbook"]);
			expect(rehydratedSkillInstructions(context.loadedSkills)).toContain("Canvas Cookbook");

			const [loadSkill] = createLoadSkillTool(context.skills, context.loadedSkillIds, context.onLoad);
			const result = await loadSkill.execute("tool-call-1", { skill: "product-visual" });
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("skill://session/product-visual") });
			expect(store.getLoadedSkillIds("session-1")).toEqual(["canvas-cookbook", "product-visual"]);
			expect(store.getLoadedSkillIds("session-2")).toEqual([]);
		} finally {
			store.close();
		}

		const reopened = new DesktopAgentControlStore(databasePath);
		try {
			const nextTurn = createDesktopAgentSkillContext(reopened, "session-1");
			expect(nextTurn.loadedSkillIds).toEqual(["canvas-cookbook", "product-visual"]);
			expect(rehydratedSkillInstructions(nextTurn.loadedSkills)).toContain("产品视觉");
		} finally {
			reopened.close();
		}
	});

	it("rejects a selected Skill outside the original manifest", async () => {
		const { store } = await createStore();
		try {
			expect(() => createDesktopAgentSkillContext(store, "session-1", "missing-skill")).toThrow("SKILL_NOT_FOUND");
			expect(store.getLoadedSkillIds("session-1")).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("migrates an existing v2 control database without dropping run state", async () => {
		const { databasePath, store } = await createStore();
		store.close();
		const database = new DatabaseSync(databasePath);
		database.exec("DROP TABLE agent_session_skill_state; PRAGMA user_version = 2;");
		database.close();

		const migrated = new DesktopAgentControlStore(databasePath);
		try {
			expect(migrated.getLoadedSkillIds("session-1")).toEqual([]);
			expect(migrated.markSkillLoaded("session-1", "canvas-cookbook")).toEqual(["canvas-cookbook"]);
			expect(migrated.getLoadedSkillIds("session-1")).toEqual(["canvas-cookbook"]);
		} finally {
			migrated.close();
		}
	});
});
