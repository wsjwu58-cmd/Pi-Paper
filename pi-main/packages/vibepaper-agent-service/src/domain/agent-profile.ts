export type AgentProfile = "canvas-general" | "vertical-short-drama" | "asset-assistant" | "audit-readonly";

export type ModelSnapshot = {
	provider: string;
	modelId: string;
	version: string;
};
