import { GENERATED_SYSTEM_SKILLS } from "./skill-manifest.generated.ts";

export type SkillKind = "builtin-core" | "dynamic";

export interface SystemSkillDefinition {
	key: string;
	name: string;
	kind: SkillKind;
	category: string;
	description: string;
	instructions: string;
}

export const FALLBACK_SYSTEM_SKILLS: readonly SystemSkillDefinition[] = [
	{
		key: "canvas-cookbook",
		name: "Canvas Cookbook",
		kind: "builtin-core",
		category: "canvas",
		description:
			"把已确定的创作方案落实为节点、连线、派生和异步任务；适用于需要操作画布的执行指令；不用于只讨论创意或只输出文本。",
		instructions:
			"按脚本→分镜→关键帧→视频→合成创建独立可编辑节点；只通过 Tool Gateway 读写画布，生成任务必须经确认和计费。",
	},
	{
		key: "director-stage",
		name: "DirectorStage 导演台",
		kind: "builtin-core",
		category: "canvas",
		description:
			"用 3D 站位、道具与机位预演构图并输出构图参考；适用于复杂调度或机位难以文字确定的镜头；不用于已有参考足够的最终渲染。",
		instructions: "先确定角色站位、道具位置和机位，再将捕获的构图作为关键帧或视频节点的参考输入。",
	},
	{
		key: "story-bible",
		name: "短剧故事圣经",
		kind: "dynamic",
		category: "text",
		description:
			"建立跨集可查询的角色、世界、时间线、钩子、反转和伏笔事实；适用于新项目或设定缺失；不用于已锁定事实的随意改写。",
		instructions:
			"输出并写入结构化事实。主要角色必须包含 3-5 条不可变外形锚点、服装、voice ID 和性格语气；所有冲突必须显式列出。",
	},
	{
		key: "episode-script",
		name: "短剧单集",
		kind: "dynamic",
		category: "text",
		description:
			"将既定故事圣经转为单集剧本、冲突升级和集尾断点；适用于已有世界观后的单集创作；不用于绕过故事圣经直接批量生镜头。",
		instructions: "首 3 秒给钩子，结尾留下断点；不改变既定角色关系、时间线和已确认伏笔。",
	},
	{
		key: "shot-storyboard",
		name: "镜头级分镜",
		kind: "dynamic",
		category: "video",
		description:
			"把单集拆为 ShotSpec、镜头级提示词和可定向重跑的关键帧/视频节点；适用于剧本已确认后的制作；不用于一句话直接出整集。",
		instructions: "默认 9:16、每镜 2-5 秒、先关键帧再视频。人物镜头只能使用当前批准角色参考包。",
	},
	{
		key: "dialogue-polish",
		name: "短剧对白润色",
		kind: "dynamic",
		category: "text",
		description:
			"在不改剧情事实的前提下优化口语感、人物声线与冲突张力；适用于已完成对白；不用于改变既定人物关系或事件。",
		instructions: "一句台词只承担一个意图；保留事实，区分角色说话方式，优先用动作和潜台词。",
	},
	{
		key: "continuity-audit",
		name: "短剧一致性审校",
		kind: "dynamic",
		category: "video",
		description:
			"独立检查角色外形漂移、时间线矛盾、道具穿越和伏笔遗漏；适用于关键帧、视频或单集完成后的验收；不用于为当前生成结果辩护。",
		instructions: "只输出可验证的问题、证据、影响范围和建议动作；不得自行改写创作内容。",
	},
];

export const SYSTEM_SKILLS = GENERATED_SYSTEM_SKILLS.length > 0 ? GENERATED_SYSTEM_SKILLS : FALLBACK_SYSTEM_SKILLS;

export function skillIndexLine(skill: Pick<SystemSkillDefinition, "key" | "name" | "kind" | "description">): string {
	return `- [${skill.kind}] ${skill.name} (${skill.key})：${skill.description}`;
}
