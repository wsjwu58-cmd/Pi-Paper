import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DesktopAgentSessionStore } from "../src/desktop/session-store.ts";

const temporaryDirectories: string[] = [];
const openStores: DesktopAgentSessionStore[] = [];

async function createStore() {
	const directory = await mkdtemp(join(tmpdir(), "vibepaper-agent-session-title-"));
	temporaryDirectories.push(directory);
	const projectDirectory = join(directory, "project");
	const sessionsDirectory = join(directory, "sessions");
	await Promise.all([mkdir(projectDirectory), mkdir(sessionsDirectory)]);
	const store = new DesktopAgentSessionStore("title-recovery-project", projectDirectory, sessionsDirectory);
	openStores.push(store);
	return store;
}

afterEach(async () => {
	await Promise.all(openStores.splice(0).map((store) => store.close()));
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("desktop session title recovery", () => {
	it("recovers new and legacy placeholders from the first user's plain text only", async () => {
		const store = await createStore();
		for (const placeholder of ["新对话", "画布对话"]) {
			const session = await store.createSession(placeholder);
			await store.appendMessage(
				session.id,
				{
					role: "user",
					content: [{ type: "text", text: "  请按这个角色参考写一个短片脚本，并创建分镜。  " }],
					timestamp: Date.now(),
				},
				{
					selectedNodeIds: ["reference-node"],
					nodeReferences: [
						{
							nodeId: "reference-node",
							nodeType: "image",
							title: "不可作为标题的参考图",
							status: "ready",
						},
					],
				},
			);

			expect(await store.resolveSessionTitle(session.id)).toBe("请按这个角色参考写一个短片脚本，并创建分镜。");
			expect(await (await store.openSession(session.id)).getName()).toBe(
				"请按这个角色参考写一个短片脚本，并创建分镜。",
			);
		}
	});

	it("keeps custom titles and leaves empty sessions as 新对话", async () => {
		const store = await createStore();
		const custom = await store.createSession("对话 创作策划");
		await store.appendMessage(custom.id, {
			role: "user",
			content: [{ type: "text", text: "这段内容不得替换自定义名称" }],
			timestamp: Date.now(),
		});
		const empty = await store.createSession("新对话");

		expect(await store.resolveSessionTitle(custom.id)).toBe("对话 创作策划");
		expect(await store.resolveSessionTitle(empty.id)).toBe("新对话");
	});

	it("matches the original Web title limit of 48 characters", async () => {
		const store = await createStore();
		const session = await store.createSession("新对话");
		const content = "创".repeat(60);
		await store.appendMessage(session.id, {
			role: "user",
			content: [{ type: "text", text: content }],
			timestamp: Date.now(),
		});

		expect(await store.resolveSessionTitle(session.id)).toBe(content.slice(0, 48));
	});
});
