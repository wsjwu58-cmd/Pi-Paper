import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { SessionRunService } from "../src/application/session-run-service.ts";
import { openDesktopAgentStores } from "../src/desktop/agent-stores.ts";
import { DESKTOP_AGENT_CONTROL_SCHEMA_VERSION } from "../src/desktop/control-store.ts";
import type { AgentPlan } from "../src/domain/agent-plan.ts";

const temporaryDirectories: string[] = [];

async function createProject() {
	const directory = await mkdtemp(join(tmpdir(), "vibepaper-plan-v8-migration-"));
	temporaryDirectories.push(directory);
	const projectId = randomUUID();
	const dataDirectory = join(directory, ".vibepaper");
	const agentDirectory = join(dataDirectory, "agent");
	await mkdir(join(agentDirectory, "sessions"), { recursive: true });
	await writeFile(join(dataDirectory, "project.json"), JSON.stringify({ schemaVersion: 1, projectId }), "utf8");
	return { directory, projectId, agentDirectory, controlPath: join(agentDirectory, "control.sqlite") };
}

function snapshotContainsV7PlanAndRun(snapshotPath: string, planId: string, runId: string): number {
	const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
	try {
		const version = snapshot.prepare("PRAGMA user_version").get() as { user_version: number };
		const integrity = snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
		const plan = snapshot.prepare("SELECT plan_id FROM agent_plans WHERE plan_id = ?").get(planId) as
			| { plan_id: string }
			| undefined;
		const run = snapshot.prepare("SELECT id FROM agent_runs WHERE id = ?").get(runId) as { id: string } | undefined;
		const planStep = snapshot
			.prepare("SELECT step_id FROM agent_plan_steps WHERE plan_id = ? AND step_id = 'read-summary'")
			.get(planId) as { step_id: string } | undefined;
		const v8Tables = snapshot
			.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'desktop_plan_execution_%'")
			.all();
		expect(integrity.integrity_check).toBe("ok");
		expect(plan?.plan_id).toBe(planId);
		expect(planStep?.step_id).toBe("read-summary");
		expect(run?.id).toBe(runId);
		expect(v8Tables).toHaveLength(0);
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

describe("desktop plan execution v7-to-v8 migration", () => {
	it("backs up and preserves v7 plans and Runs, then freezes a legacy plan context on explicit execution", async () => {
		const project = await createProject();
		const originalPlan: AgentPlan = {
			id: `legacy-${randomUUID()}`,
			sessionId: "",
			version: 1,
			canvasVersion: 12,
			steps: [
				{
					id: "read-summary",
					tool: "get_canvas_summary",
					dependsOn: [],
					status: "pending",
					inputHash: "legacy-read-summary",
					estimatedCost: 0,
					effect: "read",
				},
			],
		};
		let stores = await openDesktopAgentStores(project.directory);
		let runId = "";
		let sessionId = "";
		try {
			const session = await stores.sessions.createSession("v7 legacy plan", "canvas-v7");
			sessionId = session.id;
			const runs = new SessionRunService(stores.control);
			const run = await runs.startRun({ sessionId, idempotencyKey: "v7-preserved-run" });
			runId = run.runId;
			await runs.setStatus(run.runId, "running");
			await runs.appendEvent(run.runId, "assistant_delta", { delta: "kept before schema upgrade" });
			await stores.plans.create({
				ownerId: project.projectId,
				sessionId,
				plan: { ...originalPlan, sessionId },
				expectedVersion: 1,
				profile: "canvas-general",
			});
		} finally {
			await stores.close();
		}

		const downgrade = new DatabaseSync(project.controlPath);
		try {
			downgrade.prepare("DELETE FROM desktop_plan_execution_context WHERE plan_id = ?").run(originalPlan.id);
			downgrade.exec(`
				DROP TABLE desktop_plan_execution_tasks;
				DROP TABLE desktop_plan_executions;
				DROP TABLE desktop_plan_execution_context;
				PRAGMA user_version = 7;
			`);
		} finally {
			downgrade.close();
		}

		stores = await openDesktopAgentStores(project.directory);
		try {
			expect(DESKTOP_AGENT_CONTROL_SCHEMA_VERSION).toBe(8);
			expect((await stores.control.findById(runId))?.status).toBe("running");
			expect(stores.control.listEvents(runId).some((event) => event.type === "assistant_delta")).toBe(true);
			expect(await stores.plans.get(originalPlan.id, project.projectId)).toEqual({ ...originalPlan, sessionId });
			expect(await stores.plans.getExecution({ planId: originalPlan.id, ownerId: project.projectId })).toEqual([]);

			const bound = await stores.plans.bindExecutionContext({
				planId: originalPlan.id,
				ownerId: project.projectId,
				canvasId: "canvas-v7",
				profile: "canvas-general",
			});
			expect(bound).toMatchObject({ canvasId: "canvas-v7", profile: "canvas-general", stopRequested: false });
			expect(
				await stores.plans.getExecutionContext({ planId: originalPlan.id, ownerId: project.projectId }),
			).toMatchObject({
				canvasId: "canvas-v7",
				profile: "canvas-general",
			});
			await expect(
				stores.plans.bindExecutionContext({
					planId: originalPlan.id,
					ownerId: project.projectId,
					canvasId: "canvas-restored",
					profile: "canvas-general",
				}),
			).rejects.toMatchObject({ code: "PLAN_CONTEXT_CONFLICT" });
			await expect(
				stores.plans.bindExecutionContext({
					planId: originalPlan.id,
					ownerId: project.projectId,
					canvasId: "canvas-v7",
					profile: "audit-readonly",
				}),
			).rejects.toMatchObject({ code: "PLAN_CONTEXT_CONFLICT" });
		} finally {
			await stores.close();
		}

		const snapshots = (await readdir(project.agentDirectory)).filter((name) =>
			/^control-v7-[0-9a-f-]{36}\.pre-migration\.sqlite$/u.test(name),
		);
		expect(snapshots).toHaveLength(1);
		expect(snapshotContainsV7PlanAndRun(join(project.agentDirectory, snapshots[0]!), originalPlan.id, runId)).toBe(7);

		const migrated = new DatabaseSync(project.controlPath, { readOnly: true });
		try {
			expect((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(8);
		} finally {
			migrated.close();
		}
	});
});
