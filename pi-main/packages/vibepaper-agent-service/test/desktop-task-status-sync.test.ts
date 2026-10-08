import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { SessionRunService } from "../src/application/session-run-service.ts";
import { DesktopAgentControlStore } from "../src/desktop/control-store.ts";
import { recoverDesktopAgentRuns } from "../src/desktop/generation-confirmation.ts";
import { reconcileDesktopAgentTasks, requestDesktopTaskContinuations } from "../src/desktop/task-status-sync.ts";

const temporaryDirectories: string[] = [];

async function createStore() {
	const directory = await mkdtemp(join(tmpdir(), "vibepaper-agent-task-sync-"));
	temporaryDirectories.push(directory);
	return { directory, store: new DesktopAgentControlStore(join(directory, "control.sqlite")) };
}

function createStores(store: DesktopAgentControlStore, sessionIds = ["session-1"]) {
	return {
		projectId: "project-1",
		control: store,
		sessions: {
			listSessions: async () => sessionIds.map((id) => ({ id })),
			flushOutbox: async (control: DesktopAgentControlStore, sessionId?: string) => {
				const pending = control.listPendingOutbox(sessionId);
				for (const item of pending) control.markOutboxDelivered(item.outboxId);
				return pending.length;
			},
		},
	} as unknown as Parameters<typeof reconcileDesktopAgentTasks>[0];
}

async function createWaitingTaskRun(store: DesktopAgentControlStore, id = "run-1", sessionId = "session-1") {
	const runService = new SessionRunService(store);
	const run = await runService.startRun({ sessionId, idempotencyKey: id });
	await runService.setStatus(run.runId, "running");
	await runService.setStatus(run.runId, "waiting_task");
	return { run, runService };
}

async function createPendingContinuation(
	store: DesktopAgentControlStore,
	taskId = "task-continuation",
	sessionId = "session-1",
) {
	const { run } = await createWaitingTaskRun(store, `origin-${taskId}`, sessionId);
	store.linkTask({
		taskId,
		sessionId,
		runId: run.runId,
		actionId: "action-1",
		nodeId: `node-${taskId}`,
		status: "queued",
	});
	const result = store.recordTaskStatus(
		{ taskId, status: "succeeded", outputRef: `vibe://app/tasks/${taskId}/output` },
		{ projectId: "project-1" },
	);
	expect(result).toMatchObject({ runFinalized: true, runStatus: "completed", continuationCreated: true });
	return run;
}

