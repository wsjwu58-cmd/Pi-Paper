export class AuthorizationError extends Error {
	readonly code: "NOT_FOUND" | "PERMISSION_DENIED" | "VERSION_CONFLICT";
	readonly statusCode: number;

	constructor(code: "NOT_FOUND" | "PERMISSION_DENIED" | "VERSION_CONFLICT", message: string) {
		super(message);
		this.name = "AuthorizationError";
		this.code = code;
		this.statusCode = code === "NOT_FOUND" ? 404 : code === "VERSION_CONFLICT" ? 409 : 403;
	}
}

export function assertOwner(ownerId: string | null | undefined, userId: string): void {
	if (!ownerId || ownerId !== userId) throw new AuthorizationError("NOT_FOUND", "资源不存在");
}

export function assertSessionCanvasAccess(sessionCanvasId: string | null, requestedCanvasId?: string): void {
	if (requestedCanvasId === undefined || requestedCanvasId === sessionCanvasId) return;
	throw new AuthorizationError("VERSION_CONFLICT", "会话已绑定其他画布，请显式复制会话后再使用");
}

export type StableApiError = {
	code: string;
	message: string;
	details: unknown;
	request_id: string;
	retryable: boolean;
};

export function formatApiError(error: AuthorizationError, requestId: string): StableApiError {
	return {
		code: error.code,
		message: error.message,
		details: undefined,
		request_id: requestId,
		retryable: false,
	};
}
