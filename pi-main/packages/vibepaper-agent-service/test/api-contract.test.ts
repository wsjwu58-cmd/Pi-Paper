import type { QueryResultRow } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/api/app.ts";
import { InMemoryRunRepository } from "../src/application/session-run-service.ts";
import { loadConfig } from "../src/config.ts";
import type { SqlExecutor } from "../src/infrastructure/database.ts";
import type { MigrationDatabase } from "../src/infrastructure/migrations.ts";

type Session = {
	id: string;
	userId: string;
	canvasId: string | null;
	title: string;
	status: "active" | null;
	updatedAt: Date;
};

class MemoryDatabase implements SqlExecutor {
	readonly sessions: Session[] = [];

	async query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
		if (text.startsWith("INSERT INTO agent_sessions")) {
			this.sessions.push({
				id: String(values[0]),
				userId: String(values[1]),
				canvasId: values[2] === null ? null : String(values[2]),
				title: String(values[3]),
				status: text.includes("status") ? "active" : null,
				updatedAt: new Date(),
			});
			return { rows: [] };
		}
		if (text.includes("FROM agent_sessions WHERE user_id")) {
			const userId = String(values[0]);
			const canvasId = values[1] === null ? undefined : String(values[1]);
			const treatsNullStatusAsActive = text.includes("COALESCE(status, 'active') <> 'deleted'");
			return {
				rows: this.sessions
					.filter(
						(session) =>
							session.userId === userId &&
							(!canvasId || session.canvasId === canvasId) &&
							(treatsNullStatusAsActive || session.status !== null),
					)
					.map((session) => ({
						id: session.id,
						title: session.title,
						canvas_id: session.canvasId,
						status: session.status,
						token_used_total: 0,
						points_used_total: 0,
						model_usage: {},
						updated_at: session.updatedAt,
					})) as unknown as T[],
			};
		}
		if (text.includes("FROM agent_sessions WHERE id = $1 AND user_id = $2")) {
			const session = this.sessions.find(
				(item) => item.id === String(values[0]) && item.userId === String(values[1]),
			);
			return {
				rows: session
					? ([
							{
								id: session.id,
								title: session.title,
								canvas_id: session.canvasId,
								status: session.status,
								token_used_total: 0,
								points_used_total: 0,
								model_usage: {},
								updated_at: session.updatedAt,
							},
						] as unknown as T[])
					: [],
			};
		}
		return { rows: [] };
	}
}

class CallbackDatabase implements MigrationDatabase {
	async query<T extends QueryResultRow>(text: string): Promise<{ rows: T[] }> {
		if (text.includes("FROM agent_actions a WHERE a.task_id")) {
			return {
				rows: [{ task_id: "task-1", action_id: "action-1", session_id: "session-1", run_id: "run-1" }] as unknown as T[],
			};
		}
		if (text.includes("INSERT INTO agent_wakeup_notices")) return { rows: [{ id: "action-1" }] as unknown as T[] };
		return { rows: [] };
	}

	async transaction<T>(operation: (client: SqlExecutor) => Promise<T>): Promise<T> {
		return await operation(this);
	}
}

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
	for (const app of apps.splice(0)) await app.close();
});

