import { describe, expect, it } from "vitest";

import {
	type AgentEventEnvelope,
	AgentEventStream,
	strictAssistantDelta,
} from "../src/application/run-event-stream.ts";

describe("Agent run event streaming", () => {
	it("emits only the new assistant suffix", () => {
		expect(strictAssistantDelta("", "Hel")).toBe("Hel");
		expect(strictAssistantDelta("Hel", "Hello")).toBe("lo");
		expect(strictAssistantDelta("Hello", "Hello")).toBe("");
	});

	it("replays events strictly after the last event sequence", () => {
		const stream = new AgentEventStream();
		const events: AgentEventEnvelope[] = [
			stream.publish("run-1", "session-1", "assistant_delta", { text: "Hi" }),
			stream.publish("run-1", "session-1", "tool_started", { tool: "get_canvas_summary" }),
			stream.publish("run-1", "session-1", "run_completed", { text: "Hi" }),
		];
		expect(events[0].eventSeq).toBe(1);
		expect(stream.replay("run-1", 1).map((event) => event.eventSeq)).toEqual([2, 3]);
	});

	it("uses one monotonic cursor across runs in a session", () => {
		const stream = new AgentEventStream();
		stream.publish("run-1", "session-1", "run_completed", {});
		stream.publish("run-2", "session-1", "run_completed", {});
		expect(stream.replaySession("session-1", 1).map((event) => event.runId)).toEqual(["run-2"]);
	});

	it("does not turn an aborted or failed run into a successful completion", () => {
		const stream = new AgentEventStream();
		stream.publish("run-1", "session-1", "run_failed", { errorCode: "MODEL_TIMEOUT" });
		expect(stream.latest("run-1")?.type).toBe("run_failed");
		expect(stream.latest("run-1")?.type).not.toBe("run_completed");
	});

	it("accepts a persisted event without allocating a second cursor", () => {
		const stream = new AgentEventStream();
		stream.publishEvent({
			eventId: "event-9",
			runId: "run-1",
			sessionId: "session-1",
			eventSeq: 9,
			type: "assistant_delta",
			runtime: "pi",
			runtimeVersion: "0.1.0",
			data: { text: "persisted" },
		});
		const next = stream.publish("run-1", "session-1", "run_completed", {});
		expect(next.eventSeq).toBe(10);
		expect(stream.replay("run-1", 8).map((event) => event.eventId)).toEqual(["event-9", next.eventId]);
	});
});
