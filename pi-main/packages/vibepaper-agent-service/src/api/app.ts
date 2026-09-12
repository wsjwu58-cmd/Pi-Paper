import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { QueryResultRow } from "pg";

import {
	AgentRuntimeError,
	type AgentSkillContext,
	type AgentTurnEvent,
	runDramaTurn,
	type StoredAgentMessage,
	sanitizeAgentReply,
} from "../application/agent-runtime.ts";
import {
	ApprovalError,
	type ApprovalRepository,
	ApprovalService,
	InMemoryApprovalRepository,
} from "../application/approval-service.ts";
import { AuthorizationError, assertSessionCanvasAccess } from "../application/authorization-service.ts";
import {
	isNodeCountQuestion,
	missingAssistantReply,
	nodeCountFromCanvasSummary,
	nodeCountReply,
} from "../application/canvas-fact-reply.ts";
import { confirmationRecoveryMessage } from "../application/confirmation-recovery.ts";
import { persistConfirmationStatus } from "../application/confirmation-status.ts";
import { GenerationActionExecutor } from "../application/generation-action-executor.ts";
import { formatIntentContext, routeAgentIntent } from "../application/intent-router.ts";
import { MemoryService } from "../application/memory-service.ts";
import {
	MAX_NODE_REFERENCES,
	NodeReferenceContextError,
	type NodeReferenceSnapshot,
} from "../application/node-reference-context.ts";
import { PlanCompileError } from "../application/plan-compiler.ts";
import { PostProductionError } from "../application/post-production-service.ts";
import { selectProfile } from "../application/profile-selector.ts";
import { RenderAuditService } from "../application/render-audit-service.ts";
import { AgentEventStream } from "../application/run-event-stream.ts";
import { InMemoryRunRepository, type RunRepository, SessionRunService } from "../application/session-run-service.ts";
import { BUILTIN_SKILL_INSERT_SQL } from "../application/skill-bootstrap.ts";
import {
	TaskTerminalService,
	type TerminalNotice,
	type TerminalResult,
	type TerminalStatus,
} from "../application/task-terminal-service.ts";
import type { ServiceConfig } from "../config.ts";
import type { AgentPlan, PlanStep } from "../domain/agent-plan.ts";
import type { AgentRunEvent, AgentRunEventType } from "../domain/agent-run.ts";
import type { TimelineSegment } from "../domain/audio-subtitle-composite.ts";
import {
	type CharacterProfile,
	type CharacterReferencePack,
	DramaDomainError,
	type DramaSeries,
	type KeyframeRender,
	type RenderLineage,
	type ShotSpec,
	STANDARD_VERTICAL_SHORT_DRAMA_FORMAT,
} from "../domain/drama-state.ts";
import type { MemoryScope } from "../domain/memory.ts";
import { SYSTEM_SKILLS, skillIndexLine } from "../domain/skill-manifest.ts";
import type { SqlExecutor } from "../infrastructure/database.ts";
import { nextId } from "../infrastructure/ids.ts";
import type { MigrationDatabase } from "../infrastructure/migrations.ts";
import { PgApprovalRepository } from "../infrastructure/pg-approval-repository.ts";
import { PgDramaStateStore } from "../infrastructure/pg-drama-state-store.ts";
import { PgDramaStoryService } from "../infrastructure/pg-drama-story-repository.ts";
import { PgMemoryRepository } from "../infrastructure/pg-memory-repository.ts";
import { PgPlanRepository, PlanRepositoryError } from "../infrastructure/pg-plan-repository.ts";
import { PgPostProductionService } from "../infrastructure/pg-post-production-repository.ts";
import { PgRenderBatchRepository, RenderBatchError } from "../infrastructure/pg-render-batch-repository.ts";
import { PgRunRepository } from "../infrastructure/pg-run-repository.ts";
import { PgTaskTerminalStore } from "../infrastructure/pg-task-terminal-store.ts";
import { ToolGateway, ToolGatewayError } from "../infrastructure/tool-gateway.ts";
import { createRuntimeTools } from "../tools/runtime-tools.ts";
import { createAgentOpenApi } from "./openapi.ts";

type SessionRow = {
	id: string;
	title: string;
	canvas_id: string | null;
	status: string;
	token_used_total: number;
	points_used_total: number;
	model_usage: unknown;
	updated_at: Date;
};
type MessageRow = {
	id: string;
	role: "user" | "assistant" | "system";
	msg_type: string;
	content: string;
	meta: unknown;
	created_at: Date;
};
type SkillRow = {
	id: string;
	owner_id: string;
	name: string;
	description: string | null;
	instructions: string;
	source: string;
	category: string;
	version: number;
	enabled: boolean;
	created_at: Date;
	updated_at: Date;
};
type SkillVersionRow = { skill_id: string; version: number; content_hash: string; content: string };
type SkillSnapshot = { id: string; version: number; contentHash: string };
type MemoryRow = { id: string; content: string; memory_type: string; created_at: Date };
type FragmentRow = { id: string; title: string | null; canvas_id: string | null; content: unknown; created_at: Date };

export interface CreateAppOptions {
	config: ServiceConfig;
	database: SqlExecutor;
	referenceGateway?: NodeReferenceGateway;
	runTurn?: typeof runDramaTurn;
	runRepository?: RunRepository;
	approvalRepository?: ApprovalRepository;
	generationExecutor?: GenerationActionExecutor;
}

export interface NodeReferenceGateway {
	getNodeReferences(
		userId: string,
		canvasId: string,
		nodeIds: readonly string[],
		requestId?: string,
	): Promise<NodeReferenceSnapshot[]>;
}

