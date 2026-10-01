import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { DESKTOP_AGENT_CONTROL_SCHEMA_VERSION, DesktopAgentControlStore } from "./control-store.ts";
import { DesktopAgentSessionStore } from "./session-store.ts";

type ProjectMetadata = { projectId: string; schemaVersion: number };
type AgentLock = { pid: number; token: string; startedAt: string };

export type DesktopAgentStores = {
	projectId: string;
	projectDirectory: string;
	control: DesktopAgentControlStore;
	sessions: DesktopAgentSessionStore;
	close(): Promise<void>;
};

function nodeErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

async function requireDirectory(directory: string, label: string): Promise<void> {
	const info = await lstat(directory).catch(() => null);
	if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label}缺失、无效或不能是符号链接。`);
	if (relative(directory, await realpath(directory)) !== "") throw new Error(`${label}不能指向目录之外。`);
}

function decodeProjectMetadata(value: unknown): ProjectMetadata {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!("schemaVersion" in value) ||
		!("projectId" in value) ||
		typeof value.schemaVersion !== "number" ||
		value.schemaVersion !== 1 ||
		typeof value.projectId !== "string" ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value.projectId)
	) {
		throw new Error("当前目录不是有效的 VibePaper 本地项目。");
	}
	return { projectId: value.projectId, schemaVersion: value.schemaVersion };
}

function isLockRecord(value: unknown): value is AgentLock {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		"pid" in value &&
		typeof value.pid === "number" &&
		Number.isSafeInteger(value.pid) &&
		value.pid > 0 &&
		"token" in value &&
		typeof value.token === "string" &&
		value.token.length >= 16 &&
		"startedAt" in value &&
		typeof value.startedAt === "string"
	);
}

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return nodeErrorCode(error) !== "ESRCH";
	}
}

async function acquireProjectWriterLock(lockPath: string): Promise<() => Promise<void>> {
	for (let attempt = 0; attempt < 3; attempt++) {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		const lock: AgentLock = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() };
		try {
			handle = await open(lockPath, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify(lock)}\n`, "utf8");
			await handle.sync();
			let released = false;
			return async () => {
				if (released) return;
				released = true;
				await handle?.close();
				const lockInfo = await lstat(lockPath).catch(() => null);
				if (!lockInfo?.isFile() || lockInfo.isSymbolicLink()) return;
				const currentText = await readFile(lockPath, "utf8").catch(() => "");
				let current: unknown;
				try {
					current = JSON.parse(currentText);
				} catch {
					return;
				}
				if (isLockRecord(current) && current.token === lock.token) await rm(lockPath, { force: true });
			};
		} catch (error) {
			await handle?.close().catch(() => undefined);
			if (nodeErrorCode(error) !== "EEXIST") {
				const currentText = await readFile(lockPath, "utf8").catch(() => "");
				let current: unknown;
				try {
					current = JSON.parse(currentText);
				} catch {
					current = undefined;
				}
				if (isLockRecord(current) && current.token === lock.token)
					await rm(lockPath, { force: true }).catch(() => undefined);
				throw error;
			}
		}

		const info = await lstat(lockPath).catch((error: unknown) => {
			if (nodeErrorCode(error) === "ENOENT") return null;
			throw error;
		});
		if (!info) continue;
		if (!info.isFile() || info.isSymbolicLink())
			throw new Error("Agent 项目写入锁文件无效。请关闭其他 VibePaper 进程后检查该文件。");
		const currentText = await readFile(lockPath, "utf8");
		let current: unknown;
		try {
			current = JSON.parse(currentText);
		} catch {
			throw new Error("Agent 项目写入锁文件不完整。请关闭 VibePaper 并检查项目后再重试。");
		}
		if (!isLockRecord(current))
			throw new Error("Agent 项目写入锁文件格式无效。请关闭 VibePaper 并检查项目后再重试。");
		if (processIsRunning(current.pid)) throw new Error("该项目已在另一个 VibePaper Agent 进程中打开。");
		if ((await readFile(lockPath, "utf8")) !== currentText) continue;
		await rm(lockPath, { force: true });
	}
	throw new Error("无法取得该项目的 Agent 写入锁，请稍后重试。");
}

