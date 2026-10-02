import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
	type AgentMessage,
	buildContextEntries,
	buildSessionContext,
	type Entry,
	type FileError,
	type JsonlSessionMetadata,
	JsonlSessionRepo,
	type Result,
	type Session,
	type SessionContext,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
	composeUserContent,
	type NodeReferenceSnapshot,
	nodeReferencesFromMeta,
} from "../application/node-reference-context.ts";
import type { DesktopAgentControlStore, DesktopAgentSessionState, DesktopAgentSessionStatus } from "./control-store.ts";
import type { DesktopAgentSkillSnapshot } from "./skill-context.ts";

const RUN_EVENT_ENTRY_TYPE = "vibepaper_run_event";
const MESSAGE_METADATA_ENTRY_TYPE = "vibepaper_message_metadata";
const MAX_MESSAGE_REFERENCES = 8;
const MAX_MESSAGE_ID_LENGTH = 128;
const MAX_MESSAGE_RUN_ID_LENGTH = 128;
const MAX_SKILL_ID_LENGTH = 160;
const MAX_METADATA_BYTES = 96 * 1024;
const LEGACY_RUN_TIMESTAMP_SKEW_MS = 1_000;
const DEFAULT_SESSION_TITLE = "新对话";
const MAX_SESSION_TITLE_CHARACTERS = 48;

export type DesktopAgentReferenceCard = Pick<
	NodeReferenceSnapshot,
	"nodeId" | "nodeType" | "creativeType" | "title" | "status" | "previewUrl"
>;

export type DesktopAgentMessageMetadata = {
	selectedNodeIds: string[];
	nodeReferences: DesktopAgentReferenceCard[];
	selectedSkillId?: string;
	runId?: string;
};

export type DesktopAgentTimelineRun = {
	runId: string;
	sessionId: string;
	createdAt: number;
};

export type DesktopAgentSessionView = {
	sessionId: string;
	title: string;
	status: Exclude<DesktopAgentSessionStatus, "deleted">;
	canvasId?: string;
	createdAt: number;
	modifiedAt: number;
};

