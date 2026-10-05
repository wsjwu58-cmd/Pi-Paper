# Pi-Paper Desktop

VibePaper 的单用户桌面版：使用 Electron 运行原 `vibepaper-web` 页面、画布节点和 Agent 面板，在原 Pi TypeScript Agent 上接入本地项目、任务、会话与模型适配。

当前默认分支为 **`feat/desktop-local-migration`**。这是仍在开发和验收的桌面迁移分支，尚未完成全部模块的 1:1 与跨平台安装包验收。工程目录和数据格式继续使用 `vibepaper` / `VibePaper` 标识。

## 快速启动

### 环境与依赖

- Node.js **22.19.0 或更高版本**、npm，以及用于原前端锁文件的 pnpm。
- 首次安装依赖需要联网；桌面正常启动无需 Java 微服务、Docker、PostgreSQL、Redis、Nacos、RocketMQ 或平台账户。
- 本地视频合成及部分媒体处理需要 FFmpeg。可放入 `PATH`，或设置 `VIBEPAPER_FFMPEG_PATH` / `FFMPEG_PATH` 指向可执行文件；未找到时相关能力会显示不可用。
- Windows 本地语音使用 SAPI；其他系统不能据此视为已支持该本地语音模型。

从准备存放仓库的目录执行：

```powershell
git clone --branch feat/desktop-local-migration git@github.com:wsjwu58-cmd/Pi-Paper.git
cd Pi-Paper

npm --prefix pi-main ci
npm --prefix pi-main run build:offline
pnpm --dir vibepaper-web install --frozen-lockfile
npm --prefix vibepaper-desktop ci
```

已有完整依赖和 Pi 构建产物时，不必重复安装。`build:offline` 使用本地模型目录构建 Pi 依赖，不代表后续选择云端模型时不联网。

### 开发模式

从仓库根目录执行：

```powershell
npm --prefix vibepaper-desktop run dev
```

脚本会自动启动 `http://127.0.0.1:5173` 的 Vite Renderer，并等待就绪后启动 Electron。端口被占用时会退出，请先关闭占用该端口的开发服务。直接用浏览器打开 Vite 页面不会获得 Electron 的本地项目桥接能力。

### 使用已构建的界面

```powershell
npm --prefix vibepaper-web run build
npm --prefix vibepaper-desktop start
```

`predev` / `prestart` 会构建独立 Agent Worker 和 Pi 官方媒体适配包。修改原前端后需重新构建或使用开发模式；修改 Main、Preload 或运行时图标后需重启桌面应用。

## 使用入口与当前功能

启动后进入原画布展示页。选择已有本地项目，或新建项目后进入画布创作；历史记录读取本地真实任务，不显示平台点数。

| 模块 | 已接入的桌面能力 |
| --- | --- |
| 画布与节点 | 原文本、图片、视频、音频、导演台与合成节点；连线兼容校验、上下游引用、节点状态、编组及堆叠；画布 JSON 导入/导出 |
| 画布交互 | 选择框编组、水平/垂直排列、取消编组、组内独立拖动及下载；图片单图/四宫格/九宫格裁剪与范围调整；右键删除连线 |
| 素材与结果 | 本地素材导入、预览、引用、重命名、替换、删除及结果下载；支持范围按各媒体入口的实际校验执行 |
| 生成与历史 | 持久化任务、幂等、状态及错误原因；最新任务动画、参考连线流动和计时；本地结果文件核验后回显成功 |
| Agent | 原“小P”角色及工具链，本地画布操作、生成确认、任务状态对账与符合恢复条件的续跑；对话、执行记录和历史时间线 |
| 会话与 Skill | 历史标题、改名、归档/恢复、软删除、空白复制、会话片段；Skill 列表、加载及会话版本快照 |
| 计划与记忆 | 持久计划执行链路与步骤账本；请求预算、Pi 压缩、工作状态及会话/画布/项目/全局/当日记忆，候选记忆审核 |
| Agent 面板 | 短剧资产、生产状态、Token 用量统计、模型与记忆设置 |
| 文本阅读 | Markdown 标题、列表、表格、引用和代码块；双击文本节点打开可选择、滚动的全文阅读框，Escape 关闭 |

以上是已接入链路，不能替代完整原版逐屏、领域规则和真实模型验收。当前仍为**单项目单画布存储**；跨平台、本地 Agent 模型、长上下文压力与全部官方型号的真实账号测试仍有待验收项，详见下方规格文档。

## 模型配置与生成确认

在应用的 **API 配置** 或画布模型菜单的 **自定义配置** 中，选择厂商并配置其要求的凭据、启用模型和默认参数。文本复用 Pi，官方图片、视频、音频调用通过 Pi 媒体适配接入；保留 Agnes、Ark 和本机服务兼容路径，当前不依赖 New API 或 LiteLLM 网关。

- 只有已实现、启用且能力匹配的模型绑定才能调用。展示名称不等于供应商调用 ID，具体输入模式、参考数、分辨率、音色和时长限制以能力目录为准。
- 本机文本服务仅接受 loopback 地址，例如 `http://127.0.0.1:11434/v1`。当前本地文本目录不声明工具调用能力，不能把节点文本生成直接视为完整本地 Agent 支持。
- 云端配置会披露供应商、发送内容范围和可能费用；用户主动选择模型并点击发送/生成。普通云端 API 请求不重复弹逐次系统确认。
- **Agent 提交单个或批量生成仍需明确生成确认**，展示目标、模型、输入和覆盖影响；删除等高风险动作保留相应确认。没有平台点数、冻结、结算或充值。
- 连接检测使用已接入的鉴权探测路径；探测通过也不代表账号具有所有型号的生成权限。尚不支持安全检测的配置会明确提示，检测不会隐式创建付费生成任务。