async function backupControlDatabaseBeforeUpgrade(controlPath: string, agentDirectory: string): Promise<void> {
	const sourceInfo = await lstat(controlPath).catch((error: unknown) => {
		if (nodeErrorCode(error) === "ENOENT") return null;
		throw error;
	});
	if (!sourceInfo) return;
	if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("Agent 控制数据库路径无效。");

	const source = new DatabaseSync(controlPath, { readOnly: true, timeout: 5000 });
	try {
		const versionRow = source.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
		const version = Number(versionRow?.user_version);
		if (!Number.isSafeInteger(version) || version < 1 || version >= DESKTOP_AGENT_CONTROL_SCHEMA_VERSION) return;

		const snapshotName = `control-v${version}-${randomUUID()}.pre-migration.sqlite`;
		const snapshotPath = join(agentDirectory, snapshotName);
		const existingSnapshot = await lstat(snapshotPath).catch((error: unknown) => {
			if (nodeErrorCode(error) === "ENOENT") return null;
			throw error;
		});
		if (existingSnapshot) throw new Error("Agent 控制数据库升级快照路径已存在。");

		try {
			await backup(source, snapshotPath);
			const snapshotInfo = await lstat(snapshotPath).catch(() => null);
			if (!snapshotInfo?.isFile() || snapshotInfo.isSymbolicLink())
				throw new Error("Agent 控制数据库升级快照文件无效。");
			if (relative(agentDirectory, await realpath(snapshotPath)) !== snapshotName)
				throw new Error("Agent 控制数据库升级快照路径越界。");
			await chmod(snapshotPath, 0o600).catch(() => undefined);

			const snapshot = new DatabaseSync(snapshotPath, { timeout: 5000 });
			try {
				const journalMode = snapshot.prepare("PRAGMA journal_mode = DELETE").get() as
					| { journal_mode: string }
					| undefined;
				const snapshotVersionRow = snapshot.prepare("PRAGMA user_version").get() as
					| { user_version: number }
					| undefined;
				const integrityRow = snapshot.prepare("PRAGMA integrity_check").get() as
					| { integrity_check: string }
					| undefined;
				if (
					journalMode?.journal_mode.toLowerCase() !== "delete" ||
					Number(snapshotVersionRow?.user_version) !== version ||
					integrityRow?.integrity_check !== "ok"
				) {
					throw new Error("Agent 控制数据库升级快照校验失败。");
				}
			} finally {
				snapshot.close();
			}
			for (const sidecarPath of [`${snapshotPath}-wal`, `${snapshotPath}-shm`]) {
				const sidecarInfo = await lstat(sidecarPath).catch((error: unknown) => {
					if (nodeErrorCode(error) === "ENOENT") return null;
					throw error;
				});
				if (sidecarInfo) throw new Error("Agent 控制数据库升级快照仍有 SQLite sidecar 文件。");
			}
		} catch (error) {
			await rm(snapshotPath, { force: true }).catch(() => undefined);
			await rm(`${snapshotPath}-wal`, { force: true }).catch(() => undefined);
			await rm(`${snapshotPath}-shm`, { force: true }).catch(() => undefined);
			throw error;
		}
	} finally {
		source.close();
	}
}

export async function openDesktopAgentStores(projectDirectoryInput: string): Promise<DesktopAgentStores> {
	const projectDirectory = await realpath(resolve(projectDirectoryInput));
	const dataDirectory = join(projectDirectory, ".vibepaper");
	await requireDirectory(dataDirectory, "项目数据目录");

	const metadataPath = join(dataDirectory, "project.json");
	const metadataInfo = await lstat(metadataPath).catch(() => null);
	if (!metadataInfo?.isFile() || metadataInfo.isSymbolicLink()) throw new Error("项目元数据缺失或路径无效。");
	const metadata = decodeProjectMetadata(JSON.parse(await readFile(metadataPath, "utf8")) as unknown);

	const agentDirectory = join(dataDirectory, "agent");
	await mkdir(agentDirectory, { recursive: true });
	await requireDirectory(agentDirectory, "Agent 数据目录");
	const sessionsDirectory = join(agentDirectory, "sessions");
	await mkdir(sessionsDirectory, { recursive: true });
	await requireDirectory(sessionsDirectory, "Agent 会话目录");

	const controlPath = join(agentDirectory, "control.sqlite");
	const databaseInfo = await lstat(controlPath).catch((error: unknown) => {
		if (nodeErrorCode(error) === "ENOENT") return null;
		throw error;
	});
	if (databaseInfo && (!databaseInfo.isFile() || databaseInfo.isSymbolicLink())) {
		throw new Error("Agent 控制数据库不能是符号链接或非普通文件。");
	}

	const releaseWriterLock = await acquireProjectWriterLock(join(agentDirectory, "writer.lock"));
	let control: DesktopAgentControlStore | undefined;
	let sessions: DesktopAgentSessionStore | undefined;
	try {
		await backupControlDatabaseBeforeUpgrade(controlPath, agentDirectory);
		control = new DesktopAgentControlStore(controlPath);
		sessions = new DesktopAgentSessionStore(metadata.projectId, projectDirectory, sessionsDirectory);
		let closed = false;
		return {
			projectId: metadata.projectId,
			projectDirectory,
			control,
			sessions,
			async close() {
				if (closed) return;
				closed = true;
				try {
					control?.close();
				} finally {
					try {
						await sessions?.close();
					} finally {
						await releaseWriterLock();
					}
				}
			},
		};
	} catch (error) {
		try {
			control?.close();
		} finally {
			try {
				await sessions?.close();
			} finally {
				await releaseWriterLock();
			}
		}
		throw error;
	}
}
