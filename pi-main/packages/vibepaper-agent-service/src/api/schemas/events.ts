export const agentEventEnvelopeSchema = {
	type: "object",
	required: ["eventId", "runId", "sessionId", "eventSeq", "type", "runtime", "runtimeVersion", "data"],
	properties: {
		eventId: { type: "string" },
		runId: { type: "string" },
		sessionId: { type: "string" },
		eventSeq: { type: "integer" },
		type: { type: "string" },
		runtime: { const: "pi" },
		runtimeVersion: { type: "string" },
		data: { type: "object" },
	},
} as const;
