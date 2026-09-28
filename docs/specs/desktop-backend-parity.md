# 桌面版后端能力迁移对照

> 状态：验收清单，未完成全部迁移。与 [桌面 UI 保真清单](desktop-ui-parity.md) 一起使用；根目录 `AGENTS.md` 为上位契约。下方原项目能力表及后续长段落保留 2026-09-24 至 09-27 的迁移记录；以下 2026-09-28 状态优先于其中过时的“尚未实现”描述。

## 2026-09-28 六节点与依赖复核

桌面画布仍注册原 `CanvasPage` 与原 `nodes/index.tsx` 六种节点。桌面 `EdgeRules` 类型矩阵与旧 Java `EdgeRules` 一致，手动连线沿原版默认 `reference`；`input` 依赖可由命令/API 显式指定。上游参考现在只读取有效边；修改节点内容经整图保存时，沿 `input` 边级联标记下游 `stale`，`reference` 边不传播。当前能运行这些路径不等于六节点已经全部完成 1:1 验收。

| 节点 | 已接通的桌面链路 | 待完成的 1:1 缺口 |
| --- | --- | --- |
| 文本 | 原编辑器、本地文本和 Agnes 文本、任务结果及文本上游参考。 | 非文本上游参考被显式拒绝；尚缺与原版同状态的逐操作录屏验收。 |
| 图片 | 原图片节点、本地素材、Agnes 生成、图片参考、多结果预览及结果存素材。 | 仍需不同生成参数和原版所有后处理输出的视觉对照。 |
| 音频 | 原音频节点、Windows SAPI 本地生成、播放和结果存素材。 | 云端音频模型、上游音频参考、音频节点直接导入与 macOS/Linux 本地等价模型尚未接通。 |
| 视频 | 原视频节点、Agnes 生成、比例/时长/720P、图片首尾帧、任务状态及结果。 | 非图片媒体上游会被抽取为首尾帧候选，但本地参考材料化仅支持图片；视频作为视频参考仍未接通。 |
| 合成 | 原时间线与 FFmpeg 顺序合成，校验至少两段有效、已完成的视频上游。 | FFmpeg 的跨平台安装与路径选择、原服务接受的其他输入地址形式及输出细节尚未全部对齐。 |
| 导演台 | 原 3D 编辑器与节点布局、场景状态、受限 IPC 本地 PNG 入库、最新照片 `assetId`、历史 `captures` 引用、下游图片/视频引用；Store 测试覆盖历史照删除影响及备份恢复。 | 仍需桌面 UI 手工拍摄/预览、删除流程与原版同状态录屏对照；自动 Store 测试不能替代交互验收。 |

真实 Agnes Key 已以系统保护的凭据形式更新，并通过一次文本请求 HTTP 200 验证。最短视频任务已成功生成并下载可解析的 MP4，约 4.46 秒、609091 字节。截图中的 HTTP 503 `video queue is full` 是供应商当时的容量响应；本地视频创建原有 429/502/503/504 有限重试，现将轮询阶段也纳入相同临时状态退避，最终仍保留原 HTTP 状态和供应商原因。此单次成功不能证明供应商队列始终可用。

## 2026-09-28 非 Agent 迁移状态

| 能力 | 本轮已接通及验证 | 仍未满足 1:1 的部分 |
| --- | --- | --- |
| 画布与项目 | 原 `WorkspacePage` 接 JSON 导入、导出、重命名和移入系统回收站。导入从新项目创建画布，版本为 1，节点和连线重映射 ID、节点恢复 idle，并跳过悬空边；同名项目不覆盖。原 `CanvasPage` 全量保存向本地命令账本透传幂等键，同一快照重试复用该键。画布/项目定向测试通过。 | 桌面仍为单项目单画布；跨项目 JSON 不携带素材正文，导入时移除无法核验的 `assetId` 并向用户警告。原 Web 未提供 `extractFromStack` 界面入口，本地核心已有同名后端能力；逐屏对照仍待验收。 |
| 素材 | 本地素材库支持图片 PNG/JPEG/GIF/WebP，视频 MP4/MOV/WebM，音频 WAV/MP3/OGG/M4A，以及 TXT/MD；按内容校验格式和 200 MB 上限。上传、同类型原位替换、引用、删除影响、备份恢复、MIME 预览和视频 Range 读取均在原素材库位置接入。图片预览派生宽度不超过 320px 的 JPEG 缩略图，替换后按哈希刷新，备份恢复后可重建。 | 缩略图由本地 FFmpeg 按需生成，缺少 FFmpeg 或源图片无法解码时回退原图；原 Java 使用 ImageIO，派生时间和失败条件尚未完全等同。更少见的原服务可接收格式仍待逐项对照。为保证节点引用有效，桌面替换要求素材类别不变。 |
| 生成与任务 | 原节点显示供应商 `errorMessage`，保留 `errorCode`；云端错误正文在受控进程截断并清理密钥。失败任务同 ID 重试、运行中取消并清理输出、图片 `count=1..4` 独立产物与备份恢复、Agnes 扩图/超分提示词语义及索引预览已接通。原节点裁剪、三视图、视频剪辑、提帧和视频超分接本地 FFmpeg 后处理；提帧 JPEG 结果按结果类型预览、备份和恢复。真实 FFmpeg 合成/后处理及 Windows SAPI 测试在允许子进程的环境通过；一次真实云端视频生成和下载成功。 | 本地后处理需要可用的 FFmpeg；三视图还需要受支持的系统字体。云端音频提供方、非图片媒体参考及多提供方仍有缺口。云端任务重启后处于 interrupted 时，没有供应商任务 ID 可对账，禁止盲重试。单次视频成功不能替代持续可用性和原节点端到端交互验收。 |

