import { describe, expect, it } from "vitest";

import { extractMemoryCandidates } from "../src/application/memory-candidate-extractor.ts";

describe("memory candidate extraction", () => {
	it("extracts an explicit durable preference", () => {
		const result = extractMemoryCandidates("请记住：以后默认使用 9:16 画幅。");
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ content: "以后默认使用 9:16 画幅", scope: "long_term", explicit: true });
	});

	it("scopes project rules to the current canvas", () => {
		const result = extractMemoryCandidates("记住：这个画布的角色参考必须先连线再生成");
		expect(result[0]?.scope).toBe("canvas");
		expect(result[0]?.memoryType).toBe("project_rule");
	});

	it("does not turn ordinary conversation into memory", () => {
		expect(extractMemoryCandidates("帮我生成下一镜头的视频")).toEqual([]);
	});
});
