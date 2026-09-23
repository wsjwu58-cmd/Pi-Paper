# 桌面本地项目格式（阶段 1–2）

状态：Electron 项目引导、本地画布存储、首批图片素材导入/引用及当前格式下的画布/素材备份恢复切片已实现。恢复会创建新身份的副本，不覆盖原项目。任务、Agent 会话、凭据、跨版本恢复与完整项目升级流程尚未实现。

## 项目目录

```text
<用户选择的目录>/<项目名>/
  .vibepaper/
    project.json
    project.sqlite
    assets/<sha256>/<assetId>.<ext>
```

不把当前绝对路径写入项目身份。项目搬迁后，用户打开新位置即可通过 `projectId`、`canvasId` 恢复相同项目身份。操作系统用户数据目录目前只保存最近打开目录索引，不保存 API Key。

## `project.json`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `schemaVersion` | 整数，当前为 `1` | 项目元数据格式版本 |
| `projectId` | UUID 字符串 | 稳定本地项目身份 |
| `canvasId` | UUID 字符串 | 首张画布身份 |
| `name` | 字符串 | 项目显示名称 |
| `createdAt` | ISO 8601 字符串 | 创建时间 |

## `project.sqlite`

数据库使用 `PRAGMA user_version = 2` 标记存储结构版本，并以 WAL、外键和 `synchronous=FULL` 运行。主要表为：

| 表 | 内容 |
| --- | --- |
| `project_metadata` | 稳定 `projectId`、`canvasId` |
| `canvases` | 画布 ID、乐观锁版本和更新时间 |
| `nodes` | 画布 ID、节点 ID、有限位置及完整节点 JSON |
| `edges` | 画布 ID、连线 ID、来源/目标及完整连线 JSON；外键要求两端节点存在 |
| `assets` | 素材 ID、SHA-256、显示名、图片 MIME、大小和项目内相对路径 |
| `asset_references` | 画布图片节点与本地素材的关系；删除节点时级联清除引用 |

Renderer 仅通过受限 IPC 调用 Electron utility process 读写画布。写入须同时匹配项目/画布身份和 `expectedVersion`；Local Core 校验连线引用及载荷大小，再在一个 SQLite 事务中替换节点/连线并递增画布版本。若数据库版本已被其他写者更新，事务回滚并要求重新打开画布。

## 素材首个切片

通过系统文件选择器导入 PNG、JPEG、GIF 或 WebP 图片（每个文件不超过 200 MB）。Local Core 以实际文件签名识别 MIME、流式计算 SHA-256 并复制到 `.vibepaper/assets/<sha256>/<assetId>.<ext>`；相同内容只登记一条素材记录。画布中的图片节点保存稳定 `assetId`，保存画布时素材存在性检查与引用更新位于同一 SQLite 事务。Renderer 只使用受限的 `vibe://app/assets/<assetId>` 资源 URL，Main 通过 Local Core 查到项目内文件后提供只读图片响应。

`user_version = 1` 升级到版本 2 前，会先在 `.vibepaper/backups/` 创建 SQLite 在线快照，再用事务创建素材表和引用表。迁移失败时 SQLite 事务回滚，快照保留供恢复。

## 本地备份与恢复首个切片

画布界面的“备份项目”会先提交待保存的画布改动，再由 Local Core 将 `project.json`、数据库登记且校验通过的素材和 SQLite 在线一致性快照写入新目录的 `.vibepaper/`，生成 `backup-manifest.json`（文件相对路径、字节数和 SHA-256），最后原子改名发布备份目录。SQLite 通过 `node:sqlite` 的在线 backup API 生成快照，不直接复制可能仍处于 WAL 状态的数据库主文件。

“恢复备份副本”从用户选择的项目备份生成新的项目目录，不覆盖已有内容。Local Core 核验 SQLite `integrity_check`、外键、项目/画布关系、素材引用与素材实际字节；存在清单时还逐项核验 SHA-256 和大小。旧格式备份没有清单时仍执行数据库及素材校验。恢复副本获得新的 `projectId`，保留 `canvasId`、节点和连线身份，完成后打开副本。打开备份后若对画布或素材作出修改，Local Core 会移除旧备份清单，避免清单与已修改内容不符。

当前备份清单只覆盖项目元数据、SQLite 与登记的图片素材。任务、Agent 会话、凭据、诊断日志和跨版本升级回退仍需后续纳入完整备份与恢复流程。

首个 JSON 引导版本使用 `.vibepaper/canvas.json`。打开该版本项目且数据库尚不存在时，Local Core 校验 JSON 后在 SQLite 事务中导入；原文件保留为迁移来源，导入成功后 `project.sqlite` 是唯一画布权威。新项目直接创建 SQLite 数据库。

本阶段不承诺向后迁移旧 Web 项目数据。将来提升项目或 SQLite schema 版本时，按根目录 `AGENTS.md` 的备份、可重复迁移和失败回退要求实现。
