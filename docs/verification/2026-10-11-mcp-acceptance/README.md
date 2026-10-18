# MCP 真实客户端、账号与 Windows 交付验收

> 2026-10-17 用户更新确认策略：连接、配置和安全测试无人工确认，生成改在 Codex 等客户端 form 确认。下列桌面配对、披露批准与桌面生成确认的历史证据继续保留，不能据此宣称新流程已验收；新流程的协议与真实客户端结果另行记录。

新策略 [103 项 MCP 回归](client-confirmation-tests-20261017.log)通过。[真实 Codex 配置运行](codex-agnes-acceptance-2026-10-17T12-06-32-275Z.json)确认原 Main 返回配置 `saved`、检测 `unsupported`，没有原生批准窗口或媒体任务；凭据清除、授权撤销及退出后明文扫描通过。其原始诊断含未分类事件标记，未保存原文，不能据此补推错误原因；配置通过依据是实际 RPC 与权威配置状态。生成弹窗、完整官方媒体链路及更新后的安装包另行验收，见[新策略记录](client-confirmation-policy-20261017.json)。

[10-17 Windows 构建](windows-build-20261017-client-confirmation.json)已产生独立正式配置包与显式开启的卸载诊断包。正式包的包内 Node/MCP fixture、Worker 与持久化重开检查通过。诊断包已通过当前用户、目录、进度和完成页安装检查，随后用户手工卸载；[进程观察](windows-uninstall-process-trace-20261017-202922-dd8a19dc.json)确认退出并稳定 30 秒后程序、卸载器及 HKCU/HKLM 注册项均不存在，[1,737 个原数据文件内容不变](windows-manual-20261017-client-confirmation-uninstall-data.json)。[诊断日志](windows-uninstall-diagnostic-20261017.log)观察到原清理流程成功回调，未新增清理逻辑；这证明该诊断包卸载通过，旧包残留的具体原因仍未确定。正式包安装及安装后 GUI 另记于[本轮向导记录](windows-manual-20261017-client-confirmation.json)。早期包内 smoke 因旧鉴权 fixture 失败，更新 fixture 后在同一载荷复测通过，原情况如实记录。

2026-10-11 开始，2026-10-16 接续。以下按实际证据分别判定，完整产品验收仍未完成。用户指定使用 Agnes Video 2.5 Flash，并要求先测 Windows；没有 macOS/Linux 测试机器。Claude Code 真实会话按用户最新要求取消本轮验收。

[10-18 正式安装运行复核](windows-installed-runtime-20261018.json)确认原目录中 Main/MCP 核心与正式载荷匹配，正常桌面入口启动、关闭并重开后仍有原两个项目入口；未改画布或发起生成。正式向导的中间步骤由用户操作，审查者仅观察到目录页，不补记全部页面通过。独立命令行启动虽有进程却未出现可验收窗口，已停止该测试进程，原因未定；不将正常桌面重开通过解释成此启动路径也通过。

[10-18 真实 Codex app-server 配置复核](codex-app-server-configuration-review-20261018.json)接受自动连接、自然语言保存两类 Agnes 配置及明确不支持检测的子流程，回合正常完成、没有配对/披露/生成批准或媒体任务。原整轮记录仍为失败：额外 QA 继续信号未送达，未进入媒体阶段，不覆盖原结果。启动隔离与当前 CLI 不支持桌面模型别名的失败记录另存；[宿主说明](codex-app-server-relay-20261017.md)区分真实配置、16 项本地宿主测试、当前会话表单 relay 与 Codex 原生弹窗视觉验收。

继续验收发现 Main 把普通 RPC 和 bootstrap 共用地址计数器，正常配置调用会耗尽下一连接的鉴权额度。[独立限流修复](mcp-rate-limit-review-20261018.json)保留 8/120/60 每分钟及 32 并发上限，新增三项真实 HTTP 回归，全部 MCP 定向用例 **106/106** 通过。QA 宿主/IPC 另有 **20/20** 本地检查通过；它们不计为官方媒体生成。修复后的真实媒体及 Windows 新构建须另记，旧安装包不自动获得此修复。

