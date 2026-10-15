import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { SessionRunService } from "../src/application/session-run-service.ts";
import { openDesktopAgentStores } from "../src/desktop/agent-stores.ts";
import { DesktopAgentControlStore } from "../src/desktop/control-store.ts";

const temporaryDirectories: string[] = [];

async function createProject() {
	const directory = await mkdtemp(join(tmpdir(), "vibepaper-agent-schema-backup-"));
	temporaryDirectories.push(directory);
	const projectId = randomUUID();
	const dataDirectory = join(directory, ".vibepaper");
	const agentDirectory = join(dataDirectory, "agent");
	await mkdir(join(agentDirectory, "sessions"), { recursive: true });
	await writeFile(join(dataDirectory, "project.json"), JSON.stringify({ schemaVersion: 1, projectId }), "utf8");
	return { directory, projectId, agentDirectory, controlPath: join(agentDirectory, "control.sqlite") };
}

async function createV5ControlDatabase(controlPath: string) {
	const control = new DesktopAgentControlStore(controlPath);
	const runs = new SessionRunService(control);
	const run = await runs.startRun({ sessionId: "migration-session", idempotencyKey: "preserved-run" });
	await runs.setStatus(run.runId, "running");
	await runs.appendEvent(run.runId, "assistant_delta", { delta: "persisted before upgrade" });
	control.close();

	const legacy = new DatabaseSync(controlPath);
	legacy.exec("DROP TABLE desktop_task_continuations; PRAGMA user_version = 5;");
	legacy.close();
	return run.runId;
}

function readBackupVersionAndRun(snapshotPath: string, runId: string): number {
	const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
	try {
		const version = snapshot.prepare("PRAGMA user_version").get() as { user_version: number };
		const integrity = snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
		const run = snapshot.prepare("SELECT id FROM agent_runs WHERE id = ?").get(runId) as { id: string } | undefined;
		expect(integrity.integrity_check).toBe("ok");
		expect(run?.id).toBe(runId);
		return Number(version.user_version);
	} finally {
		snapshot.close();
	}
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("desktop Agent control schema backup", () => {
	it("keeps a verified v5 snapshot and migrates without losing the original Run", async () => {
		const project = await createProject();
		const runId = await createV5ControlDatabase(project.controlPath);

		const stores = await openDesktopAgentStores(project.directory);
		try {
			expect((await stores.control.findById(runId))?.status).toBe("running");
			expect(stores.control.listEvents(runId).some((event) => event.type === "assistant_delta")).toBe(true);
		} finally {
			await stores.close();
		}

		const snapshotNames = (await readdir(project.agentDirectory)).filter((name) =>
			/^control-v5-[0-9a-f-]{36}\.pre-migration\.sqlite$/u.test(name),
		);
		expect(snapshotNames).toHaveLength(1);
		expect(readBackupVersionAndRun(join(project.agentDirectory, snapshotNames[0]!), runId)).toBe(5);

		const reopened = await openDesktopAgentStores(project.directory);
		await reopened.close();
		const directoryNames = await readdir(project.agentDirectory);
		expect(
			directoryNames.filter((name) => /^control-v5-[0-9a-f-]{36}\.pre-migration\.sqlite$/u.test(name)),
		).toHaveLength(1);
		expect(directoryNames.some((name) => /\.pre-migration\.sqlite-(?:wal|shm)$/u.test(name))).toBe(false);
	});

	it("backs up a v10 project and migrates MCP batch provider revisions", async () => {
		const project = await createProject();
		const proposalId = randomUUID();
		const legacyProposal = {
			proposalId,
			clientId: randomUUID(),
			grantId: randomUUID(),
			operationId: "legacy-batch",
			projectId: project.projectId,
			canvasId: "canvas-migration",
			canvasVersion: 4,
			modelBindingId: "provider-a/model-a",
			providerRevision: 2,
			approvalActionId: randomUUID(),
			status: "awaiting_confirmation" as const,
			expiresAt: Date.now() + 60_000,
		};
		const initial = await openDesktopAgentStores(project.directory);
		try {
			initial.control.createMcpProposal(legacyProposal);
		} finally {
			await initial.close();
		}

		const legacy = new DatabaseSync(project.controlPath);
		try {
			legacy.exec(`ALTER TABLE desktop_mcp_proposals DROP COLUMN provider_revisions_json;
				PRAGMA user_version = 10;`);
		} finally {
			legacy.close();
		}

		const migrated = await openDesktopAgentStores(project.directory);
		try {
			const proposal = migrated.control.getMcpProposal({
				proposalId,
				clientId: legacyProposal.clientId,
				grantId: legacyProposal.grantId,
			});
			expect(proposal).toMatchObject({ proposalId, status: "awaiting_confirmation", providerRevision: 2 });
			expect(proposal?.providerRevisions).toBeUndefined();
			const revisions = { "provider-a": 3, "local-openai-compatible": 7 };
			const batchProposalId = randomUUID();
			const saved = migrated.control.createMcpProposal({
				...legacyProposal,
				proposalId: batchProposalId,
				operationId: "migrated-batch",
				approvalActionId: randomUUID(),
				providerRevisions: revisions,
			});
			expect(saved.providerRevisions).toEqual(revisions);
		} finally {
			await migrated.close();
		}

		const snapshots = (await readdir(project.agentDirectory)).filter((name) =>
			/^control-v10-[0-9a-f-]{36}\.pre-migration\.sqlite$/u.test(name),
		);
		expect(snapshots).toHaveLength(1);
		const snapshot = new DatabaseSync(join(project.agentDirectory, snapshots[0]!), { readOnly: true });
		try {
			expect((snapshot.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(10);
			expect((snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe(
				"ok",
			);
		} finally {
			snapshot.close();
		}
	});

	it("retains the verified snapshot when the v5-to-v6 migration fails", async () => {
		const project = await createProject();
		const runId = await createV5ControlDatabase(project.controlPath);
		const legacy = new DatabaseSync(project.controlPath);
		legacy.exec("CREATE VIEW desktop_task_continuations AS SELECT 1; PRAGMA user_version = 5;");
		legacy.close();

		await expect(openDesktopAgentStores(project.directory)).rejects.toThrow();
		const snapshotNames = (await readdir(project.agentDirectory)).filter((name) =>
			/^control-v5-[0-9a-f-]{36}\.pre-migration\.sqlite$/u.test(name),
		);
		expect(snapshotNames).toHaveLength(1);
		expect(readBackupVersionAndRun(join(project.agentDirectory, snapshotNames[0]!), runId)).toBe(5);
		expect(
			(await readdir(project.agentDirectory)).some((name) => /\.pre-migration\.sqlite-(?:wal|shm)$/u.test(name)),
		).toBe(false);

		const original = new DatabaseSync(project.controlPath, { readOnly: true });
		try {
			expect((original.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(5);
			expect((original.prepare("SELECT id FROM agent_runs WHERE id = ?").get(runId) as { id: string }).id).toBe(
				runId,
			);
		} finally {
			original.close();
		}
	});
});
