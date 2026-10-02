import { createHash } from "node:crypto";
import type { AgentSkillContext } from "../application/agent-runtime.ts";
import { SYSTEM_SKILLS, type SystemSkillDefinition, skillIndexLine } from "../domain/skill-manifest.ts";
import type { LoadedSkillResource } from "../tools/skill-tools.ts";
import type { DesktopAgentControlStore } from "./control-store.ts";
import type { DesktopAgentSessionStore } from "./session-store.ts";

export type DesktopAgentSkill = {
	id: string;
	key: string;
	name: string;
	description: string;
	instructions: string;
	source: "builtin" | "system_dynamic" | "project";
	category: string;
	version: number;
	enabled: boolean;
};

export type DesktopAgentSkillSnapshot = Omit<DesktopAgentSkill, "source" | "enabled"> & {
	source: "system_dynamic" | "project";
	enabled: true;
	contentHash: string;
};

export type DesktopAgentSkillSnapshotReference = Pick<DesktopAgentSkillSnapshot, "id" | "version" | "contentHash">;

function asResource(skill: SystemSkillDefinition): LoadedSkillResource {
	return { id: skill.key, key: skill.key, name: skill.name, instructions: skill.instructions };
}

export function snapshotDesktopAgentSkill(skill: DesktopAgentSkill): DesktopAgentSkillSnapshot {
	if (
		(skill.source !== "project" && skill.source !== "system_dynamic") ||
		!skill.enabled ||
		typeof skill.id !== "string" ||
		skill.id.length < 1 ||
		skill.id.length > 160 ||
		typeof skill.key !== "string" ||
		skill.key.length < 1 ||
		skill.key.length > 160 ||
		typeof skill.name !== "string" ||
		!skill.name.trim() ||
		typeof skill.description !== "string" ||
		typeof skill.instructions !== "string" ||
		typeof skill.category !== "string" ||
		!Number.isSafeInteger(skill.version) ||
		skill.version < 0
	) {
		throw new Error("SKILL_NOT_FOUND");
	}
	return {
		id: skill.id,
		key: skill.key,
		name: skill.name,
		description: skill.description,
		instructions: skill.instructions,
		source: skill.source,
		category: skill.category,
		version: skill.version,
		enabled: true,
		contentHash: createHash("sha256").update(skill.instructions).digest("hex"),
	};
}

