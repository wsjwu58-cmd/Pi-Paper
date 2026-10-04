# Pi 官方 API 与自定义模型配置实施设计

日期：2026-10-03。用户最新决定恢复 Pi 二次开发，本文件重新成为当前实施依据。采用各厂商官方 Key，不引入 New API 或 LiteLLM；已实现范围与待验收缺口分别记录，不声明全部目标型号已经可用。

## 范围与架构

保留原文本20、图片16、视频25、音频11，共72项目标（视频标题26但实际25，缺项未虚构）。提供方分组和官方图标遵循用户两张参考图；不恢复平台计费。复用原前端页面、编辑器与 Pi Agent 服务。模型身份为稳定 bindingId，不单独依赖显示名。现有 Agnes、Ark、本地能力继续兼容。

Renderer 配置页 → 受限 IPC → Main 保存公开设置和系统凭据 → Provider Registry → 本地任务 → Generation Worker → 原 Pi 官方适配 → 本地资产保存 → 原节点展示。Agent 使用相同能力目录，生成仍经过既有系统确认。

## 配置与数据

公开配置 schemaVersion=1，保存在 userData：providerId、baseUrl、enabledModelIds、defaultModelIds（按模态）、modelDefaults（按模型绑定）、timeoutSeconds；凭据独立经 safeStorage 系统加密能力保存，Linux basic_text 拒绝。不在 Renderer 回读 Key、设置／日志／项目导出中出现密钥。保存可更新 Key 或保留已存 Key；清除连接移除相应凭据。默认参数按目录能力校验，任务创建时快照，后续配置修改不会改变已提交任务。配置云端时说明供应商收到提示词及用户选择的参考素材、可能收费。

统一 IPC：`getProviderConfiguration()` 返回 `{providers, models}`；`saveProviderConfiguration(input)`；`clearProviderConfiguration(providerId)`；`testProviderConfiguration(input)`。provider 描述 id、name、baseUrl、credentialFields、configured、enabledModelIds；模型描述 id/name/displayName/providerId/modelType、apiModelId、implemented、enabled、inputModes、约束与 unavailableReason。设置可以保存未实现模型，但其不能出现在可用选择目录。2026-10-04 更新：连接检测无付费生成，只验证有官方鉴权探测接口的路径；不支持探测者返回 `unsupported/success=false`，不能把格式校验显示为检测成功。凭据输入默认黑点并支持眼睛按钮显示本次输入；不会回读已保存 Key。当前覆盖及验收见提供方数据契约与官方 Key 获取指南。

## Pi 接口与执行

在 `packages/ai/src/media/` 新增官方媒体类型、共享 HTTP 与适配器；图片按既有 Images 注册机制扩展，避免破坏聊天事件协议；音频区分TTS、变声、音乐等操作；视频定义 submit/query/download/cancel-capability。对外桌面桥接入口 `executeOfficialGeneration(input, options)`：input含 providerId、modelId、modality、prompt、params、references、remoteTaskId；options含 apiKey/credentials、baseUrl、signal、timeoutMs、onSubmitting、onSubmitted。返回文本或媒体结果描述（URL/Base64、MIME、usage），不自行写画布／素材文件。

视频适配在内部区分提交和查询，通过 `generateOfficialVideo` 及 `executeOfficialGeneration` 统一调用；返回 remoteTaskId、状态和结果描述，不把未落盘任务视为本地成功。网络成功但ID落盘前崩溃的窗口记为“提交结果待确认”；默认禁止自动重新POST。查询 transient 错误可重试；任务已有上游ID时重启继续查询。任务新增字段需可重复迁移及备份，不覆盖旧任务数据。取消能力按官方接口声明，否则仅停止等待并说明上游仍可能收费。

通用参考素材读取经项目归属、MIME、尺寸和数量验证。厂商只接受HTTPS地址的模式不发送磁盘路径或随意构造file_id；沿用Ark当前本地音视频参考阻塞规则。输出下载不携带官方Key到任意第三方URL，URL/DNS/重定向与大小约束沿用现有安全边界。

## UI

