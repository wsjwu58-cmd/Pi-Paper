import { describe, expect, it } from "vitest";

import type { AgentPlan, PlanStep } from "../src/domain/agent-plan.ts";
import { PgPlanRepository } from "../src/infrastructure/pg-plan-repository.ts";
import type { MigrationDatabase } from "../src/infrastructure/migrations.ts";

const plan: AgentPlan = {
	id: "plan-1",
	sessionId: "session-1",
	version: 1,
	canvasVersion: 7,
	steps: [
		{
			id: "read",
			tool: "get_canvas_summary",
			dependsOn: [],
			status: "pending",
			inputHash: "read-hash",
			estimatedCost: 0,
			effect: "read",
		},
	],
};

class PlanDatabase implements MigrationDatabase {
	version = plan.version;
	status = "draft";
	planJson: AgentPlan = structuredClone(plan);
	stepUpdates: unknown[][] = [];

	async transaction<T>(operation: (client: this) => Promise<T>): Promise<T> {
		return await operation(this);
	}

	async query<T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
		if (text.includes("FROM agent_plans plan JOIN agent_sessions") && text.includes("FOR UPDATE")) {
			return {
				rows: [
					{
						id: this.planJson.id,
						session_id: this.planJson.sessionId,
						version: this.version,
						canvas_version: this.planJson.canvasVersion,
						status: this.status,
						plan_json: this.planJson,
					},
				] as T[],
			};
		}
		if (text.includes("UPDATE agent_plans SET version")) {
			this.version = values[0] as number;
			this.status = values[1] as string;
			this.planJson = JSON.parse(values[2] as string) as AgentPlan;
			return { rows: [{ id: this.planJson.id }] as T[] };
		}
		if (text.includes("UPDATE agent_plan_steps SET")) {
			this.stepUpdates.push(values);
			return { rows: [] };
		}
		throw new Error(`Unexpected query: ${text}`);
	}
}

describe("PgPlanRepository execution persistence", () => {
	it("locks, claims and completes a plan step while updating the persisted projection", async () => {
		const database = new PlanDatabase();
		const repository = new PgPlanRepository(database);
		const running = await repository.claimStep({
			planId: "plan-1",
			ownerId: "user-1",
			stepId: "read",
			now: new Date("2026-09-11T08:00:00.000Z"),
		});
		expect(running.steps[0]).toMatchObject({ status: "running", idempotencyKey: "plan-1:read:read-hash" });
		expect(database.version).toBe(2);
		expect(database.status).toBe("running");

		const completed = await repository.completeStep({
			planId: "plan-1",
			ownerId: "user-1",
			stepId: "read",
			idempotencyKey: "plan-1:read:read-hash",
			outputRef: "artifact://summary",
		});
		expect(completed.steps[0]).toMatchObject({ status: "completed", outputRef: "artifact://summary" });
		expect(database.version).toBe(3);
		expect(database.status).toBe("completed");
		expect(database.stepUpdates).toHaveLength(2);
	});
});
