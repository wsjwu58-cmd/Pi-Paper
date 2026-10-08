import { describe, expect, it } from "vitest";

import {
	InMemoryTerminalStore,
	TaskTerminalService,
	type TerminalNotice,
} from "../src/application/task-terminal-service.ts";

const notice: TerminalNotice = { taskId: "task-1", status: "succeeded", actualCost: 8 };

describe("TaskTerminalService", () => {
	it("accepts a task-scoped callback without a session id and makes retries idempotent", async () => {
		const store = new InMemoryTerminalStore({
			taskId: "task-1",
			actionId: "action-1",
			runId: "run-1",
			sessionId: "session-1",
		});
		const service = new TaskTerminalService(store, "internal-secret");

		await expect(service.handle(notice, "internal-secret")).resolves.toMatchObject({
			accepted: true,
			sessionId: "session-1",
		});
		await expect(service.handle(notice, "internal-secret")).resolves.toMatchObject({
			accepted: true,
			duplicate: true,
		});
		expect(store.events).toHaveLength(1);
	});

	it("rejects forged credentials and records conflicting terminal states", async () => {
		const store = new InMemoryTerminalStore({
			taskId: "task-1",
			actionId: "action-1",
			runId: "run-1",
			sessionId: "session-1",
		});
		const service = new TaskTerminalService(store, "internal-secret");

		await expect(service.handle(notice, "wrong")).rejects.toThrow("PERMISSION_DENIED");
		await service.handle(notice, "internal-secret");
		await expect(service.handle({ ...notice, status: "failed" }, "internal-secret")).resolves.toMatchObject({
			conflict: true,
		});
		expect(store.warnings).toHaveLength(1);
	});
});
