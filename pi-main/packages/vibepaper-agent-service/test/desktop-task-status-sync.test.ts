import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionRunService } from "../src/application/session-run-service.ts";
import { DesktopAgentControlStore } from "../src/desktop/control-store.ts";
import { reconcileDesktopAgentTasks } from "../src/desktop/task-status-sync.ts";

const temporaryDirectories: string[] = [];

async function createStore() {
	const directory = await mkdtemp(join(tmpdir(), "vibepaper-agent-task-sync-"));
	temporaryDirectories.push(directory);
	return { directory, store: new DesktopAgentControlStore(join(directory, "control.sqlite")) };
}

function createStores(store: DesktopAgentControlStore, sessionIds = ["session-1"]) {
	return {
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

async function createWaitingTaskRun(store: DesktopAgentControlStore, id = "run-1") {
	const runService = new SessionRunService(store);
	const run = await runService.startRun({ sessionId: "session-1", idempotencyKey: id });
	await runService.setStatus(run.runId, "running");
	await runService.setStatus(run.runId, "waiting_task");
	return { run, runService };
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
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
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
			expect(events.find((event) => event.type === "task_status" && event.data.status === "failed")?.data).toMatchObject({
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
			await reconcileDesktopAgentTasks(stores, async (taskId) => ({ taskId, nodeId: `node-${taskId}`, status: "running" }));
			await reconcileDesktopAgentTasks(stores, async (taskId) => ({ taskId, nodeId: `node-${taskId}`, status: "queued" }));

			expect(store.listTaskLinks(run.runId)[0]?.status).toBe("running");
			const events = await runService.listEvents(run.runId);
			expect(events.filter((event) => event.type === "task_status" && event.data.status === "queued")).toHaveLength(1);
			expect(events.filter((event) => event.type === "task_status" && event.data.status === "running")).toHaveLength(1);
		} finally {
			store.close();
		}
	});

	it("retries outbox delivery after a flush failure without rereading terminal tasks or duplicating events", async () => {
		const { directory, store } = await createStore();
		const { run, runService } = await createWaitingTaskRun(store);
		await linkTask(store, run.runId, "task-outbox");
		let flushCalls = 0;
		let readCalls = 0;
		const failingStores = {
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
				expect(events.filter((event) => event.type === "task_status" && event.data.status === "succeeded")).toHaveLength(1);
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

			const result = await reconcileDesktopAgentTasks(createStores(store, ["session-1", "session-2"]), async () => null);
			expect(result.expiredConfirmations).toBe(1);
			expect((await store.findById(pending.runId))?.status).toBe("aborted");
			expect((await store.findById(accepted.runId))?.status).toBe("waiting_confirmation");
		} finally {
			store.close();
		}
	});
});
