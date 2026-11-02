import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Message } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../../agent/src/agent-loop.ts";
import { createMarketplaceTools } from "../src/tools/creator-tools.ts";

const require = createRequire(import.meta.url);
const { createMarketplaceService } = require("../../../../pi-paper-desktop/src/marketplace.cjs") as {
	createMarketplaceService: (directory: string) => {
		validateCreatorDraft: (draft: unknown, allowNodeDefinition: boolean) => { draftDigest: string };
		saveProjectDraft: (
			directory: string,
			draft: unknown,
			input: { draftDigest: unknown; operationKey: string },
		) => Promise<{ packageId: string; package: { installed: boolean } }>;
	};
};

const draft = {
	name: "商品三视图",
	description: "",
	components: [
		{
			id: "three-views",
			type: "template",
			name: "三视图",
			description: "",
			data: {
				nodes: [
					{ id: "brief", type: "text", x: 0, y: 0, params: { content: "商品正面" } },
					{ id: "image", type: "image", x: 350, y: 0, params: {} },
				],
				edges: [{ source: "brief", target: "image" }],
			},
		},
	],
};

const model = {
	id: "fixture",
	name: "fixture",
	api: "openai-responses" as const,
	provider: "fixture",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "fixture",
		model: "fixture",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...model.cost, total: 0 } },
		stopReason,
		timestamp: 0,
	};
}

async function callThroughAgentLoop(tool: AgentTool, args: Record<string, unknown>) {
	let turn = 0;
	const stream = agentLoop(
		[{ role: "user", content: "检查插件", timestamp: 0 }],
		{ systemPrompt: "", messages: [], tools: [tool] },
		{
			model,
			convertToLlm: (messages: AgentMessage[]) =>
				messages.filter(
					(item) => item.role === "user" || item.role === "assistant" || item.role === "toolResult",
				) as Message[],
		},
		undefined,
		() => {
			const response = new EventStream<AssistantMessageEvent, AssistantMessage>(
				(event) => event.type === "done" || event.type === "error",
				(event) => {
					if (event.type === "done") return event.message;
					if (event.type === "error") return event.error;
					throw new Error("Unexpected stream event");
				},
			);
			queueMicrotask(() => {
				const output =
					turn++ === 0
						? message([{ type: "toolCall", id: "call-1", name: tool.name, arguments: args }], "toolUse")
						: message([{ type: "text", text: "done" }], "stop");
				response.push({
					type: "done",
					reason: output.stopReason === "toolUse" ? "toolUse" : "stop",
					message: output,
				});
			});
			return response;
		},
	);
	for await (const _event of stream) {
		// Wait for the tool and the final response.
	}
	const messages = await stream.result();
	const result = messages.find((item) => item.role === "toolResult");
	if (!result || result.role !== "toolResult") throw new Error("Missing tool result");
	return result;
}