export type DesktopAgentSessionPatch = {
	title?: string;
	status?: "active" | "archived";
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
	private readonly controlStore?: DesktopAgentControlStore;
	private readonly sessionMutationTails = new Map<string, Promise<void>>();

	constructor(
		projectId: string,
		projectDirectory: string,
		sessionsRoot: string,
		controlStore?: DesktopAgentControlStore,
	) {
		this.projectId = projectId;
		this.controlStore = controlStore;
		this.fileSystem = new RelocatableSessionExecutionEnv(projectDirectory, projectId);
		this.repo = new JsonlSessionRepo({ fs: this.fileSystem, sessionsRoot });
	}

	async createSession(title?: string, canvasId?: string): Promise<JsonlSessionMetadata> {
		if (canvasId !== undefined && !isBoundedString(canvasId, 1, MAX_MESSAGE_ID_LENGTH))
			throw new Error("SESSION_INPUT_INVALID");
		const session = await this.repo.create({
			cwd: this.fileSystem.sessionCwd,
			metadata: {
				application: "VibePaper Desktop",
				projectId: this.projectId,
				...(canvasId ? { canvasId } : {}),
			},
		});
		if (title?.trim()) await session.setName(title.trim().slice(0, 120));
		return await session.getMetadata();
	}

	async listSessions(): Promise<JsonlSessionMetadata[]> {
		return await this.repo.list({ cwd: this.fileSystem.sessionCwd });
	}

	async openSession(sessionId: string): Promise<Session<JsonlSessionMetadata>> {
		const state = this.controlStore?.getSessionState(sessionId);
		if (state?.status === "deleted") throw new Error("SESSION_NOT_FOUND");
		return this.openStoredSession(sessionId);
	}

	private async openStoredSession(sessionId: string): Promise<Session<JsonlSessionMetadata>> {
		const metadata = (await this.listSessions()).find((candidate) => candidate.id === sessionId);
		if (!metadata) throw new Error("SESSION_NOT_FOUND");
		return await this.repo.open(metadata);
	}

	async getSession(sessionId: string): Promise<DesktopAgentSessionView> {
		const metadata = (await this.listSessions()).find((candidate) => candidate.id === sessionId);
		if (!metadata) throw new Error("SESSION_NOT_FOUND");
		const state = this.controlStore?.getSessionState(sessionId) ?? { status: "active" as const };
		if (state.status === "deleted") throw new Error("SESSION_NOT_FOUND");
		const title = await this.resolveSessionTitle(sessionId);
		return toSessionView(metadata, title, state);
	}

	async listAgentSessions(
		options: { status?: "active" | "archived" | "all"; search?: string } = {},
	): Promise<DesktopAgentSessionView[]> {
		if (typeof options !== "object" || options === null || Array.isArray(options))
			throw new Error("SESSION_FILTER_INVALID");
		if (
			options.status !== undefined &&
			options.status !== "active" &&
			options.status !== "archived" &&
			options.status !== "all"
		)
			throw new Error("SESSION_STATUS_INVALID");
		if (options.search !== undefined && (typeof options.search !== "string" || options.search.length > 160))
			throw new Error("SESSION_FILTER_INVALID");
		const metadata = await this.listSessions();
		const states = this.controlStore?.listSessionStates() ?? new Map<string, DesktopAgentSessionState>();
		const normalizedSearch = options.search?.trim().toLocaleLowerCase() ?? "";
		const sessions = await Promise.all(
			metadata.map(async (session): Promise<DesktopAgentSessionView | undefined> => {
				const state = states.get(session.id) ?? { status: "active" as const };
				if (
					state.status === "deleted" ||
					(options.status && options.status !== "all" && options.status !== state.status)
				)
					return undefined;
				const title = await this.resolveSessionTitle(session.id);
				if (normalizedSearch && !title.toLocaleLowerCase().includes(normalizedSearch)) return undefined;
				return toSessionView(session, title, state);
			}),
		);
		return sessions
			.filter((session): session is DesktopAgentSessionView => session !== undefined)
			.sort((left, right) => right.modifiedAt - left.modifiedAt || right.sessionId.localeCompare(left.sessionId));
	}

	async hasSession(sessionId: string): Promise<boolean> {
		const metadata = (await this.listSessions()).find((candidate) => candidate.id === sessionId);
		if (!metadata) return false;
		return this.controlStore?.getSessionState(sessionId).status !== "deleted";
	}

	async isSessionActive(sessionId: string): Promise<boolean> {
		if (!(await this.hasSession(sessionId))) return false;
		return this.controlStore?.getSessionState(sessionId).status !== "archived";
	}

	async updateSession(sessionId: string, patch: DesktopAgentSessionPatch): Promise<DesktopAgentSessionView> {
		if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("SESSION_PATCH_INVALID");
		if (Object.hasOwn(patch, "title") && typeof patch.title !== "string") throw new Error("SESSION_TITLE_INVALID");
		if (Object.hasOwn(patch, "status") && typeof patch.status !== "string") throw new Error("SESSION_STATUS_INVALID");
		const titleInput = typeof patch.title === "string" && patch.title.trim() ? patch.title.trim() : undefined;
		const statusInput = typeof patch.status === "string" && patch.status.trim() ? patch.status.trim() : undefined;
		if (titleInput === undefined && statusInput === undefined) throw new Error("SESSION_PATCH_INVALID");
		if (statusInput !== undefined && statusInput !== "active" && statusInput !== "archived") {
			throw new Error("SESSION_STATUS_INVALID");
		}
		const current = await this.getSession(sessionId);
		if (titleInput !== undefined) {
			const title = normalizeSessionTitle(titleInput);
			await this.withSessionMutation(sessionId, async () => {
				const session = await this.openSession(sessionId);
				await session.setName(title);
			});
		}
		if (statusInput !== undefined) {
			if (statusInput !== current.status) this.requireControlStore().setSessionStatus(sessionId, statusInput);
		}
		return this.getSession(sessionId);
	}

	async deleteSession(sessionId: string): Promise<{ status: "deleted"; sessionId: string }> {
		await this.getSession(sessionId);
		this.requireControlStore().setSessionStatus(sessionId, "deleted");
		return { status: "deleted", sessionId };
	}

	async copySession(
		sessionId: string,
		options: { title?: string; canvasId?: string } = {},
	): Promise<DesktopAgentSessionView & { copiedFrom: string }> {
		if (typeof options !== "object" || options === null || Array.isArray(options))
			throw new Error("SESSION_INPUT_INVALID");
		if (options.title !== undefined && typeof options.title !== "string") throw new Error("SESSION_TITLE_INVALID");
		if (options.canvasId !== undefined && !isBoundedString(options.canvasId, 1, MAX_MESSAGE_ID_LENGTH))
			throw new Error("SESSION_INPUT_INVALID");
		const source = await this.getSession(sessionId);
		const canvasId = options.canvasId ?? source.canvasId;
		const title = normalizeSessionTitle(options.title?.trim() || `${source.title} 副本`);
		const copy = await this.createSession(title, canvasId);
		const view = await this.getSession(copy.id);
		return { ...view, copiedFrom: source.sessionId };
	}

	async setSessionSkillSnapshots(
		sessionId: string,
		snapshots: readonly DesktopAgentSkillSnapshot[],
	): Promise<DesktopAgentSkillSnapshot[]> {
		const session = await this.getSession(sessionId);
		if (session.status !== "active") throw new Error("SESSION_ARCHIVED");
		return this.requireControlStore().setSessionSkillSnapshots(sessionId, snapshots);
	}

	async attachSessionSkillSnapshot(
		sessionId: string,
		snapshot: DesktopAgentSkillSnapshot,
	): Promise<{ snapshot: DesktopAgentSkillSnapshot; attached: boolean }> {
		const session = await this.getSession(sessionId);
		if (session.status !== "active") throw new Error("SESSION_ARCHIVED");
		return this.requireControlStore().attachSessionSkillSnapshot(sessionId, snapshot);
	}

	async resolveSessionTitle(sessionId: string): Promise<string> {
		return this.withSessionMutation(sessionId, async () => {
			const session = await this.openSession(sessionId);
			const state = this.controlStore?.getSessionState(sessionId);
			const currentTitle = (await session.getName())?.trim() ?? "";
			if (currentTitle && !isPlaceholderSessionTitle(currentTitle)) return currentTitle;

			const entries = await session.findEntries({ order: "oldestFirst" });
			const recoveredTitle = firstUserTextTitle(entries);
			if (recoveredTitle) {
				if (currentTitle !== recoveredTitle && state?.status !== "archived") await session.setName(recoveredTitle);
				return recoveredTitle;
			}
			return currentTitle || DEFAULT_SESSION_TITLE;
		});
	}

	async appendMessage(
		sessionId: string,
		message: AgentMessage,
		metadata?: DesktopAgentMessageMetadata,
	): Promise<string> {
		this.assertSessionActive(sessionId);
		const safeMetadata = metadata === undefined ? undefined : normalizeMessageMetadata(metadata);
		return this.withSessionMutation(sessionId, async () => {
			const session = await this.openSession(sessionId);
			const messageId = await session.appendMessage(omitOptionalUndefined(message));
			if (safeMetadata) {
				await session.appendCustomEntry(MESSAGE_METADATA_ENTRY_TYPE, { messageId, metadata: safeMetadata });
			}
			return messageId;
		});
	}

	async appendSummaryUsage(
		sessionId: string,
		response: {
			provider: string;
			model: string;
			usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
		},
	): Promise<void> {
		this.assertSessionActive(sessionId);
		const usage = Object.fromEntries(
			["input", "output", "cacheRead", "cacheWrite"].map((key) => {
				const count = response.usage[key as keyof typeof response.usage];
				if (!Number.isSafeInteger(count) || count < 0) throw new Error("AGENT_USAGE_INVALID");
				return [key, count];
			}),
		);
		if (
			typeof response.provider !== "string" ||
			response.provider.length > 128 ||
			typeof response.model !== "string" ||
			response.model.length > 256
		)
			throw new Error("AGENT_USAGE_INVALID");
		await this.withSessionMutation(sessionId, async () => {
			const session = await this.openSession(sessionId);
			await session.appendCustomEntry("vibepaper_summary_usage", {
				provider: response.provider,
				model: response.model,
				usage,
			});
		});
	}

	/**
	 * Append a Pi compaction entry to the active main branch and reload its context from JSONL.
	 * Existing message entries remain intact; the entry changes only the context projection.
	 */
	async appendCompaction(sessionId: string, input: DesktopAgentCompactionInput): Promise<SessionContext> {
		this.assertSessionActive(sessionId);
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
		return buildSessionContext(contextEntriesWithReferences(entries));
	}

	/** Full active-branch transcript for UI history; compaction only changes model input. */
	async listTranscriptMessages(
		sessionId: string,
		runs: readonly DesktopAgentTimelineRun[] = [],
	): Promise<DesktopStoredMessage[]> {
		const session = await this.openSession(sessionId);
		const leafId = await session.getLeafId();
		if (leafId === null) return [];
		const entries = await session.findEntriesOnBranch({ start: leafId, order: "oldestFirst" });
		const metadata = messageMetadataById(entries);
		const legacyRunBindings = buildDesktopLegacyMessageRunBindings(entries, sessionId, runs);
		return entries.flatMap((entry) => {
			if (entry.type !== "message") return [];
			const savedMetadata = metadata.get(entry.id);
			const runId = savedMetadata?.runId ?? legacyRunBindings.get(entry.id);
			const messageMetadata = runId
				? { ...(savedMetadata ?? { selectedNodeIds: [], nodeReferences: [] }), runId }
				: savedMetadata;
			return [
				{
					messageId: entry.id,
					message: entry.message,
					...(messageMetadata ? { metadata: messageMetadata } : {}),
				},
			];
		});
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
					const session = await this.openStoredSession(pendingSessionId);
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

	private requireControlStore(): DesktopAgentControlStore {
		if (!this.controlStore) throw new Error("SESSION_STATE_STORE_REQUIRED");
		return this.controlStore;
	}

	private assertSessionActive(sessionId: string): void {
		const status = this.controlStore?.getSessionState(sessionId).status ?? "active";
		if (status === "deleted") throw new Error("SESSION_NOT_FOUND");
		if (status === "archived") throw new Error("SESSION_ARCHIVED");
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
			if ((await realpath(parent)) !== parent) return;
			const info = await lstat(checkpointPath).catch(() => null);
			if (info && (!info.isFile() || info.isSymbolicLink())) return;
			if (
				info &&
				info.size <= 1024 * 1024 &&
				isMatchingCheckpoint(await readFile(checkpointPath, "utf8"), checkpoint)
			)
				return;
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

// Pi tool results and local DTOs can contain optional properties set to undefined.
// JSONL requires actual JSON values. Omit only those object properties; leave
// invalid array entries, cycles and non-JSON objects for Pi's validator to reject.
function omitOptionalUndefined<T>(value: T, seen = new WeakMap<object, unknown>()): T {
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return seen.get(value) as T;
	if (Array.isArray(value)) {
		if (
			Object.getPrototypeOf(value) !== Array.prototype ||
			Object.getOwnPropertySymbols(value).length ||
			Object.getOwnPropertyNames(value).length !== value.length + 1 ||
			Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, index)).some(
				(descriptor) => !descriptor || !("value" in descriptor),
			)
		)
			return value;
		const copy: unknown[] = new Array(value.length);
		seen.set(value, copy);
		for (let index = 0; index < value.length; index++) {
			if (Object.hasOwn(value, index)) copy[index] = omitOptionalUndefined(value[index], seen);
		}
		return copy as T;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;
	if (
		Reflect.ownKeys(value).some((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
			return typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor);
		})
	)
		return value;
	const copy = Object.create(prototype) as Record<string, unknown>;
	seen.set(value, copy);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
		if ("value" in descriptor && descriptor.value === undefined) continue;
		Object.defineProperty(
			copy,
			key,
			"value" in descriptor ? { ...descriptor, value: omitOptionalUndefined(descriptor.value, seen) } : descriptor,
		);
	}
	return copy as T;
}