10-15 按用户要求整合 GitHub `feat/desktop-local-migration` 的既有改动，当前源码目录为 `pi-paper-web` / `pi-paper-desktop`。原验收 JSON、截图与运行路径保留，不回写成新目录下的实测。合并中修复了 Agent 控制库 schema 11 被旧备份校验拒绝的问题；[合并复核记录](merge-feat-2026-10-15.json)另列 101 项桌面、19 项记忆恢复及 10 项前端回归，计数不与历史集合累加。

| 项目 | 当前结果 | 证据及边界 |
| --- | --- | --- |
| 独立桌面专项回归 | 128/128 通过，0 跳过 | [完整日志](reviewer-tests.log)；含媒体权限、文本分页、多输出、MIME/摘要、文件路径/junction、大小、取消、凭据及生成确认 |
| Pi 完整工程检查 | 通过 | [复核记录](pi-check-rerun.txt)；首次受限运行的 esbuild spawn EPERM 在允许本地子进程后消失；恢复无关格式化修改 |
| Agnes 图片真实生成 | 通过 | [真实账号记录](agnes-real-account.json)、[生成结果](agnes-real-image.png)、[原节点截图](agnes-image-result-on-original-canvas.png) |
| Agnes Video 2.5 Flash | 第三次真实生成通过 | [账号记录](agnes-real-account.json)、[真实 MP4](agnes-real-video.mp4)、[历史队列诊断与恢复](agnes-video-queue-diagnosis.json)；4 秒/720P 请求，1,070,236 bytes，约 9 分钟生成，模型与参数未更换 |
| 真实 Codex | 自然语言官方凭据配置及本地生成分别通过；官方媒体完整回合未通过 | [配置审查](codex-provider-configuration-real-review.json)确认真实写入加密凭据、启用两种默认型号、原桌面披露与明确不支持检测；[历史本地生成](codex-real-session-review.json)另存。配置运行在额外 QA 执行者关卡退出，原失败记录保留，媒体任务为零；不是官方图片/视频完整回合通过 |
| 真实 Claude Code | 用户取消本轮验收 | 历史配对已完成，但模型 HTTP 402；不将配对或 SDK fixture 计作真实会话通过，不再请求账户或重试 |
| MCP 实际图片读取 | 通过 | [读取记录](mcp-real-image-read.json)、[重开原节点截图](mcp-real-image-read-original-canvas.png)；新无凭据 profile，实际 Main/Local Core IPC + SDK，853,173 bytes 与 TaskStore 摘要一致 |
| MCP 实际视频读取 | 真实 Flash MP4 通过 | [真实读取记录](mcp-real-video-read.json)、[原视频节点截图](mcp-real-video-read-original-canvas.png)；新无凭据 profile，经 Main/Local Core/SDK 返回 1,070,236 bytes，摘要匹配；FFmpeg 全片解码与原节点播放 17 帧通过。早期[本地 MP4 fixture](mcp-local-video-read.json)另存 |
| Windows NSIS 安装包 | 交互式重装及正常本地启动/关闭/重开通过；卸载清理未通过 | 历史[升级记录](windows-installed-upgrade.json)与[10-15 完整向导](windows-manual-lifecycle.json)保留。858fbbe 新构建的[10-16 记录](windows-manual-lifecycle-20261016.json)覆盖观察到的当前用户/进度/完成页，中间由用户操作，本次未观察目录页；受限重开失败另存，正常本地重开原媒体画布成功。第三次用户看到卸载完成页后，程序文件和 HKCU 键仍在；日常 1,737 个文件内容保持一致 |
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

