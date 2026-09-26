import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import { ApprovalService, InMemoryApprovalRepository } from "../src/application/approval-service.ts";
import { ToolGatewayError } from "../src/infrastructure/tool-gateway.ts";
import { createRuntimeTools } from "../src/tools/runtime-tools.ts";

describe("runtime tool integration", () => {
	it("retries transient gateway failures and reports each retry to the execution timeline", async () => {
		let calls = 0;
		const updates: unknown[] = [];
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 1,
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				getCanvasSummary: async () => {
					calls += 1;
					if (calls < 3) throw new ToolGatewayError("MODEL_TIMEOUT", "temporary timeout", {}, 504);
					return { canvas: { version: 1 }, nodes: [], edges: [] };
				},
			} as never,
		});

		await expect(
			tools
				.find((tool) => tool.name === "get_canvas_summary")!
				.execute("retry-summary", {}, undefined, (update) => updates.push(update)),
		).resolves.toMatchObject({ content: [{ type: "text" }] });
		expect(calls).toBe(3);
		expect(updates.map((update) => (update as { details?: { attempt?: number } }).details?.attempt)).toEqual([2, 3]);
	});

	it("does not retry a non-recoverable gateway error", async () => {
		let calls = 0;
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 1,
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				getCanvasSummary: async () => {
					calls += 1;
					throw new ToolGatewayError("VERSION_CONFLICT", "stale canvas", {}, 409);
				},
			} as never,
		});

		await expect(
			tools.find((tool) => tool.name === "get_canvas_summary")!.execute("no-retry", {}),
		).rejects.toMatchObject({
			code: "VERSION_CONFLICT",
		});
		expect(calls).toBe(1);
	});

	it("refreshes the canvas version and retries a conflicted node creation once", async () => {
		let writes = 0;
		let reads = 0;
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 1,
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				execute: async () => {
					writes += 1;
					if (writes === 1) throw new ToolGatewayError("VERSION_CONFLICT", "stale canvas", {}, 409);
					return { createdNodes: [], canvasVersion: 5 };
				},
				getCanvasSummary: async () => {
					reads += 1;
					return { canvas: { version: 4 }, nodes: [], edges: [] };
				},
			} as never,
		});

		await expect(
			tools
				.find((tool) => tool.name === "create_nodes")!
				.execute("create-after-conflict", {
					nodes: [{ type: "text", params: { content: "故事圣经" } }],
				}),
		).resolves.toMatchObject({ content: [{ type: "text" }] });
		expect({ reads, writes }).toEqual({ reads: 1, writes: 2 });
	});

	it("adopts the authoritative canvas version returned by a summary before writes", async () => {
		const approvals = new ApprovalService(new InMemoryApprovalRepository(), "secret", 300);
		const commands: unknown[] = [];
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 0,
			approvals,
			gateway: {
				getCanvasSummary: async () => ({ canvas: { version: 7 }, nodes: [], edges: [] }),
				execute: async (command: unknown) => {
					commands.push(command);
					return { canvasVersion: 8 };
				},
			} as never,
		});

		await tools.find((tool) => tool.name === "get_canvas_summary")!.execute("tool-summary", {});
		await tools
			.find((tool) => tool.name === "create_nodes")!
			.execute("tool-create", {
				nodes: [{ type: "text", params: { content: "x" } }],
				expectedVersion: 7,
				idempotencyKey: "create-1",
			});

		expect(commands[0]).toMatchObject({ expectedVersion: 7, operation: "create_nodes" });
	});

	it("accepts a serialized node array but rejects display-only node shapes", () => {
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 1,
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {} as never,
		});
		const create = tools.find((tool) => tool.name === "create_nodes");

		expect(create).toBeDefined();
		expect(
			Value.Check(create!.parameters, {
				nodes: [{ type: "text", params: { content: "x" } }],
			}),
		).toBe(true);
		expect(Value.Check(create!.parameters, { nodes: '[{"type":"text","params":{"content":"x"}}]' })).toBe(true);
		expect(
			Value.Check(create!.parameters, {
				type: "text",
				nodes: '[{"type":"text","params":{"content":"x"}}]',
			}),
		).toBe(true);
		expect(
			Value.Check(create!.parameters, {
				nodes: [{ id: "draft-copy", content: "x", contentType: "text" }],
				expectedVersion: 1,
				idempotencyKey: "create-text",
			}),
		).toBe(false);
	});

	it("keeps desktop tool availability separate from the legacy Web generation contract", () => {
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 1,
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				estimateGeneration: async () => ({ estimatedCost: 0, pricingVersion: 1, models: [] }),
			} as never,
			desktopMode: true,
		});

		const names = tools.map((tool) => tool.name);
		expect(names).toContain("create_nodes");
		expect(names).not.toContain("delete_nodes");
		expect(names).toContain("submit_generation");
		expect(names).toContain("submit_generation_batch");
	});

	it("parses a serialized node array before sending the canvas command", async () => {
		const commands: Array<Record<string, unknown>> = [];
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 7,
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				execute: async (command: Record<string, unknown>) => {
					commands.push(command);
					return { canvasVersion: 8 };
				},
			} as never,
		});

		await tools
			.find((tool) => tool.name === "create_nodes")!
			.execute("serialized-call", {
				type: "text",
				nodes: '[{"type":"text","params":{"content":"正文"}}]',
			});

		expect(commands[0]).toMatchObject({
			operation: "create_nodes",
			payload: { nodes: [{ type: "text", params: { content: "正文" } }] },
		});
	});

	it("supplies canvas-write idempotency internally when the model only provides node content", async () => {
		const commands: Array<Record<string, unknown>> = [];
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			runId: "301",
			canvasId: "401",
			canvasVersion: 7,
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				execute: async (command: Record<string, unknown>) => {
					commands.push(command);
					return { canvasVersion: 8 };
				},
			} as never,
		});

		await tools
			.find((tool) => tool.name === "create_nodes")!
			.execute("call-1", { nodes: [{ type: "text", creativeType: "script", params: { content: "正文" } }] });

		expect(commands[0]).toMatchObject({ idempotencyKey: "301:canvas:call-1", expectedVersion: 7 });
	});

	it("normalizes serialized node IDs for deletion and owns mechanical write fields", async () => {
		const commands: Array<Record<string, unknown>> = [];
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			runId: "301",
			canvasId: "401",
			canvasVersion: 7,
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				execute: async (command: Record<string, unknown>) => {
					commands.push(command);
					return { canvasVersion: 8 };
				},
			} as never,
		});
		const remove = tools.find((tool) => tool.name === "delete_nodes")!;

		expect(
			Value.Check(remove.parameters, {
				nodeIds: '["node-a","node-b"]',
				expectedVersion: "38",
				idempotencyKey: "model-key",
			}),
		).toBe(true);
		await remove.execute("delete-call", {
			nodeIds: '["node-a","node-b"]',
			expectedVersion: "38",
			idempotencyKey: "model-key",
		});

		expect(commands[0]).toMatchObject({
			operation: "delete_nodes",
			expectedVersion: 7,
			idempotencyKey: "model-key",
			payload: { nodeIds: ["node-a", "node-b"] },
		});
	});

	it("connects selected references to newly created media nodes", async () => {
		const commands: Array<Record<string, unknown>> = [];
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 1,
			referenceNodeIds: ["source-image"],
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				execute: async (command: Record<string, unknown>) => {
					commands.push(command);
					if (command.operation === "create_nodes")
						return { createdNodes: [{ id: "derived-video" }], canvasVersion: 2 };
					return { canvasVersion: 3 };
				},
			} as never,
		});

		await tools
			.find((tool) => tool.name === "create_nodes")!
			.execute("tool-create", {
				nodes: [{ type: "video", params: { prompt: "由参考画面延展镜头" } }],
				expectedVersion: 1,
				idempotencyKey: "create-video",
			});

		expect(commands).toHaveLength(2);
		expect(commands[1]).toMatchObject({
			operation: "connect_nodes",
			expectedVersion: 2,
			payload: { nodeIds: ["source-image", "derived-video"] },
		});
	});

	it("rejects ambiguous multi-selection before creating any nodes or edges", async () => {
		const commands: Array<Record<string, unknown>> = [];
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 1,
			referenceNodeIds: ["shot-image-1", "shot-image-2", "shot-image-3"],
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				execute: async (command: Record<string, unknown>) => {
					commands.push(command);
					return { createdNodes: [], canvasVersion: 2 };
				},
			} as never,
		});

		await expect(
			tools
				.find((tool) => tool.name === "create_nodes")!
				.execute("tool-create", {
					nodes: [
						{ type: "video", params: { prompt: "镜头一" } },
						{ type: "video", params: { prompt: "镜头二" } },
						{ type: "video", params: { prompt: "镜头三" } },
					],
					expectedVersion: 1,
					idempotencyKey: "create-three-videos",
				}),
		).rejects.toThrow(/INVALID_INPUT.*先向用户询问/);
		expect(commands).toHaveLength(0);
	});

	it("creates only the three declared one-to-one image-to-video edges", async () => {
		const commands: Array<Record<string, unknown>> = [];
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 1,
			referenceNodeIds: ["shot-image-1", "shot-image-2", "shot-image-3"],
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				execute: async (command: Record<string, unknown>) => {
					commands.push(command);
					if (command.operation === "create_nodes")
						return {
							createdNodes: [{ id: "shot-video-1" }, { id: "shot-video-2" }, { id: "shot-video-3" }],
							canvasVersion: 2,
						};
					return { canvasVersion: commands.length + 1 };
				},
			} as never,
		});

		await tools
			.find((tool) => tool.name === "create_nodes")!
			.execute("tool-create", {
				nodes: [
					{ type: "video", sourceNodeIds: ["shot-image-1"], params: { prompt: "镜头一" } },
					{ type: "video", sourceNodeIds: ["shot-image-2"], params: { prompt: "镜头二" } },
					{ type: "video", sourceNodeIds: ["shot-image-3"], params: { prompt: "镜头三" } },
				],
				expectedVersion: 1,
				idempotencyKey: "create-three-videos-one-to-one",
			});

		expect(commands).toHaveLength(4);
		const edgePayloads = commands
			.filter((command) => command.operation === "connect_nodes")
			.map((command) => command.payload);
		expect(edgePayloads).toEqual([
			{ nodeIds: ["shot-image-1", "shot-video-1"] },
			{ nodeIds: ["shot-image-2", "shot-video-2"] },
			{ nodeIds: ["shot-image-3", "shot-video-3"] },
		]);
	});

	it("preserves an explicitly declared multi-reference input for one target", async () => {
		const commands: Array<Record<string, unknown>> = [];
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 1,
			referenceNodeIds: ["reference-image-1", "reference-image-2"],
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				execute: async (command: Record<string, unknown>) => {
					commands.push(command);
					if (command.operation === "create_nodes")
						return { createdNodes: [{ id: "derived-video" }], canvasVersion: 2 };
					return { canvasVersion: commands.length + 1 };
				},
			} as never,
		});

		await tools
			.find((tool) => tool.name === "create_nodes")!
			.execute("tool-create", {
				nodes: [{ type: "video", sourceNodeIds: ["reference-image-1", "reference-image-2"] }],
				expectedVersion: 1,
				idempotencyKey: "create-multi-reference-video",
			});

		const edgePayloads = commands
			.filter((command) => command.operation === "connect_nodes")
			.map((command) => command.payload);
		expect(edgePayloads).toEqual([
			{ nodeIds: ["reference-image-1", "derived-video"] },
			{ nodeIds: ["reference-image-2", "derived-video"] },
		]);
	});

	it("does not add incompatible selected references when a media node declares its sources", async () => {
		const commands: Array<Record<string, unknown>> = [];
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 1,
			// The UI can submit all currently selected nodes. The explicit source
			// list on the generated node is the authoritative subset for this write.
			referenceNodeIds: ["source-text", "source-video"],
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				execute: async (command: Record<string, unknown>) => {
					commands.push(command);
					if (command.operation === "create_nodes")
						return { createdNodes: [{ id: "derived-audio" }], canvasVersion: 2 };
					return { canvasVersion: 3 };
				},
			} as never,
		});

		await tools
			.find((tool) => tool.name === "create_nodes")!
			.execute("tool-create", {
				nodes: [{ type: "audio", sourceNodeIds: ["source-text"], params: { text: "对白" } }],
				expectedVersion: 1,
				idempotencyKey: "create-audio-with-explicit-source",
			});

		expect(commands).toHaveLength(2);
		expect(commands[1]).toMatchObject({
			operation: "connect_nodes",
			payload: { nodeIds: ["source-text", "derived-audio"] },
		});
	});

	it.each([
		["text-to-image", "source-text", "image"],
		["image-to-image", "source-image", "image"],
		["image-to-video", "source-image", "video"],
	] as const)("creates a selected %s reference edge", async (_scenario, sourceNodeId, targetType) => {
		const commands: Array<Record<string, unknown>> = [];
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 1,
			referenceNodeIds: [sourceNodeId],
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				execute: async (command: Record<string, unknown>) => {
					commands.push(command);
					if (command.operation === "create_nodes")
						return { createdNodes: [{ id: "target-node" }], canvasVersion: 2 };
					return { canvasVersion: 3 };
				},
			} as never,
		});

		await tools
			.find((tool) => tool.name === "create_nodes")!
			.execute("tool-create", {
				nodes: [{ type: targetType, params: { content: "由所选参考节点生成" } }],
				expectedVersion: 1,
				idempotencyKey: `create-${targetType}`,
			});

		expect(commands).toHaveLength(2);
		expect(commands[1]).toMatchObject({
			operation: "connect_nodes",
			expectedVersion: 2,
			payload: { nodeIds: [sourceNodeId, "target-node"] },
		});
	});

	it("connects declared short-drama workflow sources to every created stage", async () => {
		const commands: Array<Record<string, unknown>> = [];
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 1,
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				execute: async (command: Record<string, unknown>) => {
					commands.push(command);
					if (command.operation === "create_nodes")
						return {
							createdNodes: [
								{ id: "story-bible" },
								{ id: "shot-list" },
								{ id: "keyframe" },
								{ id: "shot-video" },
								{ id: "final-compose" },
							],
							canvasVersion: 2,
						};
					return { canvasVersion: commands.length + 1 };
				},
			} as never,
		});

		await tools
			.find((tool) => tool.name === "create_nodes")!
			.execute("tool-create", {
				nodes: [
					{ type: "text", params: { content: "故事圣经" } },
					{ type: "text", sourceNodeIds: ["story-bible"], params: { content: "15 镜分镜" } },
					{ type: "image", sourceNodeIds: ["shot-list"], params: { content: "镜头一关键帧" } },
					{ type: "video", sourceNodeIds: ["keyframe"], params: { content: "镜头一视频" } },
					{ type: "compose", sourceNodeIds: ["shot-video"], params: { content: "最终成片" } },
				],
				expectedVersion: 1,
				idempotencyKey: "create-short-drama-workflow",
			});

		expect(commands.filter((command) => command.operation === "connect_nodes")).toEqual([
			expect.objectContaining({ payload: { nodeIds: ["story-bible", "shot-list"] } }),
			expect.objectContaining({ payload: { nodeIds: ["shot-list", "keyframe"] } }),
			expect.objectContaining({ payload: { nodeIds: ["keyframe", "shot-video"] } }),
			expect.objectContaining({ payload: { nodeIds: ["shot-video", "final-compose"] } }),
		]);
	});

	it("binds a generation confirmation to the version returned after a node write", async () => {
		const approvals = new ApprovalService(new InMemoryApprovalRepository(), "secret", 300);
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 1,
			approvals,
			gateway: {
				execute: async () => ({ canvasVersion: 2 }),
				getCanvasSummary: async () => ({ canvas: { version: 2 }, edges: [] }),
				estimateGeneration: async () => ({ estimatedCost: 4, pricingVersion: 1, models: [] }),
			} as never,
		});

		await tools
			.find((tool) => tool.name === "create_nodes")!
			.execute("tool-create", {
				nodes: [{ type: "image", params: { prompt: "bird" } }],
				expectedVersion: 1,
				idempotencyKey: "create-image",
			});
		const result = await tools
			.find((tool) => tool.name === "submit_generation")!
			.execute("tool-submit", {
				nodeId: "401",
				modelType: "image",
				modelParams: { prompt: "bird" },
				overwrite: false,
			});

		expect(result.details).toMatchObject({ confirmation: { canvasVersion: 2 } });
	});

	it("fills a missing generation prompt from the authoritative Canvas node", async () => {
		let estimatedParams: Record<string, unknown> | undefined;
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 1,
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				getNodeDetail: async () => ({ id: "401", prompt: "authoritative bottle prompt" }),
				getCanvasSummary: async () => ({ canvas: { version: 1 }, edges: [] }),
				estimateGeneration: async (input: { modelParams: Record<string, unknown> }) => {
					estimatedParams = input.modelParams;
					return { estimatedCost: 4, pricingVersion: 1, models: [] };
				},
			} as never,
		});

		await tools
			.find((tool) => tool.name === "submit_generation")!
			.execute("tool-submit", {
				nodeId: "401",
				modelType: "image",
				modelParams: { size: "2K" },
				overwrite: false,
			});

		expect(estimatedParams).toMatchObject({ size: "2K", prompt: "authoritative bottle prompt" });
	});

	it("uses authoritative node content when a generated node has no prompt field", async () => {
		let estimatedParams: Record<string, unknown> | undefined;
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 1,
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				getNodeDetail: async () => ({ id: "401", prompt: null, params: { content: "generated image prompt" } }),
				getCanvasSummary: async () => ({ canvas: { version: 1 }, edges: [] }),
				estimateGeneration: async (input: { modelParams: Record<string, unknown> }) => {
					estimatedParams = input.modelParams;
					return { estimatedCost: 4, pricingVersion: 1, models: [] };
				},
			} as never,
		});

		await tools
			.find((tool) => tool.name === "submit_generation")!
			.execute("tool-submit", {
				nodeId: "401",
				modelType: "image",
				modelParams: { size: "2K" },
				overwrite: false,
			});

		expect(estimatedParams).toMatchObject({ size: "2K", prompt: "generated image prompt" });
	});

	it("falls back to the selected reference scene when a derived target has no prompt", async () => {
		let estimatedParams: Record<string, unknown> | undefined;
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 1,
			referenceNodeIds: ["director-1"],
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				getNodeDetail: async (_userId: string, _canvasId: string, nodeId: string) =>
					nodeId === "401"
						? { id: "401", prompt: null, params: { referenceImageUrl: "/captures/scene.png" } }
						: {
								id: "director-1",
								type: "director",
								params: { description: "雨巷对峙，女主左侧，男主靠墙，路灯居中" },
							},
				getSelectedNodes: async () => [
					{
						id: "director-1",
						type: "director",
						params: { description: "雨巷对峙，女主左侧，男主靠墙，路灯居中" },
					},
				],
				getCanvasSummary: async () => ({ canvas: { version: 1 }, edges: [] }),
				estimateGeneration: async (input: { modelParams: Record<string, unknown> }) => {
					estimatedParams = input.modelParams;
					return { estimatedCost: 4, pricingVersion: 1, models: [] };
				},
			} as never,
		});

		await tools
			.find((tool) => tool.name === "submit_generation")!
			.execute("tool-submit", {
				nodeId: "401",
				modelType: "image",
				modelParams: { referenceImageUrl: "/captures/scene.png" },
				overwrite: false,
			});

		expect(estimatedParams).toMatchObject({ prompt: "雨巷对峙，女主左侧，男主靠墙，路灯居中" });
	});

	it("falls back through the authoritative Canvas edge for a newly created derived target", async () => {
		let estimatedParams: Record<string, unknown> | undefined;
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 3,
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				getNodeDetail: async () => ({
					id: "401",
					prompt: null,
					params: { referenceImageUrl: "/captures/scene.png" },
				}),
				getCanvasSummary: async () => ({
					canvas: { version: 3 },
					edges: [{ sourceNodeId: "director-1", targetNodeId: "401" }],
				}),
				getSelectedNodes: async () => [
					{ id: "director-1", type: "director", params: { description: "雨巷对峙构图" } },
				],
				estimateGeneration: async (input: { modelParams: Record<string, unknown> }) => {
					estimatedParams = input.modelParams;
					return { estimatedCost: 4, pricingVersion: 1, models: [] };
				},
			} as never,
		});

		await tools
			.find((tool) => tool.name === "submit_generation")!
			.execute("tool-submit", {
				nodeId: "401",
				modelType: "image",
				modelParams: { referenceImageUrl: "/captures/scene.png" },
				overwrite: false,
			});

		expect(estimatedParams).toMatchObject({ prompt: "雨巷对峙构图" });
	});

	it("infers image operations from the authoritative generation request", async () => {
		let estimatedParams: Record<string, unknown> | undefined;
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 1,
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				getNodeDetail: async () => ({ id: "401", prompt: null, params: { content: "将原图向右扩展留白" } }),
				getCanvasSummary: async () => ({ canvas: { version: 1 }, edges: [] }),
				estimateGeneration: async (input: { modelParams: Record<string, unknown> }) => {
					estimatedParams = input.modelParams;
					return { estimatedCost: 4, pricingVersion: 1, models: [] };
				},
			} as never,
		});

		await tools
			.find((tool) => tool.name === "submit_generation")!
			.execute("tool-submit", {
				nodeId: "401",
				modelType: "image",
				modelParams: { size: "2K" },
				overwrite: false,
			});

		expect(estimatedParams).toMatchObject({ operation: "outpaint_image" });
	});

	it("normalizes legacy extend-right image operations", async () => {
		let estimatedParams: Record<string, unknown> | undefined;
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 1,
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				getNodeDetail: async () => ({ id: "401", prompt: "source image" }),
				getCanvasSummary: async () => ({ canvas: { version: 1 }, edges: [] }),
				estimateGeneration: async (input: { modelParams: Record<string, unknown> }) => {
					estimatedParams = input.modelParams;
					return { estimatedCost: 4, pricingVersion: 1, models: [] };
				},
			} as never,
		});

		await tools
			.find((tool) => tool.name === "submit_generation")!
			.execute("tool-submit", {
				nodeId: "401",
				modelType: "image",
				modelParams: { operation: "extend_right" },
				overwrite: false,
			});

		expect(estimatedParams).toMatchObject({ operation: "outpaint_image" });
	});

	it("rejects a generation when the supplied canvas version is stale", async () => {
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 1,
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				getCanvasSummary: async () => ({ canvas: { version: 3 } }),
				estimateGeneration: async () => {
					throw new Error("stale canvas should fail before estimate");
				},
			} as never,
		});

		await expect(
			tools
				.find((tool) => tool.name === "submit_generation")!
				.execute("tool-submit", {
					nodeId: "401",
					modelType: "image",
					modelParams: { prompt: "bird" },
					overwrite: false,
				}),
		).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
	});

	it("rejects compose confirmation before estimating when fewer than two video inputs are supplied", async () => {
		let estimated = false;
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 1,
			approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
			gateway: {
				resolveGenerationModel: async () => "compose-1.0",
				getCanvasSummary: async () => ({ canvas: { version: 1 }, edges: [] }),
				estimateGeneration: async () => {
					estimated = true;
					return { estimatedCost: 15, pricingVersion: 1, models: [] };
				},
			} as never,
		});

		await expect(
			tools
				.find((tool) => tool.name === "submit_generation")!
				.execute("tool-submit", {
					nodeId: "401",
					modelType: "compose-1.0",
					modelParams: { prompt: "compose", inputNodeIds: ["video-1"] },
					overwrite: false,
				}),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		expect(estimated).toBe(false);
	});

	it("creates a persisted confirmation action instead of freezing during tool execution", async () => {
		const approvals = new ApprovalService(new InMemoryApprovalRepository(), "secret", 300);
		let requestedAction: string | undefined;
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 4,
			approvals,
			gateway: {
				resolveGenerationModel: async () => "agnes-image-2.5-flash",
				getCanvasSummary: async () => ({ canvas: { version: 4 }, edges: [] }),
				estimateGeneration: async () => ({ estimatedCost: 4, pricingVersion: 2, models: [] }),
			} as never,
			onApprovalRequired: (action) => {
				requestedAction = action.actionId;
			},
		});

		const submit = tools.find((tool) => tool.name === "submit_generation");
		expect(submit).toBeDefined();
		const output = await submit!.execute("tool-1", {
			nodeId: "401",
			modelType: "Agnes Image",
			modelParams: { prompt: "bird" },
			estimatedCost: 4,
			overwrite: false,
		});

		expect(requestedAction).toBeDefined();
		expect(output.terminate).toBe(true);
		expect(output.details).toMatchObject({
			confirmation: { canvasVersion: 4, estimatedCost: 4, params: { modelType: "agnes-image-2.5-flash" } },
		});
	});

	it("stages local SAPI audio single and batch tools for confirmation before any task write", async () => {
		const requestedActions: Array<Record<string, unknown>> = [];
		let taskWrites = 0;
		const buildTools = (sessionId: string) =>
			createRuntimeTools({
				userId: "project-1",
				sessionId,
				canvasId: "canvas-audio",
				canvasVersion: 4,
				approvals: new ApprovalService(new InMemoryApprovalRepository(), "secret", 300),
				desktopMode: true,
				gateway: {
					resolveGenerationModel: async (_userId: string, requestedModel: string) => requestedModel,
					getCanvasSummary: async () => ({ canvas: { version: 4 }, nodes: [], edges: [] }),
					createGenerationTask: async () => {
						taskWrites += 1;
						return { taskId: "unexpected", status: "queued", modality: "audio", nodeId: "audio-node" };
					},
				} as never,
				onApprovalRequired: (action) => requestedActions.push(action as unknown as Record<string, unknown>),
			});
		const single = buildTools("session-audio-single").find((tool) => tool.name === "submit_generation")!;
		const batch = buildTools("session-audio-batch").find((tool) => tool.name === "submit_generation_batch")!;

		const singleResult = await single.execute("audio-single", {
			nodeId: "audio-node-1",
			modelType: "local-sapi-tts",
			modelParams: { prompt: "朗读第一段。", voice: "female", language: "zh-CN", speed: 0.9 },
			overwrite: false,
		});
		expect(singleResult.terminate).toBe(true);
		expect(singleResult.details).toMatchObject({
			confirmation: {
				toolName: "submit_generation",
				estimatedCost: 0,
				params: {
					modelType: "local-sapi-tts",
					modelParams: { prompt: "朗读第一段。", voice: "female", language: "zh-CN", speed: 0.9 },
				},
			},
		});
		expect(taskWrites).toBe(0);

		const batchResult = await batch.execute("audio-batch", {
			generations: [
				{
					nodeId: "audio-node-2",
					modelType: "local-sapi-tts",
					modelParams: { prompt: "朗读第二段。", voice: "female" },
					overwrite: false,
				},
				{
					nodeId: "audio-node-3",
					modelType: "local-sapi-tts",
					modelParams: { prompt: "朗读第三段。", voice: "male" },
					overwrite: false,
				},
			],
		});
		expect(batchResult.terminate).toBe(true);
		expect(batchResult.details).toMatchObject({
			confirmation: {
				toolName: "submit_generation_batch",
				estimatedCost: 0,
				params: {
					generations: [
						{ modelType: "local-sapi-tts", modelParams: { prompt: "朗读第二段。", voice: "female" } },
						{ modelType: "local-sapi-tts", modelParams: { prompt: "朗读第三段。", voice: "male" } },
					],
				},
			},
		});
		expect(requestedActions).toHaveLength(2);
		expect(taskWrites).toBe(0);
	});

	it("blocks a canvas write queued after a confirmation request in the same turn", async () => {
		const approvals = new ApprovalService(new InMemoryApprovalRepository(), "secret", 300);
		const tools = createRuntimeTools({
			userId: "101",
			sessionId: "201",
			canvasId: "301",
			canvasVersion: 4,
			approvals,
			gateway: {
				resolveGenerationModel: async () => "agnes-image-2.5-flash",
				getCanvasSummary: async () => ({ canvas: { version: 4 }, edges: [] }),
				estimateGeneration: async () => ({ estimatedCost: 4, pricingVersion: 1, models: [] }),
			} as never,
			onApprovalRequired: async () => {},
		});

		await tools
			.find((tool) => tool.name === "submit_generation")!
			.execute("tool-submit", {
				nodeId: "401",
				modelType: "image",
				modelParams: { prompt: "bird" },
				overwrite: false,
			});

		await expect(
			tools
				.find((tool) => tool.name === "connect_nodes")!
				.execute("tool-connect", {
					nodeIds: ["source", "target"],
					expectedVersion: 4,
					idempotencyKey: "connect-after-confirmation",
				}),
		).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
	});
});
