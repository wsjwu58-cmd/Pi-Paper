import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalService } from "../src/application/approval-service.ts";
import { SessionRunService } from "../src/application/session-run-service.ts";
import { DesktopAgentControlStore } from "../src/desktop/control-store.ts";
import {
	buildDesktopDeletionSnapshot,
	confirmDesktopDeleteAction,
	type DesktopDeletionConfirmationInput,
} from "../src/desktop/deletion-confirmation.ts";
import { recoverDesktopAgentRuns } from "../src/desktop/generation-confirmation.ts";
import { DesktopLocalToolGateway } from "../src/desktop/local-tool-gateway.ts";
import type { PlannedAction } from "../src/domain/action-approval.ts";
import { createRuntimeTools } from "../src/tools/runtime-tools.ts";

const temporaryDirectories: string[] = [];

async function createStore() {
	const directory = await mkdtemp(join(tmpdir(), "vibepaper-agent-delete-"));
	temporaryDirectories.push(directory);
	return { directory, store: new DesktopAgentControlStore(join(directory, "control.sqlite")) };
}

function createStores(store: DesktopAgentControlStore, sessionIds = ["session-delete"]) {
	return {
		projectId: "project-delete",
		control: store,
		sessions: {
			listSessions: async () => sessionIds.map((id) => ({ id })),
			flushOutbox: async () => 0,
		},
	} as unknown as Parameters<typeof recoverDesktopAgentRuns>[0];
}

function createGateway(options: { versionWhenDelete?: number } = {}) {
	let canvasVersion = 4;
	let nodes = [
		{ id: "node-a", type: "text", position: { x: 0, y: 0 }, data: { label: "方案" } },
		{ id: "node-b", type: "image", position: { x: 200, y: 0 }, data: { label: "主视觉" } },
		{ id: "node-c", type: "video", position: { x: 400, y: 0 }, data: { label: "片段" } },
	];
	let edges = [
		{ id: "edge-in", source: "node-c", target: "node-a" },
		{ id: "edge-out", source: "node-a", target: "node-b" },
		{ id: "edge-untouched", source: "node-b", target: "node-c" },
	];
	const groups = [{ id: "group-1", name: "脚本组", nodeIds: ["node-a", "node-b"] }];
	const stacks = [{ id: "stack-1", collapsed: false, nodeIds: ["node-a", "node-c"] }];
	const deleteCommands = new Map<string, Record<string, unknown>>();
	let deleteCalls = 0;
	const gateway = new DesktopLocalToolGateway(
		{
			request: async (method, payload) => {
				if (method === "agent:core:load-canvas")
					return {
						projectId: "project-delete",
						canvasId: "canvas-delete",
						version: canvasVersion,
						nodes,
						edges,
						groups,
						stacks,
					};
				if (method === "agent:core:delete-nodes") {
					if (options.versionWhenDelete !== undefined) canvasVersion = options.versionWhenDelete;
					const key = String(payload.idempotencyKey);
					const previous = deleteCommands.get(key);
					if (previous) return previous;
					if (payload.expectedVersion !== canvasVersion) throw new Error("VERSION_CONFLICT");
					const nodeIds = payload.nodeIds as string[];
					if (nodeIds.some((id) => !nodes.some((node) => node.id === id))) throw new Error("NOT_FOUND");
					deleteCalls += 1;
					const selected = new Set(nodeIds);
					nodes = nodes.filter((node) => !selected.has(node.id));
					edges = edges.filter((edge) => !selected.has(edge.source) && !selected.has(edge.target));
					canvasVersion += nodeIds.length;
					const result = { operation: "delete_nodes", canvasVersion, results: [] };
					deleteCommands.set(key, result);
					return result;
				}
				throw new Error(`unexpected local core method: ${method}`);
			},
		},
		"project-delete",
	);
	return {
		gateway,
		get deleteCalls() {
			return deleteCalls;
		},
		setCanvasVersion(version: number) {
			canvasVersion = version;
		},
	};
}

async function startWaitingRun(store: DesktopAgentControlStore, sessionId = "session-delete") {
	const runService = new SessionRunService(store);
	const run = await runService.startRun({ sessionId, idempotencyKey: `run-${sessionId}` });
	await runService.setStatus(run.runId, "running");
	return { run, runService };
}

