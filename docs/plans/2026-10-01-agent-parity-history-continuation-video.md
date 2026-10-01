# Agent 原代码迁移审查与历史、续跑、视频修复

审查日期：2026-10-01。基线：`feat/desktop-local-migration`，`c6f6b85`；工作区已有其他未提交修改。本次按原实现核查桌面调用链，既有修改不代表本次交付。

## 结论

Agent 确实基于原源码运行，但尚不能认定已完整 1:1 迁移。桌面 Worker 直接调用原 `application/agent-runtime.ts` 的 `runDramaTurn`、`runtime-tools.ts` 的 `createRuntimeTools`，复用原工具 schema、`SessionRunService`、`ApprovalService`、角色“小P”及 Skill loader。原 `CanvasPage` 将本地适配器注入原 `AgentPanel`，没有用平行面板替代。

另有应用层边界偏离：Worker 自身仍承载较多回合编排。复用原运行时和工具并不等于所有应用服务都已原样接通；这些编排应收敛到原 TypeScript 服务的本地适配边界。

## 本次问题

| 问题 | 原因及修复目标 |
| --- | --- |
| 历史全部为“新对话” | 前端以占位标题预建会话，Worker 只在名字为空时自动命名。用首条用户正文前 48 字符命名，对旧占位会话从 JSONL 回填；保留自定义标题。引用 metadata 不进入标题。 |
| 生成后没有 Agent 续跑 | 本地对账只把任务及原 Run 转成终态，缺少原 `/internal/agent/resume` 的任务终态回调 → 新 Agent 回合。全批次终态后按 `task-continuation:<originRun>` 幂等续跑；成功读取画布继续，失败整理影响且不自动重试生成，新增生成仍需系统确认。 |
| 成功视频不能播放 | 原播放器添加 `#t=0.001`，Electron 自定义协议请求会保留片段，本地 task/asset 路由原本要求空片段，导致拒绝合法播放器 URL。允许标准媒体时间片段，保留项目、路径、query、输出序号与 Range 校验，并启用媒体流协议权限。 |

续跑须只调度持久化的待处理请求；不能首次升级就重新执行全部已结束的历史任务。无 Key 时只对账、保留待续跑请求；Key 仅由 Main 从系统凭据读取后传给受控 Worker，不进入会话或 SQLite。重启不得盲重放写工具或已提交任务。

### 控制库 schema 6 数据字典

`desktop_task_continuations` 保存后台续跑意图；完整对话仍以 Pi JSONL 为准。唯一键绑定原 Run，一条批次不会因多项任务或重复通知创建多个续跑请求。

| 字段 | 含义 |
| --- | --- |
| `origin_run_id` | 原生成 Run，主键并引用 `agent_runs`。 |
| `session_id`、`project_id` | 发起会话与授权项目范围；项目副本不得继承原项目续跑授权。 |
| `idempotency_key` | 唯一 `task-continuation:<originRunId>`。 |
| `prompt`、`task_results_json` | 系统续跑指令与批次结果，不冒充用户新消息，不存 API Key。 |
| `status` | `pending`、`claimed`、`completed`、`interrupted` 或 `invalidated`。 |
| `continuation_run_id` | 已领取的唯一后续 Run，引用 `agent_runs`；未领取时为空。 |
| `created_at`、`updated_at` | 创建与最近状态变化时间。 |

项目备份接受 schema 6；恢复副本时重绑定项目身份并将续跑请求失效。正常同项目重启按权威任务和账本恢复，不能重放已开始的写操作。

控制库从旧版升级前，在持有项目 Agent writer lock 时使用 SQLite 在线备份生成 `agent/control-v<旧版本>-<UUID>.pre-migration.sqlite`；验证完整性及原版本后再迁移。升级失败保留旧版快照。它是源项目的本地回滚文件，项目导出备份只包含当前权威控制库，恢复副本不继承源项目的回滚快照。

