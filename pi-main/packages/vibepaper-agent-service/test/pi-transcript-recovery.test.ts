import { describe, expect, it } from "vitest";

import { InMemoryTranscriptRepository, PiTranscriptService } from "../src/application/pi-transcript-service.ts";

describe("recoverable Pi transcript", () => {
	it("rebuilds user, tool observation and pending action entries after restart", async () => {
		const repository = new InMemoryTranscriptRepository();
		const service = new PiTranscriptService(repository);
		await service.append("run-1", { kind: "user", content: "create an image" });
		await service.append("run-1", {
			kind: "tool_result",
			tool: "get_canvas_summary",
			content: "version 3",
			effectId: "read-1",
		});
		await service.append("run-1", { kind: "pending_action", actionId: "action-1", content: "confirm generation" });

		const restarted = new PiTranscriptService(repository);
		expect(await restarted.recover("run-1")).toHaveLength(3);
		expect(await restarted.recover("run-1")).toEqual(await service.recover("run-1"));
	});

	it("steers an active run, follows up a waiting run and suppresses duplicate effects", async () => {
		const service = new PiTranscriptService(new InMemoryTranscriptRepository());
		service.setRunStatus("run-1", "running");
		expect(await service.steer("run-1", "stop after this turn")).toBe(true);
		service.setRunStatus("run-1", "waiting_confirmation");
		expect(await service.followUp("run-1", "yes")).toBe(true);
		expect(await service.recordEffect("run-1", "effect-1")).toBe(true);
		expect(await service.recordEffect("run-1", "effect-1")).toBe(false);
	});
});
