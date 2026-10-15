# Pi Agent Audit Full Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现并验收《VibePaper Pi Agent 二次开发模块全面审查报告》中所有未实现功能、部分实现能力和优化项，使 Pi Agent 具备可替换旧 Agent 的安全、可恢复、可观测生产闭环。

**Architecture:** 稳定复用 Pi Core 的模型—工具循环、事件、上下文变换和中途控制；VibePaper 自研 profile、上下文、ToolManifest、Action/Approval、PostgreSQL run/outbox、记忆治理、短剧领域 compiler 和前端事件层。Canvas、Asset、Billing、Generation 继续分别作为业务事实源，Agent 只通过受控 Tool Gateway 调用 REST/RocketMQ，不直连其他服务数据库。

**Tech Stack:** Node.js 22.19+、TypeScript、Fastify、Pi Agent Core、PostgreSQL、Redis 7、RocketMQ、Java 21/Spring Boot、Python 3.12/FastAPI、React/TypeScript/Vite、TanStack Query、Zustand、Vitest、Playwright、Maven、pytest。

**Spec:** `docs/audits/pi-agent-secondary-development-comprehensive-review-2026-08-28.md`

## Global Constraints

- API 前缀固定为 `/api/v1`；错误体固定为 `{ code, message, details, request_id, retryable }`；时间使用 ISO 8601 UTC；点数只使用整数。
- 全局业务 ID 使用 Snowflake 字符串；节点号必须由部署实例显式配置，不得使用 PID 推导。
- 高风险动作必须绑定 `user_id + canvas_id + canvas_version + action_hash + expires_at`；`estimated_cost >= 1`、切换模型、参数变化 >=30%、批量创建 >20、覆盖已有输出均须确认。
- Billing 是估价、冻结、结算和点数流水事实源；Generation 是模型目录和任务状态事实源；Canvas 是画布版本、节点和连线事实源。
- Agent 不得直连其他服务数据库，不得让 Pi/Skill 动态注册任意工具，不得复用 Pi Coding Agent 的 bash、文件、浏览器或任意网络工具。
- 同一会话同一时刻最多一个 active run；所有写接口必须有明确幂等策略；服务重启不得重复写画布或重复冻结点数。
- 用户提供的节点、Skill、记忆、素材元数据均作为不可信数据进入模型，不能改变 SYSTEM、profile、工具集或审批策略。
- `AGT-PI-P1-23` 已自动化实现，仅保留真实浏览器视觉与交互验收；不得回退已有最多 8 个节点、权威读取、不可变快照和按轮消费行为。
- 不读取或修改 `.worktrees/agent-security-hardening`；执行以当前 `dev` 已提交内容为基线，现有旧计划只作为参考。
- 每个任务严格 TDD：失败测试 → 最小实现 → 通过测试 → 契约/文档同步 → 独立提交；资金与审批核心分支覆盖率不低于 90%。

## 完整性保证与阶段门禁

本计划用三层机制保证审查项不会漏做：

1. `docs/audits/pi-agent-remediation-tracker.md` 保存每个审查 ID 的 `planned/in_progress/verified` 状态、提交、测试证据和验收人。
2. 每个任务必须更新 tracker；没有测试证据的条目不得标记 `verified`。
3. 阶段 A、B、C、D、E 必须依次通过退出门禁；不得用后续功能掩盖前置安全、资金或恢复缺口。

### 审查项追踪矩阵

| 审查项 | 实施任务 | 关闭证据 |
|---|---|---|
| P0-01 审批签发/执行缺失 | Task 8、9 | Action/Approval 并发与真实 Billing 集成测试 |
| P0-02 工具面不足 | Task 10、13、14、15 | ToolManifest 契约与读/写/生成 E2E |
| P0-03 死代码与非权威估价 | Task 9、15、31 | Generation 估价 + Billing 冻结合同测试 |
| P0-04 假流式 SSE | Task 5、6 | 首 delta 先于 run 完成、断线回放测试 |
| P0-05 停止不取消后端 | Task 5、6 | abort 后无后续工具副作用 |
| P0-06 `/events` 与 Skill attach 404 | Task 6、22 | 网关真实路径契约测试 |
| P0-07 回调字段不兼容 | Task 7 | 仅凭 `task_id` 定位 action/run/session |
| P0-08 notice 不消费 | Task 5、7 | 终态幂等消费、outbox、UI 推送 |
| P0-09 内部回调未 fail closed | Task 3、7 | 生产空 secret 启动失败、伪造回调 401 |
| P0-10 短剧无所有权 | Task 4、25 | 跨用户/遗留数据 404 |
| P0-11 会话静默改绑画布 | Task 4、23 | 跨画布拒绝、显式复制测试 |
| P0-12 确认消费非原子 | Task 8 | 100 并发仅一次成功 |
| P0-13 动态 DDL | Task 2 | checksum 迁移、重复运行与失败回滚测试 |
| P0-14 Pi 未进 CI | Task 3、35 | 根 CI 必需 job 通过 |
| P0-15 Nacos 静默跳过 | Task 3 | 生产 fail closed、注册/心跳探针 |
| P1-01 profile/意图路由 | Task 11 | 四 profile 决策表测试 |
| P1-02 选中节点上下文 | Task 18 | 已实现回归 + 浏览器验收 |
| P1-03 画布上下文构建器 | Task 12、13 | summary/selected/detail/one-hop 测试 |
| P1-04 工具 observation 丢失 | Task 5、19 | Pi transcript 重建与恢复测试 |
| P1-05 固定截断无压缩 | Task 20 | 业务事实保护型 compaction 测试 |
| P1-06 会话无并发控制 | Task 5、19 | lease/steer/follow-up 并发测试 |
| P1-07 前后端事件不兼容 | Task 16、17 | OpenAPI/SSE reducer 契约测试 |
| P1-08 累计前缀重复发送 | Task 6、16 | 严格 delta 测试 |
| P1-09 模型错误以 200 空响应结束 | Task 6、16 | failed/aborted 终态测试 |
| P1-10 token 与点数低估 | Task 6、9、31 | 多工具轮累加与最终费用对账 |
| P1-11 模型选择无效 | Task 11、17、31 | 请求模型、能力校验、会话快照 |
| P1-12 记忆不参与推理 | Task 21 | scope 检索/注入/写入/撤销测试 |
| P1-13 Skill 快照不可复现 | Task 22 | version/hash 快照回放测试 |
| P1-14 用户 Skill 无治理 | Task 22 | 风险扫描、预算、能力声明测试 |
| P1-15 错误码改写 | Task 4、17 | 稳定错误码表契约测试 |
| P1-16 request ID 断裂 | Task 4、34 | 跨服务 trace 集成测试 |
| P1-17 queued 回写失败被吞 | Task 9 | 补偿状态与可见告警测试 |
| P1-18 drama/review 网关缺路由 | Task 3 | 网关路由测试 |
| P1-19 无 OpenAPI/TypeBox | Task 17 | schema 生成与 breaking-change 检查 |
| P1-20 数据约束不足 | Task 2 | FK/unique/check 迁移测试 |
| P1-21 Snowflake 多实例不安全 | Task 2 | 多 worker/时钟回拨/4097 ID 测试 |
| P1-22 部署配置漂移 | Task 3 | 单一 env 来源启动测试 |
| P1-23 节点参考闭环 | Task 18 | 自动化回归 + Playwright 截图验收 |
| P2 run/outbox/重放 | Task 5、6 | `afterSeq` 重放和重启恢复 |
| P2 plan/局部重跑审计 | Task 24 | 计划版本、行动摘要、重跑记录 |
| P2 Ready Set/stale compiler | Task 24、26 | 依赖图影响集测试 |
| P2 完整短剧生产链 | Task 25-30 | 三镜头纵切 E2E |
| P2 独立只读审校 Agent | Task 29 | 客户端不可写、审校证据可追踪 |
| P2 模型目录/估价/降级/预算 | Task 31 | capability、fallback、retry budget 测试 |
| P2 企业记忆治理 | Task 21、32 | tenant 隔离、保留/导出/删除测试 |
| P2 会话完整生命周期 | Task 23 | cursor 分页、归档、删除、重命名、搜索 |
| P2 前端重连与静默错误 | Task 6、16 | cursor 重连、错误可见性测试 |
| P2 评测/A-B/收益归因 | Task 33、34 | 离线集、trace diff、在线指标门禁 |

