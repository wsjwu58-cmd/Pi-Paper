import type { ProposeMemoryCandidateInput } from "./memory-service.ts";
import { MemoryCandidateService } from "./memory-service.ts";

export type MemoryUpdateJob = ProposeMemoryCandidateInput & { persist?: boolean };

export interface MemoryUpdateQueue {
	enqueue(job: MemoryUpdateJob): Promise<void>;
	dequeue(): Promise<MemoryUpdateJob | undefined>;
	close(): Promise<void>;
}

export class MemoryUpdateWorker {
	private running = false;
	private loopPromise?: Promise<void>;
	private readonly queue: MemoryUpdateQueue;
	private readonly candidates: MemoryCandidateService;

	constructor(queue: MemoryUpdateQueue, candidates: MemoryCandidateService) {
		this.queue = queue;
		this.candidates = candidates;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.loopPromise = this.loop();
	}

	async stop(): Promise<void> {
		this.running = false;
		await this.queue.close();
		await this.loopPromise;
	}

	private async loop(): Promise<void> {
		while (this.running) {
			let job: MemoryUpdateJob | undefined;
			try {
				job = await this.queue.dequeue();
			} catch {
				if (this.running) {
					await new Promise((resolve) => setTimeout(resolve, 250));
					continue;
				}
				return;
			}
			if (!this.running || !job) return;
			try {
				const candidate = await this.candidates.propose(job);
				if (job.persist !== false) await this.candidates.accept(candidate.id, job.userId);
			} catch {
				// A bad candidate must not stop processing later jobs. The durable
				// candidate table remains the audit point for reviewable failures.
			}
		}
	}
}

export class InMemoryMemoryUpdateQueue implements MemoryUpdateQueue {
	private readonly jobs: MemoryUpdateJob[] = [];
	private readonly waiters: Array<(job: MemoryUpdateJob | undefined) => void> = [];
	private closed = false;

	async enqueue(job: MemoryUpdateJob): Promise<void> {
		if (this.closed) throw new Error("MEMORY_QUEUE_CLOSED");
		const waiter = this.waiters.shift();
		if (waiter) waiter(job);
		else this.jobs.push(job);
	}

	async dequeue(): Promise<MemoryUpdateJob | undefined> {
		const job = this.jobs.shift();
		if (job) return job;
		if (this.closed) return undefined;
		return await new Promise<MemoryUpdateJob | undefined>((resolve) => this.waiters.push(resolve));
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter(undefined);
	}
}