## 仍有明确差距

| 能力 | 已核实的差距 | 原实现与桌面证据 |
| --- | --- | --- |
| 会话管理 | 本地接口没有原会话重命名、软删除、归档与复制的完整映射；自动标题修复不等于这些能力完成。 | 原 `src/api/app.ts` 的 Session PATCH/DELETE/copy；本地 preload、Worker dispatch 和原面板历史适配。 |
| 持久计划 API | 原服务已注册计划创建、读取、ready-set、rerun，任务回调会完成 plan step；桌面没有等价持久接口。原 AgentPanel 和 Pi 工具回合未发现消费这些 API，所以不能推断所有自然语言计划不可用。按完整后端 API 迁移验收仍为差距。 | 原 `src/api/app.ts` 的计划路由与任务回调、`application/plan-execution-service.ts`、`infrastructure/pg-plan-repository.ts`；桌面桥与 Worker 没有 plan 映射。 |
| Skill 版本绑定 | 桌面只保存已加载 Skill ID，每轮重读当前项目 Skill；原会话附加 Skill 时保存正文及版本快照。编辑 Skill 后旧会话恢复时的版本语义不一致。 | 原 app 的 attach/`resolveSkillContext`；本地 `desktop/skill-context.ts`。 |
| Agent 删除确认 | 原删除工具还未接桌面可撤销或预览确认流程；恢复桌面工具可用性限制，Web 原路径不变。这是待接通的业务能力，不能视为完成迁移。 | 原 `RuntimeToolContext.desktopMode` 的工具可用性规则、`delete_nodes` 与本地确认路由。 |
| 完整验收 | Windows 定向测试不替代逐屏截图/录屏、三个操作系统安装包、本地 Agent 模型、长会话压力及媒体多阶段全链路验收。 | `desktop-ui-parity.md`、`2026-10-01-agent-context-memory-validation.md` 中现有验收边界。 |

明确移除的平台点数、登录、运营功能，以及延期的 Provider Registry，不列为迁移遗漏。原运行时本来没有的工具也不列为遗漏。

## 验证记录

- Main 任务通知边界 6 条通过：先落盘后通知、成功及失败通知、通知失败不改变任务结果、跨项目隔离、凭据读取期间项目切换隔离、取消排队任务触发恢复。
- 用户现有成功 MP4 只读检查通过：SHA-256 与 TaskStore 一致，H.264 High/avc1、yuv420p、960×960、5.17 秒；ffmpeg 全量解码无错误。
- 真实 Electron 播放 A/B 验证：原路由返回 404，播放器错误码 4；修复后的实际 Main handler 返回 206、`video/mp4` 及正确 Content-Range，触发 `loadedmetadata`/`playing`，时长 5.166667 秒，播放时间推进到 0.21672 秒，`readyState=4`。只读取已有产物，没有重新生成。
- `node --test --test-isolation=none` 的 asset-operations、agent-task-notification、agent-session-fragment-backup：41 条通过，0 失败，包括 task/asset 时间片段 + Range、非法 query/hash 拒绝、schema 5→6 升级快照、备份恢复身份变更及续跑失效。
- Worker 编排回归 5 条通过：重复通知去重、Key/项目切换、启动错误去重、完整回合续跑和新生成仍须确认。加载原服务、工具与 Gateway，模型回合使用测试替身，单独不计为真实模型验收。
- 使用用户新配置且系统加密保存的真实 Agnes Key，在隔离本地项目调用原 Agent runtime。首轮确认后任务 `queued → running → succeeded`，唯一续跑 Run 达到 `completed`；恢复后事件数量稳定，重复确认仍只有 1 项任务，历史标题来自用户正文，返回历史不含 Key。图片结果使用已存在的真实 PNG 测试产物，此次额外付费图片请求为 0；因此证明真实 Agent 续跑，不代表新图片/视频供应商生成已重新验收。
- 首次真实续跑发现合成 assistant 进度消息缺少 Pi `usage`，导致读取 `totalTokens` 报错。进度改为原 Run 事件，旧格式进度从模型输入隔离，保留完整 JSONL；合法模型消息仍保留。
- 真实验证结果保存在本机 `.test-temp/live-agent-continuation-result.json`，测试项目 `.test-temp/live-agent-VI16Vq/Agent live migration validation`；临时脚本与完整对话不提交。
- Pi 完整 `npm run check` 通过：Biome、固定依赖、TS 相对导入、shrinkwrap/install-lock、全仓类型与 browser smoke。检查器对本批次外文件的格式变更按运行前快照恢复，保留已有未提交工作。修复了检查暴露的既有联合类型、测试类型断言及 erasable syntax 问题；相关定向测试通过。
- 最终 Worker 构建与 `smoke:agent` 通过，原项目 Skill 与会话片段在重启后可保存/导入。构建仍有原 Pi 的 CJS `import.meta`（Bedrock/OAuth）和图像注册 sideEffects 警告；当前 Agnes 文本链路已实测，其他提供方不因此视为验证通过。
- 视频修复已提交并推送：`6397a85`。本次标题、续跑及审查文档另作提交；暂存不包含此前其他批次的未提交修改。

