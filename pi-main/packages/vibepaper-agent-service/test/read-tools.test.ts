import { describe, expect, it } from "vitest";

import { ReadTools, type ReadToolsGateway } from "../src/tools/read-tools.ts";

describe("read-only Agent tools", () => {
	it("exposes canvas, asset, model and task facts through a uniform adapter", async () => {
		const gateway: ReadToolsGateway = {
			getCanvasSummary: async () => ({ version: 3, nodeCount: 2 }),
			getSelectedNodes: async () => [{ id: "1" }],
			getNodeDetail: async () => ({ id: "1", type: "text" }),
			listModels: async () => [{ id: "text-v1", capabilities: ["text"] }],
			searchAssets: async () => [{ id: "asset-1", name: "hero.png" }],
			checkTaskStatus: async () => ({ taskId: "task-1", status: "succeeded" }),
		};
		const tools = new ReadTools(gateway);
		expect(await tools.getCanvasSummary("101", "301")).toEqual({ version: 3, nodeCount: 2 });
		expect(await tools.listModels("101")).toEqual([{ id: "text-v1", capabilities: ["text"] }]);
		expect(await tools.checkTaskStatus("101", "task-1")).toMatchObject({ status: "succeeded" });
	});

	it("maps unauthorized and malformed downstream results to stable tool errors", async () => {
		const gateway: ReadToolsGateway = {
			getCanvasSummary: async () => {
				throw new Error("HTTP_403");
			},
			getSelectedNodes: async () => [],
			getNodeDetail: async () => "invalid" as unknown,
			listModels: async () => [],
			searchAssets: async () => [],
			checkTaskStatus: async () => ({}),
		};
		const tools = new ReadTools(gateway);
		await expect(tools.getCanvasSummary("101", "301")).rejects.toThrow("PERMISSION_DENIED");
		await expect(tools.getNodeDetail("101", "301", "1")).rejects.toThrow("INVALID_RESPONSE");
	});
});
