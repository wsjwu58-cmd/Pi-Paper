import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { DesktopSessionFragments } from "../src/desktop/session-fragments.ts";
import { DesktopAgentSessionStore } from "../src/desktop/session-store.ts";

const require = createRequire(import.meta.url);
const { buildAgentUsage } = require("../../../../vibepaper-desktop/src/agent-usage.cjs") as {
	buildAgentUsage: (entries: unknown[], sessionId: string) => {
		tokenTotal: number;
		modelCallCount: number;
		modelUsage: Record<string, number>;
		modelCalls: Record<string, number>;
	};
};

const temporaryDirectories: string[] = [];
const openStores: DesktopAgentSessionStore[] = [];

async function createProject(projectId = randomUUID(), canvasId = randomUUID()) {
	const directory = await mkdtemp(join(tmpdir(), "vibepaper-agent-session-fragments-"));
	temporaryDirectories.push(directory);
	const projectDirectory = join(directory, "project");
	const dataDirectory = join(projectDirectory, ".vibepaper");
	const agentDirectory = join(dataDirectory, "agent");
	const sessionsDirectory = join(agentDirectory, "sessions");
	await mkdir(sessionsDirectory, { recursive: true });
	await writeFile(join(dataDirectory, "project.json"), JSON.stringify({ schemaVersion: 1, projectId, canvasId }));
	const store = new DesktopAgentSessionStore(projectId, projectDirectory, sessionsDirectory);
	openStores.push(store);
	const fragments = new DesktopSessionFragments(projectDirectory, projectId, store);
	await fragments.initialize();
	return { directory, projectDirectory, sessionsDirectory, projectId, canvasId, store, fragments };
}

async function closeStore(store: DesktopAgentSessionStore): Promise<void> {
	const index = openStores.indexOf(store);
	if (index >= 0) openStores.splice(index, 1);
	await store.close();
}

function assistantMessage(content: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: content }, {
			type: "toolCall",
			id: "private-tool-call-id",
			name: "create_node",
			arguments: { prompt: "must not be copied" },
		}],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

