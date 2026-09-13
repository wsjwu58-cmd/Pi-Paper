import { timingSafeEqual } from "node:crypto";

export type TerminalStatus = "succeeded" | "failed" | "cancelled" | "expired" | "settlement_error";

export type TerminalNotice = {
	taskId: string;
	userId?: string;
	status: TerminalStatus;
	nodeId?: string;
	canvasId?: string;
	output?: Record<string, unknown>;
	errorCode?: string;
	actualCost?: number;
};

export type TaskAssociation = { taskId: string; actionId: string; runId: string; sessionId: string; userId?: string };

export interface TerminalStore {
	findTask(taskId: string): TaskAssociation | undefined | Promise<TaskAssociation | undefined>;
	getTerminalStatus(taskId: string): TerminalStatus | undefined | Promise<TerminalStatus | undefined>;
	markTerminal(
		notice: TerminalNotice,
		association: TaskAssociation,
	): boolean | undefined | Promise<boolean | undefined>;
	warnConflict(notice: TerminalNotice, previous: TerminalStatus): void | Promise<void>;
}

export type TerminalResult = {
	accepted: true;
	duplicate?: boolean;
	conflict?: boolean;
	sessionId: string;
	association: TaskAssociation;
};

export class TaskTerminalService {
	private readonly store: TerminalStore;
	private readonly secret: string;

	constructor(store: TerminalStore, secret: string) {
		this.store = store;
		this.secret = secret;
	}

	assertAuthorized(suppliedSecret: string): void {
		if (!this.secret || !safeEqual(this.secret, suppliedSecret)) throw new Error("PERMISSION_DENIED");
	}

	async handle(notice: TerminalNotice, suppliedSecret: string): Promise<TerminalResult> {
		this.assertAuthorized(suppliedSecret);
		const association = await this.store.findTask(notice.taskId);
		if (!association) throw new Error("NOT_FOUND");
		const previous = await this.store.getTerminalStatus(notice.taskId);
		if (previous === notice.status)
			return { accepted: true, duplicate: true, sessionId: association.sessionId, association };
		if (previous) {
			await this.store.warnConflict(notice, previous);
			return { accepted: true, conflict: true, sessionId: association.sessionId, association };
		}
		const inserted = await this.store.markTerminal(notice, association);
		if (inserted === false) return { accepted: true, duplicate: true, sessionId: association.sessionId, association };
		return { accepted: true, sessionId: association.sessionId, association };
	}
}

export class InMemoryTerminalStore implements TerminalStore {
	readonly events: Array<{ notice: TerminalNotice; association: TaskAssociation }> = [];
	readonly warnings: Array<{ notice: TerminalNotice; previous: TerminalStatus }> = [];
	private status?: TerminalStatus;
	private readonly association: TaskAssociation;

	constructor(association: TaskAssociation) {
		this.association = association;
	}

	findTask(taskId: string): TaskAssociation | undefined {
		return taskId === this.association.taskId ? this.association : undefined;
	}

	getTerminalStatus(): TerminalStatus | undefined {
		return this.status;
	}

	markTerminal(notice: TerminalNotice, association: TaskAssociation): boolean {
		this.status = notice.status;
		this.events.push({ notice, association });
		return true;
	}

	warnConflict(notice: TerminalNotice, previous: TerminalStatus): void {
		this.warnings.push({ notice, previous });
	}
}

function safeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
