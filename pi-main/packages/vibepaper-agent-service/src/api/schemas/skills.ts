export const skillAttachSchema = {
	type: "object",
	required: ["skillId"],
	properties: { skillId: { type: "string" }, version: { type: "integer" } },
} as const;
