import { describe, expect, it } from "vitest";

import { buildCanvasContext } from "../src/application/canvas-context-builder.ts";

describe("canvas context builder", () => {
	it("returns selected nodes and one-hop dependencies with sensitive data removed", () => {
		const context = buildCanvasContext(
			{
				authorized: true,
				version: 9,
				summary: "A storyboard",
				nodes: [
					{ id: "1", type: "text", data: { title: "Hero", content: "ready", apiKey: "secret" } },
					{ id: "2", type: "image", data: { title: "Reference" } },
					{ id: "3", type: "video", data: { title: "Unrelated" } },
				],
				edges: [{ source: "1", target: "2" }],
				assets: [{ id: "asset-1", name: "hero.png", url: "https://private.example/hero.png", secret: "hide" }],
				selectedNodeIds: ["1"],
			},
			{ maxCharacters: 10_000 },
		);

		expect(context.version).toBe(9);
		expect(context.selectedNodes).toMatchObject([{ id: "1", data: { title: "Hero", content: "ready" } }]);
		expect(context.oneHopDependencies).toMatchObject([{ id: "2" }]);
		expect(context.summary).toContain("A storyboard");
		expect(JSON.stringify(context)).not.toContain("secret");
	});

	it("rejects unauthorized reads and enforces a bounded context", () => {
		expect(() =>
			buildCanvasContext({
				authorized: false,
				version: 1,
				summary: "x",
				nodes: [],
				edges: [],
				assets: [],
				selectedNodeIds: [],
			}),
		).toThrow("PERMISSION_DENIED");
		const context = buildCanvasContext(
			{
				authorized: true,
				version: 1,
				summary: "x".repeat(100),
				nodes: [],
				edges: [],
				assets: [],
				selectedNodeIds: [],
			},
			{ maxCharacters: 20 },
		);
		expect(context.summary.length).toBeLessThanOrEqual(20);
	});
});
