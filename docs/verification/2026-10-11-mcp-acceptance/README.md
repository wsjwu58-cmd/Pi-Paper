# MCP 真实客户端、账号与 Windows 交付验收

2026-10-11 开始，2026-10-15 接续收尾。以下按实际证据分别判定，完整产品验收仍未完成。用户指定使用 Agnes Video 2.5 Flash，并要求先测 Windows；没有 macOS/Linux 测试机器。Claude Code 真实会话按用户最新要求取消本轮验收。

10-15 按用户要求整合 GitHub `feat/desktop-local-migration` 的既有改动，当前源码目录为 `pi-paper-web` / `pi-paper-desktop`。原验收 JSON、截图与运行路径保留，不回写成新目录下的实测。合并中修复了 Agent 控制库 schema 11 被旧备份校验拒绝的问题；[合并复核记录](merge-feat-2026-10-15.json)另列 101 项桌面、19 项记忆恢复及 10 项前端回归，计数不与历史集合累加。

| 项目 | 当前结果 | 证据及边界 |
| --- | --- | --- |
| 独立桌面专项回归 | 128/128 通过，0 跳过 | [完整日志](reviewer-tests.log)；含媒体权限、文本分页、多输出、MIME/摘要、文件路径/junction、大小、取消、凭据及生成确认 |
| Pi 完整工程检查 | 通过 | [复核记录](pi-check-rerun.txt)；首次受限运行的 esbuild spawn EPERM 在允许本地子进程后消失；恢复无关格式化修改 |
| Agnes 图片真实生成 | 通过 | [真实账号记录](agnes-real-account.json)、[生成结果](agnes-real-image.png)、[原节点截图](agnes-image-result-on-original-canvas.png) |
| Agnes Video 2.5 Flash | 第三次真实生成通过 | [账号记录](agnes-real-account.json)、[真实 MP4](agnes-real-video.mp4)、[历史队列诊断与恢复](agnes-video-queue-diagnosis.json)；4 秒/720P 请求，1,070,236 bytes，约 9 分钟生成，模型与参数未更换 |
| 真实 Codex | 本地生成完整回合经审查通过；自动脚本末尾误判保留 | [审查结论](codex-real-session-review.json)、[10-15 原始记录](client-acceptance-2026-10-15T07-41-19-174Z.json)、[原节点结果](codex-result-on-original-canvas.png)；真实 CLI 完成配对、2 图片节点/1 连线、桌面确认、本地文本任务及结果读取。原 JSON 保留 false：最后撤销断言把历史行保留误当撤销失败；不是云端图片/视频全链路通过 |
| 真实 Claude Code | 用户取消本轮验收 | 历史配对已完成，但模型 HTTP 402；不将配对或 SDK fixture 计作真实会话通过，不再请求账户或重试 |
| MCP 实际图片读取 | 通过 | [读取记录](mcp-real-image-read.json)、[重开原节点截图](mcp-real-image-read-original-canvas.png)；新无凭据 profile，实际 Main/Local Core IPC + SDK，853,173 bytes 与 TaskStore 摘要一致 |
| MCP 实际视频读取 | 真实 Flash MP4 通过 | [真实读取记录](mcp-real-video-read.json)、[原视频节点截图](mcp-real-video-read-original-canvas.png)；新无凭据 profile，经 Main/Local Core/SDK 返回 1,070,236 bytes，摘要匹配；FFmpeg 全片解码与原节点播放 17 帧通过。早期[本地 MP4 fixture](mcp-local-video-read.json)另存 |
| Windows NSIS 安装包 | 实际静默升级、注册核对、已安装运行及重开通过 | [升级记录](windows-installed-upgrade.json)、[重开画布截图](installed-canvas-after-reopen.png)；用户授权后更新 `E:\pp\Pi-Paper`，9 个关键文件摘要匹配最终载荷，包内 Node stdio、原生配对、2 节点/1 连线及幂等/UI 同步通过；手工安装向导和卸载未验收 |
| 本轮凭据清理与秘密扫描 | 通过，范围限定本轮隔离资料 | [记录](credential-hygiene.json)；原 IPC 清除测试凭据并撤销测试授权，10-13 退出后扫描 97 个测试 profile/证据文件无明文 Key；保留项目及输出 |
| macOS/Linux | 本轮未验收 | 用户没有机器，并指定先测 Windows |

## 真实账号链路