export function createApp(options: CreateAppOptions): FastifyInstance {
	const app = Fastify({ logger: true });
	const { config, database } = options;
	const dramaState = new PgDramaStateStore(database);
	const dramaStory = new PgDramaStoryService(database);
	const postProduction = new PgPostProductionService(database);
	const planRepository = hasTransaction(database) ? new PgPlanRepository(database as MigrationDatabase) : undefined;
	const renderBatchRepository = hasTransaction(database)
		? new PgRenderBatchRepository(database as MigrationDatabase)
		: undefined;
	const renderAuditService = new RenderAuditService();
	const referenceGateway = options.referenceGateway ?? new ToolGateway(config);
	const runTurn = options.runTurn ?? runDramaTurn;
	const eventStream = new AgentEventStream();
	const runRepository = options.runRepository ?? defaultRunRepository(database);
	const runService = new SessionRunService(runRepository);
	const approvalRepository = options.approvalRepository ?? defaultApprovalRepository(database);
	const approvalService = new ApprovalService(
		approvalRepository,
		config.confirmSigningSecret,
		config.confirmTokenTtlSeconds,
	);
	const taskGateway = new ToolGateway(config);
	const generationExecutor =
		options.generationExecutor ??
		new GenerationActionExecutor(
			{ estimate: (input) => taskGateway.estimateGeneration(input) },
			{ freeze: (input) => taskGateway.freezeGeneration(input) },
			{ markQueued: (input) => taskGateway.markQueued(input) },
			(_actionId, taskId, userId) => taskGateway.cancelGeneration(taskId, userId),
		);
	const activeRuns = new Map<string, string>();
	const activeAgents = new Map<string, { abort: () => void }>();
	const cancelledSessions = new Set<string>();
	const terminalService = hasTransaction(database)
		? new TaskTerminalService(new PgTaskTerminalStore(database as MigrationDatabase), config.internalServiceToken)
		: undefined;
	const memoryService = hasTransaction(database) ? new MemoryService(new PgMemoryRepository(database)) : undefined;
	app.register(multipart, { limits: { fileSize: 512 * 1024, files: 1 } });

	app.setErrorHandler((error, _request, reply) => {
		const domainError = error instanceof DramaDomainError || error instanceof AgentRuntimeError;
		const referenceError = error instanceof NodeReferenceContextError;
		const gatewayError = error instanceof ToolGatewayError;
		const apiError = error instanceof ApiError;
		const authorizationError = error instanceof AuthorizationError;
		const postProductionError = error instanceof PostProductionError;
		const planError = error instanceof PlanRepositoryError;
		const planCompileError = error instanceof PlanCompileError;
		const renderBatchError = error instanceof RenderBatchError;
		const approvalError = error instanceof ApprovalError;
		const known =
			domainError ||
			referenceError ||
			gatewayError ||
			apiError ||
			authorizationError ||
			postProductionError ||
			planError ||
			planCompileError ||
			renderBatchError ||
			approvalError;
		const status = referenceError
			? error.code === "NOT_FOUND"
				? 404
				: 400
			: gatewayError || apiError || authorizationError
				? error.statusCode
				: postProductionError
					? 400
					: planError
						? error.code === "NOT_FOUND"
							? 404
							: 403
						: planCompileError
							? 409
							: approvalError
								? error.code === "VERSION_CONFLICT"
									? 409
									: 400
								: renderBatchError
									? error.code === "NOT_FOUND"
										? 404
										: error.code === "PERMISSION_DENIED"
											? 403
											: 400
									: domainError
										? 400
										: isStatusError(error)
											? error.statusCode
											: 500;
		const code =
			known && "code" in error && typeof error.code === "string"
				? error.code
				: status === 500
					? "INTERNAL_ERROR"
					: "INVALID_INPUT";
		const message = error instanceof Error ? error.message : "未知服务错误";
		void reply.status(status).send({
			code,
			message,
			details: gatewayError ? error.details : undefined,
			request_id: reply.request.id,
			retryable: status >= 500,
		});
	});

	app.get("/health", async () => ({ status: "ok", service: config.appName, runtime: "pi-agent" }));
	app.get("/api/v1/openapi.json", async () => createAgentOpenApi());

	app.post("/api/v1/agent/sessions", async (request, reply) => {
		const userId = requireUserId(request);
		const body = recordBody(request.body);
		const id = nextId();
		const canvasId = optionalId(body.canvasId ?? body.canvas_id);
		const title = optionalString(body.title) ?? "新对话";
		await database.query(
			`INSERT INTO agent_sessions (id, user_id, canvas_id, title, status, model_usage)
			 VALUES ($1, $2, $3, $4, 'active', '{}'::jsonb)`,
			[id, userId, canvasId, title],
		);
		return await reply.status(201).send({ sessionId: id, title, canvasId });
	});

	app.get("/api/v1/agent/sessions", async (request) => {
		const userId = requireUserId(request);
		const query = request.query as {
			canvasId?: string;
			search?: string;
			q?: string;
			limit?: string;
			cursor?: string;
		};
		const canvasId = optionalId(query.canvasId);
		const search = optionalString(query.search ?? query.q);
		const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? "100", 10) || 100));
		const cursor = decodeSessionCursor(query.cursor);
		const rows = await database.query<SessionRow>(
			`SELECT id, title, canvas_id, status, token_used_total, points_used_total, model_usage, updated_at
			 FROM agent_sessions WHERE user_id = $1 AND COALESCE(status, 'active') <> 'deleted'
			 AND ($2::bigint IS NULL OR canvas_id = $2::bigint)
			 AND ($3::text IS NULL OR title ILIKE '%' || $3 || '%')
			 AND ($4::timestamptz IS NULL OR updated_at < $4 OR (updated_at = $4 AND id < $5::bigint))
			 ORDER BY updated_at DESC, id DESC LIMIT $6`,
			[userId, canvasId, search, cursor?.updatedAt ?? null, cursor?.id ?? null, limit + 1],
		);
		const hasMore = rows.rows.length > limit;
		const items = rows.rows.slice(0, limit);
		return {
			items: items.map(sessionView),
			...(hasMore && items.length ? { nextCursor: encodeSessionCursor(items.at(-1)!) } : {}),
		};
	});

	app.get("/api/v1/agent/sessions/:sessionId", async (request) => {
		const session = await requireSession(database, requireUserId(request), routeId(request, "sessionId"));
		return { sessionId: session.id, title: session.title, canvasId: session.canvas_id, status: session.status };
	});

	app.patch("/api/v1/agent/sessions/:sessionId", async (request) => {
		const userId = requireUserId(request);
		const sessionId = routeId(request, "sessionId");
		const session = await requireSession(database, userId, sessionId);
		const body = recordBody(request.body);
		const title = optionalString(body.title);
		const status = optionalString(body.status);
		if (title === undefined && status === undefined)
			throw new ApiError(400, "INVALID_INPUT", "title 或 status 至少提供一个");
		if (status !== undefined && status !== "active" && status !== "archived")
			throw new ApiError(400, "INVALID_INPUT", "会话状态无效");
		await database.query(
			"UPDATE agent_sessions SET title = COALESCE($1, title), status = COALESCE($2, status), updated_at = now() WHERE id = $3 AND user_id = $4 AND COALESCE(status, 'active') <> 'deleted'",
			[title, status, sessionId, userId],
		);
		return {
			...sessionView({
				...session,
				title: title ?? session.title,
				status: status ?? session.status,
				updated_at: new Date(),
			}),
			status: status ?? session.status,
		};
	});

	app.delete("/api/v1/agent/sessions/:sessionId", async (request) => {
		const userId = requireUserId(request);
		const sessionId = routeId(request, "sessionId");
		await requireSession(database, userId, sessionId);
		await database.query(
			"UPDATE agent_sessions SET status = 'deleted', updated_at = now() WHERE id = $1 AND user_id = $2",
			[sessionId, userId],
		);
		return { status: "deleted", sessionId };
	});

	app.post("/api/v1/agent/sessions/:sessionId/copy", async (request, reply) => {
		const userId = requireUserId(request);
		const source = await requireSession(database, userId, routeId(request, "sessionId"));
		const body = recordBody(request.body);
		const id = nextId();
		const canvasId = optionalId(body.canvasId) ?? source.canvas_id;
		const title = optionalString(body.title) ?? `${source.title} 副本`;
		await database.query(
			"INSERT INTO agent_sessions (id, user_id, canvas_id, title, status, model_usage) VALUES ($1, $2, $3, $4, 'active', '{}'::jsonb)",
			[id, userId, canvasId, title],
		);
		return await reply.status(201).send({ sessionId: id, title, canvasId, copiedFrom: source.id });
	});

	app.get("/api/v1/agent/sessions/:sessionId/messages", async (request) => {
		const sessionId = routeId(request, "sessionId");
		await requireSession(database, requireUserId(request), sessionId);
		const rows = await database.query<MessageRow>(
			"SELECT id, role, msg_type, content, meta, created_at FROM agent_messages WHERE session_id = $1 ORDER BY id",
			[sessionId],
		);
		return {
			items: rows.rows.map((message) => ({
				id: message.id,
				role: message.role,
				type: message.msg_type,
				content: message.role === "assistant" ? sanitizeAgentReply(message.content) : message.content,
				meta: objectOrEmpty(message.meta),
				createdAt: message.created_at.toISOString(),
			})),
		};
	});

	app.post("/api/v1/agent/sessions/:sessionId/messages", async (request, reply) => {
		reply.header("x-request-id", request.id);
		const userId = requireUserId(request);
		const sessionId = routeId(request, "sessionId");
		const body = recordBody(request.body);
		const content = requiredString(body.content, "content");
		const session = await requireSession(database, userId, sessionId);
		const requestedCanvas = optionalId(body.canvasId ?? body.canvas_id);
		assertSessionCanvasAccess(session.canvas_id, requestedCanvas);
		if (!session.canvas_id) throw new ApiError(400, "INVALID_INPUT", "会话未绑定画布，请在画布页重新打开 Agent");
		const selectedNodeIds = uniqueStrings(
			stringArray(body.selectedNodeIds)
				.map((id) => optionalId(id))
				.filter((id): id is string => id !== undefined),
		);
		if (selectedNodeIds.length > MAX_NODE_REFERENCES) {
			throw new NodeReferenceContextError("INVALID_INPUT", `每轮最多引用 ${MAX_NODE_REFERENCES} 个节点`);
		}
		const nodeReferences = await referenceGateway.getNodeReferences(
			userId,
			session.canvas_id,
			selectedNodeIds,
			request.id,
		);
		const profile = selectProfile({
			entrypoint: optionalString(body.entrypoint) as "canvas" | "assets" | "audit" | undefined,
			canvasDomain: optionalString(body.canvasDomain) as "general" | "short-drama" | "assets" | undefined,
		});
		const intent = routeAgentIntent({ content, profile, selectedNodeCount: selectedNodeIds.length });
		const idempotencyKey = requiredIdempotencyKey(request);
		const existingRun = await runRepository.findByIdempotency(sessionId, idempotencyKey);
		if (existingRun) {
			return sendRunEventSse(reply, await runService.listEvents(existingRun.runId));
		}
		const run = await runService.startRun({ sessionId, idempotencyKey });
		await addMessage(database, sessionId, "user", content, { selectedNodeIds, nodeReferences });
		await database.query(
			"UPDATE agent_sessions SET title = CASE WHEN title IN ('新对话', '画布对话') THEN $1 ELSE title END, updated_at = now() WHERE id = $2",
			[content.slice(0, 48), sessionId],
		);
		const history = await readHistory(database, sessionId);
		const skillContext = await resolveSkillContext(database, userId, sessionId);
		const memoryContext = await resolveMemoryContext(
			database,
			userId,
			session.id,
			session.canvas_id,
			optionalId(request.headers["x-enterprise-id"]),
		);
		const runId = run.runId;
		const directReply = await resolveCanvasFactReply(taskGateway, userId, session.canvas_id, content, request.id);
		if (directReply) {
			await addMessage(database, sessionId, "assistant", directReply, {});
			await runRepository.updateStatus(runId, "running");
			reply.hijack();
			reply.raw.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"X-Request-Id": request.id,
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});
			reply.raw.write(": connected\n\n");
			const responseEvent = await runService.appendEvent(runId, "assistant_delta", { text: directReply });
			reply.raw.write(`id: ${responseEvent.eventSeq}\nevent: ${responseEvent.type}\ndata: ${JSON.stringify(toEnvelope(responseEvent))}\n\n`);
			await runService.setStatus(runId, "completed", { text: directReply });
			const completedEvent = (await runService.listEvents(runId)).at(-1);
			if (completedEvent)
				reply.raw.write(`id: ${completedEvent.eventSeq}\nevent: ${completedEvent.type}\ndata: ${JSON.stringify(toEnvelope(completedEvent))}\n\n`);
			reply.raw.end();
			return reply;
		}
		const live: {
			assistantText: string;
			count: number;
			repeatedReadLimitReached: boolean;
			toolCalls: Map<string, number>;
			errorCode?: string;
		} = { assistantText: "", count: 0, repeatedReadLimitReached: false, toolCalls: new Map() };
		const modelId = await resolveRequestedTextModel(
			taskGateway,
			userId,
			optionalString(body.modelId),
			config.llmModel,
			request.id,
		);
		const runtimeTools = createRuntimeTools({
			userId,
			sessionId,
			runId,
			canvasId: session.canvas_id,
			canvasVersion: optionalInteger(body.canvasVersion) ?? 0,
			canvasVersionPinned: (optionalInteger(body.canvasVersion) ?? 0) > 0,
			referenceNodeIds: nodeReferences.map((reference) => reference.nodeId),
			requestId: request.id,
			gateway: taskGateway,
			approvals: approvalService,
			onAuditRequested: async (input) => {
				const report = renderAuditService.audit({ ownerId: userId, ...input });
				const reportId = nextId();
				await database.query(
					`INSERT INTO render_reviews
					 (id, canvas_id, user_id, target_node_id, target_kind, scores, failures, recommended_action, evidence, retry_count, status)
					 VALUES ($1, $2, $3, $4, 'clip', $5::jsonb, $6::jsonb, $7, $8::jsonb, 0, $9)`,
					[
						reportId,
						session.canvas_id,
						userId,
						input.targetNodeId,
						JSON.stringify({ verdict: report.verdict, ruleVersion: report.ruleVersion }),
						JSON.stringify(report.findings),
						report.verdict === "pass" ? "accept" : "fix_and_retry",
						JSON.stringify({ ruleVersion: report.ruleVersion, reportId: report.id }),
						report.verdict,
					],
				);
				return { ...report, id: reportId };
			},
			onApprovalRequired: async (action) => {
				await runRepository.updateStatus(runId, "waiting_confirmation");
				const recovery = confirmationRecoveryMessage({
					tool: action.toolName,
					actionId: action.actionId,
					approvalToken: action.approvalToken,
					estimatedCost: action.estimatedCost,
					canvasVersion: action.canvasVersion,
					expiresAt: action.binding.expiresAt,
					affectedNodeCount:
						action.toolName === "submit_generation_batch" ? generationItemCount(action.params) : 1,
				});
				await addMessage(database, sessionId, "assistant", recovery.content, recovery.meta);
				const event = await runService.appendEvent(runId, "confirmation_required", {
					actionId: action.actionId,
					approvalToken: action.approvalToken,
					tool: action.toolName,
					summary: `确认执行 ${action.toolName}`,
					confirmReason: action.risk === "high" ? "该操作会产生外部副作用或点数费用" : undefined,
					estimatedCost: action.estimatedCost,
					estimatedTotalCost: action.estimatedCost,
					affectedNodeCount:
						action.toolName === "submit_generation_batch" ? generationItemCount(action.params) : 1,
					canvasVersion: action.canvasVersion,
					expiresAt: action.binding.expiresAt,
				});
				eventStream.publishEvent(toEnvelope(event));
			},
		});
		activeRuns.set(sessionId, runId);
		await runRepository.updateStatus(runId, "running");
		reply.hijack();
		reply.raw.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"X-Request-Id": request.id,
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		reply.raw.flushHeaders();
		reply.raw.write(": connected\n\n");
		const unsubscribe = eventStream.subscribe(runId, (event) => {
			reply.raw.write(`id: ${event.eventSeq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		});
		try {
			const outcome = await runTurn(
				config,
				dramaState,
				sessionId,
				history.slice(0, -1),
				content,
				skillContext,
				nodeReferences,
				{
					onAgent: (agent) => activeAgents.set(sessionId, agent),
					runtimeTools,
					profile,
					modelId,
					memoryContext,
					intentContext: formatIntentContext(intent),
					requiredToolName: intent.requiredToolName,
					shouldStopAfterTurn: async () =>
						cancelledSessions.has(sessionId) ||
						Boolean(live.errorCode) ||
						live.repeatedReadLimitReached ||
						(await runRepository.findById(runId))?.status === "aborted",
					onEvent: async (event) => {
						live.count += 1;
						if (event.type === "tool_started" && event.toolName === "get_canvas_summary") {
							const calls = (live.toolCalls.get(event.toolName) ?? 0) + 1;
							live.toolCalls.set(event.toolName, calls);
							// One authoritative summary is enough per turn.  A second call is
							// allowed for the model to recover from a transient read, then stop.
							if (calls >= 2) live.repeatedReadLimitReached = true;
						}
						if (event.type === "error") live.errorCode = event.errorCode ?? "MODEL_UNAVAILABLE";
						if (event.type === "tool" && event.ok === false && event.errorCode) live.errorCode = event.errorCode;
						live.assistantText = await persistTurnEvent(
							runService,
							eventStream,
							runId,
							sessionId,
							event,
							live.assistantText,
						);
					},
				},
			);
			if (cancelledSessions.delete(sessionId) || (await runRepository.findById(runId))?.status === "aborted") {
				await publishLatestRunEvent(runService, eventStream, runId);
				return reply;
			}
			if ((await runRepository.findById(runId))?.status === "waiting_confirmation") return reply;
			if (live.errorCode) {
				if (live.errorCode === "RUN_ABORTED") await runService.cancelRun(runId);
				else await runService.setStatus(runId, "failed", { errorCode: live.errorCode, message: "模型调用失败" });
				await publishLatestRunEvent(runService, eventStream, runId);
				return reply;
			}
			if (live.count === 0) await persistTurnEvents(runService, eventStream, runId, sessionId, outcome.events);
			const assistantText = outcome.assistantText || live.assistantText || missingAssistantReply(content);
			if (assistantText) await addMessage(database, sessionId, "assistant", assistantText, {});
			await database.query(
				`UPDATE agent_sessions SET token_used_total = token_used_total + $1,
					model_usage = jsonb_set(model_usage, '{assistant}', to_jsonb(COALESCE((model_usage->>'assistant')::integer, 0) + $1)), updated_at = now()
				 WHERE id = $2`,
				[outcome.totalTokens, sessionId],
			);
			await runService.setStatus(runId, "completed", { text: assistantText });
			await publishLatestRunEvent(runService, eventStream, runId);
			return reply;
		} catch (error) {
			const current = await runRepository.findById(runId);
			if (current && isCallbackActiveRun(current.status))
				await runService.setStatus(runId, "failed", {
					errorCode: error instanceof AgentRuntimeError ? error.code : "INTERNAL_ERROR",
					message: error instanceof Error ? error.message : "Agent 运行失败",
				});
			await publishLatestRunEvent(runService, eventStream, runId);
			return reply;
		} finally {
			unsubscribe();
			reply.raw.end();
			activeRuns.delete(sessionId);
			activeAgents.delete(sessionId);
		}
	});

	app.get("/api/v1/agent/sessions/:sessionId/events", async (request, reply) => {
		const sessionId = routeId(request, "sessionId");
		await requireSession(database, requireUserId(request), sessionId);
		const query = request.query as { afterSeq?: string };
		const afterSeq = Number.parseInt(query.afterSeq ?? "0", 10);
		const cursor = Number.isSafeInteger(afterSeq) && afterSeq >= 0 ? afterSeq : 0;
		const active = await runRepository.findActive(sessionId);
		reply.hijack();
		reply.raw.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"X-Request-Id": request.id,
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		reply.raw.flushHeaders();
		reply.raw.write(": connected\n\n");
		if (!active) {
			reply.raw.write('event: idle\ndata: {"type":"idle"}\n\n');
			reply.raw.end();
			return reply;
		}
		const persisted = await runService.listEvents(active.runId, cursor);
		const events = mergeRunEvents(persisted.map(toEnvelope), eventStream.replay(active.runId, cursor));
		let lastSeq = cursor;
		const write = (event: ReturnType<typeof toEnvelope>): void => {
			if (event.eventSeq <= lastSeq) return;
			lastSeq = event.eventSeq;
			reply.raw.write(`id: ${event.eventSeq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		};
		for (const event of events) write(event);
		if (active.status === "waiting_confirmation") {
			reply.raw.end();
			return reply;
		}
		const unsubscribe = eventStream.subscribe(active.runId, (event) => {
			write(event);
			if (event.type === "run_completed" || event.type === "run_failed" || event.type === "run_aborted") {
				unsubscribe();
				reply.raw.end();
			}
		});
		request.raw.once("close", unsubscribe);
		return reply;
	});

	app.post("/api/v1/agent/sessions/:sessionId/cancel", async (request) => {
		const userId = requireUserId(request);
		const sessionId = routeId(request, "sessionId");
		await requireSession(database, userId, sessionId);
		const runId = activeRuns.get(sessionId) ?? (await runRepository.findActive(sessionId))?.runId;
		if (!runId) return { cancelled: false };
		const cancelled = await runService.cancelRun(runId);
		if (!cancelled) return { cancelled: false, runId };
		cancelledSessions.add(sessionId);
		activeAgents.get(sessionId)?.abort();
		await publishLatestRunEvent(runService, eventStream, runId);
		return { cancelled: true, runId };
	});

	app.get("/api/v1/agent/sessions/:sessionId/usage", async (request) => {
		const session = await requireSession(database, requireUserId(request), routeId(request, "sessionId"));
		return {
			sessionId: session.id,
			tokenTotal: session.token_used_total,
			pointsUsed: session.points_used_total,
			modelUsage: objectOrEmpty(session.model_usage),
		};
	});

	app.get("/api/v1/agent/sessions/:sessionId/skills", async (request) => {
		const userId = requireUserId(request);
		const sessionId = routeId(request, "sessionId");
		await requireSession(database, userId, sessionId);
		const context = await resolveSkillContext(database, userId, sessionId);
		return { index: context.indexLines, loadedSkillIds: context.loadedSkillIds };
	});

	app.put("/api/v1/agent/sessions/:sessionId/skills", async (request) => {
		const userId = requireUserId(request);
		const sessionId = routeId(request, "sessionId");
		await requireSession(database, userId, sessionId);
		const skillIds = stringArray(recordBody(request.body).skillIds);
		await ensureBuiltinSkills(database);
		const skills = await database.query<{ id: string; source: string }>(
			"SELECT id, source FROM skills WHERE id = ANY($1::bigint[]) AND enabled = true AND (owner_id = 0 OR owner_id = $2)",
			[skillIds, userId],
		);
		if (skills.rows.length !== skillIds.length || skills.rows.some((skill) => skill.source === "builtin")) {
			throw new ApiError(400, "INVALID_INPUT", "只能启用当前用户可用的动态 Skill");
		}
		const selectedSkills = await database.query<SkillRow>(
			"SELECT id, owner_id, name, description, instructions, source, category, version, enabled, created_at, updated_at FROM skills WHERE id = ANY($1::bigint[])",
			[skillIds],
		);
		await Promise.all(selectedSkills.rows.map((skill) => ensureSkillVersion(database, skill)));
		const snapshot = selectedSkills.rows.map(skillSnapshot);
		await database.query(
			"UPDATE agent_sessions SET skill_snapshot = $1::jsonb, loaded_skill_ids = '[]'::jsonb, updated_at = now() WHERE id = $2",
			[JSON.stringify(snapshot), sessionId],
		);
		return { sessionId, skillIds, snapshot };
	});

	app.post("/api/v1/agent/sessions/:sessionId/skills/:skillId:attach", async (request) => {
		const userId = requireUserId(request);
		const sessionId = routeId(request, "sessionId");
		await requireSession(database, userId, sessionId);
		const skill = await requireSkill(database, userId, routeId(request, "skillId"));
		if (skill.owner_id === "0" || skill.source === "builtin")
			throw new ApiError(400, "INVALID_INPUT", "只能附加用户 Skill");
		await ensureSkillVersion(database, skill);
		const current = await database.query<{ skill_snapshot: unknown }>(
			"SELECT skill_snapshot FROM agent_sessions WHERE id = $1",
			[sessionId],
		);
		const snapshots = parseSkillSnapshots(current.rows[0]?.skill_snapshot);
		const next = snapshots.some((item) => item.id === skill.id) ? snapshots : [...snapshots, skillSnapshot(skill)];
		await database.query("UPDATE agent_sessions SET skill_snapshot = $1::jsonb, updated_at = now() WHERE id = $2", [
			JSON.stringify(next),
			sessionId,
		]);
		return { sessionId, skillId: skill.id, version: skill.version, attached: true, snapshot: skillSnapshot(skill) };
	});

	app.post("/api/v1/agent/sessions/:sessionId/confirmations/:actionId", async (request) => {
		const userId = requireUserId(request);
		const sessionId = routeId(request, "sessionId");
		const actionId = routeId(request, "actionId");
		const body = recordBody(request.body);
		const token = requiredString(body.approvalToken ?? body.token, "approvalToken");
		const accepted = body.accept === true;
		const session = await requireSession(database, userId, sessionId);
		if (!session.canvas_id) throw new ApiError(400, "INVALID_INPUT", "会话未绑定画布，请在画布页重新打开 Agent");
		if (!accepted) {
			const approval = await database.query<{ id: string; token_signature: string; expires_at: Date }>(
				"SELECT id, token_signature, expires_at FROM agent_approvals WHERE action_id = $1 AND session_id = $2 AND user_id = $3 AND status = 'pending'",
				[actionId, sessionId, userId],
			);
			const record = approval.rows[0];
			// Rejecting is a safe cleanup operation and must remain possible after the
			// confirmation TTL. Keep signature validation so an expired token cannot
			// be used to reject another user's pending action.
			if (!record || !verifyToken(config, token, record.token_signature))
				throw new ApiError(400, "CONFIRMATION_REQUIRED", "确认令牌无效或已过期");
			await database.query(
				"UPDATE agent_approvals SET status = 'rejected', consumed_at = now() WHERE id = $1 AND status = 'pending'",
				[record.id],
			);
			await database.query("UPDATE agent_actions SET status = 'rejected' WHERE id = $1", [actionId]);
			await persistConfirmationStatus(database, sessionId, actionId, "rejected");
			// A rejected confirmation terminates the waiting turn. Leaving the run in
			// waiting_confirmation would block every subsequent natural-language turn
			// in this session after an expired/stale card is dismissed.
			const waitingRun = await runRepository.findActive(sessionId);
			if (waitingRun?.status === "waiting_confirmation") {
				await runService.setStatus(waitingRun.runId, "completed", { text: "用户已取消确认，未执行生成任务" });
			}
			return { ok: true, actionId, accepted: false, status: "rejected" };
		}

		const submittedCanvasVersion = requiredInteger(body.canvasVersion, "canvasVersion");
		const currentCanvasVersion = await taskGateway.getCanvasVersion(userId, session.canvas_id, request.id);
		if (submittedCanvasVersion !== currentCanvasVersion)
			throw new ToolGatewayError("VERSION_CONFLICT", "画布版本已变化，请刷新后重试", {
				currentVersion: currentCanvasVersion,
				submittedVersion: submittedCanvasVersion,
			});
		const consumed = await approvalService.consumeApproval(actionId, token, submittedCanvasVersion);
		if (consumed.userId !== userId || consumed.sessionId !== sessionId)
			throw new ApiError(403, "PERMISSION_DENIED", "确认操作不属于当前会话");
		await persistConfirmationStatus(database, sessionId, actionId, "accepted");
		const params = consumed.params;
		const batchItems = consumed.toolName === "submit_generation_batch" ? batchGenerationItems(params) : undefined;
		const singleItem = batchItems ? undefined : singleGenerationItem(params);
		const items = batchItems ?? [{ ...singleItem!, estimatedCost: consumed.estimatedCost }];
		try {
			const execution = await generationExecutor.executeBatch(
				items.map((item, index) => ({
					actionId: items.length === 1 ? actionId : `${actionId}:${index}`,
					userId,
					canvasId: consumed.canvasId,
					nodeId: item.nodeId,
					modelType: item.modelType,
					modelParams: item.modelParams,
					requestedCost: item.estimatedCost,
					costCap: item.estimatedCost,
					requestId: request.id,
				})),
			);
			const results = execution.results;
			if (items.length === 1) {
				const result = results[0]!;
				await database.query(
					"UPDATE agent_actions SET status = $1, task_id = $2, result = $3::jsonb WHERE id = $4",
					[
						result.compensationRequired ? "compensation_required" : "running",
						result.taskId,
						JSON.stringify(result),
						actionId,
					],
				);
			} else {
				await database.query("UPDATE agent_actions SET status = 'running', result = $1::jsonb WHERE id = $2", [
					JSON.stringify({
						batch: true,
						tasks: results.map((result, index) => ({ ...result, nodeId: items[index]!.nodeId })),
					}),
					actionId,
				]);
				for (const [index, result] of results.entries()) {
					const item = items[index]!;
					await database.query(
						`INSERT INTO agent_actions
						 (id, session_id, run_id, user_id, action_type, tool_name, params, risk_level, status, canvas_version, estimated_cost, task_id, result, idempotency_key)
						 VALUES ($1, $2, NULLIF($3, '')::bigint, $4, 'batch_task', 'submit_generation', $5::jsonb, 'high', $6, $7, $8, $9, $10::jsonb, $11)`,
						[
							nextId(),
							sessionId,
							consumed.runId ?? "",
							userId,
							JSON.stringify(item),
							result.compensationRequired ? "compensation_required" : "running",
							consumed.canvasVersion,
							result.actualCost,
							result.taskId,
							JSON.stringify(result),
							`batch:${actionId}:${index}`,
						],
					);
				}
			}
			const pendingRun = await runRepository.findActive(sessionId);
			const events: ReturnType<typeof toEnvelope>[] = [];
			if (pendingRun) {
				await runRepository.updateStatus(pendingRun.runId, "waiting_task");
				for (const [index, result] of results.entries()) {
					const queued = await runService.appendEvent(pendingRun.runId, "task_status", {
						task_id: result.taskId,
						status: "queued",
						node_id: items[index]!.nodeId,
						canvas_id: consumed.canvasId,
					});
					eventStream.publishEvent(toEnvelope(queued));
					events.push(toEnvelope(queued));
				}
			}
			return {
				ok: true,
				accepted: true,
				status: "running",
				events,
				taskId: results[0]?.taskId,
				taskIds: results.map((result) => result.taskId),
			};
		} catch (error) {
			await database.query("UPDATE agent_actions SET status = 'failed', error_code = $1 WHERE id = $2", [
				error instanceof ToolGatewayError ? error.code : "GENERATION_UNAVAILABLE",
				actionId,
			]);
			throw error;
		}
	});

	registerSkillRoutes(app, database);
	registerMemoryRoutes(app, database, memoryService);
	registerFragmentRoutes(app, database);
	registerReviewRoutes(app, database);
	registerDramaRoutes(app, dramaState, config);
	registerDramaStoryRoutes(app, dramaStory);
	registerPostProductionRoutes(app, postProduction);
	registerPlanRoutes(app, planRepository);
	registerRenderBatchRoutes(app, renderBatchRepository, taskGateway, generationExecutor, approvalService);
	registerInternalRoutes(
		app,
		database,
		runService,
		runRepository,
		eventStream,
		terminalService,
		renderBatchRepository,
		planRepository,
	);
	return app;
}

