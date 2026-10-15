import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type MemoryRepository, MemoryService } from "../application/memory-service.ts";
import type { MemoryRecord } from "../domain/memory.ts";
import type { DesktopAgentControlStore, DesktopMemoryCandidateRecord } from "./control-store.ts";
import {
	type DesktopProjectMemory,
	normalizeDesktopMemoryContent,
	readMarkdownMemoryFile,
	replaceMarkdownMemoryContent,
	writeMarkdownMemoryFile,
} from "./project-memory.ts";
import type { DesktopAgentSessionStore } from "./session-store.ts";

const MEMORY_SCHEMA_VERSION = 1;
const MAX_MEMORY_ID_LENGTH = 128;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_CANVAS_ID_LENGTH = 128;
const MAX_CANDIDATES = 500;
const MAX_CANDIDATE_CONTENT_LENGTH = 500;
const DAILY_MEMORY_MAX_LENGTH = 500;
const MANAGED_SCOPES = ["session", "canvas", "project", "global", "daily"] as const;

export type DesktopMemoryScope = (typeof MANAGED_SCOPES)[number];

export function desktopCandidateScope(userText: string, originalScope: string): DesktopMemoryScope {
	if (/(?:本项目|当前项目|该项目|这个项目|this project)/iu.test(userText)) return "project";
	return originalScope === "long_term" ? "global" : "canvas";
}

export type DesktopMemoryRecord = {
	id: string;
	userId: string;
	canvasId?: string;
	sessionId?: string;
	scope: DesktopMemoryScope;
	content: string;
	memoryType: string;
	source: string;
	confidence: number;
	visibility: "user";
	version: number;
	createdAt: string;
	expiresAt?: string;
	deleted: false;
};

export type DesktopMemoryCandidate = {
	id: string;
	userId: string;
	canvasId?: string;
	sessionId?: string;
	sourceEventSeq?: number;
	scope: DesktopMemoryScope;
	content: string;
	memoryType: string;
	source: string;
	confidence: number;
	status: "pending" | "accepted" | "rejected";
	createdAt: string;
	reviewedAt?: string;
	expiresAt?: string;
};

type ProjectMetadata = { projectId: string; canvasId: string };
type SessionScopeValidator = Pick<DesktopAgentSessionStore, "listSessions" | "openSession">;
type CandidateStore = Pick<
	DesktopAgentControlStore,
	| "listPendingDesktopMemoryCandidates"
	| "findPendingDesktopMemoryCandidate"
	| "getDesktopMemoryCandidate"
	| "saveDesktopMemoryCandidate"
	| "updateDesktopMemoryCandidateStatus"
>;

type ScopeFile = {
	directory: string;
	file: string;
	ownerId: string;
	scope: "session" | "canvas" | "daily";
	sessionId?: string;
	canvasId?: string;
	errorCode: string;
};

const SCOPED_MEMORY_HEADERS: Record<ScopeFile["scope"], string> = {
	session: [
		"# VibePaper session memory",
		"",
		"<!-- schemaVersion: 1; scope: session; user-authored session continuity. -->",
		"",
	].join("\n"),
	canvas: [
		"# VibePaper canvas memory",
		"",
		"<!-- schemaVersion: 1; scope: canvas; user-authored canvas preferences. -->",
		"",
	].join("\n"),
	daily: [
		"# VibePaper daily memory",
		"",
		"<!-- schemaVersion: 1; scope: daily; entries expire at the next UTC day boundary. -->",
		"",
	].join("\n"),
};

class BoundMarkdownMemoryRepository implements MemoryRepository {
	private readonly scopeFile: ScopeFile;
	private readonly header: string;

	constructor(scopeFile: ScopeFile) {
		this.scopeFile = scopeFile;
		this.header = SCOPED_MEMORY_HEADERS[scopeFile.scope];
	}

	async list(): Promise<readonly MemoryRecord[]> {
		const records = await readMarkdownMemoryFile(
			this.scopeFile.file,
			this.scopeFile.ownerId,
			this.scopeFile.errorCode,
			this.header,
			this.scopeFile.scope,
		);
		for (const record of records) {
			if (record.sessionId !== this.scopeFile.sessionId || record.canvasId !== this.scopeFile.canvasId) {
				throw new Error(this.scopeFile.errorCode);
			}
		}
		return records;
	}

