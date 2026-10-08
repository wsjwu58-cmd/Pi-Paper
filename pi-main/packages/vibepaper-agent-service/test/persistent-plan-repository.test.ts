import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	DesktopPersistentPlanRepository,
	desktopPlanResponse,
	parseDesktopAgentPlan,
	parseDesktopAgentProfile,
	parseDesktopPlanCreateRequest,
	parseDesktopPlanId,
	parseDesktopPlanRerunRequest,
} from "../src/desktop/persistent-plan-repository.ts";
import type { AgentPlan, PlanStep } from "../src/domain/agent-plan.ts";

const PLAN_SCHEMA = `
CREATE TABLE agent_plans (
	plan_id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	version INTEGER NOT NULL CHECK (version >= 0),
	canvas_version INTEGER NOT NULL CHECK (canvas_version >= 0),
	status TEXT NOT NULL CHECK (status IN ('draft', 'running', 'failed', 'completed')),
	plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX agent_plans_by_session ON agent_plans(session_id, created_at DESC);
CREATE TABLE agent_plan_steps (
	plan_id TEXT NOT NULL REFERENCES agent_plans(plan_id) ON DELETE CASCADE,
	step_id TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'stale')),
	task_id TEXT UNIQUE,
	idempotency_key TEXT,
	step_json TEXT NOT NULL CHECK (json_valid(step_json)),
	PRIMARY KEY (plan_id, step_id)
) STRICT;
CREATE INDEX agent_plan_steps_by_task ON agent_plan_steps(task_id) WHERE task_id IS NOT NULL;
`;

let openDatabases: DatabaseSync[] = [];

afterEach(() => {
	for (const database of openDatabases) database.close();
	openDatabases = [];
});

function createRepository(options: { sessionExists?: boolean; sessionActive?: boolean } = {}): {
	database: DatabaseSync;
	repository: DesktopPersistentPlanRepository;
} {
	const database = new DatabaseSync(":memory:");
	database.exec(PLAN_SCHEMA);
	openDatabases.push(database);
	return {
		database,
		repository: new DesktopPersistentPlanRepository(
			database,
			"project-1",
			async () => options.sessionExists ?? true,
			async () => options.sessionActive ?? options.sessionExists ?? true,
		),
	};
}

function step(id: string, overrides: Partial<PlanStep> = {}): PlanStep {
	return {
		id,
		tool: "get_canvas_summary",
		dependsOn: [],
		status: "pending",
		inputHash: `hash-${id}`,
		estimatedCost: 0,
		effect: "read",
		...overrides,
	};
}

function plan(id: string, steps: PlanStep[]): AgentPlan {
	return { id, sessionId: "session-1", version: 1, canvasVersion: 7, steps };
}

