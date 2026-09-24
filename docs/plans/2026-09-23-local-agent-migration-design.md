# VibePaper Agent 本地化迁移与记忆/压缩设计

> 状态：Agent 本地 JSONL/SQLite/Markdown 存储与项目备份/恢复原型已实现。Electron Main 为活动项目启动独立 Agent Worker，切换项目、备份和退出前关闭该 Worker；桌面会话面板已接入本地会话列表、创建和选择。会话选择目前只管理会话索引，尚未读取消息或恢复对话；Pi 模型回合、Tool Gateway、长期记忆检索与压缩仍未接入，也未做端到端验证，因此桌面 Agent 还不能对话。备份会先停掉本应用 Worker；若其他进程持有项目写锁，备份明确失败。日期：2026-09-24。配套功能契约见 [桌面版 Agent 功能规格](../specs/desktop-agent-functional-spec.md)，全服务实施顺序见 [桌面本地化方案](2026-09-23-desktop-full-service-local-migration-plan.md)。目标是单用户、项目数据与 Agent 数据均由本机文件持有，正常创作不依赖云端账户、平台点数、签到、套餐或企业服务。桌面版以根目录 `AGENTS.md` 为工程契约；旧 PRD 和 V1.0 Spec 仍描述 Web 多用户架构。

当前原型位于 `pi-main/packages/vibepaper-agent-service/src/desktop/`。`openDesktopAgentStores(projectDirectory)` 校验项目目录并取得单写者锁；会话适配器使用 Pi `JsonlSessionRepo` 写入完整消息并从分支/压缩记录恢复上下文；控制库实现现有 `RunRepository` 接口、单会话活动 Run 唯一约束、事件序号、写操作意图/结果状态，以及可按 outbox ID 在 JSONL 中去重补投的事件镜像。SQLite 控制库当前 `user_version = 1`。Electron 项目备份清单 schema v2 已包含 JSONL、控制数据库、Markdown、检查点和压缩工具结果；恢复前验证内容哈希，恢复副本会生成新 `projectId`、更新会话头部与目录、终止未完成 Run 并失效待处理确认。Agent 存储 schema 自身的升级回退仍需补齐。

## 1. 结论和边界

采用 **Pi Agent Core 内存运行态 + 本地 JSONL 完整会话 + 本地 SQLite 控制账本 + 可编辑 Markdown 长期记忆 + 可重建压缩检查点**。不用 Redis、Nacos、Agent 专用 PostgreSQL。内存是加速层，不是恢复依据；JSONL 保留完整消息与工具调用/结果，压缩只改变下一次发给模型的上下文视图。

本方案不允许 Agent 直接修改画布文件，也不让会话摘要代表画布或生成任务的真实状态。Tool Gateway 仍是唯一副作用入口，画布、素材和任务的权威存储也必须在本地。首版同时支持本地模型与用户配置 API Key 的云端模型，默认本地模式不发外部模型请求；云端模式须由用户显式配置和选择，清楚展示将发送的文本/图片/视频、供应商和可能产生的供应商费用，不得把云端调用表述为“所有数据只在本地处理”。联网模式也不得恢复平台点数、充值、套餐或云端会话存储。

## 2. 当前基线与需修的问题