独立配置页左侧厂商、右侧字段／模态启用列表／默认模型／测试与保存。复用原应用路由与导航。模型选择器按厂商两列分组，只有可用绑定可选择；底部自定义配置入口保存返回路径。编辑器和Agent都读Registry，不在前端拼接虚假目录。Web旧路径保持原DTO与行为；桌面能力通过显式适配隔离。官方图标随包保存，无法取得的图标记缺口，不手绘伪造。

## 并行边界与交付

Luna max 子Agent分别负责 Pi 文本／图片／音频、Pi 视频／官方目录、原前端配置与选择器。主Agent负责Main凭据与IPC、构建产物、任务路由／恢复、跨模块契约和测试。互不覆盖文件，任何接口变化先协调。优先可运行纵向链路，不能把仅展示目录宣称所有72项已接入。

验收包括配置读写／清除与无密钥回读、未配置模型隐藏、参数能力校验、官方请求转换、无效Key、任务中断恢复／重复提交防护、结果落盘、Agent目录一致、前端构建及现有相关回归。真实Key未提供时使用可信协议fixture验证并明确未完成真实供应商验收；测试成功不代表跨平台安装包验收完成。

## 当前代码覆盖与未完成项（2026-10-03）

目录保留72项目标。下表为最初7项纵向链路的基线；本次增量覆盖见后面的表。只有用户配置并启用后才可用于生成，实现状态不是真实账号可用性证明。

| 模态 | 型号 | 路径 |
| --- | --- | --- |
| 文本 | DeepSeek V4.1 Flash | Pi 文本接口，官方 `deepseek-flash` |
| 图片 | GPT-Image-2 | Pi Images，官方生成／编辑请求 |
| 图片 | Agnes Image 2.5 Flash | 保留既有 Agnes 官方适配 |
| 视频 | Seedance 2.5 | Pi 方舟提交、查询与上游任务 ID 恢复 |
| 视频 | Agnes Video 2.5 Flash | 保留既有 Agnes 官方适配 |
| 音频 | Eleven Flash v2.5、Eleven Multilingual v2 | Pi 官方 TTS；需配置 voiceId |

基线交付时其余65项未实现。本次继续核验官方文档并增加如下适配；音乐、克隆、扩图等特殊操作仍不能用通用 TTS／图像生成替代。GPT 图像适配目前只接受已实现的尺寸子集，超出范围明确报错；这不是供应商全部能力的声明。

已接通原前端配置页、模型选择、受限 IPC、加密凭据、生成 Worker、多结果落盘和异步任务检查点。检查点在参数及参考地址预检完成后、提交请求前记录 submitting，获得上游 ID 后先持久化再轮询；提交结果不确定禁止盲目重新 POST。恢复已有 ID 的任务只查询原任务。

桌面资源包已收录19个官方来源品牌／型号系列图标，来源与 SHA-256 见 `docs/research/2026-10-03-official-provider-icon-provenance.md`。新增 BytePlus、Moonshot、Kimi、Qwen、HappyHorse 官方 favicon；Midjourney 官方站点 favicon 无法取得，继续使用通用符号，不伪造品牌。尚未完成：全部型号真实 Key 验收、与原 Web 同状态截图对照，以及三平台安装包验收。

验证使用本地协议 fixture：Pi 类型检查、桌面相关回归和 Agent Worker 会话重启／片段恢复 smoke。没有真实厂商 Key 的付费生成证据，不能把 fixture 通过声明为全部模型接入完成。配置与 IPC 数据契约见 `docs/specs/desktop-provider-data-contract.md`。

历史初始基线曾记录 Pi 官方媒体定向测试10/10、桌面相关回归85/85；这组数字只说明最初基线快照，不代表当前全部增量。协议 fixture 用于验证本地请求构造、响应解析与编排，不等于真实 API Key、账户权限或付费生成验收。构建保留既有 CJS import.meta 与前端大 chunk 警告，相关 Bedrock/OAuth 分支未在本轮验收。前端选择器已实现左厂商／右模型，失效选择不自动替换，目录读取失败明确显示；视觉对照仍待运行截图验收。

## 当前源码覆盖与能力状态（2026-10-03）