### 桌面任务数据字典增量

| 字段 | 类型与来源 | 约束与用途 |
| --- | --- | --- |
| `errorCode` | `string \| null`；`tasks.error_code` | 稳定错误分类，失败节点和历史记录在无详情时回退显示。 |
| `errorMessage` | `string \| null`；失败 `task_events.data_json.errorMessage` 投影 | 受控进程净化并限制长度，不写 API Key；节点及历史记录优先显示。重试后不再投影旧失败消息。 |
| `outputs` | 按 `index` 排序的数组；SQLite `task_outputs` | 每项保存受限结果路径、SHA-256、大小和元信息；图片最多 4 项。Renderer 只收到 `vibe://app/tasks/{taskId}/output` 及其受限 `?index=n` 形式，不收到磁盘绝对路径。旧单结果任务迁移时回填索引 0。 |
| `outputMeta.outputType` | 成功任务事件与 `task_outputs` 元信息 | 本地视频提帧任务仍归类为视频操作，产物明确标记 `image`；预览 MIME、扩展名校验和备份恢复均依据产物类型。 |

以上状态来自本地核心、前端代码、定向测试及一次真实云端视频结果；仍须执行原 Web 与桌面同状态截图、完整交互及三平台安装包验收，不能据此宣称非 Agent 全模块 1:1 完成。

本地 FFmpeg 后处理当前是可执行的等价任务链路，但输出视觉细节尚未通过原版对照：三视图标签使用英文，排版与原 Pillow 输出不同；原 MockVideoProvider 的剪辑/超分会生成彩色模拟视频、提帧会生成占位图，桌面改为真实输入处理。原 MockImageProvider 的本地扩图与放大锐化路径也尚未迁移，桌面当前扩图/图片超分使用 Agnes。以上差异不能计为 1:1 验收完成。

## 原项目能力基线

