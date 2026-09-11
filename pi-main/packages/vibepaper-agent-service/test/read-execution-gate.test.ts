import { describe, expect, it } from "vitest";

import { PerUserReadExecutionGate } from "../src/application/read-execution-gate.ts";

describe("PerUserReadExecutionGate", () => {
	it("enforces a FIFO per-user limit without blocking another user", async () => {
		const gate = new PerUserReadExecutionGate(1);
		const starts: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const first = gate.run("user-1", async () => {
			starts.push("first");
			await new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
		});
		await Promise.resolve();
		const second = gate.run("user-1", async () => starts.push("second"));
		const otherUser = gate.run("user-2", async () => starts.push("other"));
		await Promise.resolve();
		expect(starts).toEqual(["first", "other"]);
		releaseFirst?.();
		await Promise.all([first, second, otherUser]);
		expect(starts).toEqual(["first", "other", "second"]);
	});
});