export function listDesktopAgentSkills(
	keyword?: string,
	projectSkills: readonly DesktopAgentSkill[] = [],
): DesktopAgentSkill[] {
	const normalized = typeof keyword === "string" ? keyword.trim().toLocaleLowerCase() : "";
	const systemSkills: DesktopAgentSkill[] = SYSTEM_SKILLS.filter((skill) => {
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
	const matchingProjectSkills = projectSkills.filter((skill) => {
		if (!normalized) return true;
		return [skill.id, skill.key, skill.name, skill.description, skill.instructions, skill.category].some((value) =>
			value.toLocaleLowerCase().includes(normalized),
		);
	});
	return [...systemSkills, ...matchingProjectSkills];
}

export function listDesktopAgentSessionSkills(
	control: DesktopAgentControlStore,
	sessionId: string,
	keyword?: string,
	projectSkills: readonly DesktopAgentSkill[] = [],
): { items: DesktopAgentSkill[]; loadedSkillIds: string[] } {
	const skillsById = new Map(
		listDesktopAgentSkills(undefined, projectSkills).map((skill) => [skill.id, skill] as const),
	);
	for (const snapshot of control.getSessionSkillSnapshots(sessionId)) {
		const current = skillsById.get(snapshot.id);
		if (current?.source === "builtin") continue;
		skillsById.set(snapshot.id, {
			id: snapshot.id,
			key: snapshot.key,
			name: current?.name ?? snapshot.name,
			description: current?.description ?? snapshot.description,
			instructions: snapshot.instructions,
			source: snapshot.source,
			category: current?.category ?? snapshot.category,
			version: snapshot.version,
			enabled: current?.enabled === true,
		});
	}
	const normalized = typeof keyword === "string" ? keyword.trim().toLocaleLowerCase() : "";
	const items = [...skillsById.values()].filter((skill) => {
		if (!normalized) return true;
		return [skill.id, skill.key, skill.name, skill.description, skill.instructions, skill.category].some((value) =>
			value.toLocaleLowerCase().includes(normalized),
		);
	});
	const availableIds = new Set(skillsById.keys());
	const loadedSkillIds = control.getLoadedSkillIds(sessionId).filter((skillId) => availableIds.has(skillId));
	return { items, loadedSkillIds };
}

export async function setDesktopSessionSkills(
	sessions: DesktopAgentSessionStore,
	sessionId: string,
	skillIds: readonly string[],
	availableSkills: readonly DesktopAgentSkill[],
): Promise<{
	sessionId: string;
	skillIds: string[];
	snapshot: DesktopAgentSkillSnapshotReference[];
}> {
	const session = await sessions.getSession(sessionId);
	if (session.status !== "active") throw new Error("SESSION_ARCHIVED");
	if (!Array.isArray(skillIds) || skillIds.some((skillId) => typeof skillId !== "string" || !skillId)) {
		throw new Error("SKILL_SELECTION_INVALID");
	}
	if (new Set(skillIds).size !== skillIds.length) throw new Error("SKILL_SELECTION_INVALID");
	const enabledAvailableSkills = new Map(
		availableSkills
			.filter((skill) => skill.enabled && skill.source !== "builtin")
			.map((skill) => [skill.id, skill] as const),
	);
	const snapshots = skillIds.map((skillId) => {
		const skill = enabledAvailableSkills.get(skillId);
		if (!skill) throw new Error("SKILL_NOT_FOUND");
		return snapshotDesktopAgentSkill(skill);
	});
	const saved = await sessions.setSessionSkillSnapshots(sessionId, snapshots);
	return { sessionId, skillIds: saved.map((skill) => skill.id), snapshot: saved.map(toSnapshotReference) };
}

export async function attachDesktopSessionSkill(
	sessions: DesktopAgentSessionStore,
	sessionId: string,
	skillId: string,
	availableSkills: readonly DesktopAgentSkill[],
): Promise<{
	sessionId: string;
	skillId: string;
	version: number;
	attached: true;
	snapshot: DesktopAgentSkillSnapshotReference;
}> {
	const session = await sessions.getSession(sessionId);
	if (session.status !== "active") throw new Error("SESSION_ARCHIVED");
	const skill = availableSkills.find(
		(candidate) => candidate.id === skillId && candidate.source === "project" && candidate.enabled,
	);
	if (!skill) throw new Error("SKILL_NOT_FOUND");
	const result = await sessions.attachSessionSkillSnapshot(sessionId, snapshotDesktopAgentSkill(skill));
	return {
		sessionId,
		skillId: result.snapshot.id,
		version: result.snapshot.version,
		attached: true,
		snapshot: toSnapshotReference(result.snapshot),
	};
}

export function createDesktopAgentSkillContext(
	control: DesktopAgentControlStore,
	sessionId: string,
	selectedSkillId?: string,
	projectSkills: readonly DesktopAgentSkill[] = [],
): AgentSkillContext {
	const availableById = new Map(
		listDesktopAgentSkills(undefined, projectSkills).map((skill) => [skill.id, skill] as const),
	);
	const resourcesById = new Map<string, LoadedSkillResource>();
	for (const skill of SYSTEM_SKILLS) resourcesById.set(skill.key, asResource(skill));

	const attachedSnapshots = control.getSessionSkillSnapshots(sessionId);
	for (const snapshot of attachedSnapshots) {
		const current = availableById.get(snapshot.id);
		if (!current?.enabled) continue;
		resourcesById.set(snapshot.id, {
			id: snapshot.id,
			key: snapshot.key,
			name: snapshot.name,
			instructions: snapshot.instructions,
		});
	}

	if (selectedSkillId !== undefined && !resourcesById.has(selectedSkillId)) {
		const selected = availableById.get(selectedSkillId);
		if (!selected?.enabled) throw new Error("SKILL_NOT_FOUND");
		resourcesById.set(selected.id, {
			id: selected.id,
			key: selected.key,
			name: selected.name,
			instructions: selected.instructions,
		});
	}

	const resources = [...resourcesById.values()];
	const indexLinesByKey = new Map<string, string>();
	for (const skill of SYSTEM_SKILLS) indexLinesByKey.set(skill.key, skillIndexLine(skill));
	for (const snapshot of attachedSnapshots) {
		if (availableById.get(snapshot.id)?.enabled) {
			indexLinesByKey.set(
				snapshot.key,
				skillIndexLine({
					key: snapshot.key,
					name: snapshot.name,
					kind: "dynamic",
					description: snapshot.description,
				}),
			);
		}
	}
	if (selectedSkillId) {
		const selected = availableById.get(selectedSkillId);
		if (selected?.enabled && !indexLinesByKey.has(selected.key)) {
			indexLinesByKey.set(
				selected.key,
				skillIndexLine({
					key: selected.key,
					name: selected.name,
					kind: "dynamic",
					description: selected.description,
				}),
			);
		}
	}

	const persistedIds = control.getLoadedSkillIds(sessionId);
	const loadedIds = new Set(persistedIds);
	if (selectedSkillId && resourcesById.has(selectedSkillId) && !loadedIds.has(selectedSkillId)) {
		control.markSkillLoaded(sessionId, selectedSkillId);
		loadedIds.add(selectedSkillId);
	}
	return {
		indexLines: [...indexLinesByKey.values()],
		skills: resources,
		loadedSkillIds: [...loadedIds],
		loadedSkills: resources.filter((skill) => loadedIds.has(skill.id)),
		onLoad: async (skill) => {
			const resource = resourcesById.get(skill.id);
			if (!resource || resource.key !== skill.key) throw new Error("SKILL_NOT_FOUND");
			if (loadedIds.has(skill.id)) return;
			control.markSkillLoaded(sessionId, skill.id);
			loadedIds.add(skill.id);
		},
	};
}

function toSnapshotReference(snapshot: DesktopAgentSkillSnapshot): DesktopAgentSkillSnapshotReference {
	return { id: snapshot.id, version: snapshot.version, contentHash: snapshot.contentHash };
}