	async save(record: MemoryRecord): Promise<void> {
		if (
			record.userId !== this.scopeFile.ownerId ||
			record.scope !== this.scopeFile.scope ||
			record.sessionId !== this.scopeFile.sessionId ||
			record.canvasId !== this.scopeFile.canvasId
		) {
			throw new Error("PERMISSION_DENIED");
		}
		const records = [...(await this.list())];
		const index = records.findIndex((item) => item.id === record.id);
		if (index < 0) records.push(record);
		else records[index] = record;
		await this.write(records);
	}

	async softDelete(id: string, userId: string): Promise<boolean> {
		if (userId !== this.scopeFile.ownerId) return false;
		const records = [...(await this.list())];
		const index = records.findIndex((item) => item.id === id && !item.deleted);
		const existing = records[index];
		if (index < 0 || !existing) return false;
		records[index] = { ...existing, deleted: true, version: existing.version + 1 };
		await this.write(records);
		return true;
	}

	async replaceContent(memoryId: string, userId: string, content: string): Promise<MemoryRecord> {
		if (userId !== this.scopeFile.ownerId) throw new Error("PERMISSION_DENIED");
		return await replaceMarkdownMemoryContent(
			async () => [...(await this.list())],
			this.write.bind(this),
			memoryId,
			content,
		);
	}

	private async write(records: readonly MemoryRecord[]): Promise<void> {
		await writeMarkdownMemoryFile(
			this.scopeFile.directory,
			this.scopeFile.file,
			records,
			this.scopeFile.errorCode,
			this.header,
		);
	}
}

/**
 * Desktop facade for all user-visible memory scopes. Project/global data use the
 * existing memory service; session/canvas/daily records use scoped Markdown files.
 * Candidate status remains in the project's durable Agent control database.
 */
export class DesktopScopedMemoryStore {
	readonly projectId: string;
	private readonly projectDirectoryInput: string;
	private readonly sessions: SessionScopeValidator;
	private readonly projectMemory: DesktopProjectMemory;
	private readonly candidateStore: CandidateStore;
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(
		projectDirectory: string,
		projectId: string,
		sessions: SessionScopeValidator,
		projectMemory: DesktopProjectMemory,
		candidateStore: CandidateStore,
	) {
		if (!projectId || projectId.length > 128 || projectMemory.projectId !== projectId) {
			throw new Error("AGENT_PROJECT_CHANGED");
		}
		this.projectDirectoryInput = projectDirectory;
		this.projectId = projectId;
		this.sessions = sessions;
		this.projectMemory = projectMemory;
		this.candidateStore = candidateStore;
	}

	async initialize(): Promise<void> {
		const paths = await this.requireProjectPaths();
		for (const directory of [
			join(paths.agentDirectory, "session-memory"),
			join(paths.agentDirectory, "memory", "canvas"),
			join(paths.agentDirectory, "daily-memory"),
		]) {
			await ensureProjectDirectory(directory, paths.projectDirectory, "AGENT_MEMORY_PATH_INVALID");
		}
		await this.cleanupExpiredDailyMemory(paths.agentDirectory);
	}

	async list(scope: DesktopMemoryScope, sessionId?: string): Promise<{ items: DesktopMemoryRecord[] }> {
		const records = await this.listRecords(scope, sessionId);
		return { items: records.map((record) => toDesktopMemoryRecord(record, scope)) };
	}

	async create(scope: DesktopMemoryScope, content: string, sessionId?: string): Promise<DesktopMemoryRecord> {
		return await this.mutate(() => this.createInternal(scope, content, sessionId));
	}

	async update(
		scope: DesktopMemoryScope,
		memoryId: string,
		content: string,
		sessionId?: string,
	): Promise<DesktopMemoryRecord> {
		return await this.mutate(async () => {
			validateMemoryId(memoryId);
			const normalized = normalizeDesktopMemoryContent(content);
			if (scope === "project" || scope === "global") {
				return toDesktopMemoryRecord(await this.projectMemory.editManaged(memoryId, normalized, scope), scope);
			}
			const repository = await this.repositoryFor(scope, sessionId);
			const service = new MemoryService(repository);
			const existing = (await service.export(this.projectId)).find((item) => item.id === memoryId);
			if (!existing) throw new Error("NOT_FOUND");
			const updated = await repository.replaceContent(memoryId, this.projectId, normalized);
			return toDesktopMemoryRecord(updated, scope);
		});
	}

