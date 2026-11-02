# 桌面插件市场首期验证

2026-11-02，在 macOS ARM64 上使用隔离项目和用户配置进行验证。首期目录随应用交付，也支持本地 JSON 包。Windows、Linux 正式安装包、远程市场及付费生成待另行验收。

| 验证入口 | 观察到的结果 |
| --- | --- |
| TypeScript、完整前端 Vitest、Vite | 编译和生产构建成功。Node 24 开启 Web Storage 并使用临时文件后，32 个测试文件、158 项用例通过。 |
| 市场服务、原项目 Skill、路由测试 | 12 项通过。覆盖选装、停用、升级冲突、回退、保留用户启停及卸载选择、导入校验、项目隔离、真实素材入库与备份恢复。 |
| 画布集成 | 同一模板插入两次后为 14 个节点、12 条边，两次插入之间没有交叉引用。幂等重放不会重复增加节点，过期版本无法覆盖画布。 |
| macOS Electron 桌面流程 | 从工作区打开插件市场，安装四类棚拍组件。从原 Agent 服务读到已启用的商品棚拍 Skill。通过画布工具插入 7 个节点、6 条有效连线，将背景素材添加到画布，向选中图片节点应用提示词预设。重载后共 8 个节点可读，生成任务数为 0。 |
| 打包载荷 | build-package 成功生成独立应用目录，Agent Worker 重启测试通过。使用随项目的 Electron 加载该目录复验上述市场流程。这一步验证安装载荷，不代表安装向导、签名或升级流程通过。 |

![隔离项目中的商品棚拍组件选择页](marketplace.png)

复现时在仓库根目录运行：

```sh
node pi-paper-desktop/scripts/build-package.cjs
node --test pi-paper-desktop/test/marketplace.test.cjs pi-paper-desktop/test/project-agent-skills.test.cjs pi-paper-desktop/test/renderer-trust.test.cjs
node pi-paper-desktop/node_modules/electron/cli.js pi-paper-desktop/scripts/smoke-marketplace.cjs --staged
```

存量测试限制：另跑 project-navigation.test.cjs 时，三项用例在旧 Electron mock 的 app.commandLine.getSwitchValue 处中止。此次市场交付对真实 Electron 使用上述独立项目完成了导航验证。

## 后续能力验证与会话续接

续接本次工作时，先查看 GitHub 默认分支 `feat/desktop-local-migration` 与本次会话 worktree 分支 `codex/plugin-marketplace-mcp` 的提交号，再阅读本页、[设计方案](../../plans/2026-11-02-desktop-plugin-marketplace.md)和[在线目录验证](online-catalog.md)。

- 工作区「插件市场」含棚拍、创作工作室、MCP 连接器三个内置包。本地 JSON、独立 Pi Skill 与在线资源先进入目录，按项目选择组件。在线目录已发布在默认分支。个人与项目预设分层保存，安装、使用和创建生成任务分别验证。
- macOS ARM64 的隔离 Electron GUI 中完成独立 Skill 导入、真实 GitHub 下载、MCP 范围预填、图像素材和预设应用、可编辑海报的本地 PNG 输出以及分镜 CSV 文件读回。打开导演台应用场景、机位与运镜、播放后关闭，从存储重新读到两个对象和 4 秒运镜。全程未创建生成任务。没有使用供应商凭据。
- MCP 设置预填后原服务保持关闭，客户端授权计数为零。另用本机真实 stdio 测试程序验证工具发现、指派、仅发送文本、超时终止及停用拦截。用户选的程序以系统用户身份运行。历史上用户取消的 Claude Code 真实会话测试仍按原记录。
- 修复了桌面保存状态标记吞掉第一次导演编辑的问题。首期记录中未通过的三项导航 mock 用例现已通过。测试区分可编辑相机过渡预览与渲染动画视频。
- 本机另外验证了隔离的未签名 ARM64 应用包内可执行文件的 Agent/SQLite/MCP fixture；这与使用 Electron 打开指定安装资源的 GUI smoke 分别计证据。

**复现。** 依赖就绪后运行 `node pi-paper-desktop/scripts/build-package.cjs`。在线端到端验收运行 `node pi-paper-desktop/node_modules/electron/cli.js pi-paper-desktop/scripts/smoke-marketplace.cjs --staged --online`；省略 `--online` 可检验离线路径。后端使用 Node 24 在真实临时目录运行 `node --test pi-paper-desktop/test/marketplace*.test.cjs`。macOS 下测试若使用符号链接形式的系统临时路径，可设 `TMPDIR=/private/tmp`。前端完整套件在 Node 24 的实验性 Web Storage 和独立临时存储下运行。