function registerSkillRoutes(app: FastifyInstance, database: SqlExecutor): void {
	app.get("/api/v1/skills", async (request) => {
		const userId = requireUserId(request);
		await ensureBuiltinSkills(database);
		const query = request.query as { keyword?: string; category?: string };
		const rows = await database.query<SkillRow>(
			`SELECT id, owner_id, name, description, instructions, source, category, version, enabled, created_at, updated_at
			 FROM skills WHERE (owner_id = $1 OR owner_id = 0)
			 AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%' OR description ILIKE '%' || $2 || '%')
			 AND ($3::text IS NULL OR $3 IN ('all', '全部') OR category = $3) ORDER BY owner_id DESC, name`,
			[userId, optionalString(query.keyword), optionalString(query.category)],
		);
		return { items: rows.rows.map(skillView) };
	});

	app.get("/api/v1/skills/:skillId", async (request) => {
		const skill = await requireSkill(database, requireUserId(request), routeId(request, "skillId"));
		return skillView(skill);
	});

	app.post("/api/v1/skills", async (request, reply) => {
		const userId = requireUserId(request);
		const body = recordBody(request.body);
		const id = nextId();
		await database.query(
			`INSERT INTO skills (id, owner_id, name, description, instructions, source, category)
			 VALUES ($1, $2, $3, $4, $5, 'manual', $6)`,
			[
				id,
				userId,
				requiredString(body.name, "name"),
				optionalString(body.description),
				requiredString(body.instructions, "instructions"),
				optionalString(body.category) ?? "general",
			],
		);
		const created = await requireSkill(database, userId, id);
		await ensureSkillVersion(database, created);
		return await reply.status(201).send(skillView(created));
	});

	app.post("/api/v1/skills/upload", async (request, reply) => {
		const userId = requireUserId(request);
		const file = await request.file();
		if (!file || (!file.filename.endsWith(".md") && !file.filename.endsWith(".markdown"))) {
			throw new ApiError(400, "INVALID_INPUT", "仅支持 .md 文件");
		}
		const instructions = (await file.toBuffer()).toString("utf8");
		if (Buffer.byteLength(instructions) > 512 * 1024) throw new ApiError(400, "INVALID_INPUT", "文件超过 512KB");
		const id = nextId();
		await database.query(
			`INSERT INTO skills (id, owner_id, name, description, instructions, source, category)
			 VALUES ($1, $2, $3, '上传的 Skill 文件', $4, 'upload', 'general')`,
			[id, userId, file.filename.replace(/\.(md|markdown)$/i, "").slice(0, 64) || "上传 Skill", instructions],
		);
		const created = await requireSkill(database, userId, id);
		await ensureSkillVersion(database, created);
		return await reply.status(201).send(skillView(created));
	});

	app.put("/api/v1/skills/:skillId", async (request) => {
		const userId = requireUserId(request);
		const skillId = routeId(request, "skillId");
		const body = recordBody(request.body);
		const skill = await requireSkill(database, userId, skillId);
		if (skill.owner_id === "0" || skill.source === "builtin")
			throw new ApiError(403, "PERMISSION_DENIED", "内置 Skill 不可编辑内容");
		await database.query(
			`UPDATE skills SET name = COALESCE($1, name), description = COALESCE($2, description), instructions = COALESCE($3, instructions),
			 category = COALESCE($4, category), enabled = COALESCE($5, enabled),
			 version = version + CASE WHEN $3::text IS NULL THEN 0 ELSE 1 END, updated_at = now() WHERE id = $6`,
			[
				optionalString(body.name),
				optionalString(body.description),
				optionalString(body.instructions),
				optionalString(body.category),
				optionalBoolean(body.enabled),
				skillId,
			],
		);
		const updated = await requireSkill(database, userId, skillId);
		await ensureSkillVersion(database, updated);
		return skillView(updated);
	});

	app.delete("/api/v1/skills/:skillId", async (request) => {
		const userId = requireUserId(request);
		const skill = await requireSkill(database, userId, routeId(request, "skillId"));
		if (skill.owner_id === "0" || skill.source === "builtin")
			throw new ApiError(403, "PERMISSION_DENIED", "内置 Skill 不可删除");
		await database.query("DELETE FROM skills WHERE id = $1", [skill.id]);
		return { status: "ok" };
	});
}

