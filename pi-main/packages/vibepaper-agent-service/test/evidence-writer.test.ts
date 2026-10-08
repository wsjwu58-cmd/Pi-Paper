import { describe, expect, it } from "vitest";

import { collectEvidenceEvents } from "../evals/evidence-writer.ts";

describe("evaluation evidence", () => {
	it("includes events emitted during turns and after resume", () => {
		const result = {
			caseId: "evidence-001",
			fixture: { caseId: "evidence-001", sessionId: "session-1", canvasId: "canvas-1" },
			turns: [
				{
					turnId: "turn-1",
					requestId: "request-1",
					runId: "run-1",
					status: "failed" as const,
					events: [
						{
							eventId: "event-1",
							runId: "run-1",
							sessionId: "session-1",
							eventSeq: 1,
							type: "run_failed",
							runtime: "pi" as const,
							runtimeVersion: "0.1.0",
							data: {},
						},
					],
				},
			],
			resumedEvents: [
				{
					eventId: "event-2",
					runId: "run-1",
					sessionId: "session-1",
					eventSeq: 2,
					type: "run_failed",
					runtime: "pi" as const,
					runtimeVersion: "0.1.0",
					data: {},
				},
			],
			status: "failed" as const,
			assertionFailures: [],
			evidence: { caseId: "evidence-001", turns: [], resumedEvents: [], assertionFailures: [] },
		};

		expect(collectEvidenceEvents(result).map((event) => event.eventId)).toEqual(["event-1", "event-2"]);
	});
});
