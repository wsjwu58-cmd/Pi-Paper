# 桌面本地项目格式（阶段 1）

状态：首个 Electron 本地项目切片已实现。此 JSON 格式是阶段 1 的可打开项目引导格式；阶段 2 的本地核心将按备份与回退规则迁移画布权威状态到全服务方案规定的 `project.sqlite`。此格式目前只覆盖空白项目和画布；素材、任务、Agent 会话与备份仍未实现。

## 项目目录

```text
<用户选择的目录>/<项目名>/
  .vibepaper/
    project.json
    canvas.json
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

## `canvas.json`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `schemaVersion` | 整数，当前为 `1` | 画布文件格式版本 |
| `projectId` / `canvasId` | UUID 字符串 | 与项目元数据对应 |
| `version` | 非负整数 | 乐观锁版本，每次成功保存递增 |
| `nodes` | React Flow 节点数组 | 节点 ID 唯一，位置有限，数据为对象 |
| `edges` | React Flow 连线数组 | 连线 ID 唯一，来源和目标必须存在 |

Renderer 仅通过受限 IPC 读写画布。写入须同时匹配项目/画布身份和 `expectedVersion`；Main 校验连线引用及载荷大小，然后在同目录写临时文件、同步落盘并原子替换目标文件。若磁盘版本已由其他进程更新，保存失败并要求重新打开画布。

本阶段不承诺向后迁移旧 Web 项目数据。将来提升 `schemaVersion` 时，按根目录 `AGENTS.md` 的备份、可重复迁移和失败回退要求实现。
