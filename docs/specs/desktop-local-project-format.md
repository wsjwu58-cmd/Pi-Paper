# 桌面本地数据格式（项目与模型设置）

状态：Electron 项目引导、本地画布存储、六类节点及连线领域命令、分组/堆叠 Store 命令、只读画布 JSON Store 导出、首批图片素材导入/引用、任务状态存储、本地文本执行、Agnes 文本/图像/视频云端任务，以及当前格式下的画布/素材/成功任务输出和 Agent 数据备份恢复切片已实现。画布 JSON 导出尚未接入 IPC 或 Renderer；旧版“导入为新画布”语义因当前单项目单画布模型而未实现。分组/堆叠命令尚未接入 IPC 或 Renderer；恢复会创建新身份的副本，不覆盖原项目。Agent Worker 接入、跨版本恢复与完整项目升级流程尚未实现。

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

用户从文本节点选择 Agnes 模型后，每个云端任务在进入 TaskStore 前都会显示一次确认，说明将发送当前文本提示词、供应商和可能费用。拒绝不会创建任务。图像和视频当前仅发送文本提示词及模型参数，不上传本地参考素材；返回媒体下载并校验后仍保存在项目任务目录。图像/视频模型目前不支持运行中取消。

## `project.json`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `schemaVersion` | 整数，当前为 `1` | 项目元数据格式版本 |
| `projectId` | UUID 字符串 | 稳定本地项目身份 |
| `canvasId` | UUID 字符串 | 首张画布身份 |
| `name` | 字符串 | 项目显示名称 |
| `createdAt` | ISO 8601 字符串 | 创建时间 |

## `project.sqlite`

数据库使用 `PRAGMA user_version = 5` 标记存储结构版本，并以 WAL、外键和 `synchronous=FULL` 运行。主要表为：

| 表 | 内容 |
| --- | --- |
| `project_metadata` | 稳定 `projectId`、`canvasId` |
| `canvases` | 画布 ID、乐观锁版本和更新时间 |
| `nodes` | 画布 ID、节点 ID、有限位置及完整节点 JSON |
| `edges` | 画布 ID、连线 ID、来源/目标及完整连线 JSON；外键要求两端节点存在 |
| `assets` | 素材 ID、SHA-256、显示名、图片 MIME、大小和项目内相对路径 |
| `asset_references` | 画布图片节点与本地素材的关系；删除节点时级联清除引用 |
| `tasks` | 本地/云端生成任务输入哈希、Idempotency-Key、画布版本、提供方/模型标识、状态、结果路径与哈希、错误码和时间 |
| `task_events` | 任务状态事件的单调序号、类型、JSON 数据和时间 |
| `canvas_graph_commands` | 画布增量命令的 `Idempotency-Key`、操作类型、结果快照和提交版本；用于节点创建/更新/删除与连接命令 |
| `canvas_groups` | 编组 ID、名称、颜色、布局、成员节点 ID 列表及创建/更新时间 |
| `canvas_stacks` | 堆叠 ID、折叠状态、成员节点 ID 列表及创建/更新时间 |

Renderer 仅通过受限 IPC 调用 Electron utility process 读写画布。写入须匹配项目/画布身份；全量保存与节点增删改、连接命令须匹配 `expectedVersion`，节点创建按旧接口允许内部调用省略版本。Local Core 校验连线兼容性、自连接、节点类型、引用及载荷大小，再在 SQLite 事务中提交；这些版本化命令按旧接口推进画布版本。`saveCanvas` 可选接收持久化幂等键，但当前 Renderer 保存 IPC 未传入该键。分组/堆叠七项 Store 命令已通过受限 Main IPC 和 Preload 暴露，写入成员节点关系但不递增画布版本，符合旧 `GraphService` 行为；原 `CanvasPage` 仍需切换到这些桥接方法。桌面全量保存可接收 `groups`/`stacks`；未带字段时会保留 Store 中的记录，显式传入字段（包括空数组或 `null`）时才按快照替换。与旧 `deleteNode` 一致，独立删除节点不会从分组/堆叠的 `node_ids_json` 列表中过滤其 ID。若数据库版本已被其他写者更新，事务回滚并要求重新打开画布。节点创建/更新/删除及显式连接命令的同一幂等键重试返回已提交结果，不重复执行。

