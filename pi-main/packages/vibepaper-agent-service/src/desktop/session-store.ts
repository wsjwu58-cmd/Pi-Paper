import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
	type AgentMessage,
	buildSessionContext,
	buildContextEntries,
	type FileError,
	type Entry,
	type JsonlSessionMetadata,
	JsonlSessionRepo,
	sessionEntryToContextMessages,
	type Result,
	type Session,
	type SessionContext,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { nodeReferencesFromMeta, type NodeReferenceSnapshot } from "../application/node-reference-context.ts";
import type { DesktopAgentControlStore } from "./control-store.ts";

const RUN_EVENT_ENTRY_TYPE = "vibepaper_run_event";
const MESSAGE_METADATA_ENTRY_TYPE = "vibepaper_message_metadata";
const MAX_MESSAGE_REFERENCES = 8;
const MAX_MESSAGE_ID_LENGTH = 128;
const MAX_SKILL_ID_LENGTH = 160;
const MAX_METADATA_BYTES = 96 * 1024;

export type DesktopAgentReferenceCard = Pick<
	NodeReferenceSnapshot,
	"nodeId" | "nodeType" | "creativeType" | "title" | "status" | "previewUrl"
>;

export type DesktopAgentMessageMetadata = {
	selectedNodeIds: string[];
	nodeReferences: DesktopAgentReferenceCard[];
	selectedSkillId?: string;
};

export type DesktopStoredMessage = {
	messageId: string;
	message: AgentMessage;
	metadata?: DesktopAgentMessageMetadata;
};

export type DesktopAgentCompactionInput = {
	/** Caller-generated summary of conversation facts needed for future turns. */
	summary: string;
	/** Minimum recent context messages to retain; complete tool pairs may add messages. */
	retainLastMessages: number;
	tokensBefore: number;
};

export type DesktopAgentCompactionCheckpoint = {
	schemaVersion: 1;
	sessionId: string;
	branchId: "main";
	throughEntryId: string;
	throughEntrySeq: number;
	sourceHash: string;
	summary: string;
	createdAt: number;
};

const COMPACTION_CHECKPOINT_SUFFIX = ".checkpoint.json";
const MAX_COMPACTION_SUMMARY_CHARACTERS = 8_000;
const MAX_RETAINED_CONTEXT_MESSAGES = 512;

class RelocatableSessionExecutionEnv extends NodeExecutionEnv {
	private readonly stableCwd: string;

	constructor(projectDirectory: string, projectId: string) {
		super({ cwd: projectDirectory });
		this.stableCwd = `vibepaper-project-${projectId}`;
	}

	get sessionCwd(): string {
		return this.stableCwd;
	}

	override absolutePath(path: string): Promise<Result<string, FileError>> {
		if (path === this.stableCwd) return Promise.resolve({ ok: true, value: this.stableCwd });
		return super.absolutePath(path);
	}
}

export class DesktopAgentSessionStore {
	private readonly projectId: string;
	private readonly fileSystem: RelocatableSessionExecutionEnv;
	private readonly repo: JsonlSessionRepo;
	private readonly sessionMutationTails = new Map<string, Promise<void>>();

	constructor(projectId: string, projectDirectory: string, sessionsRoot: string) {
		this.projectId = projectId;
		this.fileSystem = new RelocatableSessionExecutionEnv(projectDirectory, projectId);
		this.repo = new JsonlSessionRepo({ fs: this.fileSystem, sessionsRoot });
	}

	async createSession(title?: string): Promise<JsonlSessionMetadata> {
		const session = await this.repo.create({
			cwd: this.fileSystem.sessionCwd,
			metadata: { application: "VibePaper Desktop", projectId: this.projectId },
		});
		if (title?.trim()) await session.setName(title.trim().slice(0, 120));
		return await session.getMetadata();
	}

	async listSessions(): Promise<JsonlSessionMetadata[]> {
		return await this.repo.list({ cwd: this.fileSystem.sessionCwd });
	}

	async openSession(sessionId: string): Promise<Session<JsonlSessionMetadata>> {
		const metadata = (await this.listSessions()).find((candidate) => candidate.id === sessionId);
		if (!metadata) throw new Error("SESSION_NOT_FOUND");
		return await this.repo.open(metadata);
	}

