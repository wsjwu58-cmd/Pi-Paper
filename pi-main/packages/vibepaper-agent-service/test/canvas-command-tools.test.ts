import { describe, expect, it } from "vitest";

import { type CanvasCommandGateway, CanvasCommandService } from "../src/application/canvas-command-service.ts";
import { CanvasCommandTools } from "../src/tools/canvas-command-tools.ts";

describe("canvas command tools", () => {
	it("enforces the batch limit and forwards the expected canvas version", async () => {
		const commands: unknown[] = [];
		const gateway: CanvasCommandGateway = {
			execute: async (command) => {
				commands.push(command);
				return { version: 2, changed: ["node-1"] };
			},
		};
		const tools = new CanvasCommandTools(new CanvasCommandService(gateway));
		await expect(
			tools.createNodes({
				userId: "101",
				canvasId: "301",
				expectedVersion: 1,
				idempotencyKey: "k1",
				nodes: Array.from({ length: 21 }, (_, index) => ({ id: String(index) })),
			}),
		).rejects.toThrow("BATCH_LIMIT_EXCEEDED");
		await expect(
			tools.createNodes({
				userId: "101",
				canvasId: "301",
				expectedVersion: 1,
				idempotencyKey: "k1",
				nodes: [{ id: "node-1" }],
			}),
		).resolves.toMatchObject({ version: 2 });
		expect(commands[0]).toMatchObject({
			userId: "101",
			canvasId: "301",
			expectedVersion: 1,
			operation: "create_nodes",
		});
	});

	it("does not permanently cache a failed canvas command", async () => {
		let calls = 0;
		const service = new CanvasCommandService({
			execute: async () => {
				calls += 1;
				throw new Error("HTTP_409");
			},
		});
		const input = { userId: "101", canvasId: "301", expectedVersion: 1, idempotencyKey: "k1", nodeIds: ["1"] };
		await expect(service.connectNodes(input)).rejects.toThrow("VERSION_CONFLICT");
		await expect(service.connectNodes(input)).rejects.toThrow("VERSION_CONFLICT");
		expect(calls).toBe(2);
	});

	it("preserves the structured downstream input error code", async () => {
		const service = new CanvasCommandService({
			execute: async () => {
				const error = new Error("创建画布节点失败") as Error & { code?: string };
				error.code = "INVALID_INPUT";
				throw error;
			},
		});

		await expect(
			service.createNodes({
				userId: "101",
				canvasId: "301",
				expectedVersion: 1,
				idempotencyKey: "invalid-node",
				nodes: [{ type: "text" }],
			}),
		).rejects.toThrow("INVALID_INPUT");
	});
});
