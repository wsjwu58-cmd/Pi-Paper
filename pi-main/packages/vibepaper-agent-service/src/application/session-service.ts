import { nextId } from "../infrastructure/ids.ts";

export type SessionRecord = {
	id: string;
	userId: string;
	canvasId: string | null;
	title: string;
	status: "active" | "archived" | "deleted";
	updatedAt: number;
};
export type SessionListOptions = { limit: number; cursor?: string; search?: string; canvasId?: string };

export interface SessionRepository {
	list(userId: string): readonly SessionRecord[] | Promise<readonly SessionRecord[]>;
	get(id: string): SessionRecord | undefined | Promise<SessionRecord | undefined>;
	save(session: SessionRecord): void | Promise<void>;
}

export class SessionService {
	private readonly repository: SessionRepository;

	constructor(repository: SessionRepository) {
		this.repository = repository;
	}

	async create(session: Omit<SessionRecord, "status"> & { status?: SessionRecord["status"] }): Promise<SessionRecord> {
		const created = { ...session, status: session.status ?? "active" };
		await this.repository.save(created);
		return created;
	}

	async list(
		userId: string,
		options: SessionListOptions,
	): Promise<{ items: readonly SessionRecord[]; nextCursor?: string }> {
		const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
		const search = options.search?.toLocaleLowerCase();
		const filtered = (await this.repository.list(userId))
			.filter((session) => session.status !== "deleted")
			.filter((session) => !options.canvasId || session.canvasId === options.canvasId)
			.filter((session) => !search || session.title.toLocaleLowerCase().includes(search))
			.filter(
				(session) =>
					!cursor ||
					session.updatedAt < cursor.updatedAt ||
					(session.updatedAt === cursor.updatedAt && session.id < cursor.id),
			)
			.sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id));
		const items = filtered.slice(0, Math.max(1, options.limit));
		return { items, ...(filtered.length > items.length ? { nextCursor: encodeCursor(items.at(-1)!) } : {}) };
	}

	async rename(id: string, userId: string, title: string): Promise<SessionRecord> {
		const session = await this.requireOwned(id, userId);
		const renamed = { ...session, title: title.trim(), updatedAt: Date.now() };
		await this.repository.save(renamed);
		return renamed;
	}

	async archive(id: string, userId: string): Promise<void> {
		await this.setStatus(id, userId, "archived");
	}
	async restore(id: string, userId: string): Promise<void> {
		await this.setStatus(id, userId, "active");
	}
	async remove(id: string, userId: string): Promise<void> {
		await this.setStatus(id, userId, "deleted");
	}

	async copyToCanvas(id: string, userId: string, canvasId: string): Promise<SessionRecord> {
		const source = await this.requireOwned(id, userId);
		return await this.create({
			id: nextId(),
			userId,
			canvasId,
			title: `${source.title} 副本`,
			updatedAt: Date.now(),
		});
	}

	private async setStatus(id: string, userId: string, status: SessionRecord["status"]): Promise<void> {
		const session = await this.requireOwned(id, userId);
		await this.repository.save({ ...session, status, updatedAt: Date.now() });
	}

	private async requireOwned(id: string, userId: string): Promise<SessionRecord> {
		const session = await this.repository.get(id);
		if (!session || session.userId !== userId || session.status === "deleted") throw new Error("NOT_FOUND");
		return session;
	}
}

export class InMemorySessionRepository implements SessionRepository {
	private readonly sessions = new Map<string, SessionRecord>();
	list(userId: string): readonly SessionRecord[] {
		return [...this.sessions.values()].filter((session) => session.userId === userId);
	}
	get(id: string): SessionRecord | undefined {
		return this.sessions.get(id);
	}
	save(session: SessionRecord): void {
		this.sessions.set(session.id, session);
	}
}

function encodeCursor(session: SessionRecord): string {
	return Buffer.from(JSON.stringify({ updatedAt: session.updatedAt, id: session.id }), "utf8").toString("base64url");
}

function decodeCursor(value: string): { updatedAt: number; id: string } {
	try {
		const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { updatedAt: number; id: string };
		if (!Number.isFinite(cursor.updatedAt) || typeof cursor.id !== "string") throw new Error();
		return cursor;
	} catch {
		throw new Error("INVALID_CURSOR");
	}
}
