import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { ToolGateway } from "../src/infrastructure/tool-gateway.ts";

describe("ToolGateway generation contract", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("resolves a display-name prefix to the enabled canonical generation model name", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.endsWith("/api/v1/models"))
					return new Response(
						JSON.stringify({
							items: [
								{
									name: "agnes-image-2.5-flash",
									displayName: "Agnes Image 2.5 Flash",
									modelType: "image",
									enabled: true,
								},
								{
									name: "agnes-video-2.5-flash",
									displayName: "Agnes Video 2.5 Flash",
									modelType: "video",
									enabled: true,
								},
							],
						}),
						{ status: 200 },
					);
				return new Response("{}", { status: 200 });
			}),
		);

		await expect(new ToolGateway(loadConfig({})).resolveGenerationModel("101", "Agnes Video")).resolves.toBe(
			"agnes-video-2.5-flash",
		);
	});

	it("resolves legacy modality aliases to the sole enabled canonical model", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.endsWith("/api/v1/models"))
					return new Response(
						JSON.stringify({
							items: [
								{ name: "agnes-image-2.5-flash", modelType: "image", enabled: true },
								{ name: "agnes-video-2.5-flash", modelType: "video", enabled: true },
								{ name: "director-1.0", modelType: "director", enabled: true },
							],
						}),
						{ status: 200 },
					);
				return new Response("{}", { status: 200 });
			}),
		);

		const gateway = new ToolGateway(loadConfig({}));
		await expect(gateway.resolveGenerationModel("101", "flux")).resolves.toBe("agnes-image-2.5-flash");
		await expect(gateway.resolveGenerationModel("101", "kling")).resolves.toBe("agnes-video-2.5-flash");
		await expect(gateway.resolveGenerationModel("101", "director")).resolves.toBe("director-1.0");
	});

	it("accepts an idempotent canvas-node replay when the canvas version is unchanged", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.endsWith("/api/v1/canvases/301"))
					return new Response(JSON.stringify({ canvas: { version: 7 }, nodes: [] }), { status: 200 });
				if (url.endsWith("/nodes")) return new Response(JSON.stringify({ id: "node-1" }), { status: 201 });
				return new Response("{}", { status: 200 });
			}),
		);

		await expect(
			new ToolGateway(loadConfig({})).execute({
				userId: "101",
				canvasId: "301",
				expectedVersion: 7,
				idempotencyKey: "node-replay-1",
				operation: "create_nodes",
				payload: { nodes: [{ type: "image", params: { prompt: "rain" } }] },
			}),
		).resolves.toMatchObject({ canvasVersion: 7 });
	});

	it("reads the authoritative canvas version for confirmation validation", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.endsWith("/api/v1/canvases/301"))
					return new Response(JSON.stringify({ canvas: { version: 12 } }), { status: 200 });
				return new Response("{}", { status: 200 });
			}),
		);

		await expect(new ToolGateway(loadConfig({})).getCanvasVersion("101", "301")).resolves.toBe(12);
	});

	it("uses authoritative Generation pricing before Billing freeze", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url, init });
				if (url.endsWith("/api/v1/models/estimate"))
					return new Response(JSON.stringify({ estimatedCost: 4, pricingVersion: 2 }), { status: 200 });
				if (url.endsWith("/api/v1/tasks"))
					return new Response(JSON.stringify({ taskId: "task-1", status: "queued" }), { status: 200 });
				return new Response(JSON.stringify({ id: "node-1" }), { status: 200 });
			}),
		);

		const result = await new ToolGateway(loadConfig({})).submitGeneration(
			"101",
			"301",
			"401",
			"image",
			{ prompt: "bird" },
			999,
			"action-1",
		);

		expect(result).toMatchObject({ taskId: "task-1", estimatedCost: 4, pricingVersion: 2 });
		const billing = calls.find((call) => call.url.endsWith("/api/v1/tasks"));
		expect(JSON.parse(String(billing?.init?.body))).toMatchObject({ estimatedCost: 4 });
	});

	it("rejects a text node as the target of image generation before freezing points", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				calls.push(url);
				if (url.endsWith("/api/v1/models"))
					return new Response(
						JSON.stringify({ items: [{ name: "agnes-image-2.5-flash", modelType: "image", enabled: true }] }),
						{ status: 200 },
					);
				if (url.endsWith("/api/v1/canvases/301/nodes/401"))
					return new Response(JSON.stringify({ id: 401, type: "text" }), { status: 200 });
				if (url.endsWith("/api/v1/models/estimate"))
					return new Response(JSON.stringify({ estimatedCost: 4 }), { status: 200 });
				return new Response(JSON.stringify({ taskId: "must-not-freeze" }), { status: 200 });
			}),
		);

		await expect(
			new ToolGateway(loadConfig({})).submitGeneration(
				"101",
				"301",
				"401",
				"agnes-image-2.5-flash",
				{},
				4,
				"action-text-target",
			),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		expect(calls.some((url) => url.endsWith("/api/v1/tasks"))).toBe(false);
	});

	it("compensates Billing when the Canvas queued write fails", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push(url);
				if (url.endsWith("/api/v1/models/estimate"))
					return new Response(JSON.stringify({ estimatedCost: 4 }), { status: 200 });
				if (url.endsWith("/api/v1/tasks"))
					return new Response(JSON.stringify({ taskId: "task-1", status: "queued" }), { status: 200 });
				if (url.includes("/nodes/401") && init?.method === "PUT")
					return new Response(JSON.stringify({ code: "VERSION_CONFLICT" }), { status: 409 });
				if (url.includes("/nodes/401"))
					return new Response(JSON.stringify({ id: "401", type: "image" }), { status: 200 });
				if (url.endsWith("/api/v1/tasks/task-1/cancel")) return new Response("{}", { status: 200 });
				return new Response("{}", { status: 200 });
			}),
		);

		await expect(
			new ToolGateway(loadConfig({})).submitGeneration("101", "301", "401", "image", {}, 4, "action-1"),
		).rejects.toThrow("画布节点写入 queued 失败");
		expect(calls.some((url) => url.endsWith("/api/v1/tasks/task-1/cancel"))).toBe(true);
	});

	it("persists deterministic layout through the versioned Canvas save endpoint", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url, init });
				if (url.endsWith("/api/v1/canvases/301"))
					return new Response(
						JSON.stringify({
							canvas: { version: 7 },
							nodes: [
								{ id: "1", x: 0, y: 0 },
								{ id: "2", x: 0, y: 0 },
							],
							edges: [],
							groups: [],
							stacks: [],
						}),
						{ status: 200 },
					);
				if (url.endsWith("/api/v1/canvases/301/save"))
					return new Response(JSON.stringify({ version: 8 }), { status: 200 });
				return new Response("{}", { status: 200 });
			}),
		);

		const result = await new ToolGateway(loadConfig({})).execute({
			userId: "101",
			canvasId: "301",
			expectedVersion: 7,
			idempotencyKey: "layout-1",
			operation: "layout_nodes",
			payload: { nodeIds: ["1", "2"], layout: { direction: "horizontal", gap: 400 } },
		});
		const save = calls.find((call) => call.url.endsWith("/api/v1/canvases/301/save"));
		expect(save).toBeDefined();
		expect(JSON.parse(String(save?.init?.body))).toMatchObject({
			version: 7,
			nodes: [
				{ x: 120, y: 120 },
				{ x: 520, y: 120 },
			],
		});
		expect(result).toMatchObject({ version: 8 });
	});

	it("passes the expected Canvas version when creating a node", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url, init });
				if (url.endsWith("/api/v1/canvases/301/nodes"))
					return new Response(JSON.stringify({ id: "node-1", type: "text" }), { status: 200 });
				if (url.endsWith("/api/v1/canvases/301"))
					return new Response(JSON.stringify({ canvas: { version: 8 } }), { status: 200 });
				return new Response("{}", { status: 200 });
			}),
		);

		await new ToolGateway(loadConfig({})).execute({
			userId: "101",
			canvasId: "301",
			expectedVersion: 7,
			idempotencyKey: "create-1",
			operation: "create_nodes",
			payload: { nodes: [{ type: "text", content: "copy" }] },
		});

		const create = calls.find((call) => call.url.endsWith("/api/v1/canvases/301/nodes"));
		expect(JSON.parse(String(create?.init?.body))).toMatchObject({ expectedVersion: 7 });
	});

	it("preserves distinct positions when creating multiple canvas nodes", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		let canvasVersion = 9;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url, init });
				if (url.endsWith("/api/v1/canvases/301/nodes"))
					return new Response(JSON.stringify({ id: `node-${calls.length}` }), { status: 200 });
				if (url.endsWith("/api/v1/canvases/301"))
					return new Response(JSON.stringify({ canvas: { version: canvasVersion++ } }), { status: 200 });
				return new Response("{}", { status: 200 });
			}),
		);

		await new ToolGateway(loadConfig({})).execute({
			userId: "101",
			canvasId: "301",
			expectedVersion: 8,
			idempotencyKey: "create-positioned-1",
			operation: "create_nodes",
			payload: {
				nodes: [
					{ type: "text", x: 120, y: 120 },
					{ type: "text", x: 520, y: 120 },
				],
			},
		});

		const creates = calls.filter((call) => call.url.endsWith("/api/v1/canvases/301/nodes"));
		expect(JSON.parse(String(creates[0]?.init?.body))).toMatchObject({ x: 120, y: 120 });
		expect(JSON.parse(String(creates[1]?.init?.body))).toMatchObject({ x: 520, y: 120 });
	});

	it("places a new node after existing nodes when no position is supplied", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url, init });
				if (url.endsWith("/api/v1/canvases/301/nodes"))
					return new Response(JSON.stringify({ id: "node-new", type: "image" }), { status: 200 });
				if (url.endsWith("/api/v1/canvases/301"))
					return new Response(
						JSON.stringify({
							canvas: { version: 3 },
							nodes: [{ id: "node-old-1" }, { id: "node-old-2" }],
						}),
						{ status: 200 },
					);
				return new Response("{}", { status: 200 });
			}),
		);

		await new ToolGateway(loadConfig({})).execute({
			userId: "101",
			canvasId: "301",
			expectedVersion: 2,
			idempotencyKey: "create-after-existing-1",
			operation: "create_nodes",
			payload: { nodes: [{ type: "image" }] },
		});

		const create = calls.find((call) => call.url.endsWith("/api/v1/canvases/301/nodes"));
		expect(JSON.parse(String(create?.init?.body))).toMatchObject({ x: 940, y: 180 });
	});
});