function registerMemoryRoutes(app: FastifyInstance, database: SqlExecutor, memoryService?: MemoryService): void {
	app.get("/api/v1/memories", async (request) => {
		const userId = requireUserId(request);
		if (memoryService) {
			const items = await memoryService.export(userId);
			return {
				items: items.map((memory) => ({
					id: memory.id,
					content: memory.content,
					memoryType: memory.memoryType ?? memory.scope,
					scope: memory.scope,
					canvasId: memory.canvasId,
					createdAt: memory.createdAt?.toISOString(),
				})),
			};
		}
		const rows = await database.query<MemoryRow>(
			`SELECT id, content, memory_type, created_at FROM user_memories
			 WHERE user_id = $1 AND scope = 'long_term' AND deleted = false AND (expires_at IS NULL OR expires_at > now())
			 ORDER BY created_at DESC`,
			[userId],
		);
		return {
			items: rows.rows.map((memory) => ({
				id: memory.id,
				content: memory.content,
				memoryType: memory.memory_type,
				createdAt: memory.created_at.toISOString(),
			})),
		};
	});

	app.post("/api/v1/memories", async (request, reply) => {
		const userId = requireUserId(request);
		const body = recordBody(request.body);
		if (memoryService) {
			const scope = memoryScope(body.scope ?? "long_term");
			const sessionId = optionalId(body.sessionId);
			if (scope === "session" && !sessionId)
				throw new ApiError(400, "INVALID_INPUT", "session scope 必须绑定 sessionId");
			if (sessionId) await requireSession(database, userId, sessionId);
			const tenantId = optionalId(body.tenantId ?? request.headers["x-enterprise-id"]);
			const role = request.headers["x-user-role"];
			const memory = await memoryService.write({
				userId,
				tenantId,
				canvasId: optionalId(body.canvasId),
				sessionId,
				scope,
				content: requiredString(body.content, "content"),
				memoryType: optionalString(body.memoryType),
				confidence: optionalNumber(body.confidence) ?? 1,
				source: optionalString(body.source) ?? "user",
				visibility: scope === "enterprise" ? "enterprise" : "user",
				adminAuthorized: role === "enterprise_admin" || role === "admin",
			});
			return await reply.status(201).send({ id: memory.id, content: memory.content, scope: memory.scope });
		}
		const id = nextId();
		const content = requiredString(body.content, "content");
		await database.query(
			"INSERT INTO user_memories (id, user_id, content, memory_type, scope) VALUES ($1, $2, $3, $4, 'long_term')",
			[id, userId, content, optionalString(body.memoryType) ?? "preference"],
		);
		return await reply.status(201).send({ id, content });
	});

	app.delete("/api/v1/memories/:memoryId", async (request) => {
		if (memoryService) {
			await memoryService.remove(routeId(request, "memoryId"), requireUserId(request));
			return { status: "ok" };
		}
		const result = await database.query<{ id: string }>(
			"UPDATE user_memories SET deleted = true WHERE id = $1 AND user_id = $2 AND deleted = false RETURNING id",
			[routeId(request, "memoryId"), requireUserId(request)],
		);
		if (!result.rows[0]) throw new ApiError(404, "NOT_FOUND", "记忆不存在");
		return { status: "ok" };
	});
}

function registerFragmentRoutes(app: FastifyInstance, database: SqlExecutor): void {
	app.post("/api/v1/agent/sessions/:sessionId/fragments", async (request, reply) => {
		const userId = requireUserId(request);
		const session = await requireSession(database, userId, routeId(request, "sessionId"));
		const body = recordBody(request.body);
		const messages = await database.query<MessageRow>(
			"SELECT id, role, msg_type, content, meta, created_at FROM agent_messages WHERE session_id = $1 ORDER BY id",
			[session.id],
		);
		const id = nextId();
		await database.query(
			"INSERT INTO session_fragments (id, owner_id, title, content, canvas_id) VALUES ($1, $2, $3, $4::jsonb, $5)",
			[
				id,
				userId,
				optionalString(body.title) ?? session.title,
				JSON.stringify(messages.rows.map((message) => ({ role: message.role, content: message.content }))),
				session.canvas_id,
			],
		);
		return await reply.status(201).send({ fragmentId: id });
	});

	app.get("/api/v1/agent/fragments", async (request) => {
		const rows = await database.query<FragmentRow>(
			"SELECT id, title, canvas_id, content, created_at FROM session_fragments WHERE owner_id = $1 ORDER BY id DESC",
			[requireUserId(request)],
		);
		return {
			items: rows.rows.map((fragment) => ({
				id: fragment.id,
				title: fragment.title,
				canvasId: fragment.canvas_id,
				createdAt: fragment.created_at.toISOString(),
			})),
		};
	});

	app.post("/api/v1/agent/fragments/:fragmentId/import", async (request, reply) => {
		const userId = requireUserId(request);
		const body = recordBody(request.body);
		const fragments = await database.query<FragmentRow>(
			"SELECT id, title, canvas_id, content, created_at FROM session_fragments WHERE id = $1 AND owner_id = $2",
			[routeId(request, "fragmentId"), userId],
		);
		const fragment = fragments.rows[0];
		if (!fragment) throw new ApiError(404, "NOT_FOUND", "片段不存在");
		const sessionId = nextId();
		const canvasId = optionalId(body.canvasId) ?? fragment.canvas_id;
		await database.query(
			"INSERT INTO agent_sessions (id, user_id, canvas_id, title, status, model_usage) VALUES ($1, $2, $3, $4, 'active', '{}'::jsonb)",
			[sessionId, userId, canvasId, fragment.title ?? "新对话"],
		);
		if (Array.isArray(fragment.content)) {
			for (const item of fragment.content) {
				if (
					typeof item === "object" &&
					item !== null &&
					"role" in item &&
					"content" in item &&
					typeof item.role === "string" &&
					typeof item.content === "string"
				) {
					if (item.role === "user" || item.role === "assistant" || item.role === "system")
						await addMessage(database, sessionId, item.role, item.content, {});
				}
			}
		}
		return await reply.status(201).send({ sessionId });
	});
}

function registerReviewRoutes(app: FastifyInstance, database: SqlExecutor): void {
	const auditService = new RenderAuditService();
	app.post("/api/v1/render-reviews", async (request, reply) => {
		const userId = requireUserId(request);
		const body = recordBody(request.body);
		const id = nextId();
		const report = auditService.audit({
			ownerId: userId,
			shotDurationSeconds: requiredInteger(body.shotDurationSeconds, "shotDurationSeconds"),
			expectedDurationSeconds: requiredInteger(body.expectedDurationSeconds, "expectedDurationSeconds"),
			characterConsistent: body.characterConsistent === true,
			audioDurationMs: requiredInteger(body.audioDurationMs, "audioDurationMs"),
			videoDurationMs: requiredInteger(body.videoDurationMs, "videoDurationMs"),
			previousCamera: requiredString(body.previousCamera, "previousCamera"),
			currentCamera: requiredString(body.currentCamera, "currentCamera"),
		});
		await database.query(
			`INSERT INTO render_reviews (id, canvas_id, user_id, target_node_id, target_kind, scores, failures, recommended_action, evidence, retry_count, status)
			 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10, $11)`,
			[
				id,
				requiredId(body.canvasId, "canvasId"),
				userId,
				requiredId(body.targetNodeId, "targetNodeId"),
				optionalString(body.targetKind) ?? "clip",
				JSON.stringify({ verdict: report.verdict, ruleVersion: report.ruleVersion }),
				JSON.stringify(report.findings),
				report.verdict === "pass" ? "accept" : "fix_and_retry",
				JSON.stringify({ ruleVersion: report.ruleVersion, ownerId: report.ownerId }),
				optionalInteger(body.retryCount) ?? 0,
				report.verdict,
			],
		);
		return await reply.status(201).send({ ...report, id });
	});

	app.get("/api/v1/render-reviews", async (request) => {
		const userId = requireUserId(request);
		const query = request.query as { canvasId?: string; targetNodeId?: string };
		const rows = await database.query<QueryResultRow>(
			"SELECT * FROM render_reviews WHERE user_id = $1 AND canvas_id = $2 AND ($3::bigint IS NULL OR target_node_id = $3::bigint) ORDER BY created_at DESC",
			[userId, requiredId(query.canvasId, "canvasId"), optionalId(query.targetNodeId)],
		);
		return { items: rows.rows };
	});
}

