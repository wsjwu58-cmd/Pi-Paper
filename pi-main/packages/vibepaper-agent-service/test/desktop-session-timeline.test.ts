import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";

import { SessionRunService } from "../src/application/session-run-service.ts";
import { DesktopAgentControlStore } from "../src/desktop/control-store.ts";
import {
	buildDesktopLegacyMessageRunBindings,
	DesktopAgentSessionStore,
	type DesktopAgentTimelineRun,
} from "../src/desktop/session-store.ts";

const temporaryDirectories: string[] = [];
const openStores: DesktopAgentSessionStore[] = [];
const openControls: DesktopAgentControlStore[] = [];

async function createProject() {
	const directory = await mkdtemp(join(tmpdir(), "vibepaper-agent-session-timeline-"));
	temporaryDirectories.push(directory);
	const projectDirectory = join(directory, "project");
	const sessionsDirectory = join(directory, "sessions");
	await Promise.all([mkdir(projectDirectory), mkdir(sessionsDirectory)]);
	const store = new DesktopAgentSessionStore("timeline-project", projectDirectory, sessionsDirectory);
	const control = new DesktopAgentControlStore(join(directory, "control.sqlite"));
	openStores.push(store);
	openControls.push(control);
	return { directory, projectDirectory, sessionsDirectory, store, control };
}

function assistantMessage(content: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: content }],
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function timelineRun(runId: string, sessionId: string, createdAt: Date): DesktopAgentTimelineRun {
	return { runId, sessionId, createdAt: createdAt.getTime() };
}