| 模块 | 原实现依据 | 桌面等价实现必须覆盖 | 当前状态与差距 |
| --- | --- | --- | --- |
| 画布与节点 | `vibepaper-services/canvas-service/.../CanvasService.java`、`GraphService.java`、`EdgeRules.java` | 画布版本、节点类型/能力、连线方向与依赖、上下游失效、删除影响、分组堆叠、导入导出、幂等与错误语义 | **已接通：** 全量 `saveCanvas` 经 Local Core 和受限 IPC 接到原 `CanvasPage`；校验六种节点类型与连线兼容矩阵，跳过悬空边，并按原 `CanvasService.applyPreservedGeneration` 保留旧节点的生成产物、媒体参数及已成功状态；`createNode`、`updateNode`、`deleteNode`、`connectEdge`、`deleteEdge` 均从原 `CanvasPage` 调用桌面桥接。`updateNode` 保留字段更新、版本 CAS、命令账本及仅沿 input 边传播 stale；`connectEdge` 校验端点、自连接、兼容性和依赖类型，显式命令键可重启回放，重复端点按原规则返回已有边且不增版本。`addGroup`、`updateGroup`、`deleteGroup`、`addStack`、`updateStack`、`deleteStack` 经原 `CanvasToolbar` 调用 Local Core；节点双击时展开堆叠，布局字段和坐标随整图保存；成员命令不递增画布版本。Store 的 `saveCanvas` 接收显式 groups/stacks 快照；省略字段会保留本地记录，这一兼容行为不同于 Java 全量保存对缺省字段的清空语义。只读 `exportCanvas` 已从 Store 接到 Local Core、Main IPC、Preload 和 bridge 类型；导出按钮及文件保存 UI 待原 `WorkspacePage` 接入。Store 的保存命令幂等键尚未由 Renderer 保存 IPC 传入。**未迁移：** `extractFromStack` 有 Store/IPC/Preload 实现，但原 `CanvasToolbar` 当前无对应调用；画布导入未实现，桌面仍是单项目单画布，不能安全复刻旧 `importCanvas`“新建画布并重新映射身份”的语义。旧 `deleteNode` 不从 group/stack 的 `nodeIds` 清除被删节点，此处保留原行为。 |
| 素材 | `vibepaper-services/asset-service/.../AssetService.java` 及画布素材引用 | 原件/派生文件、引用计数、删除影响、导入导出与项目备份恢复 | 原 `AssetLibrary` 的桌面上传入口现可多选导入 PNG/JPEG/GIF/WebP 图片和 WAV/MP3 音频；逐文件处理，单份失败不阻断其他文件，成功项仍刷新素材库。Local Core 按内容校验格式、200 MB 上限及 SHA；同一文件每次导入均创建独立素材 ID 和文件路径，与原 Java 上传一致。原图片专用入口仍只接受图片。素材重命名、图片/WAV/MP3 原位替换、软删除和引用计数已接本地 Store，替换保持素材 ID 和节点引用并更新内容哈希；删除保留原文件供现有节点使用。原音频节点的“存入素材库”通过受限任务 ID 保存经校验的 WAV；每次保存创建独立音频素材，音频节点引用、删除影响和项目备份恢复已接通。M4A、视频、文本、派生文件与完整跨模态素材能力仍未迁移。 |
| 生成与任务 | 原 `generation-service`、节点任务动作及模型能力目录 | 文/图/音/视频及合成的参数、模型能力、异步状态、取消、结果文件、历史结果、恢复与幂等 | 本地文本、Agnes 文/图/视频已接通；原 `ComposeNodeView` 接本地 `mock-compose`/FFmpeg 顺序拼接，Local Core 验证有序上游节点、连线、成功视频任务和输出摘要，`compose` 模态进入 TaskStore 并在原节点回显。Windows SAPI 音频任务已从原 `WindowsSapiTtsProvider` 迁移，按原参数归一化生成本地 WAV，并复用 TaskStore、原音频节点与预览位置；只在 Windows 提供该本地模型。云端音频提供方、音频参考输入、通用音频上传、多提供方、运行中取消及完整后处理仍未迁移。TaskStore 保留为内部权威状态，不加独立任务抽屉。 |

| Agent | `pi-main/packages/vibepaper-agent-service/src/domain/tool-manifest.ts`、`src/pi/profile-agents.ts`、`src/tools/runtime-tools.ts` | “小P”人格、读画布/节点/素材、建改删节点、连线/布局、生成/任务状态、Skill、会话与风险确认 | 桌面 Worker 直接打包原 TypeScript Agent，保留“小P”角色；原工具通过本地白名单网关访问画布、节点、任务，生成动作使用持久化确认令牌，单个与批量目标确认后提交。Pi 工具调用与结果成对保存在 JSONL、压缩时保持配对；可见回复清理规则已收敛到原 TS runtime；内置 Skill 列表及加载状态接入原 `SkillsPanel` 与本地 SQLite。Windows SAPI 音频任务已接原 `submit_generation` 确认链路；动态项目 Skill、完整素材及跨平台音频模型仍有缺口，不能宣称 Agent 1:1 完成。 |

2026-09-27 图像/视频故障修复对照：原 Python Agnes 适配器接受云端返回的媒体 CDN 地址，并对创建请求的 429/502/503/504 与视频轮询 429 做退避。桌面 Generation Worker 已对应处理这些响应、原节点的画幅与分辨率参数、媒体重定向和格式校验。原节点的本地图片素材与成功的图片任务结果现由 Main 经 Local Core 校验后转换为有大小上限的图片 data URL；图片请求按原服务要求传裸 Base64，视频首尾帧传 data URL。图片/视频节点不再拦截图片参考，桌面 Agnes 视频分辨率显示 720P；尚不支持媒体参考的文本/音频节点仍明确拒绝。真实 Key 测试已生成三份可读取的 PNG，其中一份使用图片参考；一次 4 秒首帧视频创建请求在 5 次尝试后仍收到供应商 HTTP 429，故真实视频生成和本地首帧端到端成功尚未验收。节点现区分显示 `CLOUD_RATE_LIMITED`。非图片媒体参考及其他原后端能力仍有迁移缺口，不计为 1:1 完成。

