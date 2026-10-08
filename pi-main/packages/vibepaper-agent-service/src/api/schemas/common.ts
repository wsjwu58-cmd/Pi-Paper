export const errorSchema = {
	type: "object",
	required: ["code", "message", "request_id", "retryable"],
	properties: {
		code: { type: "string" },
		message: { type: "string" },
		details: {},
		request_id: { type: "string" },
		retryable: { type: "boolean" },
	},
} as const;
