import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ApprovalService } from "../src/application/approval-service.ts";
import { SessionRunService } from "../src/application/session-run-service.ts";
import { DesktopAgentControlStore } from "../src/desktop/control-store.ts";
import { confirmDesktopGenerationAction, recoverDesktopAgentRuns } from "../src/desktop/generation-confirmation.ts";
import type { RuntimeToolGateway } from "../src/tools/runtime-tools.ts";

const temporaryDirectories: string[] = [];

async function createStore() {
	const directory = await mkdtemp(join(tmpdir(), "vibepaper-agent-approval-"));
	temporaryDirectories.push(directory);
	return { directory, store: new DesktopAgentControlStore(join(directory, "control.sqlite")) };
}

function createStores(store: DesktopAgentControlStore, projectId = "project-1", sessionIds = ["session-1"]) {
	return {
		projectId,
		control: store,
		sessions: {
			listSessions: async () => sessionIds.map((id) => ({ id })),
			flushOutbox: async () => 0,
		},
	} as unknown as Parameters<typeof confirmDesktopGenerationAction>[1];
}

function createGateway(options: { version?: number; failAfterFirstCreate?: boolean } = {}) {
	const tasks = new Map<string, { taskId: string; status: string; modality: string; nodeId: string }>();
	let creationWrites = 0;
	let failAfterFirstCreate = options.failAfterFirstCreate === true;
	const gateway = {
		getCanvasSummary: async () => ({ canvas: { version: options.version ?? 4 } }),
		createGenerationTask: async (input: { idempotencyKey: string; nodeId: string; modelType: string }) => {
			const existing = tasks.get(input.idempotencyKey);
			if (existing) return existing;
			const created = {
				taskId: `task-${creationWrites + 1}`,
				status: "queued",
				modality: input.modelType === "local-sapi-tts" ? "audio" : "image",
				nodeId: input.nodeId,
			};
			tasks.set(input.idempotencyKey, created);
			creationWrites += 1;
			if (failAfterFirstCreate) {
				failAfterFirstCreate = false;
				throw new Error("AGENT_LOCAL_CORE_TIMEOUT");
			}
			return created;
		},
	};
	return {
		gateway: gateway as unknown as RuntimeToolGateway,
		tasks,
		get creationWrites() {
			return creationWrites;
		},
	};
}