	async appendMessage(
		sessionId: string,
		message: AgentMessage,
		metadata?: DesktopAgentMessageMetadata,
	): Promise<string> {
		const safeMetadata = metadata === undefined ? undefined : normalizeMessageMetadata(metadata);
		return this.withSessionMutation(sessionId, async () => {
			const session = await this.openSession(sessionId);
			const messageId = await session.appendMessage(message);
			if (safeMetadata) {
				await session.appendCustomEntry(MESSAGE_METADATA_ENTRY_TYPE, { messageId, metadata: safeMetadata });
			}
			return messageId;
		});
	}

	/**
	 * Append a Pi compaction entry to the active main branch and reload its context from JSONL.
	 * Existing message entries remain intact; the entry changes only the context projection.
	 */
	async appendCompaction(sessionId: string, input: DesktopAgentCompactionInput): Promise<SessionContext> {
		const summary = validateCompactionSummary(input.summary);
		if (
			!Number.isSafeInteger(input.retainLastMessages) ||
			input.retainLastMessages < 0 ||
			input.retainLastMessages > MAX_RETAINED_CONTEXT_MESSAGES ||
			!Number.isSafeInteger(input.tokensBefore) ||
			input.tokensBefore < 0
		) {
			throw new Error("AGENT_COMPACTION_INVALID");
		}

		return this.withSessionMutation(sessionId, async () => {
			const session = await this.openSession(sessionId);
			const leafId = await session.getLeafId();
			if (leafId === null) throw new Error("AGENT_COMPACTION_EMPTY_SESSION");
			const entries = await session.findEntriesOnBranch({ start: leafId, order: "oldestFirst" });
			const retainedTail = retainCompleteToolPairs(contextMessagesForRetention(entries), input.retainLastMessages);
			await session.appendEntry(
				{
					type: "compaction",
					id: randomUUID(),
					summary,
					retainedTail,
					tokensBefore: input.tokensBefore,
				},
				"main",
			);

			// Reopen through JsonlSessionRepo so the returned context is based on the durable entry.
			return this.buildContext(sessionId);
		});
	}

	async listMessages(sessionId: string): Promise<DesktopStoredMessage[]> {
		const session = await this.openSession(sessionId);
		const leafId = await session.getLeafId();
		if (leafId === null) return [];
		const entries = await session.findEntriesOnBranch({ start: leafId, order: "oldestFirst" });
		const metadataByMessageId = messageMetadataById(entries);
		const contextEntries = buildContextEntries(entries);
		return contextEntries.flatMap((entry, entryIndex) => {
			const projectedMessages = sessionEntryToContextMessages(entry, entryIndex, contextEntries);
			const consumedRetainedMessageIds = new Set<string>();
			return projectedMessages.map((message, messageIndex) => {
				const sourceMessageId = sourceMessageIdForContextMessage(
					entry,
					messageIndex,
					entries,
					consumedRetainedMessageIds,
				);
				const messageId = sourceMessageId ?? `context-${entry.id}-${messageIndex}`;
				return {
					messageId,
					message,
					...(metadataByMessageId.has(messageId) ? { metadata: metadataByMessageId.get(messageId) } : {}),
				};
			});
		});
	}

	async buildContext(sessionId: string): Promise<SessionContext> {
		const session = await this.openSession(sessionId);
		const leafId = await session.getLeafId();
		if (leafId === null) return buildSessionContext([]);
		const entries = await session.findEntriesOnBranch({ start: leafId, order: "oldestFirst" });
		await this.refreshOptionalCompactionCheckpoint(sessionId, await session.getMetadata(), entries);
		return buildSessionContext(entries);
	}

	/** Full active-branch transcript for UI history; compaction only changes model input. */
	async listTranscriptMessages(sessionId: string): Promise<DesktopStoredMessage[]> {
		const session = await this.openSession(sessionId);
		const leafId = await session.getLeafId();
		if (leafId === null) return [];
		const entries = await session.findEntriesOnBranch({ start: leafId, order: "oldestFirst" });
		const metadata = messageMetadataById(entries);
		return entries.flatMap((entry) => entry.type === "message" ? [{
			messageId: entry.id,
			message: entry.message,
			...(metadata.has(entry.id) ? { metadata: metadata.get(entry.id) } : {}),
		}] : []);
	}