## 迁移规则

本地合成已按原 `ComposeProvider` 的 FFmpeg 转码、concat copy 与失败重编码实现，保留 `compose` 任务模态、输入顺序、幂等与文件校验；当前只接受当前画布已连接节点的成功视频任务。原 provider 可直接读取本地路径、data URL 与 HTTP(S) URL，以及返回完整 `meta` 和独立错误详情，这些接口语义尚未全部迁移。桌面设置页也尚未提供 FFmpeg 路径选择。这些差距在 1:1 验收前必须处理或经产品契约明确调整。

本地音频沿用原 SAPI 的文本、voice、language、speed、tone 归一化、速率范围与哈希；输入经 PowerShell stdin 传递，真实 WAV 先写临时文件并校验后进入任务结果，`voiceId`、时长和采样率随成功事件持久化。修复了原 PowerShell 正则把 `female` 中的 `male` 误判为男性声音的问题。测试覆盖真实 Windows 合成、失败码、结果预览、重启与幂等。此链路仅覆盖原项目的 Windows SAPI 提供方；其他音频模型与素材链路仍是迁移缺口。

音频生成结果保存素材沿用原 Web 的每次点击独立上传语义；Renderer 只提交项目与任务 ID，Local Core 核对成功任务的 WAV、哈希及 200 MB 素材上限，复制成独立原件。项目 SQLite v7→v8 扩展音频 MIME，v8→v9 为旧 `params.assetId` 节点补齐可核实的素材引用，v9→v10 允许 MP3；升级前均生成回退副本。备份和恢复校验 WAV/MP3 内容、路径、哈希及节点引用。原素材库上传与替换入口已接图片和 WAV/MP3，多选上传逐文件执行；M4A、视频、文本仍需按原 `AssetService` 迁移。

项目 SQLite v12→v13 将素材引用主键扩展为 `(canvas_id, node_id, asset_id)`，在回退快照后补登记导演台节点 `captures` 中仍存在的本地图片。引用计数、删除影响、`updateNode`/整画布保存和备份恢复现已覆盖一节点多张照片；旧项目中已经失效或非图片的历史 URL 不阻止打开，也不作为有效素材引用。

### 画布 JSON 导入/导出

原版 `CanvasService.export` 导出 `schema_version`/`schemaVersion`、画布、节点、连线、groups 与 stacks；Store 的 `exportCanvas(projectId, canvasId)` 目前输出相同顶层结构和 `1.0.0` schema 别名，导出六类节点的节点载荷、有效连线 DTO、groups/stacks 及本地图片 `assetId` 引用。它只读当前项目数据库，不嵌入素材字节；现已通过 Local Core、桌面 IPC 接到原 `WorkspacePage` 和 `CanvasTopBar` 导出按钮。单元测试覆盖画布身份错误、素材引用、groups/stacks 和旧 schema/DTO 形状。

旧 `CanvasService.importCanvas` 接受任一别名且主版本号大于等于 1 的 schema；它创建新画布（初始版本 1），重新生成节点/边 ID，将节点状态重置为 idle、stale=false，并跳过引用缺失节点的边；兼容 `creativeType`/`creative_type` 及 `dependencyType`/`dependency_type`。它不恢复 groups/stacks，也只复制素材 ID 参数，不携带素材字节。Local Core 当前每项目仅允许一张画布，且素材身份属于项目；直接覆盖当前图会破坏旧语义并可能丢失数据。因此本地 `importCanvas` 暂不实现，待多画布身份及可校验素材包契约明确后再迁移；当前不得把 Store-only 导出描述为已完成导入/导出迁移。

将旧微服务数据依赖换为本地项目文件、SQLite、受限 IPC/Worker 和 OS 凭据能力，但保持输入校验、状态机、业务副作用、可见错误与输出语义。平台账号、点数、企业及运营能力按 `AGENTS.md` 明确移除；Agent 的生成动作继续保留原版单个/批量确认并在确认后提交本地任务，普通云端模型 API 请求不逐次弹数据发送确认，高风险画布写操作保留可撤销或确认。Agent 另外优化上下文压缩、短期记忆和长期记忆，不能让摘要或记忆取代画布与任务的权威状态。

## 完成判定

对每个原 API/工具建立桌面映射，至少在成功、非法输入、版本冲突、能力不匹配、任务中断、重启恢复和幂等重试场景运行同等测试；再执行端到端画布与 Agent 操作并检查本地持久化结果。UI 对齐、打包通过或单个示例成功均不足以判定模块迁移完成。未通过项应保持可见的缺口记录。
