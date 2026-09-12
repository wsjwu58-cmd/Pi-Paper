export const sessionMessageSchema = {
	type: "object",
	required: ["content"],
	properties: {
		content: { type: "string" },
		canvasId: { type: "string" },
		selectedNodeIds: { type: "array", items: { type: "string" } },
		selectedSkillIds: { type: "array", items: { type: "string" } },
		modelId: { type: "string" },
	},
} as const;
