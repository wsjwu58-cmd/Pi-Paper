import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDesktopAgentStores } from "../src/desktop/agent-stores.ts";
import { DesktopProjectMemory } from "../src/desktop/project-memory.ts";
import { DesktopScopedMemoryStore, desktopCandidateScope } from "../src/desktop/scoped-memory.ts";

const { createLocalProjectStore } = createRequire(import.meta.url)(
	"../../../../pi-paper-desktop/src/project-store.cjs",
);

it("maps project, canvas and general preference hints to distinct desktop scopes", () => {
	expect(desktopCandidateScope("记住这个项目的主角姓林", "long_term")).toBe("project");
	expect(desktopCandidateScope("remember this project uses warm colors", "canvas")).toBe("project");
	expect(desktopCandidateScope("记住这个画布的布局", "canvas")).toBe("canvas");
	expect(desktopCandidateScope("我偏好暖色调", "long_term")).toBe("global");
});

let temporaryRoot: string;
let localCore: ReturnType<typeof createLocalProjectStore>;
let agentStores: Awaited<ReturnType<typeof openDesktopAgentStores>>;
let projectDirectory: string;
let projectId: string;
let memory: DesktopProjectMemory;
let scoped: DesktopScopedMemoryStore;

describe("desktop scoped memory", () => {
	beforeEach(async () => {
		temporaryRoot = await mkdtemp(join(tmpdir(), "vibepaper-scoped-memory-"));
		localCore = createLocalProjectStore();
		const created = await localCore.createProject(temporaryRoot, "Scoped memory");
		projectDirectory = created.directory;
		projectId = created.project.projectId;
		const userDataDirectory = join(temporaryRoot, "user-data");
		await mkdir(userDataDirectory, { recursive: true });
		agentStores = await openDesktopAgentStores(projectDirectory);
		memory = new DesktopProjectMemory(projectDirectory, projectId, { userDataDirectory });
		await memory.initialize();
		scoped = new DesktopScopedMemoryStore(
			projectDirectory,
			projectId,
			agentStores.sessions,
			memory,
			agentStores.control,
		);
		await scoped.initialize();
	});

	afterEach(async () => {
		await agentStores?.close();
		await localCore?.close();
		await rm(temporaryRoot, { recursive: true, force: true });
	});

	it("isolates session memories and requires an existing session id", async () => {
		const firstSession = await agentStores.sessions.createSession("第一会话");
		const secondSession = await agentStores.sessions.createSession("第二会话");
		const saved = await scoped.create("session", "继续当前会话的分镜安排", firstSession.id);

		expect(saved.scope).toBe("session");
		expect(saved.sessionId).toBe(firstSession.id);
		expect((await scoped.list("session", firstSession.id)).items.map((item) => item.id)).toContain(saved.id);
		expect(await scoped.list("session", secondSession.id)).toMatchObject({ items: [] });
		await expect(scoped.list("session")).rejects.toThrow("AGENT_MEMORY_SESSION_REQUIRED");
		await expect(scoped.update("session", saved.id, "跨会话修改", secondSession.id)).rejects.toThrow("NOT_FOUND");
	});

	it("keeps canvas and daily entries separate from project preferences and expires daily records", async () => {
		const session = await agentStores.sessions.createSession("当日任务");
		const canvas = await scoped.create("canvas", "画面保留柔和的纸张质感");
		const project = await scoped.create("project", "项目分镜统一使用 16:9");
		const daily = await scoped.create("daily", "今天先完成角色设定", session.id);

		expect((await scoped.list("canvas")).items.map((item) => item.id)).toContain(canvas.id);
		expect((await scoped.list("project")).items.map((item) => item.id)).toContain(project.id);
		expect((await scoped.list("daily")).items.map((item) => item.id)).toContain(daily.id);
		expect(daily.sessionId).toBeUndefined();
		expect(daily.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u);
		expect((await scoped.list("project")).items.map((item) => item.id)).not.toContain(canvas.id);

		const projectMetadata = JSON.parse(
			await readFile(join(projectDirectory, ".vibepaper", "project.json"), "utf8"),
		) as { canvasId: string };
		const canvasFile = join(
			projectDirectory,
			".vibepaper",
			"agent",
			"memory",
			"canvas",
			`${await sha256(projectMetadata.canvasId)}.md`,
		);
		expect(await readFile(canvasFile, "utf8")).toContain("柔和的纸张质感");
		const dailyFiles = await readdir(join(projectDirectory, ".vibepaper", "agent", "daily-memory"));
		expect(dailyFiles).toContain(`${new Date().toISOString().slice(0, 10)}.md`);
	});

	it("persists reviewable candidates in the control database and writes only after acceptance", async () => {
		const candidate = await scoped.proposeCandidate({
			scope: "global",
			content: "默认使用低饱和暖色",
			sourceEventSeq: 4,
		});
		const duplicate = await scoped.proposeCandidate({
			scope: "global",
			content: "默认使用低饱和暖色",
			sourceEventSeq: 5,
		});
		expect(duplicate.id).toBe(candidate.id);
		expect(candidate.userId).toBe(projectId);
		expect(candidate.status).toBe("pending");
		expect((await scoped.list("global")).items).toEqual([]);
		expect((await scoped.listCandidates()).items.map((item) => item.id)).toEqual([candidate.id]);

		const accepted = await scoped.reviewCandidate(candidate.id, "accept");
		expect(accepted.status).toBe("accepted");
		expect(accepted.item).toMatchObject({ scope: "global", content: candidate.content });
		expect(accepted.item).toMatchObject({
			confidence: candidate.confidence,
			source: candidate.source,
			memoryType: candidate.memoryType,
		});
		expect((await scoped.list("global")).items).toMatchObject([{ content: candidate.content }]);
		expect((await scoped.listCandidates()).items).toEqual([]);
		await expect(scoped.reviewCandidate(candidate.id, "accept")).rejects.toThrow("NOT_FOUND");
	});

	it("deduplicates an accepted memory when a crash happens before candidate status is saved", async () => {
		let failNextStatusUpdate = true;
		const candidates = {
			listPendingDesktopMemoryCandidates: agentStores.control.listPendingDesktopMemoryCandidates.bind(
				agentStores.control,
			),
			findPendingDesktopMemoryCandidate: agentStores.control.findPendingDesktopMemoryCandidate.bind(
				agentStores.control,
			),
			getDesktopMemoryCandidate: agentStores.control.getDesktopMemoryCandidate.bind(agentStores.control),
			saveDesktopMemoryCandidate: agentStores.control.saveDesktopMemoryCandidate.bind(agentStores.control),
			updateDesktopMemoryCandidateStatus: (
				...args: Parameters<typeof agentStores.control.updateDesktopMemoryCandidateStatus>
			) => {
				if (failNextStatusUpdate) {
					failNextStatusUpdate = false;
					return false;
				}
				return agentStores.control.updateDesktopMemoryCandidateStatus(...args);
			},
		};
		const retryable = new DesktopScopedMemoryStore(
			projectDirectory,
			projectId,
			agentStores.sessions,
			memory,
			candidates,
		);
		await retryable.initialize();
		const candidate = await retryable.proposeCandidate({ scope: "global", content: "默认使用克制的暖色" });

		await expect(retryable.reviewCandidate(candidate.id, "accept")).rejects.toThrow("NOT_FOUND");
		expect((await retryable.list("global")).items).toHaveLength(1);
		await expect(retryable.reviewCandidate(candidate.id, "accept")).resolves.toMatchObject({ status: "accepted" });
		expect((await retryable.list("global")).items).toHaveLength(1);
	});

	it("restores scoped memory and pending candidates with the restored project identity", async () => {
		const session = await agentStores.sessions.createSession("备份记忆");
		const saved = await scoped.create("session", "继续整理人物关系", session.id);
		const pending = await scoped.proposeCandidate({
			sessionId: session.id,
			scope: "session",
			content: "接下来优先补全配角动机",
		});
		await agentStores.close();

		const backup = await localCore.backupProject(temporaryRoot, projectId);
		const restored = await localCore.restoreBackup(backup.directory, temporaryRoot);
		expect(restored.project.projectId).not.toBe(projectId);
		projectDirectory = restored.directory;
		projectId = restored.project.projectId;
		agentStores = await openDesktopAgentStores(projectDirectory);
		memory = new DesktopProjectMemory(projectDirectory, projectId, {
			userDataDirectory: join(temporaryRoot, "user-data"),
		});
		await memory.initialize();
		scoped = new DesktopScopedMemoryStore(
			projectDirectory,
			projectId,
			agentStores.sessions,
			memory,
			agentStores.control,
		);
		await scoped.initialize();

		expect(await scoped.list("session", session.id)).toMatchObject({
			items: [{ id: saved.id, content: saved.content, userId: projectId, sessionId: session.id }],
		});
		expect(await scoped.listCandidates()).toMatchObject({
			items: [{ id: pending.id, content: pending.content, userId: projectId, sessionId: session.id }],
		});
	});

	it("rejects traversal session ids instead of interpreting them as filesystem paths", async () => {
		await expect(scoped.list("session", "../outside")).rejects.toThrow("AGENT_MEMORY_SESSION_REQUIRED");
	});
});

async function sha256(value: string): Promise<string> {
	const { createHash } = await import("node:crypto");
	return createHash("sha256").update(value).digest("hex");
}