	async flushOutbox(controlStore: DesktopAgentControlStore, sessionId?: string): Promise<number> {
		let delivered = 0;
		while (true) {
			const pending = controlStore.listPendingOutbox(sessionId);
			if (pending.length === 0) return delivered;
			const grouped = new Map<string, typeof pending>();
			for (const item of pending) {
				const group = grouped.get(item.sessionId) ?? [];
				group.push(item);
				grouped.set(item.sessionId, group);
			}

			for (const [pendingSessionId, items] of grouped) {
				await this.withSessionMutation(pendingSessionId, async () => {
					const session = await this.openSession(pendingSessionId);
					const existingEntries = await session.findEntries({
						type: "custom",
						customType: RUN_EVENT_ENTRY_TYPE,
						order: "oldestFirst",
					});
					const recordedOutboxIds = new Set<string>();
					for (const entry of existingEntries) {
						if (
							entry.type !== "custom" ||
							typeof entry.data !== "object" ||
							entry.data === null ||
							Array.isArray(entry.data)
						)
							continue;
						const outboxId = "outboxId" in entry.data ? entry.data.outboxId : undefined;
						if (typeof outboxId === "string") recordedOutboxIds.add(outboxId);
					}
					for (const item of items) {
						if (!recordedOutboxIds.has(item.outboxId)) {
							await session.appendCustomEntry(RUN_EVENT_ENTRY_TYPE, {
								outboxId: item.outboxId,
								event: item.payload,
							});
							recordedOutboxIds.add(item.outboxId);
						}
						if (controlStore.markOutboxDelivered(item.outboxId)) delivered += 1;
					}
				});
			}
		}
	}

	async close(): Promise<void> {
		await Promise.all(this.sessionMutationTails.values());
		await this.fileSystem.cleanup();
	}

