import type { MemoryRecord, MemoryScope } from "../domain/memory.ts";
import { nextId } from "../infrastructure/ids.ts";

export type WriteMemoryInput = {
	userId: string;
	tenantId?: string;
	canvasId?: string;
	sessionId?: string;
	scope: MemoryScope;
	content: string;
	memoryType?: string;
	confidence: number;
	source?: string;
	visibility?: "user" | "enterprise";
	expiresAt?: Date;
	adminAuthorized?: boolean;
};

export type SearchMemoryInput = {
	userId: string;
	tenantId?: string;
	canvasId?: string;
	sessionId?: string;
	scope?: MemoryScope;
	query: string;
	topK: number;
	now?: Date;
};

export interface MemoryRepository {
	list(): readonly MemoryRecord[] | Promise<readonly MemoryRecord[]>;
	save(memory: MemoryRecord): void | Promise<void>;
	softDelete(id: string, userId: string): boolean | Promise<boolean>;
}

export type MemoryCandidate = {
	id: string;
	userId: string;
	tenantId?: string;
	canvasId?: string;
	sessionId?: string;
	content: string;
	memoryType: string;
	scope: MemoryScope;
	source: string;
	sourceEventSeq?: number;
	confidence: number;
	status: "pending" | "accepted" | "rejected";
	dedupeKey: string;
	expiresAt?: Date;
	createdAt: Date;
	reviewedAt?: Date;
};

export type ProposeMemoryCandidateInput = Omit<
	MemoryCandidate,
	"id" | "memoryType" | "source" | "status" | "dedupeKey" | "createdAt"
> & {
	memoryType?: string;
	source?: string;
	createdAt?: Date;
};

export interface MemoryCandidateRepository {
	listPending(userId: string): readonly MemoryCandidate[] | Promise<readonly MemoryCandidate[]>;
	findPending(userId: string, scope: MemoryScope, dedupeKey: string): MemoryCandidate | undefined | Promise<MemoryCandidate | undefined>;
	get(id: string, userId: string): MemoryCandidate | undefined | Promise<MemoryCandidate | undefined>;
	save(candidate: MemoryCandidate): void | Promise<void>;
	updateStatus(id: string, userId: string, status: "accepted" | "rejected"): boolean | Promise<boolean>;
}

export class MemoryCandidateService {
	private readonly repository: MemoryCandidateRepository;
	private readonly memoryService: MemoryService;

	constructor(repository: MemoryCandidateRepository, memoryService: MemoryService) {
		this.repository = repository;
		this.memoryService = memoryService;
	}

	async listPending(userId: string): Promise<readonly MemoryCandidate[]> {
		return await this.repository.listPending(userId);
	}

	async propose(input: ProposeMemoryCandidateInput): Promise<MemoryCandidate> {
		if (/(api[_-]?key|password|secret|token)\s*[:=]/i.test(input.content))
			throw new Error("SENSITIVE_MEMORY_REJECTED");
		if (!input.content.trim() || input.confidence < 0 || input.confidence > 1) throw new Error("INVALID_INPUT");
		const dedupeKey = dedupeKeyFor(input.scope, input.content);
		const existing = await this.repository.findPending(input.userId, input.scope, dedupeKey);
		if (existing) return existing;
		const candidate: MemoryCandidate = {
			...input,
			id: nextId(),
			content: input.content.trim(),
			memoryType: input.memoryType ?? input.scope,
			source: input.source ?? "agent",
			status: "pending",
			dedupeKey,
			createdAt: input.createdAt ?? new Date(),
		};
		await this.repository.save(candidate);
		return candidate;
	}

	async accept(id: string, userId: string, adminAuthorized = false): Promise<MemoryRecord> {
		const candidate = await this.repository.get(id, userId);
		if (!candidate || candidate.status !== "pending") throw new Error("NOT_FOUND");
		const memory = await this.memoryService.write({
			userId: candidate.userId,
			tenantId: candidate.tenantId,
			canvasId: candidate.canvasId,
			sessionId: candidate.sessionId,
			scope: candidate.scope,
			content: candidate.content,
			memoryType: candidate.memoryType,
			confidence: candidate.confidence,
			source: candidate.source,
			expiresAt: candidate.expiresAt,
			adminAuthorized,
		});
		if (!(await this.repository.updateStatus(id, userId, "accepted"))) throw new Error("NOT_FOUND");
		return memory;
	}

	async reject(id: string, userId: string): Promise<void> {
		if (!(await this.repository.updateStatus(id, userId, "rejected"))) throw new Error("NOT_FOUND");
	}
}

