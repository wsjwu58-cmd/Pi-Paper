import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { prepareDesktopAgentTurnContext } from "../src/application/agent-runtime.ts";
import type { AgentRunEvent } from "../src/domain/agent-run.ts";
import {
	assembleDesktopMemoryContext,
	planDesktopContextBudget,
	projectDesktopSessionContext,
} from "../src/desktop/context-assembler.ts";

function toolTurn(index: number): AgentMessage[] {
	const callId = `tool-${index}`;
	return [
		{
			role: "user",
			content: [{ type: "text", text: `历史需求 ${index} ${`需要保留的用户背景 ${index}。`.repeat(24)}` }],
			timestamp: index * 4,
		},
		{
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "read_canvas", arguments: { request: `state-${index}` } }],
			api: "openai-completions",
			provider: "agnes",
			model: "test-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: index * 4 + 1,
		},
		{
			role: "toolResult",
			toolCallId: callId,
			toolName: "read_canvas",
			content: [{ type: "text", text: `画布查询结果 ${index}。${`本轮权威读取的画布数据。`.repeat(10)}` }],
			isError: false,
			timestamp: index * 4 + 2,
		},
		{
			role: "assistant",
			content: [{ type: "text", text: `已完成第 ${index} 项核验。` }],
			api: "openai-completions",
			provider: "agnes",
			model: "test-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: index * 4 + 3,
		},
	];
}

function runEvent(partial: Pick<AgentRunEvent, "eventSeq" | "type" | "data">): AgentRunEvent {
	return {
		eventId: `event-${partial.eventSeq}`,
		runId: "run-1",
		sessionId: "session-1",
		eventSeq: partial.eventSeq,
		type: partial.type,
		runtime: "pi",
		runtimeVersion: "0.1.0",
		data: partial.data,
		createdAt: new Date(1_790_000_000_000 + partial.eventSeq),
	};
}

describe("desktop context assembly", () => {
	it("budgets system, tools, current input, and 55 complete tool turns before selecting a whole-turn suffix", () => {
		const history = Array.from({ length: 55 }, (_, index) => toolTurn(index)).flat();
		const plan = planDesktopContextBudget({
			history,
			currentUserInput: "本轮唯一输入标记 current-turn-only",
			systemPrompt: "system prompt ".repeat(1_000),
			toolSchemas: [{ name: "read_canvas", parameters: { type: "object", properties: { canvasId: { type: "string" } } } }],
			contextWindowTokens: 6_000,
			outputReserveTokens: 1_000,
			safetyMarginTokens: 500,
		});

		expect(plan.compactionRequired).toBe(true);
		expect(plan.requestFitsWithoutHistory).toBe(true);
		expect(plan.requestTokens).toBeGreaterThan(6_000);
		expect(plan.retainedHistory[0]?.role).toBe("user");
		expect(plan.retainedHistory.some((message) => JSON.stringify(message).includes("current-turn-only"))).toBe(false);
		const retainedCalls = plan.retainedHistory.flatMap((message) =>
			message.role === "assistant" && Array.isArray(message.content)
				? message.content.flatMap((part) => part.type === "toolCall" ? [part.id] : [])
				: [],
		);
		const retainedResults = plan.retainedHistory.flatMap((message) => message.role === "toolResult" ? [message.toolCallId] : []);
		expect([...retainedCalls].sort()).toEqual([...retainedResults].sort());
		expect(plan.summarizedHistory.length + plan.retainedHistory.length).toBe(history.length);
	});

	it("keeps the current user turn outside prior history so Pi sends it once", () => {
		const prior: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "过去的用户输入" }],
			timestamp: 1,
		};
		const descriptor = prepareDesktopAgentTurnContext(
			[{
				role: "user",
				content: "过去的用户输入",
				meta: {},
				createdAt: new Date(1),
				piMessage: prior,
			}],
			"本轮唯一输入标记 current-turn-only",
			{ indexLines: [], skills: [], loadedSkillIds: [], loadedSkills: [], onLoad: async () => undefined },
			[],
			{ profile: "canvas-general", desktopMode: true },
		);

		expect(descriptor.initialMessages).toHaveLength(1);
		expect(JSON.stringify(descriptor.initialMessages)).toContain("过去的用户输入");
		expect(JSON.stringify(descriptor.initialMessages)).not.toContain("current-turn-only");
		expect(descriptor.currentUserInput).toContain("current-turn-only");
	});

	it("rebuilds bounded working state from run events and the current canvas projection", async () => {
		const state = await projectDesktopSessionContext({
			sessionId: "session-1",
			canvasId: "canvas-1",
			initialGoal: "完成当前画布方案",
			events: [
				runEvent({ eventSeq: 1, type: "task_status", data: { taskId: "task-1", nodeId: "node-live", status: "succeeded" } }),
				runEvent({ eventSeq: 2, type: "tool_completed", data: { nodeId: "node-removed" } }),
				runEvent({ eventSeq: 3, type: "run_completed", data: {} }),
			],
			canvas: { canvasId: "canvas-1", version: 23, nodeIds: ["node-live"] },
		});

		expect(state.goal).toBe("完成当前画布方案");
		expect(state.canvasVersion).toBe(23);
		expect(state.tasks["task-1"]?.status).toBe("succeeded");
		expect(state.nodeRefs).toEqual(["node-live"]);
		expect(state.lastRunStatus).toBe("completed");
	});

	it("selects relevant unexpired memory within a fixed prompt budget", () => {
		const context = assembleDesktopMemoryContext({
			now: new Date("2026-09-30T12:00:00.000Z"),
			query: "分镜构图比例",
			canvasId: "canvas-1",
			maxCharacters: 120,
			records: [
				{ scope: "project", content: "保持 16:9 分镜构图", confidence: 0.9, createdAt: "2026-09-29T00:00:00.000Z" },
				{ scope: "daily", content: "已过期内容", confidence: 1, expiresAt: "2026-09-30T11:00:00.000Z" },
				{ scope: "canvas", content: "其他画布记录", confidence: 1, canvasId: "canvas-2" },
				{ scope: "session", content: "其他相关构图比例记录", confidence: 0.7, createdAt: "2026-09-29T00:00:00.000Z" },
			],
		});

		expect(context).toContain("保持 16:9 分镜构图");
		expect(context).toContain("其他相关构图比例记录");
		expect(context).not.toContain("已过期内容");
		expect(context).not.toContain("其他画布记录");
		expect(context!.length).toBeLessThanOrEqual(120);
	});
});