10-15 增加隔离的 Codex→Agnes 分阶段脚本。首次[配置阶段记录](codex-agnes-acceptance-2026-10-15T12-52-54-132Z.json)中 CLI 正常结束，但未调用 MCP、未配对、未保存配置，图片和视频任务均为零；清理与退出后明文 Key 扫描通过。复核发现 QA 错把 CLI 自身的 APPDATA 改为测试目录，且测试窗口未显式显示；这两项已修复，但不能仅凭观察认定首次零调用的根因。临时 MCP 配置另加入必需启动、60 秒启动超时及仅转发授权环境变量名的配置，stderr/assistant 内容仅在内存分类为固定诊断标志，不保留原文。后续真实结果独立记录，不回写首次失败。

第二次[配置阶段记录](codex-agnes-acceptance-2026-10-15T13-03-44-754Z.json)已完成真实用户原生配对批准，Codex 读取画布、模型和 Agnes 公开配置；配置工具调用失败，未出现提供方披露卡，未保存凭据、未创建图片/视频任务。CLI 的安全诊断含网络类标志，尚不足以判定具体失败原因；不能把 CLI 正常退出当作配置通过。原 IPC 凭据清理、授权撤销与退出后明文 Key 扫描均通过。

第三次[带安全分类的记录](codex-agnes-acceptance-2026-10-15T13-14-09-012Z.json)确认三个读取调用成功；配置调用失败时未观察到对应 Main `/rpc`，因此失败位于桌面业务处理前，具体原因仍不明。第四次[客户端许可配置复测](codex-agnes-acceptance-2026-10-15T13-18-50-155Z.json)的模型回合退出码为 1，没有调用工具，stderr 仅分类为网络错误；这次不能用于判断配置工具许可是否已解决。两次均未保存提供方凭据、未提交媒体任务，退出后清理与明文 Key 扫描通过。独立修复的[Codex 授权环境变量导出回归](codex-environment-export-review.json)为源码测试证据，不替代真实配置通过。

10-16 的[最小 Codex 连接诊断](codex-connectivity-2026-10-16.json)不提供媒体 Key、不启动 Electron/MCP；真实模型请求退出码 0、turn.completed，证明该次最小连接可用。随后[配对复测](codex-agnes-acceptance-2026-10-16T02-27-52-442Z.json)在原桌面未收到用户批准时达到 MCP 启动超时，未调用工具、未保存凭据、未创建媒体任务，清理及明文扫描通过；不能把配对超时记为提供方错误。QA 启动超时随后恢复为产品导出相同的 150 秒，下一轮需在用户准备操作窗口后启动。

复核还发现 QA Electron 子进程只复制常规环境变量，丢失父进程显式代理，导致其中的 Codex 使用 WinINET 回退路径，而最小连接诊断使用父进程路径。QA 已统一采用同一白名单及无内嵌密码的代理规范化函数；尚未据此声称此前配置失败的根因已确定。正常工具回合和诊断均仅保留有限状态码及固定关键词布尔，不保留原错误正文、模型回复或环境值。

10-16 后续[03:00 UTC 运行](codex-agnes-acceptance-2026-10-16T03-00-40-076Z.json)在配对阶段因用户按 Escape 停止 Computer Use，root 随即停止所拥有的验收进程。原自动记录使用通用 `ELECTRON_WORKER_FAILED`，不能将该代码认定为产品崩溃；退出后的明文 Key 扫描通过，当时未完成 IPC 撤销。其[独立事后清理](codex-abort-cleanup-completed.json)随后用原 Main/Renderer 和原 IPC 确认 Agnes 未配置、凭据字段为零，并精确撤销唯一匹配的测试授权；没有启动 Codex、提交生成或读取解密 Key。清理脚本[首次启动失败](codex-abort-cleanup-attempt1.json)发生在读取配置前，原记录仅有通用错误码。修正 QA 异步检查后协议注册过晚的时序风险、改为同步预注册后重试完成，两个记录及原验收失败记录均保留。

用户再次继续后的[03:06 UTC 运行](codex-agnes-acceptance-2026-10-16T03-06-20-022Z.json)仍未收到桌面配对批准，连接等待结束后退出；无工具调用、无配置写入、无媒体任务，IPC 清理、授权撤销和明文扫描通过。暂不继续自动重试配对。