export function desktopCompactionSummary(context: SessionContext): string | undefined {
	const summaries = context.messages.flatMap((message) =>
		message.role === "compactionSummary" ? [message.summary] : [],
	);
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
	const contextEntries = buildContextEntries(contextEntriesWithReferences(entries));
	return contextEntries.flatMap((entry, entryIndex) => {
		if (entry.type === "compaction") return entry.retainedTail;
		return sessionEntryToContextMessages(entry, entryIndex, contextEntries);
	});
}

function retainCompleteToolPairs(messages: readonly AgentMessage[], requestedTailSize: number): AgentMessage[] {
	if (requestedTailSize === 0) return [];
	const desiredStart = Math.max(0, messages.length - requestedTailSize);
	const userTurnStarts = messages.flatMap((message, index) => (message.role === "user" ? [index] : []));
	if (userTurnStarts.length === 0) return [];
	const candidates = [
		...userTurnStarts.filter((index) => index <= desiredStart).reverse(),
		...userTurnStarts.filter((index) => index > desiredStart),
		messages.length,
	];
	for (const start of candidates) {
		if (hasCompleteToolPairs(messages, start)) {
			return messages.slice(start).map((message) => structuredClone(message));
		}
	}
	throw new Error("AGENT_COMPACTION_UNPAIRED_TOOL_CALL");
}

