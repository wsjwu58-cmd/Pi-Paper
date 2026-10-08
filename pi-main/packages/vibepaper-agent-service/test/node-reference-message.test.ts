import type { QueryResultRow } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/api/app.ts";
import type { StoredAgentMessage } from "../src/application/agent-runtime.ts";
import { NodeReferenceContextError, type NodeReferenceSnapshot } from "../src/application/node-reference-context.ts";
import { loadConfig } from "../src/config.ts";
import type { SqlExecutor } from "../src/infrastructure/database.ts";
import { ToolGateway } from "../src/infrastructure/tool-gateway.ts";

type StoredMessage = {
	id: string;
	sessionId: string;
	role: "user" | "assistant" | "system";
	content: string;
	meta: Record<string, unknown>;
	createdAt: Date;
};

class MessageDatabase implements SqlExecutor {
	readonly messages: StoredMessage[] = [];
	readonly session = {
		id: "201",
		userId: "101",
		canvasId: "301",
		title: "新对话",
		updatedAt: new Date("2026-08-28T12:00:00.000Z"),
	};

	async query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
		if (text.includes("FROM agent_sessions WHERE id = $1 AND user_id = $2")) {
			if (String(values[0]) !== this.session.id || String(values[1]) !== this.session.userId) return { rows: [] };
			return {
				rows: [
					{
						id: this.session.id,
						title: this.session.title,
						canvas_id: this.session.canvasId,
						status: "active",
						token_used_total: 0,
						points_used_total: 0,
						model_usage: {},
						updated_at: this.session.updatedAt,
					},
				] as unknown as T[],
			};
		}
		if (text.startsWith("INSERT INTO agent_messages")) {
			this.messages.push({
				id: String(values[0]),
				sessionId: String(values[1]),
				role: String(values[2]) as StoredMessage["role"],
				content: String(values[3]),
				meta: JSON.parse(String(values[4])) as Record<string, unknown>,
				createdAt: new Date(Date.now() + this.messages.length),
			});
			return { rows: [] };
		}
		if (text.includes("FROM agent_messages WHERE session_id = $1")) {
			const ordered = this.messages.filter((message) => message.sessionId === String(values[0]));
			const rows = text.includes("ORDER BY id DESC") ? [...ordered].reverse() : ordered;
			return {
				rows: rows.map((message) => ({
					id: message.id,
					role: message.role,
					msg_type: "text",
					content: message.content,
					meta: message.meta,
					created_at: message.createdAt,
				})) as unknown as T[],
			};
		}
		return { rows: [] };
	}
}

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
	for (const app of apps.splice(0)) await app.close();
	vi.unstubAllGlobals();
});