function registerDramaRoutes(app: FastifyInstance, store: PgDramaStateStore, config: ServiceConfig): void {
	const gateway = new ToolGateway(config);
	app.post("/api/v1/drama/series", async (request, reply) => {
		const userId = requireUserId(request);
		const body = recordBody(request.body);
		const series: DramaSeries = {
			id: optionalString(body.id) ?? randomUUID(),
			canvasId: requiredId(body.canvasId, "canvasId"),
			activeCanonRevision: optionalInteger(body.activeCanonRevision) ?? 1,
			format: STANDARD_VERTICAL_SHORT_DRAMA_FORMAT,
		};
		await store.createSeries(series, userId);
		return await reply.status(201).send(series);
	});

	app.post("/api/v1/drama/series/:seriesId/characters", async (request, reply) => {
		const userId = requireUserId(request);
		const body = recordBody(request.body);
		const character: CharacterProfile = {
			id: optionalString(body.id) ?? randomUUID(),
			seriesId: routeStringId(request, "seriesId"),
			name: requiredString(body.name, "name"),
			identityAnchors: stringArray(body.identityAnchors),
			activeLookRevision: optionalInteger(body.activeLookRevision) ?? 1,
			voiceId: requiredString(body.voiceId, "voiceId"),
		};
		await store.createCharacter(character, userId);
		return await reply.status(201).send(character);
	});

	app.post("/api/v1/drama/characters/:characterId/reference-packs", async (request, reply) => {
		const userId = requireUserId(request);
		const body = recordBody(request.body);
		const pack: CharacterReferencePack = {
			id: optionalString(body.id) ?? randomUUID(),
			characterId: routeStringId(request, "characterId"),
			lookRevision: requiredInteger(body.lookRevision, "lookRevision"),
			status: referenceStatus(body.status),
			frontAssetId: requiredString(body.frontAssetId, "frontAssetId"),
			sideAssetId: requiredString(body.sideAssetId, "sideAssetId"),
			backAssetId: requiredString(body.backAssetId, "backAssetId"),
			expressionAssetIds: stringArray(body.expressionAssetIds),
		};
		await store.addReferencePack(pack, userId);
		return await reply.status(201).send(pack);
	});

	app.post("/api/v1/drama/series/:seriesId/shots", async (request, reply) => {
		const userId = requireUserId(request);
		const body = recordBody(request.body);
		const shot: ShotSpec = {
			id: optionalString(body.id) ?? randomUUID(),
			seriesId: routeStringId(request, "seriesId"),
			episodeNo: requiredInteger(body.episodeNo, "episodeNo"),
			shotNo: requiredInteger(body.shotNo, "shotNo"),
			durationSeconds: requiredInteger(body.durationSeconds, "durationSeconds"),
			characterBindings: bindings(body.characterBindings),
			promptRevision: optionalInteger(body.promptRevision) ?? 1,
		};
		await store.createShot(shot, userId);
		return await reply.status(201).send(shot);
	});

	app.post("/api/v1/drama/shots/:shotId/keyframe-node", async (request) => {
		const userId = requireUserId(request);
		const body = recordBody(request.body);
		const idempotencyKey = requiredIdempotencyKey(request);
		const draft = await store.prepareKeyframeNode(routeStringId(request, "shotId"), userId);
		const canvasNode = await gateway.createCanvasNode(
			userId,
			requiredId(body.canvasId, "canvasId"),
			{
				type: "image",
				creativeType: "keyframe",
				prompt: requiredString(body.prompt, "prompt"),
				params: {
					shotId: draft.shotId,
					referencePackIds: draft.referencePackIds,
					referenceAssetIds: draft.referenceAssetIds,
					aspectRatio: "9:16",
					model: optionalString(body.model),
				},
			},
			request.id,
			idempotencyKey,
		);
		return { ...draft, canvasNodeId: canvasNode.id };
	});
	app.post("/api/v1/drama/shots/:shotId/keyframes", async (request, reply) => {
		const userId = requireUserId(request);
		const body = recordBody(request.body);
		const render: KeyframeRender = {
			id: optionalString(body.id) ?? randomUUID(),
			shotId: routeStringId(request, "shotId"),
			status: keyframeStatus(body.status),
			referencePackIds: stringArray(body.referencePackIds),
		};
		await store.recordKeyframe(render, userId);
		return await reply.status(201).send(render);
	});
	app.post("/api/v1/drama/shots/:shotId/video-node", async (request) => {
		const userId = requireUserId(request);
		const body = recordBody(request.body);
		const idempotencyKey = requiredIdempotencyKey(request);
		const draft = await store.prepareVideoNode(routeStringId(request, "shotId"), userId);
		const canvasNode = await gateway.createCanvasNode(
			userId,
			requiredId(body.canvasId, "canvasId"),
			{
				type: "video",
				creativeType: "clip",
				prompt: requiredString(body.prompt, "prompt"),
				params: {
					shotId: draft.shotId,
					keyframeRenderId: draft.keyframeRenderId,
					referencePackIds: draft.referencePackIds,
					aspectRatio: "9:16",
					model: optionalString(body.model),
				},
			},
			request.id,
			idempotencyKey,
		);
		return { ...draft, canvasNodeId: canvasNode.id };
	});
	app.post("/api/v1/drama/lineages", async (request, reply) => {
		const userId = requireUserId(request);
		const body = recordBody(request.body);
		const lineage: RenderLineage = {
			id: optionalString(body.id) ?? randomUUID(),
			shotId: requiredString(body.shotId, "shotId"),
			keyframeRenderId: requiredString(body.keyframeRenderId, "keyframeRenderId"),
			status: lineageStatus(body.status),
		};
		await store.recordLineage(lineage, userId);
		return await reply.status(201).send(lineage);
	});
	app.post("/api/v1/drama/characters/:characterId/stale-lineages", async (request) => {
		const userId = requireUserId(request);
		return { lineageIds: await store.markLineagesStaleForCharacter(routeStringId(request, "characterId"), userId) };
	});
}

function registerDramaStoryRoutes(app: FastifyInstance, story: PgDramaStoryService): void {
	app.post("/api/v1/drama/story-bibles", async (request, reply) => {
		const ownerId = requireUserId(request);
		const body = recordBody(request.body);
		const bible = await story.createBible({
			ownerId,
			title: requiredString(body.title, "title"),
			canon: requiredString(body.canon, "canon"),
		});
		return await reply.status(201).send(bible);
	});

	app.get(
		"/api/v1/drama/story-bibles/:bibleId",
		async (request) => await story.getBible(routeStringId(request, "bibleId"), requireUserId(request)),
	);

	app.patch("/api/v1/drama/story-bibles/:bibleId/canon", async (request) => {
		const body = recordBody(request.body);
		return await story.reviseCanon(
			routeStringId(request, "bibleId"),
			requireUserId(request),
			requiredString(body.canon, "canon"),
		);
	});

	app.post("/api/v1/drama/story-bibles/:bibleId/episodes", async (request, reply) => {
		const body = recordBody(request.body);
		const episode = await story.createEpisode({
			ownerId: requireUserId(request),
			bibleId: routeStringId(request, "bibleId"),
			number: requiredInteger(body.number ?? body.episodeNo, "number"),
			title: requiredString(body.title, "title"),
		});
		return await reply.status(201).send(episode);
	});

	app.post("/api/v1/drama/story-episodes/:episodeId/scenes", async (request, reply) => {
		const body = recordBody(request.body);
		const scene = await story.createScene({
			ownerId: requireUserId(request),
			episodeId: routeStringId(request, "episodeId"),
			number: requiredInteger(body.number ?? body.sceneNo, "number"),
			summary: requiredString(body.summary, "summary"),
		});
		return await reply.status(201).send(scene);
	});

	app.post("/api/v1/drama/story-scenes/:sceneId/facts", async (request, reply) => {
		const body = recordBody(request.body);
		const fact = await story.addContinuityFact({
			ownerId: requireUserId(request),
			sceneId: routeStringId(request, "sceneId"),
			statement: requiredString(body.statement, "statement"),
		});
		return await reply.status(201).send(fact);
	});

	app.get(
		"/api/v1/drama/story-scenes/:sceneId/facts",
		async (request) => await story.listContinuityFacts(routeStringId(request, "sceneId"), requireUserId(request)),
	);

	app.post("/api/v1/drama/story-scenes/:sceneId/foreshadows", async (request, reply) => {
		const body = recordBody(request.body);
		const foreshadow = await story.plantForeshadow({
			ownerId: requireUserId(request),
			sceneId: routeStringId(request, "sceneId"),
			clue: requiredString(body.clue, "clue"),
			payoff: requiredString(body.payoff, "payoff"),
		});
		return await reply.status(201).send(foreshadow);
	});

	app.post(
		"/api/v1/drama/foreshadows/:foreshadowId/resolve",
		async (request) => await story.resolveForeshadow(routeStringId(request, "foreshadowId"), requireUserId(request)),
	);
}

function registerPostProductionRoutes(app: FastifyInstance, service: PgPostProductionService): void {
	app.post("/api/v1/drama/post-production/videos", async (request, reply) => {
		const body = recordBody(request.body);
		const idempotencyKey = requiredIdempotencyKey(request);
		const artifact = await service.registerVideo({
			ownerId: requireUserId(request),
			durationMs: requiredInteger(body.durationMs, "durationMs"),
			taskId: requiredString(body.taskId, "taskId"),
			lineageIds: stringArray(body.lineageIds ?? []),
			idempotencyKey,
		});
		return await reply.status(201).send(artifact);
	});

	app.post("/api/v1/drama/post-production/videos/:videoId/tts", async (request, reply) => {
		const body = recordBody(request.body);
		const idempotencyKey = requiredIdempotencyKey(request);
		const artifact = await service.createTts({
			ownerId: requireUserId(request),
			videoId: routeId(request, "videoId"),
			durationMs: requiredInteger(body.durationMs, "durationMs"),
			language: requiredString(body.language, "language"),
			voiceId: requiredString(body.voiceId, "voiceId"),
			taskId: requiredString(body.taskId, "taskId"),
			idempotencyKey,
		});
		return await reply.status(201).send(artifact);
	});

	app.post("/api/v1/drama/post-production/videos/:videoId/subtitles", async (request, reply) => {
		const body = recordBody(request.body);
		const idempotencyKey = requiredIdempotencyKey(request);
		const artifact = await service.createSubtitle({
			ownerId: requireUserId(request),
			videoId: routeId(request, "videoId"),
			durationMs: requiredInteger(body.durationMs, "durationMs"),
			language: requiredString(body.language, "language"),
			segments: timelineSegments(body.segments),
			taskId: requiredString(body.taskId, "taskId"),
			idempotencyKey,
		});
		return await reply.status(201).send(artifact);
	});

	app.post("/api/v1/drama/post-production/composites", async (request, reply) => {
		const body = recordBody(request.body);
		const idempotencyKey = requiredIdempotencyKey(request);
		const artifact = await service.createComposite({
			ownerId: requireUserId(request),
			videoId: requiredId(body.videoId, "videoId"),
			ttsId: requiredId(body.ttsId, "ttsId"),
			subtitleId: requiredId(body.subtitleId, "subtitleId"),
			taskId: requiredString(body.taskId, "taskId"),
			idempotencyKey,
		});
		return await reply.status(201).send(artifact);
	});

	app.get("/api/v1/drama/post-production/artifacts", async (request) => ({
		items: await service.list(requireUserId(request)),
	}));
}