10-16 用户在电脑前继续后，[03:35 UTC 运行](codex-agnes-acceptance-2026-10-16T03-35-24-721Z.json)实际收到一次原生配对批准，真实 Codex 调用了公开配置、模型、画布读取及提供方配置等工具，Main RPC 已返回 `awaiting_disclosure`。尚未保存凭据或启用模型，媒体任务为零，退出前原 IPC 清理、授权撤销及退出后明文 Key 扫描通过。此次已排除“配对未批准”；失败不能继续归入配对或模型网络错误。

审查源码发现，提供方披露卡实际由既有 `/settings/mcp` 的 `DesktopMcpSettingsPage` 显示，原画布只订阅生成确认。QA 始终在画布页查找 `mcp-pending-*`，真实模型回合正常结束并等待用户操作后，脚本立即断言配置已保存并退出。因此该次 `AGNES_PROVIDER_NOT_CONFIGURED` 是实际未完成配置的结果，未证明配置业务保存失败。后续须由现有设置页完成用户披露，再让真实 Codex 自然语言续接并核验公开配置；本次原失败记录保持不变，不能改记全链路通过。

随后修复原设置页把 `authorized` 披露仍列为待确认的问题，只显示明确处于 `awaiting_disclosure` 的披露卡。QA 改为读取公开待办的权威状态，进入已有外部 Agent 设置页等用户操作，批准后返回同一原画布并核验 `canvasReady`，再以纯自然语言续接配置；Agnes 检测必须明确观察到 Main 返回 `unsupported` 才通过检测状态门槛。生成阶段同样读取已存在的提案与 TaskStore，拒绝不能计作确认，只有 `submitted` 计作已确认；Codex 回合提前结束后只等既有任务，再以查询用自然语言读取已有结果，不重放创作请求。配置回合不开放生成工具，结果查询与 readback 回合只开放读取工具。[审查及模拟记录](codex-disclosure-resume-review.json)包括前端 2/2 定向测试、构建与十种等待/权限场景，不代表真实付费生成已通过。这处 UI 修复尚未进入前述安装器，安装证据继续绑定 `858fbbe` 构建。

用户晚间继续后，[最小模型连接复核](codex-connectivity-2026-10-16-evening.json)再次退出码 0、turn.completed；该检查不含媒体 Key、不启动 MCP 或 Electron，仅证明当次真实 Codex 模型连接可用。

晚间[11:35 UTC 真实运行](codex-agnes-acceptance-2026-10-16T11-35-50-715Z.json)完成两次原生配对，原设置页披露卡已显示，公开状态确认 `authorized`，返回原画布后 `canvasReady` 为真。配置续接回合完成读取并调用检测，但没有再次调用配置保存，检测明确返回 `CLOUD_CREDENTIAL_MISSING`；模型正常结束不代表配置成功。该次未保存凭据、未提交图片或视频任务，原 IPC 清理、授权撤销及退出后明文扫描通过。已据此把续接自然语言改为先使用当前公开的授权来源完成尚未保存的配置，再核验和检测；没有给模型注入内部工具名、操作 ID 或密钥正文。原失败记录保留。

进一步补全原 TypeScript Agent 服务共享的提供方工具发现契约，明确公开配置 schema、授权 sourceRef、披露后续接及保存状态；没有另写 Main 工具定义或改变权限。定向共享测试 1/1、Agent 服务 TypeScript 构建、重新编译 Worker 与 Worker smoke 通过。无 Key 的 Agnes 目录只有四个模型，公开投影约 2.8k 字符，凭据来源元数据在 20k 文本上限内，未把本例归因于响应截断。工具契约改动的真实客户端结果仍须独立复测。

