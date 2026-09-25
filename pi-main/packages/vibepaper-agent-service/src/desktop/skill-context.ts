import type { AgentSkillContext } from "../application/agent-runtime.ts";
import { SYSTEM_SKILLS, type SystemSkillDefinition, skillIndexLine } from "../domain/skill-manifest.ts";
import type { LoadedSkillResource } from "../tools/skill-tools.ts";
import type { DesktopAgentControlStore } from "./control-store.ts";

export type DesktopAgentSkill = {
	id: string;
	key: string;
	name: string;
	description: string;
	instructions: string;
	source: "builtin" | "system_dynamic";
	category: string;
	version: 1;
	enabled: true;
};

function asResource(skill: SystemSkillDefinition): LoadedSkillResource {
	return { id: skill.key, key: skill.key, name: skill.name, instructions: skill.instructions };
}

export function listDesktopAgentSkills(keyword?: string): DesktopAgentSkill[] {
	const normalized = typeof keyword === "string" ? keyword.trim().toLocaleLowerCase() : "";
	return SYSTEM_SKILLS.filter((skill) => {
		if (!normalized) return true;
		return [skill.key, skill.name, skill.description, skill.instructions, skill.category].some((value) =>
			value.toLocaleLowerCase().includes(normalized),
		);
	}).map((skill) => ({
		id: skill.key,
		key: skill.key,
		name: skill.name,
		description: skill.description,
		instructions: skill.instructions,
		source: skill.kind === "builtin-core" ? "builtin" : "system_dynamic",
		category: skill.category,
		version: 1,
		enabled: true,
	}));
}

export function createDesktopAgentSkillContext(
	control: DesktopAgentControlStore,
	sessionId: string,
	selectedSkillId?: string,
): AgentSkillContext {
	const resources = SYSTEM_SKILLS.map(asResource);
	const resourceById = new Map(resources.map((skill) => [skill.id, skill]));
	if (selectedSkillId !== undefined && !resourceById.has(selectedSkillId)) throw new Error("SKILL_NOT_FOUND");

	const persistedIds = control.getLoadedSkillIds(sessionId);
	const loadedIds = new Set(persistedIds.filter((skillId) => resourceById.has(skillId)));
	if (selectedSkillId && !loadedIds.has(selectedSkillId)) {
		control.markSkillLoaded(sessionId, selectedSkillId);
		loadedIds.add(selectedSkillId);
	}

	return {
		indexLines: SYSTEM_SKILLS.map(skillIndexLine),
		skills: resources,
		loadedSkillIds: [...loadedIds],
		loadedSkills: resources.filter((skill) => loadedIds.has(skill.id)),
		onLoad: async (skill) => {
			const resource = resourceById.get(skill.id);
			if (!resource || resource.key !== skill.key) throw new Error("SKILL_NOT_FOUND");
			if (loadedIds.has(skill.id)) return;
			control.markSkillLoaded(sessionId, skill.id);
			loadedIds.add(skill.id);
		},
	};
}