	async delete(scope: DesktopMemoryScope, memoryId: string, sessionId?: string): Promise<{ status: "ok" }> {
		return await this.mutate(async () => {
			validateMemoryId(memoryId);
			if (scope === "project" || scope === "global") {
				await this.projectMemory.removeManaged(memoryId, scope);
				return { status: "ok" };
			}
			const repository = await this.repositoryFor(scope, sessionId);
			if (!(await repository.softDelete(memoryId, this.projectId))) throw new Error("NOT_FOUND");
			return { status: "ok" };
		});
	}

	async export(): Promise<{ schemaVersion: 1; exportedAt: string; items: DesktopMemoryRecord[] }> {
		const items: DesktopMemoryRecord[] = [];
		for (const scope of ["project", "global", "canvas", "daily"] as const) {
			items.push(...(await this.list(scope)).items);
		}
		for (const session of await this.sessions.listSessions()) {
			items.push(...(await this.list("session", session.id)).items);
		}
		return { schemaVersion: MEMORY_SCHEMA_VERSION, exportedAt: new Date().toISOString(), items };
	}

	async proposeCandidate(input: {
		sessionId?: string;
		sourceEventSeq?: number;
		scope: DesktopMemoryScope;
		content: string;
		memoryType?: string;
		confidence?: number;
		source?: string;
		expiresAt?: Date;
	}): Promise<DesktopMemoryCandidate> {
		return await this.mutate(async () => {
			const content = normalizeDesktopMemoryContent(input.content);
			if (content.length > MAX_CANDIDATE_CONTENT_LENGTH) throw new Error("AGENT_MEMORY_CANDIDATE_INVALID");
			if (!isDesktopMemoryScope(input.scope)) throw new Error("AGENT_MEMORY_SCOPE_INVALID");
			const confidence = input.confidence ?? 0.95;
			if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
				throw new Error("AGENT_MEMORY_CANDIDATE_INVALID");
			}
			if (
				input.sourceEventSeq !== undefined &&
				(!Number.isSafeInteger(input.sourceEventSeq) || input.sourceEventSeq < 0)
			) {
				throw new Error("AGENT_MEMORY_CANDIDATE_INVALID");
			}
			const context = await this.scopeContext(input.scope, input.sessionId);
			const expiresAt = input.expiresAt ?? (input.scope === "daily" ? utcNextDay(new Date()) : undefined);
			if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())) {
				throw new Error("AGENT_MEMORY_CANDIDATE_INVALID");
			}
			const dedupeKey = createHash("sha256")
				.update(
					`${input.scope}:${context.sessionId ?? ""}:${context.canvasId ?? ""}:${content.toLocaleLowerCase()}`,
				)
				.digest("hex");
			const existing = this.candidateStore.findPendingDesktopMemoryCandidate(this.projectId, input.scope, dedupeKey);
			if (existing) return toDesktopMemoryCandidate(existing);
			const candidate: DesktopMemoryCandidateRecord = {
				id: randomUUID(),
				userId: this.projectId,
				...(context.canvasId ? { canvasId: context.canvasId } : {}),
				...(context.sessionId ? { sessionId: context.sessionId } : {}),
				...(input.sourceEventSeq === undefined ? {} : { sourceEventSeq: input.sourceEventSeq }),
				scope: input.scope,
				content,
				memoryType: input.memoryType ?? defaultMemoryType(input.scope),
				source: input.source ?? "agent_candidate",
				confidence,
				status: "pending",
				dedupeKey,
				...(expiresAt ? { expiresAt } : {}),
				createdAt: new Date(),
			};
			if (!this.candidateStore.saveDesktopMemoryCandidate(candidate)) {
				const duplicate = this.candidateStore.findPendingDesktopMemoryCandidate(
					this.projectId,
					input.scope,
					dedupeKey,
				);
				if (duplicate) return toDesktopMemoryCandidate(duplicate);
				throw new Error("AGENT_MEMORY_CANDIDATE_SAVE_FAILED");
			}
			return toDesktopMemoryCandidate(candidate);
		});
	}

	async listCandidates(): Promise<{ items: DesktopMemoryCandidate[] }> {
		const now = Date.now();
		const items = this.candidateStore
			.listPendingDesktopMemoryCandidates(this.projectId)
			.filter((candidate) => !candidate.expiresAt || candidate.expiresAt.getTime() > now)
			.slice(0, MAX_CANDIDATES)
			.map(toDesktopMemoryCandidate);
		return { items };
	}

	async reviewCandidate(
		candidateId: string,
		action: "accept" | "reject",
	): Promise<{ status: "accepted" | "rejected"; item?: DesktopMemoryRecord }> {
		return await this.mutate(async () => {
			validateMemoryId(candidateId);
			if (action !== "accept" && action !== "reject") throw new Error("AGENT_MEMORY_CANDIDATE_ACTION_INVALID");
			const candidate = this.candidateStore.getDesktopMemoryCandidate(candidateId, this.projectId);
			if (!candidate || candidate.status !== "pending") throw new Error("NOT_FOUND");
			if (candidate.expiresAt && candidate.expiresAt.getTime() <= Date.now()) throw new Error("NOT_FOUND");
			if (action === "reject") {
				if (!this.candidateStore.updateDesktopMemoryCandidateStatus(candidateId, this.projectId, "rejected")) {
					throw new Error("NOT_FOUND");
				}
				return { status: "rejected" };
			}
			const item = await this.createInternal(candidate.scope, candidate.content, candidate.sessionId, candidate);
			if (!this.candidateStore.updateDesktopMemoryCandidateStatus(candidateId, this.projectId, "accepted")) {
				throw new Error("NOT_FOUND");
			}
			return { status: "accepted", item };
		});
	}

	private async listRecords(scope: DesktopMemoryScope, sessionId?: string): Promise<MemoryRecord[]> {
		if (!isDesktopMemoryScope(scope)) throw new Error("AGENT_MEMORY_SCOPE_INVALID");
		if (scope === "project" || scope === "global") {
			return [...(await this.projectMemory.listManaged(scope))];
		}
		const repository = await this.repositoryFor(scope, sessionId);
		const now = new Date();
		return (await repository.list()).filter(
			(record) => !record.deleted && (!record.expiresAt || record.expiresAt > now),
		);
	}

	private async createInternal(
		scope: DesktopMemoryScope,
		content: string,
		sessionId?: string,
		metadata: { memoryType?: string; confidence?: number; source?: string; expiresAt?: Date } = {},
	): Promise<DesktopMemoryRecord> {
		if (!isDesktopMemoryScope(scope)) throw new Error("AGENT_MEMORY_SCOPE_INVALID");
		const normalized = normalizeDesktopMemoryContent(content);
		if (scope === "daily" && normalized.length > DAILY_MEMORY_MAX_LENGTH) {
			throw new Error("AGENT_MEMORY_INPUT_INVALID");
		}
		if (scope === "project" || scope === "global") {
			return toDesktopMemoryRecord(await this.projectMemory.createManaged(normalized, scope, metadata), scope);
		}
		const scopeContext = await this.scopeContext(scope, sessionId);
		const repository = await this.repositoryFor(scope, sessionId, scopeContext);
		const expiresAt = metadata.expiresAt ?? (scope === "daily" ? utcNextDay(new Date()) : undefined);
		const memory = await new MemoryService(repository).write({
			userId: this.projectId,
			...(scopeContext.canvasId ? { canvasId: scopeContext.canvasId } : {}),
			...(scopeContext.sessionId ? { sessionId: scopeContext.sessionId } : {}),
			scope,
			content: normalized,
			memoryType: metadata.memoryType ?? defaultMemoryType(scope),
			confidence: metadata.confidence ?? 1,
			source: metadata.source ?? "user_memory_manager",
			visibility: "user",
			...(expiresAt ? { expiresAt } : {}),
		});
		return toDesktopMemoryRecord(memory, scope);
	}

	private async repositoryFor(
		scope: DesktopMemoryScope,
		sessionId?: string,
		knownContext?: { sessionId?: string; canvasId?: string },
	): Promise<BoundMarkdownMemoryRepository> {
		if (scope === "project" || scope === "global") throw new Error("AGENT_MEMORY_SCOPE_INVALID");
		const context = knownContext ?? (await this.scopeContext(scope, sessionId));
		const paths = await this.requireProjectPaths();
		let directory: string;
		let file: string;
		if (scope === "session") {
			if (!context.sessionId) throw new Error("AGENT_MEMORY_SESSION_REQUIRED");
			directory = join(paths.agentDirectory, "session-memory", context.sessionId);
			file = join(directory, "MEMORY.md");
		} else if (scope === "canvas") {
			if (!context.canvasId) throw new Error("AGENT_MEMORY_CANVAS_REQUIRED");
			directory = join(paths.agentDirectory, "memory", "canvas");
			file = join(directory, `${createHash("sha256").update(context.canvasId).digest("hex")}.md`);
		} else {
			const dayKey = utcDayKey(new Date());
			directory = join(paths.agentDirectory, "daily-memory");
			file = join(directory, `${dayKey}.md`);
		}
		await ensureProjectDirectory(directory, paths.projectDirectory, "AGENT_MEMORY_PATH_INVALID");
		return new BoundMarkdownMemoryRepository({
			directory,
			file,
			ownerId: this.projectId,
			scope,
			...(context.sessionId ? { sessionId: context.sessionId } : {}),
			...(context.canvasId ? { canvasId: context.canvasId } : {}),
			errorCode: "AGENT_MEMORY_FILE_INVALID",
		});
	}

	private async scopeContext(
		scope: DesktopMemoryScope,
		sessionId?: string,
	): Promise<{ sessionId?: string; canvasId?: string }> {
		if (scope === "session") {
			validateSessionId(sessionId);
			await this.sessions.openSession(sessionId);
			return { sessionId };
		}
		if (scope === "project" || scope === "global") return {};
		const { canvasId } = (await this.requireProjectPaths()).metadata;
		if (scope === "canvas") return { canvasId };
		if (scope === "daily") {
			if (sessionId) {
				validateSessionId(sessionId);
				await this.sessions.openSession(sessionId);
			}
			return { canvasId };
		}
		throw new Error("AGENT_MEMORY_SCOPE_INVALID");
	}

	private async requireProjectPaths(): Promise<{
		projectDirectory: string;
		agentDirectory: string;
		metadata: ProjectMetadata;
	}> {
		const projectDirectory = await realpath(resolve(this.projectDirectoryInput)).catch(() => {
			throw new Error("AGENT_MEMORY_PATH_INVALID");
		});
		const dataDirectory = join(projectDirectory, ".vibepaper");
		const agentDirectory = join(dataDirectory, "agent");
		await requireProjectDirectory(dataDirectory, projectDirectory, "AGENT_MEMORY_PATH_INVALID");
		await requireProjectDirectory(agentDirectory, projectDirectory, "AGENT_MEMORY_PATH_INVALID");
		const metadataPath = join(dataDirectory, "project.json");
		await requireProjectFile(metadataPath, projectDirectory, "AGENT_MEMORY_PATH_INVALID");
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
		} catch {
			throw new Error("AGENT_MEMORY_PATH_INVALID");
		}
		const metadata = decodeProjectMetadata(parsed, this.projectId);
		return { projectDirectory, agentDirectory, metadata };
	}

	private async cleanupExpiredDailyMemory(agentDirectory: string): Promise<void> {
		const directory = join(agentDirectory, "daily-memory");
		const today = utcDayKey(new Date());
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const dateKey = /^(\d{4}-\d{2}-\d{2})\.md$/u.exec(entry.name)?.[1];
			if (!dateKey || dateKey >= today) continue;
			const filePath = join(directory, entry.name);
			const info = await lstat(filePath).catch(() => null);
			if (!info || !info.isFile() || info.isSymbolicLink()) throw new Error("AGENT_MEMORY_PATH_INVALID");
			await rm(filePath);
		}
	}

	private async mutate<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.mutationTail.then(operation);
		this.mutationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return await result;
	}
}

