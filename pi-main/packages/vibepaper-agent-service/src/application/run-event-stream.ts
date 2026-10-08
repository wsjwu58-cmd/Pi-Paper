import type { AgentRunEventType } from "../domain/agent-run.ts";
import { nextId } from "../infrastructure/ids.ts";

export type AgentEventEnvelope = {
	eventId: string;
	runId: string;
	sessionId: string;
	eventSeq: number;
	type: AgentRunEventType;
	runtime: "pi";
	runtimeVersion: string;
	data: Record<string, unknown>;
};

export function strictAssistantDelta(previous: string, next: string): string {
	if (next.startsWith(previous)) return next.slice(previous.length);
	return next;
}

export type AgentEventListener = (event: AgentEventEnvelope) => void;

export class AgentEventStream {
	private readonly events = new Map<string, AgentEventEnvelope[]>();
	private readonly listeners = new Map<string, Set<AgentEventListener>>();
	private readonly sessionListeners = new Map<string, Set<AgentEventListener>>();
	private readonly sessionSequences = new Map<string, number>();

	publish(
		runId: string,
		sessionId: string,
		type: AgentRunEventType,
		data: Record<string, unknown>,
	): AgentEventEnvelope {
		const eventSeq = (this.sessionSequences.get(sessionId) ?? 0) + 1;
		this.sessionSequences.set(sessionId, eventSeq);
		const event: AgentEventEnvelope = {
			eventId: nextId(),
			runId,
			sessionId,
			eventSeq,
			type,
			runtime: "pi",
			runtimeVersion: "0.1.0",
			data,
		};
		this.publishEvent(event);
		return event;
	}

	publishEvent(event: AgentEventEnvelope): void {
		const events = this.events.get(event.runId) ?? [];
		if (events.some((current) => current.eventId === event.eventId)) return;
		events.push(event);
		events.sort((left, right) => left.eventSeq - right.eventSeq);
		this.events.set(event.runId, events);
		this.sessionSequences.set(
			event.sessionId,
			Math.max(this.sessionSequences.get(event.sessionId) ?? 0, event.eventSeq),
		);
		for (const listener of this.listeners.get(event.runId) ?? []) listener(event);
		for (const listener of this.sessionListeners.get(event.sessionId) ?? []) listener(event);
	}

	replay(runId: string, afterSeq = 0): readonly AgentEventEnvelope[] {
		return (this.events.get(runId) ?? []).filter((event) => event.eventSeq > afterSeq);
	}

	replaySession(sessionId: string, afterSeq = 0): readonly AgentEventEnvelope[] {
		return [...this.events.values()]
			.flat()
			.filter((event) => event.sessionId === sessionId && event.eventSeq > afterSeq)
			.sort((left, right) => left.eventSeq - right.eventSeq);
	}

	latest(runId: string): AgentEventEnvelope | undefined {
		return this.events.get(runId)?.at(-1);
	}

	subscribe(runId: string, listener: AgentEventListener): () => void {
		const listeners = this.listeners.get(runId) ?? new Set<AgentEventListener>();
		listeners.add(listener);
		this.listeners.set(runId, listeners);
		return () => listeners.delete(listener);
	}

	subscribeSession(sessionId: string, listener: AgentEventListener): () => void {
		const listeners = this.sessionListeners.get(sessionId) ?? new Set<AgentEventListener>();
		listeners.add(listener);
		this.sessionListeners.set(sessionId, listeners);
		return () => listeners.delete(listener);
	}
}
