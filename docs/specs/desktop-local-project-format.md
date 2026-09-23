# 桌面本地数据格式（项目与模型设置）

状态：Electron 项目引导、本地画布存储、首批图片素材导入/引用、任务状态存储与本地文本任务执行，以及当前格式下的画布/素材/成功任务输出备份恢复切片已实现。恢复会创建新身份的副本，不覆盖原项目。Agent 会话、云端凭据、跨版本恢复与完整项目升级流程尚未实现。

## 项目目录

```text
<用户选择的目录>/<项目名>/
  .vibepaper/
    project.json
    project.sqlite
    assets/<sha256>/<assetId>.<ext>
```

不把当前绝对路径写入项目身份。项目搬迁后，用户打开新位置即可通过 `projectId`、`canvasId` 恢复相同项目身份。操作系统用户数据目录保存 `recent-project.json` 和非密钥 `settings.json`；凭据仍不进入普通设置文件。

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

Renderer 只能通过 Main 暴露的配置、发现、保存和移除方法访问此目录项。应用不会自动探测服务；用户点击“读取模型”后，Main 才向 loopback 地址的 `/models` 发起无凭据请求。此设置不进入项目目录或项目备份，也不包含 API Key。文本节点的生成操作会用该目录项创建本地 TaskStore 任务，由独立 Generation Worker 访问 `/chat/completions`；当前仅声明文本能力，不支持工具调用、流式或运行中取消。

## `project.json`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `schemaVersion` | 整数，当前为 `1` | 项目元数据格式版本 |
| `projectId` | UUID 字符串 | 稳定本地项目身份 |
| `canvasId` | UUID 字符串 | 首张画布身份 |
| `name` | 字符串 | 项目显示名称 |
| `createdAt` | ISO 8601 字符串 | 创建时间 |

## `project.sqlite`

数据库使用 `PRAGMA user_version = 3` 标记存储结构版本，并以 WAL、外键和 `synchronous=FULL` 运行。主要表为：

| 表 | 内容 |
| --- | --- |
| `project_metadata` | 稳定 `projectId`、`canvasId` |
| `canvases` | 画布 ID、乐观锁版本和更新时间 |
| `nodes` | 画布 ID、节点 ID、有限位置及完整节点 JSON |
| `edges` | 画布 ID、连线 ID、来源/目标及完整连线 JSON；外键要求两端节点存在 |
| `assets` | 素材 ID、SHA-256、显示名、图片 MIME、大小和项目内相对路径 |
| `asset_references` | 画布图片节点与本地素材的关系；删除节点时级联清除引用 |
| `tasks` | 本地生成任务输入哈希、Idempotency-Key、画布版本、提供方/模型标识、状态、结果路径与哈希、错误码和时间 |
| `task_events` | 任务状态事件的单调序号、类型、JSON 数据和时间 |

Renderer 仅通过受限 IPC 调用 Electron utility process 读写画布。写入须同时匹配项目/画布身份和 `expectedVersion`；Local Core 校验连线引用及载荷大小，再在一个 SQLite 事务中替换节点/连线并递增画布版本。若数据库版本已被其他写者更新，事务回滚并要求重新打开画布。

文本节点可将当前内容作为提示词提交本地文本任务。任务输入使用 `Idempotency-Key` 和画布版本；Worker 输出固定写入该任务目录的 `result.txt`，Local Core 校验文件类型、路径、可读性、SHA-256 与大小后才提交 `succeeded`。面板可读取已校验的文本结果，并由用户操作将结果作为新文本节点追加，不覆盖提示节点。

## 素材首个切片

通过系统文件选择器导入 PNG、JPEG、GIF 或 WebP 图片（每个文件不超过 200 MB）。Local Core 以实际文件签名识别 MIME、流式计算 SHA-256 并复制到 `.vibepaper/assets/<sha256>/<assetId>.<ext>`；相同内容只登记一条素材记录。画布中的图片节点保存稳定 `assetId`，保存画布时素材存在性检查与引用更新位于同一 SQLite 事务。Renderer 只使用受限的 `vibe://app/assets/<assetId>` 资源 URL，Main 通过 Local Core 查到项目内文件后提供只读图片响应。

`user_version = 1` 升级到版本 2 前，会先在 `.vibepaper/backups/` 创建 SQLite 在线快照，再用事务创建素材表和引用表。`user_version = 2` 升级到版本 3 前同样创建回退副本，再用事务增加任务表和事件表。迁移失败时 SQLite 事务回滚，快照保留供恢复。

## 本地备份与恢复首个切片

画布界面的“备份项目”会先提交待保存的画布改动，再由 Local Core 将 `project.json`、数据库登记且校验通过的素材和 SQLite 在线一致性快照写入新目录的 `.vibepaper/`，生成 `backup-manifest.json`（文件相对路径、字节数和 SHA-256），最后原子改名发布备份目录。SQLite 通过 `node:sqlite` 的在线 backup API 生成快照，不直接复制可能仍处于 WAL 状态的数据库主文件。

“恢复备份副本”从用户选择的项目备份生成新的项目目录，不覆盖已有内容。Local Core 核验 SQLite `integrity_check`、外键、项目/画布关系、素材引用与素材实际字节；存在清单时还逐项核验 SHA-256 和大小。旧格式备份没有清单时仍执行数据库及素材校验。恢复副本获得新的 `projectId`，保留 `canvasId`、节点和连线身份，完成后打开副本。打开备份后若对画布或素材作出修改，Local Core 会移除旧备份清单，避免清单与已修改内容不符。

当前备份清单覆盖项目元数据、SQLite、登记的图片素材及已成功任务的校验结果文件。Agent 会话/控制库、凭据、诊断日志和跨版本升级回退仍需后续纳入完整备份与恢复流程；凭据不应进入项目备份。

首个 JSON 引导版本使用 `.vibepaper/canvas.json`。打开该版本项目且数据库尚不存在时，Local Core 校验 JSON 后在 SQLite 事务中导入；原文件保留为迁移来源，导入成功后 `project.sqlite` 是唯一画布权威。新项目直接创建 SQLite 数据库。

本阶段不承诺向后迁移旧 Web 项目数据。将来提升项目或 SQLite schema 版本时，按根目录 `AGENTS.md` 的备份、可重复迁移和失败回退要求实现。
