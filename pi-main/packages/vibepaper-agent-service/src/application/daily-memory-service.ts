import { nextId } from "../infrastructure/ids.ts";

export type DailyMemoryEntry = {
	id: string;
	userId: string;
	canvasId?: string;
	content: string;
	createdAt: Date;
};

export type RememberDailyMemoryInput = {
	userId: string;
	canvasId?: string;
	content: string;
	now?: Date;
};

export interface DailyMemoryRepository {
	list(userId: string, dayKey: string): readonly DailyMemoryEntry[] | Promise<readonly DailyMemoryEntry[]>;
	append(entry: DailyMemoryEntry, dayKey: string, ttlSeconds: number): void | Promise<void>;
}

export class DailyMemoryService {
	private readonly repository: DailyMemoryRepository;
	private readonly clock: () => Date;

	constructor(repository: DailyMemoryRepository, clock: () => Date = () => new Date()) {
		this.repository = repository;
		this.clock = clock;
	}

	async remember(input: RememberDailyMemoryInput): Promise<DailyMemoryEntry | undefined> {
		const content = input.content.trim();
		if (!content || content.length > 500) return undefined;
		const now = input.now ?? this.clock();
		const dayKey = dateKey(now);
		const existing = await this.repository.list(input.userId, dayKey);
		if (existing.some((entry) => entry.canvasId === input.canvasId && entry.content === content))
			return existing.find((entry) => entry.canvasId === input.canvasId && entry.content === content);
		const entry: DailyMemoryEntry = {
			id: nextId(),
			userId: input.userId,
			...(input.canvasId ? { canvasId: input.canvasId } : {}),
			content,
			createdAt: now,
		};
		await this.repository.append(entry, dayKey, secondsUntilNextDay(now));
		return entry;
	}

	async search(
		userId: string,
		query: string,
		canvasId?: string,
		limit = 5,
		now = this.clock(),
	): Promise<readonly DailyMemoryEntry[]> {
		const terms = tokenize(query);
		return (await this.repository.list(userId, dateKey(now)))
			.filter((entry) => !canvasId || !entry.canvasId || entry.canvasId === canvasId)
			.map((entry) => ({ entry, score: terms.filter((term) => entry.content.toLocaleLowerCase().includes(term)).length }))
			.filter((result) => terms.length === 0 || result.score > 0)
			.sort((left, right) => right.score - left.score || right.entry.createdAt.getTime() - left.entry.createdAt.getTime())
			.slice(0, Math.max(0, limit))
			.map((result) => result.entry);
	}
}

export class InMemoryDailyMemoryRepository implements DailyMemoryRepository {
	private readonly entries = new Map<string, DailyMemoryEntry[]>();

	list(userId: string, dayKey: string): readonly DailyMemoryEntry[] {
		return [...(this.entries.get(key(userId, dayKey)) ?? [])].sort(
			(left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
		);
	}

	append(entry: DailyMemoryEntry, dayKey: string): void {
		const bucket = this.entries.get(key(entry.userId, dayKey)) ?? [];
		bucket.push(entry);
		this.entries.set(key(entry.userId, dayKey), bucket.slice(-100));
	}
}

export function extractDailyMemory(content: string): string | undefined {
	const match = content.trim().match(/^(?:今天|本轮|这次|暂时|当前任务|for today|this turn|this task)\s*[:：,，]?\s*(.{2,500})$/iu);
	if (!match?.[1]) return undefined;
	return match[1].trim().replace(/[。.!！]+$/u, "");
}

export function dateKey(value: Date): string {
	return value.toISOString().slice(0, 10);
}

function key(userId: string, dayKey: string): string {
	return `${userId}:${dayKey}`;
}

function secondsUntilNextDay(value: Date): number {
	const next = new Date(value);
	next.setUTCHours(24, 0, 0, 0);
	return Math.max(60, Math.ceil((next.getTime() - value.getTime()) / 1_000));
}

function tokenize(value: string): string[] {
	const matches = value.toLocaleLowerCase().match(/[\p{Script=Han}]|[a-z0-9_]{2,}/gu);
	return matches && matches.length > 0 ? [...new Set(matches)] : value.toLocaleLowerCase().split(/\s+/).filter(Boolean);
}
