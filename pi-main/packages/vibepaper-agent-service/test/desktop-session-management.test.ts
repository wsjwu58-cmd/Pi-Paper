import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionRunService } from "../src/application/session-run-service.ts";
import { DesktopAgentControlStore } from "../src/desktop/control-store.ts";
import { DesktopAgentSessionStore, LEGACY_AGENT_MODEL_BINDING_ID } from "../src/desktop/session-store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("desktop Agent session management", () => {
	it("renames, archives, copies an empty session, and soft deletes across restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "vibepaper-agent-session-management-"));
		temporaryDirectories.push(directory);
		const projectDirectory = join(directory, "project");
		const sessionsDirectory = join(directory, "sessions");
		const controlPath = join(directory, "control.sqlite");
		await Promise.all([mkdir(projectDirectory), mkdir(sessionsDirectory)]);
		const projectId = "session-management-project";
		let control = new DesktopAgentControlStore(controlPath);
		let sessions = new DesktopAgentSessionStore(projectId, projectDirectory, sessionsDirectory, control);
		try {
			const original = await sessions.createSession("原会话", "canvas-local-1");
			expect((await sessions.getSession(original.id)).agentModelId).toBe(LEGACY_AGENT_MODEL_BINDING_ID);
			await sessions.setAgentModelBinding(original.id, "target-deepseek-v4-1-flash");
			await expect(sessions.setAgentModelBinding(original.id, "not a binding")).rejects.toThrow(
				"AGENT_MODEL_INVALID",
			);
			await sessions.appendMessage(original.id, {
				role: "user",
				content: [{ type: "text", text: "这条记录不应复制。" }],
				timestamp: Date.now(),
			});

			const copied = await sessions.copySession(original.id);
			expect(copied).toMatchObject({
				title: "原会话 副本",
				agentModelId: "target-deepseek-v4-1-flash",
				status: "active",
				canvasId: "canvas-local-1",
				copiedFrom: original.id,
			});
			const copiedEntries = await (await sessions.openSession(copied.sessionId)).findEntries({
				order: "oldestFirst",
			});
			expect(copiedEntries.some((entry) => entry.type === "message")).toBe(false);
			expect(JSON.stringify(copiedEntries)).not.toContain("test-only-api-key");

			await expect(
				sessions.updateSession(original.id, { title: "不能部分改名", status: "unknown" } as never),
			).rejects.toThrow("SESSION_STATUS_INVALID");
			await expect(sessions.updateSession(original.id, { title: 42, status: "active" } as never)).rejects.toThrow(
				"SESSION_TITLE_INVALID",
			);
			expect((await sessions.getSession(original.id)).title).toBe("原会话");
			await expect(sessions.listAgentSessions({ status: "deleted" } as never)).rejects.toThrow(
				"SESSION_STATUS_INVALID",
			);

			const runs = new SessionRunService(control);
			const run = await runs.startRun({ sessionId: original.id, idempotencyKey: "archive-stops-run" });
			await runs.setStatus(run.runId, "running");
			const archived = await sessions.updateSession(original.id, { status: "archived" });
			expect(archived.status).toBe("archived");
			expect(control.findById(run.runId)?.status).toBe("aborted");
			expect(
				(await sessions.listAgentSessions({ status: "active" })).some((item) => item.sessionId === original.id),
			).toBe(false);
			expect(
				(await sessions.listAgentSessions({ status: "archived" })).some((item) => item.sessionId === original.id),
			).toBe(true);
			await expect(sessions.openSession(original.id)).resolves.toBeDefined();
			await expect(
				sessions.appendMessage(original.id, { role: "user", content: "禁止写入", timestamp: Date.now() }),
			).rejects.toThrow("SESSION_ARCHIVED");

			await sessions.close();
			control.close();
			control = new DesktopAgentControlStore(controlPath);
			sessions = new DesktopAgentSessionStore(projectId, projectDirectory, sessionsDirectory, control);
			expect((await sessions.getSession(original.id)).status).toBe("archived");
			expect((await sessions.getSession(original.id)).agentModelId).toBe("target-deepseek-v4-1-flash");
			expect(await sessions.getAgentModelBinding(copied.sessionId)).toBe("target-deepseek-v4-1-flash");
			expect(await sessions.hasSession(original.id)).toBe(true);

			await sessions.deleteSession(original.id);
			expect(await sessions.hasSession(original.id)).toBe(false);
			expect(
				(await sessions.listAgentSessions({ status: "all" })).some((item) => item.sessionId === original.id),
			).toBe(false);
			await expect(sessions.getSession(original.id)).rejects.toThrow("SESSION_NOT_FOUND");
			await expect(sessions.openSession(original.id)).rejects.toThrow("SESSION_NOT_FOUND");
			await expect(sessions.updateSession(original.id, { status: "active" })).rejects.toThrow("SESSION_NOT_FOUND");
		} finally {
			await sessions.close();
			control.close();
		}
	});
});