**安装包验证已完成。** 在 `848036c` 上，Windows x64 静默安装 NSIS，Linux x64 解开 AppImage，macOS ARM64 与 x64 分别挂载 DMG。四项均通过包内 Electron 可执行文件的 Node 模式自检，并通过测试用 Electron 加载各自安装资源的工作区、市场和画布 GUI 验收。macOS 初次检查遇到挂载目录别名，规范化真实路径后复跑通过。此次未测试图形安装向导、系统签名认可或升级卸载。[四个平台的安装包验收](https://github.com/wsjwu58-cmd/Pi-Paper/actions/runs/41394745725) · [常规 CI](https://github.com/wsjwu58-cmd/Pi-Paper/actions/runs/41394745549) · [Docker 构建](https://github.com/wsjwu58-cmd/Pi-Paper/actions/runs/41394745735)

### 在新会话继续

在 Codex 中把本会话的 `plugin-marketplace-mcp/pi-paper` worktree 选为工作目录，运行 `git status -sb` 确认本地分支为 `codex/plugin-marketplace-mcp`。从同一仓库的其他目录运行 `git worktree list` 可找到这个目录的绝对路径。发布目标是 `origin/feat/desktop-local-migration`。换机器时可在克隆中从该远程分支重建 worktree。

2026-11-02 在该 worktree 的 Node 24 环境重跑前端完整套件，34 个文件、166 项测试通过。桌面侧覆盖市场、连接器、创作组件、在线目录、项目导航、画布校验、项目 Skill 与 Renderer 来源校验，共 64 项通过。从干净检出构建时，先按桌面打包流程恢复公开模型目录（`node pi-paper-desktop/scripts/restore-model-data.cjs`）。

功能提交 `68cebaf` 的独立打包和 `--staged --online` GUI 验收在此 worktree 通过，导演与海报编辑结果可读回，生成任务为零。原工作区针对更早 ARM64 应用包的自检只覆盖该旧包。前端 lint 发现导演组件按钮的普通回调误用了 Hook 命名，改名后前端 lint 退出码为 0。

### macOS ARM64 安装后启动与市场操作（2026-11-02）

在 macOS 26.4.1（25E253）上从 `d3b8a4e` 重建 Pi-Paper 0.1.0 ARM64 DMG。使用该分支的 `electron-builder.cjs`、Electron 44.4.4 和 Node 24.22.1。本机已有的应用与项目保留，验收使用全新的用户配置及项目。

| 操作 | 实测结果 |
| --- | --- |
| 从 DMG 安装 | `hdiutil verify` 通过。只读挂载后用 `ditto` 复制到独立的临时 `Applications/Pi-Paper.app`，弹出映像。复核映像和已安装副本，3,015 个文件及符号链接按相对路径、文件内容或链接目标比较一致。DMG SHA-256 为 `da6f63aa1bf8dac99f6ab1ef4b5811b51b3064db4cb6a12a5a1412c033fc934d`。 |
| 系统正常启动 | 在映像已弹出时，`/usr/bin/open -n -a` 打开复制出的应用，仅传入隔离的 `--user-data-dir`。Launch Services 中的 bundle 路径匹配，WindowServer 观察到该进程的可见主窗口，通过该实例的 `NSRunningApplication` 正常退出并确认进程结束。 |
| 市场选装与画布应用 | 再经 Launch Services 启动同一副本，使用仅监听回环地址的 CDP 操作真实窗口。从原工作区进入市场，在四个棚拍组件中只勾选「商品主图三案」，到原画布插入一次。存储与画布 DOM 均有 7 个节点、6 条连线。三个图片目标各收到公共参考图和各自文本的一条连线。[选装截图](macos-arm64/02-marketplace-template.png) · [应用后画布](macos-arm64/03-canvas-applied.png) |
| MCP 范围预填 | 只安装「Codex 画布连接」，从详情进入原 MCP 设置页。客户端为 Codex，仅勾选读取与编辑画布。读取 Main 状态确认服务关闭、客户端授权为 0，原 TaskStore 中有 0 个任务。[设置截图](macos-arm64/04-mcp-prefill.png) |
| 退出与重启 | 关闭进程后，经 Launch Services 再次启动，点击原工作区的同一项目。两项组件仍启用，节点身份、类型及六条有向连线与退出前一致，MCP 仍关闭，授权与任务均为 0。[重启后的画布](macos-arm64/06-reopened-canvas.png) · [逐项结果及包摘要](macos-arm64/report.json) |
| 签名与系统策略 | 已复制应用通过 `codesign --verify --deep --strict`，签名类型为 ad-hoc，无 Team ID；构建跳过公证。`spctl --assess --type execute` 返回 `rejected`（退出码 3）。本地构建副本可运行，Developer ID / Gatekeeper 分发认可未通过。 |

**复现市场操作。** 在 Apple Silicon Mac 上用 Node 24 运行下列命令，传入已经从 DMG 复制出来的应用和一个单独的证据目录。脚本从已安装资源创建空项目夹具，使用原应用 Main、Renderer 和存储，项目与 Chromium 配置位于证据目录之外。成功退出后清理该夹具。报告中的 DMG 哈希用于关联产物，上表的挂载复制和内容比对单独建立两者的对应关系。

```sh
node pi-paper-desktop/scripts/smoke-installed-marketplace-macos.cjs \
  --app "/absolute/Applications/Pi-Paper.app" \
  --dmg "/absolute/Pi-Paper-0.1.0-mac-arm64.dmg" \
  --output "/absolute/marketplace-evidence"
```

本轮另跑四个市场测试文件，21/21 通过。此阶段覆盖从本地 DMG 复制后的系统启动和自动化图形操作。Finder 人工拖装、带下载隔离标记的首开、覆盖升级及卸载仍待验收。

**MCP 证据范围。** 历史记录已验证真实 Codex 自动连接与读取画布，真实图片曾经 QA relay 表单批准后生成，另有厂商直调视频与原节点媒体读回的独立证据。Codex 自身的原生生成确认到原节点显示仍待完整验收。此次市场预填全程无外部客户端连接、无付费生成；Claude Code 真实会话沿用用户取消本轮验收的决定。[既有 MCP 验收记录](../2026-10-11-mcp-acceptance/README.md)