function registerRenderBatchRoutes(
	app: FastifyInstance,
	repository: PgRenderBatchRepository | undefined,
	gateway: ToolGateway,
	generationExecutor: GenerationActionExecutor,
	approvalService: ApprovalService,
): void {
	app.post("/api/v1/drama/render-batches", async (request, reply) => {
		if (!repository) throw new ApiError(503, "DATABASE_UNAVAILABLE", "渲染批次存储不可用");
		const body = recordBody(request.body);
		const userId = requireUserId(request);
		const idempotencyKey = requiredIdempotencyKey(request);
		const replay = await repository.findByIdempotencyKey(userId, idempotencyKey);
		if (replay) return replay;
		const jobInputs = renderBatchJobs(body.jobs);
		const estimates = await Promise.all(
			jobInputs.map(async (job) => {
				const estimate = await gateway.estimateGeneration({
					userId,
					modelType: job.modelType,
					modelParams: job.modelParams,
					requestId: request.id,
				});
				return { ...job, estimatedCost: estimate.estimatedCost };
			}),
		);
		const batch = await repository.create({
			ownerId: userId,
			canvasId: requiredId(body.canvasId, "canvasId"),
			seriesId: requiredString(body.seriesId, "seriesId"),
			episodeNo: requiredInteger(body.episodeNo, "episodeNo"),
			costCap: requiredInteger(body.costCap, "costCap"),
			idempotencyKey,
			sessionId: requiredId(body.sessionId, "sessionId"),
			canvasVersion: requiredInteger(body.canvasVersion, "canvasVersion"),
			jobs: estimates,
		});
		if (batch.estimatedCost < 1) return await reply.status(201).send(batch);
		const action = await approvalService.planActionAsync({
			userId,
			sessionId: batch.sessionId as string,
			canvasId: batch.canvasId,
			canvasVersion: batch.canvasVersion as number,
			toolName: "drama.render_batch.submit",
			params: { batchId: batch.id, estimatedCost: batch.estimatedCost },
			estimatedCost: batch.estimatedCost,
			risk: "high",
			requiresApproval: true,
		});
		const stored = await repository.attachApproval(batch.id, userId, action.actionId);
		return await reply.status(201).send({
			...stored,
			approval: {
				actionId: action.actionId,
				approvalToken: action.approvalToken,
				expiresAt: action.binding.expiresAt,
			},
		});
	});

	app.get("/api/v1/drama/render-batches", async (request) => {
		if (!repository) throw new ApiError(503, "DATABASE_UNAVAILABLE", "渲染批次存储不可用");
		return { items: await repository.list(requireUserId(request)) };
	});

	app.get("/api/v1/drama/render-batches/:batchId", async (request) => {
		if (!repository) throw new ApiError(503, "DATABASE_UNAVAILABLE", "渲染批次存储不可用");
		return await repository.get(routeId(request, "batchId"), requireUserId(request));
	});

	app.post("/api/v1/drama/render-batches/:batchId/submit", async (request) => {
		if (!repository) throw new ApiError(503, "DATABASE_UNAVAILABLE", "渲染批次存储不可用");
		const userId = requireUserId(request);
		requiredIdempotencyKey(request);
		const batch = await repository.get(routeId(request, "batchId"), userId);
		if (batch.status !== "draft" && batch.status !== "awaiting_approval" && batch.status !== "running")
			throw new RenderBatchError("BATCH_NOT_SUBMITTABLE");
		const draftJobs = batch.jobs.filter((job) => job.status === "draft");
		if (draftJobs.some((job) => !job.canvasNodeId)) throw new RenderBatchError("CANVAS_NODE_REQUIRED");
		if (draftJobs.length > 0 && batch.estimatedCost >= 1) {
			const body = recordBody(request.body);
			if (!batch.approvalActionId || !batch.sessionId || batch.canvasVersion === undefined)
				throw new RenderBatchError("CONFIRMATION_REQUIRED");
			const consumed = await approvalService.consumeApproval(
				requiredString(body.approvalActionId, "approvalActionId"),
				requiredString(body.approvalToken, "approvalToken"),
				requiredInteger(body.canvasVersion, "canvasVersion"),
			);
			if (
				consumed.actionId !== batch.approvalActionId ||
				consumed.userId !== userId ||
				consumed.sessionId !== batch.sessionId ||
				consumed.canvasId !== batch.canvasId ||
				consumed.params.batchId !== batch.id
			)
				throw new RenderBatchError("PERMISSION_DENIED");
		}
		for (const job of batch.jobs) {
			if (job.status !== "draft") continue;
			const canvasNodeId = job.canvasNodeId as string;
			try {
				const result = await generationExecutor.execute({
					actionId: `render-batch:${batch.id}:job:${job.id}`,
					userId,
					canvasId: batch.canvasId,
					nodeId: canvasNodeId,
					modelType: job.modelType,
					modelParams: job.modelParams,
					requestedCost: job.estimatedCost,
					costCap: job.estimatedCost,
					requestId: request.id,
				});
				await repository.markJob({
					batchId: batch.id,
					ownerId: userId,
					jobId: job.id,
					status: result.compensationRequired ? "failed" : "running",
					taskId: result.taskId,
					errorCode: result.compensationRequired ? "CANVAS_UNAVAILABLE" : undefined,
				});
			} catch (error) {
				await repository.markJob({
					batchId: batch.id,
					ownerId: userId,
					jobId: job.id,
					status: "failed",
					errorCode: error instanceof ToolGatewayError ? error.code : "GENERATION_UNAVAILABLE",
				});
			}
		}
		return await repository.get(batch.id, userId);
	});

	app.post("/api/v1/drama/render-batches/:batchId/jobs/:jobId/status", async (request) => {
		if (!repository) throw new ApiError(503, "DATABASE_UNAVAILABLE", "渲染批次存储不可用");
		const body = recordBody(request.body);
		const params = request.params as Record<string, string | undefined>;
		return await repository.markJob({
			batchId: requiredId(params.batchId, "batchId"),
			ownerId: requireUserId(request),
			jobId: requiredId(params.jobId, "jobId"),
			status: renderJobStatus(body.status),
			taskId: optionalString(body.taskId),
			errorCode: optionalString(body.errorCode),
		});
	});

	app.post("/api/v1/drama/render-batches/:batchId/jobs/:jobId/rerun", async (request) => {
		if (!repository) throw new ApiError(503, "DATABASE_UNAVAILABLE", "渲染批次存储不可用");
		const params = request.params as Record<string, string | undefined>;
		const batch = await repository.rerun(
			requiredId(params.batchId, "batchId"),
			requireUserId(request),
			requiredId(params.jobId, "jobId"),
		);
		if (batch.estimatedCost < 1) return batch;
		if (!batch.sessionId || batch.canvasVersion === undefined) throw new RenderBatchError("CONFIRMATION_REQUIRED");
		const action = await approvalService.planActionAsync({
			userId: batch.ownerId,
			sessionId: batch.sessionId,
			canvasId: batch.canvasId,
			canvasVersion: batch.canvasVersion,
			toolName: "drama.render_batch.submit",
			params: { batchId: batch.id, estimatedCost: batch.estimatedCost },
			estimatedCost: batch.estimatedCost,
			risk: "high",
			requiresApproval: true,
		});
		const stored = await repository.attachApproval(batch.id, batch.ownerId, action.actionId);
		return {
			...stored,
			approval: {
				actionId: action.actionId,
				approvalToken: action.approvalToken,
				expiresAt: action.binding.expiresAt,
			},
		};
	});
}

function renderBatchJobs(value: unknown): Array<{
	shotId: string;
	keyframeRenderId: string;
	canvasNodeId?: string;
	durationSeconds: number;
	modelType: string;
	modelParams: Record<string, unknown>;
	estimatedCost: number;
}> {
	if (!Array.isArray(value)) throw new ApiError(400, "INVALID_INPUT", "jobs 必须是数组");
	if (value.length === 0 || value.length > 90) throw new ApiError(400, "INVALID_SHOT_COUNT", "jobs 数量必须为 1-90");
	return value.map((item) => {
		const job = recordBody(item);
		return {
			shotId: requiredString(job.shotId, "job.shotId"),
			keyframeRenderId: requiredString(job.keyframeRenderId, "job.keyframeRenderId"),
			canvasNodeId: optionalId(job.canvasNodeId),
			durationSeconds: requiredInteger(job.durationSeconds, "job.durationSeconds"),
			modelType: requiredString(job.modelType, "job.modelType"),
			modelParams: objectOrEmpty(job.modelParams),
			estimatedCost: 0,
		};
	});
}

function registerPlanRoutes(app: FastifyInstance, repository?: PgPlanRepository): void {
	app.post("/api/v1/agent/sessions/:sessionId/plans", async (request, reply) => {
		if (!repository) throw new ApiError(503, "DATABASE_UNAVAILABLE", "计划存储不可用");
		const body = recordBody(request.body);
		const plan = parseAgentPlan(body.plan ?? body, routeId(request, "sessionId"));
		const profile = planProfile(body.profile);
		const compiled = await repository.create({
			ownerId: requireUserId(request),
			sessionId: routeId(request, "sessionId"),
			plan,
			expectedVersion: requiredInteger(body.expectedVersion ?? plan.version, "expectedVersion"),
			profile,
		});
		return await reply.status(201).send(compiled);
	});

	app.get("/api/v1/agent/plans/:planId", async (request) => {
		if (!repository) throw new ApiError(503, "DATABASE_UNAVAILABLE", "计划存储不可用");
		return await repository.get(routeId(request, "planId"), requireUserId(request));
	});

	app.get("/api/v1/agent/plans/:planId/ready-set", async (request) => {
		if (!repository) throw new ApiError(503, "DATABASE_UNAVAILABLE", "计划存储不可用");
		const query = request.query as { profile?: unknown };
		return await repository.readySet(routeId(request, "planId"), requireUserId(request), planProfile(query.profile));
	});

	app.post("/api/v1/agent/plans/:planId/rerun", async (request) => {
		if (!repository) throw new ApiError(503, "DATABASE_UNAVAILABLE", "计划存储不可用");
		const body = recordBody(request.body);
		return await repository.rerun({
			planId: routeId(request, "planId"),
			ownerId: requireUserId(request),
			stepId: requiredString(body.stepId, "stepId"),
		});
	});
}

function registerInternalRoutes(
	app: FastifyInstance,
	database: SqlExecutor,
	runService: SessionRunService,
	runRepository: RunRepository,
	eventStream: AgentEventStream,
	terminalService?: TaskTerminalService,
	renderBatchRepository?: PgRenderBatchRepository,
	planRepository?: PgPlanRepository,
): void {
	app.post("/internal/agent/resume", async (request) => {
		if (!terminalService) throw new ApiError(503, "INTERNAL_AUTH_NOT_CONFIGURED", "内部回调鉴权未配置");
		const supplied = request.headers["x-internal-service-token"];
		if (typeof supplied !== "string") throw new ApiError(401, "PERMISSION_DENIED", "内部服务鉴权失败");
		const body = recordBody(request.body);
		const taskId = requiredString(body.taskId ?? body.task_id, "taskId");
		const status = requiredString(body.status, "status");
		if (!isTerminalStatus(status)) throw new ApiError(400, "INVALID_INPUT", "非法任务终态");
		try {
			terminalService.assertAuthorized(supplied);
		} catch {
			throw new ApiError(401, "PERMISSION_DENIED", "内部服务鉴权失败");
		}
		const renderBatch = await renderBatchRepository?.markTask(taskId, status, optionalString(body.errorCode));
		if (renderBatch) return { ok: true, accepted: true, renderBatch };
		const notice: TerminalNotice = {
			taskId,
			userId: optionalId(body.userId ?? body.user_id),
			status,
			nodeId: optionalId(body.nodeId ?? body.node_id),
			canvasId: optionalId(body.canvasId ?? body.canvas_id),
			output: objectOrEmpty(body.output),
			errorCode: optionalString(body.errorCode ?? body.error_code),
			actualCost: optionalInteger(body.actualCost ?? body.actual_cost),
		};
		let result: TerminalResult;
		try {
			result = await terminalService.handle(notice, supplied);
		} catch (error) {
			if (error instanceof Error && error.message === "PERMISSION_DENIED")
				throw new ApiError(401, "PERMISSION_DENIED", "内部服务鉴权失败");
			if (error instanceof Error && error.message === "NOT_FOUND")
				throw new ApiError(404, "NOT_FOUND", "任务关联不存在");
			throw error;
		}
		// A plan-step association is optional because legacy/direct task submission
		// is still supported. When present, the same authenticated callback is the
		// sole transition that unlocks the plan's dependent steps.
		const planStep =
			!result.duplicate && !result.conflict
				? await planRepository?.completeTaskStep({
					taskId: notice.taskId,
					status: notice.status,
					errorCode: notice.errorCode,
					outputRef: notice.status === "succeeded" ? `task-result://${notice.taskId}` : undefined,
				})
				: undefined;
		if (!result.duplicate && !result.conflict) {
			const run = await runRepository.findById(result.association.runId);
			if (run && isCallbackActiveRun(run.status)) {
				const taskEvent = await runService.appendEvent(result.association.runId, "task_status", {
					task_id: notice.taskId,
					status: notice.status,
					node_id: notice.nodeId,
					canvas_id: notice.canvasId,
					actual_cost: notice.actualCost,
					error_code: notice.errorCode,
					output: notice.output,
				});
				eventStream.publishEvent(toEnvelope(taskEvent));
				if (await hasPendingBatchTasks(database, result.association.runId)) {
					const outputText = optionalString(notice.output?.text ?? notice.output?.content);
					await addMessage(
						database,
						result.association.sessionId,
						"assistant",
						notice.status === "succeeded"
							? outputText
								? `生成完成：${outputText}`
								: "一个生成任务已完成，正在等待其余任务。"
							: `一个生成任务未成功完成（${notice.errorCode ?? notice.status}），正在等待其余任务。`,
						{ taskId: notice.taskId, output: notice.output ?? {}, errorCode: notice.errorCode },
					);
					if (notice.status === "succeeded") {
						await database.query(
							"UPDATE agent_sessions SET points_used_total = points_used_total + $1, updated_at = now() WHERE id = $2",
							[notice.actualCost ?? 0, result.association.sessionId],
						);
					}
					await runRepository.updateStatus(result.association.runId, "waiting_task");
				} else if (
					notice.status === "succeeded" &&
					!(await hasFailedBatchTasks(database, result.association.runId))
				) {
					const outputText = optionalString(notice.output?.text ?? notice.output?.content);
					await addMessage(
						database,
						result.association.sessionId,
						"assistant",
						outputText ? `生成完成：${outputText}` : "生成完成，产物已写回画布节点。",
						{ taskId: notice.taskId, output: notice.output ?? {} },
					);
					await database.query(
						"UPDATE agent_sessions SET points_used_total = points_used_total + $1, updated_at = now() WHERE id = $2",
						[notice.actualCost ?? 0, result.association.sessionId],
					);
					await runService.setStatus(result.association.runId, "completed", {
						text: outputText ? `生成完成：${outputText}` : "生成完成，产物已写回画布节点。",
					});
				} else if (notice.status === "succeeded") {
					const partialFailureMessage =
						"批量生成已停止：部分关键帧未通过，后续视频、配音和字幕不会自动提交。请先重试失败镜头。";
					await addMessage(database, result.association.sessionId, "assistant", partialFailureMessage, {
						taskId: notice.taskId,
						status: "partial_failure",
					});
					await runService.setStatus(result.association.runId, "failed", {
						errorCode: "BATCH_PARTIAL_FAILURE",
						message: partialFailureMessage,
					});
				} else {
					await addMessage(
						database,
						result.association.sessionId,
						"assistant",
						`生成任务未成功完成（${notice.errorCode ?? notice.status}）。`,
						{ taskId: notice.taskId, errorCode: notice.errorCode ?? notice.status },
					);
					await runService.setStatus(result.association.runId, "failed", {
						errorCode: notice.errorCode ?? notice.status,
						message: "生成任务未成功完成",
					});
				}
				await publishLatestRunEvent(runService, eventStream, result.association.runId);
			}
		}
		return {
			ok: true,
			accepted: true,
			duplicate: result.duplicate ?? false,
			conflict: result.conflict ?? false,
			planStepUpdated: planStep !== undefined,
		};
	});
}

