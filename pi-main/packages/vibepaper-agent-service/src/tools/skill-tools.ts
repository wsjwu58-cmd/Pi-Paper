import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

export interface LoadedSkillResource {
	id: string;
	key: string;
	name: string;
	instructions: string;
}

const LoadSkillSchema = Type.Object({ skill: Type.String({ minLength: 1 }) }, { additionalProperties: false });

export function createLoadSkillTool(
	skills: readonly LoadedSkillResource[],
	loadedSkillIds: readonly string[],
	onLoad: (skill: LoadedSkillResource) => Promise<void>,
): AgentTool[] {
	const loaded = new Set(loadedSkillIds);
	const loadSkill: AgentTool<typeof LoadSkillSchema, { uri: string; alreadyLoaded: boolean }> = {
		name: "load_skill",
		label: "加载 Skill",
		description: "仅在当前任务缺少该 Skill 方法论时按名称或 key 加载全文；同一会话不得重复加载。",
		parameters: LoadSkillSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: { skill: string }) {
			const requested = params.skill.trim().toLowerCase();
			const skill = skills.find(
				(candidate) => candidate.key.toLowerCase() === requested || candidate.name.toLowerCase() === requested,
			);
			if (!skill) throw new Error("请求的 Skill 不在当前会话可用索引中");
			const uri = `skill://session/${skill.id}`;
			if (loaded.has(skill.id)) {
				return {
					content: [{ type: "text", text: `Skill 已在当前会话加载：${uri}。请直接执行，不要重复加载。` }],
					details: { uri, alreadyLoaded: true },
				};
			}
			loaded.add(skill.id);
			await onLoad(skill);
			return {
				content: [
					{
						type: "text",
						text: `已加载 ${skill.name}（${uri}）。\n\n${skill.instructions}\n\n现在必须基于该方法论执行具体动作。`,
					},
				],
				details: { uri, alreadyLoaded: false },
			};
		},
	};
	return [loadSkill];
}