## Phase A：安全、数据与可用性基础

### Task 1: 建立审查追踪器与旧 Agent 行为基线

**Files:**
- Create: `docs/audits/pi-agent-remediation-tracker.md`
- Create: `pi-main/packages/vibepaper-agent-service/test/fixtures/legacy-behavior-catalog.json`
- Create: `pi-main/packages/vibepaper-agent-service/test/audit-coverage.test.ts`
- Read: `agent-service/tests/**/*.py`

**Interfaces:**
- Produces: `AuditCoverageEntry { auditId, taskIds, status, evidence }` 和旧 Python 197 用例到 Pi 测试/不适用理由的映射。

- [ ] **Step 1: 写失败的覆盖完整性测试**

```ts
it("maps every audit issue to at least one executable task", () => {
  expect(unmappedAuditIds(tracker, auditMarkdown)).toEqual([]);
});
```

- [ ] **Step 2: 运行并确认因 tracker 不存在而失败**

Run: `cd pi-main && npx vitest run packages/vibepaper-agent-service/test/audit-coverage.test.ts`

- [ ] **Step 3: 建立 tracker 和旧行为目录**

记录 P0-01..15、P1-01..23、10 个 P2 条目；旧测试目录按 approval、methodology、dependency、precedence、media、events、recovery 分类，不机械复制实现细节。

- [ ] **Step 4: 运行测试并确认通过**

Run: `cd pi-main && npx vitest run packages/vibepaper-agent-service/test/audit-coverage.test.ts`

- [ ] **Step 5: 提交**

```bash
git add docs/audits/pi-agent-remediation-tracker.md pi-main/packages/vibepaper-agent-service/test
git commit -m "test(agent): establish audit remediation coverage"
```

