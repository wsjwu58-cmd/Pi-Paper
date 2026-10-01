# 2026-10-01 画布返回、首帧、封面、下载与历史修复

## 范围与结论

本批直接修改原 `WorkspacePage`、`HistoryPage`、`CanvasPage` 和六种节点组件，并在现有 Main、Local Core、ProjectStore、生成 Worker 接入本地能力。没有建立平行桌面页面。以下修复已有定向测试和 Windows 隔离 Electron 运行证据；不表示全部模块或 Agent 已完成 1:1 验收。

| 用户反馈 | 原因与处理 | 验证边界 |
| --- | --- | --- |
| Agent 工作时返回展示页，再进入无响应 | 打开同一活动项目也走项目切换门，等待生成队列并停止 Agent。现在规范化目录后识别同项目导航，复用活动 Core/Agent；Core 继续核验项目与画布身份。真正换项目保留原切换门。 | 永不完成的任务泵仍可返回同项目；Agent 引用不变；错误身份拒绝；其他项目等待泵结束。没有把跨项目并发列为已支持。 |
| 上游图片首帧未约束视频 | 旧请求把图片放入不对应当前 Agnes 协议的 `extra_body.image`。现在使用顶层 `first_frame` / `last_frame` 与 `mode=keyframe`；参考模式使用顶层 `images`。保留原前端上游图片参数别名，无法解析的本地参考仍拒绝，不能静默降为纯文本。 | 受控解析、原批次首帧、协议测试及一次真实首帧视频通过；不代表所有供应商或所有多输出参考组合已验收。 |
| 画布卡片没有生成图片封面 | 最近项目摘要增加可选 `thumbnailUrl`。Store 只选择仍关联此画布图片节点、已成功且哈希/大小匹配的生成图片；读取非活动项目使用只读数据库，不激活项目。Main 只通过已核验目录提供受限封面 URI。 | 活动/非活动项目、身份变化、结果被修改与无图片场景通过；无封面保持原占位。当前使用索引 0，最新最多 20 个候选。 |
| 六种节点下载不可用 | 原工具栏接系统保存对话框与受限 IPC，下载现有结果，不重新生成。下载前刷新原画布保存队列；Main 在对话框前后核验当前项目、画布、节点及结果归属。文本也允许核验已落盘但尚未同步到节点参数的最新结果。 | 文本 TXT、图片、音频、视频、合成视频与导演台照片；取消、项目切换、伪造来源、变化文本和覆盖内部数据拒绝。图片原按钮真实点击后保存字节与源文件一致；其余类型以真实文件复制/文本测试验证，尚非六屏逐一录屏。 |
| 历史记录页面不显示 | 桌面路由、导航和原两个入口统一使用受限 bridge 或 `vibe:` 的桌面运行识别，避免误入 Web 登录路径；加载/搜索失败明确显示原因，不作为空历史。 | 原 `HistoryPage` 在隔离 Electron 中显示当前项目真实的成功/失败任务、输入及供应商错误；仍为当前活动项目历史，不宣称汇总所有项目。 |

Agnes 协议依据：[Video 2.5 Flash 官方文档](https://www.agnes-ai.com/zh-Hans/docs/agnes-video-25-flash)。文档列出公网 URL 形式；本次真实端点接受了受控解析后的 PNG data URI 并保持原图构图，此结果仅记录当前端点实测，不推定其他提供方支持此格式。

## 本地接口与数据增量

- `DesktopProject.thumbnailUrl?: string | null`：展示层派生字段，不写入项目主元数据；格式为 `vibe://app/projects/{projectId}/cover?v={sha256}`，Renderer 不收到文件路径。Main 内部 `project:resolve-cover` 通过最近项目目录和项目/画布身份解析，结果损坏时回退其他图片或占位。
- `desktop:node:export-output` / `exportNodeOutput`：输入为项目、画布、节点、节点类型及受限来源；来源为文本、任务 ID + 输出索引 0–3，或素材 ID。结果只有 `saved` / `cancelled`，错误通过原 Toast 显示。
- 复制结果以同目录临时文件和原子替换保存；禁止目标位于活动项目 `.vibepaper` 内，取消不写文件。来源继续调用原权威任务/素材解析，保留路径、内容与归属校验。不持久化新的任务或改变生成账本。
- 本批没有数据库 schema 升级、Pi 源码变动、API Key 明文、用户数据改写或项目数据迁移。

## 验证记录

- 桌面定向回归 **105/105**：generation-worker、reference-media、node-export、project-navigation、project-cover、recent-project-catalog、agent-task-notification、asset-operations。覆盖新问题及原媒体 Range/片段、安全隔离、通知与备份路径。
- 原前端媒体 URL 与节点下载 **7/7**；原 TypeScript + Vite production build 通过。既有包体积及动态导入警告仍存在。
- 原 TS 上下文与记忆 **23/23**：desktop-context-assembler、desktop-scoped-memory、desktop-project-memory。本批只重测已实现能力，没有修改其实现。
- 实际 Electron 使用隔离用户数据/项目，运行原 Main、Preload、Core 与原前端 production 页面：封面自然宽度 2048；历史两条真实 TaskStore 记录，成功与失败均显示；原图片下载按钮保存 **2,695,081 字节**，与已有源 PNG 相同。保存对话框在测试中指定隔离输出位置。运行结果 `.test-temp/desktop-pages-result.json`，截图位于其中 `profile` 目录；临时脚本、项目与截图不提交仓库。
- 真实 Agnes 首帧视频：使用系统加密保存的当前 Key，只读已有项目猫鼠 PNG，经正式 `runVideoTask` 提交最短 4 秒、720P、1:1 任务，306 秒后成功落盘，MP4 **242,108 字节**。FFmpeg 提取首帧并人工检查：原猫、鼠角色与构图保留。结果 `.test-temp/live-agnes/status-9aea0b6c-c419-4eff-b861-010f48796fe5.json`；视频及提帧仅在隔离目录，不修改用户项目。没有重复进行付费验证。

## Agent 压缩、记忆与完整迁移判定

压缩和记忆已按当前文档实现：完整请求预算包含系统/工具/本轮/历史及输出、安全预留；完整用户回合与工具配对保留；真实模型摘要写入 Pi compaction，原 JSONL 不删除，摘要实际用量逐次记账。五范围记忆为会话、画布、项目、全局、当日；候选经审核写入，保留来源等元数据，当日有到期清理，全局不混入项目备份。工作状态以权威画布/任务/Run 为准。估算采用保守字符规则，非供应商精确 tokenizer。

此前真实摘要已验证目标保留及重启；本批 23 条测试验证预算、边界、记忆范围和权限，不等于真实 128k 长会话压力门槛通过。详细证据见 [压缩与记忆记录](2026-10-01-agent-context-memory-validation.md)。

**Agent 全模块尚未迁移完成。** 原后端会话重命名/软删除/归档/复制的完整接口、持久计划 create/read/ready-set/rerun、会话 Skill 正文/版本快照、Agent 删除确认仍有差距；Worker 的编排还未全部收敛至原应用服务适配。原版同状态逐屏/录屏、多平台安装包、本地 Agent 模型和真实长会话/完整媒体链路验收仍未完成。差距以 [Agent 对照审查](2026-10-01-agent-parity-history-continuation-video.md) 为准，不能用普通续跑或复用原面板代替这些能力的完整迁移。