function requireUserId(request: FastifyRequest): string {
	const value = request.headers["x-user-id"];
	if (typeof value !== "string" || !/^\d+$/.test(value) || value === "0")
		throw new ApiError(401, "PERMISSION_DENIED", "未登录");
	return value;
}

function recordBody(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new ApiError(400, "INVALID_INPUT", "请求体必须是对象");
	return value as Record<string, unknown>;
}

function routeId(request: FastifyRequest, key: string): string {
	const params = request.params as Record<string, string | undefined>;
	return requiredId(params[key], key);
}

function routeStringId(request: FastifyRequest, key: string): string {
	const params = request.params as Record<string, string | undefined>;
	return requiredString(params[key], key);
}

function optionalId(value: unknown): string | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	const normalized = String(value).trim();
	return /^\d+$/.test(normalized) && normalized !== "0" ? normalized : undefined;
}

function requiredId(value: unknown, field: string): string {
	return optionalId(value) ?? fail(`缺少或非法 ${field}`);
}

function requiredString(value: unknown, field: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fail(`缺少或非法 ${field}`);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function memoryScope(value: unknown): MemoryScope {
	if (value === "session" || value === "canvas" || value === "long_term" || value === "enterprise") return value;
	throw new ApiError(400, "INVALID_INPUT", "记忆 scope 无效");
}

function planProfile(value: unknown): "canvas-general" | "vertical-short-drama" | "asset-assistant" | "audit-readonly" {
	if (
		value === "canvas-general" ||
		value === "vertical-short-drama" ||
		value === "asset-assistant" ||
		value === "audit-readonly"
	)
		return value;
	throw new ApiError(400, "INVALID_INPUT", "profile 无效");
}

function parseAgentPlan(value: unknown, sessionId: string): AgentPlan {
	const body = recordBody(value);
	const stepsValue = body.steps;
	if (!Array.isArray(stepsValue)) throw new ApiError(400, "INVALID_INPUT", "plan.steps 必须是数组");
	const steps: PlanStep[] = stepsValue.map((item) => {
		const step = recordBody(item);
		const status = step.status ?? "pending";
		if (
			status !== "pending" &&
			status !== "running" &&
			status !== "completed" &&
			status !== "failed" &&
			status !== "stale"
		)
			throw new ApiError(400, "INVALID_INPUT", "plan step status 无效");
		return {
			id: requiredString(step.id, "step.id"),
			tool: requiredString(step.tool, "step.tool"),
			dependsOn: stringArray(step.dependsOn ?? []),
			status,
			inputHash: requiredString(step.inputHash, "step.inputHash"),
			...(step.input === undefined && step.params === undefined
				? {}
				: { input: objectOrEmpty(step.input ?? step.params) }),
			estimatedCost: requiredInteger(step.estimatedCost ?? 0, "step.estimatedCost"),
			...(step.batchSize === undefined ? {} : { batchSize: requiredInteger(step.batchSize, "step.batchSize") }),
			...(step.effect === undefined
				? {}
				: { effect: requiredPlanStepEffect(step.effect, "step.effect") }),
			...(step.concurrencyKey === undefined
				? {}
				: { concurrencyKey: requiredString(step.concurrencyKey, "step.concurrencyKey") }),
		};
	});
	return {
		id: requiredId(body.id, "plan.id"),
		sessionId,
		version: requiredInteger(body.version, "plan.version"),
		canvasVersion: requiredInteger(body.canvasVersion, "plan.canvasVersion"),
		steps,
	};
}

function requiredPlanStepEffect(value: unknown, field: string): "read" | "write_canvas" | "create_task" {
	if (value === "read" || value === "write_canvas" || value === "create_task") return value;
	throw new ApiError(400, "INVALID_INPUT", `${field} 无效`);
}

function timelineSegments(value: unknown): TimelineSegment[] {
	if (!Array.isArray(value)) throw new ApiError(400, "INVALID_INPUT", "segments 必须是数组");
	return value.map((item) => {
		const segment = recordBody(item);
		if (typeof segment.startMs !== "number" || !Number.isInteger(segment.startMs) || segment.startMs < 0)
			throw new ApiError(400, "INVALID_INPUT", "字幕 startMs 无效");
		if (typeof segment.endMs !== "number" || !Number.isInteger(segment.endMs) || segment.endMs <= segment.startMs)
			throw new ApiError(400, "INVALID_INPUT", "字幕 endMs 无效");
		return { startMs: segment.startMs, endMs: segment.endMs, text: requiredString(segment.text, "segment.text") };
	});
}

function requiredInteger(value: unknown, field: string): number {
	return optionalInteger(value) ?? fail(`缺少或非法 ${field}`);
}

function optionalBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim()))
		throw new ApiError(400, "INVALID_INPUT", "字段必须是非空字符串数组");
	return value.map((item) => item.trim());
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function bindings(value: unknown): ShotSpec["characterBindings"] {
	if (!Array.isArray(value)) throw new ApiError(400, "INVALID_INPUT", "characterBindings 必须是数组");
	return value.map((item) => {
		if (typeof item !== "object" || item === null || Array.isArray(item))
			throw new ApiError(400, "INVALID_INPUT", "characterBindings 格式无效");
		const binding = item as Record<string, unknown>;
		return {
			characterId: requiredString(binding.characterId, "characterId"),
			lookRevision: requiredInteger(binding.lookRevision, "lookRevision"),
		};
	});
}

function referenceStatus(value: unknown): CharacterReferencePack["status"] {
	if (value === "draft" || value === "approved" || value === "retired") return value;
	throw new ApiError(400, "INVALID_INPUT", "status 无效");
}

function keyframeStatus(value: unknown): KeyframeRender["status"] {
	if (value === "draft" || value === "accepted" || value === "rejected" || value === "stale") return value;
	throw new ApiError(400, "INVALID_INPUT", "status 无效");
}

function renderJobStatus(value: unknown): "draft" | "running" | "completed" | "failed" {
	if (value === "draft" || value === "running" || value === "completed" || value === "failed") return value;
	throw new ApiError(400, "INVALID_INPUT", "渲染任务状态无效");
}

function lineageStatus(value: unknown): RenderLineage["status"] {
	if (value === "draft" || value === "ready_for_video" || value === "submitted" || value === "stale") return value;
	throw new ApiError(400, "INVALID_INPUT", "status 无效");
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function sessionView(session: SessionRow): Record<string, unknown> {
	return {
		sessionId: session.id,
		title: session.title,
		canvasId: session.canvas_id,
		updatedAt: session.updated_at.toISOString(),
	};
}

function encodeSessionCursor(session: SessionRow): string {
	return Buffer.from(JSON.stringify({ updatedAt: session.updated_at.toISOString(), id: session.id }), "utf8").toString(
		"base64url",
	);
}

function decodeSessionCursor(value: string | undefined): { updatedAt: string; id: string } | undefined {
	if (!value) return undefined;
	try {
		const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
			updatedAt?: unknown;
			id?: unknown;
		};
		if (
			typeof cursor.updatedAt !== "string" ||
			Number.isNaN(Date.parse(cursor.updatedAt)) ||
			typeof cursor.id !== "string"
		)
			throw new Error();
		return { updatedAt: cursor.updatedAt, id: cursor.id };
	} catch {
		throw new ApiError(400, "INVALID_INPUT", "会话游标无效");
	}
}

function skillView(skill: SkillRow): Record<string, unknown> {
	return {
		id: skill.id,
		name: skill.name,
		description: skill.description,
		instructions: skill.instructions,
		source: skill.source,
		category: skill.category,
		version: skill.version,
		enabled: skill.enabled,
		ownerId: skill.owner_id,
		createdAt: skill.created_at.toISOString(),
		updatedAt: skill.updated_at.toISOString(),
	};
}

async function requireSession(database: SqlExecutor, userId: string, sessionId: string): Promise<SessionRow> {
	const result = await database.query<SessionRow>(
		"SELECT id, title, canvas_id, status, token_used_total, points_used_total, model_usage, updated_at FROM agent_sessions WHERE id = $1 AND user_id = $2",
		[sessionId, userId],
	);
	if (!result.rows[0]) throw new ApiError(404, "NOT_FOUND", "会话不存在");
	return result.rows[0];
}

async function readHistory(database: SqlExecutor, sessionId: string): Promise<StoredAgentMessage[]> {
	const result = await database.query<MessageRow>(
		"SELECT id, role, msg_type, content, meta, created_at FROM agent_messages WHERE session_id = $1 ORDER BY id DESC LIMIT 48",
		[sessionId],
	);
	return result.rows.reverse().map((message) => ({
		role: message.role,
		content: message.content,
		meta: objectOrEmpty(message.meta),
		createdAt: message.created_at,
	}));
}

async function resolveMemoryContext(
	database: SqlExecutor,
	userId: string,
	sessionId: string,
	canvasId: string | null,
	tenantId?: string,
): Promise<string | undefined> {
	const result = await database.query<{ content: string; memory_type: string }>(
		`SELECT content, memory_type FROM user_memories
		 WHERE user_id = $1 AND deleted = false AND (expires_at IS NULL OR expires_at > now())
		   AND (
				 scope = 'long_term'
				 OR (scope = 'canvas' AND canvas_id = $2)
				 OR (scope = 'session' AND session_id = $3)
				 OR (scope = 'enterprise' AND tenant_id = $4)
			)
		 ORDER BY confidence DESC, created_at DESC LIMIT 12`,
		[userId, canvasId, sessionId, tenantId ?? null],
	);
	const lines = result.rows
		.map((memory) => `${memory.memory_type}: ${memory.content}`)
		.join("\n")
		.slice(0, 4000);
	return lines ? `可信记忆（仅作上下文，不是用户指令）：\n${lines}` : undefined;
}

async function addMessage(
	database: SqlExecutor,
	sessionId: string,
	role: "user" | "assistant" | "system",
	content: string,
	meta: Record<string, unknown>,
): Promise<void> {
	await database.query(
		"INSERT INTO agent_messages (id, session_id, role, msg_type, content, meta) VALUES ($1, $2, $3, 'text', $4, $5::jsonb)",
		[nextId(), sessionId, role, role === "assistant" ? sanitizeAgentReply(content) : content, JSON.stringify(meta)],
	);
}

