import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DesktopProjectMemory } from "../src/desktop/project-memory.ts";
import { openDesktopAgentStores } from "../src/desktop/agent-stores.ts";
import { SessionRunService } from "../src/application/session-run-service.ts";
import { createDramaAgent } from "../src/pi/drama-agent.ts";
const { createLocalProjectStore } = createRequire(import.meta.url)("../../../../vibepaper-desktop/src/project-store.cjs");

let temporaryRoot: string;

describe("desktop project memory", () => {
	beforeEach(async () => {
		temporaryRoot = await mkdtemp(join(tmpdir(), "vibepaper-project-memory-"));
	});

	it("retains preference text containing braces and comment delimiters after reopening", async () => {
		const memory = await createMemory("markdown-delimiter", "project-delimiter");
		const content = "偏好显示示例 {色调} --> 暖色绘本";
		await memory.write(content, "请记住这个偏好");
		expect((await memory.list())[0]?.content).toBe(content);
	});

	it("exposes memory tools through the original desktop Agent while keeping Web and read-only profiles bounded", async () => {
		const memory = await createMemory("profile-tools", "project-profile");
		const tools = memory.createTools("请记住这个项目的偏好");
		const options = { profile: "canvas-general" as const, streamFn: (() => undefined) as never, desktopMemoryTools: tools };
		expect(createDramaAgent(undefined, options).state.tools.map((tool) => tool.name)).not.toContain("remember_project_preference");
		expect(createDramaAgent(undefined, { ...options, desktopMode: true }).state.tools.map((tool) => tool.name))
			.toContain("remember_project_preference");
		expect(createDramaAgent(undefined, { ...options, desktopMode: true, profile: "audit-readonly" }).state.tools.map((tool) => tool.name))
			.toEqual(["read_project_memory"]);
	});

	afterEach(async () => {
		await rm(temporaryRoot, { recursive: true, force: true });
	});

	it("backs up the current Agent control schema and rebinds project memory in a restored copy", async () => {
		const core = createLocalProjectStore();
		let agent: Awaited<ReturnType<typeof openDesktopAgentStores>> | undefined;
		try {
			const opened = await core.createProject(temporaryRoot, "Memory Backup");
			agent = await openDesktopAgentStores(opened.directory);
			const session = await agent.sessions.createSession("记忆恢复");
			await new SessionRunService(agent.control).startRun({ sessionId: session.id, idempotencyKey: "interrupted-before-backup" });
			const memory = new DesktopProjectMemory(opened.directory, opened.project.projectId);
			await memory.initialize();
			const saved = await memory.write("这个项目使用暖色绘本风格", "请记住这个项目偏好");
			await agent.close();
			agent = undefined;
			const backup = await core.backupProject(temporaryRoot, opened.project.projectId);
			const restored = await core.restoreBackup(backup.directory, temporaryRoot);
			expect(restored.project.projectId).not.toBe(opened.project.projectId);
			const restoredMemory = new DesktopProjectMemory(restored.directory, restored.project.projectId);
			await restoredMemory.initialize();
			expect(await restoredMemory.list()).toEqual([expect.objectContaining({
				id: saved.id, content: saved.content, userId: restored.project.projectId,
			})]);
			expect(await memory.list()).toEqual([expect.objectContaining({ userId: opened.project.projectId })]);
			agent = await openDesktopAgentStores(restored.directory);
			expect((await agent.sessions.listSessions()).map((item) => item.id)).toContain(session.id);
			expect(agent.control.findByIdempotency(session.id, "interrupted-before-backup")?.status).toBe("aborted");
		} finally {
			await agent?.close();
			await core.close();
		}
	});

	it("rejects writes unless the current user clearly asks to save memory", async () => {
		const memory = await createMemory("ordinary-request", "project-ordinary");

		await expect(memory.write("项目喜欢暖色调", "这个项目喜欢暖色调")).rejects.toThrow(
			"MEMORY_EXPLICIT_REQUEST_REQUIRED",
		);
		await expect(memory.write("项目喜欢暖色调", "请不要记住我喜欢暖色调")).rejects.toThrow(
			"MEMORY_EXPLICIT_REQUEST_REQUIRED",
		);
		expect(await memory.list()).toHaveLength(0);
	});

	it("supports create, read, edit, and delete through the project memory service", async () => {
		const memory = await createMemory("crud", "project-crud");
		const created = await memory.write("偏好使用冷色调", "请记住这个项目偏好");

		expect((await memory.read("冷色调")).map((record) => record.id)).toContain(created.id);

		const updated = await memory.edit(created.id, "偏好使用低饱和冷色调", "请修改这项项目记忆");
		expect(updated.id).toBe(created.id);
		expect(updated.content).toBe("偏好使用低饱和冷色调");
		expect(updated.version).toBeGreaterThan(created.version);
		expect((await memory.read("低饱和")).map((record) => record.id)).toContain(created.id);

		await memory.remove(updated.id, "请删除这项项目记忆");
		expect(await memory.list()).toEqual([]);
		expect(await memory.read()).toEqual([]);
	});

	it("keeps global preferences in user data and exports them separately from project backup scope", async () => {
		const firstDirectory = await createProject("global-memory-a", "project-global-a");
		const first = new DesktopProjectMemory(firstDirectory, "project-global-a", { userDataDirectory: temporaryRoot });
		await first.initialize();
		const projectPreference = await first.createManaged("此项目使用复古胶片质感", "project");
		const globalPreference = await first.createManaged("默认优先使用暖色调", "global");

		const exported = await first.exportManaged();
		expect(exported.map((entry) => entry.scope)).toEqual(["project", "global"]);
		expect(exported.map((entry) => entry.record.id)).toEqual([projectPreference.id, globalPreference.id]);

		const secondDirectory = await createProject("global-memory-b", "project-global-b");
		const reopened = new DesktopProjectMemory(secondDirectory, "project-global-b", { userDataDirectory: temporaryRoot });
		await reopened.initialize();
		expect(await reopened.listManaged("project")).toEqual([]);
		expect(await reopened.listManaged("global")).toEqual([expect.objectContaining({
			id: globalPreference.id,
			userId: "vibepaper-local-user-v1",
			content: "默认优先使用暖色调",
		})]);

		await reopened.editManaged(globalPreference.id, "全局默认优先使用暖色绘本风格", "global");
		expect((await first.listManaged("global"))[0]?.content).toBe("全局默认优先使用暖色绘本风格");
		await reopened.removeManaged(globalPreference.id, "global");
		expect(await first.listManaged("global")).toEqual([]);
		expect(await first.listManaged("project")).toEqual([expect.objectContaining({ id: projectPreference.id })]);
	});

	it("makes memory tools available according to the user's explicit request", async () => {
		const memory = await createMemory("tools", "project-tools");
		const names = (userText: string) => memory.createTools(userText).map((tool) => tool.name);

		expect(names("这个项目适合暖色调")).toEqual(["read_project_memory"]);
		expect(names("请不要记住暖色调偏好")).toEqual(["read_project_memory"]);
		expect(names("请记住我偏好暖色调")).toContain("remember_project_preference");
		expect(names("请修改项目记忆")).toContain("edit_project_memory");
		expect(names("请删除项目记忆")).toContain("delete_project_memory");
	});

	it("deduplicates repeated preferences idempotently", async () => {
		const memory = await createMemory("dedupe", "project-dedupe");
		const first = await memory.write("偏好使用蓝色", "请记住我的偏好");
		const repeated = await memory.write("  偏好使用蓝色  ", "请记住我的偏好");

		expect(repeated.id).toBe(first.id);
		expect(await memory.list()).toHaveLength(1);
	});

	it("keeps saved memory available after reopening the project", async () => {
		const projectDirectory = await createProject("restart", "project-restart");
		const firstSession = new DesktopProjectMemory(projectDirectory, "project-restart");
		await firstSession.initialize();
		const saved = await firstSession.write("画面比例优先使用十六比九", "请记住这个项目偏好");

		const reopenedSession = new DesktopProjectMemory(projectDirectory, "project-restart");
		await reopenedSession.initialize();
		const restored = await reopenedSession.list();

		expect(restored).toHaveLength(1);
		expect(restored[0]).toMatchObject({ id: saved.id, content: saved.content, userId: "project-restart" });
		expect((await reopenedSession.read("十六比九")).map((record) => record.id)).toContain(saved.id);
	});

	it("isolates records and project identity between project directories", async () => {
		const first = await createMemory("isolation-a", "project-a");
		const second = await createMemory("isolation-b", "project-b");
		await first.write("甲项目的专属画面规则", "请记住这个项目规则");
		await second.write("乙项目的专属画面规则", "请记住这个项目规则");

		expect((await first.list()).map((record) => record.content)).toEqual(["甲项目的专属画面规则"]);
		expect((await second.list()).map((record) => record.content)).toEqual(["乙项目的专属画面规则"]);
		expect(await first.read("乙")).toEqual([]);
		expect(await second.read("甲")).toEqual([]);

		await expect(new DesktopProjectMemory(join(temporaryRoot, "isolation-a"), "project-b").initialize()).rejects.toThrow(
			"PERMISSION_DENIED",
		);
	});

	it("rejects sensitive key and credential patterns", async () => {
		const memory = await createMemory("sensitive", "project-sensitive");
		const fakeCredentialValues = [
			"api_key=FAKE_API_KEY_FOR_TESTS",
			"password: FAKE_PASSWORD_FOR_TESTS",
			"secret=FAKE_SECRET_FOR_TESTS",
			"token: FAKE_TOKEN_FOR_TESTS",
		];

		for (const content of fakeCredentialValues) {
			await expect(memory.write(content, "请记住这个项目偏好")).rejects.toThrow("SENSITIVE_MEMORY_REJECTED");
		}
		expect(await memory.list()).toHaveLength(0);
	});

	it("preserves every distinct record when writes run concurrently", async () => {
		const memory = await createMemory("concurrent", "project-concurrent");
		const contents = Array.from({ length: 10 }, (_, index) => `并发保存的项目规则 ${index + 1}`);

		await Promise.all(contents.map((content) => memory.write(content, "请记住这些项目规则")));

		const saved = await memory.list();
		expect(saved).toHaveLength(contents.length);
		expect(new Set(saved.map((record) => record.content))).toEqual(new Set(contents));
	});
});

async function createMemory(directoryName: string, projectId: string): Promise<DesktopProjectMemory> {
	const projectDirectory = await createProject(directoryName, projectId);
	const memory = new DesktopProjectMemory(projectDirectory, projectId);
	await memory.initialize();
	return memory;
}

async function createProject(directoryName: string, projectId: string): Promise<string> {
	const projectDirectory = join(temporaryRoot, directoryName);
	const agentDirectory = join(projectDirectory, ".vibepaper", "agent");
	await mkdir(agentDirectory, { recursive: true });
	await writeFile(join(projectDirectory, ".vibepaper", "project.json"), JSON.stringify({ projectId }), "utf8");
	return projectDirectory;
}
