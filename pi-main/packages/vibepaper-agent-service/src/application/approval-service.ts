import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { ActionBinding, ActionRisk, ConsumedAction, PlannedAction } from "../domain/action-approval.ts";
import { nextId } from "../infrastructure/ids.ts";

export type PlanActionInput = {
	userId: string;
	runId?: string;
	sessionId: string;
	canvasId: string;
	canvasVersion: number;
	toolName: string;
	params: Record<string, unknown>;
	estimatedCost: number;
	risk?: ActionRisk;
	requiresApproval?: boolean;
};

export type ApprovalRecord = {
	action: PlannedAction;
	nonce: string;
	tokenSignature: string;
	status: "pending" | "consumed" | "rejected";
};

export interface ApprovalRepository {
	save(record: ApprovalRecord): void | Promise<void>;
	find(actionId: string): ApprovalRecord | undefined | Promise<ApprovalRecord | undefined>;
	consumePending(actionId: string): ApprovalRecord | undefined | Promise<ApprovalRecord | undefined>;
	rejectPending?(actionId: string): ApprovalRecord | undefined | Promise<ApprovalRecord | undefined>;
}

export class ApprovalError extends Error {
	readonly code: "CONFIRMATION_REQUIRED" | "VERSION_CONFLICT";

	constructor(code: "CONFIRMATION_REQUIRED" | "VERSION_CONFLICT", message: string) {
		super(`${code}: ${message}`);
		this.name = "ApprovalError";
		this.code = code;
	}
}

export class ApprovalService {
	private readonly repository: ApprovalRepository;
	private readonly secret: string;
	private readonly ttlSeconds: number;

	constructor(repository: ApprovalRepository, secret: string, ttlSeconds: number) {
		this.repository = repository;
		this.secret = secret;
		this.ttlSeconds = ttlSeconds;
	}

	planAction(input: PlanActionInput, now = Date.now()): PlannedAction {
		const { action, record } = this.createPlan(input, now);
		if (record) void this.repository.save(record);
		return action;
	}

	async planActionAsync(input: PlanActionInput, now = Date.now()): Promise<PlannedAction> {
		const { action, record } = this.createPlan(input, now);
		if (record) await this.repository.save(record);
		return action;
	}

	private createPlan(input: PlanActionInput, now: number): { action: PlannedAction; record?: ApprovalRecord } {
		if (!Number.isInteger(input.estimatedCost) || input.estimatedCost < 0) throw new Error("INVALID_INPUT");
		const actionHash = sha256(
			stableStringify({
				userId: input.userId,
				sessionId: input.sessionId,
				canvasId: input.canvasId,
				canvasVersion: input.canvasVersion,
				toolName: input.toolName,
				params: input.params,
				estimatedCost: input.estimatedCost,
			}),
		);
		const requiresApproval = input.requiresApproval ?? (input.estimatedCost >= 1 || input.risk === "high");
		const actionId = nextId();
		const base: Omit<PlannedAction, "binding" | "approvalToken"> = {
			actionId,
			userId: input.userId,
			runId: input.runId,
			sessionId: input.sessionId,
			canvasId: input.canvasId,
			canvasVersion: input.canvasVersion,
			toolName: input.toolName,
			params: input.params,
			estimatedCost: input.estimatedCost,
			risk: input.risk ?? (requiresApproval ? "high" : "canvas_write"),
			actionHash,
			status: requiresApproval ? "awaiting_approval" : "planned",
		};
		if (!requiresApproval) return { action: { ...base, binding: this.binding(base, now) } };
		const nonce = randomUUID();
		const expiresAt = now + this.ttlSeconds * 1000;
		const binding: ActionBinding = { ...this.binding(base, now), expiresAt };
		const tokenPayload = encode(binding, nonce);
		const approvalToken = `${tokenPayload}.${sign(this.secret, tokenPayload)}`;
		const record: ApprovalRecord = {
			action: { ...base, binding, approvalToken },
			nonce,
			tokenSignature: sign(this.secret, tokenPayload),
			status: "pending",
		};
		return { action: { ...base, binding, approvalToken }, record };
	}

	async consumeApproval(
		actionId: string,
		token: string,
		currentCanvasVersion: number,
		now = Date.now(),
	): Promise<ConsumedAction> {
		return await this.consume(actionId, token, currentCanvasVersion, now, false);
	}

	/**
	 * Desktop task creation is idempotent by approval action ID. Allowing the same
	 * accepted token to replay the exact bound action lets recovery finish a task
	 * creation that was interrupted between SQLite databases without permitting a
	 * different task to be submitted.
	 */
	async consumeApprovalIdempotently(
		actionId: string,
		token: string,
		currentCanvasVersion: number,
		now = Date.now(),
	): Promise<ConsumedAction> {
		return await this.consume(actionId, token, currentCanvasVersion, now, true);
	}