随后[11:53 UTC 真实运行](codex-agnes-acceptance-2026-10-16T11-53-33-820Z.json)完成两个真实 Codex 配对及原桌面披露，原画布恢复后，Codex 自然语言续接实际完成加密凭据保存、图片/视频默认型号启用与检测，Main 明确返回 `unsupported`。审查者[接受这段配置链路](codex-provider-configuration-real-review.json)，不把检测称作独立鉴权成功。原总结果仍为 false：额外 QA 执行者费用关卡提前结束，未提交任何媒体任务；审查者没有发送取消，具体 stdin 事件未被记录，不能归因于用户取消或已确定的空行原因。退出后的凭据清理、授权撤销和明文扫描均通过。

为继续用户已授权的一张图片、一条 Flash 视频验收，QA 增加显式 `--allow-one-image-and-video` 执行范围，仅在配置核验后通过额外执行者关卡；原桌面披露与每次生成确认仍由用户完成。默认交互路径忽略空行，并保留明确停止选项。四种执行者关卡模拟及原十种等待/权限模拟通过，不替代真实媒体生成。

10-15 另复跑现有 `mcp-review-main.test.cjs`，12/12 通过，包含撤销后立即拒绝活跃连接、CAS/保存屏障、重启确认失效和断线配对取消。这是原 128 项集合中定向复跑的 12 项，不累加计数，也不能代替修正后真实 CLI 清理断言的重跑。首次受限环境在测试运行器创建子进程时遭 EPERM，允许本地子进程后的复跑通过；两份 QA 脚本语法检查和视频/安装器交付摘要复核也通过。

## 验收方式与限制

真实账号和媒体读取脚本的连接批准使用受控测试替身；生成确认点击原 Renderer 卡。Windows 最终包测试通过 Windows UI Automation 定位当前测试进程的原生配对对话框、核对短码并点击批准，未替换配对逻辑。实际客户端脚本须证明真实 CLI 模型 turn 与 MCP 调用，而非直接 SDK 编排。账号生成、客户端本地模型 fixture、正式包内运行是三类独立证据，不能相互替代。

MCP 媒体默认返回元数据；显式 preview 且有 task.read/media.read/对应 mediaTypes 时才传字节。图片限 4 MiB、视频限 8 MiB；超限拒绝。文本支持 Unicode 字符分页，outputIndex 范围 0–3。当前没有任意路径读取或大视频流式传输。

测试项目和 profile 使用 `.test-temp` 唯一目录。用户明确批准后，使用最终 NSIS 安装器 `/S /D=E:\pp\Pi-Paper` 更新既有 Windows 安装，退出码 0；已安装可执行文件和 8 个关键资源的 SHA256 与最终载荷一致。安装前后注册项一致且指向现有安装；版本号仍为 0.1.0，不能仅凭版本号判定升级。实际已安装程序以标准 `--user-data-dir` 隔离创作测试，从原 Workspace 进入 Canvas，正常关闭重启后同一画布仍有 2 节点和 1 连线。日常用户数据目录仍存在，顶层条目数保持 30；未删除或测试写入日常项目。

原生安装向导控制的 Orca UI runtime 返回 `runtime_open_timeout`，使用本地 electron-builder NSIS 模板支持的静默模式完成授权升级。因此该历史轮次的静默安装、注册核对和已安装程序运行有实际证据；当时手工向导页面/选项、卸载和签名可信度仍未验收。供复核的本机安装器位置与摘要见[构建清单](windows-installer-builds.md)。

上述为 10-12 历史边界。10-15 在 `6491cd8` 源码上重新构建安装器，SHA256 `cca3e3051bc4f3654691c0e92abdc00b31fa48e36770e73a84a052b2114a88ed`。本次 Windows Computer Use 可用，实际操作当前用户、目录选择、安装及完成页，取消完成后自动启动并关闭向导。原目录已恢复，新 Main 与载荷摘要一致；使用新隔离 profile 打开已有验收项目，原节点真实图片和视频可见，Alt+F4 正常退出后重开仍可打开同一画布。见[手工记录](windows-manual-lifecycle.json)和[重开截图](windows-manual-installed-reopen.png)。日常用户资料未用于创作测试，升级、用户确认卸载、重装和运行后均对照同一私有基线：1,737 个文件无新增、缺失或内容变化。

