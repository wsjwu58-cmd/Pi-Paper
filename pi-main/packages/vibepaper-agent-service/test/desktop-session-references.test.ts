import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import {
	DesktopAgentSessionStore,
	desktopCompactionSummary,
	type DesktopAgentMessageMetadata,
} from "../src/desktop/session-store.ts";

const temporaryDirectories: string[] = [];
const openStores: DesktopAgentSessionStore[] = [];

async function createStore() {
	const directory = await mkdtemp(join(tmpdir(), "vibepaper-agent-session-references-"));
	temporaryDirectories.push(directory);
	const projectDirectory = join(directory, "project");
	const sessionsDirectory = join(directory, "sessions");
	await Promise.all([mkdir(projectDirectory), mkdir(sessionsDirectory)]);
	const store = new DesktopAgentSessionStore(
		"f382c607-b2c1-41d9-9703-8bd84ae84c29",
		projectDirectory,
		sessionsDirectory,
	);
	openStores.push(store);
	return { directory, projectDirectory, sessionsDirectory, store };
}

async function closeStore(store: DesktopAgentSessionStore): Promise<void> {
	const index = openStores.indexOf(store);
	if (index >= 0) openStores.splice(index, 1);
	await store.close();
}

afterEach(async () => {
	await Promise.all(openStores.splice(0).map((store) => store.close()));
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("desktop Pi session reference metadata", () => {
	it("retains selected reference identities in model history and compaction without changing visible text", async () => {
		const { store } = await createStore();
		const session = await store.createSession("历史参考");
		await store.appendMessage(session.id, { role: "user", content: "继续这张图", timestamp: Date.now() }, {
			selectedNodeIds: ["image-source"], nodeReferences: [{
				nodeId: "image-source", nodeType: "image", title: "人物图", status: "ready",
			}],
		});
		expect(JSON.stringify((await store.buildContext(session.id)).messages)).toContain("image-source");
		expect((await store.listTranscriptMessages(session.id))[0]?.message.content).toBe("继续这张图");
		await store.appendCompaction(session.id, { summary: "用户正在引用人物图继续整理画布。", retainLastMessages: 1, tokensBefore: 100 });
		const context = await store.buildContext(session.id);
		expect(JSON.stringify(context.messages)).toContain("image-source");
		expect(JSON.stringify(context.messages).match(/NODE_REFERENCES_UNTRUSTED_DATA_BEGIN/g)).toHaveLength(1);
		await store.appendCompaction(session.id, { summary: "用户正在引用人物图继续整理画布。", retainLastMessages: 0, tokensBefore: 100 });
		expect((await store.buildContext(session.id)).messages).toHaveLength(1);
		expect(await store.listTranscriptMessages(session.id)).toHaveLength(1);
	});

	it("writes bounded summary usage receipts without summary content", async () => {
		const { store } = await createStore();
		const session = await store.createSession("摘要用量");
		await store.appendSummaryUsage(session.id, { provider: "agnes", model: "agnes-2.5-flash",
			usage: { input: 70, output: 10, cacheRead: 3, cacheWrite: 0 } });
		const entries = await (await store.openSession(session.id)).findEntries({ type: "custom" });
		expect(entries).toMatchObject([{ customType: "vibepaper_summary_usage", data: {
			provider: "agnes", usage: { input: 70, output: 10 },
		} }]);
		await expect(store.appendSummaryUsage(session.id, { provider: "agnes", model: "test",
			usage: { input: NaN, output: 0, cacheRead: 0, cacheWrite: 0 } })).rejects.toThrow("AGENT_USAGE_INVALID");
	});
	it("persists live tool DTOs with optional undefined fields and restores their results", async () => {
		const { store } = await createStore();
		const session = await store.createSession("工具结果落盘");
		const message: AgentMessage = {
			role: "toolResult", toolCallId: "call-live", toolName: "create_nodes",
			content: [{ type: "text", text: "已创建节点" }],
			details: { nodes: [{ title: "小猫", assetId: undefined }], warning: undefined },
			isError: false, timestamp: Date.now(),
		};
		await store.appendMessage(session.id, message);
		const context = await store.buildContext(session.id);
		expect(context.messages[0]).toMatchObject({ details: { nodes: [{ title: "小猫" }] } });
		expect(message).toHaveProperty("details.warning", undefined);
		await expect(store.appendMessage(session.id, { ...message, details: [undefined] }))
			.rejects.toThrow("contains undefined");
		await expect(store.appendMessage(session.id, { ...message, details: { count: NaN } }))
			.rejects.toThrow("non-finite");
		const unsupportedArray = Object.assign(["value"], { hidden: undefined });
		await expect(store.appendMessage(session.id, { ...message, details: unsupportedArray }))
			.rejects.toThrow("unsupported properties");
		await expect(store.appendMessage(session.id, { ...message, details: { [Symbol("hidden")]: undefined } }))
			.rejects.toThrow("symbol");
	});
	it("restores stable node reference cards after reopening JSONL and drops remote secrets and prompt bodies", async () => {
		const { projectDirectory, sessionsDirectory, store } = await createStore();
		const session = await store.createSession("参考历史");
		const metadata = {
			selectedNodeIds: ["node-1"],
			nodeReferences: [{
				nodeId: "node-1",
				nodeType: "image",
				title: "角色参考",
				status: "ready",
				previewUrl: "vibe://app/assets/asset-1",
				textContent: "不要写入素材正文",
				prompt: "不要写入节点提示词",
			}],
			selectedSkillId: "shot-storyboard",
		} as unknown as DesktopAgentMessageMetadata;
		const userMessage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "根据这张参考图继续创作" }],
			timestamp: Date.now(),
		};
		const messageId = await store.appendMessage(session.id, userMessage, metadata);
		const piSession = await store.openSession(session.id);
		await piSession.appendEntry({
			type: "compaction",
			id: randomUUID(),
			summary: "用户正在基于参考图继续创作。",
			retainedTail: [userMessage],
			tokensBefore: 120,
		}, "main");
		expect(JSON.stringify((await store.buildContext(session.id)).messages)).toContain("node-1");
		const storedSession = await store.openSession(session.id);
		const sessionPath = (await storedSession.getMetadata()).path;
		const rawJsonl = await readFile(sessionPath, "utf8");

		expect(rawJsonl).toContain(messageId);
		expect(rawJsonl).toContain("vibe://app/assets/asset-1");
		expect(rawJsonl).not.toContain("不要写入素材正文");
		expect(rawJsonl).not.toContain("不要写入节点提示词");

		await closeStore(store);
		const reopened = new DesktopAgentSessionStore(
			"f382c607-b2c1-41d9-9703-8bd84ae84c29",
			projectDirectory,
			sessionsDirectory,
		);
		openStores.push(reopened);
		const restored = await reopened.listMessages(session.id);
		expect(restored).toHaveLength(2);
		const restoredUserMessage = restored.find((entry) => entry.message.role === "user");
		expect(restoredUserMessage).toEqual({
			messageId,
			message: expect.objectContaining({ role: "user" }),
			metadata: {
				selectedNodeIds: ["node-1"],
				nodeReferences: [{
					nodeId: "node-1",
					nodeType: "image",
					title: "角色参考",
					status: "ready",
					previewUrl: "vibe://app/assets/asset-1",
				}],
				selectedSkillId: "shot-storyboard",
			},
		});
	});

	it("appends durable compaction after long history and rebuilds missing or corrupt optional checkpoints", async () => {
		const { projectDirectory, sessionsDirectory, store } = await createStore();
		const session = await store.createSession("长会话压缩");
		let lastUser: AgentMessage | undefined;
		let lastToolAssistant: AgentMessage | undefined;
		let lastToolResult: AgentMessage | undefined;
		for (let index = 0; index < 50; index += 1) {
			lastUser = {
				role: "user",
				content: [{ type: "text", text: `历史消息 ${index}` }],
				timestamp: 1_790_000_000_000 + index * 3,
			};
			await store.appendMessage(session.id, {
				...lastUser,
			});
			lastToolAssistant = {
				role: "assistant",
				content: [{ type: "toolCall", id: `call-${index}`, name: "read_canvas", arguments: {} }],
				api: "openai-completions",
				provider: "openai",
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
				timestamp: 1_790_000_000_001 + index * 3,
			};
			await store.appendMessage(session.id, lastToolAssistant);
			lastToolResult = {
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "read_canvas",
				content: [{ type: "text", text: index === 49 ? "读取到了当前画布状态" : `画布状态 ${index}` }],
				isError: false,
				timestamp: 1_790_000_000_002 + index * 3,
			};
			await store.appendMessage(session.id, lastToolResult);
		}

		await expect(
			store.appendCompaction(session.id, {
				summary: "Compacted 52 messages",
				retainLastMessages: 1,
				tokensBefore: 12_000,
			}),
		).rejects.toThrow("AGENT_COMPACTION_SUMMARY_REQUIRED");
		const summary = "用户正在整理画布方案；最后一次画布读取已经返回当前状态。";
		const compactedContext = await store.appendCompaction(session.id, {
			summary,
			retainLastMessages: 1,
			tokensBefore: 12_000,
		});
		expect(compactedContext.messages).toHaveLength(4);
		expect(compactedContext.messages[0]).toEqual(expect.objectContaining({ role: "compactionSummary", summary }));
		expect(compactedContext.messages[1]).toEqual(lastUser);
		expect(compactedContext.messages.slice(2)).toEqual([lastToolAssistant, lastToolResult]);
		expect(desktopCompactionSummary(compactedContext)).toBe(summary);
		expect(await store.listTranscriptMessages(session.id)).toHaveLength(150);

		const storedSession = await store.openSession(session.id);
		const sessionPath = (await storedSession.getMetadata()).path;
		const checkpointPath = `${sessionPath}.checkpoint.json`;
		const rawJsonl = await readFile(sessionPath, "utf8");
		expect(rawJsonl).toContain("历史消息 0");
		expect(rawJsonl).toContain("历史消息 49");
		expect(rawJsonl).toContain("读取到了当前画布状态");
		expect((await storedSession.findEntries({ type: "message" })).length).toBe(150);
		expect(JSON.parse(await readFile(checkpointPath, "utf8"))).toEqual(
			expect.objectContaining({ schemaVersion: 1, sessionId: session.id, summary }),
		);

		await closeStore(store);
		const reopened = new DesktopAgentSessionStore(
			"f382c607-b2c1-41d9-9703-8bd84ae84c29",
			projectDirectory,
			sessionsDirectory,
		);
		openStores.push(reopened);
		await rm(checkpointPath, { force: true });
		const restoredWithoutCheckpoint = await reopened.buildContext(session.id);
		expect(restoredWithoutCheckpoint.messages).toEqual(compactedContext.messages);
		expect(await reopened.listTranscriptMessages(session.id)).toHaveLength(150);
		expect(JSON.parse(await readFile(checkpointPath, "utf8"))).toEqual(
			expect.objectContaining({ schemaVersion: 1, sessionId: session.id, summary }),
		);

		await writeFile(checkpointPath, "{not valid json");
		const restoredWithCorruptCheckpoint = await reopened.buildContext(session.id);
		expect(restoredWithCorruptCheckpoint.messages).toEqual(compactedContext.messages);
		expect(JSON.parse(await readFile(checkpointPath, "utf8"))).toEqual(
			expect.objectContaining({ schemaVersion: 1, sessionId: session.id, summary }),
		);
	});

	it("stores only approved local preview identifiers and enforces the reference count before writing", async () => {
		const { store } = await createStore();
		const session = await store.createSession();
		const userMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "继续" }],
			timestamp: Date.now(),
		};

		await store.appendMessage(session.id, userMessage, {
			selectedNodeIds: ["node-1"],
			nodeReferences: [{
				nodeId: "node-1",
				nodeType: "image",
				title: "云端链接不保留",
				status: "ready",
				previewUrl: "https://cdn.example.test/image.png?signature=secret",
			}],
		});
		const stored = await store.listMessages(session.id);
		expect(stored[0]?.metadata?.nodeReferences[0]).not.toHaveProperty("previewUrl");
		const storedSession = await store.openSession(session.id);
		const sessionPath = (await storedSession.getMetadata()).path;
		expect(await readFile(sessionPath, "utf8")).not.toContain("signature=secret");

		const tooManyReferences = Array.from({ length: 9 }, (_, index) => ({
			nodeId: `node-${index}`,
			nodeType: "image",
			title: `参考 ${index}`,
			status: "ready",
		}));
		await expect(store.appendMessage(session.id, userMessage, {
			selectedNodeIds: tooManyReferences.map((reference) => reference.nodeId),
			nodeReferences: tooManyReferences,
		} as DesktopAgentMessageMetadata)).rejects.toThrow("AGENT_REFERENCE_METADATA_INVALID");
		expect(await store.listMessages(session.id)).toHaveLength(1);
	});
});