以下数量由 `getOfficialProviderCatalog()` 对当前 `catalog.ts` 运行时计算得到。产品目标仍是72项（文本20、图像16、视频25、音频11）；当前65项标记为 `implemented`（文本19、图像15、视频21、音频10）。实现标记说明请求适配及目录能力已落入源码，不代表供应商真实账号、地区权限或收费调用已验收；只有配置并启用的模型才能进入生成选择器。Wan 2.7 T2V、MiniMax Hailuo 2.3 Fast、HappyHorse 1.1 的 canvas bindings 已有实现；未来增加其他输入模式前须具备相应画布绑定与真实协议覆盖。

| 模态 | 当前 `implemented` 型号 | 接口与能力边界 |
| --- | --- | --- |
| 文本（19） | Claude Fable 5.1、Haiku 4.5、Opus 5、Opus 5.5、Sonnet 4.6；DeepSeek V4.1 Flash；Gemini 3.1 Pro、3.6 Flash、3.8 Flash；GPT-5.6 Sol/Terra/Luna、GPT-6 Astra/Sol/Luna；Grok 4.3/4.7；Seed 2.0 Mini、Seed 2.1 Pro | 使用 Pi Messages、OpenAI Responses/Completions、Gemini 官方 API。目录分开记录官方 API ID、reasoning 参数和上下文/输出元数据。Seed 2.0 Mini 的 8192/2048 是应用预算和上限，不是官方模型上下文声明；Seed 2.1 Pro 的 256k/32768 有官方元数据支持。桌面 catalog 将文本绑定标为可 tool calling/streaming；真实账号语义仍待厂商验收。 |
| 图像（15） | GPT-Image-2、GPT-Image-2.5 Flare/Sunburst；Grok Imagine；Seedream 5.0/5.0 Pro；Agnes Image 2.0/2.1/2.5 Flash；Qwen Image Edit Plus、Wan 2.7 Image Pro、Z-Image Turbo；Banana 2、Banana 2 Lite、Banana Pro | 使用各自的官方 Images/Interactions/Ark/Model Studio/Agnes 协议；严格按目录检查输入模式、大小、比例、参考数和输出数。Grok Imagine、Agnes 2.0/2.1、Z-Image 是文本输入路径；legacy Agnes Image 2.5 可接受图像参考；Qwen Image Edit Plus 要求图像输入；通用扩图工作流未实现。GPT-Image-2 当前目录仅允许1K。 |
| 视频（21） | Veo 3.1/Lite；Grok Imagine Video/1.5；Ark Seedance 2.0/2.0 Fast/2.0 Mini/2.5；BytePlus Seedance 2.0/Fast/Mini；Wan 2.7 T2V、Wan 3.0；Kling V3/3.0 Omni；MiniMax Hailuo 2.3 Fast、H3；Agnes Video 2.5 Flash；Vidu Q3 Pro；PixVerse V6；HappyHorse 1.1 T2V | 异步任务提交/查询使用本地持久化上游任务 ID。Ark/BytePlus Seedance 每项在目录中限制文本、图像、视频、音频输入模式及最多50个参考；Veo、Grok、Wan 2.7/3.0、Kling、MiniMax H3、PixVerse 和 HappyHorse 1.1 当前画布绑定是文本输入；legacy Agnes Video 2.5 接受图像参考并支持首尾帧／参考模式；Vidu接受最多2个图像参考。MiniMax Hailuo 2.3 Fast 是必须传入一张首帧的 image-only 绑定：768P支持6/10秒，1080P仅6秒，画幅从图像自适应。远端取消未实现，停止轮询不代表供应商已取消。 |
| 音频（10） | MiniMax Speech 2.8 HD/Turbo、MiniMax Music 2.6；Eleven Flash v2.5/Multilingual v2、ElevenLabs Voice Changer；Fish Audio S1/S2 Pro；Doubao TTS v1/v2 | operation 区分 `speech`、`music`、`voice-change`。语音合成需按模型配置 Voice ID；MiniMax Music 2.6 受官方账户开通条件限制；ElevenLabs Voice Changer 接受一个本地音频参考并要求目标 Voice ID；Fish Audio 可选服务端 Reference ID，不读取本地克隆音频；Doubao v2 用独立语音 Key，v1 另需 AppID、Access Token、Voice Type。 |

