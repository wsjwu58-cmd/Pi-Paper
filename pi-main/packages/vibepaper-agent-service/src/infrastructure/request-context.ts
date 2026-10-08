export type RequestContext = {
	requestId: string;
	userId: string;
	role: string;
	enterpriseId?: string;
};

type RequestLike = {
	id: string;
	headers: Record<string, string | string[] | undefined>;
};

export function buildRequestContext(request: RequestLike): RequestContext {
	const userId = headerValue(request.headers["x-user-id"]);
	if (!userId || !/^\d+$/.test(userId) || userId === "0") throw new Error("PERMISSION_DENIED");
	return {
		requestId: request.id,
		userId,
		role: headerValue(request.headers["x-user-role"]) ?? "user",
		...(headerValue(request.headers["x-enterprise-id"])
			? { enterpriseId: headerValue(request.headers["x-enterprise-id"]) }
			: {}),
	};
}

function headerValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}