function contextEntriesWithReferences(entries: readonly Entry[]): Entry[] {
	const metadata = messageMetadataById(entries);
	const originalUserIds = new Map(
		entries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "user"
				? [[JSON.stringify(entry.message), entry.id] as const]
				: [],
		),
	);
	const project = (message: AgentMessage, messageId?: string): AgentMessage => {
		if (message.role !== "user") return message;
		const id = messageId ?? originalUserIds.get(JSON.stringify(message));
		const references = nodeReferencesFromMeta(id ? metadata.get(id) : undefined);
		if (!references.length) return message;
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
		return {
			...message,
			content: [
				{ type: "text" as const, text: composeUserContent(text, references) },
				...(Array.isArray(content) ? content.filter((block) => block.type !== "text") : []),
			],
		};
	};
	return entries.map((entry) => {
		if (entry.type === "message") return { ...entry, message: project(entry.message, entry.id) };
		if (entry.type === "compaction")
			return { ...entry, retainedTail: entry.retainedTail.map((message) => project(message)) };
		return entry;
	});
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

type DesktopLegacyRunEventMarker = {
	entrySeq: number;
	runId: string;
	eventSeq: number;
	type: string;
	createdAt: number;
};

type DesktopLegacyRunLifecycle = DesktopAgentTimelineRun & {
	firstEventAt: number;
	lastEventAt: number;
	lastEntrySeq: number;
	terminalAt?: number;
};