afterEach(async () => {
	await Promise.all(openStores.splice(0).map((store) => store.close()));
	await Promise.all(openControls.splice(0).map((control) => control.close()));
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("desktop session transcript timeline", () => {
	it("persists a Run ID on each durable message and restores it after reopening", async () => {
		const { projectDirectory, sessionsDirectory, store, control } = await createProject();
		const session = await store.createSession("稳定会话归属");
		const run = await new SessionRunService(control).startRun({
			sessionId: session.id,
			idempotencyKey: "timeline-run",
		});
		const metadata = { selectedNodeIds: [], nodeReferences: [], runId: run.runId };
		await store.appendMessage(session.id, { role: "user", content: "继续", timestamp: Date.now() }, metadata);
		await store.appendMessage(session.id, assistantMessage("已经继续。"), metadata);
		const original = await store.openSession(session.id);
		const sessionPath = (await original.getMetadata()).path;
		const before = await readFile(sessionPath, "utf8");

		const index = openStores.indexOf(store);
		if (index >= 0) openStores.splice(index, 1);
		await store.close();
		const reopened = new DesktopAgentSessionStore("timeline-project", projectDirectory, sessionsDirectory);
		openStores.push(reopened);
		const transcript = await reopened.listTranscriptMessages(session.id);

		expect(transcript.map(({ metadata: saved }) => saved?.runId)).toEqual([run.runId, run.runId]);
		expect(transcript[0]?.message).toMatchObject({ role: "user", content: "继续" });
		expect(transcript[1]?.message).toMatchObject({ role: "assistant" });
		expect(await readFile(sessionPath, "utf8")).toBe(before);
	});

	it("projects legacy bindings from branch interleaving and leaves later imported messages unbound", async () => {
		const { store, control } = await createProject();
		const session = await store.createSession("旧会话结构");
		const runService = new SessionRunService(control);
		const firstRun = await runService.startRun({ sessionId: session.id, idempotencyKey: "legacy-run-one" });
		await runService.setStatus(firstRun.runId, "running");
		await store.appendMessage(session.id, { role: "user", content: "第一轮", timestamp: Date.now() });
		await store.appendMessage(session.id, assistantMessage("先说明结论。"));
		await runService.appendEvent(firstRun.runId, "thinking", { text: "thinking event" });
		await store.appendMessage(session.id, assistantMessage("然后解释原因。"));
		await runService.appendEvent(firstRun.runId, "assistant_delta", { text: "先说明结论。然后解释原因。" });
		await runService.setStatus(firstRun.runId, "completed", { text: "先说明结论。然后解释原因。" });
		await store.flushOutbox(control, session.id);

		const secondRun = await runService.startRun({ sessionId: session.id, idempotencyKey: "legacy-run-two" });
		await runService.setStatus(secondRun.runId, "running");
		await store.appendMessage(session.id, { role: "user", content: "第二轮", timestamp: Date.now() });
		await store.appendMessage(session.id, assistantMessage("第二轮回答。"));
		await runService.appendEvent(secondRun.runId, "assistant_delta", { text: "第二轮回答。" });
		await runService.setStatus(secondRun.runId, "completed", { text: "第二轮回答。" });
		await store.flushOutbox(control, session.id);
		await store.appendMessage(session.id, assistantMessage("终态后追加的旧记录。"));

		const runRows = [
			timelineRun(firstRun.runId, session.id, firstRun.createdAt),
			timelineRun(secondRun.runId, session.id, secondRun.createdAt),
		];
		const storedSession = await store.openSession(session.id);
		const entries = await storedSession.findEntriesOnBranch({
			start: (await storedSession.getLeafId())!,
			order: "oldestFirst",
		});
		const rawPath = (await storedSession.getMetadata()).path;
		const rawBeforeProjection = await readFile(rawPath, "utf8");
		const bindings = buildDesktopLegacyMessageRunBindings(entries, session.id, runRows);
		const transcript = await store.listTranscriptMessages(session.id, runRows);

		expect(
			transcript.map(({ message, metadata }) => [
				message.role,
				message.role === "user"
					? message.content
					: message.role === "assistant"
						? message.content
								.filter((item) => item.type === "text")
								.map((item) => item.text)
								.join("")
						: "",
				metadata?.runId,
			]),
		).toEqual([
			["user", "第一轮", firstRun.runId],
			["assistant", "先说明结论。", firstRun.runId],
			["assistant", "然后解释原因。", firstRun.runId],
			["user", "第二轮", secondRun.runId],
			["assistant", "第二轮回答。", secondRun.runId],
			["assistant", "终态后追加的旧记录。", undefined],
		]);
		expect(bindings.size).toBe(5);
		expect(await readFile(rawPath, "utf8")).toBe(rawBeforeProjection);

		const importedOldTimestamp = Date.now() - 86_400_000;
		await store.appendMessage(session.id, { role: "user", content: "导入的旧问题", timestamp: importedOldTimestamp });
		await store.appendMessage(session.id, assistantMessage("导入的旧回答。"));
		const rawBeforeImportedProjection = await readFile(rawPath, "utf8");
		const entriesAfterImport = await storedSession.findEntriesOnBranch({
			start: (await storedSession.getLeafId())!,
			order: "oldestFirst",
		});
		const importedBindings = buildDesktopLegacyMessageRunBindings(entriesAfterImport, session.id, runRows);
		const importedTranscript = await store.listTranscriptMessages(session.id, runRows);
		expect(importedTranscript.slice(-2).map(({ metadata }) => metadata?.runId)).toEqual([undefined, undefined]);
		expect(importedBindings.size).toBe(5);
		expect(await readFile(rawPath, "utf8")).toBe(rawBeforeImportedProjection);
	});

	it("does not link entries to a Run from another session", async () => {
		const { store } = await createProject();
		const session = await store.createSession("跨会话隔离");
		const run: DesktopAgentTimelineRun = { runId: "foreign-run", sessionId: "other-session", createdAt: Date.now() };
		await store.appendMessage(session.id, { role: "user", content: "没有 Run", timestamp: Date.now() });
		const storedSession = await store.openSession(session.id);
		const entries = await storedSession.findEntries({ order: "oldestFirst" });

		expect(buildDesktopLegacyMessageRunBindings(entries, session.id, [run])).toEqual(new Map());
	});
});