| 观察 | 已确认代码位置 | 迁移含义 |
| --- | --- | --- |
| 启动强制要求 Agent PostgreSQL，Redis 用于当日记忆和异步候选队列，且注册 Nacos | `pi-main/packages/vibepaper-agent-service/src/server.ts` | 新增 desktop bootstrap，不在旧入口上堆条件分支 |
| 跨轮先读最近 48 条 `agent_messages`，只把 user/assistant 文本重建成 Pi `initialMessages` | `src/api/app.ts` 的 `readHistory`；`src/application/agent-runtime.ts` 的 `runDramaTurn` | 完整工具调用/结果未作为 Pi 消息跨轮恢复；必须更换 history 入口 |
| 当前“压缩”按固定 24k 预算倒序选单条消息；所谓摘要主要是 `SessionContext` 文本 | `src/application/context-compaction-service.ts` | 改为全请求预算、完整轮次切分、真正的覆盖摘要 |
| Run、事件序号、幂等、确认和会话状态已有领域/应用接口，但多处生产实例由 PG 类直接构建 | `src/application/session-run-service.ts`、`src/api/app.ts`、`src/infrastructure/pg-run-repository.ts` | 保留状态机和领域规则，抽离存储工厂及桌面适配器 |
| Pi Agent Core 在内存执行；上游 Pi harness 另有 `JsonlSessionRepo`、会话 context builder 与 compaction entry | `pi-main/packages/agent/src/harness/session/` | 可复用接口和格式，但当前 VibePaper 未接入；先做兼容性原型，不等同于切换 import 即完成 |

`SessionContext.compactedToEventSeq` 当前实际上是状态投影进度，不应兼任“历史已摘要到哪里”。`extractProtectedFacts` 还会从自由文本正则提取“受保护事实”；新实现只允许经 Tool Gateway、任务/确认账本核验的事实提升为权威上下文。

### 2.1 Agent 模块的云端功能迁移清单

| 现有 Agent 关联能力 | 桌面版目标 | 当前主要落点 |
| --- | --- | --- |
| `user_id`、企业头、租户记忆与管理员权限 | 单机项目/画布身份；不提供企业作用域或云端角色授权 | `src/api/app.ts` 的会话/记忆路由 |
| `points_used_total`、`estimatedCost`、`INSUFFICIENT_POINTS` 与按点数确认 | 不进入桌面版运行契约；保留 Token/运行时长统计，确认只依据操作风险与显式联网授权 | `src/api/app.ts`、`src/application/approval-service.ts`、`src/tools/runtime-tools.ts` |
| `billingBaseUrl`、`identityBaseUrl`、Nacos、Redis 队列 | 桌面 bootstrap 不注入这些服务；旧版 server bootstrap 在迁移期保留，不能作为桌面版必需依赖 | `src/config.ts`、`src/server.ts` |
| 远程模型目录、远程生成任务关联 | 本地 TaskStore 和统一模型能力目录；首版支持本机模型及用户显式配置的云端 API，缺少本地模型时报告不可用，不静默联网 | Agent Tool Gateway、后续本地生成模块 |
| `enterprise` 记忆与共享 Skill | 仅全局本机、项目/画布、会话作用域；Skill 为本地文件 | `src/application/memory-service.ts`、Skill 装配入口 |

上表描述桌面路径需要**替换/下线的能力**，不是要求现在删除旧版代码或数据库列。桌面版不迁移旧 Web Agent 历史或点数账本；只保证桌面版新建数据的升级、备份和恢复。Agent 模块以外的签到、套餐、邀请、企业和运营页面按全服务方案处理。

## 3. 目标进程与模块

```text
桌面 Renderer（React，不持有磁盘权限/密钥）
    ⇅ 受限 IPC 或随机本地端口 + 一次性授权
桌面 Main（生命周期、文件选择、密钥保险箱、更新/备份）
    └─ Agent Worker（Node.js + TypeScript + Pi Agent Core）
        ├─ TurnOrchestrator / ContextAssembler / Compactor
        ├─ SessionStore：Pi JSONL，会话完整原文
        ├─ ControlStore：SQLite，run/操作账本/确认/候选记忆/索引
        ├─ MemoryStore：Markdown 正文 + SQLite 可重建索引
        └─ Tool Gateway：LocalCanvasPort / LocalAssetPort / LocalTaskPort / LocalModelPort
```

