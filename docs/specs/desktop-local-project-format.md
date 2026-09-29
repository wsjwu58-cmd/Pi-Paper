# 桌面本地数据格式（项目与模型设置）

状态：Electron 项目引导、本地画布与六类节点存储、连线/分组/堆叠领域命令、原页面上的画布 JSON 导出、图片及 WAV/MP3 素材导入/引用/重命名/替换/软删除、Windows SAPI 音频任务、任务状态、本地文本与合成执行、Agnes 文本/图像/视频任务、短剧系列/角色/参考包/镜头/关键帧及渲染血缘状态，以及当前格式下的项目备份恢复切片已实现。原 `AgentPanel` 的 Skills 面板已接入项目级 Skill 列表、创建、Markdown 导入、编辑、启停和归档删除，并使用 Pi 原始 Skill loader。旧版“导入为新画布”语义因当前单项目单画布模型而未实现；短剧生产批次提交、任务回调/重跑、完整素材与跨平台安装包验收、Agent 跨版本恢复仍有缺口。

## 项目目录

```text
<用户选择的目录>/<项目名>/
  .vibepaper/
    project.json
    project.sqlite
    assets/<sha256>/<assetId>.<ext>
    agent/
      control.sqlite
      sessions/<cwd-key>/*.jsonl
      memory/**/*.md
      skills/**/*.md
      session-memory/**/*.md
```

不把当前绝对路径写入项目身份。项目搬迁后，用户打开新位置即可通过 `projectId`、`canvasId` 恢复相同项目身份。操作系统用户数据目录保存非密钥 `settings.json`、最近项目 `recent-projects.json` 和兼容旧版单项恢复的 `recent-project.json`。最近项目清单只由 Main 读取，Renderer 只能拿到经过身份校验的 `{projectId, canvasId, name}`；打开时 Main 按项目 ID 查回内部路径并再次验证 `project.json` 与 SQLite 身份。迁移只读取旧 `recent-project.json` 并建立新清单，不删除该文件。此目录清单记录用户明确创建或打开过的本地项目；每个项目当前仍只对应一张画布。Agnes API Key 经 Electron `safeStorage` 使用 OS 密钥能力加密后，单独保存为 `credentials/agnes-api-key.bin`；Linux 未提供 Secret Service/KWallet/Secret Portal 时拒绝保存。凭据不进入普通设置文件、项目目录或项目备份。

## 项目级 Skill

项目自定义 Skill 保存在 `.vibepaper/agent/skills/`，不读写用户目录里的全局 Skill。Agent Worker 使用 Pi 原始 `loadSkillsFromDir` 发现这些 Markdown 文件，运行时只把当前项目内启用的 Skill 提供给原 Agent 工具。原 `AgentPanel` Skills 面板提供列表、分类与搜索、创建、Markdown 文件导入、详情、编辑、启停和删除；导入文件上限为 512 KB。

新建和导入文件采用 Pi Skill frontmatter，并在 `metadata.vibepaper` 中记录 `schemaVersion: 1`、稳定项目内 ID、显示名称、分类、启用状态与版本号。内容使用同目录临时文件和原子改名；编辑前将完整旧文件保存到隐藏 `.versions/` 目录并递增版本。删除将文件移入隐藏 `.deleted/` 目录，保留可恢复副本。Pi loader 会跳过这些隐藏目录，项目备份清单会纳入其中的 Markdown 文件。

## 本地文本模型设置

用户数据目录的 `settings.json` 使用 `schemaVersion: 1`。当前可选 `localTextModel` 字段保存一台用户主动配置的 OpenAI 兼容本地文本服务：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `providerId` | 固定字符串 `local-openai-compatible` | 本地目录项标识 |
| `providerType` | 固定字符串 `local` | 阻止本地选择被解释成云端提供方 |
| `endpoint` | URL 字符串 | 仅允许 `localhost`、`127.0.0.1` 或 `::1`，路径仅支持 `/`、`/v1`、`/api/v1` |
| `modelId` | 字符串，最多 200 字符 | 由用户输入或显式读取 `/models` 后选择 |
| `modalities`、`inputModes` | 固定为 `['text']` | 当前只声明文本输入/输出 |
| `toolCalling`、`streaming`、`cancellation` | 固定为 `false` | 未接入对应执行能力，不向调用方虚报支持 |

Renderer 只能通过 Main 暴露的配置、发现、保存和移除方法访问此目录项。应用不会自动探测服务；用户点击“读取模型”后，Main 才向 loopback 地址的 `/models` 发起无凭据请求。此设置不进入项目目录或项目备份，也不包含 API Key。文本节点可用该目录项创建本地 TaskStore 任务，由独立 Generation Worker 访问 `/chat/completions`；本地目录只声明文本能力，不支持工具调用、流式或运行中取消。