async function createWaitingGeneration(
	store: DesktopAgentControlStore,
	input?: {
		toolName?: "submit_generation" | "submit_generation_batch";
		params?: Record<string, unknown>;
		now?: number;
		sessionId?: string;
	},
) {
	const sessionId = input?.sessionId ?? "session-1";
	const runService = new SessionRunService(store);
	const run = await runService.startRun({ sessionId, idempotencyKey: `run-${Date.now()}-${Math.random()}` });
	await runService.setStatus(run.runId, "running");
	const secret = store.getOrCreateApprovalSecret();
	const service = new ApprovalService(store, secret, 300);
	const toolName = input?.toolName ?? "submit_generation";
	const action = await service.planActionAsync(
		{
			userId: "project-1",
			runId: run.runId,
			sessionId: run.sessionId,
			canvasId: "canvas-1",
			canvasVersion: 4,
			toolName,
			params: input?.params ?? {
				nodeId: "node-1",
				modelType: "image-model",
				modelParams: { prompt: "a blue bird" },
				overwrite: false,
			},
			estimatedCost: 0,
			risk: "high",
			requiresApproval: true,
		},
		input?.now,
	);
	await runService.setStatus(run.runId, "waiting_confirmation");
	return { run, action, service };
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("desktop persisted approvals", () => {
	it("restores a pending confirmation and permits only an idempotent replay of its accepted action", async () => {
		const { directory, store } = await createStore();
		const runService = new SessionRunService(store);
		const run = await runService.startRun({ sessionId: "session-1", idempotencyKey: "run-1" });
		await runService.setStatus(run.runId, "running");
		const secret = store.getOrCreateApprovalSecret();
		const service = new ApprovalService(store, secret, 300);
		const action = await service.planActionAsync({
			userId: "project-1",
			runId: run.runId,
			sessionId: run.sessionId,
			canvasId: "canvas-1",
			canvasVersion: 4,
			toolName: "submit_generation",
			params: {
				nodeId: "node-1",
				modelType: "image-model",
				modelParams: { prompt: "a blue bird" },
				overwrite: false,
			},
			estimatedCost: 0,
			risk: "high",
			requiresApproval: true,
		});
		await runService.setStatus(run.runId, "waiting_confirmation");
		store.close();

		const reopened = new DesktopAgentControlStore(join(directory, "control.sqlite"));
		try {
			expect(reopened.getOrCreateApprovalSecret()).toBe(secret);
			const restored = await reopened.find(action.actionId);
			expect(restored?.status).toBe("pending");
			expect(restored?.action).toMatchObject({
				userId: "project-1",
				canvasId: "canvas-1",
				canvasVersion: 4,
				toolName: "submit_generation",
			});

			const resumedService = new ApprovalService(reopened, secret, 300);
			await expect(resumedService.consumeApproval(action.actionId, action.approvalToken!, 4)).resolves.toMatchObject(
				{ status: "approved" },
			);
			await expect(
				resumedService.consumeApprovalIdempotently(action.actionId, action.approvalToken!, 4),
			).resolves.toMatchObject({ status: "approved" });
			await expect(resumedService.consumeApproval(action.actionId, action.approvalToken!, 4)).rejects.toThrow(
				"CONFIRMATION_REQUIRED",
			);
		} finally {
			reopened.close();
		}
	});

	it("records rejection and invalidates pending actions when an active run is interrupted", async () => {
		const { store } = await createStore();
		try {
			const runService = new SessionRunService(store);
			const run = await runService.startRun({ sessionId: "session-2", idempotencyKey: "run-2" });
			await runService.setStatus(run.runId, "running");
			const secret = store.getOrCreateApprovalSecret();
			const service = new ApprovalService(store, secret, 300);
			const action = await service.planActionAsync({
				userId: "project-1",
				runId: run.runId,
				sessionId: run.sessionId,
				canvasId: "canvas-1",
				canvasVersion: 4,
				toolName: "submit_generation",
				params: {
					nodeId: "node-1",
					modelType: "image-model",
					modelParams: { prompt: "a blue bird" },
					overwrite: false,
				},
				estimatedCost: 0,
				risk: "high",
				requiresApproval: true,
			});
			await service.rejectApproval(action.actionId, action.approvalToken!);
			await expect(service.consumeApproval(action.actionId, action.approvalToken!, 4)).rejects.toThrow(
				"CONFIRMATION_REQUIRED",
			);

			const interrupted = await service.planActionAsync({
				userId: "project-1",
				runId: run.runId,
				sessionId: run.sessionId,
				canvasId: "canvas-1",
				canvasVersion: 4,
				toolName: "submit_generation",
				params: {
					nodeId: "node-2",
					modelType: "image-model",
					modelParams: { prompt: "a red bird" },
					overwrite: false,
				},
				estimatedCost: 0,
				risk: "high",
				requiresApproval: true,
			});
			store.invalidatePendingForRun(run.runId);
			expect((await store.find(interrupted.actionId))?.status).toBe("rejected");
			await expect(
				service.consumeApprovalIdempotently(interrupted.actionId, interrupted.approvalToken!, 4),
			).rejects.toThrow("CONFIRMATION_REQUIRED");
		} finally {
			store.close();
		}
	});

	it("binds each token to its exact persisted action", async () => {
		const { store } = await createStore();
		try {
			const first = await createWaitingGeneration(store);
			const second = await first.service.planActionAsync(
				{
					userId: "project-1",
					runId: first.run.runId,
					sessionId: first.run.sessionId,
					canvasId: "canvas-1",
					canvasVersion: 4,
					toolName: "submit_generation",
					params: {
						nodeId: "node-1",
						modelType: "image-model",
						modelParams: { prompt: "a blue bird" },
						overwrite: false,
					},
					estimatedCost: 0,
					risk: "high",
					requiresApproval: true,
				},
				Date.now(),
			);
			await expect(
				new ApprovalService(store, store.getOrCreateApprovalSecret(), 300).consumeApprovalIdempotently(
					second.actionId,
					first.action.approvalToken!,
					4,
				),
			).rejects.toThrow("CONFIRMATION_REQUIRED");
		} finally {
			store.close();
		}
	});

	it("does not create tasks when a pending action is rejected or the canvas version changed", async () => {
		const { store } = await createStore();
		const stores = createStores(store);
		const gateway = createGateway();
		try {
			const rejected = await createWaitingGeneration(store);
			await expect(
				confirmDesktopGenerationAction(
					{
						projectId: "project-1",
						canvasId: "canvas-1",
						sessionId: "session-1",
						actionId: rejected.action.actionId,
						approvalToken: rejected.action.approvalToken!,
						accept: false,
						currentCanvasVersion: 4,
					},
					stores,
					gateway.gateway,
				),
			).resolves.toMatchObject({ status: "rejected" });

			const changed = await createWaitingGeneration(store);
			const changedGateway = createGateway({ version: 5 });
			await expect(
				confirmDesktopGenerationAction(
					{
						projectId: "project-1",
						canvasId: "canvas-1",
						sessionId: "session-1",
						actionId: changed.action.actionId,
						approvalToken: changed.action.approvalToken!,
						accept: true,
						currentCanvasVersion: 5,
					},
					stores,
					changedGateway.gateway,
				),
			).resolves.toMatchObject({ status: "rejected" });

			const expired = await createWaitingGeneration(store, { now: Date.now() - 301_000 });
			const expiredGateway = createGateway();
			await expect(
				confirmDesktopGenerationAction(
					{
						projectId: "project-1",
						canvasId: "canvas-1",
						sessionId: "session-1",
						actionId: expired.action.actionId,
						approvalToken: expired.action.approvalToken!,
						accept: true,
						currentCanvasVersion: 4,
					},
					stores,
					expiredGateway.gateway,
				),
			).resolves.toMatchObject({ status: "rejected" });
			expect(gateway.creationWrites).toBe(0);
			expect(changedGateway.creationWrites).toBe(0);
			expect(expiredGateway.creationWrites).toBe(0);
		} finally {
			store.close();
		}
	});

	it("submits confirmed local SAPI audio actions once for both single and batch tools", async () => {
		const { store } = await createStore();
		const stores = createStores(store);
		const confirmation = (action: Awaited<ReturnType<typeof createWaitingGeneration>>) => ({
			projectId: "project-1",
			canvasId: "canvas-1",
			sessionId: action.run.sessionId,
			actionId: action.action.actionId,
			approvalToken: action.action.approvalToken!,
			accept: true,
			currentCanvasVersion: 4,
		});
		try {
			const single = await createWaitingGeneration(store, {
				toolName: "submit_generation",
				params: {
					nodeId: "audio-node-1",
					modelType: "local-sapi-tts",
					modelParams: { prompt: "朗读第一段。", voice: "female", language: "zh-CN", speed: 0.95 },
					overwrite: false,
				},
			});
			const singleGateway = createGateway();
			expect(singleGateway.creationWrites).toBe(0);
			expect(singleGateway.tasks.size).toBe(0);
			await expect(
				confirmDesktopGenerationAction(confirmation(single), stores, singleGateway.gateway),
			).resolves.toMatchObject({ status: "accepted" });
			expect(singleGateway.creationWrites).toBe(1);
			expect([...singleGateway.tasks.values()]).toEqual([
				{ taskId: "task-1", status: "queued", modality: "audio", nodeId: "audio-node-1" },
			]);
			await confirmDesktopGenerationAction(confirmation(single), stores, singleGateway.gateway);
			expect(singleGateway.creationWrites).toBe(1);

			const batch = await createWaitingGeneration(store, {
				toolName: "submit_generation_batch",
				sessionId: "session-audio-batch",
				params: {
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
				},
			});
			const batchGateway = createGateway();
			expect(batchGateway.creationWrites).toBe(0);
			expect(batchGateway.tasks.size).toBe(0);
			await expect(
				confirmDesktopGenerationAction(confirmation(batch), stores, batchGateway.gateway),
			).resolves.toMatchObject({ status: "accepted" });
			expect(batchGateway.creationWrites).toBe(2);
			expect([...batchGateway.tasks.values()].map((task) => [task.modality, task.nodeId])).toEqual([
				["audio", "audio-node-2"],
				["audio", "audio-node-3"],
			]);
			await confirmDesktopGenerationAction(confirmation(batch), stores, batchGateway.gateway);
			expect(batchGateway.creationWrites).toBe(2);
		} finally {
			store.close();
		}
	});

	it("recovers accepted actions by idempotent replay after a task commit response is lost", async () => {
		const { directory, store } = await createStore();
		const created = await createWaitingGeneration(store);
		const action = created.action;
		const secret = store.getOrCreateApprovalSecret();
		await new ApprovalService(store, secret, 300).consumeApprovalIdempotently(
			action.actionId,
			action.approvalToken!,
			4,
		);
		const durableGateway = createGateway({ failAfterFirstCreate: true });
		store.close();

		const reopened = new DesktopAgentControlStore(join(directory, "control.sqlite"));
		try {
			const stores = createStores(reopened);
			const input = {
				projectId: "project-1",
				canvasId: "canvas-1",
				sessionId: "session-1",
				actionId: action.actionId,
				approvalToken: action.approvalToken!,
				accept: true,
				currentCanvasVersion: 4,
			};
			await expect(confirmDesktopGenerationAction(input, stores, durableGateway.gateway)).rejects.toThrow(
				"AGENT_LOCAL_CORE_TIMEOUT",
			);
			await expect(confirmDesktopGenerationAction(input, stores, durableGateway.gateway)).resolves.toMatchObject({
				status: "accepted",
			});
			expect(durableGateway.creationWrites).toBe(1);
			expect(durableGateway.tasks.size).toBe(1);
			await expect(confirmDesktopGenerationAction(input, stores, durableGateway.gateway)).resolves.toMatchObject({
				status: "accepted",
			});
			expect(durableGateway.creationWrites).toBe(1);
		} finally {
			reopened.close();
		}
	});

	it("does not reinterpret a post-restart rejection as acceptance of a consumed action", async () => {
		const { store } = await createStore();
		try {
			const { action } = await createWaitingGeneration(store);
			const service = new ApprovalService(store, store.getOrCreateApprovalSecret(), 300);
			await service.consumeApprovalIdempotently(action.actionId, action.approvalToken!, 4);
			const gateway = createGateway();
			await expect(
				confirmDesktopGenerationAction(
					{
						projectId: "project-1",
						canvasId: "canvas-1",
						sessionId: "session-1",
						actionId: action.actionId,
						approvalToken: action.approvalToken!,
						accept: false,
						currentCanvasVersion: 4,
					},
					createStores(store),
					gateway.gateway,
				),
			).rejects.toThrow("CONFIRMATION_DECISION_ALREADY_ACCEPTED");
			expect(gateway.creationWrites).toBe(0);
		} finally {
			store.close();
		}
	});

	it("aborts pending approvals on restart but leaves previously accepted actions waiting for an explicit retry", async () => {
		const { store } = await createStore();
		try {
			const pending = await createWaitingGeneration(store);
			const accepted = await createWaitingGeneration(store, { sessionId: "session-2" });
			await accepted.service.consumeApprovalIdempotently(
				accepted.action.actionId,
				accepted.action.approvalToken!,
				4,
			);
			await recoverDesktopAgentRuns(createStores(store, "project-1", ["session-1", "session-2"]));

			expect((await store.find(pending.action.actionId))?.status).toBe("rejected");
			expect((await store.findById(pending.run.runId))?.status).toBe("aborted");
			expect((await store.findById(accepted.run.runId))?.status).toBe("waiting_confirmation");
			expect(store.findConsumedApprovalForRun(accepted.run.runId)?.status).toBe("consumed");
		} finally {
			store.close();
		}
	});
});