async function prepareDeleteAction(
	store: DesktopAgentControlStore,
	gateway: ReturnType<typeof createGateway>["gateway"],
	input: { nodeIds?: string[]; sessionId?: string } = {},
): Promise<{ action: PlannedAction; runId: string }> {
	const sessionId = input.sessionId ?? "session-delete";
	const { run, runService } = await startWaitingRun(store, sessionId);
	const approval = new ApprovalService(store, store.getOrCreateApprovalSecret(), 300);
	let planned: PlannedAction | undefined;
	const tools = createRuntimeTools({
		userId: "project-delete",
		sessionId,
		runId: run.runId,
		canvasId: "canvas-delete",
		canvasVersion: 4,
		desktopMode: true,
		approvals: approval,
		gateway,
		onApprovalRequired: async (action) => {
			planned = action;
			await runService.setStatus(run.runId, "waiting_confirmation");
		},
	});
	const deletion = tools.find((tool) => tool.name === "delete_nodes");
	if (!deletion) throw new Error("DESKTOP_DELETE_TOOL_MISSING");
	const result = await deletion.execute("delete-call", { nodeIds: input.nodeIds ?? ["node-a"] });
	expect(result).toMatchObject({
		details: {
			kind: "canvas_delete",
			preview: {
				nodeCount: 1,
				nodeLabels: ["方案"],
				connectedEdgeCount: 2,
				downstreamNodeCount: 1,
				affectedGroupCount: 1,
				affectedGroupLabels: ["脚本组"],
				affectedStackCount: 1,
				groupMembershipsRetained: true,
				stackMembershipsRetained: true,
			},
		},
		terminate: true,
	});
	if (!planned) throw new Error("DELETE_APPROVAL_NOT_PLANNED");
	return { action: planned, runId: run.runId };
}