	private async withSessionMutation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.sessionMutationTails.get(sessionId) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.sessionMutationTails.set(sessionId, current);
		await previous;
		try {
			return await operation();
		} finally {
			release();
			if (this.sessionMutationTails.get(sessionId) === current) this.sessionMutationTails.delete(sessionId);
		}
	}

	private async refreshOptionalCompactionCheckpoint(
		sessionId: string,
		metadata: JsonlSessionMetadata,
		entries: readonly Entry[],
	): Promise<void> {
		const latestCompaction = [...entries].reverse().find((entry) => entry.type === "compaction");
		if (!latestCompaction || latestCompaction.type !== "compaction") return;
		const checkpoint = compactionCheckpoint(sessionId, latestCompaction);
		const checkpointPath = `${metadata.path}${COMPACTION_CHECKPOINT_SUFFIX}`;
		try {
			const parent = dirname(checkpointPath);
			if (await realpath(parent) !== parent) return;
			const info = await lstat(checkpointPath).catch(() => null);
			if (info && (!info.isFile() || info.isSymbolicLink())) return;
			if (info && info.size <= 1024 * 1024
				&& isMatchingCheckpoint(await readFile(checkpointPath, "utf8"), checkpoint)) return;
			await this.writeOptionalCheckpoint(checkpointPath, checkpoint);
		} catch {
			// Checkpoints are optional caches; JSONL remains the recovery source.
		}
	}

	private async writeOptionalCheckpoint(
		checkpointPath: string,
		checkpoint: DesktopAgentCompactionCheckpoint,
	): Promise<void> {
		const temporaryPath = `${checkpointPath}.${randomUUID()}.tmp`;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(temporaryPath, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify(checkpoint)}\n`, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temporaryPath, checkpointPath);
		} catch {
			// The JSONL entry is authoritative; checkpoint cache failures never block session recovery.
			await handle?.close().catch(() => undefined);
			await rm(temporaryPath, { force: true }).catch(() => undefined);
		}
	}
}

export function desktopCompactionSummary(context: SessionContext): string | undefined {
	const summaries = context.messages.flatMap((message) => message.role === "compactionSummary" ? [message.summary] : []);
	return summaries.length ? summaries.join("\n\n") : undefined;
}

function validateCompactionSummary(value: string): string {
	if (typeof value !== "string") throw new Error("AGENT_COMPACTION_INVALID");
	const summary = value.trim();
	if (
		summary.length < 8 ||
		summary.length > MAX_COMPACTION_SUMMARY_CHARACTERS ||
		/^compacted\s+\d+\s+messages\.?$/iu.test(summary)
	) {
		throw new Error("AGENT_COMPACTION_SUMMARY_REQUIRED");
	}
	return summary;
}

function contextMessagesForRetention(entries: readonly Entry[]): AgentMessage[] {
	const contextEntries = buildContextEntries(entries);
	return contextEntries.flatMap((entry, entryIndex) => {
		if (entry.type === "compaction") return entry.retainedTail;
		return sessionEntryToContextMessages(entry, entryIndex, contextEntries);
	});
}

function retainCompleteToolPairs(messages: readonly AgentMessage[], requestedTailSize: number): AgentMessage[] {
	const desiredStart = Math.max(0, messages.length - requestedTailSize);
	for (let start = desiredStart; start >= 0; start -= 1) {
		if (hasCompleteToolPairs(messages, start)) return messages.slice(start).map((message) => structuredClone(message));
	}
	// A dangling call in the requested tail cannot be fixed by retaining more
	// history. Trim forward past it, while still preferring to retain a complete
	// pair when the requested boundary splits one.
	for (let start = desiredStart + 1; start <= messages.length; start += 1) {
		if (hasCompleteToolPairs(messages, start)) return messages.slice(start).map((message) => structuredClone(message));
	}
	throw new Error("AGENT_COMPACTION_UNPAIRED_TOOL_CALL");
}

function hasCompleteToolPairs(messages: readonly AgentMessage[], start: number): boolean {
	const assistantCallIndexes = new Map<string, number[]>();
	const resultIndexes = new Map<string, number[]>();
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (!message) continue;
		for (const callId of toolCallIds(message)) {
			const indexes = assistantCallIndexes.get(callId) ?? [];
			indexes.push(index);
			assistantCallIndexes.set(callId, indexes);
		}
		const resultCallId = toolResultCallId(message);
		if (resultCallId) {
			const indexes = resultIndexes.get(resultCallId) ?? [];
			indexes.push(index);
			resultIndexes.set(resultCallId, indexes);
		}
	}
	for (let index = start; index < messages.length; index += 1) {
		const message = messages[index];
		if (!message) continue;
		for (const callId of toolCallIds(message)) {
			if (!callId || !(resultIndexes.get(callId) ?? []).some((resultIndex) => resultIndex > index)) return false;
		}
		const resultCallId = toolResultCallId(message);
		if (message.role === "toolResult" && !resultCallId) return false;
		if (
			resultCallId &&
			!(assistantCallIndexes.get(resultCallId) ?? []).some((callIndex) => callIndex >= start && callIndex < index)
		) {
			return false;
		}
	}
	return true;
}

function toolCallIds(message: AgentMessage): string[] {
	if (message.role !== "assistant" || typeof message.content === "string") return [];
	return message.content.flatMap((item) => {
		if (item.type !== "toolCall") return [];
		return [typeof item.id === "string" ? item.id : ""];
	});
}

function toolResultCallId(message: AgentMessage): string | undefined {
	if (message.role !== "toolResult") return undefined;
	return message.toolCallId || undefined;
}

function compactionCheckpoint(
	sessionId: string,
	entry: Extract<Entry, { type: "compaction" }>,
): DesktopAgentCompactionCheckpoint {
	const sourceHash = createHash("sha256")
		.update(
			JSON.stringify({
				sessionId,
				branchId: "main",
				id: entry.id,
				seq: entry.seq,
				parentId: entry.parentId,
				summary: entry.summary,
				retainedTail: entry.retainedTail,
				tokensBefore: entry.tokensBefore,
			}),
		)
		.digest("hex");
	return {
		schemaVersion: 1,
		sessionId,
		branchId: "main",
		throughEntryId: entry.id,
		throughEntrySeq: entry.seq,
		sourceHash,
		summary: entry.summary,
		createdAt: entry.timestamp,
	};
}

function isMatchingCheckpoint(value: string, expected: DesktopAgentCompactionCheckpoint): boolean {
	try {
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
		const checkpoint = parsed as Partial<DesktopAgentCompactionCheckpoint>;
		return (
			checkpoint.schemaVersion === expected.schemaVersion &&
			checkpoint.sessionId === expected.sessionId &&
			checkpoint.branchId === expected.branchId &&
			checkpoint.throughEntryId === expected.throughEntryId &&
			checkpoint.throughEntrySeq === expected.throughEntrySeq &&
			checkpoint.sourceHash === expected.sourceHash &&
			checkpoint.summary === expected.summary &&
			checkpoint.createdAt === expected.createdAt
		);
	} catch {
		return false;
	}
}

function normalizeMessageMetadata(value: unknown): DesktopAgentMessageMetadata {
	const raw = objectValue(value);
	const rawReferences = raw.nodeReferences;
	if (!Array.isArray(rawReferences) || rawReferences.length > MAX_MESSAGE_REFERENCES) {
		throw new Error("AGENT_REFERENCE_METADATA_INVALID");
	}
	const references = nodeReferencesFromMeta({ nodeReferences: rawReferences });
	if (references.length !== rawReferences.length) throw new Error("AGENT_REFERENCE_METADATA_INVALID");
	const nodeReferences = references.map((reference) => {
		if (reference.nodeId.length > MAX_MESSAGE_ID_LENGTH) throw new Error("AGENT_REFERENCE_METADATA_INVALID");
		const previewUrl = safeLocalPreviewUrl(reference.previewUrl);
		return {
			nodeId: reference.nodeId,
			nodeType: reference.nodeType,
			...(reference.creativeType ? { creativeType: reference.creativeType } : {}),
			title: reference.title,
			status: reference.status,
			...(previewUrl ? { previewUrl } : {}),
		};
	});

	const selectedNodeIds = raw.selectedNodeIds;
	if (
		!Array.isArray(selectedNodeIds) ||
		selectedNodeIds.length !== nodeReferences.length ||
		selectedNodeIds.some((nodeId, index) =>
			typeof nodeId !== "string" ||
			nodeId.length < 1 ||
			nodeId.length > MAX_MESSAGE_ID_LENGTH ||
			nodeId !== nodeReferences[index]?.nodeId,
		)
	) {
		throw new Error("AGENT_REFERENCE_METADATA_INVALID");
	}

	const selectedSkillId = raw.selectedSkillId;
	if (
		selectedSkillId !== undefined &&
		(typeof selectedSkillId !== "string" || selectedSkillId.length < 1 || selectedSkillId.length > MAX_SKILL_ID_LENGTH)
	) {
		throw new Error("AGENT_REFERENCE_METADATA_INVALID");
	}
	const metadata: DesktopAgentMessageMetadata = {
		selectedNodeIds: [...selectedNodeIds],
		nodeReferences,
		...(typeof selectedSkillId === "string" ? { selectedSkillId } : {}),
	};
	if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_METADATA_BYTES) {
		throw new Error("AGENT_REFERENCE_METADATA_INVALID");
	}
	return metadata;
}

function messageMetadataById(entries: readonly Entry[]): Map<string, DesktopAgentMessageMetadata> {
	const metadataByMessageId = new Map<string, DesktopAgentMessageMetadata>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MESSAGE_METADATA_ENTRY_TYPE) continue;
		const data = objectValue(entry.data);
		const messageId = boundedString(data.messageId, MAX_MESSAGE_ID_LENGTH);
		if (!messageId || metadataByMessageId.has(messageId)) continue;
		try {
			metadataByMessageId.set(messageId, normalizeMessageMetadata(data.metadata));
		} catch {
			// Ignore malformed imported/custom entries; they must not poison history loading.
		}
	}
	return metadataByMessageId;
}

function sourceMessageIdForContextMessage(
	entry: Entry,
	messageIndex: number,
	entries: readonly Entry[],
	consumedRetainedMessageIds: Set<string>,
): string | undefined {
	if (entry.type === "message") return entry.id;
	if (entry.type !== "compaction" || messageIndex === 0) return undefined;
	const retainedMessage = entry.retainedTail[messageIndex - 1];
	if (!retainedMessage) return undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const candidate = entries[index];
		if (
			candidate?.type === "message" &&
			candidate.seq < entry.seq &&
			!consumedRetainedMessageIds.has(candidate.id) &&
			JSON.stringify(candidate.message) === JSON.stringify(retainedMessage)
		) {
			consumedRetainedMessageIds.add(candidate.id);
			return candidate.id;
		}
	}
	return undefined;
}

function safeLocalPreviewUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const assetMatch = /^vibe:\/\/app\/assets\/([A-Za-z0-9_-]{1,128})$/u.exec(value);
	if (assetMatch) return `vibe://app/assets/${assetMatch[1]}`;
	const taskMatch = /^vibe:\/\/app\/tasks\/([A-Za-z0-9_-]{1,128})\/output(?:\?index=(0|[1-9][0-9]{0,5}))?$/u.exec(value);
	if (!taskMatch) return undefined;
	const index = taskMatch[2];
	return `vibe://app/tasks/${taskMatch[1]}/output${index && index !== "0" ? `?index=${index}` : ""}`;
}

function objectValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function boundedString(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	const normalized = String(value).replace(/\s+/g, " ").trim();
	return normalized ? normalized.slice(0, maxLength) : undefined;
}
