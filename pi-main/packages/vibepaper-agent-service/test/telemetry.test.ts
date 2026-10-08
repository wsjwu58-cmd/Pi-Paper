import { describe, expect, it } from "vitest";
import { AgentTelemetry } from "../src/infrastructure/telemetry.ts";

describe("agent telemetry", () => {
	it("keeps required trace fields and redacts sensitive values", () => {
		const telemetry = new AgentTelemetry();
		telemetry.record({
			request_id: "r1",
			user_id: "7",
			session_id: "s1",
			run_id: "run1",
			event_seq: 1,
			action_id: "a1",
			task_id: "t1",
			canvas_id: "c1",
			model_id: "m1",
			error_code: undefined,
			estimated_cost: 2,
			actual_cost: 2,
			prompt: "api_key=secret",
		});
		const record = telemetry.records()[0];
		expect(record.request_id).toBe("r1");
		expect(JSON.stringify(record)).not.toContain("secret");
		telemetry.increment("run_completed");
		expect(telemetry.metric("run_completed")).toBe(1);
	});
});