卸载程序被 Computer Use 以 `product policy blocks this app` 拒绝操作，交由用户手工完成，未换用其他 UI 自动化绕过。用户明确确认卸载完成后、再次启动安装器前，程序/卸载器文件已不存在，但仍观察到一个 HKCU 卸载项及安装位置项；已记录[当时状态](windows-manual-uninstall-final-state.json)，不能用重装后正常存在的注册项替代该时间点。标准 NSIS 模板本有删除注册项的成功路径，尚无实际卸载进程/退出码证据证明未清理的具体原因，未盲改产品模板。手工安装向导已补验；卸载完全清理和签名可信度仍不计通过。

10-16 从已推送的 `858fbbe` 另构建[新 Windows 安装器](windows-build-2026-10-16.json)，载荷包含授权环境变量导出修复。包内 Electron Node 检查通过：MCP node 入口本地 fixture、24 个提供方/93 个模型目录、SQLite 重启持久化及 Worker Skill/片段恢复。随后完成[本次交互式重装与运行核对](windows-manual-lifecycle-20261016.json)：审查者观察当前用户选项、安装进度和完成页，用户操作中间页面，审查者取消自动运行并结束向导；本次未观察目录页，且已有 HKCU 注册，不能计为注册项全空的首次安装。已安装 Main 与新载荷一致，MCP service 摘要为 `020b3ac8aae595df95e56f972f03e95dd64490b9cebf6bc07fa7767068162c6d`，不可与 Main 文件摘要混用。10-15 的完整向导证据保留原构建身份。

新安装程序使用隔离 profile 从原 Workspace 打开已有真实媒体项目，图片和视频在原节点中可见；Alt+F4 正常关闭，受限 shell 首次重开出现 Windows 异常 `0x80000003`，保留[异常截图](windows-20261016-reopen-error.jpg)。改用正常本地进程上下文启动后，同一 profile 的 Workspace、同一项目和两个媒体节点均正常，再次 Alt+F4 关闭；见[重开截图](windows-20261016-installed-reopen.jpg)。这证明正常本地重开可用，不能据此确认首次异常的具体根因。本轮未调用云端生成，卸载尝试、重装及运行后对照私有基线的日常 1,737 个文件均无新增、缺失或内容变化。

10-16 用户第三次手工卸载明确报告看见完成页，但重装前[只读追踪](windows-uninstall-process-trace-20261016-111922-f3ed569f.json)仍见主程序、卸载器和两个 HKCU 键存在。已观测卸载进程及子进程后来从 CIM 查询消失，WMI 原生启停追踪不可用，未捕获退出码，也未完整验证临时卸载器身份；稳定 30 秒不能当作 NSIS 成功返回。此状态与前两轮“文件消失、注册项残留”分别保留，不相互覆盖。[诊断记录](windows-uninstall-process-trace-20261016-diagnosis.md)核对 stock 模板包含文件及注册项删除路径，但根因未证实，卸载验收仍未通过；未手工删注册项或绕过自动化限制运行卸载。

晚间另构建包含披露卡状态修复的 [141dd27 安装器](windows-build-2026-10-16-evening.json)，包内 Node fixture 检查通过，尚未手工安装；随后的共享工具 schema 修复不在该冻结包中。晚间用户第四次手工卸载的[句柄追踪](windows-uninstall-process-trace-20261016-194833-932af3fc.json)实际捕获注册路径卸载器、临时卸载器及两个 PowerShell 子进程的退出码均为 `0`，但程序文件和两个 HKCU 键仍存在，不能算卸载成功。另一个短命子进程没有退出码，仍不保证完整树；新的 1,737 文件基线及卸载后内容核对一致。此轮尚未重装，未伪造清理结果。
