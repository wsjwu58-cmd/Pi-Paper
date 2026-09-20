export const memorySchema = {
	type: "object",
	required: ["content"],
	properties: {
		content: { type: "string" },
		scope: { enum: ["session", "canvas", "long_term", "enterprise"] },
		visibility: { type: "string" },
	},
} as const;

export const memoryCandidateSchema = {
	type: "object",
	required: ["id", "content", "memoryType", "scope", "confidence", "createdAt"],
	properties: {
		id: { type: "string" },
		content: { type: "string" },
		memoryType: { type: "string" },
		scope: { enum: ["canvas", "long_term"] },
		canvasId: { type: "string" },
		confidence: { type: "number", minimum: 0, maximum: 1 },
		createdAt: { type: "string", format: "date-time" },
	},
} as const;
