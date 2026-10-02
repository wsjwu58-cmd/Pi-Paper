# 2026-10-01 Agent 会话、计划、Skill 快照与删除确认

后续计划执行接通及控制库 v8 的变更和验证见 [2026-10-02 计划执行记录](2026-10-02-agent-plan-execution-validation.md)。下文保留 v7 批次完成时的范围，不能用其中“执行未接通”的记录代表后续批次状态。

## 实现范围

在原 Agent TypeScript、原 `AgentPanel` 和原历史页上接本地适配。Worker 负责调用和进程生命周期，计划校验、步骤状态、Skill 正文快照、删除授权与画布命令仍由 TypeScript 服务负责。保留 Web 原路径；本批不使用平行 Agent 界面。

| 能力 | 桌面实现及原版语义 |
| --- | --- |
| 会话管理 | 获取、改名、归档/恢复、软删除、复制和状态筛选。复制创建空白会话，默认标题为“原标题 副本”，不复制历史、Skill 或运行任务。归档/删除中止当前运行并失效待确认与续跑授权；删除会话不可再读取或启动。JSONL 留存用于恢复，不物理删除用户内容。 |
| 持久计划 | 原四接口 create/get/ready-set/rerun 经 API adapter → Preload → Main → Worker → TS SQLite repository。复用 `PlanCompiler`、依赖编译与步骤状态函数；版本 CAS、租约、任务关联、幂等终态与局部重跑持久化。创建计划只保存与编译，不自动执行；原 `PlanExecutionService` 也没有生产调用点，不新增自动执行入口。 |
| Skill 版本快照 | 原 PUT 会话 Skill 列表与 attach 接口保存正文、版本及 SHA-256。重复 attach 保留旧版本；PUT 显式替换所选快照并清空已加载状态。运行仍按原版检查当前 Skill 可用/启用状态，已删除/停用 Skill 的旧快照只保留历史，不恢复其执行权限。复制不继承快照。 |
| 删除确认 | 原 `delete_nodes` 在桌面提出持久确认，预览节点名称、关联连线、下游、分组及堆叠影响。确认绑定项目、会话、画布版本、动作内容、签名和有效期；确认后经原 `CanvasCommandService` 与受限 Gateway 删除。取消/过期/版本变化在派发前拒绝；重启不重放未核实的删除。复用原确认卡，不再弹第二次系统对话框。 |

原分组/堆叠中被删节点的 ID 成员按现有原领域语义保留；预览明确计入这些影响。批量删除沿既有逐节点命令执行，派发后发生错误可能已有已删除前缀，因此标为“结果待核验”，不宣称画布未改变或整批成功。

## 本地数据字典

Agent 控制库 `control.sqlite` 的 `user_version` 从 6 升到 **7**，升级前仍生成可核验的原库快照；与项目主数据库 schema 相互独立。

| 表/字段 | 用途与边界 |
| --- | --- |
| `desktop_agent_session_state(session_id,status,updated_at)` | active/archived/deleted；默认旧会话 active。项目身份由所在项目及 JSONL 头绑定。 |
| `desktop_agent_skill_snapshots(session_id,snapshots_json,updated_at)` | 正文、来源、版本、内容哈希；完整快照随项目备份。已加载 ID 仍保存在原 `agent_session_skill_state`。 |
| `agent_plans(plan_id,session_id,version,canvas_version,status,plan_json,created_at,updated_at)` | 计划权威状态及版本。操作核验当前项目和会话归属；归档可读，删除不可读，归档/删除不得新建或领取步骤。 |
| `agent_plan_steps(plan_id,step_id,status,task_id,idempotency_key,step_json)` | 复合主键、唯一任务关联、外键级联与步骤幂等。关联任务的租约过期不导致重复提交。 |
| 原 `approvals` / `run_events` / `outbox` | 删除动作复用签名授权和事件落盘；不新增独立授权表。`confirmation_required.data.kind=canvas_delete`，生成仍为 generation。 |

Main 从 TaskStore 读取任务终态并验证本地输出，随后同步已关联的计划步骤；成功只接受已核验的 `vibe://app/tasks/{taskId}/output`，缺失输出不能记成功。当前没有生产调用方领取计划步骤或关联生成任务，因此这条对账只作用于已有持久任务关联，不代表自动计划执行已接通。桌面 DTO 删除原计划点数估算字段；内部复用的编译函数仍接零值，不启用冻结/结算。

备份恢复接受控制库 v1–v7。恢复副本重新绑定项目身份，保留会话状态、快照及计划；原待确认和续跑授权失效，活动 Run 中止。不会因打开计划、恢复历史或读取 ready-set 自动派发写操作。

## 验证与未完成门槛

2026-10-02 收尾验证：

- 原 Agent TS 定向测试：9 个文件、45 项通过，覆盖删除确认、计划仓储、会话管理、Skill 快照、旧库升级、授权、片段和标题恢复。
- 原前端定向测试：5 个文件、41 项通过，覆盖本地 API、确认卡事件恢复、去重及版本失效。
- 桌面定向测试：4 个文件、12 项通过；实际 Worker 加载原 TS，使用真实 JSONL/SQLite 测试改名、归档、空副本、删除、旧版 Skill 和四个计划接口，重启后再读；另用真实项目备份恢复验证 schema 7、项目身份重绑与越权拒绝。归档会话不能新建运行或请求模型。
- 隔离 Electron 原面板实测：改名、归档、恢复、复制、取消删除、确认删除均通过；从 Preload 读取最终权威状态核对两条会话变为一条。管理操作错误在原面板当前页可见。
- Pi 完整 `npm run check`、原前端生产构建及 `test:agent-runtime` 均通过。现有前端包大小/动态导入提示与 Worker 的 CJS `import.meta`/图片注册副作用打包提示仍存在；本批未扩展对应供应商能力。

隔离临时项目用于这些测试，不修改用户项目，不进行额外云端生成调用。

这四项补齐不等同于全 Agent 1:1 验收完成。原版同状态逐屏/录屏、Windows/macOS/Linux 安装包、本地 Agent 模型、真实长会话及完整媒体生产门槛仍待验收；Worker 的全部编排向原应用服务收敛也需继续审查。