	async rejectApproval(actionId: string, token: string): Promise<void> {
		const record = await this.repository.find(actionId);
		if (!record || record.status !== "pending")
			throw new ApprovalError("CONFIRMATION_REQUIRED", "确认令牌无效或已处理");
		this.assertStoredToken(record, token);
		const [payload, signature] = token.split(".");
		if (!payload || !signature || !safeEqual(sign(this.secret, payload), signature))
			throw new ApprovalError("CONFIRMATION_REQUIRED", "确认令牌无效");
		const binding = decode(payload);
		if (
			!binding ||
			binding.actionHash !== record.action.actionHash ||
			binding.userId !== record.action.userId ||
			binding.sessionId !== record.action.sessionId ||
			binding.canvasId !== record.action.canvasId ||
			binding.canvasVersion !== record.action.canvasVersion
		)
			throw new ApprovalError("CONFIRMATION_REQUIRED", "确认令牌无效");
		if (!this.repository.rejectPending) throw new Error("APPROVAL_REJECTION_NOT_SUPPORTED");
		if (!(await this.repository.rejectPending(actionId)))
			throw new ApprovalError("CONFIRMATION_REQUIRED", "确认令牌已被其他请求处理");
	}

	/** Validate the exact persisted capability before returning a previous decision. */
	async validateApprovalToken(actionId: string, token: string): Promise<void> {
		const record = await this.repository.find(actionId);
		if (!record) throw new ApprovalError("CONFIRMATION_REQUIRED", "确认令牌无效或已处理");
		this.assertStoredToken(record, token);
	}

	private async consume(
		actionId: string,
		token: string,
		currentCanvasVersion: number,
		now: number,
		allowConsumedReplay: boolean,
	): Promise<ConsumedAction> {
		const record = await this.repository.find(actionId);
		const replay = record?.status === "consumed" && allowConsumedReplay;
		if (!record || (record.status !== "pending" && !replay))
			throw new ApprovalError("CONFIRMATION_REQUIRED", "确认令牌无效或已消费");
		this.assertStoredToken(record, token);
		if (record.action.canvasVersion !== currentCanvasVersion)
			throw new ApprovalError("VERSION_CONFLICT", "画布版本已变化，请重新确认");
		const [payload, signature] = token.split(".");
		if (!payload || !signature || !safeEqual(sign(this.secret, payload), signature))
			throw new ApprovalError("CONFIRMATION_REQUIRED", "确认令牌无效或已过期");
		const binding = decode(payload);
		if (
			!binding ||
			binding.actionHash !== record.action.actionHash ||
			(!replay && binding.expiresAt <= now) ||
			binding.userId !== record.action.userId ||
			binding.sessionId !== record.action.sessionId ||
			binding.canvasId !== record.action.canvasId ||
			binding.canvasVersion !== record.action.canvasVersion
		)
			throw new ApprovalError("CONFIRMATION_REQUIRED", "确认令牌无效或已过期");
		if (replay) return { ...record.action, status: "approved" };
		const consumed = await this.repository.consumePending(actionId);
		if (!consumed) throw new ApprovalError("CONFIRMATION_REQUIRED", "确认令牌已被其他请求消费");
		return { ...consumed.action, status: "approved" };
	}

	private assertStoredToken(record: ApprovalRecord, token: string): void {
		const storedToken = record.action.approvalToken;
		if (!storedToken || !safeEqual(storedToken, token))
			throw new ApprovalError("CONFIRMATION_REQUIRED", "确认令牌无效");
	}

	private binding(action: Omit<PlannedAction, "binding" | "approvalToken">, now: number): ActionBinding {
		return {
			userId: action.userId,
			sessionId: action.sessionId,
			canvasId: action.canvasId,
			canvasVersion: action.canvasVersion,
			actionHash: action.actionHash,
			expiresAt: now + this.ttlSeconds * 1000,
		};
	}
}

export class InMemoryApprovalRepository implements ApprovalRepository {
	private readonly records = new Map<string, ApprovalRecord>();

	save(record: ApprovalRecord): void {
		this.records.set(record.action.actionId, record);
	}

	find(actionId: string): ApprovalRecord | undefined {
		return this.records.get(actionId);
	}

	consumePending(actionId: string): ApprovalRecord | undefined {
		const record = this.records.get(actionId);
		if (!record || record.status !== "pending") return undefined;
		const consumed = { ...record, status: "consumed" as const };
		this.records.set(actionId, consumed);
		return consumed;
	}
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function sign(secret: string, value: string): string {
	return createHmac("sha256", secret).update(value).digest("hex");
}

function encode(binding: ActionBinding, nonce: string): string {
	return Buffer.from(JSON.stringify({ ...binding, nonce }), "utf8").toString("base64url");
}

function decode(value: string): ActionBinding | undefined {
	try {
		const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ActionBinding>;
		if (
			typeof parsed.userId !== "string" ||
			typeof parsed.sessionId !== "string" ||
			typeof parsed.canvasId !== "string" ||
			typeof parsed.canvasVersion !== "number" ||
			typeof parsed.actionHash !== "string" ||
			typeof parsed.expiresAt !== "number"
		)
			return undefined;
		return parsed as ActionBinding;
	} catch {
		return undefined;
	}
}

function safeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
