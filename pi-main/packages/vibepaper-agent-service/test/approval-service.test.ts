import { describe, expect, it } from "vitest";

import {
	ApprovalService,
	InMemoryApprovalRepository,
	type PlanActionInput,
} from "../src/application/approval-service.ts";

const input: PlanActionInput = {
	userId: "101",
	sessionId: "session-1",
	canvasId: "301",
	canvasVersion: 7,
	toolName: "submit_generation",
	params: { model: "image-v1", prompt: "a blue bird" },
	estimatedCost: 1,
};

describe("action and approval service", () => {
	it("binds a high-risk action to a canonical hash and confirmation token", () => {
		const service = new ApprovalService(new InMemoryApprovalRepository(), "test-secret", 300);
		const planned = service.planAction(input, 1_700_000_000_000);
		expect(planned.approvalToken).toBeDefined();
		expect(planned.actionHash).toMatch(/^[a-f0-9]{64}$/);
		expect(planned.binding).toMatchObject({ userId: "101", canvasId: "301", canvasVersion: 7 });
	});

	it("consumes a valid approval only once and invalidates it after a canvas change", async () => {
		const repository = new InMemoryApprovalRepository();
		const service = new ApprovalService(repository, "test-secret", 300);
		const planned = service.planAction(input, 1_700_000_000_000);
		const results = await Promise.allSettled(
			Array.from({ length: 100 }, () =>
				service.consumeApproval(planned.actionId, planned.approvalToken!, 7, 1_700_000_000_001),
			),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);

		const expired = service.planAction(input, 1_700_000_000_000);
		await expect(
			service.consumeApproval(expired.actionId, expired.approvalToken!, 8, 1_700_000_000_001),
		).rejects.toThrow("VERSION_CONFLICT");
	});

	it("rejects an expired or tampered token", async () => {
		const service = new ApprovalService(new InMemoryApprovalRepository(), "test-secret", 300);
		const planned = service.planAction(input, 1_700_000_000_000);
		await expect(
			service.consumeApproval(planned.actionId, planned.approvalToken!, 7, 1_700_000_300_001),
		).rejects.toThrow("CONFIRMATION_REQUIRED");
		const fresh = service.planAction(input, 1_700_000_000_000);
		await expect(
			service.consumeApproval(fresh.actionId, `${fresh.approvalToken}tampered`, 7, 1_700_000_000_001),
		).rejects.toThrow("CONFIRMATION_REQUIRED");
	});

	it("can persist an approval before returning it", async () => {
		let saved = false;
		const repository = {
			save: async () => {
				saved = true;
			},
			find: () => undefined,
			consumePending: () => undefined,
		};
		const service = new ApprovalService(repository, "test-secret", 300);

		const planned = await service.planActionAsync(input, 1_700_000_000_000);

		expect(planned.approvalToken).toBeDefined();
		expect(saved).toBe(true);
	});
});
