# Agent 实时任务、自动续跑、思考摘要与 `/Skill` 命令实现计划

> 状态：待实施  
> 日期：2026-09-12  
> 适用范围：`vibepaper-web`、`agent-service`、`generation-service`、任务终态回调与计费提交链路

## 1. 目标与产品决策

本计划将 Agent 的一次创作请求从“提交任务后停止、用户刷新才看到结果”变为可恢复的异步工作流：

1. 图片、视频、音频任务提交后，画布节点立即显示 `queued/running`；终态产物和对话状态无需刷新页面即可出现。
2. 已提交任务即使在浏览器断线、面板关闭重开或 Agent 服务重启后，也能按会话游标恢复终态消息与画布状态。
3. 任务完成会解锁计划中的下游步骤；例如关键帧完成后，Agent 自动创建并提交对应视频片段，而非把会话直接结束。
4. AI 回复提供默认折叠的“思考与计划”摘要，展示可验证的执行意图和下一步，不展示模型原始隐藏推理。
5. 输入框键入 `/` 时展示可搜索的 Skill 选择器；选中 Skill 后，它作为本轮显式上下文加载并记录在执行轨迹中。
6. 用户已要求取消“提交生成”的交互确认：模型可直接提交生成任务，但点数冻结、余额校验、预算策略、幂等、审计和取消能力继续保留。

### 1.1 需要同步的工程契约

当前 `AGENTS.md` / PRD 的安全规则要求 `estimated_cost ≥ 1` 的生成必须确认，这与本计划的直接提交决策冲突。实施第一步必须把该规则改为“由执行策略决定”：

- `manual`：保留确认卡片；用于默认生产安全模式或需要人工审核的企业策略。
- `auto`：不展示确认卡片，模型通过受控工具直接提交；用于本次要求的创作体验。

两种策略都必须经过服务端余额校验、冻结/结算、单任务与批量预算上限、幂等键和审计记录。`auto` 不是让模型直连数据库或绕过计费。

## 2. 已确认根因

### 2.1 页面刷新后才出现生成状态与完成消息

- 画布节点任务查询只会在缓存中已存在 `queued/running` 任务或节点自身已有运行状态时启动轮询。Agent 提交任务后未使 `canvas-tasks` 查询失效，因此首次任务不会触发轮询。
- Agent 服务将 `task_status` 与 `run_completed` 正确持久化；但 `GET /agent/sessions/:sessionId/events` 只回放当前活跃运行。任务已完成后运行不再活跃，重连请求只得到 `idle`，错过的终态事件不会回放给前端。
- 前端只有在接收成功终态事件时刷新画布；断线后的 `idle` 没有静默重新拉取会话与画布。

### 2.2 生成完成后没有继续创建视频

当前生成路径在提交后把运行置为 `waiting_task`。任务终态回调会写入一条“生成完成”消息并直接结束运行，但不会基于计划步骤重新唤醒 Agent。计划依赖关联仅覆盖部分计划执行路径，普通对话式生成没有统一的“任务 → 计划步骤 → 续跑”闭环。

### 2.3 思考区已有基础但没有可靠数据来源

前端 `AgentTurnTimeline` 已支持 `reasoning` 步骤与折叠执行记录，但 Agent 运行时没有将工具前的执行意图、依赖判断和下一步计划持久化为安全事件。因此不能稳定显示图示中的思考/执行片段。

## 3. 目标架构

```text
模型请求
  │
  ├─ 受控生成工具（auto：直接提交；manual：创建确认）
  │      ├─ 估价、余额校验、冻结点数、创建任务
  │      ├─ 原子持久化 action / task / plan-step 关联
  │      └─ 写入 task_status(queued) 事件
  │
  ├─ Agent 会话 SSE ─────────────► 前端任务缓存失效 + 画布局部刷新
  │
generation-service 终态回调
  │
  ├─ 写回画布节点产物与任务状态
  ├─ 事务持久化 task_status + plan-step 终态
  ├─ 会话事件流按 event_seq 广播/可重放
  └─ 同一会话 FIFO 续跑器 ───────► 解锁下游视频步骤或输出明确收尾计划
                                      │
                                      └─ reasoning_summary + 工具事件 ─► 思考与计划下拉框
```

关键原则：画布状态以 Canvas / Generation 服务为权威；Agent 只通过 Tool Gateway 发起受控动作；浏览器只做乐观展示与事件驱动的重新拉取，不能自行推断任务成功。

## 4. 接口与数据契约

### 4.1 会话事件流

扩展 `AgentRunEventType`：

- `reasoning_summary`：仅包含结构化、面向用户的摘要，不包含隐藏思维链。
- 现有 `task_status` 覆盖 `queued | running | succeeded | failed | cancelled | expired`。

`reasoning_summary.data`：

