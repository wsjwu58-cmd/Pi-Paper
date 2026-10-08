import { describe, expect, it } from "vitest";

import {
	type ReferenceMappingEvent,
	referenceMappingClarification,
} from "../src/application/reference-mapping-clarification.ts";

describe("reference mapping clarification", () => {
	const rejected: ReferenceMappingEvent = {
		type: "tool",
		toolName: "create_nodes",
		ok: false,
		errorCode: "INVALID_INPUT",
		details: {
			content: [{ type: "text", text: "[INVALID_INPUT] 选中了多个参考节点，但目标没有明确的来源。" }],
		},
	};

	it("asks the user when the model did not clarify an unresolved mapping", () => {
		expect(referenceMappingClarification([rejected], "后续步骤已处理。")).toContain("分别对应哪个视频镜头");
	});

	it("keeps the model's own mapping question", () => {
		expect(referenceMappingClarification([rejected], "请问哪张图片对应哪个镜头？")).toBeUndefined();
	});

	it("does not ask after the model successfully retries with explicit sources", () => {
		expect(
			referenceMappingClarification([rejected, { type: "tool", toolName: "create_nodes", ok: true }], "已完成。"),
		).toBeUndefined();
	});

	it("does not turn unrelated input errors into a mapping question", () => {
		expect(
			referenceMappingClarification(
				[
					{
						type: "tool",
						toolName: "create_nodes",
						ok: false,
						errorCode: "INVALID_INPUT",
						details: { content: [{ type: "text", text: "[INVALID_INPUT] 创建节点参数不是有效的 JSON 数组。" }] },
					},
				],
				"创建失败。",
			),
		).toBeUndefined();
	});
});
