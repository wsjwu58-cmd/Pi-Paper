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
		for (let index = 0; index < 50; index += 1) {
			await store.appendMessage(session.id, {
				role: "user",
				content: [{ type: "text", text: `历史消息 ${index}` }],
				timestamp: 1_790_000_000_000 + index,
			});
		}
		const toolAssistant: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-last", name: "read_canvas", arguments: {} }],
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
			timestamp: 1_790_000_000_050,
		};
		const toolResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "call-last",
			toolName: "read_canvas",
			content: [{ type: "text", text: "读取到了当前画布状态" }],
			isError: false,
			timestamp: 1_790_000_000_051,
		};
		await store.appendMessage(session.id, toolAssistant);
		await store.appendMessage(session.id, toolResult);

		await expect(
			store.appendCompaction(session.id, {
				summary: "Compacted 52 messages",
				retainLastMessages: 1,
				tokensBefore: 4_100,
			}),
		).rejects.toThrow("AGENT_COMPACTION_SUMMARY_REQUIRED");
		const summary = "用户正在整理画布方案；最后一次画布读取已经返回当前状态。";
		const compactedContext = await store.appendCompaction(session.id, {
			summary,
			retainLastMessages: 1,
			tokensBefore: 4_100,
		});
		expect(compactedContext.messages).toHaveLength(3);
		expect(compactedContext.messages[0]).toEqual(expect.objectContaining({ role: "compactionSummary", summary }));
		expect(compactedContext.messages.slice(1)).toEqual([toolAssistant, toolResult]);
		expect(desktopCompactionSummary(compactedContext)).toBe(summary);
		expect(await store.listTranscriptMessages(session.id)).toHaveLength(52);

		const storedSession = await store.openSession(session.id);
		const sessionPath = (await storedSession.getMetadata()).path;
		const checkpointPath = `${sessionPath}.checkpoint.json`;
		const rawJsonl = await readFile(sessionPath, "utf8");
		expect(rawJsonl).toContain("历史消息 0");
		expect(rawJsonl).toContain("历史消息 49");
		expect(rawJsonl).toContain("读取到了当前画布状态");
		expect((await storedSession.findEntries({ type: "message" })).length).toBe(52);
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
		expect(await reopened.listTranscriptMessages(session.id)).toHaveLength(52);
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
