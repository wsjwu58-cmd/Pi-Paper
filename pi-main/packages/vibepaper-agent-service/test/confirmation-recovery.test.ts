import { describe, expect, it } from "vitest";

import { confirmationRecoveryMessage } from "../src/application/confirmation-recovery.ts";

describe("confirmation recovery message", () => {
	it("preserves a pending generation confirmation for a re-opened session", () => {
		const message = confirmationRecoveryMessage({
			tool: "submit_generation",
			actionId: "action-1",
			approvalToken: "approval-1",
			estimatedCost: 8,
			canvasVersion: 4,
			expiresAt: 1_788_060_046_984,
		});

		expect(message.content).toBe("生成已准备就绪，请确认后继续执行。");
		expect(message.meta).toMatchObject({
			requiresConfirmation: true,
			confirmation: {
				actionId: "action-1",
				approvalToken: "approval-1",
				estimatedCost: 8,
				canvasVersion: 4,
				status: "pending",
			},
		});
	});
});
