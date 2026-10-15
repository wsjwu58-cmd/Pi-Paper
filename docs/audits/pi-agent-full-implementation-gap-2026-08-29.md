# Pi Agent 审查整改差异（2026-08-29）

本记录以当前工作区源码和已执行的验证命令为准。只有存在真实持久化、权限边界和可重复验证的实现，才列入“已落地”；仅有内存 service 或单元测试的能力仍列为未闭环。

## 已落地并完成真实路径

- P0-01/02/03：Action/Approval 签发与原子消费、ToolManifest profile 过滤、服务端模型估价、Billing 冻结与画布 queued 回写。
- P0-04/05/06/07/08/09：运行事件持久化、SSE 增量和 afterSeq 重放、服务端 abort、Skill attach 合同、按 task_id 的终态回调、通知消费、内部回调 fail-closed。
- P0-10/11/12/13/14/15：短剧状态 owner 隔离、会话画布绑定、版本化迁移、显式 Snowflake worker/datacenter、Pi CI、Nacos 生产配置检查。
- P1-01/02/03/05/07/08/09/10/11/12/13/15/16/17/18/19/20/21/22/23：四 profile、权威画布上下文和节点引用、业务事实保护型压缩、统一 SSE 信封、终态错误、token/点数回写、模型请求、记忆注入、Skill version/hash 快照、稳定错误码和 request ID 透传、queued 补偿、网关路由、OpenAPI 入口、约束迁移、多实例 ID、部署配置和节点参考回显。
- P2-01/05/08/09：PostgreSQL run/event/outbox/replay 基础、只读确定性审校、会话生命周期 API、前端事件重连基础。
- Task 25：StoryBible、Episode、Scene、ContinuityFact、Foreshadow 已使用 PostgreSQL 和 owner-scoped API。
- Task 28（基础事实层）：Video、TTS、Subtitle、Composite 制品已使用 PostgreSQL、lineage、时长校验、字幕边界校验、上游 accepted 校验和幂等键；这不等于已自动提交对应 Generation 任务。
- Task 24（基础事实层）：结构化计划已使用 `agent_plans`/`agent_plan_steps` 持久化，创建时校验 ToolManifest，局部重跑产生新计划版本并保留旧计划。

## 仍未达到“全功能真实闭环”的项

1. P2-02/P2-03（部分补齐）：计划已持久化步骤输入、提供按 profile 重算的 Ready Set API，并保留依赖影响重跑；仍未接入 Agent 自动编排事件、步骤执行器和基于实时 Canvas 版本的 stale 编译，因此不会自动执行计划步骤。
2. P2-04/P2-06（已补齐主要执行链，仍有边界缺口）：已增加 PostgreSQL `agent_render_batches`/`agent_render_jobs`、权威逐任务估价、90 镜头上限、2-5 秒时长校验、accepted 关键帧/集数/画布归属校验、确认令牌、输入哈希、逐镜真实 Generation 提交、task 终态回写、事务锁状态聚合和失败局部重跑。尚未完整接入 CharacterLook revision/供应商重试预算，也未将整批点数预冻结做成 Billing 原子批量接口；TTS/字幕/合成制品仍未自动提交为 Generation 任务，因此仍不能宣称所有短剧加工链已完成。
3. P2-07：企业记忆策略、保留/导出/删除审计和企业配额尚未完整接入 Enterprise service；目前只有 Agent 侧 scope/tenant/admin 检查。
4. P2-10：评测集和 trace 结构已建立部分目录，但尚未形成线上 A/B、人工修订、点数收益归因和发布门禁。
5. 全栈运行验收：尚未在真实 PostgreSQL、Redis、Nacos、RocketMQ、Java 全服务和 Generation 供应商凭证环境执行浏览器级三镜头验收；因此不能把本记录当成生产上线证明。

6. API 级前置约束：批次创建要求 `sessionId`、`canvasVersion`、`Idempotency-Key`，有点数成本时必须消费绑定当前画布版本的确认令牌；提交任务前必须已有画布视频节点，避免把“创建批次”误报为已生成。

## 本轮验证

- `cd E:\VibePaperProject\pi-main && npm run check`：通过。
- `cd E:\VibePaperProject\pi-main && npx vitest run packages/vibepaper-agent-service/test`：39 个文件、101 个测试通过。
- `cd E:\VibePaperProject\pi-main && npx tsgo -p packages/vibepaper-agent-service/tsconfig.build.json --noEmit`：通过。
- `cd E:\VibePaperProject\pi-paper-web && pnpm exec tsc -b --pretty false`：通过。
- `cd E:\VibePaperProject\generation-service && uv run --with pytest --with redis --with httpx --with sqlalchemy --with psycopg2-binary --with pydantic-settings --with fastapi --with python-multipart --with pillow --with alembic pytest -q`：10 个测试通过，2 个既有弃用/缓存警告。
- `cd E:\VibePaperProject\vibepaper-services\canvas-service && mvn -DskipTests compile`：通过。
- `cd E:\VibePaperProject\pi-main && npx tsgo -p packages/vibepaper-agent-service/tsconfig.build.json --noEmit`：通过（含 RenderBatch/内部终态回写）。
- `cd E:\VibePaperProject\pi-paper-web && pnpm exec tsc -b --pretty false`：通过（含生产链批次状态展示）。
- `cd E:\VibePaperProject\pi-paper-web && pnpm exec oxlint src/features/canvas/DramaProductionPanel.tsx`：通过。

`git diff --check` 的失败来自工作区已有的二进制 PDF 变更，不涉及本轮源码文件，未对用户文件执行清理或回滚。