describe("creator draft transport", () => {
	it("accepts the Agnes JSON-string form through the Agent loop and saves the same Main-validated draft", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "creator-draft-test-")));
		try {
			const project = join(root, "project");
			const userData = join(root, "userdata");
			await mkdir(project);
			await mkdir(join(project, ".vibepaper"));
			await mkdir(userData);
			const service = createMarketplaceService(userData);
			const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
			const tools = createMarketplaceTools({
				mode: "creator",
				canvasVersion: 0,
				request: async (action, input, toolCallId) => {
					calls.push({ action, input });
					if (action === "validate") return service.validateCreatorDraft(input.draft, true);
					if (action === "save")
						return service.saveProjectDraft(project, input.draft, {
							draftDigest: input.draftDigest,
							operationKey: toolCallId,
						});
					throw new Error("UNEXPECTED_HOST_ACTION");
				},
			});
			const validate = tools.find((tool) => tool.name === "creator_validate")!;
			const save = tools.find((tool) => tool.name === "creator_save")!;
			const serialized = JSON.stringify(draft);
			expect(Value.Check(validate.parameters, { draft })).toBe(true);
			expect(Value.Check(validate.parameters, { draft: serialized })).toBe(true);
			expect(Value.Check(save.parameters, { draft: serialized, draftDigest: "a".repeat(64) })).toBe(true);

			const checked = await callThroughAgentLoop(validate, { draft: serialized });
			expect(checked.isError).toBe(false);
			const text = checked.content[0];
			if (text.type !== "text") throw new Error("Missing validation result");
			const { draftDigest } = JSON.parse(text.text) as { draftDigest: string };
			expect(draftDigest).toMatch(/^[a-f0-9]{64}$/);
			const saved = await callThroughAgentLoop(save, { draft: serialized, draftDigest });
			expect(saved.isError).toBe(false);
			const savedText = saved.content[0];
			if (savedText.type !== "text") throw new Error("Missing save result");
			expect(JSON.parse(savedText.text)).toMatchObject({
				packageId: expect.any(String),
				package: { installed: false },
			});
			expect(calls).toEqual([
				{ action: "validate", input: { draft } },
				{ action: "save", input: { draft, draftDigest } },
			]);

			const objectCheck = await callThroughAgentLoop(validate, { draft });
			expect(objectCheck.isError).toBe(false);
			expect(objectCheck.content).toEqual(checked.content);
			const objectSave = await callThroughAgentLoop(save, { draft, draftDigest });
			expect(objectSave.isError).toBe(false);
			expect(calls.slice(2)).toEqual([
				{ action: "validate", input: { draft } },
				{ action: "save", input: { draft, draftDigest } },
			]);
			const changed = await callThroughAgentLoop(save, {
				draft: JSON.stringify({ ...draft, name: "修改后的草稿" }),
				draftDigest,
			});
			expect(changed.isError).toBe(true);
			expect(JSON.stringify(changed.content)).toContain("MARKETPLACE_DRAFT_CHANGED");
			expect(calls.map((call) => call.action)).toEqual(["validate", "save", "validate", "save", "save"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects malformed or oversized drafts and envelope arguments without sending them to Main", async () => {
		const calls: string[] = [];
		const tools = createMarketplaceTools({
			mode: "creator",
			canvasVersion: 0,
			request: async (action) => {
				calls.push(action);
				return {};
			},
		});
		const validate = tools.find((tool) => tool.name === "creator_validate")!;
		const save = tools.find((tool) => tool.name === "creator_save")!;
		const marker = "draft-content-must-not-appear";
		const invalidInputs = [
			{ draft: `{${marker}` },
			{ draft: JSON.stringify([draft]) },
			{ draft: JSON.stringify(JSON.stringify(draft)) },
			{ draft: JSON.stringify(null) },
			{ draft: JSON.stringify({ ...draft, unexpected: marker }) },
			{ draft: { ...draft, components: [{ ...draft.components[0], unexpected: marker }] } },
			{ draft, unexpected: marker },
			{ draft: "界".repeat(Math.ceil((8 * 1024 * 1024 + 1) / 3)) },
			{
				draft: {
					...draft,
					components: [{ ...draft.components[0], data: "界".repeat(Math.ceil((8 * 1024 * 1024 + 1) / 3)) }],
				},
			},
		];
		for (const input of invalidInputs) {
			expect(() => validate.prepareArguments!(input)).toThrow("INVALID_INPUT");
			await expect(validate.execute("direct", input)).rejects.toThrow("INVALID_INPUT");
		}
		expect(() => save.prepareArguments!({ draft, draftDigest: "invalid", unexpected: marker })).toThrow(
			"INVALID_INPUT",
		);
		await expect(save.execute("direct", { draft, draftDigest: "invalid" })).rejects.toThrow("INVALID_INPUT");
		const rejected = await callThroughAgentLoop(validate, invalidInputs[0]);
		expect(rejected.isError).toBe(true);
		expect(JSON.stringify(rejected.content)).toContain("INVALID_INPUT");
		expect(JSON.stringify(rejected.content)).not.toContain(marker);
		const oversized = await callThroughAgentLoop(validate, invalidInputs[7]);
		expect(oversized.isError).toBe(true);
		expect(JSON.stringify(oversized.content)).toContain("[INVALID_INPUT]");
		expect(JSON.stringify(oversized.content)).not.toContain("界");
		expect(calls).toEqual([]);
	});

	it("still leaves component-domain validation to Main and does not expose creator tools in standard mode", async () => {
		const actions: string[] = [];
		const context = {
			mode: "creator" as const,
			canvasVersion: 0,
			request: async (action: string) => {
				actions.push(action);
				throw new Error("MARKETPLACE_PACKAGE_INVALID");
			},
		};
		const tools = createMarketplaceTools(context);
		const validate = tools.find((tool) => tool.name === "creator_validate")!;
		const badData = {
			...draft,
			components: [{ ...draft.components[0], data: { nodes: "not an array", edges: [] } }],
		};
		const result = await callThroughAgentLoop(validate, { draft: JSON.stringify(badData) });
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("MARKETPLACE_PACKAGE_INVALID");
		expect(actions).toEqual(["validate"]);
		expect(
			createMarketplaceTools({ ...context, mode: "standard" }).some((tool) => tool.name.startsWith("creator_")),
		).toBe(false);
	});
});