async function linkTask(
	store: DesktopAgentControlStore,
	runId: string,
	taskId: string,
	actionId = "action-1",
	nodeId = `node-${taskId}`,
) {
	store.linkTask({ taskId, sessionId: "session-1", runId, actionId, nodeId, status: "queued" });
	await new SessionRunService(store).appendEvent(runId, "task_status", {
		actionId,
		actionStatus: "accepted",
		task_id: taskId,
		node_id: nodeId,
		status: "queued",
	});
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("desktop Agent task status reconciliation", () => {
	it("waits for every batch task, then closes the run with a sanitized detailed failure", async () => {
		const { store } = await createStore();
		try {
			const { run, runService } = await createWaitingTaskRun(store);
			await linkTask(store, run.runId, "task-1", "action-1", "node-1");
			await linkTask(store, run.runId, "task-2", "action-1", "node-2");
			const stores = createStores(store);

			const first = await reconcileDesktopAgentTasks(stores, async (taskId) =>
				taskId === "task-1"
					? { taskId, nodeId: "node-1", status: "succeeded", outputVerified: true }
					: { taskId, nodeId: "node-2", status: "running" },
			);
			expect(first).toMatchObject({ checked: 2, updated: 2, finalizedRuns: 0 });
			expect((await store.findById(run.runId))?.status).toBe("waiting_task");

			const second = await reconcileDesktopAgentTasks(stores, async (taskId) => ({
				taskId,
				nodeId: "node-2",
				status: "failed",
				errorCode: "PROVIDER_REQUEST_FAILED",
				errorMessage: "Provider failed at C:\\Users\\WSJ\\.keys\\secret.txt with api_key=super-secret-value",
			}));
			expect(second).toMatchObject({ checked: 1, updated: 1, finalizedRuns: 1 });
			expect((await store.findById(run.runId))?.status).toBe("failed");

			const events = await runService.listEvents(run.runId);
			const failed = events.find((event) => event.type === "task_status" && event.data.status === "failed");
			expect(failed?.data).toMatchObject({
				actionId: "action-1",
				actionStatus: "accepted",
				task_id: "task-2",
				node_id: "node-2",
				error_code: "PROVIDER_REQUEST_FAILED",
			});
			expect(failed?.data.error_message).toContain("[路径已隐藏]");
			expect(failed?.data.error_message).not.toContain("super-secret-value");
			expect(failed?.data.error_message).not.toContain("C:\\Users");
			expect(events.filter((event) => event.type === "run_failed")).toHaveLength(1);
			const continuation = store.listPendingTaskContinuations("project-1");
			expect(continuation).toHaveLength(1);
			expect(continuation[0]).toMatchObject({
				originRunId: run.runId,
				sessionId: "session-1",
				idempotencyKey: `task-continuation:${run.runId}`,
				status: "pending",
				taskResults: [
					{ taskId: "task-1", status: "succeeded" },
					{ taskId: "task-2", status: "failed", errorCode: "PROVIDER_REQUEST_FAILED" },
				],
			});
			expect(continuation[0]?.prompt).toContain("其中至少一个未成功");
			expect(continuation[0]?.prompt).toContain("不要自动新建收费生成任务");
		} finally {
			store.close();
		}
	});

	it("treats succeeded tasks with unverifiable outputs as failed and leaves legacy completed runs intact", async () => {
		const { store } = await createStore();
		try {
			const runService = new SessionRunService(store);
			const run = await runService.startRun({ sessionId: "session-1", idempotencyKey: "legacy-run" });
			await runService.setStatus(run.runId, "running");
			await runService.setStatus(run.runId, "completed", { actionId: "legacy-action", actionStatus: "accepted" });
			store.linkTask({
				taskId: "legacy-task",
				sessionId: "session-1",
				runId: run.runId,
				actionId: "legacy-action",
				nodeId: "legacy-node",
				status: "queued",
			});

			let reads = 0;
			await reconcileDesktopAgentTasks(createStores(store), async (taskId) => {
				reads += 1;
				return { taskId, nodeId: "legacy-node", status: "succeeded", outputVerified: false };
			});
			expect(reads).toBe(1);
			expect((await store.findById(run.runId))?.status).toBe("completed");
			const events = await runService.listEvents(run.runId);
			expect(events.filter((event) => event.type === "run_completed")).toHaveLength(1);
			expect(
				events.find((event) => event.type === "task_status" && event.data.status === "failed")?.data,
			).toMatchObject({
				actionId: "legacy-action",
				actionStatus: "accepted",
				error_code: "TASK_OUTPUT_UNAVAILABLE",
			});
		} finally {
			store.close();
		}
	});

	it("ignores a late queued snapshot after running", async () => {
		const { store } = await createStore();
		try {
			const { run, runService } = await createWaitingTaskRun(store);
			await linkTask(store, run.runId, "task-late-queue");
			const stores = createStores(store);
			await reconcileDesktopAgentTasks(stores, async (taskId) => ({
				taskId,
				nodeId: `node-${taskId}`,
				status: "running",
			}));
			await reconcileDesktopAgentTasks(stores, async (taskId) => ({
				taskId,
				nodeId: `node-${taskId}`,
				status: "queued",
			}));

			expect(store.listTaskLinks(run.runId)[0]?.status).toBe("running");
			const events = await runService.listEvents(run.runId);
			expect(events.filter((event) => event.type === "task_status" && event.data.status === "queued")).toHaveLength(
				1,
			);
			expect(events.filter((event) => event.type === "task_status" && event.data.status === "running")).toHaveLength(
				1,
			);
		} finally {
			store.close();
		}
	});

	it("retries outbox delivery after a flush failure without rereading terminal tasks or duplicating events", async () => {
		const { directory, store } = await createStore();
		const { run } = await createWaitingTaskRun(store);
		await linkTask(store, run.runId, "task-outbox");
		let flushCalls = 0;
		let readCalls = 0;
		const failingStores = {
			projectId: "project-1",
			control: store,
			sessions: {
				listSessions: async () => [{ id: "session-1" }],
				flushOutbox: async (control: DesktopAgentControlStore, sessionId?: string) => {
					flushCalls += 1;
					if (flushCalls === 1) throw new Error("SESSION_STORE_TEMPORARILY_UNAVAILABLE");
					const pending = control.listPendingOutbox(sessionId);
					for (const item of pending) control.markOutboxDelivered(item.outboxId);
					return pending.length;
				},
			},
		} as unknown as Parameters<typeof reconcileDesktopAgentTasks>[0];

		try {
			await expect(
				reconcileDesktopAgentTasks(failingStores, async (taskId) => {
					readCalls += 1;
					return { taskId, nodeId: `node-${taskId}`, status: "succeeded", outputVerified: true };
				}),
			).rejects.toThrow("SESSION_STORE_TEMPORARILY_UNAVAILABLE");
			expect((await store.findById(run.runId))?.status).toBe("completed");
			store.close();

			const reopened = new DesktopAgentControlStore(join(directory, "control.sqlite"));
			try {
				await reconcileDesktopAgentTasks(createStores(reopened), async () => {
					readCalls += 1;
					return null;
				});
				const events = await new SessionRunService(reopened).listEvents(run.runId);
				expect(readCalls).toBe(1);
				expect(
					events.filter((event) => event.type === "task_status" && event.data.status === "succeeded"),
				).toHaveLength(1);
				expect(events.filter((event) => event.type === "run_completed")).toHaveLength(1);
				expect(reopened.listPendingOutbox("session-1")).toHaveLength(0);
			} finally {
				reopened.close();
			}
		} finally {
			try {
				store.close();
			} catch {
				// The first connection is closed above before simulating recovery.
			}
		}
	});

	it("expires only unconsumed pending confirmations and preserves accepted task runs", async () => {
		const { store } = await createStore();
		try {
			const runService = new SessionRunService(store);
			const pending = await runService.startRun({ sessionId: "session-1", idempotencyKey: "expired-run" });
			await runService.setStatus(pending.runId, "waiting_confirmation");
			await runService.appendEvent(pending.runId, "confirmation_required", { expiresAt: Date.now() - 1_000 });

			const accepted = await runService.startRun({ sessionId: "session-2", idempotencyKey: "accepted-run" });
			await runService.setStatus(accepted.runId, "waiting_confirmation");
			await runService.appendEvent(accepted.runId, "confirmation_required", { expiresAt: Date.now() - 1_000 });
			const secret = store.getOrCreateApprovalSecret();
			const { ApprovalService } = await import("../src/application/approval-service.ts");
			const approval = new ApprovalService(store, secret, 300);
			const action = await approval.planActionAsync({
				userId: "project-1",
				runId: accepted.runId,
				sessionId: accepted.sessionId,
				canvasId: "canvas-1",
				canvasVersion: 1,
				toolName: "submit_generation",
				params: {},
				estimatedCost: 0,
				requiresApproval: true,
			});
			await approval.consumeApprovalIdempotently(action.actionId, action.approvalToken!, 1);

			const result = await reconcileDesktopAgentTasks(
				createStores(store, ["session-1", "session-2"]),
				async () => null,
			);
			expect(result.expiredConfirmations).toBe(1);
			expect((await store.findById(pending.runId))?.status).toBe("aborted");
			expect((await store.findById(accepted.runId))?.status).toBe("waiting_confirmation");
		} finally {
			store.close();
		}
	});

	it("repairs an old waiting_task run whose persisted batch is already terminal", async () => {
		const { store } = await createStore();
		try {
			const { run } = await createWaitingTaskRun(store, "legacy-waiting-task");
			store.linkTask({
				taskId: "legacy-terminal-task",
				sessionId: "session-1",
				runId: run.runId,
				nodeId: "legacy-node",
				status: "failed",
			});

			let taskReads = 0;
			const result = await reconcileDesktopAgentTasks(createStores(store), async () => {
				taskReads += 1;
				return null;
			});

			expect(result.finalizedRuns).toBe(1);
			expect(taskReads).toBe(0);
			expect((await store.findById(run.runId))?.status).toBe("failed");
			expect(store.listPendingTaskContinuations("project-1")).toMatchObject([
				{
					originRunId: run.runId,
					status: "pending",
					taskResults: [{ taskId: "legacy-terminal-task", status: "failed" }],
				},
			]);
			expect(store.listPendingTaskContinuations("project-1")[0]?.prompt).toContain("其中至少一个未成功");
		} finally {
			store.close();
		}
	});

	it("does not backfill completed historical runs with terminal task links", async () => {
		const { store } = await createStore();
		try {
			const runService = new SessionRunService(store);
			const run = await runService.startRun({ sessionId: "session-1", idempotencyKey: "historical-completed" });
			await runService.setStatus(run.runId, "completed");
			store.linkTask({
				taskId: "historical-terminal-task",
				sessionId: "session-1",
				runId: run.runId,
				nodeId: "historical-node",
				status: "succeeded",
			});

			const result = await reconcileDesktopAgentTasks(createStores(store), async () => {
				throw new Error("terminal links should be skipped");
			});

			expect(result.finalizedRuns).toBe(0);
			expect(store.listPendingTaskContinuations("project-1")).toHaveLength(0);
		} finally {
			store.close();
		}
	});

	it("queues one continuation when an old completed Run still has a task that turns terminal now", async () => {
		const { store } = await createStore();
		try {
			const runService = new SessionRunService(store);
			const run = await runService.startRun({ sessionId: "session-1", idempotencyKey: "legacy-premature-complete" });
			await runService.setStatus(run.runId, "completed");
			store.linkTask({
				taskId: "old-already-terminal",
				sessionId: "session-1",
				runId: run.runId,
				nodeId: "node-old",
				status: "succeeded",
			});
			store.linkTask({
				taskId: "old-still-running",
				sessionId: "session-1",
				runId: run.runId,
				nodeId: "node-running",
				status: "running",
			});

			const result = await reconcileDesktopAgentTasks(createStores(store), async (taskId) => ({
				taskId,
				nodeId: "node-running",
				status: "succeeded",
				outputVerified: true,
			}));

			expect(result).toMatchObject({ checked: 1, updated: 1, finalizedRuns: 0 });
			expect((await store.findById(run.runId))?.status).toBe("completed");
			const requests = store.listPendingTaskContinuations("project-1");
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({
				originRunId: run.runId,
				idempotencyKey: `task-continuation:${run.runId}`,
				status: "pending",
				taskResults: [
					{ taskId: "old-already-terminal", status: "succeeded" },
					{ taskId: "old-still-running", status: "succeeded" },
				],
			});
			expect(requests[0]?.prompt).toContain("上一阶段生成任务已完成");
		} finally {
			store.close();
		}
	});

	it("leaves requests pending without a key, defers busy sessions, and recovers only the queued idempotent Run", async () => {
		const { directory, store } = await createStore();
		const origin = await createPendingContinuation(store);
		const runService = new SessionRunService(store);
		try {
			const noKey = await requestDesktopTaskContinuations(createStores(store), {
				projectId: "project-1",
				apiKey: "",
			});
			expect(noKey).toMatchObject([{ status: "deferred", reason: "api_key_missing" }]);
			expect(store.findByIdempotency("session-1", `task-continuation:${origin.runId}`)).toBeUndefined();
			expect(store.listPendingTaskContinuations("project-1")[0]?.status).toBe("pending");

			const other = await runService.startRun({ sessionId: "session-1", idempotencyKey: "active-user-run" });
			await runService.setStatus(other.runId, "running");
			const busy = await requestDesktopTaskContinuations(createStores(store), {
				projectId: "project-1",
				apiKey: "configured-key",
			});
			expect(busy).toMatchObject([{ status: "deferred", reason: "session_active" }]);
			expect(store.listPendingTaskContinuations("project-1")[0]?.status).toBe("pending");
			await runService.setStatus(other.runId, "aborted");

			const claimed = await requestDesktopTaskContinuations(createStores(store), {
				projectId: "project-1",
				apiKey: "configured-key",
			});
			expect(claimed).toHaveLength(1);
			expect(claimed[0]).toMatchObject({
				status: "claimed",
				shouldStart: true,
				run: { status: "queued", idempotencyKey: `task-continuation:${origin.runId}` },
			});
			const continuationRunId = claimed[0]?.status === "claimed" ? claimed[0].run.runId : undefined;
			expect(continuationRunId).toBeTruthy();
			await recoverDesktopAgentRuns(createStores(store));
			expect((await store.findById(continuationRunId!))?.status).toBe("queued");
			expect(store.canRecoverQueuedTaskContinuation(continuationRunId!, "project-1")).toBe(true);

			await runService.setStatus(continuationRunId!, "running");
			store.prepareOperation({
				sessionId: "session-1",
				runId: continuationRunId!,
				toolCallId: "continuation-tool-call",
				effect: "canvas.write",
				inputHash: "a".repeat(64),
				canvasVersion: 1,
				idempotencyKey: "continuation-write-1",
			});
			await recoverDesktopAgentRuns(createStores(store));
			expect((await store.findById(continuationRunId!))?.status).toBe("aborted");
			expect(store.findTaskContinuationForRun(continuationRunId!)?.status).toBe("interrupted");
			expect(store.listPendingTaskContinuations("project-1")).toHaveLength(0);
		} finally {
			store.close();
		}

		const reopened = new DesktopAgentControlStore(join(directory, "control.sqlite"));
		try {
			const rows = reopened.listPendingTaskContinuations("project-1");
			expect(rows).toHaveLength(0);
		} finally {
			reopened.close();
		}
	});

	it("migrates a schema 5 control database without losing Runs or task events", async () => {
		const { directory, store } = await createStore();
		const { run, runService } = await createWaitingTaskRun(store, "schema-five-origin");
		await linkTask(store, run.runId, "schema-five-task");
		const eventsBeforeMigration = await runService.listEvents(run.runId);
		store.close();

		const legacyDatabase = new DatabaseSync(join(directory, "control.sqlite"));
		legacyDatabase.exec("DROP TABLE desktop_task_continuations; PRAGMA user_version = 5;");
		legacyDatabase.close();

		const migrated = new DesktopAgentControlStore(join(directory, "control.sqlite"));
		try {
			expect((await migrated.findById(run.runId))?.status).toBe("waiting_task");
			expect(await migrated.listEvents(run.runId)).toMatchObject(eventsBeforeMigration);
			const terminal = migrated.recordTaskStatus(
				{ taskId: "schema-five-task", status: "failed", errorCode: "TASK_FAILED" },
				{ projectId: "project-1" },
			);
			expect(terminal).toMatchObject({ runFinalized: true, continuationCreated: true, runStatus: "failed" });
		} finally {
			migrated.close();
		}

		const reopened = new DesktopAgentControlStore(join(directory, "control.sqlite"));
		try {
			expect((await reopened.findById(run.runId))?.status).toBe("failed");
			const eventsAfterMigration = await reopened.listEvents(run.runId);
			for (const event of eventsBeforeMigration) expect(eventsAfterMigration).toContainEqual(event);
			expect(
				eventsAfterMigration.some((event) => event.type === "task_status" && event.data.status === "failed"),
			).toBe(true);
			expect(reopened.listPendingTaskContinuations("project-1")).toMatchObject([
				{ originRunId: run.runId, idempotencyKey: `task-continuation:${run.runId}`, status: "pending" },
			]);
		} finally {
			reopened.close();
		}
	});

	it("updates claimed continuation state atomically when its Run completes or is cancelled", async () => {
		const { store } = await createStore();
		try {
			const completedOrigin = await createPendingContinuation(store, "task-complete-continuation");
			const completedClaim = await store.claimTaskContinuation({
				originRunId: completedOrigin.runId,
				projectId: "project-1",
				apiKey: "configured-key",
			});
			expect(completedClaim.status).toBe("claimed");
			if (completedClaim.status !== "claimed") throw new Error("CONTINUATION_CLAIM_EXPECTED");
			const runService = new SessionRunService(store);
			await runService.setStatus(completedClaim.run.runId, "running");
			await runService.setStatus(completedClaim.run.runId, "completed");
			expect(store.findTaskContinuationForRun(completedClaim.run.runId)?.status).toBe("completed");

			const cancelledOrigin = await createPendingContinuation(store, "task-cancel-continuation", "session-2");
			const cancelledClaim = await store.claimTaskContinuation({
				originRunId: cancelledOrigin.runId,
				projectId: "project-1",
				apiKey: "configured-key",
			});
			expect(cancelledClaim.status).toBe("claimed");
			if (cancelledClaim.status !== "claimed") throw new Error("CONTINUATION_CLAIM_EXPECTED");
			expect(await runService.cancelRun(cancelledClaim.run.runId)).toBe(true);
			expect(store.findTaskContinuationForRun(cancelledClaim.run.runId)?.status).toBe("interrupted");
			expect(store.listPendingTaskContinuations("project-1")).toHaveLength(0);

			const batchOrigin = await createPendingContinuation(store, "task-batch-continuation", "session-3");
			const batchClaim = await store.claimTaskContinuation({
				originRunId: batchOrigin.runId,
				projectId: "project-1",
				apiKey: "configured-key",
			});
			expect(batchClaim.status).toBe("claimed");
			if (batchClaim.status !== "claimed") throw new Error("CONTINUATION_CLAIM_EXPECTED");
			store.linkTask({
				taskId: "claimed-continuation-task",
				sessionId: "session-3",
				runId: batchClaim.run.runId,
				nodeId: "claimed-continuation-node",
				status: "queued",
			});
			const batchTerminal = store.recordTaskStatus(
				{
					taskId: "claimed-continuation-task",
					status: "succeeded",
					outputRef: "vibe://app/tasks/claimed-continuation-task/output",
				},
				{ projectId: "project-1" },
			);
			expect(batchTerminal).toMatchObject({ runStatus: "completed", runFinalized: true });
			expect(store.findTaskContinuationForRun(batchClaim.run.runId)?.status).toBe("completed");

			const recoveredOrigin = await createPendingContinuation(store, "task-recovered-continuation", "session-4");
			const recoveredClaim = await store.claimTaskContinuation({
				originRunId: recoveredOrigin.runId,
				projectId: "project-1",
				apiKey: "configured-key",
			});
			expect(recoveredClaim.status).toBe("claimed");
			if (recoveredClaim.status !== "claimed") throw new Error("CONTINUATION_CLAIM_EXPECTED");
			await runService.setStatus(recoveredClaim.run.runId, "running");
			await runService.setStatus(recoveredClaim.run.runId, "waiting_task");
			store.linkTask({
				taskId: "recovered-continuation-task",
				sessionId: "session-4",
				runId: recoveredClaim.run.runId,
				nodeId: "recovered-continuation-node",
				status: "succeeded",
			});
			expect(store.finalizeWaitingTaskRuns("project-1")).toBe(1);
			expect(store.findTaskContinuationForRun(recoveredClaim.run.runId)?.status).toBe("completed");
		} finally {
			store.close();
		}
	});
});