## Agnes 云端模型目录

桌面版内置固定目录：文本 `agnes-2.5-flash`、图像 `agnes-image-2.5-flash`、视频 `agnes-video-2.5-flash`，API Base URL 为 `https://apihub.agnes-ai.com/v1`。模型 ID 和 endpoint 是非密钥能力元数据，不保存在项目内。API Key 只能通过受限 IPC 在 Electron Main 接收，并使用 Electron `safeStorage` 加密到独立凭据文件；Renderer 只能读取“是否已配置”，不能读取 Key。Generation Worker 只在调用 Agnes 时从 Main 收到短期内存副本，Key 不进入任务参数、SQLite、JSONL、日志或备份。

模型配置页说明云端调用的供应商、发送范围和可能费用；用户选择 Agnes 并点击节点生成后直接提交，不逐次弹发送确认。Agent 工具提交生成任务仍沿用原版的生成动作确认，拒绝不会创建任务。图像和视频当前仅发送文本提示词及模型参数，不上传本地参考素材；返回媒体下载并校验后仍保存在项目任务目录。图像/视频模型目前不支持运行中取消。

## `project.json`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `schemaVersion` | 整数，当前为 `1` | 项目元数据格式版本 |
| `projectId` | UUID 字符串 | 稳定本地项目身份 |
| `canvasId` | UUID 字符串 | 首张画布身份 |
| `name` | 字符串 | 项目显示名称 |
| `createdAt` | ISO 8601 字符串 | 创建时间 |

## `project.sqlite`

数据库使用 `PRAGMA user_version = 17` 标记当前存储结构版本，并以 WAL、外键和 `synchronous=FULL` 运行。每次结构迁移先保存 SQLite 回退快照并在事务内检查外键。v8→v9 回填旧 `params.assetId` 图片/音频节点可核实的缺失素材引用；v9→v10 扩展素材 MIME 约束以接纳 MP3；v13→v14 新增短剧资产和命令账本；v14→v15 新增生产批次、任务及审校表；v15→v16 新增短剧剧集状态表和幂等命令账本；v16→v17 新增批次请求摘要、任务提供方/模型与重跑次数，以及持久化批次确认快照。主要表为：

| 表 | 内容 |
| --- | --- |
| `project_metadata` | 稳定 `projectId`、`canvasId` |
| `canvases` | 画布 ID、乐观锁版本和更新时间 |
| `nodes` | 画布 ID、节点 ID、有限位置及完整节点 JSON |
| `edges` | 画布 ID、连线 ID、来源/目标及完整连线 JSON；外键要求两端节点存在 |
| `assets` | 素材 ID、SHA-256、显示名、图片或 WAV/MP3 音频 MIME、大小和项目内相对路径 |
| `asset_references` | 画布图片/音频节点与本地素材的关系；删除节点时级联清除引用 |
| `tasks` | 本地/云端生成任务输入哈希、Idempotency-Key、画布版本、提供方/模型标识、状态、结果路径与哈希、错误码和时间 |
| `task_events` | 任务状态事件的单调序号、类型、JSON 数据和时间 |
| `canvas_graph_commands` | 画布增量命令的 `Idempotency-Key`、操作类型、结果快照和提交版本；用于节点创建/更新/删除与连接命令 |
| `canvas_groups` | 编组 ID、名称、颜色、布局、成员节点 ID 列表及创建/更新时间 |
| `canvas_stacks` | 堆叠 ID、折叠状态、成员节点 ID 列表及创建/更新时间 |
| `drama_assets`、`drama_asset_commands` | 九类画布短剧资产、版本及幂等写命令快照 |
| `drama_render_batches`、`drama_render_jobs`、`drama_render_confirmations`、`render_reviews` | 本地生产批次、渲染任务、确认快照/令牌哈希/画布版本/过期时间与连续性审校记录；批次请求摘要支持幂等键冲突检测，任务记录提供方/模型及 attempt |
| `drama_series`、`drama_characters`、`drama_reference_packs` | 画布内剧集、角色身份锚点、Look 版本及角色参考包状态 |
| `drama_shots`、`drama_keyframes`、`drama_render_lineages` | 镜头参数、关键帧接受状态、所用参考包及后续渲染血缘 |
| `drama_state_commands` | 短剧状态写命令的 `Idempotency-Key`、输入摘要和返回快照；与对应状态写入在同一 SQLite 事务提交 |

