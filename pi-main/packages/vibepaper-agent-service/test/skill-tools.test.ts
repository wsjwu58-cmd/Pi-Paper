import { describe, expect, it } from "vitest";
import { rehydratedSkillInstructions } from "../src/application/agent-runtime.ts";
import { SYSTEM_SKILLS } from "../src/domain/skill-manifest.ts";
import { createLoadSkillTool } from "../src/tools/skill-tools.ts";

describe("Skill progressive disclosure", () => {
	it("extracts all workspace skills with the correct builtin/dynamic split", () => {
		expect(SYSTEM_SKILLS).toHaveLength(23);
		expect(SYSTEM_SKILLS.filter((skill) => skill.kind === "builtin-core").map((skill) => skill.key)).toEqual([
			"canvas-cookbook",
			"director-stage",
		]);
		expect(SYSTEM_SKILLS.filter((skill) => skill.kind === "dynamic")).toHaveLength(21);
		expect(SYSTEM_SKILLS.map((skill) => skill.key)).toEqual(
			expect.arrayContaining([
				"product-visual",
				"product-spray-ad",
				"anti-gravity-product",
				"ecommerce-operation",
				"trend-pv",
				"real-scene-paper",
				"interface-design",
			]),
		);
	});

	it("makes the vertical-episode skill require a connected canvas production workflow", () => {
		const workflow = SYSTEM_SKILLS.find((skill) => skill.key === "vertical-episode");

		expect(workflow?.instructions).toContain("画布生产合同");
		expect(workflow?.instructions).toContain("故事圣经 → 角色参考包 → 剧本与分镜 → 关键帧 → 视频 → 成片合成");
		expect(workflow?.instructions).toContain("上游节点连线");
	});

	it("loads the body once and returns a stable session URI", async () => {
		let loads = 0;
		const [tool] = createLoadSkillTool(
			[{ id: "42", key: "story-bible", name: "短剧故事圣经", instructions: "建立结构化事实。" }],
			[],
			async () => {
				loads += 1;
			},
		);
		const first = await tool.execute("call-1", { skill: "story-bible" });
		expect(first.content[0]).toMatchObject({ text: expect.stringContaining("skill://session/42") });
		expect(loads).toBe(1);
		const second = await tool.execute("call-2", { skill: "story-bible" });
		expect(second.details).toMatchObject({ alreadyLoaded: true });
		expect(loads).toBe(1);
	});

	it("rehydrates bounded instructions from Skills loaded in an earlier turn", () => {
		const context = rehydratedSkillInstructions([
			{ id: "42", key: "story-bible", name: "短剧故事圣经", instructions: "建立结构化事实。" },
		]);
		expect(context).toContain("此前轮次加载");
		expect(context).toContain("建立结构化事实。");
	});
});