```json
{
  "stage": "awaiting_dependency",
  "summary": "关键帧已提交生成；完成后将创建对应的视频片段。",
  "next_action": "等待关键帧任务终态",
  "plan_step_id": "..."
}
```

调整会话事件 API：

- `GET /api/v1/agent/sessions/:sessionId/messages` 返回 `latestEventSeq`。
- 前端完成消息水合后将游标设置为 `latestEventSeq`，只订阅后续事件，避免把历史工具事件错误附着到当前回复。
- `GET /events?afterSeq=n` 使用 `listSessionEvents(sessionId, n)` 重放该会话所有未见事件；存在活跃运行时使用 `subscribeSession` 继续推送；没有活跃运行时，重放后返回 `idle`。
- 事件写入、Outbox 与 HTTP SSE 均以 `eventSeq` 去重；浏览器断线重连不得依赖进程内缓存。

### 4.2 自动提交策略

新增受服务端控制的 `generationExecutionPolicy`，取值 `manual | auto`。该策略必须来自用户/企业/环境授权配置，不能由模型参数决定。

`auto` 路径：

1. 工具读取真实模型目录和画布版本，估算费用并执行既有余额与冻结规则。
2. 创建 `agent_actions`、任务终态关联、可选 `plan_step_tasks` 关联，再调用 Generation 提交。
3. 在同一逻辑单元内持久化 `task_status(queued)`；失败按既有补偿/解冻规则处理。
4. 向 Agent 和前端返回受理结果及任务标识，但用户可见文本不得暴露内部 ID。

`manual` 保留当前确认令牌分支，作为兼容和可回退模式。

### 4.3 计划续跑

新增 `SessionContinuationService`：

- 每个 `session_id` 只有一个 FIFO 续跑租约，避免多任务同一时刻完成时并发唤醒模型。
- 任务终态在数据库事务中更新关联的计划步骤；仅当依赖全部满足时标记下游步骤为 `ready`。
- 续跑输入仅包含已验证的终态摘要、已完成步骤、可执行步骤和当前画布版本；禁止把供应商原始响应当成提示词。
- 若没有可执行下游步骤，生成一次结构化收尾回复与下一步建议；若存在视频步骤，则由 Agent 创建视频节点、建立上游连线并提交下一任务。
- 续跑有幂等键 `run_id + terminal_task_id + plan_version`，可重试但不得重复创建节点或任务。

### 4.4 前端实时同步

在 `AgentPanel` 收到 `task_status` 时：

- 对每个事件触发 `vp-task-updated({ taskId, nodeId })`，使 `['canvas-tasks', canvasId]` 立即失效；任务首次进入 `queued` 即开始轮询。
- 触发合并的 `vp-agent-executed`，由 `CanvasPage` 重新拉取权威画布；事件突发时 250–500ms 去抖，避免每个批量任务刷新一次。
- `queued/running` 更新节点执行状态与任务徽标；`succeeded/failed/cancelled/expired` 更新产物或失败态。
- 收到 `idle` 时执行一次静默会话/画布水合，作为代理、浏览器或网络在终态附近断开的兜底。

### 4.5 思考与计划下拉框

在现有 `AgentTurnTimeline` 旁增加独立 `ThinkingSummaryDisclosure`：

- 默认收起，标题为“思考与计划”或“正在规划”。
- 内容由 `reasoning_summary` 与受控工具事件组合：当前目标、已使用的画布事实、依赖状态、下一步。
- 工具列表仍放在“执行记录”中；思考摘要和工具原始参数分离。
- 禁止展示提供商原始 chain-of-thought、令牌、节点/任务内部 ID、内部模型名称或未脱敏响应。

### 4.6 `/Skill` 命令面板

输入框新增命令解析：

- 输入 `/` 时弹出固定在输入框上方的 Skill 面板，展示图标、名称、简述、分类和可滚动列表。
- `/关键词` 按名称、描述、分类过滤；`↑/↓` 选择，`Enter/Tab` 插入，`Esc` 关闭，鼠标点击同样可选。
- 选中后显示为可移除的 Skill 引用 Chip；提交体新增 `selectedSkillIds`，自然语言正文保留，不把内部 Skill 指令直接拼入用户文本。
- 后端校验用户对 Skill 的访问权，写入会话 Skill 快照并加载对应版本；产生 `skill_loaded` 与 `reasoning_summary` 事件。
- `/` 后无选择直接发送时按普通文本处理，不影响现有 `@` 节点引用、输入法组合事件和移动光标编辑。

## 5. 分阶段实施任务

### Phase 0：契约与迁移准备

- 更新 PRD、工程 Spec 与 `AGENTS.md`：增加 `generationExecutionPolicy`，明确本环境启用 `auto` 的授权边界及计费不变量。
- 盘点 `agent_actions`、`agent_task_terminals`、`agent_plan_step_tasks` 的现有字段；如缺少幂等续跑键或终态投递记录，新增 Flyway migration。
- 建立失败测试：任务在浏览器断线后完成、同一批多个任务乱序完成、重复终态回调、服务重启后事件恢复。

