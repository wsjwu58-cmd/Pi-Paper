export const dramaSeriesSchema = {
	type: "object",
	required: ["canvasId"],
	properties: { id: { type: "string" }, canvasId: { type: "string" }, activeCanonRevision: { type: "integer" } },
} as const;