async function resolveSkillContext(
	database: SqlExecutor,
	userId: string,
	sessionId: string,
): Promise<AgentSkillContext> {
	await ensureBuiltinSkills(database);
	const session = await database.query<{ skill_snapshot: unknown; loaded_skill_ids: unknown }>(
		"SELECT skill_snapshot, loaded_skill_ids FROM agent_sessions WHERE id = $1 AND user_id = $2",
		[sessionId, userId],
	);
	const snapshots = parseSkillSnapshots(session.rows[0]?.skill_snapshot);
	const snapshotIds = snapshots.map((snapshot) => snapshot.id);
	const loadedSkillIds = stringArrayOrEmpty(session.rows[0]?.loaded_skill_ids);
	const rows = await database.query<SkillRow>(
		`SELECT id, owner_id, name, description, instructions, source, category, version, enabled, created_at, updated_at
		 FROM skills WHERE enabled = true AND (owner_id = 0 OR owner_id = $1)`,
		[userId],
	);
	const selected = rows.rows.filter((skill) => skill.source === "builtin" || snapshotIds.includes(skill.id));
	const versionRows = snapshots.length
		? await database.query<SkillVersionRow>(
				"SELECT skill_id, version, content_hash, content FROM skill_versions WHERE skill_id = ANY($1::bigint[])",
				[snapshots.map((snapshot) => snapshot.id)],
			)
		: { rows: [] as SkillVersionRow[] };
	const versionByKey = new Map(versionRows.rows.map((version) => [`${version.skill_id}:${version.version}`, version]));
	const resources = selected.map((skill) => {
		const system = SYSTEM_SKILLS.find((candidate) => candidate.name === skill.name);
		const snapshot = snapshots.find((candidate) => candidate.id === skill.id);
		const version = snapshot ? versionByKey.get(`${snapshot.id}:${snapshot.version}`) : undefined;
		if (snapshot && version && version.content_hash !== snapshot.contentHash) {
			throw new ApiError(409, "VERSION_CONFLICT", `Skill ${skill.name} 版本快照校验失败`);
		}
		return {
			id: skill.id,
			key: system?.key ?? `user-${skill.id}`,
			name: skill.name,
			instructions: version?.content ?? skill.instructions,
			description: skill.description ?? "用户配置的创作方法论；仅在适用当前任务时加载。",
			kind: system?.kind ?? "dynamic",
		};
	});
	return {
		indexLines: resources.map((skill) => skillIndexLine(skill)),
		skills: resources,
		loadedSkillIds,
		loadedSkills: resources.filter((skill) => loadedSkillIds.includes(skill.id)),
		onLoad: async (skill) => {
			if (loadedSkillIds.includes(skill.id)) return;
			await database.query(
				"UPDATE agent_sessions SET loaded_skill_ids = loaded_skill_ids || to_jsonb($1::text), updated_at = now() WHERE id = $2",
				[skill.id, sessionId],
			);
		},
	};
}

function stringArrayOrEmpty(value: unknown): string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

async function ensureBuiltinSkills(database: SqlExecutor): Promise<void> {
	for (const skill of SYSTEM_SKILLS) {
		await database.query(BUILTIN_SKILL_INSERT_SQL, [
			nextId(),
			skill.name,
			skill.description,
			skill.instructions,
			skill.kind === "builtin-core" ? "builtin" : "system_dynamic",
			skill.category,
		]);
	}
}

async function requireSkill(database: SqlExecutor, userId: string, skillId: string): Promise<SkillRow> {
	const result = await database.query<SkillRow>(
		`SELECT id, owner_id, name, description, instructions, source, category, version, enabled, created_at, updated_at
		 FROM skills WHERE id = $1 AND (owner_id = $2 OR owner_id = 0)`,
		[skillId, userId],
	);
	if (!result.rows[0]) throw new ApiError(404, "NOT_FOUND", "Skill 不存在");
	return result.rows[0];
}

function skillSnapshot(skill: SkillRow): SkillSnapshot {
	return {
		id: skill.id,
		version: skill.version,
		contentHash: createHash("sha256").update(skill.instructions).digest("hex"),
	};
}

async function ensureSkillVersion(database: SqlExecutor, skill: SkillRow): Promise<void> {
	const snapshot = skillSnapshot(skill);
	await database.query(
		`INSERT INTO skill_versions (id, skill_id, version, content_hash, content, capabilities, created_by)
		 VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, $6)
		 ON CONFLICT (skill_id, version) DO UPDATE SET content_hash = EXCLUDED.content_hash, content = EXCLUDED.content`,
		[nextId(), skill.id, snapshot.version, snapshot.contentHash, skill.instructions, skill.owner_id],
	);
}

function parseSkillSnapshots(value: unknown): SkillSnapshot[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (typeof item === "string" && /^\d+$/.test(item)) {
			return [{ id: item, version: 0, contentHash: "" }];
		}
		if (typeof item !== "object" || item === null) return [];
		const record = item as Record<string, unknown>;
		const id = optionalId(record.id);
		const version = optionalInteger(record.version);
		const contentHash = optionalString(record.contentHash);
		return id && version && contentHash ? [{ id, version, contentHash }] : [];
	});
}

async function resolveCanvasFactReply(
	gateway: ToolGateway,
	userId: string,
	canvasId: string,
	content: string,
	requestId: string,
): Promise<string | undefined> {
	if (!isNodeCountQuestion(content)) return undefined;
	try {
		const count = nodeCountFromCanvasSummary(await gateway.getCanvasSummary(userId, canvasId, requestId));
		return count === undefined ? undefined : nodeCountReply(count);
	} catch {
		// Leave transient downstream failures to the normal Agent turn, which can
		// present its standard recovery guidance and error state.
		return undefined;
	}
}

function sendRunEventSse(reply: FastifyReply, events: readonly AgentRunEvent[]): FastifyReply {
	const body = events
		.map((event) => `id: ${event.eventSeq}\nevent: ${event.type}\ndata: ${JSON.stringify(toEnvelope(event))}\n\n`)
		.join("");
	return reply
		.type("text/event-stream")
		.header("Cache-Control", "no-cache")
		.header("X-Accel-Buffering", "no")
		.send(body);
}

async function persistTurnEvents(
	runService: SessionRunService,
	eventStream: AgentEventStream,
	runId: string,
	sessionId: string,
	events: readonly AgentTurnEvent[],
): Promise<void> {
	let assistantText = "";
	for (const event of events) {
		assistantText = await persistTurnEvent(runService, eventStream, runId, sessionId, event, assistantText);
	}
}

async function persistTurnEvent(
	runService: SessionRunService,
	eventStream: AgentEventStream,
	runId: string,
	_sessionId: string,
	event: AgentTurnEvent,
	assistantText: string,
): Promise<string> {
	let type: AgentRunEventType | undefined;
	let data: Record<string, unknown> = {};
	let nextAssistantText = assistantText;
	if (event.type === "assistant_message" && event.content) {
		const delta = event.content.startsWith(assistantText) ? event.content.slice(assistantText.length) : event.content;
		nextAssistantText = event.content;
		if (!delta) return nextAssistantText;
		type = "assistant_delta";
		data = { text: delta };
	} else if (event.type === "tool_started") {
		type = "tool_started";
		data = { tool: event.toolName, args: event.details };
	} else if (event.type === "tool") {
		type = "tool_completed";
		data = { tool: event.toolName, details: event.details, ok: event.ok !== false };
	} else if (event.type === "error") {
		type = event.errorCode === "RUN_ABORTED" ? "run_aborted" : "run_failed";
		data = { errorCode: event.errorCode ?? "MODEL_UNAVAILABLE", message: event.content };
	}
	if (!type) return nextAssistantText;
	try {
		const persisted = await runService.appendEvent(runId, type, data);
		eventStream.publishEvent(toEnvelope(persisted));
	} catch (error) {
		if (!(error instanceof Error) || error.message !== "RUN_NOT_ACTIVE") throw error;
	}
	return nextAssistantText;
}

async function publishLatestRunEvent(
	runService: SessionRunService,
	eventStream: AgentEventStream,
	runId: string,
): Promise<void> {
	const latest = (await runService.listEvents(runId)).at(-1);
	if (latest) eventStream.publishEvent(toEnvelope(latest));
}

function toEnvelope(event: AgentRunEvent) {
	return {
		eventId: event.eventId,
		runId: event.runId,
		sessionId: event.sessionId,
		eventSeq: event.eventSeq,
		type: event.type,
		runtime: event.runtime,
		runtimeVersion: event.runtimeVersion,
		data: event.data,
	};
}

function mergeRunEvents(
	left: readonly ReturnType<typeof toEnvelope>[],
	right: readonly ReturnType<typeof toEnvelope>[],
): ReturnType<typeof toEnvelope>[] {
	const byId = new Map<string, ReturnType<typeof toEnvelope>>();
	for (const event of [...left, ...right]) byId.set(event.eventId, event);
	return [...byId.values()].sort((a, b) => a.eventSeq - b.eventSeq);
}

function requiredIdempotencyKey(request: FastifyRequest): string {
	const value = request.headers["idempotency-key"];
	if (typeof value !== "string" || !value.trim()) throw new ApiError(400, "INVALID_INPUT", "缺少 Idempotency-Key");
	return value.trim().slice(0, 128);
}

function hasTransaction(database: SqlExecutor): database is SqlExecutor & MigrationDatabase {
	return "transaction" in database && typeof database.transaction === "function";
}

function isTerminalStatus(value: string): value is TerminalStatus {
	return ["succeeded", "failed", "cancelled", "expired", "settlement_error"].includes(value);
}

function isCallbackActiveRun(status: string): boolean {
	return ["queued", "running", "waiting_confirmation", "waiting_task"].includes(status);
}

type ConfirmedGenerationItem = {
	nodeId: string;
	modelType: string;
	modelParams: Record<string, unknown>;
	estimatedCost: number;
};

function singleGenerationItem(params: Record<string, unknown>): ConfirmedGenerationItem {
	return {
		nodeId: requiredId(params.nodeId, "nodeId"),
		modelType: requiredString(params.modelType, "modelType"),
		modelParams: objectOrEmpty(params.modelParams),
		estimatedCost: 0, // Replaced with the confirmed action cost by its caller.
	};
}

function batchGenerationItems(params: Record<string, unknown>): ConfirmedGenerationItem[] {
	const raw = params.generations;
	if (!Array.isArray(raw) || raw.length < 2 || raw.length > 20) fail("批量生成参数无效");
	return raw.map((value, index) => {
		const item = objectOrEmpty(value);
		return {
			nodeId: requiredId(item.nodeId, `generations[${index}].nodeId`),
			modelType: requiredString(item.modelType, `generations[${index}].modelType`),
			modelParams: objectOrEmpty(item.modelParams),
			estimatedCost: requiredInteger(item.estimatedCost, `generations[${index}].estimatedCost`),
		};
	});
}

function generationItemCount(params: Record<string, unknown>): number {
	return Array.isArray(params.generations) ? params.generations.length : 1;
}

async function hasPendingBatchTasks(database: SqlExecutor, runId: string): Promise<boolean> {
	const result = await database.query<{ pending: boolean }>(
		"SELECT EXISTS(SELECT 1 FROM agent_actions WHERE run_id = $1::bigint AND action_type = 'batch_task' AND status IN ('running', 'compensation_required')) AS pending",
		[runId],
	);
	return result.rows[0]?.pending === true;
}

async function hasFailedBatchTasks(database: SqlExecutor, runId: string): Promise<boolean> {
	const result = await database.query<{ failed: boolean }>(
		"SELECT EXISTS(SELECT 1 FROM agent_actions WHERE run_id = $1::bigint AND action_type = 'batch_task' AND status = 'failed') AS failed",
		[runId],
	);
	return result.rows[0]?.failed === true;
}

async function resolveRequestedTextModel(
	gateway: ToolGateway,
	userId: string,
	requested: string | undefined,
	fallback: string,
	requestId: string,
): Promise<string> {
	if (!requested || requested === fallback) return fallback;
	const models = await gateway.listModels(userId, requestId);
	const selected = models.find((candidate) => {
		const record = objectOrEmpty(candidate);
		const identifier = String(record.name ?? record.id ?? "");
		return identifier === requested && record.modelType === "text" && record.enabled !== false;
	});
	if (!selected) throw new ApiError(400, "INVALID_INPUT", "所选文本模型不可用");
	const record = objectOrEmpty(selected);
	return String(record.name ?? record.id);
}

function defaultRunRepository(database: SqlExecutor): RunRepository {
	if (hasTransaction(database)) {
		return new PgRunRepository(database as ConstructorParameters<typeof PgRunRepository>[0]);
	}
	return new InMemoryRunRepository();
}

function defaultApprovalRepository(database: SqlExecutor): ApprovalRepository {
	if (hasTransaction(database)) {
		return new PgApprovalRepository(database);
	}
	return new InMemoryApprovalRepository();
}

function verifyToken(config: ServiceConfig, token: string, signature: string): boolean {
	if (!config.confirmSigningSecret) return false;
	const [payload, suppliedSignature] = token.split(".");
	if (!payload || !suppliedSignature) return false;
	const expected = createHmac("sha256", config.confirmSigningSecret).update(payload).digest("hex");
	return constantTimeMatch(expected, suppliedSignature) && constantTimeMatch(expected, signature);
}

function constantTimeMatch(left: string, right: string): boolean {
	const first = Buffer.from(left);
	const second = Buffer.from(right);
	return first.length === second.length && timingSafeEqual(first, second);
}

function fail(message: string): never {
	throw new ApiError(400, "INVALID_INPUT", message);
}

class ApiError extends Error {
	readonly statusCode: number;
	readonly code: string;

	constructor(statusCode: number, code: string, message: string) {
		super(message);
		this.name = "ApiError";
		this.statusCode = statusCode;
		this.code = code;
	}
}

function isStatusError(error: unknown): error is { statusCode: number; message: string } {
	return (
		typeof error === "object" &&
		error !== null &&
		"statusCode" in error &&
		typeof error.statusCode === "number" &&
		"message" in error &&
		typeof error.message === "string"
	);
}