首版建议 Electron 宿主，因为现有 React 与 Node/Pi 复用最多；Electron 主进程只负责宿主能力，Agent 在独立 worker/utility process 中运行，崩溃不带走 UI。Renderer 启用隔离与沙箱，只暴露窄 IPC；绝不提供任意文件读写或通用 HTTP 代理。保留现有 `/api/v1` DTO 和错误码作为兼容层，但鉴权从网关用户头改为桌面用户配置与能力边界；若使用本地 HTTP，仅绑定 loopback、随机端口和每次启动生成的令牌。

不要以“把 Java 服务的数据库改成 SQLite”假装全产品已经迁移。Agent 应只面向 `LocalToolGateway` 契约；画布、素材、生成任务由后续模块提供本地实现或同机 sidecar，均以本地项目数据为权威。当前 REST 适配器只可用于开发和旧数据导入，不属于桌面版正常运行依赖。桌面版不调用 `billing-service`、`identity-service`、企业和运营服务；模型偏好属于本机设置，Token/运行时长统计仅用于用户理解资源消耗，不是平台计费。

## 4. 磁盘布局和权威性

应用配置放操作系统用户数据目录；大文件放用户选择的项目目录。会话以稳定 `projectId` 关联项目，目录移动不能改变身份。示意：

```text
<userData>/VibePaper/
  settings.json                 # 非密钥设置；密钥交给 OS 凭据库
  catalog.sqlite                # 项目/会话目录索引，可重建
  memory/MEMORY.md              # 全局记忆索引
  memory/topics/*.md            # 跨项目明确偏好
  skills/*.md                    # 用户级本地 Skill

<project>/.vibepaper/
  project.json                  # schemaVersion, projectId, canvasId
  agent/control.sqlite          # run、操作幂等、确认、任务关联、记忆候选
  agent/sessions/<id>/session.jsonl
  agent/sessions/<id>/checkpoint.json
  agent/sessions/<id>/tool-results/<sha256>.json.zst
  agent/session-memory/<id>/memory.md
  agent/memory/MEMORY.md
  agent/memory/topics/*.md
  agent/skills/*.md              # 项目级本地 Skill
```

| 数据 | 权威来源 | 可否重建 |
| --- | --- | --- |
| 用户/助手/Pi tool-call/tool-result 完整历史 | `session.jsonl` | 不可丢；压缩不删原文 |
| Run 状态、幂等键、确认状态、外部 operationId、任务关联 | `control.sqlite` 事务账本 | 不可仅凭 LLM 摘要重建 |
| 当前画布图、节点、连线与版本 | 本地 CanvasStore | Agent 只读快照；不能以 JSONL 替代 |
| 素材、生成任务与本地模型输出 | 本地 AssetStore/TaskStore 与项目文件 | 由本地业务端核验，不由会话摘要证明 |
| 已接受的用户/项目长期偏好 | `memory/*.md` | 索引可重建，正文不可丢 |
| 压缩摘要、最近轮次边界、检索索引 | 检查点与索引 | 可从原文重新生成/校验 |

JSONL 的“本地文件”与 SQLite 的“本地磁盘”并不冲突：前者适合追加会话历史，后者适合唯一约束、状态转换和原子幂等。大工具结果可按内容哈希单独保存；此时“完整会话”是 JSONL 与其引用的本地结果文件的组合，不代表所有字节都内联在一行 JSONL。单进程单写者是首版前提；每项目互斥锁防止两个桌面实例同时写入。SQLite 使用 WAL，备份必须走一致性备份流程，不能运行中仅复制 `.sqlite` 主文件。记录文件和快照采用同目录临时文件、flush、原子替换；验收时加入突然断电/尾部半行故障注入。Pi `JsonlSessionRepo` 的接口描述了 writer claim，但本仓库实现的 `open()` 只加载文件，没有跨进程文件锁；锁须由桌面宿主另行保证。