Pi 百炼视频模块还覆盖但未对当前模型选择器开放这些准确调用 ID：Wan 2.7 的 `wan2.7-i2v`、`wan2.7-i2v-2026-04-25`、`wan2.7-r2v-2026-06-12`，以及版本化 T2V `wan2.7-t2v-2026-06-12`、`wan2.7-t2v-2026-04-25`；HappyHorse 1.1 的 `happyhorse-1.1-i2v` 和 `happyhorse-1.1-r2v`。目录仅开放 Wan 2.7 `wan2.7-t2v` 与 HappyHorse 1.1 `happyhorse-1.1-t2v` 两个文生视频绑定，因此额外模块路由不计入65项当前可选数。相关一手文档：[Wan 视频 API](https://www.alibabacloud.com/help/en/model-studio/text-to-video-api-reference)、[HappyHorse 视频 API](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/happyhorse-text-to-video-api-reference)、[MiniMax Hailuo I2V API](https://platform.minimax.io/docs/api-reference/video-generation-i2v)。

当前仍未实现或不可启用的7项目标为：**文本** Kimi K2.5；**图像** Midjourney V8.2；**视频** Gemini Omni Flash、Seedance 1.5 Pro、MiniMax H3 Local、旧目标 Happyhorse；**音频** Doubao Voice Creation。Kimi K2.5 已由官方于 2026-08-31 停用；Seedance 1.5 Pro 已由官方于 2026-09-21 下线；Midjourney 官方不提供公开 API 并禁止未授权自动化；Voice Creation 需完整音色创建/管理生命周期，不能用普通 TTS 替代；H3 Local 没有本地运行适配。HappyHorse 1.1 有可用的百炼 T2V binding，但不能据此把未核验的旧目标 `Happyhorse` 静默替换成1.1；其他未实现项同样不能仅凭显示名推断 API ID 或能力。详见[不可接入型号核验](../research/2026-10-03-unavailable-official-models.md)。

当前注册表含 Anthropic、DeepSeek、Google AI Studio、OpenAI、xAI、Moonshot、火山方舟、BytePlus、阿里云百炼、MiniMax、Agnes、ElevenLabs、Fish Audio、豆包语音、Kling、Vidu、PixVerse、Midjourney、HappyHorse 等厂商／凭据路由；同一品牌的不同服务端点（如 Ark 视频、百炼视频、豆包语音 v1/v2）分开保存凭据。Agnes、Ark 和 loopback 本地模型继续兼容；本地路径不因云端模型目录新增而联网。

当前只读连接测试仅为 OpenAI `/models`，其他提供方为输入格式校验，不调用付费生成端点。已集成的视频提交先持久化 submitting checkpoint，上游 ID 保存后再查询；不确定是否已提交时不盲目重复 POST。Ark Seedance 2.5 的本地视频／音频参考仍按官方 `video_url.url`／`audio_url.url` 契约拒绝未声明的 `file_id`、本地路径或 Base64；已接受的 HTTPS 参考须由上游可访问。

截至主Agent本次集成验证，dist catalog 运行时为65/72（文本19、图像15、视频21、音频10）。通过：桌面相关16个测试文件114/114；Pi官方媒体8个测试文件76/76；Web视频参数7/7；Agent会话/片段4/4及定向18项（定向项已包含在桌面相关总数中，不重复合计）；Pi与Web TypeScript检查、Web生产构建、desktop Worker构建，以及会话重启／片段恢复 smoke。构建仍显示既有 CJS `import.meta` 和 Vite 大 chunk 警告。视频Agent曾运行全 workspace 过滤命令，但该命令未匹配到测试，且未修改的 TUI Windows 路径分隔用例失败；本次验收范围是上面列出的定向测试文件，不能据此宣称全仓测试全绿。

以上都是本地 fixture、类型检查、构建和编排/恢复验证，不是供应商真实 API Key、账户权限或付费生成验收。未完成项仍包括真实供应商 Key 验收、Agent 多厂商全链路的最终用户验收、原 Web 同状态视觉对照和三平台安装包验收。