function toDesktopMemoryRecord(record: MemoryRecord, scope: DesktopMemoryScope): DesktopMemoryRecord {
	if (!record.createdAt || !Number.isFinite(record.createdAt.getTime())) throw new Error("AGENT_MEMORY_FILE_INVALID");
	return {
		id: record.id,
		userId: record.userId,
		...(record.canvasId ? { canvasId: record.canvasId } : {}),
		...(record.sessionId ? { sessionId: record.sessionId } : {}),
		scope,
		content: record.content,
		memoryType: record.memoryType ?? defaultMemoryType(scope),
		source: record.source,
		confidence: record.confidence,
		visibility: "user",
		version: record.version,
		createdAt: record.createdAt.toISOString(),
		...(record.expiresAt ? { expiresAt: record.expiresAt.toISOString() } : {}),
		deleted: false,
	};
}

function toDesktopMemoryCandidate(candidate: DesktopMemoryCandidateRecord): DesktopMemoryCandidate {
	return {
		id: candidate.id,
		userId: candidate.userId,
		...(candidate.canvasId ? { canvasId: candidate.canvasId } : {}),
		...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
		...(candidate.sourceEventSeq === undefined ? {} : { sourceEventSeq: candidate.sourceEventSeq }),
		scope: candidate.scope,
		content: candidate.content,
		memoryType: candidate.memoryType,
		source: candidate.source,
		confidence: candidate.confidence,
		status: candidate.status,
		createdAt: candidate.createdAt.toISOString(),
		...(candidate.reviewedAt ? { reviewedAt: candidate.reviewedAt.toISOString() } : {}),
		...(candidate.expiresAt ? { expiresAt: candidate.expiresAt.toISOString() } : {}),
	};
}