本地控制库最少有 `runs(session_id, idempotency_key, status, updated_at)`、`run_events(session_id, seq, run_id, type, payload_ref)`、`operations(operation_id, run_id, tool_call_id, effect, input_hash, canvas_version, idempotency_key, state, external_ref)`、`approvals(...)`、`task_links(...)`、`memory_candidates(...)`、`outbox(...)`。关键唯一约束是 `(session_id,idempotency_key)`、`(session_id,seq)`、`operation_id`、`tool_call_id` 和同一会话至多一个活动 Run；以事务条件更新实现状态迁移。不要把 JSONL 里的文本正则扫描结果写入这些表的“成功”字段。

## 5. 短期记忆：每轮怎样继续

短期记忆分三个层次：Pi Agent 的运行中消息缓存、磁盘完整会话、可重建的会话工作状态。缓存命中时可直接延续 Pi 消息；进程重启或模型切换时从 JSONL 加载同一条活动分支。两条路径必须产生等价的模型输入，避免“热会话能记住、重启后失忆”。

每轮顺序：

1. 在控制账本事务中创建/找到同幂等键的 Run 和用户输入待写记录，再把用户原文、被引用节点的稳定 ID/画布版本追加到 JSONL；**确认追加成功后**才能调用模型。中断时由 outbox 补写未完成记录。
2. 恢复上次有效 compaction entry、其后的完整 Pi 消息（包含 assistant 的 tool-call 和配对 tool-result）、本轮用户输入；不能先截断到 48 条才压缩。
3. 从控制账本投影 `workState`：当前目标与约束、已确认映射、未完成计划、待确认动作、进行中任务、最近相关节点引用。用户换目标时更新活动目标，不让首轮 goal 永久占位。
4. 按画布版本获取相关节点/连线的当前快照；过期快照重新读取。关键事实带 `source`、`sourceSeq`、`canvasVersion` 和 `observedAt`。
5. 装配 system/工具清单/Skill/长期记忆/工作状态/历史/当前用户请求，做预算与必要压缩，然后才调用模型。
6. Pi 的 `message_end` 和 `tool_execution_end` 应保存完整结构及 `toolCallId`；UI 流式 `assistant_delta` 与审计事件可另建投影，不替代 Pi 原文。Pi 的异步订阅器会被等待：利用 `message_end` 在工具执行前持久化含 tool-call 的 assistant 消息，扩展既有 `beforeToolCall` 白名单钩子写入操作意图，随后才放行 Tool Gateway。`toolResult` 的 `message_end` 持久化结果；执行结果先可靠落盘，再向 UI 宣称完成。

建议先定义端口而非修改领域规则：

```ts
interface LocalAgentStores {
  sessions: {
    appendMessage(sessionId: string, message: AgentMessage): Promise<string>;
    buildContext(sessionId: string): Promise<AgentMessage[]>;
    appendCompaction(sessionId: string, checkpoint: CompactionRecord): Promise<void>;
  };
  runs: RunRepository;                // 延续现有状态机接口
  context: SessionContextRepository;  // 投影缓存，可从事件重建
  memory: MemoryRepository;
  candidates: MemoryCandidateRepository;
  operations: OperationLedger;        // 新增副作用意图/结果账本
  tools: ToolGateway;                 // 唯一业务副作用入口
}
```

类型是目标契约示意，不是当前已存在的 TypeScript API。`JsonlSessionRepo` 可承载 `sessions` 的消息和 compaction，但仍需实现 Pi `FileSystem` 适配、项目目录映射、结果文件引用和业务账本；不要把 Pi 的内存 Agent state 直接 JSON 序列化作为持久化协议。

画布连线决策属于临时、可核验的创作依赖：保存每个目标节点所需来源、角色、模式、最大输入数以及用户明确的一对一映射；实际创建前由 Tool Gateway 检查节点能力、模型模式、顺序和画布版本。不明确时提问，不根据空间相邻推断，也不把三张图与三个视频默认做笛卡尔积。

## 6. 长期记忆：写入和读取

