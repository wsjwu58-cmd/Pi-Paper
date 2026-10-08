import { describe, expect, it } from "vitest";
import type { AgentRunEvent } from "../src/domain/agent-run.ts";
import type { MigrationDatabase } from "../src/infrastructure/migrations.ts";
import { PgRunRepository } from "../src/infrastructure/pg-run-repository.ts";

const runRow = {
	id: "run-1",
	session_id: "session-1",
	idempotency_key: "message-1",
	status: "running",
	created_at: new Date("2026-08-29T00:00:00.000Z"),
	updated_at: new Date("2026-08-29T00:00:01.000Z"),
};

class RecordingDatabase implements MigrationDatabase {
	readonly queries: string[] = [];
	private readonly runEvents: AgentRunEvent[] = [];

	async query<T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
		this.queries.push(text);
		if (text.includes("WITH locked_run AS")) {
			return {
				rows: [
					{
						event_id: "event-1",
						run_id: String(values[0]),
						session_id: "session-1",
						event_seq: 1,
						type: String(values[1]),
						runtime: "pi",
						runtime_version: "0.1.0",
						data: values[2],
						created_at: new Date("2026-08-29T00:00:02.000Z"),
					} as unknown as T,
				],
			};
		}
		if (text.includes("FROM agent_runs") && text.includes("WHERE id = $1")) return { rows: [runRow as unknown as T] };
		if (text.includes("FROM agent_runs") && text.includes("idempotency_key")) return { rows: [] };
		if (text.includes("FROM agent_runs") && text.includes("status IN")) return { rows: [] };
		if (text.startsWith("INSERT INTO agent_runs")) return { rows: [] };
		if (text.includes("UPDATE agent_runs") && text.includes("status = 'aborted'"))
			return { rows: [runRow as unknown as T] };
		if (text.includes("FROM agent_run_events")) return { rows: this.runEvents as unknown as T[] };
		if (text.includes("WITH locked_run AS")) {
			const event = {
				event_id: "event-1",
				run_id: String(values[0]),
				session_id: "session-1",
				event_seq: 1,
				type: String(values[1]),
				runtime: "pi",
				runtime_version: "0.1.0",
				data: values[2],
				created_at: new Date("2026-08-29T00:00:02.000Z"),
			};
			return { rows: [event as unknown as T] };
		}
		return { rows: [] };
	}

	async transaction<T>(operation: (client: RecordingDatabase) => Promise<T>): Promise<T> {
		return await operation(this);
	}
}

describe("PgRunRepository", () => {
	it("uses row locking and atomic event allocation for persistent runs", async () => {
		const database = new RecordingDatabase();
		const repository = new PgRunRepository(database);

		expect(await repository.findById("run-1")).toMatchObject({ runId: "run-1", sessionId: "session-1" });
		const event = await repository.appendEventAtomic({
			runId: "run-1",
			type: "assistant_delta",
			data: { text: "hi" },
		});
		expect(event.eventSeq).toBe(1);
		expect(database.queries.some((query) => query.includes("FOR UPDATE"))).toBe(true);
		expect(database.queries.some((query) => query.includes("agent_event_outbox"))).toBe(true);
		const atomicEventQuery = database.queries.find((query) => query.includes("WITH locked_run AS"));
		expect(atomicEventQuery).toContain("inserted_outbox AS");
		expect(atomicEventQuery).toMatch(
			/SELECT event_id, run_id, session_id, event_seq, type, runtime, runtime_version, data, created_at\s+FROM inserted_event\s*$/,
		);
		expect(atomicEventQuery).toMatch(/INSERT INTO agent_event_outbox[\s\S]*RETURNING event_id\s*\)/);
	});

	it("cancels only an active run", async () => {
		const database = new RecordingDatabase();
		const repository = new PgRunRepository(database);

		expect(await repository.cancelIfActive("run-1")).toBe(true);
		expect(database.queries.some((query) => query.includes("WHERE id = $1") && query.includes("status IN"))).toBe(
			true,
		);
	});
});
