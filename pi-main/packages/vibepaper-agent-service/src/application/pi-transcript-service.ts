import { nextId } from "../infrastructure/ids.ts";

export type TranscriptEntry = {
	entryId: string;
	kind: "user" | "assistant" | "tool_call" | "tool_result" | "pending_action" | "run_stop";
	content: string;
	tool?: string;
	actionId?: string;
	effectId?: string;
	createdAt: Date;
};

export type TranscriptInput = Omit<TranscriptEntry, "entryId" | "createdAt">;

export interface TranscriptRepository {
	append(runId: string, entry: TranscriptEntry): void | Promise<void>;
	list(runId: string): readonly TranscriptEntry[] | Promise<readonly TranscriptEntry[]>;
}

export class PiTranscriptService {
	private readonly repository: TranscriptRepository;
	private readonly statuses = new Map<
		string,
		"queued" | "running" | "waiting_confirmation" | "waiting_task" | "completed" | "failed" | "aborted"
	>();
	private readonly effects = new Set<string>();

	constructor(repository: TranscriptRepository) {
		this.repository = repository;
	}

	async append(runId: string, input: TranscriptInput): Promise<TranscriptEntry> {
		const entry: TranscriptEntry = { ...input, entryId: nextId(), createdAt: new Date() };
		await this.repository.append(runId, entry);
		return entry;
	}

	async recover(runId: string): Promise<readonly TranscriptEntry[]> {
		return await this.repository.list(runId);
	}

	setRunStatus(
		runId: string,
		status: "queued" | "running" | "waiting_confirmation" | "waiting_task" | "completed" | "failed" | "aborted",
	): void {
		this.statuses.set(runId, status);
	}

	async steer(runId: string, content: string): Promise<boolean> {
		const status = this.statuses.get(runId);
		if (status !== "running" && status !== "queued") return false;
		await this.append(runId, { kind: "user", content });
		await this.append(runId, { kind: "run_stop", content: "stop after current turn" });
		return true;
	}

	async followUp(runId: string, content: string): Promise<boolean> {
		const status = this.statuses.get(runId);
		if (status !== "waiting_confirmation" && status !== "waiting_task") return false;
		await this.append(runId, { kind: "user", content });
		return true;
	}

	async recordEffect(_runId: string, effectId: string): Promise<boolean> {
		if (this.effects.has(effectId)) return false;
		this.effects.add(effectId);
		return true;
	}
}

export class InMemoryTranscriptRepository implements TranscriptRepository {
	private readonly entries = new Map<string, TranscriptEntry[]>();

	append(runId: string, entry: TranscriptEntry): void {
		const entries = this.entries.get(runId) ?? [];
		entries.push(entry);
		this.entries.set(runId, entries);
	}

	list(runId: string): readonly TranscriptEntry[] {
		return [...(this.entries.get(runId) ?? [])];
	}
}