项目文件保存在本机，但选择云端模型时，请求需要的提示词和已选参考可能发送给供应商。API Key 由受控进程通过系统加密能力保存，不写入项目导出、普通设置或会话正文，也不回读到 Renderer。

## 本地数据、备份与恢复

```text
项目目录/
└─ .vibepaper/
   ├─ project.json           # 稳定项目/画布身份及元数据
   ├─ project.sqlite         # 画布、节点、连线、素材和任务
   ├─ project.lock           # 单写者锁
   ├─ assets/                # 本地素材与派生内容
   ├─ generated/<task-id>/   # 生成结果
   └─ agent/
      ├─ control.sqlite      # Run、确认、计划等控制状态
      ├─ sessions/           # Pi 会话 JSONL
      └─ …                   # Skill、记忆、片段等本地内容
```

项目元数据 `schemaVersion`、SQLite `user_version` 和升级前快照负责版本迁移；原始 Pi 转录与工具调用/结果保持可追溯，压缩摘要不能替代权威画布和任务状态。

- 项目目录移动后可重新打开，路径变化不改变原项目身份。
- 单写者锁阻止两个实例同时写同一项目；遗留锁经进程身份检查后恢复。
- 备份包含一致的项目数据库、登记素材、已核验结果及支持的 Agent 数据；恢复创建独立项目副本，并使旧待确认动作失效。
- 全局记忆和模型凭据位于用户数据范围，不随项目备份迁移；新设备需重新配置凭据。
- 中断恢复先查询本地任务和幂等账本，不盲重放写工具或生成提交。供应商任务是否可取消及继续查询，取决于对应适配器能力；停止本地轮询不等于供应商取消。

桌面版从新本地项目开始，**不导入旧 Web PostgreSQL 业务数据**。Renderer 使用受限 Preload / IPC，无任意磁盘权限；本地核心、生成适配和 Agent 分别在受控进程中运行。

## 图标与安装包状态

主窗口使用 `assets/app-icon.png` 的原有图案，通过 `src/application-icon.cjs` 收紧外部留白，提高主体的可见大小；macOS Dock 同样使用运行时图标。替换素材或修改图标代码后需重启。

安装包配置位于 `electron-builder.cjs`，直接打包原前端构建结果、本地核心、生成 Worker、原 Agent 服务 bundle 和媒体适配；安装包不包含项目、模型凭据或开发依赖。Windows 使用 NSIS（x64），macOS 使用 DMG / ZIP（Intel x64、Apple Silicon arm64），Linux 使用 AppImage / DEB（x64）。产物位于 `release/`，附 SHA256 校验文件。

```powershell
npm --prefix vibepaper-desktop run dist:win
# 以下两条分别在 macOS、Linux 构建机器上运行：
npm --prefix vibepaper-desktop run dist:mac
npm --prefix vibepaper-desktop run dist:linux
npm --prefix vibepaper-desktop run verify:packaged
```

首次构建先为 `pi-main`、`vibepaper-web`、`vibepaper-desktop` 安装锁定依赖，并构建 Pi telemetry、ai、agent-core；可参考 `.github/workflows/desktop-packages.yml`。该流程在三种原生系统打包并使用包内 Electron 检查 SQLite 画布恢复、Agent Skill 和会话片段重启恢复，不需要平台账号或开发工具随包安装。

当前产物为开发验收包：Windows 尚无发行证书，macOS 使用 ad-hoc 签名，尚未 Apple 公证。安装包构建和 Worker 检查不代表完整 UI、真实供应商生成或三平台安装/卸载验收完成。现有本地 FFmpeg 操作继续读取用户配置或系统 FFmpeg，当前不随安装包分发 FFmpeg；本地模型服务同样需用户配置。

## 开发验证

以下命令从仓库根目录执行；会在测试目录或临时目录创建隔离数据，不需要平台账户：

```powershell
npm --prefix vibepaper-web run build
npm --prefix vibepaper-desktop run test:agent-runtime
node --test vibepaper-desktop/test/project-store-canvas-validation.test.cjs
node --test vibepaper-desktop/test/canvas-media.test.cjs vibepaper-desktop/test/node-export.test.cjs
```

桌面测试位于 `test/`，原前端回归位于 `../vibepaper-web/src/`，原 Agent 测试位于 `../pi-main/packages/vibepaper-agent-service/test/`。协议 fixture、Worker 启动检查和前端构建与真实账号生成、长会话续跑及安装包验收分别记录，不能互相替代。最近画布交互修复通过前端构建、20 项定向回归及 32 项本地画布核心测试，见[修复记录](../docs/plans/2026-10-05-canvas-interaction-repairs.md)。

## 工程契约与验收记录

- [AGENTS.md](../AGENTS.md)：桌面工程契约和原源码迁移原则。
- [全服务本地迁移方案](../docs/plans/2026-09-23-desktop-full-service-local-migration-plan.md)。
- [Agent 功能规格](../docs/specs/desktop-agent-functional-spec.md)：会话、确认、计划、压缩、记忆和恢复。
- [UI 保真清单](../docs/specs/desktop-ui-parity.md)与[后端领域对照](../docs/specs/desktop-backend-parity.md)：1:1 验收及遗留缺口。
- [提供方目录](../docs/specs/desktop-provider-registry.md)与[数据契约](../docs/specs/desktop-provider-data-contract.md)：厂商、模型能力、凭据和任务检查点。
- [Pi 官方提供方接入设计](../docs/plans/2026-10-03-pi-official-provider-implementation.md)。