describe("node reference message contract", () => {
	it("reads canonical nodes through the user-authorized canvas API", async () => {
		const fetchMock = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						nodes: [
							{
								id: "12",
								type: "image",
								status: "ready",
								params: { title: "橘猫角色卡", lastOutputUrl: "/outputs/file/cat.png" },
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const gateway = new ToolGateway(loadConfig({ VIBEPAPER_CANVAS_BASE_URL: "http://canvas-service" }));

		await expect(gateway.getNodeReferences("101", "301", ["12"])).resolves.toEqual([
			{
				nodeId: "12",
				nodeType: "image",
				title: "橘猫角色卡",
				status: "ready",
				previewUrl: "/outputs/file/cat.png",
			},
		]);
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("http://canvas-service/api/v1/canvases/301");
		expect(init).toMatchObject({ method: "GET", headers: { "X-User-Id": "101", "X-User-Role": "user" } });
	});

	it("stores canonical references, exposes them in history, and passes them to the runtime", async () => {
		const database = new MessageDatabase();
		const references: NodeReferenceSnapshot[] = [
			{
				nodeId: "12",
				nodeType: "image",
				title: "橘猫角色卡",
				status: "ready",
				previewUrl: "/outputs/file/cat.png",
			},
		];
		const observed: {
			content?: string;
			history?: readonly StoredAgentMessage[];
			references?: readonly NodeReferenceSnapshot[];
		} = {};
		const app = createApp({
			config: loadConfig({ VIBEPAPER_LLM_API_KEY: "test" }),
			database,
			referenceGateway: {
				getNodeReferences: async (userId, canvasId, nodeIds) => {
					if (nodeIds.length === 0) return [];
					expect({ userId, canvasId, nodeIds }).toEqual({
						userId: "101",
						canvasId: "301",
						nodeIds: ["12"],
					});
					return references;
				},
			},
			runTurn: async (_config, _store, _sessionId, history, content, _skills, nodeReferences) => {
				observed.history = history;
				observed.content = content;
				observed.references = nodeReferences;
				return {
					events: [{ type: "assistant_message", content: "可以" }],
					assistantText: "可以",
					totalTokens: 3,
				};
			},
		});
		apps.push(app);

		const response = await app.inject({
			method: "POST",
			url: "/api/v1/agent/sessions/201/messages",
			headers: { "x-user-id": "101", "idempotency-key": "node-reference-1" },
			payload: {
				content: "根据图片进行创作",
				canvasId: "301",
				selectedNodeIds: ["12", "12"],
				nodeReferences: [{ nodeId: "12", title: "伪造标题", previewUrl: "https://evil.invalid/x" }],
			},
		});

		expect(response.statusCode).toBe(200);
		expect(response.headers["x-request-id"]).toBeTruthy();
		expect(response.body.startsWith(": connected\n\n")).toBe(true);
		expect(response.body).toContain("event: assistant_delta");
		expect(response.body).toContain("event: run_completed");
		expect(response.body.indexOf("event: assistant_delta")).toBeLessThan(
			response.body.indexOf("event: run_completed"),
		);
		expect(observed.content).toBe("根据图片进行创作");
		expect(observed.references).toEqual(references);
		expect(observed.history).toEqual([]);
		expect(database.messages[0]?.meta).toEqual({ selectedNodeIds: ["12"], nodeReferences: references });
		expect(JSON.stringify(database.messages[0]?.meta)).not.toContain("伪造标题");

		const history = await app.inject({
			method: "GET",
			url: "/api/v1/agent/sessions/201/messages",
			headers: { "x-user-id": "101" },
		});
		expect(history.statusCode).toBe(200);
		expect(history.json().items[0].meta.nodeReferences).toEqual(references);

		const followUp = await app.inject({
			method: "POST",
			url: "/api/v1/agent/sessions/201/messages",
			headers: { "x-user-id": "101", "idempotency-key": "node-reference-2" },
			payload: { content: "继续", canvasId: "301", selectedNodeIds: [] },
		});
		expect(followUp.statusCode).toBe(200);
		expect(observed.references).toEqual([]);
		expect(observed.history?.[0]?.meta.nodeReferences).toEqual(references);
	});

	it("does not persist or invoke the runtime when a reference is not authorized", async () => {
		const database = new MessageDatabase();
		let runtimeCalls = 0;
		const app = createApp({
			config: loadConfig({ VIBEPAPER_LLM_API_KEY: "test" }),
			database,
			referenceGateway: {
				getNodeReferences: async () => {
					throw new NodeReferenceContextError("NOT_FOUND", "参考节点不存在或不属于当前画布: 999");
				},
			},
			runTurn: async () => {
				runtimeCalls += 1;
				return { events: [], assistantText: "", totalTokens: 0 };
			},
		});
		apps.push(app);

		const response = await app.inject({
			method: "POST",
			url: "/api/v1/agent/sessions/201/messages",
			headers: { "x-user-id": "101" },
			payload: { content: "继续", canvasId: "301", selectedNodeIds: ["999"] },
		});

		expect(response.statusCode).toBe(404);
		expect(response.json()).toMatchObject({ code: "NOT_FOUND" });
		expect(database.messages).toEqual([]);
		expect(runtimeCalls).toBe(0);
	});

	it("rejects more than eight node ids before reading the canvas", async () => {
		const database = new MessageDatabase();
		let gatewayCalls = 0;
		const app = createApp({
			config: loadConfig({ VIBEPAPER_LLM_API_KEY: "test" }),
			database,
			referenceGateway: {
				getNodeReferences: async () => {
					gatewayCalls += 1;
					return [];
				},
			},
			runTurn: async () => ({ events: [], assistantText: "", totalTokens: 0 }),
		});
		apps.push(app);

		const response = await app.inject({
			method: "POST",
			url: "/api/v1/agent/sessions/201/messages",
			headers: { "x-user-id": "101" },
			payload: {
				content: "批量参考",
				canvasId: "301",
				selectedNodeIds: Array.from({ length: 9 }, (_, index) => String(index + 1)),
			},
		});

		expect(response.statusCode).toBe(400);
		expect(response.json()).toMatchObject({ code: "INVALID_INPUT", message: "每轮最多引用 8 个节点" });
		expect(gatewayCalls).toBe(0);
		expect(database.messages).toEqual([]);
	});
});
