import { describe, expect, it } from "vitest";

import {
	InMemoryRunRepository,
	RunConflictError,
	type RunRepository,
	SessionRunService,
} from "../src/application/session-run-service.ts";

describe("session run service", () => {
	it("allows only one active run and returns the same run for a duplicate idempotency key", async () => {
		const service = new SessionRunService(new InMemoryRunRepository());
		const first = await service.startRun({ sessionId: "session-1", idempotencyKey: "message-1" });
		const duplicate = await service.startRun({ sessionId: "session-1", idempotencyKey: "message-1" });

		expect(duplicate.runId).toBe(first.runId);
		await expect(service.startRun({ sessionId: "session-1", idempotencyKey: "message-2" })).rejects.toBeInstanceOf(
			RunConflictError,
		);
	});

	it("assigns strictly increasing event sequence numbers and replays after a cursor", async () => {
		const service = new SessionRunService(new InMemoryRunRepository());
		const run = await service.startRun({ sessionId: "session-1", idempotencyKey: "message-1" });
		await service.appendEvent(run.runId, "assistant_delta", { text: "a" });
		await service.appendEvent(run.runId, "tool_started", { tool: "get_canvas_summary" });
		await service.appendEvent(run.runId, "run_completed", { text: "done" });

		expect((await service.listEvents(run.runId)).map((event) => event.eventSeq)).toEqual([1, 2, 3]);
		expect((await service.listEvents(run.runId, 1)).map((event) => event.eventSeq)).toEqual([2, 3]);
	});

	it("cancels an active run once and rejects later side effects", async () => {
		const service = new SessionRunService(new InMemoryRunRepository());
		const run = await service.startRun({ sessionId: "session-1", idempotencyKey: "message-1" });
		expect(await service.cancelRun(run.runId)).toBe(true);
		expect(await service.cancelRun(run.runId)).toBe(false);
		await expect(service.appendEvent(run.runId, "tool_completed", {})).rejects.toThrow("RUN_NOT_ACTIVE");
	});

	it("does not append a second terminal failure after an error event", async () => {
		const service = new SessionRunService(new InMemoryRunRepository());
		const run = await service.startRun({ sessionId: "session-1", idempotencyKey: "message-1" });

		await service.appendEvent(run.runId, "run_failed", {
			errorCode: "MODEL_UNAVAILABLE",
			message: "模型服务暂时不可用，请稍后重试。",
		});
		await service.setStatus(run.runId, "failed", {
			errorCode: "MODEL_UNAVAILABLE",
			message: "模型调用失败",
		});

		expect((await service.listEvents(run.runId)).filter((event) => event.type === "run_failed")).toHaveLength(1);
	});

	it("uses repository capabilities instead of an InMemoryRunRepository type check", async () => {
		const backing = new InMemoryRunRepository();
		const repository: RunRepository = {
			findByIdempotency: backing.findByIdempotency.bind(backing),
			findActive: backing.findActive.bind(backing),
			findById: backing.get.bind(backing),
			save: backing.save.bind(backing),
			updateStatus: backing.updateStatus.bind(backing),
			appendEvent: backing.appendEvent.bind(backing),
			listEvents: backing.listEvents.bind(backing),
		};
		const service = new SessionRunService(repository);
		const run = await service.startRun({ sessionId: "session-2", idempotencyKey: "message-1" });

		await service.appendEvent(run.runId, "assistant_delta", { text: "hello" });
		expect((await service.listEvents(run.runId)).map((event) => event.eventSeq)).toEqual([1]);
		expect(await service.cancelRun(run.runId)).toBe(true);
		expect((await service.listEvents(run.runId, 0)).at(-1)?.type).toBe("run_aborted");
	});
});
