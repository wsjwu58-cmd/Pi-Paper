import { describe, expect, it } from "vitest";

import { formatIntentContext, routeAgentIntent } from "../src/application/intent-router.ts";

describe("Agent intent router", () => {
	it("routes canvas counts without planning or confirmation", () => {
		const intent = routeAgentIntent({ content: "画布上一共有多少个节点？", profile: "canvas-general" });
		expect(intent).toMatchObject({ kind: "canvas_fact", requiresPlan: false, requiresConfirmation: false });
	});

	it("routes multi-step creative requests to a plan before execution", () => {
		const intent = routeAgentIntent({
			content: "先写分镜，再生成三张关键帧并连接成短剧工作流",
			profile: "canvas-general",
			selectedNodeCount: 2,
		});
		expect(intent).toMatchObject({ kind: "creative_workflow", requiresPlan: true, requiresConfirmation: true });
		expect(formatIntentContext(intent)).toContain("先说明计划");
	});

	it("keeps ambiguous language in the safe conversation path", () => {
		expect(routeAgentIntent({ content: "帮我想想", profile: "canvas-general" }).kind).toBe("conversation");
	});
});