保留四个明确作用域：`session-memory` 仅帮助本会话跨压缩连续；`project/canvas` 保存长期风格与创作规范；`global` 保存用户明确的偏好；`daily` 是短期便签，过期即删。桌面版没有 `enterprise` 作用域。画布节点存在性、生成终态和确认权限永远不写成长期记忆。

`MEMORY.md` 只列主题文件名称、简短说明和更新时间，正文分主题 Markdown/YAML frontmatter，元数据含 `scope`、`sourceSession`、`sourceEventSeq`、`confidence`、`createdAt`、`expiresAt`、`status`。用户明确“以后都按这个风格”可自动接受非敏感偏好；从对话推断的习惯先入候选队列，去重后由用户确认。密钥、支付信息和第三方隐私默认拒绝。Markdown 中的文字按低信任资料进入上下文，不可覆盖系统、当前用户指令或工具权限。

每轮先加载小索引，再按当前任务、作用域和时间过滤检索少量主题文件；首版词法/中文字符片段检索即可，召回不足时再评估向量检索，不以向量数据库为前置条件。长期记忆冲突时保留历史和来源，以较新的用户明确指令优先；提供查看、编辑、删除、导出。Memory 索引与候选状态可放 SQLite，Markdown 正文为权威。

## 7. 上下文压缩协议

压缩只生成“本次模型输入视图”，绝不改写 JSONL 原文。借鉴 S8 的大结果落盘、旧结果占位和摘要，以及 Pi 的 compaction entry；但不能直接照搬教学版“裁中间消息”或固定字符阈值。S9 的长期记忆与 session-memory 是两套不同生命周期；S20 的装配顺序说明压缩、记忆、Skill 应在模型调用前汇合。

**完整预算**：`模型实际窗口 - 最大输出预留 - 安全余量 - system - tools - Skill - 当前请求 - 工作状态 - 检索记忆 = 历史预算`。固定 24k 可设为成本上限，不可当作防超窗证明。按供应商真实 token usage 校正估算；分别监控输入、输出、缓存命中与压缩费用。

**按成本递增处理**：

1. 单条大工具结果先保存到 hash 文件并在 JSONL 记录引用，模型输入保留结构化摘要与可回查引用；敏感数据不进入普通日志。
2. 旧、已被状态投影吸收的工具观察替换为短占位；当前轮还要消费的分镜正文/节点快照保持原样。tool-call 与 tool-result 必须一起保留或一起以有效摘要替代。
3. 仍超预算时，在**完整用户轮次**边界摘要旧历史：当前目标、用户硬约束、已确认决策、证据位置、失败及待续事项。摘要中的“已完成”必须由成功工具事件和当前业务状态支持。
4. 压后重注入相关的当前画布事实、未完成任务、待确认动作与已加载 Skill 版本快照；预算不足则按相关性选择，不能悄悄丢掉用户显式映射。

检查点至少包含 `schemaVersion, sessionId, branchId, throughEntryId/seq, firstKeptEntryId, sourceHash, summary, workStateVersion, modelId, tokenizerVersion, createdAt`。状态投影游标 `projectedThroughEventSeq`、摘要覆盖游标 `summarizedThroughEntrySeq` 分开。采用 Pi harness 时，**JSONL 中的 compaction entry 是压缩历史的权威记录**，`checkpoint.json` 只是快速加载缓存：先可靠追加 entry，再原子更新缓存和目录索引；缓存失配就从 JSONL 重建，失败沿用上一有效 entry。Pi harness 的 `JsonlSessionRepo` 已支持 compaction entry 和恢复；但其读盘会解析整份 JSONL、且 VibePaper 的会话/业务事件模型不同，接入前须用原型验证格式、性能、并发写者与恢复语义，不应直接替换 `PgRunRepository`。

