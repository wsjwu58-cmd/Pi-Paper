<div align="center">

# Pi-Paper Desktop

**简体中文** | [English](./README.en.md)

**本地项目优先的 AI 画布创作工具**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Desktop](https://img.shields.io/badge/Electron-Desktop-47848F?logo=electron&logoColor=white)](./pi-paper-desktop/README.md)
[![Branch](https://img.shields.io/badge/default-feat%2Fdesktop--local--migration-339933)](https://github.com/wsjwu58-cmd/Pi-Paper/tree/feat/desktop-local-migration)

<img src="pi-paper-desktop/assets/app-icon.png" alt="Pi-Paper 应用图标" width="140">

Pi-Paper 是一款面向单用户的桌面创作工具。在无限画布上连接文本、图像、视频、音频和创作笔记，与小P（Xiaop）Agent 一起将想法转化为可编辑的创作流程。

**本地项目 → 节点连接 → 生成 → 编辑 → 合成 → 导出**

[下载安装包](#下载) · [桌面版安装与使用](./pi-paper-desktop/README.md) · [迁移与验收状态](./docs/specs/desktop-agent-functional-spec.md)

</div>

---

## 下载

从 [GitHub Releases](https://github.com/wsjwu58-cmd/Pi-Paper/releases/tag/v0.1.0) 下载 **v0.1.0 桌面预发布版**，或使用以下安装包直链。

| 平台 | 架构 / 格式 | 下载 |
| --- | --- | --- |
| Windows | x64 安装程序 | [Pi-Paper-0.1.0-win-x64.exe](https://github.com/wsjwu58-cmd/Pi-Paper/releases/download/v0.1.0/Pi-Paper-0.1.0-win-x64.exe) |
| macOS | Apple Silicon (arm64), DMG | [Pi-Paper-0.1.0-mac-arm64.dmg](https://github.com/wsjwu58-cmd/Pi-Paper/releases/download/v0.1.0/Pi-Paper-0.1.0-mac-arm64.dmg) |
| macOS | Intel (x64), DMG | [Pi-Paper-0.1.0-mac-x64.dmg](https://github.com/wsjwu58-cmd/Pi-Paper/releases/download/v0.1.0/Pi-Paper-0.1.0-mac-x64.dmg) |
| Linux | x86_64, AppImage | [Pi-Paper-0.1.0-linux-x86_64.AppImage](https://github.com/wsjwu58-cmd/Pi-Paper/releases/download/v0.1.0/Pi-Paper-0.1.0-linux-x86_64.AppImage) |
| Linux | Debian / Ubuntu amd64, DEB | [Pi-Paper-0.1.0-linux-amd64.deb](https://github.com/wsjwu58-cmd/Pi-Paper/releases/download/v0.1.0/Pi-Paper-0.1.0-linux-amd64.deb) |

[SHA-256 校验值](https://github.com/wsjwu58-cmd/Pi-Paper/releases/download/v0.1.0/SHA256SUMS.txt) · [构建清单](https://github.com/wsjwu58-cmd/Pi-Paper/releases/download/v0.1.0/build-manifest.json) · [全部版本](https://github.com/wsjwu58-cmd/Pi-Paper/releases)

当前为开发预发布版。Windows 安装包未签名，macOS 安装包尚未通过 Apple 公证。安装与首次运行说明见[桌面版安装与使用](./pi-paper-desktop/README.md)。

## 界面语言

Pi-Paper 支持中文和英文。首次启动时，中文系统语言使用中文，其他系统语言使用英文。Linux 按 `LC_ALL > LC_MESSAGES > LANG` 的顺序解析消息语言，再使用 Electron 语言。可在工作区、画布工具栏或模型设置中选择 **跟随系统 / 中文 / English** 覆盖默认设置。选择会在重启后保留；项目名称与用户内容保持原语言。

## 分支说明

| 分支 | 用途 |
| --- | --- |
| `feat/desktop-local-migration` | **默认分支。** 本地桌面项目、原版画布与 Agent 界面、本地持久化及模型提供方适配 |
| `dev` | 历史 Web 与服务开发基线，保留用于迁移对照 |
| `main` | 历史 Python 服务基线，保留用于对照，不是桌面版启动入口 |

以下说明以默认桌面分支为准。

## 功能概览

| 能力 | 桌面版行为 |
| --- | --- |
| 画布创作 | 原版无限画布，支持平移缩放、六类节点、自动保存、连线规则、上游引用和 JSON 导入导出 |
| 小P（Xiaop）Agent 助手 | 保留原版创作角色与工具链，支持感知画布的对话、进度展示、执行记录和本地会话历史 |
| 多模态生成 | 通过已实现的模型绑定执行文本、图像、视频、音频和合成任务；任务状态与具体失败原因在对应节点展示 |
| 受控创作流程 | Agent 经本地工具网关修改画布；单个和批量生成均需确认，恢复前查询持久化任务与幂等记录 |
| 短剧制作 | 本地故事、角色和镜头素材，制作状态、引用、关键帧、视频及合成依赖 |
| 素材与参考库 | 导入支持的本地媒体，预览、引用、重命名、替换和下载素材或结果，保留从来源到结果的关联 |
| 画布组织 | 框选与分组、横向或纵向排列、独立拖动组内节点、取消分组和分组下载 |
| 图像裁剪 | 可调整的单图、四宫格与九宫格裁剪，结果生成可编辑的分组节点 |
| 生成反馈 | 参考预览、生成背景动画、耗时展示，以及蓝色参考连线上的白色流动高亮 |
| 文本阅读 | Markdown 标题、列表、表格、引用和代码块；双击文本节点可打开大尺寸、可滚动的阅读视图 |
| 会话、Skill 与记忆 | 会话标题与管理、可复用片段、Skill 快照、持久化计划、上下文压缩、分范围记忆和记忆候选审核 |
| 本地项目管理 | 画布展示、真实本地任务历史、项目封面、备份与恢复；当前每个项目存储一个画布 |
| 模型配置 | 用户配置官方提供方凭据和模型默认参数，兼容 Agnes、Ark 及本地文本服务；可选能力以已实现的目录为准 |

桌面版无需平台登录、点数、计费结算、企业账户或创意广场发布。云端提供方可能对 API 请求收费。本地保存项目不代表所选提示词和参考媒体不会发送给用户选择的云端提供方。

## 桌面版展示

应用启动后进入画布展示。新建或打开本地项目后，进入原版画布编辑器与 Agent 面板。生成内容保存在项目中，可从导航查看本地任务历史。

### 画布与 Agent 创作流程

在本地项目中连接角色参考、关键帧、视频片段和合成节点，画布旁同步展示 Agent 对话。

<p align="center">
  <img src="docs/images/desktop-canvas-workflow.png" alt="Pi-Paper 桌面画布，展示角色参考、生成片段、合成与 Agent 面板" width="880">
</p>

### 模型提供方配置

在桌面版 API 配置页填写官方提供方凭据、启用已实现模型并设置默认参数。凭据在设备上加密保存，不回读到表单。

<p align="center">
  <img src="docs/images/desktop-provider-configuration.png" alt="Pi-Paper 桌面 API 配置，展示提供方选择、隐藏凭据输入、模型能力和连接检测" width="880">
</p>

## 仓库结构

```text
pi-paper-desktop/      # 桌面宿主、本地项目与任务服务、IPC 及测试
pi-paper-web/          # 原版页面、画布节点、编辑器与 Agent 面板
pi-main/               # Pi 源码，包含桌面 Agent 与官方媒体适配
  packages/vibepaper-agent-service/  # 原 TypeScript Agent 与本地适配
  packages/ai/         # 文本与官方媒体提供方接口
  packages/coding-agent/ # Pi 会话、Skill 与上下文压缩支持
docker/                # noVNC 运行环境、密码初始化与部署指南
Dockerfile             # 完整 Linux 桌面的多阶段构建
docker-compose.yml     # 带持久卷的单用户桌面
docs/                  # 桌面契约、对照清单、计划与验收证据
AGENTS.md              # 当前桌面版工程契约
```

桌面分支已取消跟踪旧 Java、Python 服务和旧 Web 部署文件。当前 Docker 文件用于通过 noVNC 运行本地桌面。原实现保留在 Git 历史中供迁移对照，详见[源码边界与恢复说明](./docs/specs/desktop-source-boundary.md)。现有本地副本保留并忽略。

## Docker / 浏览器访问

在 Linux 容器中运行当前 Electron 桌面，并通过 noVNC 访问完整桌面。它使用原版画布、本地服务与 Agent；项目数据保存在 Docker 主机的持久卷中。

```bash
docker run --rm -v "${PWD}:/workspace" -w /workspace node:24-bookworm-slim node docker/create-secrets.cjs
docker compose up -d --build --wait --wait-timeout 180
```

打开 **http://127.0.0.1:8080/vnc.html**，输入生成的 noVNC 密码。在 `/projects` 中创建项目。镜像包含 FFmpeg 与加密系统密钥环；升级时需保留两个 Docker 持久卷和 `docker/secrets/`。详见 [Docker 配置、远程访问、存储与验证](./docker/README.md)。

## 快速开始

### 环境要求

- Node.js **22.19.0 或更新版本**、npm，以及用于前端锁文件的 pnpm。
- 首次安装依赖，以及用户主动选择的云端模型调用，需要网络连接。
- 本地视频合成与相关媒体处理需要 FFmpeg。设置 `VIBEPAPER_FFMPEG_PATH` / `FFMPEG_PATH`，或将 FFmpeg 加入 `PATH`。
- 当前 Windows 本地语音路径使用 Windows SAPI，尚不是跨平台语音实现。

桌面启动无需 Java 服务、Docker、PostgreSQL、Redis、Nacos、RocketMQ 或平台账户。可从 [GitHub Releases](https://github.com/wsjwu58-cmd/Pi-Paper/releases/tag/v0.1.0) 下载安装包。Windows 包含运行时图标修复；macOS 提供 Intel 和 Apple Silicon DMG；Linux 提供 AppImage 和 DEB。当前为开发预发布版，尚无 Windows 分发签名与 Apple 公证。

### 安装依赖

```powershell
git clone --branch feat/desktop-local-migration git@github.com:wsjwu58-cmd/Pi-Paper.git
cd Pi-Paper

npm --prefix pi-main ci
node pi-paper-desktop/scripts/restore-model-data.cjs
npm --prefix pi-main run build:offline
pnpm --dir pi-paper-web install --frozen-lockfile
npm --prefix pi-paper-desktop ci
```

`build:offline` 使用本地模型数据构建 Pi 依赖，不改变后续模型请求使用本地还是云端提供方。

### 启动桌面应用

在仓库根目录启动开发模式：

```powershell
npm --prefix pi-paper-desktop run dev
```

该命令在 `http://127.0.0.1:5173` 启动 Vite，Renderer 就绪后启动 Electron。需确保端口可用。用普通浏览器打开该地址无法获得桌面项目桥接能力。

使用构建后的 Renderer 启动：

```powershell
npm --prefix pi-paper-web run build
npm --prefix pi-paper-desktop start
```

桌面版 `predev` / `prestart` 钩子会自动构建 Agent Worker 和 Pi 官方媒体包。修改前端后需重新构建 Renderer；修改 Main、Preload 或运行时图标后需重启 Electron。

### 配置模型并开始创作

1. 打开 **API 配置**，或画布模型菜单中的 **自定义配置**。配置提供方、启用已实现模型并设置默认参数。
2. 从 **画布展示** 新建或打开本地项目。
3. 添加节点并连接参考素材，或让小P整理画布。Agent 生成请求在明确确认后才提交。
4. 在节点中查看结果与错误、下载输出，并在 **历史记录** 查看本地任务。

只有已实现、已启用且能力匹配的模型绑定可以调用。凭据检测成功不代表拥有全部模型的生成权限。本地文本端点仅允许 loopback 地址，当前目录未声明其支持 Agent 工具调用。

云端 API Key 由受控进程与系统加密能力处理，不暴露给 Renderer，也不进入项目导出。模型配置会说明提供方、发送数据与可能费用，普通消息无需反复确认 API 发送；Agent 生成和高风险操作仍保留各自的确认流程。

本地文件结构、项目移动、单写者锁、备份、恢复和验证命令见[桌面版 README](./pi-paper-desktop/README.md)。

## 验收状态

- 最近的画布交互修复通过前端构建、20 项专项前端回归及 32 项本地画布核心测试。在隔离的桌面项目中检查了窄窗口菜单、连线删除持久化、生成动画 fixture 与文本阅读。
- 协议 fixture 和 UI 检查不能替代真实账号生成或长时间 Agent 恢复验收。
- 待完成验收包括原版 UI 与领域能力完整对照、所有支持的官方模型账号与输入模式、本地 Agent 能力、长上下文压力，以及各目标操作系统中的安装包手工验收。原生安装包构建与打包后重启检查已通过；Docker/noVNC 有独立的构建与浏览器验证流程。

当前契约与证据：

- [桌面版工程契约](./AGENTS.md)
- [桌面版安装与使用](./pi-paper-desktop/README.md)
- [UI 对照清单](./docs/specs/desktop-ui-parity.md)与[后端领域对照](./docs/specs/desktop-backend-parity.md)
- [Agent 功能规格](./docs/specs/desktop-agent-functional-spec.md)
- [提供方目录](./docs/specs/desktop-provider-registry.md)与[提供方数据契约](./docs/specs/desktop-provider-data-contract.md)
- [画布交互修复证据](./docs/plans/2026-10-05-canvas-interaction-repairs.md)

## 项目说明

- Pi-Paper 是为个人学习与实验独立开发的项目，与历史材料中提及的商业产品无官方关联。
- 桌面行为遵循当前桌面契约。旧 Web PRD 仅用于对照，旧服务与部署文件可在 Git 历史中查看。
- 迁移期间接口与行为可能调整，欢迎提供可复现桌面场景的 Issue 和 Pull Request。

## 许可证

[MIT](./LICENSE) © 2026 ShiJie Wu