afterEach(async () => {
	await Promise.all(openStores.splice(0).map((store) => store.close()));
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("desktop session fragments", () => {
	it("persists user-visible conversation text, imports a new session, and survives reopening", async () => {
		const { projectDirectory, sessionsDirectory, projectId, canvasId, store, fragments } = await createProject();
		const session = await store.createSession("原始会话");
		await store.appendMessage(session.id, {
			role: "user",
			content: [{ type: "text", text: "保留这段对话" }],
			timestamp: Date.now(),
		});
		await store.appendMessage(session.id, assistantMessage("我会继续这个方案。"));
		await store.appendMessage(session.id, {
			role: "toolResult",
			toolCallId: "private-tool-call-id",
			toolName: "create_node",
			content: [{ type: "text", text: "内部工具结果不得复制" }],
			isError: false,
			timestamp: Date.now(),
		});

		const saved = await fragments.save(session.id, "复用方案");
		const listing = await fragments.list();
		expect(listing.items).toHaveLength(1);
		expect(listing.items[0]).toMatchObject({
			id: saved.fragmentId,
			title: "复用方案",
			canvasId,
		});
		const fragmentDirectory = join(projectDirectory, ".vibepaper", "agent", "fragments");
		const fragmentPath = join(fragmentDirectory, `${saved.fragmentId}.json`);
		const rawFragment = await readFile(fragmentPath, "utf8");
		expect(rawFragment).toContain("保留这段对话");
		expect(rawFragment).toContain("我会继续这个方案。");
		expect(rawFragment).not.toContain("private-tool-call-id");
		expect(rawFragment).not.toContain("内部工具结果不得复制");

		const imported = await fragments.import(saved.fragmentId, canvasId);
		expect(imported.sessionId).not.toBe(session.id);
		const copiedMessages = await store.listTranscriptMessages(imported.sessionId);
		expect(copiedMessages.map(({ message }) => message.role)).toEqual(["user", "assistant"]);
		expect(copiedMessages.map(({ message }) => message.role === "user"
			? message.content
			: message.content.filter((item) => item.type === "text").map((item) => item.text).join("")))
			.toEqual(["保留这段对话", "我会继续这个方案。"]);
		const copiedAssistant = copiedMessages[1]?.message;
		expect(copiedAssistant).toMatchObject({
			role: "assistant",
			provider: "",
			model: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		});
		if (copiedAssistant?.role === "assistant") {
			expect(copiedAssistant.content).toEqual([{ type: "text", text: "我会继续这个方案。" }]);
		}
		const importedEntries = await (await store.openSession(imported.sessionId)).findEntries();
		const importMarkers = importedEntries.filter((entry) => entry.type === "custom"
			&& entry.customType === "vibepaper_fragment_import");
		expect(importMarkers).toHaveLength(1);
		expect(importMarkers[0]).toMatchObject({
			customType: "vibepaper_fragment_import",
			data: { messageId: copiedMessages[1]?.messageId },
		});
		expect(buildAgentUsage(importedEntries, imported.sessionId)).toMatchObject({
			tokenTotal: 0,
			modelCallCount: 0,
			modelUsage: {},
			modelCalls: {},
		});

		await closeStore(store);
		const reopened = new DesktopAgentSessionStore(projectId, projectDirectory, sessionsDirectory);
		openStores.push(reopened);
		const reopenedFragments = new DesktopSessionFragments(projectDirectory, projectId, reopened);
		await reopenedFragments.initialize();
		expect(await reopenedFragments.list()).toEqual(listing);
		const importedAfterRestart = await reopenedFragments.import(saved.fragmentId, canvasId);
		expect((await reopened.listTranscriptMessages(importedAfterRestart.sessionId)).map(({ message }) => message.role))
			.toEqual(["user", "assistant"]);
	});

	it("keeps project fragments isolated and reads copied fragments after restore identity changes", async () => {
		const source = await createProject();
		const sourceSession = await source.store.createSession("源会话");
		await source.store.appendMessage(sourceSession.id, {
			role: "user",
			content: "仅属于源项目",
			timestamp: Date.now(),
		});
		const saved = await source.fragments.save(sourceSession.id, "备份片段");

		const other = await createProject();
		await expect(other.fragments.import(saved.fragmentId)).rejects.toThrow("AGENT_SESSION_FRAGMENT_NOT_FOUND");
		expect(await other.fragments.list()).toEqual({ items: [] });

		const restoredProjectDirectory = join(source.directory, "restored-project");
		const restoredDataDirectory = join(restoredProjectDirectory, ".vibepaper");
		const restoredAgentDirectory = join(restoredDataDirectory, "agent");
		const restoredSessionsDirectory = join(restoredAgentDirectory, "sessions");
		await mkdir(restoredSessionsDirectory, { recursive: true });
		await cp(join(source.projectDirectory, ".vibepaper", "agent", "fragments"), join(restoredAgentDirectory, "fragments"), { recursive: true });
		const restoredProjectId = randomUUID();
		await writeFile(join(restoredDataDirectory, "project.json"), JSON.stringify({
			schemaVersion: 1,
			projectId: restoredProjectId,
			canvasId: source.canvasId,
		}));
		const restoredStore = new DesktopAgentSessionStore(restoredProjectId, restoredProjectDirectory, restoredSessionsDirectory);
		openStores.push(restoredStore);
		const restoredFragments = new DesktopSessionFragments(restoredProjectDirectory, restoredProjectId, restoredStore);
		await restoredFragments.initialize();
		expect(await restoredFragments.list()).toEqual(await source.fragments.list());
		const imported = await restoredFragments.import(saved.fragmentId, source.canvasId);
		expect((await restoredStore.listTranscriptMessages(imported.sessionId)).map(({ message }) => message.role))
			.toEqual(["user"]);
		const fragmentFiles = await readdir(join(restoredAgentDirectory, "fragments"));
		expect(fragmentFiles).toContain(`${saved.fragmentId}.json`);
	});

	it("rejects fragment file links and malformed payloads before import", async () => {
		const { projectDirectory, store, fragments } = await createProject();
		await expect(fragments.import("../../outside")).rejects.toThrow("AGENT_SESSION_FRAGMENT_INPUT_INVALID");
		const fragmentDirectory = join(projectDirectory, ".vibepaper", "agent", "fragments");
		const id = randomUUID();
		await writeFile(join(fragmentDirectory, `${id}.json`), JSON.stringify({ schemaVersion: 99 }));
		await expect(fragments.list()).rejects.toThrow("AGENT_SESSION_FRAGMENT_FILE_INVALID");
		const session = await store.createSession("不会伪造片段");
		expect((await store.listTranscriptMessages(session.id))).toHaveLength(0);
	});
});
