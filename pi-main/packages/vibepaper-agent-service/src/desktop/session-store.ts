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
		const session = await this.openSession(sessionId);
		const messageId = await session.appendMessage(message);
		if (safeMetadata) {
			await session.appendCustomEntry(MESSAGE_METADATA_ENTRY_TYPE, { messageId, metadata: safeMetadata });
		}
		return messageId;
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
		return buildSessionContext(entries);
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
			}
		}
	}

	async close(): Promise<void> {
		await this.fileSystem.cleanup();
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