用户提供 Agnes Key 后，经无回显 stdin 临时进入已授权环境变量映射，再由 MCP 的 sourceRef 输入链路写入 Windows safeStorage 加密凭据。未写入源码、命令参数、MCP 配置导出或验收文档；外部聊天已包含用户输入原文，VibePaper 无法删除或保证该外部副本脱敏。

实际运行原 Main、原设置页、原画布及原确认卡。提供方发送披露和单次生成确认分别完成。Agnes 安全鉴权检测明确返回 unsupported，没有隐式生成。图片账号有效性由真实成功生成证明，不能称为独立鉴权探测通过。

图片使用 `agnes-image-2.5-flash`，一张 1K、1:1 输出。任务成功后文件已落盘，原图片节点显示；1024×1024 PNG，853,173 bytes，SHA256 `3f5641ce429f9c896b530a2875d09a7ffe2df763491085b995e9f896f3b0b716`。精确提案重放查回原任务。

视频三次实际请求均按 [Agnes Video 2.5 Flash 官方文档](https://www.agnes-ai.com/zh-Hans/docs/agnes-video-25-flash)：`POST https://apihub.agnes-ai.com/v1/videos`，模型 `agnes-video-2.5-flash`，mode=text，seconds="4"，size="720P"，aspect_ratio="16:9"，n=1，无参考媒体。前两次供应商返回 HTTP 503：`video queue is full, please retry later`；10-13 第三次成功。

| 本地任务完成时间（UTC） | 本地状态 | 最后上游请求关联号 |
| --- | --- | --- |
| 2026-10-11 13:35:25.028 | failed / CLOUD_REQUEST_FAILED | `2026101113352410173936e347JoWg` |
| 2026-10-12 11:29:49.296 | failed / CLOUD_REQUEST_FAILED | `202610121129472908615275ffs6A6W` |
| 2026-10-13 08:39:57.927 | succeeded，文件已落盘 | 成功视频见账号及媒体读取记录；非队列拒绝响应 |

前两次是创建任务端的明确队列拒绝，没有返回 video_id，未进入视频轮询或本地下载。官方文档把参数校验失败列为 HTTP 400；第三次使用同一 Key、同一模型及同一参数成功，因此证据与供应商暂时队列/容量问题一致，排除了持续的参数或凭据错误。供应商没有解释具体是全站、模型池还是账号级队列，不能断言内部根因。客户端轮询频率没有被作为修复手段。

第二次和第三次均先查本地权威失败状态，再经新的原桌面确认提交。第三次因上轮已清理凭据，重新经授权 sourceRef、原供应商披露写入测试 Key。未更换收费模型、未重新生成图片。既有 legacy Worker 对 503 有短暂退避重试；本地任务只保留最后拒绝，不能从现有证据声称精确 HTTP 请求次数。第三次生成结果为 MP4，1,070,236 bytes，SHA256 `7a1e6bb89e38b6a763f4eab0d3f5c43dfae2fa8a0344ac5b7cdc71899c927a76`。精确提案重放查回原任务，未提交第二条成功视频。

10-15 使用新无凭据 profile 重开同一项目，video-only media.read 授权经实际 SDK stdio 读取 metadata 与 resource blob。返回大小和 SHA256 与项目文件、TaskStore、账号验收副本一致，默认 metadata 不含磁盘路径或字节。FFprobe 实测 1280×720，视频流 4.458333 秒，容器/音轨 4.48 秒；这是 4 秒请求的实际输出时长。FFmpeg 全片解码成功，原 Canvas 视频加载真实任务 URL 并播放约 711ms，呈现 17 帧后暂停截图；审查者查看截图确认原节点真实画面。此次未访问提供方凭据或发起云端请求。

媒体补验脚本最初错误要求项目内 `result.mp4` 与验收副本 `agnes-real-video.mp4` 同名，尚未启动 UI 就失败。已改为核对两份文件内容的大小和 SHA256，保留项目原文件名，随后上述链路通过；这次修复仅涉及验收脚本。视频通过标准 MCP 嵌入 resource blob 返回，真实客户端自身如何展示/消费该资源仍取决于客户端能力，SDK 验证不等于 Codex/Claude 原生视频预览验收。

退出前清理时遇到一次仍打开的 SQLite 文件扫描 EBUSY；[失败记录](agnes-cleanup-harness-failure.json)保留，不作为供应商失败原因。调整为应用退出后扫描，最终清理与扫描通过；[账号汇总](agnes-real-account.json)从 SQLite tasks/task_events 只读复核，未改任务状态。

## 真实 Codex 回合与脚本误判

10-15 使用 Codex CLI 0.154.0 的真实模型回合，按自然语言请求调用 MCP；退出码 0，收到 turn.completed，观察到 10 种工具、11 个结果。持久化画布校验确认新增 2 个图片节点及唯一参考→目标连线，原文本节点仍在。模型第一次把模态 text 当成型号，Main/Worker 明确返回 MODEL_NOT_FOUND；同一回合自行改选本地 fixture 模型，原桌面确认后仅产生 1 次本地请求，任务 succeeded，并通过 MCP 读回结果。审查者查看截图，确认输出显示在原文本节点中。截图未完整展示两个图片节点及连线，其存在由持久化画布断言证明。

[原始记录](client-acceptance-2026-10-15T07-41-19-174Z.json)仍为 success=false：结果截图之后，脚本最后错误要求撤销客户端从列表消失。实际控制存储保留历史行、设置 revokedAt 并断开连接，Main 的状态接口也保留该行。已修正 QA 断言并通过语法检查，未改生产代码、未再次调用模型。原运行未记录撤销后的公开状态，临时 fixture 已被原脚本清理，所以不能补记该运行的撤销断言通过。[独立审查结论](codex-real-session-review.json)只接受已被结构化结果、源码和截图证明的本地核心流程，不将原始自动结果改成通过。

原 image 节点 DOM 诊断以提示词文本匹配导致零匹配，已改为使用仅保留在内存中的节点关联与元素矩形；此 QA 改动同样未重跑。Codex 自然语言配置真实图片/视频凭据、官方媒体完整回合、客户端原生媒体预览和已安装包内真实客户端全链路仍未验收。此前 10-13 中途额度拒绝和 10-15 本地 fixture 脚本错误均保留历史记录，不与此次真实任务完成混为一谈。

10-15 另复跑现有 `mcp-review-main.test.cjs`，12/12 通过，包含撤销后立即拒绝活跃连接、CAS/保存屏障、重启确认失效和断线配对取消。这是原 128 项集合中定向复跑的 12 项，不累加计数，也不能代替修正后真实 CLI 清理断言的重跑。首次受限环境在测试运行器创建子进程时遭 EPERM，允许本地子进程后的复跑通过；两份 QA 脚本语法检查和视频/安装器交付摘要复核也通过。

## 验收方式与限制

真实账号和媒体读取脚本的连接批准使用受控测试替身；生成确认点击原 Renderer 卡。Windows 最终包测试通过 Windows UI Automation 定位当前测试进程的原生配对对话框、核对短码并点击批准，未替换配对逻辑。实际客户端脚本须证明真实 CLI 模型 turn 与 MCP 调用，而非直接 SDK 编排。账号生成、客户端本地模型 fixture、正式包内运行是三类独立证据，不能相互替代。

MCP 媒体默认返回元数据；显式 preview 且有 task.read/media.read/对应 mediaTypes 时才传字节。图片限 4 MiB、视频限 8 MiB；超限拒绝。文本支持 Unicode 字符分页，outputIndex 范围 0–3。当前没有任意路径读取或大视频流式传输。

测试项目和 profile 使用 `.test-temp` 唯一目录。用户明确批准后，使用最终 NSIS 安装器 `/S /D=E:\pp\Pi-Paper` 更新既有 Windows 安装，退出码 0；已安装可执行文件和 8 个关键资源的 SHA256 与最终载荷一致。安装前后注册项一致且指向现有安装；版本号仍为 0.1.0，不能仅凭版本号判定升级。实际已安装程序以标准 `--user-data-dir` 隔离创作测试，从原 Workspace 进入 Canvas，正常关闭重启后同一画布仍有 2 节点和 1 连线。日常用户数据目录仍存在，顶层条目数保持 30；未删除或测试写入日常项目。

原生安装向导控制的 Orca UI runtime 返回 `runtime_open_timeout`，使用本地 electron-builder NSIS 模板支持的静默模式完成授权升级。因此静默安装、注册核对和已安装程序运行有实际证据；手工向导页面/选项、卸载和签名可信度仍未验收。供复核的安装器与摘要在 [交付目录](../../../output/mcp-windows-2026-10-12/README.md)。
