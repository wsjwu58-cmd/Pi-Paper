/**
 * FIFO, per-user read limiter.  It is intentionally used only for idempotent
 * read work; task submissions and canvas writes are not admitted here.
 */
export interface ReadExecutionGate {
	run<T>(ownerId: string, operation: () => Promise<T>): Promise<T>;
}

export class PerUserReadExecutionGate implements ReadExecutionGate {
	private readonly active = new Map<string, number>();
	private readonly waiters = new Map<string, Array<() => void>>();
	private readonly maxPerUser: number;

	constructor(maxPerUser = 4) {
		if (!Number.isInteger(maxPerUser) || maxPerUser < 1) throw new Error("INVALID_READ_CONCURRENCY_LIMIT");
		this.maxPerUser = maxPerUser;
	}

	async run<T>(ownerId: string, operation: () => Promise<T>): Promise<T> {
		await this.acquire(ownerId);
		try {
			return await operation();
		} finally {
			this.release(ownerId);
		}
	}

	private async acquire(ownerId: string): Promise<void> {
		if ((this.active.get(ownerId) ?? 0) < this.maxPerUser) {
			this.active.set(ownerId, (this.active.get(ownerId) ?? 0) + 1);
			return;
		}
		await new Promise<void>((resolve) => {
			const queue = this.waiters.get(ownerId) ?? [];
			queue.push(resolve);
			this.waiters.set(ownerId, queue);
		});
		this.active.set(ownerId, (this.active.get(ownerId) ?? 0) + 1);
	}

	private release(ownerId: string): void {
		const count = (this.active.get(ownerId) ?? 1) - 1;
		if (count <= 0) this.active.delete(ownerId);
		else this.active.set(ownerId, count);
		const next = this.waiters.get(ownerId)?.shift();
		if (this.waiters.get(ownerId)?.length === 0) this.waiters.delete(ownerId);
		next?.();
	}
}
