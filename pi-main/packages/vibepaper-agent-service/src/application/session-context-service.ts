import type { AgentRunEvent } from "../domain/agent-run.ts";
import {
	createSessionContext,
	formatSessionContext,
	reduceSessionEvents,
	type SessionContext,
} from "../domain/session-context.ts";

export interface SessionContextRepository {
	get(sessionId: string): SessionContext | undefined | Promise<SessionContext | undefined>;
	save(context: SessionContext): void | Promise<void>;
}

export class SessionContextService {
	private readonly repository: SessionContextRepository;

	constructor(repository: SessionContextRepository) {
		this.repository = repository;
	}

	async load(sessionId: string, canvasId?: string): Promise<SessionContext> {
		const existing = await this.repository.get(sessionId);
		if (existing) return existing;
		const created = createSessionContext(sessionId, canvasId);
		await this.repository.save(created);
		return created;
	}

	async recordPrompt(sessionId: string, content: string, canvasId?: string): Promise<SessionContext> {
		const current = await this.load(sessionId, canvasId);
		const next: SessionContext = {
			...current,
			...(canvasId ? { canvasId } : {}),
			goal: current.goal || content.trim().slice(0, 512),
			updatedAt: new Date().toISOString(),
		};
		await this.repository.save(next);
		return next;
	}

	async applyEvents(
		sessionId: string,
		events: readonly AgentRunEvent[],
		canvasId?: string,
	): Promise<SessionContext> {
		const current = await this.load(sessionId, canvasId);
		const reduced = reduceSessionEvents(current, events);
		const next = canvasId && !reduced.canvasId ? { ...reduced, canvasId } : reduced;
		await this.repository.save(next);
		return next;
	}

	format(context: SessionContext, maxCharacters = 8_000): string {
		return formatSessionContext(context, maxCharacters);
	}
}

export class InMemorySessionContextRepository implements SessionContextRepository {
	private readonly contexts = new Map<string, SessionContext>();

	get(sessionId: string): SessionContext | undefined {
		const context = this.contexts.get(sessionId);
		return context ? structuredClone(context) : undefined;
	}

	save(context: SessionContext): void {
		this.contexts.set(context.sessionId, structuredClone(context));
	}
}