function defaultMemoryType(scope: DesktopMemoryScope): string {
	return scope === "project"
		? "project_preference"
		: scope === "global"
			? "preference"
			: scope === "canvas"
				? "project_rule"
				: scope === "session"
					? "session_memory"
					: "daily_note";
}

function isDesktopMemoryScope(value: unknown): value is DesktopMemoryScope {
	return typeof value === "string" && (MANAGED_SCOPES as readonly string[]).includes(value);
}

function validateMemoryId(value: string): void {
	if (typeof value !== "string" || value.length > MAX_MEMORY_ID_LENGTH || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
		throw new Error("AGENT_MEMORY_INPUT_INVALID");
	}
}

function validateSessionId(value: string | undefined): asserts value is string {
	if (typeof value !== "string" || value.length > MAX_SESSION_ID_LENGTH || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
		throw new Error("AGENT_MEMORY_SESSION_REQUIRED");
	}
}

function utcDayKey(value: Date): string {
	return value.toISOString().slice(0, 10);
}

function utcNextDay(value: Date): Date {
	const next = new Date(value);
	next.setUTCHours(24, 0, 0, 0);
	return next;
}

function decodeProjectMetadata(value: unknown, projectId: string): ProjectMetadata {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("AGENT_PROJECT_CHANGED");
	const metadata = value as Record<string, unknown>;
	if (
		metadata.projectId !== projectId ||
		typeof metadata.canvasId !== "string" ||
		!metadata.canvasId.trim() ||
		metadata.canvasId.length > MAX_CANVAS_ID_LENGTH
	) {
		throw new Error("AGENT_PROJECT_CHANGED");
	}
	return { projectId, canvasId: metadata.canvasId };
}

