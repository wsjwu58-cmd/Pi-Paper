import { Agent, type AgentOptions, type AgentTool } from "@earendil-works/pi-agent-core";

import type { DramaStateStore } from "../domain/drama-state.ts";
import { type AgentProfile, getToolsForProfile } from "../domain/tool-manifest.ts";
import { createDramaTools } from "../tools/drama-tools.ts";
import { profileSystemPrompt } from "./profile-agents.ts";
import { VERTICAL_SHORT_DRAMA_SYSTEM_PROMPT } from "./system-prompt.ts";

export interface CreateDramaAgentOptions {
	initialState?: AgentOptions["initialState"];
	streamFn: AgentOptions["streamFn"];
	sessionId?: string;
	getApiKey?: AgentOptions["getApiKey"];
	systemPromptSuffix?: string;
	extraTools?: AgentTool[];
	runtimeTools?: AgentTool[];
	profile?: AgentProfile;
	desktopMode?: boolean;
	transformContext?: AgentOptions["transformContext"];
	shouldStopAfterTurn?: AgentOptions["shouldStopAfterTurn"];
}

export function createDramaAgent(store: DramaStateStore | undefined, options: CreateDramaAgentOptions): Agent {
	// The legacy drama tools only prepare in-memory draft state and are kept for
	// the standalone domain-agent tests. Runtime profiles must use the persisted
	// Canvas/generation tools so a successful reply always has real node lineage.
	if (!options.profile && !store) throw new Error("DRAMA_STATE_STORE_REQUIRED");
	const dramaTools = !options.profile ? createDramaTools(store!) : [];
	const profileToolNames = options.profile
		? new Set(getToolsForProfile(options.profile).map((entry) => entry.name))
		: undefined;
	const tools = [...dramaTools, ...(options.runtimeTools ?? []), ...(options.extraTools ?? [])].filter(
		(tool) =>
			!profileToolNames || profileToolNames.has(tool.name) || dramaTools.some((item) => item.name === tool.name),
	);
	const allowedToolNames = new Set(tools.map((tool) => tool.name));

	return new Agent({
		initialState: {
			...options.initialState,
			systemPrompt: [
				options.profile
					? profileSystemPrompt(options.profile, { desktopMode: options.desktopMode })
					: VERTICAL_SHORT_DRAMA_SYSTEM_PROMPT,
				options.systemPromptSuffix,
			]
				.filter(Boolean)
				.join("\n\n"),
			tools,
		},
		streamFn: options.streamFn,
		sessionId: options.sessionId,
		getApiKey: options.getApiKey,
		transformContext: options.transformContext,
		toolExecution: "sequential",
		shouldStopAfterTurn: options.shouldStopAfterTurn,
		beforeToolCall: async ({ toolCall }) => {
			if (allowedToolNames.has(toolCall.name)) return undefined;
			return {
				block: true,
				reason: "工具不在短剧 Agent 白名单中",
				terminate: true,
			};
		},
	});
}