## 会话历史顺序回归追查

用户反馈重新打开“猫抓老鼠”会话后，回复重复且执行记录集中在历史末尾。只读核对实际本地 JSONL：2 条用户消息、11 条含正文的 Pi assistant 消息、2 个 Run、3056 条执行事件；中间发言、工具调用与最终答复在原文件中有明确交错顺序，原始记录未损坏。

恢复路径先加载全部持久化正文，再重放 Run 事件。旧正文没有 Run 关联，重放时另建 assistant 行并追加到列表末尾。仅按全文相同去重也无法处理流式前缀、同一 Run 的多段发言，且可能误合并不同回合的合法重复输入。

修复须在原组件及本地适配边界恢复 Run 关联：新消息持久化关联，旧消息依据活动分支中的事件位置及本地 Run 记录进行只读推断；不改写旧 JSONL。渲染按回合组装原时间线，保留发言、推理和工具的交错关系，避免把中间发言和最终回复重复渲染；重复加载及缓存恢复须幂等。

同段会话的真实模型目录三次返回均正确：文本、图像、视频、音频和合成的模型类型及模态没有串位。失败的单项生成调用使用了缺少字母的 `agen-image-2.5-flash`，而目录名称为 `agnes-image-2.5-flash`。本地 Gateway 原先把不存在的名称统一报为 `MODEL_UNAVAILABLE`，导致 Agent 将拼写错误解释成服务故障。桌面工具须精确使用目录名称，并分别说明名称不存在、已禁用和模态不匹配，不自动猜测或替换付费模型。

本批验证结果：

- 只读真实会话回放：3056 条事件恢复为 2 个用户/Agent 回合，11 段发言及 11 段推理顺序完整，原 `AgentTurnTimeline` 可渲染；冷启动与缓存重载保持一致，React 步骤标识稳定且唯一。原 JSONL SHA-256 前后不变，没有修改用户项目或新增付费媒体请求。
- 原前端事件与恢复定向测试 28 条通过；原 TS 会话、引用、片段、标题、目录与工具测试 54 条通过；桌面目录和 Worker 续跑回归 12 条通过。
- Pi 完整 `npm run check` 通过。检查期间的非本批格式变动恢复到运行前字节；前端 TypeScript/Vite 构建、Worker 构建和无付费 smoke 通过。现有 Vite 大包/动态导入及 Pi CJS 提供方构建警告仍存在，本批不扩大提供方验收范围。
- 检查发现既有删除工具测试仍误认桌面删除已接通；改为核验桌面当前限制及原 Web 删除工具/命令保留，未启用未完成确认的删除流程。上方删除确认迁移差距仍有效。
