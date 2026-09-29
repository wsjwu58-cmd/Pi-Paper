import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import {
	DesktopAgentSessionStore,
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