/**
 * Reassociate legacy transcript messages from their original JSONL branch order.
 * The returned IDs are a read-only projection: this helper never edits entries.
 */
export function buildDesktopLegacyMessageRunBindings(
	entries: readonly Entry[],
	sessionId: string,
	runs: readonly DesktopAgentTimelineRun[],
): Map<string, string> {
	const runById = new Map(
		runs
			.filter(
				(run) =>
					run.sessionId === sessionId &&
					isBoundedString(run.runId, 1, MAX_MESSAGE_RUN_ID_LENGTH) &&
					Number.isSafeInteger(run.createdAt) &&
					run.createdAt >= 0,
			)
			.map((run) => [run.runId, run] as const),
	);
	if (runById.size === 0 || sessionId.length < 1 || sessionId.length > MAX_MESSAGE_ID_LENGTH) return new Map();

	const eventMarkers: DesktopLegacyRunEventMarker[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== RUN_EVENT_ENTRY_TYPE) continue;
		const data = recordValue(entry.data);
		const event = recordValue(data?.event);
		const runId = boundedString(event?.runId, MAX_MESSAGE_RUN_ID_LENGTH);
		const eventSessionId = boundedString(event?.sessionId, MAX_MESSAGE_ID_LENGTH);
		const eventSeq = event?.eventSeq;
		const eventType = boundedString(event?.type, 64);
		const createdAt = timestampValue(event?.createdAt);
		const run = runId ? runById.get(runId) : undefined;
		if (
			!run ||
			eventSessionId !== sessionId ||
			!Number.isSafeInteger(entry.seq) ||
			!Number.isSafeInteger(eventSeq) ||
			Number(eventSeq) < 1 ||
			!eventType ||
			createdAt === undefined ||
			createdAt + LEGACY_RUN_TIMESTAMP_SKEW_MS < run.createdAt
		) {
			continue;
		}
		eventMarkers.push({
			entrySeq: entry.seq,
			runId: run.runId,
			eventSeq: Number(eventSeq),
			type: eventType,
			createdAt,
		});
	}
	if (eventMarkers.length === 0) return new Map();
	eventMarkers.sort((left, right) => left.entrySeq - right.entrySeq || left.eventSeq - right.eventSeq);

	const messages = entries.flatMap((entry) =>
		entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")
			? [{ entry, role: entry.message.role }]
			: [],
	);
	const bindings = new Map<string, string>();
	const userMessages = messages.filter((candidate) => candidate.role === "user");
	let messageIndex = 0;
	let eventIndex = 0;
	for (let userIndex = 0; userIndex < userMessages.length; userIndex += 1) {
		const userMessage = userMessages[userIndex];
		if (!userMessage) continue;
		const nextUserSeq = userMessages[userIndex + 1]?.entry.seq ?? Number.POSITIVE_INFINITY;
		while (eventIndex < eventMarkers.length && (eventMarkers[eventIndex]?.entrySeq ?? 0) <= userMessage.entry.seq) {
			eventIndex += 1;
		}
		const segmentEvents: DesktopLegacyRunEventMarker[] = [];
		while (eventIndex < eventMarkers.length && (eventMarkers[eventIndex]?.entrySeq ?? 0) < nextUserSeq) {
			const marker = eventMarkers[eventIndex];
			if (marker) segmentEvents.push(marker);
			eventIndex += 1;
		}
		if (segmentEvents.length === 0) continue;

		const lifecycles = legacyRunLifecycles(segmentEvents, runById);
		const userTimestamp = entryTimestamp(userMessage.entry);
		if (userTimestamp === undefined) continue;
		const userRunCandidates = lifecycles.filter(
			(lifecycle) =>
				lifecycle.createdAt <= userTimestamp + LEGACY_RUN_TIMESTAMP_SKEW_MS &&
				lifecycle.firstEventAt + LEGACY_RUN_TIMESTAMP_SKEW_MS >= userTimestamp &&
				lifecycle.lastEventAt + LEGACY_RUN_TIMESTAMP_SKEW_MS >= userTimestamp,
		);
		if (userRunCandidates.length !== 1) continue;
		const userRun = userRunCandidates[0];
		if (!userRun) continue;
		bindings.set(userMessage.entry.id, userRun.runId);

		while (messageIndex < messages.length && (messages[messageIndex]?.entry.seq ?? 0) <= userMessage.entry.seq) {
			messageIndex += 1;
		}
		while (messageIndex < messages.length && (messages[messageIndex]?.entry.seq ?? 0) < nextUserSeq) {
			const candidate = messages[messageIndex];
			messageIndex += 1;
			if (!candidate || candidate.role !== "assistant") continue;
			const messageTimestamp = entryTimestamp(candidate.entry);
			if (messageTimestamp === undefined) continue;
			const messageRunCandidates = lifecycles.filter(
				(lifecycle) =>
					lifecycle.createdAt <= messageTimestamp + LEGACY_RUN_TIMESTAMP_SKEW_MS &&
					lifecycle.endAt + LEGACY_RUN_TIMESTAMP_SKEW_MS >= messageTimestamp &&
					lifecycle.lastEntrySeq > candidate.entry.seq &&
					lifecycle.lastEventAt + LEGACY_RUN_TIMESTAMP_SKEW_MS >= messageTimestamp,
			);
			if (messageRunCandidates.length === 1) {
				const messageRun = messageRunCandidates[0];
				if (messageRun) bindings.set(candidate.entry.id, messageRun.runId);
			}
		}
	}
	return bindings;
}