Renderer 仅通过受限 IPC 调用 Electron utility process 读写画布。写入须匹配项目/画布身份；全量保存与节点增删改、连接命令须匹配 `expectedVersion`，节点创建按旧接口允许内部调用省略版本。Local Core 校验连线兼容性、自连接、节点类型、引用及载荷大小，再在 SQLite 事务中提交；这些版本化命令按旧接口推进画布版本。`saveCanvas` 可选接收持久化幂等键，但当前 Renderer 保存 IPC 未传入该键。分组/堆叠七项 Store 命令已通过受限 Main IPC 和 Preload 暴露，写入成员节点关系但不递增画布版本，符合旧 `GraphService` 行为；原 `CanvasPage` 仍需切换到这些桥接方法。桌面全量保存可接收 `groups`/`stacks`；未带字段时会保留 Store 中的记录，显式传入字段（包括空数组或 `null`）时才按快照替换。与旧 `deleteNode` 一致，独立删除节点不会从分组/堆叠的 `node_ids_json` 列表中过滤其 ID。若数据库版本已被其他写者更新，事务回滚并要求重新打开画布。节点创建/更新/删除及显式连接命令的同一幂等键重试返回已提交结果，不重复执行。

`exportCanvas(projectId, canvasId)` 在 Store 内只读生成 interchange JSON：顶层同时写入 `schema_version` 和 `schemaVersion`（当前均为 `1.0.0`），并包含画布、节点、边、groups 与 stacks。图片节点只导出其稳定 `assetId` 引用，不打包素材文件；导出方法目前不经 IPC/Renderer 调用。旧后端 `CanvasService.importCanvas` 会创建另一张新画布并重映射节点/边身份、重置执行状态，但当前 `project_metadata` 仅保存一个 `canvasId`；本地尚无等价导入命令。为防止覆盖当前画布或生成无法解析的跨项目素材引用，画布 JSON 导入保持未实现，等待多画布身份和素材包迁移契约。

### 短剧制作状态

schema v16 将 Pi Agent 的短剧状态保存在项目 SQLite 中，并以 `canvas_id` 约束剧集所属画布。schema v17 增加渲染批次幂等请求摘要、提供方/模型与 attempt 字段，以及持久化的确认快照。写入系列、角色、参考包、镜头、关键帧和渲染血缘时，状态行与幂等结果快照一起提交；相同命令键重试会返回原结果，项目关闭后重开仍可读取关键帧接受状态。短剧状态写入不递增画布版本，保持原 Pi 状态存储语义。关键帧节点与视频节点经 `createNode` 使用画布版本 CAS 和画布命令幂等账本。

本地状态校验保留原格式、Look revision、角色绑定、单镜时长、已批准参考包唯一性、关键帧参考包匹配及“视频节点必须引用已接受关键帧”等规则。渲染血缘还要求关键帧属于同一镜头；按角色标记失效仅修改绑定该角色的血缘并返回实际变更 ID。参考素材 ID 持久化为本地项目数据中的引用标识，不随状态行写入素材文件内容。

ProjectStore 现提供经过校验的可渲染候选查询、批次创建/幂等重放、绑定项目/画布/版本/内容哈希/过期时间的持久化确认、拒绝/消费、TaskStore 任务关联与权威状态协调，以及需要二次确认的单镜头重跑。确认消费返回确认过的镜头快照和稳定批次/镜头幂等键；调用方仍须使用本地 TaskStore 创建任务。同一已接受确认可在本次应用运行期间幂等重放，以恢复任务创建后尚未关联到 job 的中断。批次读取也会按当前 attempt 的稳定幂等键找回同一任务并校验结果文件后协调状态。重启会使待处理及已接受确认失效；被拒绝、过期或画布版本变化的确认不能提交。v14→v17 与 v16→v17 升级均在事务前保存各自版本的回退快照。

候选只包含当前镜头、已接受且有可读成功图片任务输出的关键帧，以及唯一匹配的原视频节点；记录会携带可用状态和不可用原因。镜头允许 2–5 秒，而当前 Agnes 与 Ark 视频模型都至少要求 4 秒，因此 2–3 秒镜头会保留为不可用候选，并在确认前被批次创建校验拒绝。已验证的本地图片关键帧可用于 Ark：URI resolver 会先转换出数据 URL。本地视频/音频参考需要供应商可访问的 HTTPS 媒体地址；当前没有本地视频/音频素材上传链，Agnes 也明确拒绝视频/音频参考，所以候选和创建校验会报告不可用原因。原短剧系列、角色、参考包、镜头、关键帧节点/接受、视频节点、血缘和按角色失效 API 已映射到受限路径。Store 级批次链路不单独证明 Main/Preload/API/原面板接入或原版 UI 逐项等价；这些边界须分别以接口和端到端证据验收。

