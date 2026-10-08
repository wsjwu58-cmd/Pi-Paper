import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const source = resolve(process.cwd(), process.argv[2] ?? "../../../skills/skills.md");
const output = resolve(process.cwd(), "src/domain/skill-manifest.generated.ts");
const keyByName = new Map([
	["漫剧故事圣经", "story-bible"],
	["竖屏短剧单集生成", "vertical-episode"],
	["长内容短剧化改编", "longform-adaptation"],
	["短剧对白润色", "dialogue-polish"],
	["连续剧一致性审校", "continuity-audit"],
	["AI 角色一致性控制", "character-consistency"],
	["短视频完整脚本", "short-video-script"],
	["分镜与镜头清单", "shot-storyboard"],
	["六格漫画", "six-panel-comic"],
	["极简海报", "minimal-poster"],
	["电影海报", "film-poster"],
	["电影感单图", "cinematic-still"],
	["电影感三联图", "cinematic-triptych"],
	["生命感人像", "vital-portrait"],
	["产品视觉", "product-visual"],
	["产品喷绘广告", "product-spray-ad"],
	["反重力产品广告", "anti-gravity-product"],
	["电商经营", "ecommerce-operation"],
	["潮流视觉 PV", "trend-pv"],
	["实景纸刊", "real-scene-paper"],
	["界面设计", "interface-design"],
	["Canvas Cookbook", "canvas-cookbook"],
	["DirectorStage 3D 导演台", "director-stage"],
]);

const content = readFileSync(source, "utf8").replace(/\r\n/g, "\n");
const blocks = content
	.split(/\n-{6,}\n/)
	.map((block) => block.match(/^## \d+\. (.+?)\n([\s\S]*)$/m))
	.filter((block) => block !== null);
const definitions = blocks.map((match) => {
	const name = match[1].trim();
	const body = match[2].trim();
	const descriptionMarker = "### 描述";
	const descriptionStart = body.indexOf(descriptionMarker);
	const nextSection = body.indexOf("\n###", descriptionStart + descriptionMarker.length);
	const description = (descriptionStart < 0 ? "" : body.slice(descriptionStart + descriptionMarker.length, nextSection < 0 ? undefined : nextSection)).trim();
	if (!description || !keyByName.has(name)) throw new Error(`无法提取 Skill：${name}`);
	const instructionStart = body.indexOf("\n###", body.indexOf("### 描述") + 1);
	const instructions = (instructionStart < 0 ? "" : body.slice(instructionStart).trim());
	return {
		key: keyByName.get(name),
		name,
		kind: name === "Canvas Cookbook" || name === "DirectorStage 3D 导演台" ? "builtin-core" : "dynamic",
		category: categoryFor(content, content.indexOf(match[0])),
		description,
		instructions,
	};
});

if (definitions.length !== 23) throw new Error(`期望 23 个 Skill，实际提取 ${definitions.length} 个`);

writeFileSync(
	output,
	`// Generated from skills/skills.md; do not edit manually.\nimport type { SystemSkillDefinition } from "./skill-manifest.ts";\n\nexport const GENERATED_SYSTEM_SKILLS: readonly SystemSkillDefinition[] = ${JSON.stringify(definitions, null, "\t")} as const;\n`,
);

function categoryFor(markdown, index) {
	const before = markdown.slice(0, index);
	const heading = [...before.matchAll(/^# (.+)$/gm)].at(-1)?.[1] ?? "general";
	if (heading.includes("画布")) return "canvas";
	if (heading.includes("海报") || heading.includes("画面") || heading.includes("人像") || heading.includes("漫画")) return "image";
	if (heading.includes("脚本") || heading.includes("短剧") || heading.includes("角色")) return "text";
	return "general";
}
