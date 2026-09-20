import type { Redis } from "ioredis";

import type { DailyMemoryEntry, DailyMemoryRepository } from "../application/daily-memory-service.ts";

export class RedisDailyMemoryRepository implements DailyMemoryRepository {
	private readonly redis: Redis;

	constructor(redis: Redis) {
		this.redis = redis;
	}

	async list(userId: string, dayKey: string): Promise<readonly DailyMemoryEntry[]> {
		const values: string[] = await this.redis.lrange(redisKey(userId, dayKey), 0, 99);
		return values.flatMap((value: string) => {
			try {
				const parsed = JSON.parse(value) as Partial<DailyMemoryEntry>;
				return typeof parsed.id === "string" && typeof parsed.userId === "string" && typeof parsed.content === "string"
					? [
							{
								id: parsed.id,
								userId: parsed.userId,
								...(typeof parsed.canvasId === "string" ? { canvasId: parsed.canvasId } : {}),
								content: parsed.content,
								createdAt: new Date(String(parsed.createdAt)),
							},
						]
					: [];
			} catch {
				return [];
			}
		});
	}

	async append(entry: DailyMemoryEntry, dayKey: string, ttlSeconds: number): Promise<void> {
		const key = redisKey(entry.userId, dayKey);
		await this.redis.multi().lpush(key, JSON.stringify(entry)).ltrim(key, 0, 99).expire(key, ttlSeconds).exec();
	}
}

function redisKey(userId: string, dayKey: string): string {
	return `agent_daily:${userId}:${dayKey}`;
}