describe("DesktopPersistentPlanRepository", () => {
	it("validates the original create shape and returns a persisted compiled ready set", async () => {
		const { database, repository } = createRepository();
		const parsed = parseDesktopAgentPlan(
			{
				id: "901234",
				version: 1,
				canvasVersion: 7,
				steps: [{ id: "read", tool: "get_canvas_summary", inputHash: "hash-read" }],
			},
			"session-1",
		);
		expect(parsed.steps[0]?.estimatedCost).toBe(0);
		expect(parseDesktopAgentProfile("canvas-general")).toBe("canvas-general");
		expect(parseDesktopPlanId(901234)).toBe("901234");
		expect(
			parseDesktopPlanCreateRequest(
				{ plan: { id: "901234", version: 2, canvasVersion: 7, steps: [] }, profile: "canvas-general" },
				"session-1",
			).expectedVersion,
		).toBe(2);
		expect(parseDesktopPlanRerunRequest({ stepId: "step-1" })).toEqual({ stepId: "step-1" });
		expect(() => parseDesktopAgentProfile("untrusted-profile")).toThrow("profile 无效");
		expect(() => parseDesktopAgentPlan({ id: "901234", steps: [] }, "session-1")).toThrow("plan.version");
		expect(() => parseDesktopPlanId("0")).toThrow("planId");
		expect(() => parseDesktopPlanCreateRequest({ plan: {}, profile: "canvas-general" }, "session-1")).toThrow(
			"plan.steps",
		);
		expect(() => parseDesktopPlanRerunRequest({ stepId: " " })).toThrow("stepId");

		const initial = plan("901234", [
			step("read"),
			step("write", { tool: "create_nodes", effect: "write_canvas", dependsOn: ["read"] }),
		]);
		const created = await repository.create({
			ownerId: "project-1",
			sessionId: "session-1",
			plan: initial,
			expectedVersion: 1,
			profile: "canvas-general",
		});
		expect(created.readySet).toEqual(["read"]);
		expect(created.executionPartitions[0]?.stepIds).toEqual(["read"]);
		expect(JSON.stringify(desktopPlanResponse(created))).not.toContain("estimatedCost");
		expect(await repository.get(initial.id, "project-1")).toEqual(initial);
		expect((await repository.readySet(initial.id, "project-1", "canvas-general")).readySet).toEqual(["read"]);
		expect(database.prepare("SELECT status FROM agent_plans WHERE plan_id = ?").get(initial.id)).toEqual({
			status: "draft",
		});
		expect(
			database.prepare("SELECT COUNT(*) AS count FROM agent_plan_steps WHERE plan_id = ?").get(initial.id),
		).toEqual({ count: 2 });
	});

	it("runs original compiler checks before writing any plan rows", async () => {
		const { database, repository } = createRepository();
		const input = {
			ownerId: "project-1",
			sessionId: "session-1",
			plan: plan("901240", [step("read")]),
			profile: "canvas-general" as const,
		};
		await expect(repository.create({ ...input, expectedVersion: 2 })).rejects.toMatchObject({
			code: "VERSION_CONFLICT",
		});
		await expect(
			repository.create({
				...input,
				plan: plan("901241", [step("bad-tool", { tool: "unknown_tool" })]),
				expectedVersion: 1,
			}),
		).rejects.toMatchObject({ code: "TOOL_NOT_ALLOWED" });
		await expect(
			repository.create({
				...input,
				plan: plan(
					"901242",
					Array.from({ length: 21 }, (_, index) => step(`read-${index}`)),
				),
				expectedVersion: 1,
			}),
		).rejects.toMatchObject({ code: "BATCH_LIMIT_EXCEEDED" });
		expect(database.prepare("SELECT COUNT(*) AS count FROM agent_plans").get()).toEqual({ count: 0 });
	});

	it("claims with stable idempotency, links a task, and applies its terminal callback once", async () => {
		const { repository } = createRepository();
		const initial = plan("901235", [
			step("read"),
			step("generate", { tool: "submit_generation", effect: "create_task", dependsOn: ["read"], estimatedCost: 5 }),
		]);
		await repository.create({
			ownerId: "project-1",
			sessionId: "session-1",
			plan: initial,
			expectedVersion: 1,
			profile: "canvas-general",
		});
		expect((await repository.readySet(initial.id, "project-1", "canvas-general")).readySet).toEqual(["read"]);

		const claimedRead = await repository.claimStep({
			planId: initial.id,
			ownerId: "project-1",
			stepId: "read",
			now: new Date("2026-09-11T08:00:00.000Z"),
		});
		const readKey = claimedRead.steps[0]?.idempotencyKey;
		expect(readKey).toBe(`${initial.id}:read:hash-read`);
		await repository.completeStep({
			planId: initial.id,
			ownerId: "project-1",
			stepId: "read",
			idempotencyKey: readKey!,
			outputRef: "read-result://summary",
		});
		expect((await repository.readySet(initial.id, "project-1", "canvas-general")).readySet).toEqual(["generate"]);

		const claimedTask = await repository.claimStep({
			planId: initial.id,
			ownerId: "project-1",
			stepId: "generate",
			now: new Date("2026-09-11T08:00:02.000Z"),
		});
		const taskKey = claimedTask.steps.find((candidate) => candidate.id === "generate")?.idempotencyKey;
		const attached = await repository.attachTask({
			planId: initial.id,
			ownerId: "project-1",
			stepId: "generate",
			idempotencyKey: taskKey!,
			taskId: "task-1",
		});
		expect(attached.steps.find((candidate) => candidate.id === "generate")?.taskId).toBe("task-1");
		expect(await repository.listPendingTaskIds()).toEqual(["task-1"]);

		const applied = await repository.applyTaskTerminal({
			taskId: "task-1",
			status: "succeeded",
			outputRef: "vibe://app/tasks/task-1/output",
		});
		expect(applied.updated).toBe(true);
		expect(applied.plan?.steps.find((candidate) => candidate.id === "generate")).toMatchObject({
			status: "completed",
			taskId: "task-1",
			outputRef: "vibe://app/tasks/task-1/output",
		});
		const repeated = await repository.applyTaskTerminal({
			taskId: "task-1",
			status: "succeeded",
			outputRef: "vibe://app/tasks/task-1/output",
		});
		expect(repeated.updated).toBe(false);
		expect(repeated.plan?.version).toBe(applied.plan?.version);
		expect(await repository.listPendingTaskIds()).toEqual([]);
	});

	it("keeps task-backed leases across restart and fails the step only from authoritative interruption", async () => {
		const { repository } = createRepository();
		const initial = plan("901236", [step("generate", { tool: "submit_generation", effect: "create_task" })]);
		await repository.create({
			ownerId: "project-1",
			sessionId: "session-1",
			plan: initial,
			expectedVersion: 1,
			profile: "canvas-general",
		});
		const claimed = await repository.claimStep({
			planId: initial.id,
			ownerId: "project-1",
			stepId: "generate",
			now: new Date("2026-09-11T08:00:00.000Z"),
			leaseDurationMs: 1,
		});
		await repository.attachTask({
			planId: initial.id,
			ownerId: "project-1",
			stepId: "generate",
			idempotencyKey: claimed.steps[0]!.idempotencyKey!,
			taskId: "task-interrupted",
		});
		await expect(
			repository.claimStep({
				planId: initial.id,
				ownerId: "project-1",
				stepId: "generate",
				now: new Date("2026-09-11T08:00:01.000Z"),
			}),
		).rejects.toMatchObject({ code: "NOT_READY" });
		expect(await repository.listPendingTaskIds()).toEqual(["task-interrupted"]);

		const interrupted = await repository.applyTaskTerminal({ taskId: "task-interrupted", status: "interrupted" });
		expect(interrupted.updated).toBe(true);
		expect(interrupted.plan?.steps[0]).toMatchObject({ status: "failed", lastError: "TASK_INTERRUPTED" });
		expect(await repository.listPendingTaskIds()).toEqual([]);
	});

	it("does not mark a task complete without Main's verified output URI", async () => {
		const { repository } = createRepository();
		const initial = plan("901243", [step("generate", { tool: "submit_generation", effect: "create_task" })]);
		await repository.create({
			ownerId: "project-1",
			sessionId: "session-1",
			plan: initial,
			expectedVersion: 1,
			profile: "canvas-general",
		});
		const claimed = await repository.claimStep({ planId: initial.id, ownerId: "project-1", stepId: "generate" });
		await repository.attachTask({
			planId: initial.id,
			ownerId: "project-1",
			stepId: "generate",
			idempotencyKey: claimed.steps[0]!.idempotencyKey!,
			taskId: "task-output-missing",
		});

		const terminal = await repository.applyTaskTerminal({ taskId: "task-output-missing", status: "succeeded" });
		expect(terminal.updated).toBe(true);
		expect(terminal.plan?.steps[0]).toMatchObject({ status: "failed", lastError: "TASK_OUTPUT_UNAVAILABLE" });
	});

	it("creates a clean partial rerun for the selected step and its dependents", async () => {
		const { repository } = createRepository();
		const original = plan("901237", [
			step("read"),
			step("generate", { tool: "submit_generation", effect: "create_task", dependsOn: ["read"], estimatedCost: 3 }),
			step("other-read"),
		]);
		await repository.create({
			ownerId: "project-1",
			sessionId: "session-1",
			plan: original,
			expectedVersion: 1,
			profile: "canvas-general",
		});
		const readClaim = await repository.claimStep({ planId: original.id, ownerId: "project-1", stepId: "read" });
		await repository.completeStep({
			planId: original.id,
			ownerId: "project-1",
			stepId: "read",
			idempotencyKey: readClaim.steps[0]!.idempotencyKey!,
		});
		const taskClaim = await repository.claimStep({ planId: original.id, ownerId: "project-1", stepId: "generate" });
		await repository.attachTask({
			planId: original.id,
			ownerId: "project-1",
			stepId: "generate",
			idempotencyKey: taskClaim.steps.find((candidate) => candidate.id === "generate")!.idempotencyKey!,
			taskId: "task-failed",
		});
		await repository.applyTaskTerminal({ taskId: "task-failed", status: "failed", errorCode: "MODEL_FAILED" });

		const rerun = await repository.rerun({ planId: original.id, ownerId: "project-1", stepId: "generate" });
		expect(rerun.rerunOf).toBe(original.id);
		expect(rerun.id).not.toBe(original.id);
		expect(rerun.steps.find((candidate) => candidate.id === "read")?.status).toBe("completed");
		expect(rerun.steps.find((candidate) => candidate.id === "other-read")?.status).toBe("pending");
		const resetGeneration = rerun.steps.find((candidate) => candidate.id === "generate");
		expect(resetGeneration?.status).toBe("pending");
		expect(resetGeneration?.attemptCount).toBeUndefined();
		expect(resetGeneration?.taskId).toBeUndefined();
		expect(resetGeneration?.idempotencyKey).toBeUndefined();
		expect(resetGeneration?.lastError).toBeUndefined();
		expect(
			(await repository.get(original.id, "project-1")).steps.find((candidate) => candidate.id === "generate")
				?.status,
		).toBe("failed");
		expect(JSON.stringify(desktopPlanResponse(rerun))).not.toContain("estimatedCost");
	});

	it("rejects a missing or foreign session before storing a plan", async () => {
		const { database, repository } = createRepository({ sessionExists: false });
		await expect(
			repository.create({
				ownerId: "project-1",
				sessionId: "session-1",
				plan: plan("901238", [step("read")]),
				expectedVersion: 1,
				profile: "canvas-general",
			}),
		).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
		expect(database.prepare("SELECT COUNT(*) AS count FROM agent_plans").get()).toEqual({ count: 0 });
		await expect(repository.get("901238", "other-project")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
	});

	it("allows reads from archived sessions and blocks new planning writes", async () => {
		const { database, repository: activeRepository } = createRepository();
		const initial = plan("901239", [step("read")]);
		await activeRepository.create({
			ownerId: "project-1",
			sessionId: "session-1",
			plan: initial,
			expectedVersion: 1,
			profile: "canvas-general",
		});
		const archivedRepository = new DesktopPersistentPlanRepository(
			database,
			"project-1",
			async () => true,
			async () => false,
		);

		expect(await archivedRepository.get(initial.id, "project-1")).toEqual(initial);
		await expect(
			archivedRepository.claimStep({ planId: initial.id, ownerId: "project-1", stepId: "read" }),
		).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
		await expect(
			archivedRepository.rerun({ planId: initial.id, ownerId: "project-1", stepId: "read" }),
		).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
	});
});