### Task 2: 版本化迁移、关系约束与多实例安全 ID

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/migrations/001_baseline.sql`
- Create: `pi-main/packages/vibepaper-agent-service/migrations/002_control_plane_constraints.sql`
- Create: `pi-main/packages/vibepaper-agent-service/src/infrastructure/migrations.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/infrastructure/ids.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/server.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/migrate.ts`
- Delete after migration parity: `pi-main/packages/vibepaper-agent-service/src/infrastructure/schema.ts`
- Test: `pi-main/packages/vibepaper-agent-service/test/migrations-and-ids.test.ts`

**Interfaces:**
- Produces: `applyMigrations(database, directory): Promise<void>`、`SnowflakeIdGenerator(workerId, datacenterId)`。

- [ ] **Step 1: 写迁移重复执行、checksum、FK、唯一约束、时钟回拨和 4097 ID 测试**

```ts
expect(new Set(Array.from({ length: 4097 }, () => ids.next(1700000000000)))).toHaveLength(4097);
await expect(applyChangedChecksum()).rejects.toThrow("MIGRATION_CHECKSUM_MISMATCH");
```

- [ ] **Step 2: 确认测试失败**

Run: `cd pi-main && npx vitest run packages/vibepaper-agent-service/test/migrations-and-ids.test.ts`

- [ ] **Step 3: 实现迁移和数据库约束**

`agent_messages.session_id`、`agent_actions.session_id`、`agent_approvals.action_id/session_id`、`agent_wakeup_notices.session_id` 增加 FK；approval 的 `action_id` 唯一；状态增加 CHECK；事件增加 `(run_id,event_seq)` 唯一；迁移文件在单事务中执行并写 `schema_migrations(version,checksum,applied_at)`。

- [ ] **Step 4: 使用显式 worker/datacenter 配置替换 PID 节点号**

序列耗尽等待下一毫秒；时钟回拨直接失败并暴露健康指标，不允许复用 ID。

- [ ] **Step 5: 通过 focused test 和迁移烟测后提交**

Run: `cd pi-main && npx vitest run packages/vibepaper-agent-service/test/migrations-and-ids.test.ts`

### Task 3: 生产 fail-closed、Nacos、网关、部署配置与 CI

**Files:**
- Modify: `pi-main/packages/vibepaper-agent-service/src/config.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/infrastructure/nacos.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/server.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/.env.example`
- Modify: `deploy/start-all.ps1`
- Modify: `deploy/stop-all.ps1`
- Modify: `vibepaper-services/vibepaper-gateway/src/main/resources/application.yml`
- Modify: `.github/workflows/ci.yml`
- Test: `pi-main/packages/vibepaper-agent-service/test/config-nacos-routes.test.ts`

**Interfaces:**
- Produces: `validateStartupConfig(config): void`；唯一配置来源为 Pi 包 `.env`/进程环境。

- [ ] **Step 1: 写生产空 secret/Nacos 凭据失败、drama/review 路由、CI job 测试**

```ts
expect(() => validateStartupConfig(prodWithoutInternalToken)).toThrow("VIBEPAPER_INTERNAL_SERVICE_TOKEN");
expect(gatewayPaths).toContain("/api/v1/drama/**");
expect(ciJobs).toHaveProperty("pi-agent-service");
```

- [ ] **Step 2: 确认测试失败后实现**

生产缺内部 token、确认签名 secret、Nacos 凭据或 worker ID 时拒绝启动；注册、心跳和注销均检查 HTTP 状态并重试；`/health/ready` 必须反映 DB、迁移、Nacos 注册状态。

- [ ] **Step 3: 修复网关与启动脚本**

Agent route 覆盖 `/agent/**,/skills/**,/memories/**,/drama/**,/render-reviews/**`；脚本只读取 Pi 配置，不再把旧 Python `agent-service/.env` 当作 Node 配置。

- [ ] **Step 4: 增加 CI 必需门禁**

Pi job 运行 lint、typecheck、unit、migration、安全测试；旧 Python 测试保留为 parity 输入，但不得冒充 Pi job。

- [ ] **Step 5: 运行测试并提交**

Run: `cd pi-main && npx vitest run packages/vibepaper-agent-service/test/config-nacos-routes.test.ts`

### Task 4: 用户所有权、画布绑定、稳定错误码与 trace 传播

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/application/authorization-service.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/infrastructure/request-context.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/api/app.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/infrastructure/pg-drama-state-store.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/infrastructure/tool-gateway.ts`
- Test: `pi-main/packages/vibepaper-agent-service/test/authorization-and-errors.test.ts`

**Interfaces:**
- Produces: `RequestContext { requestId,userId,role,enterpriseId? }`、`assertSessionCanvasAccess()` 和 owner-scoped drama repository。

- [ ] **Step 1: 写跨用户 drama、跨画布会话、错误码、request ID 测试**

```ts
expect(otherUser.statusCode).toBe(404);
expect(rebind.statusCode).toBe(409);
expect(downstreamHeaders["x-request-id"]).toBe(incomingRequestId);
```

- [ ] **Step 2: 确认失败后实现请求上下文和权威权限检查**

所有 drama 查询都包含 `user_id`；遗留无 owner 数据隔离；消息请求中的 `canvasId` 只能与 session 画布一致，跨画布使用 Task 23 的显式复制接口。

- [ ] **Step 3: 修复错误映射和 trace**

保留 `PERMISSION_DENIED/NOT_FOUND/CONFIRMATION_REQUIRED/VERSION_CONFLICT`；Tool Gateway 透传现有 request ID，不再每次生成新 ID。

- [ ] **Step 4: 运行测试并提交**

Run: `cd pi-main && npx vitest run packages/vibepaper-agent-service/test/authorization-and-errors.test.ts`

### Task 5: 持久化 AgentRun、单会话 lease 与事件 outbox

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/migrations/003_agent_runs_events.sql`
- Create: `pi-main/packages/vibepaper-agent-service/src/domain/agent-run.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/application/session-run-service.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/infrastructure/pg-run-repository.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/infrastructure/pg-event-outbox.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/api/app.ts`
- Test: `pi-main/packages/vibepaper-agent-service/test/session-run-service.test.ts`

**Interfaces:**
- Produces: `AgentRunStatus = queued|running|waiting_confirmation|waiting_task|completed|failed|aborted` 和 `appendEvent(runId,type,data): eventSeq`。

- [ ] **Step 1: 写单 active run、顺序 eventSeq、幂等 input 测试**

```ts
await expect(startSecondRunSameSession()).rejects.toMatchObject({ code: "SESSION_BUSY" });
expect(events.map(e => e.eventSeq)).toEqual([1, 2, 3]);
```

- [ ] **Step 2: 确认失败后创建 `agent_runs`、`agent_run_events`、`agent_event_outbox`**

使用数据库唯一部分索引保证每 session 只有一个 active run；消息 POST 强制 `Idempotency-Key`，重复键返回同一 run。

- [ ] **Step 3: 把 app.ts 的消息编排移入 SessionRunService**

API 只做 schema/auth/reply；所有消息、run、事件和 pending action 由 application 层事务边界管理。

- [ ] **Step 4: 运行并发测试并提交**

Run: `cd pi-main && npx vitest run packages/vibepaper-agent-service/test/session-run-service.test.ts`

### Task 6: 真流式 SSE、严格 delta、断线重放与服务端取消

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/application/run-event-stream.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/application/agent-runtime.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/api/app.ts`
- Modify: `pi-paper-web/src/features/canvas/AgentPanel.tsx`
- Test: `pi-main/packages/vibepaper-agent-service/test/agent-streaming-cancel.test.ts`
- Test: `pi-paper-web/src/features/canvas/agentStreamClient.test.ts`

**Interfaces:**
- Produces: `GET /api/v1/agent/sessions/{sessionId}/events?afterSeq=N`、`POST /runs/{runId}/cancel`；复用 Pi `subscribe()/abort()/waitForIdle()`。

- [ ] **Step 1: 写首 delta、无重复前缀、error/aborted、cancel、replay 测试**

```ts
expect(firstDeltaAt).toBeLessThan(runCompletedAt);
expect(replayed.map(e => e.eventSeq)).toEqual([4, 5, 6]);
expect(toolCallsAfterCancel).toHaveLength(0);
```

- [ ] **Step 2: 确认失败后实现统一信封**

```ts
type AgentEventEnvelope = {
  eventId: string; runId: string; sessionId: string; eventSeq: number;
  type: "assistant_delta"|"tool_started"|"tool_completed"|"confirmation_required"|"task_status"|"run_completed"|"run_failed"|"run_aborted";
  runtime: "pi"; runtimeVersion: string; data: Record<string, unknown>;
};
```

- [ ] **Step 3: 运行时逐事件写 outbox + SSE，最终消息只在 run_completed 校准**

`message_update` 计算新增长度，只发 delta；`message_end` 累加每个 assistant usage；错误 stopReason 写 `run_failed`，不得返回 200 空完成。

- [ ] **Step 4: 前端停止改为调用 cancel API**

fetch abort 仅关闭本地读取，只有 cancel 成功事件才展示“已停止”；断线以最后 `eventSeq` 指数退避重连。

- [ ] **Step 5: 运行前后端测试并提交**

Run: `cd pi-main && npx vitest run packages/vibepaper-agent-service/test/agent-streaming-cancel.test.ts`

### Task 7: Generation 终态回调、notice 消费与异步恢复

**Files:**
- Modify: `generation-service/src/generation/services/task_service.py`
- Create: `pi-main/packages/vibepaper-agent-service/src/application/task-terminal-service.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/infrastructure/task-event-consumer.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/api/app.ts`
- Test: `generation-service/tests/test_agent_terminal_callback.py`
- Test: `pi-main/packages/vibepaper-agent-service/test/task-terminal-service.test.ts`

**Interfaces:**
- Consumes: `{ taskId,status,nodeId,canvasId,output?,errorCode?,actualCost? }`，不要求 Generation 保存 sessionId。
- Produces: 按 `task_id` 定位 action → run → session 的幂等 observation/outbox。

- [ ] **Step 1: 写 callback 不含 sessionId、重复终态、伪造 secret、重启恢复测试**

- [ ] **Step 2: 运行并确认失败**

Run: `cd generation-service && uv run pytest tests/test_agent_terminal_callback.py -q`

- [ ] **Step 3: 实现 task_id 关联和 fail-closed 内部认证**

首个终态更新 action 和 usage，重复相同终态返回 200 幂等 ACK；冲突终态写审计告警；consumer 领取 notice 时使用 `FOR UPDATE SKIP LOCKED`。

- [ ] **Step 4: 通过两端测试并提交**

Run: `cd pi-main && npx vitest run packages/vibepaper-agent-service/test/task-terminal-service.test.ts`

### Task 8: Action/Approval 签发、原子消费与版本失效

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/domain/action-approval.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/application/approval-service.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/infrastructure/pg-approval-repository.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/api/app.ts`
- Test: `pi-main/packages/vibepaper-agent-service/test/approval-service.test.ts`

**Interfaces:**
- Produces: `planAction(input): PlannedAction`、`consumeApproval(actionId,token,currentCanvasVersion): ConsumedAction`。

- [ ] **Step 1: 写 1 点确认、hash 绑定、过期、版本变化和 100 并发测试**

```ts
expect((await Promise.allSettled(Array.from({length:100}, consume))).filter(x => x.status === "fulfilled")).toHaveLength(1);
```

- [ ] **Step 2: 确认失败后实现同事务 action + approval + outbox**

canonical JSON 生成 SHA-256 action hash；HMAC token 绑定用户、画布、版本、动作、nonce、过期；原子 `UPDATE ... WHERE status='pending' RETURNING` 后再执行。

- [ ] **Step 3: 拒绝/过期/版本冲突均产生可重放事件并提交**

Run: `cd pi-main && npx vitest run packages/vibepaper-agent-service/test/approval-service.test.ts`

### Task 9: 权威估价、Billing 执行、费用上限与画布补偿

**Files:**
- Modify: `pi-main/packages/vibepaper-agent-service/src/infrastructure/tool-gateway.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/application/generation-action-executor.ts`
- Modify: `vibepaper-services/billing-service/src/main/java/com/vibepaper/billing/controller/TaskController.java`
- Modify: `vibepaper-services/billing-service/src/main/java/com/vibepaper/billing/service/PointService.java`
- Test: `pi-main/packages/vibepaper-agent-service/test/generation-action-executor.test.ts`
- Test: `vibepaper-services/billing-service/src/test/java/com/vibepaper/billing/AgentTaskContractTest.java`

**Interfaces:**
- Consumes: Generation `/api/v1/models/estimate` 的权威整数估价。
- Produces: Billing `POST /api/v1/tasks`，幂等键 `agt:{actionId}:{attemptNo}`。

- [ ] **Step 1: 写模型伪造 cost 被忽略、费用超过 cap、重复确认、queued 回写失败测试**

- [ ] **Step 2: 确认失败后实现 estimate → approval → billing freeze → canvas queued**

模型只提供意图和参数；服务端 canonicalize 后估价。Canvas 回写失败时 action 标为 `compensation_required`，持久化补偿任务并向用户展示，不允许 `.catch(() => undefined)`。

- [ ] **Step 3: 实现 points/token 用量对账**

session 使用量来自已完成 run 和 Billing 实际费用汇总，不用模型自报值；终态对账差异进入审计指标。

- [ ] **Step 4: 通过 Node + Java 测试并提交**

## Phase B：最小可用 Agent 控制面

### Task 10: 单一 ToolManifest 与确定性策略

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/domain/tool-manifest.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/domain/tool-policy.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/tools/drama-tools.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/tools/skill-tools.ts`
- Generate: `pi-paper-web/src/api/generated/agentToolManifest.ts`
- Test: `pi-main/packages/vibepaper-agent-service/test/tool-manifest.test.ts`

**Interfaces:**

```ts
interface ToolManifestEntry {
  name: string; profiles: AgentProfile[]; version: number; schema: TSchema;
  risk: "read"|"canvas_write"|"high"; maxBatch: number;
  costPolicy: "none"|"estimate_required"; approvalPolicy: string;
  auditFields: string[];
}
```

- [ ] **Step 1: 写 manifest 唯一性、前后端标签一致、profile 工具子集测试**
- [ ] **Step 2: 实现 manifest 并从中构造 Pi Tools、策略校验和前端标签**
- [ ] **Step 3: 禁止 Skill 或模型动态扩展 manifest**
- [ ] **Step 4: 运行测试并提交**

### Task 11: Profile 选择、意图边界、优先级与真实模型选择

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/domain/agent-profile.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/application/profile-selector.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/application/instruction-precedence.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/application/agent-runtime.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/pi/profile-agents.ts`
- Modify: `pi-paper-web/src/features/canvas/AgentPanel.tsx`
- Test: `pi-main/packages/vibepaper-agent-service/test/profile-selector.test.ts`

**Interfaces:**
- Produces: `canvas-general|vertical-short-drama|asset-assistant|audit-readonly`；profile 由入口、画布领域、pending action 和轻量分类确定，LLM 无权选择。

- [ ] **Step 1: 写决策表和 instruction precedence 测试**

优先级固定为：当前确认约束 > 当前明确用户指令 > 画布/项目已确认事实 > 用户偏好 > Skill > profile 默认 > 模型默认。

- [ ] **Step 2: 写请求模型不支持 profile/工具时失败测试**
- [ ] **Step 3: 实现 profile factory 和 model snapshot**

消息请求携带 `modelId`；服务端验证模型能力并把 provider/model/version 写入 run，不能只依赖全局 `config.llmModel`。

- [ ] **Step 4: 运行测试并提交**

### Task 12: 画布上下文构建器与 Pi transformContext

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/application/canvas-context-builder.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/domain/context-budget.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/application/agent-runtime.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/infrastructure/tool-gateway.ts`
- Test: `pi-main/packages/vibepaper-agent-service/test/canvas-context-builder.test.ts`

**Interfaces:**
- Produces: `CanvasContext { summary, selectedNodes, oneHopDependencies, relevantAssets, version }`，以不可信数据块注入 `transformContext`。

- [ ] **Step 1: 写权限、版本、预算、截断、敏感字段过滤和 one-hop 测试**
- [ ] **Step 2: 实现 summary/selected/detail/edge/asset 受限读取**
- [ ] **Step 3: 使用 Pi `transformContext` 注入，不把二进制或密钥传给模型**
- [ ] **Step 4: 运行测试并提交**

### Task 13: 只读画布、素材、模型与任务工具

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/tools/read-tools.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/infrastructure/tool-gateway.ts`
- Test: `pi-main/packages/vibepaper-agent-service/test/read-tools.test.ts`

**Interfaces:**
- Produces: `get_canvas_summary`、`get_selected_nodes`、`get_node_detail`、`list_models`、`search_assets`、`check_task_status`。

- [ ] **Step 1: 为每个工具写成功、无权限、超时、坏响应和脱敏测试**
- [ ] **Step 2: 实现 REST adapter；统一超时、重试和 request ID**
- [ ] **Step 3: 验证 profile 工具白名单和审计字段并提交**

### Task 14: 低风险画布命令工具

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/tools/canvas-command-tools.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/application/canvas-command-service.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/infrastructure/tool-gateway.ts`
- Test: `pi-main/packages/vibepaper-agent-service/test/canvas-command-tools.test.ts`

**Interfaces:**
- Produces: `create_nodes`、`connect_nodes`、`layout_nodes`、`update_node_config`、`delete_nodes`；每次命令携带预期 canvas version。

- [ ] **Step 1: 写 owner、版本冲突、maxBatch=20、幂等和部分失败测试**
- [ ] **Step 2: 实现 canonical command 和结果摘要**
- [ ] **Step 3: 每个成功写操作产生 `canvas_changed` 事件；原始内部错误不直接展示**
- [ ] **Step 4: 运行测试并提交**

### Task 15: Proposed generation 与任务查询闭环

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/tools/generation-tools.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/application/approval-service.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/application/generation-action-executor.ts`
- Test: `pi-main/packages/vibepaper-agent-service/test/generation-tools.test.ts`

**Interfaces:**
- `submit_generation` 只返回 proposed action/confirmation；批准后才调用 Task 9 executor。

- [ ] **Step 1: 写无确认不冻结、切模型必确认、覆盖输出必确认、重复提交幂等测试**
- [ ] **Step 2: 实现 proposed action，Pi `afterToolCall` 以 `waiting_confirmation` 优雅停止**
- [ ] **Step 3: 终态后按已批准范围决定是否 follow-up，不得自动扩大费用范围**
- [ ] **Step 4: 运行测试并提交**

### Task 16: 前端统一事件 reducer、时间线和错误可见性

**Files:**
- Create: `pi-paper-web/src/features/canvas/agentEventEnvelope.ts`
- Modify: `pi-paper-web/src/features/canvas/agentEventHandlers.ts`
- Modify: `pi-paper-web/src/features/canvas/agentTypes.ts`
- Modify: `pi-paper-web/src/features/canvas/AgentPanel.tsx`
- Modify: `pi-paper-web/src/features/canvas/AgentExecutionRecord.tsx`
- Test: `pi-paper-web/src/features/canvas/agentEventHandlers.test.ts`

**Interfaces:**
- Consumes Task 6 `AgentEventEnvelope`，只对 `assistant_delta` 做追加，以 `run_completed` 校准最终消息。

- [ ] **Step 1: 写 delta、工具、确认、任务、failed/aborted、重复 eventId reducer 测试**
- [ ] **Step 2: 删除旧混合事件推断，按 envelope.type 纯函数归约**
- [ ] **Step 3: 将 `.catch(() => undefined)` 替换为有意图的 ignore、toast 或可重试状态**
- [ ] **Step 4: 运行 Vitest、tsc、oxlint 并提交**

### Task 17: Fastify TypeBox、OpenAPI 与前端生成类型

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/api/schemas/common.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/api/schemas/sessions.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/api/schemas/events.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/api/schemas/skills.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/api/schemas/memories.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/api/schemas/drama.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/api/app.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/api/openapi.ts`
- Generate: `pi-paper-web/src/api/generated/agent.ts`
- Modify: `pi-paper-web/package.json`
- Test: `pi-main/packages/vibepaper-agent-service/test/openapi-contract.test.ts`

**Interfaces:**
- Produces: OpenAPI 3.1 文档、稳定错误 schema、消息 `modelId/selectedNodeIds` 和 SSE event schema。

- [ ] **Step 1: 写所有前端调用路径都存在、错误码不被改写、schema 示例可解析测试**
- [ ] **Step 2: 将 `Record<string,unknown>` 手工解析迁移为 route schema**
- [ ] **Step 3: 使用 openapi-typescript 生成前端类型并加入 breaking-change CI**
- [ ] **Step 4: 运行契约测试并提交**

### Task 18: 节点参考闭环真实浏览器验收

**Files:**
- Create: `pi-paper-web/e2e/agent-node-references.spec.ts`
- Update if defect found: `pi-paper-web/src/features/canvas/AgentNodeReferenceCards.tsx`
- Update: `docs/audits/pi-agent-remediation-tracker.md`

**Interfaces:**
- Verifies existing `AgentNodeReference` snapshot contract; no new behavior unless E2E exposes a defect.

- [ ] **Step 1: 写 Playwright 用例覆盖文本/图片/视频卡、刷新历史、失败保留、成功消费、重新选择**
- [ ] **Step 2: 启动完整栈并确认截图基线失败或待生成**
- [ ] **Step 3: 修复实际视觉/交互缺陷并生成桌面 1280px+ 截图**
- [ ] **Step 4: 运行现有 20 个后端和 4 个前端回归测试 + Playwright**
- [ ] **Step 5: tracker 将 P1-02/P1-23 标记 verified 并提交**

## Phase C：会话、恢复、记忆与计划

### Task 19: 可恢复 Pi transcript、steer/follow-up 与 pending 状态

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/application/pi-transcript-service.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/infrastructure/pg-transcript-repository.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/application/agent-runtime.ts`
- Test: `pi-main/packages/vibepaper-agent-service/test/pi-transcript-recovery.test.ts`

**Interfaces:**
- Persists: user、assistant、tool call、toolResult、pending action、run stopReason；复用 Pi `steer()/followUp()/shouldStopAfterTurn()`。

- [ ] **Step 1: 写工具 observation 重启恢复、active run 新输入 steer、waiting 状态 follow-up 测试**
- [ ] **Step 2: 实现业务事实在 PostgreSQL、Pi transcript 为可重建运行输入**
- [ ] **Step 3: kill/restart 注入测试确认不重复副作用并提交**

### Task 20: 业务事实保护型 compaction

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/application/context-compaction-service.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/domain/protected-facts.ts`
- Test: `pi-main/packages/vibepaper-agent-service/test/context-compaction.test.ts`

**Interfaces:**
- Produces: `CompactedContext { summary, protectedFacts, recentMessages, tokenEstimate }`。

- [ ] **Step 1: 写超预算、待审批、任务终态、Canon/费用事实不能丢失测试**
- [ ] **Step 2: 选择性复用 Pi token/summary 辅助函数，业务事实由确定性 extractor 保留**
- [ ] **Step 3: 移除固定 `slice(-24)`，改为 token budget + protected facts 并提交**

### Task 21: 四级记忆检索、写入、授权与生命周期

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/migrations/004_memory_governance.sql`
- Create: `pi-main/packages/vibepaper-agent-service/src/domain/memory.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/application/memory-service.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/infrastructure/pg-memory-repository.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/api/app.ts`
- Test: `pi-main/packages/vibepaper-agent-service/test/memory-service.test.ts`

**Interfaces:**
- Scopes: `session|canvas|long_term|enterprise`；字段包含 source、tenant/user/canvas、confidence、TTL、visibility、version、deleted。

- [ ] **Step 1: 写 top-k 相关性、scope/tenant 隔离、TTL、去重、明确授权、删除/导出测试**
- [ ] **Step 2: 实现检索并以受限摘要注入 Task 12 context**
- [ ] **Step 3: run 完成后异步提出 memory candidate；长期/企业写入必须确认或管理员发布**
- [ ] **Step 4: 敏感信息、原始工具输出和完整媒体禁止写入并提交**

### Task 22: Skill 快照、attach 合同与安全治理

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/migrations/005_skill_versions.sql`
- Create: `pi-main/packages/vibepaper-agent-service/src/application/skill-governance-service.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/tools/skill-tools.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/api/app.ts`
- Modify: `pi-paper-web/src/features/canvas/AgentPanel.tsx`
- Test: `pi-main/packages/vibepaper-agent-service/test/skill-governance.test.ts`

**Interfaces:**
- Produces: immutable `SkillVersion { skillId,version,sha256,capabilities,maxContextTokens,riskStatus }` 和兼容 `POST /sessions/{id}/skills/{skillId}:attach` 或统一 PUT 合同。

- [ ] **Step 1: 写旧会话回放、重复 attach、正文超限、提示注入、能力越界测试**
- [ ] **Step 2: 上传时规范化 Markdown、扫描风险、锁定版本/hash 和上下文预算**
- [ ] **Step 3: session 保存版本快照；Skill 不得注册工具/供应商或改变 profile**
- [ ] **Step 4: 修复前端真实路径、OpenAPI 和网关测试并提交**

### Task 23: 会话分页、搜索、重命名、归档、删除与跨画布复制

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/application/session-service.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/api/app.ts`
- Modify: `pi-paper-web/src/features/canvas/AgentPanel.tsx`
- Test: `pi-main/packages/vibepaper-agent-service/test/session-lifecycle.test.ts`
- Test: `pi-paper-web/e2e/agent-session-lifecycle.spec.ts`

**Interfaces:**
- Produces cursor pagination；`PATCH /sessions/{id}`、`:archive`、`:restore`、DELETE、`:copy-to-canvas`。

- [ ] **Step 1: 写稳定 cursor、owner 隔离、软删除、显式复制、画布切换清空 sessionId 测试**
- [ ] **Step 2: 实现生命周期 API 和索引**
- [ ] **Step 3: 前端增加搜索/重命名/归档，画布变化时停止旧 run 并重置会话**
- [ ] **Step 4: 运行 API + Playwright 并提交**

### Task 24: 结构化计划、计划版本、依赖 compiler 与局部重跑审计

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/migrations/006_agent_plans.sql`
- Create: `pi-main/packages/vibepaper-agent-service/src/domain/agent-plan.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/application/plan-compiler.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/application/canvas-dependency-compiler.ts`
- Test: `pi-main/packages/vibepaper-agent-service/test/plan-dependency-compiler.test.ts`

**Interfaces:**

```ts
interface AgentPlan { id:string; sessionId:string; version:number; canvasVersion:number; steps:PlanStep[]; }
interface PlanStep { id:string; tool:string; dependsOn:string[]; status:string; inputHash:string; }
```

- [ ] **Step 1: 写 plan 版本冲突、Ready Set、stale 传播、局部重跑不扩大费用测试**
- [ ] **Step 2: compiler 只接受 ToolManifest 工具并验证权限/版本/批量/费用策略**
- [ ] **Step 3: 新增计划摘要查询、步骤重跑审计和前端事件，禁止默认自动扣点重跑**
- [ ] **Step 4: 运行测试并提交**

## Phase D：完整短剧生产链

### Task 25: WorldBible、Episode、Scene、ContinuityFact 与 Foreshadow

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/migrations/007_drama_story_domain.sql`
- Create: `pi-main/packages/vibepaper-agent-service/src/domain/drama-story.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/application/drama-story-service.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/api/app.ts`
- Test: `pi-main/packages/vibepaper-agent-service/test/drama-story.test.ts`

**Interfaces:**
- Produces: `StoryBible → Episode → Scene → ShotSpec`，全部 owner-scoped 且有 revision/status。

- [ ] **Step 1: 写归属、顺序、Canon revision、伏笔埋设/回收和 continuity 规则测试**
- [ ] **Step 2: 实现领域实体、repository 和 API schema**
- [ ] **Step 3: Canvas 仅保存投影节点，PostgreSQL 领域表保存规范事实并提交**

### Task 26: CharacterLook/Prompt/Canvas revision、输入哈希与 stale 影响集

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/domain/render-input-hash.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/domain/drama-state.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/infrastructure/pg-drama-state-store.ts`
- Test: `pi-main/packages/vibepaper-agent-service/test/drama-lineage-impact.test.ts`

**Interfaces:**
- Hash includes: Canon revision、Character Look revision、Prompt revision、Canvas version、RenderLineage inputs。

- [ ] **Step 1: 写“改第 2 镜只 stale 第 2 镜”、角色变化影响绑定镜头、无自动重跑测试**
- [ ] **Step 2: 实现确定性 hash 和 impact set**
- [ ] **Step 3: 产生重跑建议/估价事件，等待用户确认并提交**

### Task 27: Keyframe-first RenderBatch/RenderJob 与批准成本上限

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/application/render-batch-service.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/tools/drama-tools.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/application/generation-action-executor.ts`
- Test: `pi-main/packages/vibepaper-agent-service/test/render-batch.test.ts`

**Interfaces:**
- Produces: batch state `draft|awaiting_approval|running|partial|completed|failed`；视频 job 必须引用 accepted keyframe。

- [ ] **Step 1: 写关键帧先行、2-5 秒、3-5 identity anchors、cost cap、部分失败/局部重跑测试**
- [ ] **Step 2: 实现 batch/job action 编译和审批摘要**
- [ ] **Step 3: 使用 Task 7 终态推进，不用内存回调推进并提交**

### Task 28: TTS、Subtitle 与 Composite 生产链

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/domain/audio-subtitle-composite.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/application/post-production-service.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/tools/post-production-tools.ts`
- Modify: `generation-service/src/generation/services/task_service.py`
- Test: `pi-main/packages/vibepaper-agent-service/test/post-production.test.ts`

**Interfaces:**
- Produces: `Video → TTS → Subtitle → Composite`；每个产物有 lineage、时长、语言、voice、时间轴和 task_id。

- [ ] **Step 1: 写时长、音画同步、字幕边界、已有制品复用、失败补偿测试**
- [ ] **Step 2: 实现工具 manifest、action、任务和 lineage**
- [ ] **Step 3: 合成只消费 accepted 上游制品；覆盖输出必须确认并提交**

### Task 29: 独立只读 Audit Agent 与确定性 continuity 审校

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/pi/audit-agent.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/application/render-audit-service.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/domain/continuity-rules.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/api/app.ts`
- Test: `pi-main/packages/vibepaper-agent-service/test/render-audit.test.ts`

**Interfaces:**
- `audit-readonly` profile 只能读；`render_reviews` 只能由审校服务写，客户端只能查询或提交“请求审校”。

- [ ] **Step 1: 写客户端直写拒绝、规则证据、LLM 建议不可覆盖规则结论测试**
- [ ] **Step 2: 实现角色一致性、时长、镜头连续性、音画同步确定性规则**
- [ ] **Step 3: Pi 生成解释和建议，规则/输入/模型版本全部写审计报告并提交**

### Task 30: 短剧生产前端纵切

**Files:**
- Modify: `pi-paper-web/src/features/canvas/DramaAssetsTab.tsx`
- Create: `pi-paper-web/src/features/canvas/DramaProductionPanel.tsx`
- Create: `pi-paper-web/src/features/canvas/DramaAuditPanel.tsx`
- Test: `pi-paper-web/e2e/drama-three-shot-production.spec.ts`

**Interfaces:**
- Displays: StoryBible、Scene/ShotSpec、ReferencePack、Keyframe、Video、Audio/Subtitle、Composite、AuditReport 和 stale impact。

- [ ] **Step 1: 写三镜头 E2E：角色档案→ShotSpec→关键帧→审校→确认视频→字幕合成**
- [ ] **Step 2: 实现状态、成本、确认、局部重跑和审校证据 UI**
- [ ] **Step 3: 验证修改第 2 镜只提示第 2 镜重跑并提交**

## Phase E：规模化、评测与发布

### Task 31: 模型能力目录、服务端估价、供应商降级与重试预算

**Files:**
- Modify: `generation-service/src/generation/services/model_service.py`
- Modify: `generation-service/src/generation/services/model_resolve.py`
- Create: `generation-service/src/generation/domain/model_capability.py`
- Modify: `pi-main/packages/vibepaper-agent-service/src/infrastructure/tool-gateway.ts`
- Test: `generation-service/tests/test_model_capability_and_fallback.py`

**Interfaces:**
- Produces: capability 包含输入/输出类型、时长、分辨率、参考图、价格版本、provider、fallback group、retry budget。

- [ ] **Step 1: 写不支持参数、价格版本变化、fallback 不扩大费用 cap、重试耗尽测试**
- [ ] **Step 2: 实现权威 canonical params/estimate 和 provider fallback**
- [ ] **Step 3: Agent 记录选定模型/价格/供应商版本，前端展示真实选择并提交**

### Task 32: 企业记忆、批量审批与生产配额

**Files:**
- Modify: `pi-main/packages/vibepaper-agent-service/src/application/memory-service.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/application/enterprise-agent-policy.ts`
- Modify: `vibepaper-services/enterprise-service/src/main/java/com/vibepaper/enterprise/service/EnterpriseService.java`
- Modify: `vibepaper-services/enterprise-service/src/main/java/com/vibepaper/enterprise/controller/InternalController.java`
- Create: `vibepaper-services/enterprise-service/src/main/resources/db/migration/V2__agent_enterprise_policies.sql`
- Test: `pi-main/packages/vibepaper-agent-service/test/enterprise-policy.test.ts`

**Interfaces:**
- Produces: enterprise visibility/retention/export/delete policy、管理员发布记忆、批量审批上限、成员生产配额。

- [ ] **Step 1: 写跨企业隔离、管理员权限、共享池默认关闭、配额耗尽测试**
- [ ] **Step 2: 实现 policy snapshot 并在每次 run/action 重新校验**
- [ ] **Step 3: 增加审计日志和导出/删除任务并提交**

### Task 33: Agent 效果评测集、trace diff 与模型/Skill A-B

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/evals/cases/canvas-general.json`
- Create: `pi-main/packages/vibepaper-agent-service/evals/cases/asset-assistant.json`
- Create: `pi-main/packages/vibepaper-agent-service/evals/cases/vertical-short-drama.json`
- Create: `pi-main/packages/vibepaper-agent-service/evals/cases/audit-readonly.json`
- Create: `pi-main/packages/vibepaper-agent-service/evals/cases/security-and-recovery.json`
- Create: `pi-main/packages/vibepaper-agent-service/evals/run-evals.ts`
- Create: `pi-main/packages/vibepaper-agent-service/src/application/evaluation-service.ts`
- Create: `docs/evals/pi-agent-evaluation-protocol.md`
- Test: `pi-main/packages/vibepaper-agent-service/test/evaluation-service.test.ts`

**Interfaces:**
- Eval case 固定输入画布、用户目标、模型/Skill/workflow 版本、预期工具/确认/结果约束；输出 trace、人工修订、点数与质量评分。

- [ ] **Step 1: 建立 general、asset、short-drama、audit、安全越权和失败恢复数据集**
- [ ] **Step 2: 实现可重复 trace runner 和结构化 diff**
- [ ] **Step 3: A-B 只改变一个版本变量，记录质量、成本、时延、修订和收益归因**
- [ ] **Step 4: 在 CI nightly 运行并提交**

### Task 34: 可观测性、告警、审计与 SLO

**Files:**
- Create: `pi-main/packages/vibepaper-agent-service/src/infrastructure/telemetry.ts`
- Modify: `pi-main/packages/vibepaper-agent-service/src/server.ts`
- Modify: `deploy/docker-compose.yml`
- Modify: `deploy/start-all.ps1`
- Modify: `deploy/stop-all.ps1`
- Create: `docs/operations/pi-agent-runbook.md`
- Test: `pi-main/packages/vibepaper-agent-service/test/telemetry.test.ts`

**Interfaces:**
- Trace fields: `request_id,user_id,session_id,run_id,event_seq,action_id,task_id,canvas_id,model_id,error_code,estimated_cost,actual_cost`。

- [ ] **Step 1: 写跨服务 trace、敏感字段脱敏、关键指标存在性测试**
- [ ] **Step 2: 增加 run 成功率、首 token、工具失败、确认转化、重复抑制、费用差异、审校通过率指标**
- [ ] **Step 3: 定义告警阈值、排障步骤和审计保留策略并提交**

### Task 35: 全量验证、灰度、影子运行、回滚与旧 Agent 退役

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/specs/V1.0-engineering-spec.md`
- Modify: `docs/audits/pi-agent-remediation-tracker.md`
- Create: `docs/releases/pi-agent-production-readiness.md`
- Delete only after parity and rollback approval: `agent-service/src/agent`

**Interfaces:**
- Produces: 可审计的 production readiness 报告、7 天灰度指标、回滚开关和旧 Agent 退役记录。

- [ ] **Step 1: 运行所有服务单元/迁移/集成/E2E**

```bash
cd pi-main && npx vitest run packages/vibepaper-agent-service/test
cd pi-main && npx tsgo -p packages/vibepaper-agent-service/tsconfig.build.json --noEmit
cd pi-paper-web && pnpm test && pnpm exec tsc -b --pretty false && pnpm lint
cd generation-service && uv run pytest -q && uv run ruff check . && uv run mypy src
cd vibepaper-services && mvn test
```

- [ ] **Step 2: 运行完整栈 Playwright 和故障注入**

覆盖模型流中断、DB 重启、Agent 重启、确认并发、回调重复、SSE 断线、Nacos 故障、Canvas 版本冲突、Billing 超时；预期 0 重复画布写和 0 重复点数冻结。

- [ ] **Step 3: 逐项关闭 tracker**

所有 P0/P1/P2 条目必须为 `verified`，并填写提交、测试命令、结果和证据链接；任何未关闭项阻止发布。

- [ ] **Step 4: 影子运行和灰度**

先只读 shadow，对比旧 Agent trace；再 1%→10%→50%→100%。连续 7 天满足：0 越权、0 重复扣点、0 不可恢复 active run、契约错误率 0、P95 首 delta/完成时延在发布阈值内。

- [ ] **Step 5: 回滚演练后再退役旧 Python Agent**

旧 Agent 代码只有在 parity catalog 全部 `covered/not_applicable-with-reason`、Pi 达标、回滚开关验证后删除；删除提交必须独立，便于恢复。

## 阶段退出标准

### Phase A Exit Gate

- P0-07、P0-09..15、P1-15..22 对应测试通过。
- 所有内部路由 fail closed；无跨用户 drama/会话访问；迁移可重复、可审计；Pi CI 为必需门禁。

### Phase B Exit Gate

- 用户能基于真实画布完成“理解画布→三个方向→创建节点/连线→确认生成→看到任务状态”。
- 100% 高风险工具产生 action/approval；0 次未经确认的点数冻结；SSE 真增量且可重放。

### Phase C Exit Gate

- 模型流、工具、确认等待和任务运行期间杀进程后均可恢复；0 重复副作用。
- 记忆/Skill/会话均具备 scope、版本、授权、删除/归档和可复现能力。

### Phase D Exit Gate

- 三镜头短剧纵切可运行；修改第 2 镜只使第 2 镜 lineage stale；音频、字幕、合成和审校均可追踪。

### Phase E Exit Gate

- 审查 tracker 全部 verified；评测、trace、SLO、灰度和回滚证据齐全；连续 7 天生产门槛通过。

## Self-Review Checklist

- [ ] 审查报告 P0 15 项、P1 23 项、P2 10 项均出现在追踪矩阵。
- [ ] 每个条目至少对应一个有失败测试、实现步骤和验收命令的任务。
- [ ] 所有跨服务写操作均经过 Tool Gateway，且存在幂等/补偿/审计策略。
- [ ] Pi 可复用范围未包含 VibePaper 业务账本、任意工具或本地凭据模型。
- [ ] 全文不存在任何占位语句或把实现细节推迟到未来任务的描述。
- [ ] P1-23 不重复开发，只补真实浏览器验收。
