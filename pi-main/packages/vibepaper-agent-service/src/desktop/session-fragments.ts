import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sanitizeAgentReply } from "../application/agent-runtime.ts";
import type { DesktopAgentSessionStore } from "./session-store.ts";

const FRAGMENT_SCHEMA_VERSION = 1;
const FRAGMENT_DIRECTORY = "fragments";
const FRAGMENT_IMPORTED_MESSAGE_ENTRY_TYPE = "vibepaper_fragment_import";
const MAX_FRAGMENT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FRAGMENT_MESSAGES = 2_000;
const MAX_FRAGMENT_MESSAGE_CHARACTERS = 20_000;
const MAX_FRAGMENT_TITLE_CHARACTERS = 120;
const MAX_PROJECT_ID_LENGTH = 128;
const MAX_CANVAS_ID_LENGTH = 128;
const FRAGMENT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const FRAGMENT_FILE_PATTERN = /^([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.json$/iu;
const FRAGMENT_TEMP_PATTERN = /^[a-f0-9-]{36}\.[a-f0-9-]{36}\.tmp$/iu;

type AssistantTranscriptMessage = Extract<AgentMessage, { role: "assistant" }>;
type TextTranscriptMessage = Extract<AgentMessage, { role: "user" | "assistant" }>;

export type DesktopAgentSessionFragmentMessage =
	| { role: "user"; content: string }
	| { role: "assistant"; content: string };

export type DesktopAgentSessionFragment = {
	id: string;
	title: string;
	canvasId: string | null;
	agentModelId?: string;
	createdAt: string;
};

type StoredDesktopAgentSessionFragment = DesktopAgentSessionFragment & {
	schemaVersion: 1;
	messages: DesktopAgentSessionFragmentMessage[];
};

type DesktopProjectMetadata = {
	projectId: string;
	canvasId: string;
};

export class DesktopSessionFragments {
	private readonly projectDirectoryInput: string;
	private readonly projectId: string;
	private readonly sessions: DesktopAgentSessionStore;

	constructor(projectDirectory: string, projectId: string, sessions: DesktopAgentSessionStore) {
		this.projectDirectoryInput = projectDirectory;
		this.projectId = projectId;
		this.sessions = sessions;
	}

	async initialize(): Promise<void> {
		await this.requirePaths();
	}

	async list(): Promise<{ items: DesktopAgentSessionFragment[] }> {
		const { fragmentsDirectory } = await this.requirePaths();
		const items: StoredDesktopAgentSessionFragment[] = [];
		for (const entry of await readdir(fragmentsDirectory, { withFileTypes: true })) {
			if (FRAGMENT_TEMP_PATTERN.test(entry.name)) continue;
			const match = FRAGMENT_FILE_PATTERN.exec(entry.name);
			if (!match) throw new Error("AGENT_SESSION_FRAGMENT_FILE_INVALID");
			const id = match[1];
			if (!id) throw new Error("AGENT_SESSION_FRAGMENT_FILE_INVALID");
			items.push(await this.readFragment(fragmentsDirectory, id));
		}
		items.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
		return {
			items: items.map(({ id, title, canvasId, agentModelId, createdAt }) => ({
				id,
				title,
				canvasId,
				...(agentModelId ? { agentModelId } : {}),
				createdAt,
			})),
		};
	}

	async save(sessionId: string, title?: string): Promise<{ fragmentId: string }> {
		if (!isBoundedText(sessionId, 1, 128)) throw new Error("AGENT_SESSION_FRAGMENT_INPUT_INVALID");
		const paths = await this.requirePaths();
		const session = await this.sessions.openSession(sessionId);
		const sessionName = await session.getName();
		const safeTitle = normalizeTitle(title, sessionName || "新对话");
		const transcript = await this.sessions.listTranscriptMessages(sessionId);
		const agentModelId = await this.sessions.getAgentModelBinding(sessionId);
		if (transcript.length > MAX_FRAGMENT_MESSAGES) throw new Error("AGENT_SESSION_FRAGMENT_TOO_LARGE");
		const messages: DesktopAgentSessionFragmentMessage[] = [];
		for (const { message } of transcript) {
			if (message.role !== "user" && message.role !== "assistant") continue;
			const transcriptMessage = message as TextTranscriptMessage;
			const rawContent = transcriptText(transcriptMessage);
			const content = message.role === "assistant" ? sanitizeAgentReply(rawContent) : rawContent;
			if (!content.trim()) continue;
			if (content.length > MAX_FRAGMENT_MESSAGE_CHARACTERS) throw new Error("AGENT_SESSION_FRAGMENT_TOO_LARGE");
			if (message.role === "user") {
				messages.push({ role: "user", content });
				continue;
			}
			messages.push({ role: "assistant", content });
		}
		const createdAt = new Date().toISOString();
		const fragmentId = randomUUID();
		const fragment: StoredDesktopAgentSessionFragment = {
			schemaVersion: FRAGMENT_SCHEMA_VERSION,
			id: fragmentId,
			title: safeTitle,
			canvasId: paths.metadata.canvasId,
			agentModelId,
			createdAt,
			messages,
		};
		const serialized = `${JSON.stringify(fragment)}\n`;
		if (Buffer.byteLength(serialized, "utf8") > MAX_FRAGMENT_FILE_BYTES) {
			throw new Error("AGENT_SESSION_FRAGMENT_TOO_LARGE");
		}
		await this.writeFragment(paths.fragmentsDirectory, fragmentId, serialized);
		return { fragmentId };
	}

	async import(fragmentId: string, canvasId?: string): Promise<{ sessionId: string }> {
		if (!isFragmentId(fragmentId)) throw new Error("AGENT_SESSION_FRAGMENT_INPUT_INVALID");
		const paths = await this.requirePaths();
		if (
			canvasId !== undefined &&
			(!isBoundedText(canvasId, 1, MAX_CANVAS_ID_LENGTH) || canvasId !== paths.metadata.canvasId)
		) {
			throw new Error("AGENT_PROJECT_CHANGED");
		}
		const fragment = await this.readFragment(paths.fragmentsDirectory, fragmentId);
		const session = await this.sessions.createSession(fragment.title || "新对话");
		if (fragment.agentModelId) await this.sessions.setAgentModelBinding(session.id, fragment.agentModelId);
		for (const entry of fragment.messages) {
			const timestamp = Date.now();
			if (entry.role === "user") {
				const message: AgentMessage = { role: "user", content: entry.content, timestamp };
				await this.sessions.appendMessage(session.id, message);
				continue;
			}
			const message: AssistantTranscriptMessage = {
				role: "assistant",
				content: [{ type: "text", text: entry.content }],
				api: "openai-completions",
				provider: "",
				model: "",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp,
			};
			const messageId = await this.sessions.appendMessage(session.id, message);
			const importedSession = await this.sessions.openSession(session.id);
			await importedSession.appendCustomEntry(FRAGMENT_IMPORTED_MESSAGE_ENTRY_TYPE, { messageId });
		}
		return { sessionId: session.id };
	}

	private async readFragment(
		fragmentsDirectory: string,
		fragmentId: string,
	): Promise<StoredDesktopAgentSessionFragment> {
		const filePath = join(fragmentsDirectory, `${fragmentId}.json`);
		const info = await lstat(filePath).catch((error: unknown) => {
			if (nodeErrorCode(error) === "ENOENT") return null;
			throw error;
		});
		if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_FRAGMENT_FILE_BYTES) {
			throw new Error(info ? "AGENT_SESSION_FRAGMENT_FILE_INVALID" : "AGENT_SESSION_FRAGMENT_NOT_FOUND");
		}
		const realFilePath = await realpath(filePath);
		if (!isWithin(fragmentsDirectory, realFilePath)) throw new Error("AGENT_SESSION_FRAGMENT_FILE_INVALID");
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(realFilePath, "utf8")) as unknown;
		} catch {
			throw new Error("AGENT_SESSION_FRAGMENT_FILE_INVALID");
		}
		return decodeStoredFragment(parsed, fragmentId);
	}

	private async writeFragment(fragmentsDirectory: string, fragmentId: string, contents: string): Promise<void> {
		const destination = join(fragmentsDirectory, `${fragmentId}.json`);
		const temporaryPath = join(fragmentsDirectory, `${fragmentId}.${randomUUID()}.tmp`);
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(temporaryPath, "wx", 0o600);
			await handle.writeFile(contents, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temporaryPath, destination);
		} catch (error) {
			await handle?.close().catch(() => undefined);
			await rm(temporaryPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	private async requirePaths(): Promise<{ fragmentsDirectory: string; metadata: DesktopProjectMetadata }> {
		const projectDirectory = await realpath(resolve(this.projectDirectoryInput)).catch(() => {
			throw new Error("AGENT_SESSION_FRAGMENT_PATH_INVALID");
		});
		const dataDirectory = join(projectDirectory, ".vibepaper");
		const agentDirectory = join(dataDirectory, "agent");
		await requireSafeDirectory(dataDirectory, projectDirectory);
		await requireSafeDirectory(agentDirectory, projectDirectory);
		const metadataPath = join(dataDirectory, "project.json");
		await requireSafeFile(metadataPath, projectDirectory);
		let metadataValue: unknown;
		try {
			metadataValue = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
		} catch {
			throw new Error("AGENT_SESSION_FRAGMENT_PATH_INVALID");
		}
		const metadata = decodeProjectMetadata(metadataValue, this.projectId);
		const fragmentsDirectory = join(agentDirectory, FRAGMENT_DIRECTORY);
		const currentInfo = await lstat(fragmentsDirectory).catch((error: unknown) => {
			if (nodeErrorCode(error) === "ENOENT") return null;
			throw error;
		});
		if (!currentInfo) await mkdir(fragmentsDirectory, { mode: 0o700 });
		await requireSafeDirectory(fragmentsDirectory, projectDirectory);
		return { fragmentsDirectory, metadata };
	}
}

function transcriptText(message: TextTranscriptMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("");
}

function normalizeTitle(value: string | undefined, fallback: string): string {
	const title = (value ?? fallback).trim().slice(0, MAX_FRAGMENT_TITLE_CHARACTERS);
	return title || "新对话";
}

function decodeStoredFragment(value: unknown, expectedId: string): StoredDesktopAgentSessionFragment {
	const fragment = objectValue(value);
	if (
		fragment.schemaVersion !== FRAGMENT_SCHEMA_VERSION ||
		fragment.id !== expectedId ||
		!isFragmentId(fragment.id) ||
		!isBoundedText(fragment.title, 1, MAX_FRAGMENT_TITLE_CHARACTERS) ||
		!(fragment.canvasId === null || isBoundedText(fragment.canvasId, 1, MAX_CANVAS_ID_LENGTH)) ||
		(fragment.agentModelId !== undefined &&
			(typeof fragment.agentModelId !== "string" ||
				!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(fragment.agentModelId))) ||
		typeof fragment.createdAt !== "string" ||
		!Number.isFinite(Date.parse(fragment.createdAt)) ||
		!Array.isArray(fragment.messages) ||
		fragment.messages.length > MAX_FRAGMENT_MESSAGES
	) {
		throw new Error("AGENT_SESSION_FRAGMENT_FILE_INVALID");
	}
	const messages: DesktopAgentSessionFragmentMessage[] = [];
	for (const item of fragment.messages) {
		const message = objectValue(item);
		if (!isBoundedText(message.content, 1, MAX_FRAGMENT_MESSAGE_CHARACTERS)) {
			throw new Error("AGENT_SESSION_FRAGMENT_FILE_INVALID");
		}
		if (message.role === "user") {
			messages.push({ role: "user", content: message.content });
			continue;
		}
		if (message.role === "assistant") {
			messages.push({ role: "assistant", content: message.content });
			continue;
		}
		throw new Error("AGENT_SESSION_FRAGMENT_FILE_INVALID");
	}
	return {
		schemaVersion: FRAGMENT_SCHEMA_VERSION,
		id: fragment.id,
		title: fragment.title,
		canvasId: fragment.canvasId,
		...(typeof fragment.agentModelId === "string" ? { agentModelId: fragment.agentModelId } : {}),
		createdAt: fragment.createdAt,
		messages,
	};
}

function decodeProjectMetadata(value: unknown, expectedProjectId: string): DesktopProjectMetadata {
	const metadata = objectValue(value);
	if (
		!isBoundedText(metadata.projectId, 1, MAX_PROJECT_ID_LENGTH) ||
		metadata.projectId !== expectedProjectId ||
		!isBoundedText(metadata.canvasId, 1, MAX_CANVAS_ID_LENGTH)
	) {
		throw new Error("AGENT_PROJECT_CHANGED");
	}
	return { projectId: metadata.projectId, canvasId: metadata.canvasId };
}

async function requireSafeDirectory(directory: string, projectDirectory: string): Promise<void> {
	const info = await lstat(directory).catch(() => null);
	if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error("AGENT_SESSION_FRAGMENT_PATH_INVALID");
	const resolved = await realpath(directory);
	if (!isWithin(projectDirectory, resolved)) throw new Error("AGENT_SESSION_FRAGMENT_PATH_INVALID");
}

async function requireSafeFile(filePath: string, projectDirectory: string): Promise<void> {
	const info = await lstat(filePath).catch(() => null);
	if (!info?.isFile() || info.isSymbolicLink()) throw new Error("AGENT_SESSION_FRAGMENT_PATH_INVALID");
	const resolved = await realpath(filePath);
	if (!isWithin(projectDirectory, resolved)) throw new Error("AGENT_SESSION_FRAGMENT_PATH_INVALID");
}

function isWithin(parent: string, candidate: string): boolean {
	const relativePath = relative(parent, candidate);
	return (
		relativePath === "" ||
		(!isAbsolute(relativePath) &&
			relativePath !== ".." &&
			!relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
	);
}

function objectValue(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("AGENT_SESSION_FRAGMENT_FILE_INVALID");
	}
	return value as Record<string, unknown>;
}

function isFragmentId(value: unknown): value is string {
	return typeof value === "string" && FRAGMENT_ID_PATTERN.test(value);
}

function isBoundedText(value: unknown, minimum: number, maximum: number): value is string {
	return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function nodeErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}
