import {
	type AgentMessage,
	buildSessionContext,
	type FileError,
	type JsonlSessionMetadata,
	JsonlSessionRepo,
	type Result,
	type Session,
	type SessionContext,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { DesktopAgentControlStore } from "./control-store.ts";

const RUN_EVENT_ENTRY_TYPE = "vibepaper_run_event";

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

	async appendMessage(sessionId: string, message: AgentMessage): Promise<string> {
		const session = await this.openSession(sessionId);
		return await session.appendMessage(message);
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
