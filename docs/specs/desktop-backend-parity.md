# 桌面版后端能力迁移对照

> 2026-09-24。状态：验收清单，未完成全部迁移。与 [桌面 UI 保真清单](desktop-ui-parity.md) 一起使用；根目录 `AGENTS.md` 为上位契约。

## 原项目能力基线

| 模块 | 原实现依据 | 桌面等价实现必须覆盖 | 当前状态与差距 |
| --- | --- | --- | --- |
| 画布与节点 | `vibepaper-services/canvas-service/.../CanvasService.java`、`GraphService.java`、`EdgeRules.java` | 画布版本、节点类型/能力、连线方向与依赖、上下游失效、删除影响、分组堆叠、导入导出、幂等与错误语义 | **已接通：** 全量 `saveCanvas` 经 Local Core 和受限 IPC 接到原 `CanvasPage`；校验六种节点类型与连线兼容矩阵，跳过悬空边，并按原 `CanvasService.applyPreservedGeneration` 保留旧节点的生成产物、媒体参数及已成功状态；`createNode`、`updateNode`、`deleteNode`、`connectEdge`、`deleteEdge` 均从原 `CanvasPage` 调用桌面桥接。`updateNode` 保留字段更新、版本 CAS、命令账本及仅沿 input 边传播 stale；`connectEdge` 校验端点、自连接、兼容性和依赖类型，显式命令键可重启回放，重复端点按原规则返回已有边且不增版本。`addGroup`、`updateGroup`、`deleteGroup`、`addStack`、`updateStack`、`deleteStack` 经原 `CanvasToolbar` 调用 Local Core；节点双击时展开堆叠，布局字段和坐标随整图保存；成员命令不递增画布版本。Store 的 `saveCanvas` 接收显式 groups/stacks 快照；省略字段会保留本地记录，这一兼容行为不同于 Java 全量保存对缺省字段的清空语义。只读 `exportCanvas` 已从 Store 接到 Local Core、Main IPC、Preload 和 bridge 类型；导出按钮及文件保存 UI 待原 `WorkspacePage` 接入。Store 的保存命令幂等键尚未由 Renderer 保存 IPC 传入。**未迁移：** `extractFromStack` 有 Store/IPC/Preload 实现，但原 `CanvasToolbar` 当前无对应调用；画布导入未实现，桌面仍是单项目单画布，不能安全复刻旧 `importCanvas`“新建画布并重新映射身份”的语义。旧 `deleteNode` 不从 group/stack 的 `nodeIds` 清除被删节点，此处保留原行为。 |
| 素材 | `vibepaper-services/asset-service/.../AssetService.java` 及画布素材引用 | 原件/派生文件、引用计数、删除影响、导入导出与项目备份恢复 | 原 `AssetLibrary` 已接本地图片导入、重命名、替换、软删除和引用计数；删除保留原文件供现有节点使用。视频/音频/文本素材导入、派生文件与完整备份恢复仍未迁移。 |
| 生成与任务 | 原 `generation-service`、节点任务动作及模型能力目录 | 文/图/音/视频及合成的参数、模型能力、异步状态、取消、结果文件、历史结果、恢复与幂等 | 本地文本、Agnes 文/图/视频已接通；原 `ComposeNodeView` 接本地 `mock-compose`/FFmpeg 顺序拼接，Local Core 验证有序上游节点、连线、成功视频任务和输出摘要，`compose` 模态进入 TaskStore 并在原节点回显。音频、多提供方、参考媒体输入及完整后处理仍未迁移。TaskStore 保留为内部权威状态，不加独立任务抽屉。 |
| Agent | `pi-main/packages/vibepaper-agent-service/src/domain/tool-manifest.ts`、`src/pi/profile-agents.ts`、`src/tools/runtime-tools.ts` | “小P”人格、读画布/节点/素材、建改删节点、连线/布局、生成/任务状态、Skill、会话与风险确认 | 桌面 Worker 直接打包原 TypeScript Agent，保留“小P”角色；原工具通过本地白名单网关访问画布、节点、任务，生成动作使用持久化确认令牌，单个与批量目标确认后提交。Pi 工具调用与结果成对保存在 JSONL、压缩时保持配对；可见回复清理规则已收敛到原 TS runtime；内置 Skill 列表及加载状态接入原 `SkillsPanel` 与本地 SQLite。动态项目 Skill、完整素材与音频任务能力仍有缺口，不能宣称 Agent 1:1 完成。 |

## 迁移规则

本地合成已按原 `ComposeProvider` 的 FFmpeg 转码、concat copy 与失败重编码实现，保留 `compose` 任务模态、输入顺序、幂等与文件校验；当前只接受当前画布已连接节点的成功视频任务。原 provider 可直接读取本地路径、data URL 与 HTTP(S) URL，以及返回完整 `meta` 和独立错误详情，这些接口语义尚未全部迁移。桌面设置页也尚未提供 FFmpeg 路径选择。这些差距在 1:1 验收前必须处理或经产品契约明确调整。

### 画布 JSON 导入/导出

原版 `CanvasService.export` 导出 `schema_version`/`schemaVersion`、画布、节点、连线、groups 与 stacks；Store 的 `exportCanvas(projectId, canvasId)` 目前输出相同顶层结构和 `1.0.0` schema 别名，导出六类节点的节点载荷、有效连线 DTO、groups/stacks 及本地图片 `assetId` 引用。它只读当前项目数据库，不嵌入素材字节；现已通过 Local Core、桌面 IPC 接到原 `WorkspacePage` 和 `CanvasTopBar` 导出按钮。单元测试覆盖画布身份错误、素材引用、groups/stacks 和旧 schema/DTO 形状。

旧 `CanvasService.importCanvas` 接受任一别名且主版本号大于等于 1 的 schema；它创建新画布（初始版本 1），重新生成节点/边 ID，将节点状态重置为 idle、stale=false，并跳过引用缺失节点的边；兼容 `creativeType`/`creative_type` 及 `dependencyType`/`dependency_type`。它不恢复 groups/stacks，也只复制素材 ID 参数，不携带素材字节。Local Core 当前每项目仅允许一张画布，且素材身份属于项目；直接覆盖当前图会破坏旧语义并可能丢失数据。因此本地 `importCanvas` 暂不实现，待多画布身份及可校验素材包契约明确后再迁移；当前不得把 Store-only 导出描述为已完成导入/导出迁移。

将旧微服务数据依赖换为本地项目文件、SQLite、受限 IPC/Worker 和 OS 凭据能力，但保持输入校验、状态机、业务副作用、可见错误与输出语义。平台账号、点数、企业及运营能力按 `AGENTS.md` 明确移除；Agent 的生成动作继续保留原版单个/批量确认并在确认后提交本地任务，普通云端模型 API 请求不逐次弹数据发送确认，高风险画布写操作保留可撤销或确认。Agent 另外优化上下文压缩、短期记忆和长期记忆，不能让摘要或记忆取代画布与任务的权威状态。

## 完成判定

对每个原 API/工具建立桌面映射，至少在成功、非法输入、版本冲突、能力不匹配、任务中断、重启恢复和幂等重试场景运行同等测试；再执行端到端画布与 Agent 操作并检查本地持久化结果。UI 对齐、打包通过或单个示例成功均不足以判定模块迁移完成。未通过项应保持可见的缺口记录。