describe("Pi agent service API contract", () => {
	it("keeps Agnes as the default model configuration", () => {
		const config = loadConfig({});
		expect(config.llmModel).toBe("agnes-2.5-flash");
		expect(config.llmBaseUrl).toBe("https://apihub.agnes-ai.com/v1");
	});

	it("exposes health and the legacy session response fields", async () => {
		const app = createApp({ config: loadConfig({}), database: new MemoryDatabase() });
		apps.push(app);
		const health = await app.inject({ method: "GET", url: "/health" });
		expect(health.statusCode).toBe(200);
		expect(health.json()).toMatchObject({ status: "ok", service: "agent-service", runtime: "pi-agent" });

		const created = await app.inject({
			method: "POST",
			url: "/api/v1/agent/sessions",
			headers: { "x-user-id": "101" },
			payload: { canvasId: "301", title: "短剧第一集" },
		});
		expect(created.statusCode).toBe(201);
		expect(created.json()).toMatchObject({ title: "短剧第一集", canvasId: "301" });

		const listed = await app.inject({
			method: "GET",
			url: "/api/v1/agent/sessions?canvasId=301",
			headers: { "x-user-id": "101" },
		});
		expect(listed.statusCode).toBe(200);
		expect(listed.json().items).toHaveLength(1);
		expect(listed.json().items[0]).toMatchObject({ title: "短剧第一集", canvasId: "301" });
	});

	it("accepts the snake_case task terminal callback emitted by Generation", async () => {
		const app = createApp({
			config: loadConfig({ VIBEPAPER_INTERNAL_SERVICE_TOKEN: "internal-secret" }),
			database: new CallbackDatabase(),
		});
		apps.push(app);

		const response = await app.inject({
			method: "POST",
			url: "/internal/agent/resume",
			headers: { "x-internal-service-token": "internal-secret" },
			payload: {
				task_id: "task-1",
				status: "succeeded",
				node_id: "node-1",
				canvas_id: "canvas-1",
				user_id: "101",
				actual_cost: 4,
			},
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ ok: true, accepted: true });
	});

	it("primes an active SSE stream before waiting for the next run event", async () => {
		const database = new MemoryDatabase();
		const runs = new InMemoryRunRepository();
		const app = createApp({ config: loadConfig({}), database, runRepository: runs });
		apps.push(app);

		const created = await app.inject({
			method: "POST",
			url: "/api/v1/agent/sessions",
			headers: { "x-user-id": "101" },
			payload: { canvasId: "301", title: "SSE recovery" },
		});
		const sessionId = String(created.json().sessionId);
		runs.save({
			runId: "run-sse-1",
			sessionId,
			idempotencyKey: "idem-sse-1",
			status: "running",
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const streamPromise = app.inject({
			method: "GET",
			url: `/api/v1/agent/sessions/${sessionId}/events`,
			headers: { "x-user-id": "101" },
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		await app.inject({
			method: "POST",
			url: `/api/v1/agent/sessions/${sessionId}/cancel`,
			headers: { "x-user-id": "101" },
		});

		const stream = await streamPromise;
		expect(stream.statusCode).toBe(200);
		expect(stream.body.startsWith(": connected\n\n")).toBe(true);
		expect(stream.body).toContain("run_aborted");
	});

	it("closes the recovery SSE after replaying a waiting confirmation", async () => {
		const database = new MemoryDatabase();
		const runs = new InMemoryRunRepository();
		const app = createApp({ config: loadConfig({}), database, runRepository: runs });
		apps.push(app);

		const created = await app.inject({
			method: "POST",
			url: "/api/v1/agent/sessions",
			headers: { "x-user-id": "101" },
			payload: { canvasId: "301", title: "confirmation recovery" },
		});
		const sessionId = String(created.json().sessionId);
		runs.save({
			runId: "run-confirmation-recovery",
			sessionId,
			idempotencyKey: "idem-confirmation-recovery",
			status: "waiting_confirmation",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		runs.appendEvent({
			eventId: "event-confirmation-recovery",
			runId: "run-confirmation-recovery",
			sessionId,
			eventSeq: 1,
			type: "confirmation_required",
			runtime: "pi",
			runtimeVersion: "0.1.0",
			data: { actionId: "action-confirmation-recovery" },
			createdAt: new Date(),
		});

		const stream = await Promise.race([
			app.inject({
				method: "GET",
				url: `/api/v1/agent/sessions/${sessionId}/events`,
				headers: { "x-user-id": "101" },
			}),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE_RECOVERY_TIMEOUT")), 100)),
		]);

		expect(stream.statusCode).toBe(200);
		expect(stream.body).toContain("confirmation_required");
	});
});