function dedupeKeyFor(scope: MemoryScope, content: string): string {
	let hash = 2_166_136_261;
	for (const character of `${scope}:${content.trim().toLocaleLowerCase()}`) {
		hash ^= character.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export class MemoryService {
	private readonly repository: MemoryRepository;

	constructor(repository: MemoryRepository) {
		this.repository = repository;
	}

	async write(input: WriteMemoryInput): Promise<MemoryRecord> {
		if (/(api[_-]?key|password|secret|token)\s*[:=]/i.test(input.content))
			throw new Error("SENSITIVE_MEMORY_REJECTED");
		if (input.scope === "enterprise" && (!input.tenantId || !input.adminAuthorized))
			throw new Error("PERMISSION_DENIED");
		if (!input.content.trim() || input.confidence < 0 || input.confidence > 1) throw new Error("INVALID_INPUT");
		const existing = (await this.repository.list()).find(
			(memory) =>
				!memory.deleted &&
				memory.userId === input.userId &&
				memory.scope === input.scope &&
				memory.tenantId === input.tenantId &&
				memory.canvasId === input.canvasId &&
				memory.sessionId === input.sessionId &&
				memory.content.trim().toLocaleLowerCase() === input.content.trim().toLocaleLowerCase(),
		);
		if (existing) return existing;
		const memory: MemoryRecord = {
			id: nextId(),
			userId: input.userId,
			tenantId: input.tenantId,
			canvasId: input.canvasId,
			sessionId: input.sessionId,
			scope: input.scope,
			content: input.content.trim(),
			memoryType: input.memoryType ?? input.scope,
			source: input.source ?? "agent",
			confidence: input.confidence,
			visibility: input.visibility ?? (input.scope === "enterprise" ? "enterprise" : "user"),
			version: 1,
			createdAt: new Date(),
			expiresAt: input.expiresAt,
			deleted: false,
		};
		await this.repository.save(memory);
		return memory;
	}

	async search(input: SearchMemoryInput): Promise<readonly MemoryRecord[]> {
		const now = input.now ?? new Date();
		const terms = tokenize(input.query);
		return (await this.repository.list())
			.filter((memory) => !memory.deleted && (!memory.expiresAt || memory.expiresAt > now))
			.filter(
				(memory) =>
					memory.userId === input.userId ||
					(memory.scope === "enterprise" && !!input.tenantId && memory.tenantId === input.tenantId),
			)
			.filter((memory) => !input.scope || memory.scope === input.scope)
			.filter((memory) => memory.scope !== "enterprise" || memory.tenantId === input.tenantId)
			.filter((memory) => !input.canvasId || !memory.canvasId || memory.canvasId === input.canvasId)
			.filter((memory) => !input.sessionId || !memory.sessionId || memory.sessionId === input.sessionId)
			.map((memory) => ({
				memory,
				score: terms.filter((term) => memory.content.toLocaleLowerCase().includes(term)).length,
			}))
			.filter((entry) => terms.length === 0 || entry.score > 0)
			.sort((left, right) => right.score - left.score || right.memory.confidence - left.memory.confidence)
			.slice(0, Math.max(0, input.topK))
			.map((entry) => entry.memory);
	}

	async remove(id: string, userId: string): Promise<void> {
		if (!(await this.repository.softDelete(id, userId))) throw new Error("NOT_FOUND");
	}

	async export(userId: string): Promise<readonly MemoryRecord[]> {
		return (await this.repository.list()).filter((memory) => memory.userId === userId && !memory.deleted);
	}
}

function tokenize(value: string): string[] {
	const matches = value.toLocaleLowerCase().match(/[\p{Script=Han}]|[a-z0-9_]{2,}/gu);
	return matches && matches.length > 0 ? [...new Set(matches)] : value.toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

export class InMemoryMemoryRepository implements MemoryRepository {
	private readonly memories: MemoryRecord[] = [];

	list(): readonly MemoryRecord[] {
		return [...this.memories];
	}
	save(memory: MemoryRecord): void {
		this.memories.push(memory);
	}
	softDelete(id: string, userId: string): boolean {
		const memory = this.memories.find(
			(candidate) => candidate.id === id && candidate.userId === userId && !candidate.deleted,
		);
		if (!memory) return false;
		memory.deleted = true;
		return true;
	}
}

export class InMemoryMemoryCandidateRepository implements MemoryCandidateRepository {
	private readonly candidates = new Map<string, MemoryCandidate>();

	listPending(userId: string): readonly MemoryCandidate[] {
		return [...this.candidates.values()]
			.filter((candidate) => candidate.userId === userId && candidate.status === "pending")
			.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
	}

	findPending(userId: string, scope: MemoryScope, dedupeKey: string): MemoryCandidate | undefined {
		return [...this.candidates.values()].find(
			(candidate) =>
				candidate.userId === userId && candidate.scope === scope && candidate.dedupeKey === dedupeKey && candidate.status === "pending",
		);
	}

	get(id: string, userId: string): MemoryCandidate | undefined {
		const candidate = this.candidates.get(id);
		return candidate?.userId === userId ? candidate : undefined;
	}

	save(candidate: MemoryCandidate): void {
		this.candidates.set(candidate.id, candidate);
	}

	updateStatus(id: string, userId: string, status: "accepted" | "rejected"): boolean {
		const candidate = this.candidates.get(id);
		if (!candidate || candidate.userId !== userId || candidate.status !== "pending") return false;
		this.candidates.set(id, { ...candidate, status, reviewedAt: new Date() });
		return true;
	}
}
