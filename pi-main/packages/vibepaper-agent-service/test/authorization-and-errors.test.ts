import { describe, expect, it } from "vitest";

import {
	AuthorizationError,
	assertOwner,
	assertSessionCanvasAccess,
	formatApiError,
} from "../src/application/authorization-service.ts";
import { buildRequestContext } from "../src/infrastructure/request-context.ts";

describe("authorization and request context", () => {
	it("rejects a request that tries to rebind a session to another canvas", () => {
		expect(() => assertSessionCanvasAccess("301", "302")).toThrowError(
			expect.objectContaining({ code: "VERSION_CONFLICT" }),
		);
	});

	it("uses not-found semantics for resources owned by another user", () => {
		expect(() => assertOwner("101", "202")).toThrowError(
			expect.objectContaining({ code: "NOT_FOUND", statusCode: 404 }),
		);
	});

	it("preserves the inbound request id and stable error envelope", () => {
		const context = buildRequestContext({
			id: "req-123",
			headers: { "x-user-id": "101", "x-user-role": "editor", "x-enterprise-id": "enterprise-1" },
		});
		expect(context).toEqual({ requestId: "req-123", userId: "101", role: "editor", enterpriseId: "enterprise-1" });
		expect(formatApiError(new AuthorizationError("PERMISSION_DENIED", "拒绝访问"), context.requestId)).toEqual({
			code: "PERMISSION_DENIED",
			message: "拒绝访问",
			details: undefined,
			request_id: "req-123",
			retryable: false,
		});
	});
});
