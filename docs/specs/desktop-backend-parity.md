# 桌面版后端能力迁移对照

> 2026-09-24。状态：验收清单，未完成全部迁移。与 [桌面 UI 保真清单](desktop-ui-parity.md) 一起使用；根目录 `AGENTS.md` 为上位契约。

## 原项目能力基线

| 模块 | 原实现依据 | 桌面等价实现必须覆盖 | 当前状态与差距 |
| --- | --- | --- | --- |
| 画布与节点 | `vibepaper-services/canvas-service/.../CanvasService.java`、`GraphService.java`、`EdgeRules.java` | 画布版本、节点类型/能力、连线方向与依赖、上下游失效、删除影响、分组堆叠、导入导出、幂等与错误语义 | **已接通：** 全量 `saveCanvas` 经 Local Core、受限 IPC 接到 Renderer，按原版保存语义校验六种节点的连线兼容矩阵，并跳过悬空边；`createNode` 已接 Renderer 与 Agent `create_nodes` 工具，保留默认值、版本 CAS 和命令账本；`updateNode` 已接 Renderer，保留字段更新、版本 CAS、命令账本及仅沿 input 边传播 stale；`connectEdge` 已接 Renderer 与 Agent `connect_nodes` 工具，校验端点/自连接/兼容性/依赖类型，显式命令键保存到账本并可重启回放，重复端点按原规则返回已有边且不增版本。**仅存储层：** `deleteNode` 已实现版本 CAS、幂等回放、连线清理和直接下游影响摘要；`deleteEdge` 已按旧 API 删除连线且不要求版本/幂等键、不增加画布版本；`addGroup`、`updateGroup`、`deleteGroup`、`addStack`、`updateStack`、`extractFromStack`、`deleteStack` 已实现持久化与原版节点成员副作用，七项均不递增画布版本。`saveCanvas` 未收到 groups/stacks 字段时保留现有记录，显式传数组时按快照替换；Store 可选接受保存命令幂等键并持久化回放，但当前 Renderer 保存 IPC 未传此键。`exportCanvas` 已在 Store 实现只读 JSON 导出，尚未接入 IPC/Renderer。**接线/能力缺口：** 删除节点/连线和全部分组/堆叠独立命令仍没有经 IPC/Renderer 调用；旧 Web 的删除前下游影响预览、布局和画布导入也未接通。桌面仍是单项目单画布，不能安全复刻旧 `importCanvas`“新建画布并重新映射身份”的语义，因此没有覆盖式导入实现。旧 `deleteNode` 不从 group/stack 的 `nodeIds` 清除被删节点，此处保留原行为。 |
| 素材 | `vibepaper-services/asset-service/.../AssetService.java` 及画布素材引用 | 原件/派生文件、引用计数、删除影响、导入导出与项目备份恢复 | 当前主要是本地图片导入和引用，完整素材能力待对照。 |
| 生成与任务 | 原 `generation-service`、节点任务动作及模型能力目录 | 文/图/音/视频的参数、模型能力、异步状态、取消、结果文件、历史结果、恢复与幂等 | 当前本地文本及 Agnes 文/图/视频为原型；音频、多提供方、原版节点内结果历史等待迁移。TaskStore 保留为内部权威状态，不加独立任务抽屉。 |
| Agent | `pi-main/packages/vibepaper-agent-service/src/domain/tool-manifest.ts`、`src/pi/profile-agents.ts`、`src/tools/runtime-tools.ts` | “小P”人格、读画布/节点/素材、建改删节点、连线/布局、生成/任务状态、Skill、会话与风险确认 | 桌面 Worker 使用“小P”角色；经 Main/Local Core 白名单接入 `get_canvas_summary`、`get_node_detail`、`check_task_status`、`list_models`、`create_nodes`、`connect_nodes`。写工具通过 `createNode`/`connectEdge` Store 命令及派生幂等键创建节点和连接节点。素材搜索、选中节点、更新/删除/布局、生成工具、完整 Skill 接入仍有缺口，不能宣称 Agent 1:1 完成。 |

## 迁移规则

### 画布 JSON 导入/导出

原版 `CanvasService.export` 导出 `schema_version`/`schemaVersion`、画布、节点、连线、groups 与 stacks；Store 的 `exportCanvas(projectId, canvasId)` 目前输出相同顶层结构和 `1.0.0` schema 别名，导出六类节点的节点载荷、有效连线 DTO、groups/stacks 及本地图片 `assetId` 引用。它只读当前项目数据库，不嵌入素材字节，也尚未通过桌面 IPC 暴露；单元测试覆盖画布身份错误、素材引用、groups/stacks 和旧 schema/DTO 形状。

旧 `CanvasService.importCanvas` 接受任一别名且主版本号大于等于 1 的 schema；它创建新画布（初始版本 1），重新生成节点/边 ID，将节点状态重置为 idle、stale=false，并跳过引用缺失节点的边；兼容 `creativeType`/`creative_type` 及 `dependencyType`/`dependency_type`。它不恢复 groups/stacks，也只复制素材 ID 参数，不携带素材字节。Local Core 当前每项目仅允许一张画布，且素材身份属于项目；直接覆盖当前图会破坏旧语义并可能丢失数据。因此本地 `importCanvas` 暂不实现，待多画布身份及可校验素材包契约明确后再迁移；当前不得把 Store-only 导出描述为已完成导入/导出迁移。

将旧微服务数据依赖换为本地项目文件、SQLite、受限 IPC/Worker 和 OS 凭据能力，但保持输入校验、状态机、业务副作用、可见错误与输出语义。平台账号、点数、企业及运营能力按 `AGENTS.md` 明确移除；Agent 的生成动作继续保留原版单个/批量确认并在确认后提交本地任务，普通云端模型 API 请求不逐次弹数据发送确认，高风险画布写操作保留可撤销或确认。Agent 另外优化上下文压缩、短期记忆和长期记忆，不能让摘要或记忆取代画布与任务的权威状态。

## 完成判定

对每个原 API/工具建立桌面映射，至少在成功、非法输入、版本冲突、能力不匹配、任务中断、重启恢复和幂等重试场景运行同等测试；再执行端到端画布与 Agent 操作并检查本地持久化结果。UI 对齐、打包通过或单个示例成功均不足以判定模块迁移完成。未通过项应保持可见的缺口记录。
