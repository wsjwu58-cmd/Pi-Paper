import type { Redis } from "ioredis";

import type { MemoryUpdateJob, MemoryUpdateQueue } from "../application/memory-update-queue.ts";

export class RedisMemoryUpdateQueue implements MemoryUpdateQueue {
	private readonly consumer: Redis;
	private closed = false;
	private readonly producer: Redis;
	private readonly key: string;

	constructor(producer: Redis, key = "agent_memory_updates") {
		this.producer = producer;
		this.key = key;
		this.consumer = producer.duplicate();
	}

	async enqueue(job: MemoryUpdateJob): Promise<void> {
		if (this.closed) throw new Error("MEMORY_QUEUE_CLOSED");
		await this.producer.lpush(this.key, JSON.stringify(job));
	}

	async dequeue(): Promise<MemoryUpdateJob | undefined> {
		if (this.closed) return undefined;
		const result = await this.consumer.brpop(this.key, 2);
		if (!result) return undefined;
		try {
			return JSON.parse(result[1]) as MemoryUpdateJob;
		} catch {
			return undefined;
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await Promise.allSettled([this.consumer.quit(), this.producer.quit()]);
	}
}
