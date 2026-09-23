import {
	type AgentRun,
	type AgentRunEvent,
	type AgentRunEventType,
	type AgentRunStatus,
	isActiveRunStatus,
} from "../domain/agent-run.ts";
import { nextId } from "../infrastructure/ids.ts";

export type StartRunInput = { sessionId: string; idempotencyKey: string };

export interface RunRepository {
	findByIdempotency(sessionId: string, idempotencyKey: string): AgentRun | undefined | Promise<AgentRun | undefined>;
	findActive(sessionId: string): AgentRun | undefined | Promise<AgentRun | undefined>;
	findById(runId: string): AgentRun | undefined | Promise<AgentRun | undefined>;
	startRunAtomic?: (input: StartRunInput & { runId: string; createdAt: Date }) => AgentRun | Promise<AgentRun>;
	save(run: AgentRun): void | Promise<void>;
	updateStatus(runId: string, status: AgentRunStatus): void | Promise<void>;
	appendEvent(event: AgentRunEvent): void | Promise<void>;
	listEvents(runId: string): readonly AgentRunEvent[] | Promise<readonly AgentRunEvent[]>;
	listSessionEvents?: (
		sessionId: string,
		afterSeq?: number,
	) => readonly AgentRunEvent[] | Promise<readonly AgentRunEvent[]>;
	appendEventAtomic?: (input: {
		runId: string;
		type: AgentRunEventType;
		data: Record<string, unknown>;
	}) => AgentRunEvent | Promise<AgentRunEvent>;
	setStatusAtomic?: (input: {
		runId: string;
		status: AgentRunStatus;
		terminalEvent?: { type: AgentRunEventType; data: Record<string, unknown> };
	}) => void | Promise<void>;
	cancelIfActive?: (runId: string) => boolean | Promise<boolean>;
	cancelIfActiveAtomic?: (runId: string) => boolean | Promise<boolean>;
}

export class RunConflictError extends Error {
	readonly code = "SESSION_BUSY";

	constructor(message = "会话已有运行中的任务") {
		super(message);
		this.name = "RunConflictError";
	}
}

export class SessionRunService {
	private readonly repository: RunRepository;

	constructor(repository: RunRepository) {
		this.repository = repository;
	}

	async startRun(input: StartRunInput): Promise<AgentRun> {
		if (this.repository.startRunAtomic)
			return await this.repository.startRunAtomic({ ...input, runId: nextId(), createdAt: new Date() });
		const existing = await this.repository.findByIdempotency(input.sessionId, input.idempotencyKey);
		if (existing) return existing;
		const active = await this.repository.findActive(input.sessionId);
		if (active) throw new RunConflictError();
		const now = new Date();
		const run: AgentRun = {
			runId: nextId(),
			sessionId: input.sessionId,
			idempotencyKey: input.idempotencyKey,
			status: "queued",
			createdAt: now,
			updatedAt: now,
		};
		await this.repository.save(run);
		return run;
	}

	async findActive(sessionId: string): Promise<AgentRun | undefined> {
		return await this.repository.findActive(sessionId);
	}

	async appendEvent(runId: string, type: AgentRunEventType, data: Record<string, unknown>): Promise<AgentRunEvent> {
		const run = await this.requireRun(runId);
		if (!isActiveRunStatus(run.status)) throw new Error("RUN_NOT_ACTIVE");
		if (this.repository.appendEventAtomic) return await this.repository.appendEventAtomic({ runId, type, data });
		return await this.append(run, type, data);
	}

	async setStatus(runId: string, status: AgentRunStatus, data: Record<string, unknown> = {}): Promise<void> {
		const terminalType =
			status === "completed"
				? "run_completed"
				: status === "failed"
					? "run_failed"
					: status === "aborted"
						? "run_aborted"
						: undefined;
		if (this.repository.setStatusAtomic) {
			await this.repository.setStatusAtomic({
				runId,
				status,
				...(terminalType ? { terminalEvent: { type: terminalType, data } } : {}),
			});
			return;
		}
		const run = await this.requireRun(runId);
		const existingTerminal = terminalType
			? (await this.repository.listEvents(runId)).some((event) => event.type === terminalType)
			: false;
		await this.repository.updateStatus(runId, status);
		// Runtime error events are persisted before the route marks the run as
		// failed. Do not append a second terminal event for the same run: the
		// duplicate used to produce two red error toasts for one upstream failure.
		if (existingTerminal) return;
		if (status === "completed") await this.append(run, "run_completed", data);
		if (status === "failed") await this.append(run, "run_failed", data);
	}

