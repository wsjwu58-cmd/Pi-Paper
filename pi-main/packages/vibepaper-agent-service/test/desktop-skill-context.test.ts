import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { rehydratedSkillInstructions } from "../src/application/agent-runtime.ts";
import { DesktopAgentControlStore } from "../src/desktop/control-store.ts";
import {
	createDesktopAgentSkillContext,
	listDesktopAgentSessionSkills,
	listDesktopAgentSkills,
	snapshotDesktopAgentSkill,
} from "../src/desktop/skill-context.ts";
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

	it("adds enabled project Skills to the original load_skill tool context", async () => {
		const { store } = await createStore();
		const skill = {
			id: "project-lens-notes",
			key: "project-lens-notes",
			name: "镜头笔记",
			description: "保持镜头方向连续",
			instructions: "记录轴线和镜头方向。",
			source: "project" as const,
			category: "video",
			version: 1,
			enabled: true,
		};
		try {
			const unconfigured = createDesktopAgentSkillContext(store, "session-1", undefined, [skill]);
			expect(unconfigured.skills.some((resource) => resource.id === skill.id)).toBe(false);
			store.attachSessionSkillSnapshot("session-1", snapshotDesktopAgentSkill(skill));
			const context = createDesktopAgentSkillContext(store, "session-1", undefined, [skill]);
			expect(context.indexLines).toContain("- [dynamic] 镜头笔记 (project-lens-notes)：保持镜头方向连续");
			expect(context.skills).toContainEqual({
				id: "project-lens-notes",
				key: "project-lens-notes",
				name: "镜头笔记",
				instructions: "记录轴线和镜头方向。",
			});

			const [loadSkill] = createLoadSkillTool(context.skills, context.loadedSkillIds, context.onLoad);
			const result = await loadSkill.execute("tool-call-project-skill", { skill: "镜头笔记" });
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("记录轴线和镜头方向") });
			expect(store.getLoadedSkillIds("session-1")).toEqual(["project-lens-notes"]);
		} finally {
			store.close();
		}
	});

	it("uses an enabled session snapshot, displays an unavailable snapshot, and keeps explicit selection live", async () => {
		const { databasePath, store } = await createStore();
		const versionOne = {
			id: "project-versioned-skill",
			key: "project-versioned-skill",
			name: "版本化项目 Skill",
			description: "旧版说明",
			instructions: "版本一正文。",
			source: "project" as const,
			category: "general",
			version: 1,
			enabled: true,
		};
		const versionTwo = { ...versionOne, description: "新版说明", instructions: "版本二正文。", version: 2 };
		try {
			store.attachSessionSkillSnapshot("session-1", snapshotDesktopAgentSkill(versionOne));
			const attached = createDesktopAgentSkillContext(store, "session-1", undefined, [versionTwo]);
			expect(attached.skills.find((skill) => skill.id === versionOne.id)?.instructions).toBe("版本一正文。");
			const listed = listDesktopAgentSessionSkills(store, "session-1", undefined, [versionTwo]);
			expect(listed.items.find((skill) => skill.id === versionOne.id)).toMatchObject({
				instructions: "版本一正文。",
				version: 1,
				enabled: true,
			});

			const liveSelection = createDesktopAgentSkillContext(store, "session-2", versionOne.id, [versionOne]);
			expect(liveSelection.skills.find((skill) => skill.id === versionOne.id)?.instructions).toBe("版本一正文。");
			const nextLiveSelection = createDesktopAgentSkillContext(store, "session-2", versionTwo.id, [versionTwo]);
			expect(nextLiveSelection.skills.find((skill) => skill.id === versionTwo.id)?.instructions).toBe(
				"版本二正文。",
			);
			store.markSkillLoaded("session-1", versionOne.id);
		} finally {
			store.close();
		}

		const reopened = new DesktopAgentControlStore(databasePath);
		try {
			const disabledSnapshot = listDesktopAgentSessionSkills(reopened, "session-1", undefined, []);
			expect(disabledSnapshot.items.find((skill) => skill.id === versionOne.id)).toMatchObject({
				instructions: "版本一正文。",
				version: 1,
				enabled: false,
			});
			expect(disabledSnapshot.loadedSkillIds).toContain(versionOne.id);
			expect(
				createDesktopAgentSkillContext(reopened, "session-1").skills.some((skill) => skill.id === versionOne.id),
			).toBe(false);
		} finally {
			reopened.close();
		}
	});

	it("keeps disabled project Skills out of the model context", async () => {
		const { store } = await createStore();
		const disabledSkill = {
			id: "project-private-notes",
			key: "project-private-notes",
			name: "停用的项目笔记",
			description: "当前不提供给 Agent",
			instructions: "这些指令不可加载。",
			source: "project" as const,
			category: "general",
			version: 2,
			enabled: false,
		};
		try {
			const context = createDesktopAgentSkillContext(store, "session-1", undefined, [disabledSkill]);
			expect(context.indexLines.some((line) => line.includes(disabledSkill.id))).toBe(false);
			expect(context.skills.some((skill) => skill.id === disabledSkill.id)).toBe(false);
			expect(() => createDesktopAgentSkillContext(store, "session-1", disabledSkill.id, [disabledSkill])).toThrow(
				"SKILL_NOT_FOUND",
			);
		} finally {
			store.close();
		}
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
		database.exec(
			"DROP TABLE agent_session_skill_state; DROP TABLE desktop_memory_candidates; PRAGMA user_version = 2;",
		);
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