function confirmation(
	action: PlannedAction,
	accept: boolean,
	currentCanvasVersion = 4,
): DesktopDeletionConfirmationInput {
	if (!action.approvalToken) throw new Error("DELETE_APPROVAL_TOKEN_MISSING");
	return {
		projectId: "project-delete",
		canvasId: "canvas-delete",
		sessionId: action.sessionId,
		actionId: action.actionId,
		approvalToken: action.approvalToken,
		accept,
		currentCanvasVersion,
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("desktop delete confirmation", () => {
	it("persists a version and action-bound preview, then deletes through the original CanvasCommand gateway once", async () => {
		const { store } = await createStore();
		const fake = createGateway();
		const { gateway } = fake;
		try {
			const { action, runId } = await prepareDeleteAction(store, gateway);
			expect(action).toMatchObject({
				userId: "project-delete",
				sessionId: "session-delete",
				canvasId: "canvas-delete",
				canvasVersion: 4,
				toolName: "delete_nodes",
				binding: { canvasVersion: 4, actionHash: action.actionHash, expiresAt: expect.any(Number) },
				params: { nodeIds: ["node-a"], preview: { connectedEdgeCount: 2 } },
			});
			expect(await store.find(action.actionId)).toMatchObject({ status: "pending" });
			gateway.attachRun({ control: store, sessionId: "session-delete", runId });
			const stores = createStores(store);
			await expect(confirmDesktopDeleteAction(confirmation(action, true), stores, gateway)).resolves.toMatchObject({
				status: "accepted",
			});
			await expect(confirmDesktopDeleteAction(confirmation(action, true), stores, gateway)).resolves.toMatchObject({
				status: "accepted",
			});
			expect(fake.deleteCalls).toBe(1);
			expect((await store.find(action.actionId))?.status).toBe("consumed");
			expect(await new SessionRunService(store).findActive("session-delete")).toBeUndefined();
		} finally {
			store.close();
		}
	});

	it("does not write after rejection or when the canvas version changed before confirmation", async () => {
		const { store } = await createStore();
		const fake = createGateway();
		try {
			const rejected = await prepareDeleteAction(store, fake.gateway);
			await expect(
				confirmDesktopDeleteAction(confirmation(rejected.action, false), createStores(store), fake.gateway),
			).resolves.toMatchObject({ status: "rejected" });
			expect(fake.deleteCalls).toBe(0);

			const stale = await prepareDeleteAction(store, fake.gateway, { sessionId: "session-stale" });
			fake.setCanvasVersion(5);
			await expect(
				confirmDesktopDeleteAction(
					confirmation(stale.action, true),
					createStores(store, ["session-stale"]),
					fake.gateway,
				),
			).resolves.toMatchObject({ status: "rejected" });
			expect((await store.find(stale.action.actionId))?.status).toBe("rejected");
			expect(fake.deleteCalls).toBe(0);
		} finally {
			store.close();
		}
	});

	it("does not write for an expired confirmation", async () => {
		const { store } = await createStore();
		const fake = createGateway();
		try {
			const { run } = await startWaitingRun(store);
			const approval = new ApprovalService(store, store.getOrCreateApprovalSecret(), 1);
			const snapshot = await buildDesktopDeletionSnapshot(fake.gateway, "project-delete", "canvas-delete", [
				"node-a",
			]);
			const action = await approval.planActionAsync(
				{
					userId: "project-delete",
					runId: run.runId,
					sessionId: run.sessionId,
					canvasId: "canvas-delete",
					canvasVersion: snapshot.canvasVersion,
					toolName: "delete_nodes",
					params: { nodeIds: ["node-a"], preview: snapshot.preview },
					estimatedCost: 0,
					risk: "high",
					requiresApproval: true,
				},
				Date.now() - 10_000,
			);
			await new SessionRunService(store).setStatus(run.runId, "waiting_confirmation");
			await expect(
				confirmDesktopDeleteAction(confirmation(action, true), createStores(store), fake.gateway),
			).resolves.toMatchObject({ status: "rejected" });
			expect(fake.deleteCalls).toBe(0);
		} finally {
			store.close();
		}
	});

	it("reports a version race after command dispatch as an uncertain result", async () => {
		const { store } = await createStore();
		const fake = createGateway({ versionWhenDelete: 5 });
		try {
			const { action, runId } = await prepareDeleteAction(store, fake.gateway);
			fake.gateway.attachRun({ control: store, sessionId: action.sessionId, runId });
			await expect(
				confirmDesktopDeleteAction(confirmation(action, true), createStores(store), fake.gateway),
			).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
			expect((await store.findById(runId))?.status).toBe("failed");
			const terminal = (await new SessionRunService(store).listEvents(runId)).at(-1);
			expect(terminal).toMatchObject({
				type: "run_failed",
				data: {
					actionId: action.actionId,
					actionStatus: "uncertain",
					text: expect.stringContaining("删除命令已提交"),
				},
			});
			expect(fake.deleteCalls).toBe(0);
		} finally {
			store.close();
		}
	});

	it("invalidates pending and consumed delete confirmations after a worker restart", async () => {
		const { directory, store } = await createStore();
		const fake = createGateway();
		const pending = await prepareDeleteAction(store, fake.gateway);
		const consumed = await prepareDeleteAction(store, fake.gateway, { sessionId: "session-consumed" });
		await new ApprovalService(store, store.getOrCreateApprovalSecret(), 300).consumeApprovalIdempotently(
			consumed.action.actionId,
			consumed.action.approvalToken!,
			4,
		);
		store.close();

		const reopened = new DesktopAgentControlStore(join(directory, "control.sqlite"));
		try {
			await recoverDesktopAgentRuns(createStores(reopened, ["session-delete", "session-consumed"]));
			expect((await reopened.findById(pending.runId))?.status).toBe("aborted");
			expect((await reopened.find(pending.action.actionId))?.status).toBe("rejected");
			expect((await reopened.findById(consumed.runId))?.status).toBe("aborted");
			for (const action of [pending.action, consumed.action])
				await expect(
					confirmDesktopDeleteAction(confirmation(action, true), createStores(reopened), fake.gateway),
				).rejects.toThrow("RUN_NOT_ACTIVE");
			expect(fake.deleteCalls).toBe(0);
		} finally {
			reopened.close();
		}
	});

	it("does not write after the Agent run is stopped", async () => {
		const { store } = await createStore();
		const fake = createGateway();
		try {
			const { action, runId } = await prepareDeleteAction(store, fake.gateway);
			expect(store.cancelIfActiveAtomic(runId)).toBe(true);
			await expect(
				confirmDesktopDeleteAction(confirmation(action, true), createStores(store), fake.gateway),
			).rejects.toThrow("RUN_NOT_ACTIVE");
			expect(fake.deleteCalls).toBe(0);
		} finally {
			store.close();
		}
	});
});