function legacyRunLifecycles(
	markers: readonly DesktopLegacyRunEventMarker[],
	runById: ReadonlyMap<string, DesktopAgentTimelineRun>,
): Array<DesktopLegacyRunLifecycle & { endAt: number }> {
	const grouped = new Map<string, DesktopLegacyRunEventMarker[]>();
	for (const marker of markers) {
		const group = grouped.get(marker.runId) ?? [];
		group.push(marker);
		grouped.set(marker.runId, group);
	}
	return [...grouped].flatMap(([runId, runMarkers]) => {
		const run = runById.get(runId);
		if (!run || runMarkers.length === 0) return [];
		const bounds = runMarkers.reduce(
			(current, marker) => ({
				firstEventAt: Math.min(current.firstEventAt, marker.createdAt),
				lastEventAt: Math.max(current.lastEventAt, marker.createdAt),
				lastEntrySeq: Math.max(current.lastEntrySeq, marker.entrySeq),
				terminalAt:
					marker.type === "run_completed" || marker.type === "run_failed" || marker.type === "run_aborted"
						? Math.max(current.terminalAt ?? 0, marker.createdAt)
						: current.terminalAt,
			}),
			{
				firstEventAt: Number.POSITIVE_INFINITY,
				lastEventAt: 0,
				lastEntrySeq: 0,
				terminalAt: undefined as number | undefined,
			},
		);
		const { firstEventAt, lastEventAt, lastEntrySeq, terminalAt } = bounds;
		return [
			{
				...run,
				firstEventAt,
				lastEventAt,
				lastEntrySeq,
				...(terminalAt === undefined ? {} : { terminalAt }),
				endAt: terminalAt ?? lastEventAt,
			},
		];
	});
}

