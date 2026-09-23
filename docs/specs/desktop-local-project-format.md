# 桌面本地项目格式（阶段 1–2）

状态：Electron 项目引导和 `project.sqlite` 画布存储首个切片已实现。此格式目前只覆盖空白项目和画布；素材、任务、Agent 会话、凭据、备份和项目升级仍未实现。

## 项目目录

```text
<用户选择的目录>/<项目名>/
  .vibepaper/
    project.json
    project.sqlite
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

数据库使用 `PRAGMA user_version = 1` 标记存储结构版本，并以 WAL、外键和 `synchronous=FULL` 运行。主要表为：

| 表 | 内容 |
| --- | --- |
| `project_metadata` | 稳定 `projectId`、`canvasId` |
| `canvases` | 画布 ID、乐观锁版本和更新时间 |
| `nodes` | 画布 ID、节点 ID、有限位置及完整节点 JSON |
| `edges` | 画布 ID、连线 ID、来源/目标及完整连线 JSON；外键要求两端节点存在 |

Renderer 仅通过受限 IPC 调用 Electron utility process 读写画布。写入须同时匹配项目/画布身份和 `expectedVersion`；Local Core 校验连线引用及载荷大小，再在一个 SQLite 事务中替换节点/连线并递增画布版本。若数据库版本已被其他写者更新，事务回滚并要求重新打开画布。

首个 JSON 引导版本使用 `.vibepaper/canvas.json`。打开该版本项目且数据库尚不存在时，Local Core 校验 JSON 后在 SQLite 事务中导入；原文件保留为迁移来源，导入成功后 `project.sqlite` 是唯一画布权威。新项目直接创建 SQLite 数据库。

本阶段不承诺向后迁移旧 Web 项目数据。将来提升项目或 SQLite schema 版本时，按根目录 `AGENTS.md` 的备份、可重复迁移和失败回退要求实现。