触发策略包括：模型调用前接近预算时主动压缩，工具结果大于单项/总预算时即时落盘，同一轮工具不断累积时使用 Pi `transformContext` 缩减视图；模型返回 context-overflow 时只重试**未成功的推理请求**一次，更严格压缩，不重放已成功的写画布或提交生成。再失败就保存原始会话和 Run 状态，明确提示用户。

## 8. 断点续跑与副作用

本地断点恢复分三类，不能简单等同于“把上次 messages 再送给模型”：

| 中断点 | 恢复规则 |
| --- | --- |
| 模型调用前/生成文本中 | 原文与检查点恢复后，可重新调用模型；已展示的部分回复标记为未完成 |
| 只读工具前后 | 可重读，但按画布版本/时间判定旧结果是否过期 |
| 写画布、提交本地生成、覆盖/删除素材等副作用前后 | 先把 `operationId`、幂等键、目标/参数哈希和预期版本写入 SQLite；重启先查询本地业务账本是否已完成，再决定补全事件、等待、澄清或安全重试；绝不盲重放 |

SQLite 事务账本负责 `run` 唯一活动约束、单会话事件序号、操作意图和结果；JSONL 持久化 Pi 消息。跨 SQLite/JSONL 无共享事务时使用本地 outbox：先写事务结果和待追加事件，随后追加 JSONL，最后标记投递；重启补投并按 `operationId`/`toolCallId` 去重。对结果不确定且本地业务端无法核验的操作进入 `needs_reconciliation`，让用户查看本地画布/任务状态后决定，不能自动重试。

副作用 operation 状态建议为 `prepared → dispatched → succeeded | failed | uncertain`。执行前 `prepared` 必须落盘；本地业务端应接受稳定幂等键并返回可查询的操作或任务标识。只有本地权威结果可驱动 `succeeded`，进程崩溃或超时只进入 `uncertain`。恢复扫描 `prepared/dispatched/uncertain`，先查本地结果，不直接调用模型“猜测下一步”。对于已成功但 Pi tool-result 尚未写入 JSONL 的操作，outbox 补一个带原 `toolCallId` 的结果，不能再次执行工具。

后台生成不靠重放模型继续：保留本地 task ID、关联节点与期望输出；启动时读取本地 TaskStore 和子进程状态，只有成功产物落盘并核验后更新画布与会话。本地模型不可用时显示 `waiting_model` 或失败，不自动切换到云端。确认令牌恢复时仍检查当前画布版本、操作摘要和过期时间；本地文件中的确认摘要不构成新的授权。

## 9. 迁移实现清单

| 阶段 | 核心改动 | 验收门槛 |
| --- | --- | --- |
| 0. 基线和契约 | 以配套桌面版 Agent 功能规格固定 10 镜头跨轮、3 对 3 一对一、50+ 轮、失败任务、删除/覆盖安全保护场景；按新 `AGENTS.md` 固定桌面确认规则与本地/云端模型边界 | 新空白项目和用例可复现，未改旧版 Web 运行路径 |
| 1. 存储端口 | 从 `createApp` 拆出 `AgentRuntimeDeps`：`SessionStore`、`RunRepository`、`ContextRepository`、`MemoryStore`、`ApprovalStore`、`TaskAssociationStore`、`ToolGateway`；引入 desktop bootstrap；server bootstrap 保持不变 | Agent 独立测试无需 PG/Redis/Nacos，原服务测试仍通过 |
| 2. 完整会话 | 适配 Pi harness JSONL 或实现等价 `LocalSessionStore`；记录完整 Pi 消息与工具调用/结果；建立本地会话目录/SQLite 索引 | 热会话与重启恢复产生等价上下文，48 条以前可回查 |
| 3. 本地控制账本 | Run、确认、计划、任务关联、事件流、候选记忆改为 SQLite 适配器；Redis daily 改文件/SQLite TTL；单写者锁与 outbox | 用本地业务端测试替身验证幂等和事件序号；真实画布/任务崩溃注入在阶段 5 复验 |
| 4. 压缩与记忆 | ContextAssembler、工具结果落盘、分层压缩、双游标检查点、Markdown 长期记忆与候选审阅 | 50+ 轮、一次压缩、重启后仍识别正确分镜/连线；原文未丢 |
| 5. 桌面宿主与集成 | Agent worker 生命周期、受限 IPC、项目搬迁、备份恢复、桌面项目自身升级；Tool Gateway 对接本地画布、素材、任务和本地/云端模型端口 | 真实业务端崩溃注入后不重复写画布/提交任务；Agent 无基础设施启动，云端 API 仅在显式选择时调用 |