### Phase 1：事件恢复与画布即时状态

涉及文件：

- `pi-main/packages/vibepaper-agent-service/src/api/app.ts`
- `pi-main/packages/vibepaper-agent-service/src/application/run-event-stream.ts`
- `pi-main/packages/vibepaper-agent-service/src/infrastructure/pg-run-repository.ts`
- `vibepaper-web/src/features/canvas/AgentPanel.tsx`
- `vibepaper-web/src/features/canvas/agentEventEnvelope.ts`
- `vibepaper-web/src/features/canvas/agentEventHandlers.ts`
- `vibepaper-web/src/features/canvas/nodes/index.tsx`
- 对应 Vitest / API 测试。

完成标准：不刷新页面即可看到任务 `queued/running`；终态后节点产物、聊天完成消息和画布版本在 2 秒内一致；重连后不会漏消息或重复工具行。

### Phase 2：自动提交与计费安全

涉及文件：

- `pi-main/packages/vibepaper-agent-service/src/tools/generation-tools.ts`
- `pi-main/packages/vibepaper-agent-service/src/application/generation-action-executor.ts`
- `pi-main/packages/vibepaper-agent-service/src/application/*submission*.ts`（新增统一提交服务）
- `pi-main/packages/vibepaper-agent-service/src/api/app.ts`
- 策略配置、OpenAPI、单元和集成测试。

完成标准：`auto` 模式不会生成确认卡；每次提交都有估价、冻结、任务、终态关联和审计；余额不足、估价失败、重复请求、任务提交失败均不会遗留冻结点数。

### Phase 3：计划依赖与任务终态自动续跑

涉及文件：

- `pi-main/packages/vibepaper-agent-service/src/application/plan-execution-service.ts`
- `pi-main/packages/vibepaper-agent-service/src/application/session-continuation-service.ts`（新增）
- `pi-main/packages/vibepaper-agent-service/src/application/task-terminal-service.ts`
- `pi-main/packages/vibepaper-agent-service/src/infrastructure/pg-plan-repository.ts`
- 计划/终态关联 migration 与测试。

完成标准：五张关键帧全部成功后，系统仅续跑一次，创建五个有正确上游连线的视频节点并自动提交；任一关键帧失败时下游步骤被阻塞并给出可操作建议，不盲目生成视频。

### Phase 4：思考摘要与 `/Skill` 交互

涉及文件：

- `pi-main/packages/vibepaper-agent-service/src/application/agent-runtime.ts`
- `pi-main/packages/vibepaper-agent-service/src/domain/agent-run.ts`
- `vibepaper-web/src/features/canvas/AgentExecutionRecord.tsx`
- `vibepaper-web/src/features/canvas/AgentPanel.tsx`
- `vibepaper-web/src/features/canvas/SkillCommandPalette.tsx`（新增）
- `vibepaper-web/src/features/canvas/*test.tsx`。

完成标准：每轮复杂创作可查看结构化思考摘要；原始隐藏推理不出现在网络事件、数据库消息或 UI；`/` 可搜索、键盘选择、插入、移除并成功加载授权 Skill。

## 6. 验收场景

1. 在已有关键帧画布中要求“生成这些关键帧，再创建对应视频片段”。提交后所有目标节点立即显示排队/生成中。
2. 在生成途中不刷新页面；图片完成后自动显示产物、聊天显示任务完成，并自动开始创建视频节点。
3. 在生成途中断开网络或关闭/重开 Agent 面板；恢复后终态消息、图片和视频续跑状态与服务端一致且不重复。
4. 批量任务部分失败：失败节点可见，依赖的视频步骤不执行，思考摘要说明阻塞原因和重试建议。
5. `auto` 模式直接提交，无确认卡；检查点数冻结、成功结算、失败解冻、幂等重复提交和预算拒绝。
6. 输入 `/`：列表出现、筛选、键盘选择 Skill、发送后显示“加载技能”执行记录与思考摘要；普通 `/文案` 不会意外加载未选择 Skill。
7. 审查浏览器 SSE、消息 API、数据库事件和日志，确认没有泄露原始思维链、内部 ID、密钥或供应商原始响应。

## 7. 非目标与风险控制

- 本计划不引入多人实时协作或 WebSocket 画布协同；单用户画布仍使用乐观锁与增量保存。
- 不允许 Agent 绕过 Tool Gateway、直接写 Canvas JSON、直接操作数据库或跳过点数账本。
- 自动续跑限定为持久化计划中已批准的低风险后续步骤；没有计划或依赖不明确时只生成下一步建议。
- 前端事件采用 SSE + 持久化游标恢复，不以高频全画布轮询替代；任务查询只在活跃任务存在时轮询。