	async cancelRun(runId: string): Promise<boolean> {
		if (this.repository.cancelIfActiveAtomic) return await this.repository.cancelIfActiveAtomic(runId);
		if (this.repository.cancelIfActive) {
			const canceled = await this.repository.cancelIfActive(runId);
			if (!canceled) return false;
			const run = await this.requireRun(runId);
			await this.append(run, "run_aborted", {});
			return true;
		}
		const run = await this.repository.findById(runId);
		if (!run || !isActiveRunStatus(run.status)) return false;
		await this.repository.updateStatus(runId, "aborted");
		await this.append(run, "run_aborted", {});
		return true;
	}

	async listEvents(runId: string, afterSeq = 0): Promise<readonly AgentRunEvent[]> {
		return (await this.repository.listEvents(runId)).filter((event) => event.eventSeq > afterSeq);
	}

	async listSessionEvents(sessionId: string, afterSeq = 0): Promise<readonly AgentRunEvent[]> {
		if (this.repository.listSessionEvents)
			return (await this.repository.listSessionEvents(sessionId, afterSeq)).filter(
				(event) => event.eventSeq > afterSeq,
			);
		const run = await this.repository.findActive(sessionId);
		return run ? await this.listEvents(run.runId, afterSeq) : [];
	}

	private async requireRun(runId: string): Promise<AgentRun> {
		const run = await this.repository.findById(runId);
		if (!run) throw new Error("RUN_NOT_FOUND");
		return run;
	}

	private async append(run: AgentRun, type: AgentRunEventType, data: Record<string, unknown>): Promise<AgentRunEvent> {
		const current = await this.repository.listEvents(run.runId);
		const event: AgentRunEvent = {
			eventId: nextId(),
			runId: run.runId,
			sessionId: run.sessionId,
			eventSeq: (current.at(-1)?.eventSeq ?? 0) + 1,
			type,
			runtime: "pi",
			runtimeVersion: "0.1.0",
			data,
			createdAt: new Date(),
		};
		await this.repository.appendEvent(event);
		return event;
	}
}

export class InMemoryRunRepository implements RunRepository {
	private readonly runs = new Map<string, AgentRun>();
	private readonly events = new Map<string, AgentRunEvent[]>();

	get(runId: string): AgentRun | undefined {
		return this.runs.get(runId);
	}

	findByIdempotency(sessionId: string, idempotencyKey: string): AgentRun | undefined {
		return [...this.runs.values()].find(
			(run) => run.sessionId === sessionId && run.idempotencyKey === idempotencyKey,
		);
	}

	findActive(sessionId: string): AgentRun | undefined {
		return [...this.runs.values()].find((run) => run.sessionId === sessionId && isActiveRunStatus(run.status));
	}

	findById(runId: string): AgentRun | undefined {
		return this.runs.get(runId);
	}

	save(run: AgentRun): void {
		this.runs.set(run.runId, run);
	}

	updateStatus(runId: string, status: AgentRunStatus): void {
		const run = this.runs.get(runId);
		if (run) this.runs.set(runId, { ...run, status, updatedAt: new Date() });
	}

	appendEvent(event: AgentRunEvent): void {
		const events = this.events.get(event.runId) ?? [];
		events.push(event);
		this.events.set(event.runId, events);
	}

	listEvents(runId: string): readonly AgentRunEvent[] {
		return this.listEventsSync(runId);
	}

	listEventsSync(runId: string): readonly AgentRunEvent[] {
		return [...(this.events.get(runId) ?? [])];
	}

	listSessionEvents(sessionId: string, afterSeq = 0): readonly AgentRunEvent[] {
		return [...this.events.values()]
			.flat()
			.filter((event) => event.sessionId === sessionId && event.eventSeq > afterSeq)
			.sort((left, right) => left.eventSeq - right.eventSeq);
	}
}
