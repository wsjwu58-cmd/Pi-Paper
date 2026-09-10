import { describe, expect, it } from "vitest";

import {
	isNodeCountQuestion,
	missingAssistantReply,
	nodeCountFromCanvasSummary,
	nodeCountReply,
} from "../src/application/canvas-fact-reply.ts";

describe("canvas fact replies", () => {
	it("recognizes Chinese node-count questions", () => {
		expect(isNodeCountQuestion("一共有多少的节点")).toBe(true);
		expect(isNodeCountQuestion("节点数量是多少？")).toBe(true);
		expect(isNodeCountQuestion("帮我整理节点")).toBe(false);
	});

	it("uses the authoritative nodes array for the answer", () => {
		expect(nodeCountFromCanvasSummary({ nodes: [{}, {}, {}] })).toBe(3);
		expect(nodeCountFromCanvasSummary({})).toBeUndefined();
		expect(nodeCountReply(3)).toBe("当前画布共有 3 个节点。");
	});

	it("keeps a user-facing fallback when a tool-only turn has no text", () => {
		expect(missingAssistantReply("一共有多少的节点")).toContain("节点总数");
		expect(missingAssistantReply("帮我看看这个画布")).toContain("完整答复");
	});
});