async function ensureProjectDirectory(directory: string, projectDirectory: string, errorCode: string): Promise<void> {
	if (!isWithin(projectDirectory, directory)) throw new Error(errorCode);
	const relativePath = relative(projectDirectory, directory);
	let current = projectDirectory;
	for (const segment of relativePath.split(sep).filter(Boolean)) {
		current = join(current, segment);
		const info = await lstat(current).catch((error: unknown) => {
			if (nodeErrorCode(error) === "ENOENT") return null;
			throw error;
		});
		if (!info) await mkdir(current, { mode: 0o700 });
		else if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(errorCode);
	}
	const resolvedPath = await realpath(directory);
	if (!isWithin(projectDirectory, resolvedPath)) throw new Error(errorCode);
}

async function requireProjectDirectory(directory: string, projectDirectory: string, errorCode: string): Promise<void> {
	const info = await lstat(directory).catch(() => null);
	if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(errorCode);
	const resolved = await realpath(directory);
	if (!isWithin(projectDirectory, resolved)) throw new Error(errorCode);
}

async function requireProjectFile(filePath: string, projectDirectory: string, errorCode: string): Promise<void> {
	const info = await lstat(filePath).catch(() => null);
	if (!info?.isFile() || info.isSymbolicLink()) throw new Error(errorCode);
	const resolved = await realpath(filePath);
	if (!isWithin(projectDirectory, resolved)) throw new Error(errorCode);
}

function isWithin(parent: string, candidate: string): boolean {
	const relativePath = relative(parent, candidate);
	return (
		relativePath === "" ||
		(!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
	);
}

function nodeErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}