**旧 Web 数据不迁移。** 桌面版从空白项目和新 JSONL 会话开始，旧 PostgreSQL 的 `agent_sessions/agent_messages/agent_run_events` 不转换为 Pi 历史，也不承诺补齐旧会话缺失的完整工具调用。桌面版自身每次格式升级须先备份，迁移 `control.sqlite`、JSONL/检查点及 Markdown 文件并校验引用；失败恢复升级前版本。旧 Web 数据库不由桌面安装程序读取或修改。

## 10. 必测故障和交付标准

- 同一会话完成“先编剧本分镜 → 下一轮按分镜生成画面”，跨 50+ 消息、压缩和进程重启后仍读取正确文本节点；若版本变化，重新核验画布。
- 三个分镜各连一个视频节点，严格按创作依赖和模型 `inputMode` 创建 1:1 连线；角色/来源不明就澄清，无 3×3 连线。
- 在“工具实际成功但 JSONL 追加前”“本地生成任务创建成功但响应丢失”“检查点写了一半”“JSONL 尾行损坏”分别终止进程，恢复后不重复副作用、不丢已确认事实。
- 断网/本地模型不可用/模型超窗/记忆文件被用户修改/项目目录被移动/两个实例同时打开均有明确、可见的恢复或拒绝路径；断网不阻止默认本地创作。
- 本地生成任务使用真实幂等与终态查询；删除/覆盖具备可撤销或明确确认机制，大批量写入按新桌面规格确认，内部 ID 不出现在面向用户的 Agent 回复中。桌面版没有点数、充值或套餐流程。

本文是静态源码分析加方案设计；尚未执行迁移、桌面打包或故障注入测试。Learn-claude-code 的 S8/S9/S20 和其中 CC 源码解读用于设计启发，不视为已经核验的 Claude Code 当前运行行为。

桌面迁移实现进展（2026-09-23）：`pi-main/packages/vibepaper-agent-service/src/desktop/` 已加入存储适配原型：项目级 Agent 写者锁、Pi JSONL 会话读写、`control.sqlite` 的 Run/操作/outbox 持久化与 SQLite outbox 到 JSONL 的补投。`SessionRunService` 支持可选的原子终态接口；该 SQLite 适配器把 Run 终态、事件序号、事件记录和 outbox 放在同一事务中，避免“状态已结束但终态事件/outbox 尚未写入”的崩溃窗口。JSONL 会话目录使用 `projectId` 派生的稳定 CWD 键，项目目录移动后仍可按同一项目身份枚举历史会话；真实项目根目录仅作为 Pi 文件操作执行环境，不写入会话 CWD。该原型还没有接入 `AgentRuntimeDeps`、Electron Worker、Local Tool Gateway、Approval/Memory/Task 端口，也未完成控制库与项目备份集成；不能视为阶段 1–5 已验收。

桌面项目核心已另加本地 TaskStore（`vibepaper-desktop/src/project-store.cjs`，project schema v3），含幂等创建、queued 领取、进程重开转 `interrupted`、事件流水和结果文件 SHA-256 核验；成功任务输出纳入项目备份清单。Agent 的 SQLite `task_links` 仍未与此 TaskStore 对接；Worker 必须先按本地权威任务状态核对恢复结果，再决定是否续跑，禁止盲目重放生成。