`exportCanvas(projectId, canvasId)` 在 Store 内只读生成 interchange JSON：顶层同时写入 `schema_version` 和 `schemaVersion`（当前均为 `1.0.0`），并包含画布、节点、边、groups 与 stacks。图片节点只导出其稳定 `assetId` 引用，不打包素材文件；导出方法目前不经 IPC/Renderer 调用。旧后端 `CanvasService.importCanvas` 会创建另一张新画布并重映射节点/边身份、重置执行状态，但当前 `project_metadata` 仅保存一个 `canvasId`；本地尚无等价导入命令。为防止覆盖当前画布或生成无法解析的跨项目素材引用，画布 JSON 导入保持未实现，等待多画布身份和素材包迁移契约。

文本、图像与视频节点可将当前提示词提交给已配置的本地或 Agnes 模型；选择云端模型并点击生成后直接调用，不逐次弹发送确认。任务输入使用 `Idempotency-Key` 和画布版本；Worker 将输出写入该任务目录，Local Core 校验文件类型、路径、可读性、SHA-256 与大小后才提交 `succeeded`。当前桌面画布按节点保存任务 ID 和状态，从任务文件读取文本结果，预览媒体结果；原版完整结果历史与其他模态仍待迁移。

## 素材首个切片

通过系统文件选择器导入 PNG、JPEG、GIF 或 WebP 图片（每个文件不超过 200 MB）。Local Core 以实际文件签名识别 MIME、流式计算 SHA-256 并复制到 `.vibepaper/assets/<sha256>/<assetId>.<ext>`；相同内容只登记一条素材记录。画布中的图片节点保存稳定 `assetId`，保存画布时素材存在性检查与引用更新位于同一 SQLite 事务。Renderer 只使用受限的 `vibe://app/assets/<assetId>` 资源 URL，Main 通过 Local Core 查到项目内文件后提供只读图片响应。

`user_version = 1` 升级到版本 2 前，会先在 `.vibepaper/backups/` 创建 SQLite 在线快照，再用事务创建素材表和引用表。`user_version = 2` 升级到版本 3 前同样创建回退副本，再用事务增加任务表和事件表。`user_version = 3` 升级到版本 4 前再次创建回退副本，再用事务增加画布命令账本。`user_version = 4` 升级到版本 5 前创建 v4 SQLite 回退副本，再用事务创建 `canvas_groups` 与 `canvas_stacks`。迁移失败时 SQLite 事务回滚，快照保留供恢复；项目备份通过 SQLite 在线快照自动包含两张新表，恢复 v4 备份时会先校验再迁移到当前版本。

## 本地备份与恢复首个切片

画布界面的“备份项目”会先提交待保存的画布改动，再由 Local Core 将 `project.json`、数据库登记且校验通过的素材、Agent 会话/记忆/Skill 文件和 SQLite 在线一致性快照写入新目录的 `.vibepaper/`，生成 `backup-manifest.json`（文件相对路径、字节数和 SHA-256），最后原子改名发布备份目录。SQLite 通过 `node:sqlite` 的在线 backup API 生成快照，不直接复制可能仍处于 WAL 状态的数据库主文件。Agent 数据复制期间由 `.vibepaper/agent/writer.lock` 阻止并发写入；锁已存在或状态不明确时，本次备份失败并提示关闭 Agent 后重试。

“恢复备份副本”从用户选择的项目备份生成新的项目目录，不覆盖已有内容。Local Core 核验 SQLite `integrity_check`、外键、项目/画布关系、素材引用与素材实际字节；存在清单时还逐项核验 SHA-256 和大小。旧格式备份没有清单时仍执行数据库及素材校验。恢复副本获得新的 `projectId`，保留 `canvasId`、节点和连线身份，完成后打开副本。Agent JSONL 首行中的项目身份和会话目录会一并重绑；控制库中的待处理确认置为失效，未完成 Run 标记为中止。打开备份后若对画布或素材作出修改，Local Core 会移除旧备份清单，避免清单与已修改内容不符。

备份清单 schema v2 覆盖项目元数据、项目 SQLite、登记的图片素材、已成功任务结果，以及 `agent/control.sqlite`、Pi JSONL 和受支持的 Markdown/JSON/压缩结果文件；schema v1 备份仍可恢复。Agent 数据总量上限为 4 GiB，符号链接和未识别文件类型会使备份失败。凭据、诊断日志不进入项目备份；Agent schema 升级回退和完整跨版本恢复仍待实现。

首个 JSON 引导版本使用 `.vibepaper/canvas.json`。打开该版本项目且数据库尚不存在时，Local Core 校验 JSON 后在 SQLite 事务中导入；原文件保留为迁移来源，导入成功后 `project.sqlite` 是唯一画布权威。新项目直接创建 SQLite 数据库。

本阶段不承诺向后迁移旧 Web 项目数据。将来提升项目或 SQLite schema 版本时，按根目录 `AGENTS.md` 的备份、可重复迁移和失败回退要求实现。