文本、图像与视频节点可将当前提示词提交给已配置的本地或 Agnes 模型；Windows 上原音频节点可提交本地 SAPI 语音任务。原合成节点按有序上游视频节点 ID 创建本地 `compose` 任务，由 Local Core 验证连线、最新成功视频结果与文件摘要，再交给 FFmpeg 统一转码并拼接。任务输入使用 `Idempotency-Key` 和画布版本；Worker 将输出写入该任务目录，Local Core 校验文件类型、路径、可读性、SHA-256 与大小后才提交 `succeeded`。原节点显示任务状态、历史和可预览结果；其他音频提供方及完整模态能力仍待迁移。

## 素材首个切片

通过原素材库和画布入口的系统文件选择器导入 PNG、JPEG、GIF、WebP 图片及 WAV/MP3 音频（每个文件不超过 200 MB）。原素材库上传可多选，Main 逐文件调用 Local Core，返回成功项与安全的失败摘要；单个文件失败不阻断其他文件，不向 Renderer 返回本机绝对路径。Local Core 根据文件内容识别 MIME、流式计算 SHA-256 并复制到 `.vibepaper/assets/<sha256>/<assetId>.<ext>`；同一文件每次导入都有独立素材 ID，符合原 Java 上传语义。画布中的图片/音频节点保存稳定 `assetId`，保存画布时素材存在性检查与引用更新位于同一 SQLite 事务。Renderer 只使用受限的 `vibe://app/assets/<assetId>` 资源 URL，Main 通过 Local Core 查到项目内文件后提供只读媒体响应；CSP 允许该受限协议，素材响应不缓存以便替换后即时显示。

`user_version = 1` 到 5 逐级增加素材、任务、画布命令、分组与堆叠；版本 6 增加素材软删除字段。版本 6 升级到 7 前在 `.vibepaper/backups/` 创建 SQLite 在线快照，再在事务中扩展任务表的 `compose` 模态并保留旧任务和事件。迁移失败时事务回滚，快照保留供恢复；项目备份经校验后逐级迁移到当前版本。

## 本地备份与恢复首个切片

画布界面的“备份项目”会先提交待保存的画布改动，再由 Local Core 将 `project.json`、数据库登记且校验通过的素材、Agent 会话/记忆/Skill 文件和 SQLite 在线一致性快照写入新目录的 `.vibepaper/`，生成 `backup-manifest.json`（文件相对路径、字节数和 SHA-256），最后原子改名发布备份目录。SQLite 通过 `node:sqlite` 的在线 backup API 生成快照，不直接复制可能仍处于 WAL 状态的数据库主文件。Agent 数据复制期间由 `.vibepaper/agent/writer.lock` 阻止并发写入；锁已存在或状态不明确时，本次备份失败并提示关闭 Agent 后重试。

“恢复备份副本”从用户选择的项目备份生成新的项目目录，不覆盖已有内容。Local Core 核验 SQLite `integrity_check`、外键、项目/画布关系、素材引用与素材实际字节；存在清单时还逐项核验 SHA-256 和大小。旧格式备份没有清单时仍执行数据库及素材校验。恢复副本获得新的 `projectId`，保留 `canvasId`、节点和连线身份，完成后打开副本。Agent JSONL 首行中的项目身份和会话目录会一并重绑；控制库中的待处理确认置为失效，未完成 Run 标记为中止。打开备份后若对画布或素材作出修改，Local Core 会移除旧备份清单，避免清单与已修改内容不符。

备份清单 schema v2 覆盖项目元数据、项目 SQLite、登记的图片素材、已成功任务结果，以及 `agent/control.sqlite`、Pi JSONL 和受支持的 Markdown/JSON/压缩结果文件；schema v1 备份仍可恢复。Agent 数据总量上限为 4 GiB，符号链接和未识别文件类型会使备份失败。凭据、诊断日志不进入项目备份；Agent schema 升级回退和完整跨版本恢复仍待实现。

首个 JSON 引导版本使用 `.vibepaper/canvas.json`。打开该版本项目且数据库尚不存在时，Local Core 校验 JSON 后在 SQLite 事务中导入；原文件保留为迁移来源，导入成功后 `project.sqlite` 是唯一画布权威。新项目直接创建 SQLite 数据库。

本阶段不承诺向后迁移旧 Web 项目数据。将来提升项目或 SQLite schema 版本时，按根目录 `AGENTS.md` 的备份、可重复迁移和失败回退要求实现。
