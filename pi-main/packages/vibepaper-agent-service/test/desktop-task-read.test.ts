import { expect, it } from "vitest";
import { DesktopLocalToolGateway } from "../src/desktop/local-tool-gateway.ts";

it("original task tool exposes verified availability and concrete failure without local paths", async () => {
	const gateway = new DesktopLocalToolGateway(
		{
			request: async (method) =>
				method === "agent:core:load-canvas"
					? { projectId: "p", canvasId: "c", version: 0, nodes: [{ id: "n", type: "image", data: {} }], edges: [] }
					: {
							taskId: "t",
							canvasId: "c",
							nodeId: "n",
							status: "succeeded",
							outputPath: "private/path",
							outputVerified: false,
							errorCode: "TASK_OUTPUT_UNAVAILABLE",
							errorMessage: "结果文件校验失败。",
						},
		},
		"p",
	);
	expect(await gateway.checkTaskStatus("p", "t")).toEqual({
		taskId: "t",
		status: "succeeded",
		outputAvailable: false,
		errorCode: "TASK_OUTPUT_UNAVAILABLE",
		errorMessage: "结果文件校验失败。",
	});
});