function entryTimestamp(entry: Extract<Entry, { type: "message" }>): number | undefined {
	return Number.isSafeInteger(entry.timestamp) && entry.timestamp >= 0 ? entry.timestamp : undefined;
}

function timestampValue(value: unknown): number | undefined {
	const timestamp =
		value instanceof Date
			? value.getTime()
			: typeof value === "number"
				? value
				: typeof value === "string"
					? Date.parse(value)
					: Number.NaN;
	return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
	return typeof value === "string" && value.length >= minimum && value.length <= maximum;
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
		selectedNodeIds.some(
			(nodeId, index) =>
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
		(typeof selectedSkillId !== "string" ||
			selectedSkillId.length < 1 ||
			selectedSkillId.length > MAX_SKILL_ID_LENGTH)
	) {
		throw new Error("AGENT_REFERENCE_METADATA_INVALID");
	}
	const runId = raw.runId;
	if (runId !== undefined && !isBoundedString(runId, 1, MAX_MESSAGE_RUN_ID_LENGTH)) {
		throw new Error("AGENT_REFERENCE_METADATA_INVALID");
	}
	const metadata: DesktopAgentMessageMetadata = {
		selectedNodeIds: [...selectedNodeIds],
		nodeReferences,
		...(typeof selectedSkillId === "string" ? { selectedSkillId } : {}),
		...(typeof runId === "string" ? { runId } : {}),
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
	const taskMatch = /^vibe:\/\/app\/tasks\/([A-Za-z0-9_-]{1,128})\/output(?:\?index=(0|[1-9][0-9]{0,5}))?$/u.exec(
		value,
	);
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

function toSessionView(
	metadata: JsonlSessionMetadata,
	title: string,
	state: DesktopAgentSessionState,
): DesktopAgentSessionView {
	if (state.status === "deleted") throw new Error("SESSION_NOT_FOUND");
	const canvasId = metadata.metadata?.canvasId;
	const modifiedAt = Math.max(metadata.modifiedAt, state.updatedAt?.getTime() ?? 0);
	return {
		sessionId: metadata.id,
		title,
		status: state.status,
		...(typeof canvasId === "string" && canvasId.length > 0 ? { canvasId } : {}),
		createdAt: metadata.createdAt,
		modifiedAt,
	};
}

function normalizeSessionTitle(value: string): string {
	if (typeof value !== "string") throw new Error("SESSION_TITLE_INVALID");
	const title = value.trim().slice(0, 120);
	if (!title) throw new Error("SESSION_TITLE_INVALID");
	return title;
}

function isPlaceholderSessionTitle(title: string): boolean {
	return title === DEFAULT_SESSION_TITLE || title === "画布对话";
}

function firstUserTextTitle(entries: readonly Entry[]): string | undefined {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("");
		const title = text.trim().slice(0, MAX_SESSION_TITLE_CHARACTERS);
		if (title) return title;
	}
	return undefined;
}
