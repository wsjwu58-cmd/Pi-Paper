import { describe, expect, it } from "vitest";

import { profileSystemPrompt } from "../src/pi/profile-agents.ts";

describe("canvas-general profile prompt", () => {
	it("gives the public Agent the warm Xiaop companion persona", () => {
		const prompt = profileSystemPrompt("canvas-general");

		expect(prompt).toContain("你的名字是小P");
		expect(prompt).toContain("温暖、陪伴式的画布创作搭档");
		expect(prompt).toContain("绝不提及或自我介绍为任何模型、供应商、开发方");
	});

	it("requires the generation tool instead of a text-only confirmation", () => {
		const prompt = profileSystemPrompt("canvas-general");

		expect(prompt).toContain("不得用文字确认代替 submit_generation");
		expect(prompt).toContain("必须调用 submit_generation");
	});

	it("keeps desktop task-submission confirmation without per-call API prompts or legacy billing", () => {
		const prompt = profileSystemPrompt("canvas-general", { desktopMode: true });

		expect(prompt).toContain("只有用户确认后才加入本地任务队列");
		expect(prompt).toContain("确认只授权创建本地任务，不涉及平台点数、冻结或结算");
		expect(prompt).toContain("普通云端对话请求由用户配置并主动发送，不需要逐次系统确认");
		expect(prompt).not.toContain("扣除点数");
		expect(prompt).not.toContain("模型估价");
	});

	it("requires user-facing replies to omit implementation details and reference relationships to become edges", () => {
		for (const profile of ["canvas-general", "vertical-short-drama"] as const) {
			const prompt = profileSystemPrompt(profile);
			expect(prompt).toContain("不得输出节点 ID、任务 ID、会话 ID、模型或供应商名称、工具名称");
			expect(prompt).toContain("必须创建从参考节点到目标节点的连线");
		}
	});

	it("requires the short-drama profile to declare workflow dependencies when creating nodes", () => {
		const prompt = profileSystemPrompt("vertical-short-drama");

		expect(prompt).toContain("sourceNodeIds");
		expect(prompt).toContain("直接上游");
	});

	it("does not ask the model to reconnect declared source nodes with guessed ids", () => {
		const prompt = profileSystemPrompt("canvas-general");

		expect(prompt).toContain("不要再次调用 connect_nodes");
		expect(prompt).toContain("严禁猜测或复用不存在的节点 ID");
	});

	it("requires a modality-matched target node before submitting generation", () => {
		const prompt = profileSystemPrompt("canvas-general");

		expect(prompt).toContain("先创建与生成类型匹配的目标节点");
		expect(prompt).toContain("不能把 Text 节点作为图片、视频或音频生成目标");
	});

	it("uses image nodes for keyframes and video nodes for clips", () => {
		const prompt = profileSystemPrompt("vertical-short-drama");

		expect(prompt).toContain("type=image 且 creativeType=keyframe");
		expect(prompt).toContain("type=video 且 creativeType=clip");
	});

	it("uses the compose input contract and one edge per connection", () => {
		const prompt = profileSystemPrompt("canvas-general");

		expect(prompt).toContain("modelParams.inputNodeIds");
		expect(prompt).toContain("不能一次把三个或更多节点塞进同一条 Edge");
	});

	it("keeps director nodes on the Canvas creativeType contract", () => {
		expect(profileSystemPrompt("vertical-short-drama")).toContain("director 节点不要设置 creativeType");
	});

	it("requires create_nodes to receive a JSON array instead of a serialized string", () => {
		expect(profileSystemPrompt("vertical-short-drama")).toContain("nodes 必须是 JSON 数组");
	});
});
