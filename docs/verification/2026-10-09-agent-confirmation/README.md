# Agent 生成确认按钮溢出修复

用户在新项目中提交香水广告生成请求，顶部已显示「待确认生成」卡片，但看不到确认和取消按钮，输入区因待确认状态被锁定。

## 原因与修复

原 `AgentPanel` 的确认卡片位于 `SoftCollapse` 动画中。Grid 只有行轨道定义，默认列的自动最小尺寸使长标题撑宽内容；展开完成后内容恢复 `overflow: visible`，确认按钮被挤出窗口。隔离原面板复现中，380px 面板的卡片内容宽度达到 8541px，两个按钮都不可见、不可命中。

在原 `canvas-motion.css` 为 `.vp-soft-collapse` 设置 `grid-template-columns: minmax(0, 1fr)`，并为 Grid 及其直接内容设置 `min-width: 0`。保留原确认卡片布局、按钮回调、确认令牌和提交中禁用行为。

## 验证

- 前端 TypeScript 与 Vite 构建通过。
- `confirmationState`、`confirmationVersion`、`agentDeletionConfirmation`、`agentEventHandlers` 四个测试文件共 41 项通过。
- `vibepaper-desktop/scripts/smoke-agent-confirmation.cjs` 使用实际原 `AgentPanel`、构建样式和隔离 Electron profile。覆盖中文/英文、300/380/720px、100%/150% 缩放以及生成/删除预览，共 24 种布局组合；380px 生成用例包含 24 个待生成目标。
- 每个布局用例核对卡片无横向溢出，两个按钮完全在面板内，并通过 `elementFromPoint` 验证可命中。实际点击确认/取消，检查回调收到正确动作和令牌、提交中禁止重复点击、终态后输入区解锁。
- 使用本机安装目录中修复后的实际 CSS 重跑同一布局与交互检查，结果保存为 `installed-smoke.json`。
- 测试会话与确认响应为 fixture，不调用真实 Agent 或模型，不创建生成任务；网络请求数为零。不作为真实账号生成、重启恢复或 macOS/Linux 安装包的验收证据。

## 证据

- `layout-failure.png` / `layout-failure.json`：修复前按钮位于窗口外的截图与尺寸。
- `confirmation-fixed.png` / `smoke.json`：源码构建样式修复后的截图、24 个布局及交互记录。
- `installed-confirmation-fixed.png` / `installed-smoke.json`：安装版实际 CSS 的隔离验证。
- `installed-patch.json`：本机单个 CSS 补丁路径、备份路径与修复前后 SHA-256。

## 本机生效与复测

本机运行版本位于 `E:\pp\Pi-Paper`。仅修改该安装目录中的一个 Renderer CSS 文件，并在同目录保留原样式备份；不修改项目、任务、会话和凭据，也不关闭正在运行的应用。重新打开应用后加载修复样式。源码路径均通过相对目录解析，本机安装路径只记录在本次部署证据中。

源码复测先运行 `npm --prefix vibepaper-web run build`，再用 Electron 运行 `vibepaper-desktop/scripts/smoke-agent-confirmation.cjs`。可传入 `--stylesheet=<CSS绝对路径>` 验证特定安装版的样式。脚本窗口保持隐藏、使用独立 profile；在 Windows 自动化中应通过 `Start-Process -WindowStyle Hidden -Wait -PassThru` 等待进程退出并核对退出码。
