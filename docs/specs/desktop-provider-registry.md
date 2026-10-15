# 桌面版模型提供方接入契约

> 2026-10-03 最新决策：恢复 Pi 二次开发与官方 API Key 自定义配置，扩展原 Pi 文本、图片、视频与音频接口；不使用 New API、LiteLLM。具体方案见 [Pi 官方接入设计](../plans/2026-10-03-pi-official-provider-implementation.md)。当前开发中，全型号及真实供应商调用尚未验收；仅实现并能力匹配的绑定开放使用。

## 接入范围

2026-10-06 更新：在原 72 个目标外新增 21 个官方绑定（含智谱文本／图片／视频），目录共 93 项、协议已实现 86 项。型号、官方来源、规格组合和验收边界见 [媒体编辑与模型更新验收](../verification/2026-10-06-canvas-media/README.md)。下文 2026-10-03 的数字与逐项表为当日基线；Moonshot 现新增 K3 与 K2.7 Code，原 K2.5 停用状态不变。ElevenLabs 音乐不要求 Voice ID，语音绑定单独要求 Voice ID。

2026-10-03 当前源码快照的静态目录包含 **72 个目标型号**：文本 20、图像 16、视频 25、音频 11。`getOfficialProviderCatalog()` 将其中 **65 个标为 implemented**：文本 19、图像 15、视频 21、音频 10。这里的 `implemented` 表示代码已定义调用适配及相应目录项；不代表真实账号、权限或付费生成已经验收。启用还要求用户配置厂商凭据，并由设置目录标记为 enabled。

| 厂商／目录提供方 | 代码中的已接入型号与能力 | 当前缺口／约束 |
| --- | --- | --- |
| Anthropic (`anthropic`) | Claude Fable 5.1、Haiku 4.5、Opus 5、Opus 5.5、Sonnet 4.6；Pi Messages 文本调用 | 桌面适配目录只声明文本输入；仍需真实 Key 验收 |
| DeepSeek (`deepseek`) | DeepSeek V4.1 Flash (`deepseek-flash`)；Pi OpenAI Completions 文本调用，usage 读取 | 真实 Key 验收待完成 |
| Google AI Studio (`google`) | Gemini 3.1 Pro、3.6 Flash、3.8 Flash；Banana 2、Banana 2 Lite、Banana Pro；Veo 3.1、Veo 3.1 Lite | Gemini Omni Flash 未实现；Veo 当前仅文本输入；图像型号参考数量和尺寸按模型分别限制 |
| OpenAI (`openai`) | GPT-5.6 Sol/Terra/Luna、GPT-6 Astra/Sol/Luna；GPT-Image-2、GPT-Image-2.5 Flare/Sunburst | 图像尺寸、比例、参考数和输出数依型号目录校验；真实 Key 验收待完成 |
| xAI (`xai`) | Grok 4.3、Grok 4.7；Grok Imagine 文生图；Grok Imagine Video、Grok Imagine Video 1.5 文生视频 | Grok Imagine 图像当前仅文本输入；两个视频型号当前仅文本输入，时长 1–15 秒，支持参数按版本限制 |
| Moonshot (`moonshot`) | 当前没有可用型号 | Kimi K2.5 已于 2026-08-31 停用，不得改映射为 Kimi K3/K2.6；详见[不可接入型号核验](../research/2026-10-03-unavailable-official-models.md) |
| 火山引擎方舟 (`volcengine`, `volcengine-ark`) | Seed 2.0 Mini、Seed 2.1 Pro；Seedream 5.0/5.0 Pro；Seedance 2.0、2.0 Fast、2.0 Mini、2.5 | Seed 2.0 Mini 的 8192 上下文／2048 输出是保守应用预算，不是供应商公布上限；Seedance 1.5 Pro 已下线；本地音视频参考受下文说明限制 |
| BytePlus (`byteplus`) | BytePlus Seedance 2.0、2.0 Fast、2.0 Mini | 当前代码目录声明文本、图像、视频、音频参考及最多 50 个参考；真实账号能力仍待验收 |
| 阿里云百炼 (`alibaba`, `alibaba-video`) | Qwen Image Edit Plus、Wan 2.7 Image Pro、Z-Image Turbo；Wan 2.7 (`wan2.7-t2v`)、Wan 3.0 (`wan3.0-video`)、HappyHorse 1.1 (`happyhorse-1.1-t2v`) 文生视频 | 视频使用独立 workspace/region 凭据。Wan 2.7 与 HappyHorse 1.1 的当前画布绑定均仅接受文本，不能将底层 Pi 模块的 I2V/R2V 能力宣称为画布可选能力；HappyHorse 1.1 默认保留水印 |
| MiniMax (`minimax`) | Hailuo 2.3 Fast (`MiniMax-Hailuo-2.3-Fast`)、H3 视频、Speech 2.8 HD/Turbo、Music 2.6；音乐使用独立 `music` 操作 | Hailuo Fast 必须提供一张首帧，画幅自适应，768P 支持 6/10 秒，1080P 仅6秒；H3 Local 未实现；Music 2.6 受官方账户开通资格限制，新账户不一定可用；语音需配置 Voice ID |
| 豆包／方舟兼容路由 (`doubao`) | catalog 保留 Ark endpoint provider，但当前72项目标中没有直接绑定到此 ID 的型号 | Seed 文本/图片/视频使用 `volcengine` 或 `volcengine-ark`；豆包音频另用下方 v1/v2 独立端点和凭据 |
| Agnes (`agnes`) | Image 2.0/2.1/2.5 Flash、Video 2.5 Flash；旧 Agnes 2.5 路径保留兼容 | Image 2.0/2.1 为文本输入；legacy Image 2.5 与 Video 2.5 的 catalog 均声明文本／图像输入，Video 2.5 支持首尾帧与参考模式。仍需端到端及真实 Key 验收 |
| ElevenLabs (`elevenlabs`) | Eleven Flash v2.5、Multilingual v2 TTS；Voice Changer speech-to-speech | Voice ID 必填；Voice Changer 只接受一个受校验的音频参考，不代表通用参考音频上传 |
| Fish Audio (`fish-audio`) | S1、S2 Pro 文本转语音 | 仅文本输入；可使用服务端 Reference ID，不实现本地参考音频克隆上传 |
| 豆包语音 (`doubao-voice`, `doubao-voice-v1`) | TTS v2 (`seed-tts-2.0`)；兼容 TTS v1 (`seed-tts-1.1`) | v2 使用语音控制台 Key 和 Voice ID，与方舟 Key 分开；v1 另需 AppID、Access Token 和 Voice Type；Voice Creation 未实现 |
| Kling (`kling`) | Kling V3、Kling 3.0 Omni | 目录当前仅开放文本输入，参考媒体未接入；AK/SK 签名与任务查询路径已实现 |
| Vidu (`vidu`) | Vidu Q3 Pro | 文本和图像输入，最多 2 个参考；当前任务适配不等于真实账号验证 |
| PixVerse (`pixverse`) | PixVerse V6 | 目录当前仅文本输入；任务能力按模型约束校验 |
| Midjourney (`midjourney`) | 目标型号仅用于显示不可用原因，不可配置／调用 | 官方 V8.2 页面确认当前版本；官方规则不提供公开 API，禁止未授权自动化；详见[不可接入型号核验](../research/2026-10-03-unavailable-official-models.md) |
| HappyHorse (`alibaba-video`；旧目标仍为 `happyhorse`) | HappyHorse 1.1 `happyhorse-1.1-t2v` 已通过百炼 workspace/region 凭据接入，画布仅开放文本输入；另有 `Happyhorse` 旧目标保留不可用 | Alibaba 官方发布页链接 HappyHorse 官网并说明 Model Studio API 服务；旧展示型号 `Happyhorse` 的精确调用 ID 未核验，catalog 保持不可配置，不能用1.1代替。参见 [HappyHorse 官方发布](https://www.alibabacloud.com/blog/alibaba-rolls-out-happyhorse-1-0-in-limited-beta_603068/) 与 [Model Studio API](https://www.alibabacloud.com/help/en/model-studio/happyhorse-text-to-video-api-reference) |
| Agnes、Ark 及本机服务 | 原 Agnes、Ark 与 local provider/Agent 路径保留；本机服务仍由 loopback 能力探测 | 本表的新官方云端 catalog 不替代现有 local 路径；其他 OpenAI 兼容服务尚未接入 |

桌面资源包当前有 **19 个官方来源图标文件**，包括 Anthropic、OpenAI、Google、DeepSeek、xAI、MiniMax、ElevenLabs、Fish Audio、ByteDance/Volcano Engine、Alibaba Cloud、Agnes、Kling、Vidu、PixVerse、BytePlus、Moonshot、Kimi、Qwen 和 HappyHorse。文件清单、来源与 SHA-256 见[图标来源记录](../research/2026-10-03-official-provider-icon-provenance.md)。Midjourney 官网与官方文档 favicon 下载均返回 403，因此继续使用通用符号，不以第三方资源替代。

Pi 百炼视频模块还实现了尚未开放给当前 catalog 的 Wan 2.7 `wan2.7-i2v`、`wan2.7-i2v-2026-04-25`、`wan2.7-r2v-2026-06-12`，以及 `wan2.7-t2v-2026-06-12`、`wan2.7-t2v-2026-04-25` 两个版本化 T2V ID；当前仅 `wan2.7-t2v` 文生视频绑定进入可选目录。HappyHorse 1.1 的底层任务路由也实现 `happyhorse-1.1-i2v` 与 `happyhorse-1.1-r2v`，但当前只开放 `happyhorse-1.1-t2v`。未进入 catalog 的协议路由不计为可选择型号，也不能视为已有 UI 能力。

媒体与文本的精确 model ID、操作、输入模式、默认值及约束以 `pi-main/packages/ai/src/media/catalog.ts`、`official-text-models.ts`、`official-media-models.ts` 为代码权威。2026-10-04 的设置连接检测覆盖 Anthropic、DeepSeek、Google、OpenAI、xAI、Moonshot、BytePlus、方舟 Seedance、MiniMax、ElevenLabs、Fish Audio、Kling、Vidu、PixVerse 共 14 个配置分组，发送真实官方鉴权 GET 请求，不创建生成任务、不回显余额或历史任务。Kling 支持新版单 API Key 或旧 AK/SK，二者不能混填；更换鉴权族时受控进程清除旧族并保留模型设置。

当前 `volcengine`／`doubao` 文本图片分组、百炼文本图片／视频、Agnes、豆包语音 v3／v1 共 7 个配置分组尚无已接通安全探测，页面明确显示暂不支持检测，IPC 返回 `unsupported/success=false`；不把格式校验呈现为鉴权成功。这些分组的生成配置不因此移除。方舟 Key 可在 Seedance 配置分组进行已实现的任务列表鉴权，但该结果不能替代文本图片型号的权限验收。官方凭据入口和附加字段见 [官方 Key 获取指南](../guides/official-provider-api-key-setup.md)。所有提供方仍须独立完成真实 Key 的模型调用验收。

Ark 参考请求选用 `doubao-seedance-2-5-260628`。官方[模型目录](https://docs.volcengine.com/docs/ark/model-list?lang=zh)列出全模态参考生视频能力、4–30 秒时长和 480p/720p/1080p 输出；[创建视频任务 API](https://api.volcengine.com/api-docs/view?action=CreateContentsGenerationsTasks&serviceCode=ark&version=2024-01-01)把参考视频和音频定义为 `video_url.url`、`audio_url.url`，示例使用 Ark 可访问的 HTTPS 地址。Seedance 2.5 提示指南说明单次最多 50 个图像/音视频参考，并要求首尾帧任务使用 `ratio=adaptive`；桌面请求据此限制参考总量并转换节点分辨率/首尾帧参数。

**本地视频/音频参考阻塞（2026-09-29，按 Ark 官方 API 契约核对）：** CreateContentsGenerationsTasks 的 `content` 示例与请求结构没有声明 `file_id`、`file_data` 或 Base64 字段；`video_url`/`audio_url` 下只给出 `url`。Ark [Files API](https://docs.volcengine.com/docs/ark/file-api?lang=zh)确实支持通过 `multipart/form-data` 的 `file` 上传本地二进制到 Ark 托管存储，使用 `purpose=user_data` 时只需要 Ark API Key，无需用户 TOS 凭据；默认单文件上限 512 MB、总容量 20 GB、保留 7 天（可配置 1–30 天），并支持通过[删除文件 API](https://docs.volcengine.com/docs/ark/delete-files-api?lang=en)清理。可是它返回的 `file_id` 在官方[Chat API](https://docs.volcengine.com/docs/ark/chat-api?lang=zh)和[Responses API](https://docs.volcengine.com/docs/ark/get-response-context-api?lang=en)文档中用于多模态理解；CreateContentsGenerationsTasks 没有规定如何把这个 ID 作为 Seedance 参考输入。因此不能把 `file_id`、`mm_file://`、本地路径或未声明的 `data:` URL 填进 Seedance 的 `url` 字段，也不能为这些任务先上传一份无法引用的用户媒体。当前桌面端在核验项目归属、索引 MIME/扩展名和文件大小后拒绝本地视频/音频参考，不发送本地路径或文件字节。

**解除阻塞所需输入：** Ark 官方文档或供应商书面确认需明确 Seedance 2.5 的 CreateContentsGenerationsTasks 接受 Files API `file_id`、本地字节/Base64 或数据 URL 中的哪一种，并给出可用 MIME/容器、大小限制、文件状态要求和删除/过期语义。收到这份契约后才能实现受控上传、幂等恢复与清理。当前可用输入是 Ark 可访问的 HTTPS 媒体地址：用户提供的地址，或用户已配置的 TOS Bucket 对象的预签名 HTTPS 地址；TOS 地址是否可访问应先由用户侧确认。Ark 托管存储上传不需 TOS 凭据，但 `file_id` 与 Seedance 任务 API 的连接仍缺乏官方契约。真实 Ark API Key 仍是验证端到端任务所需输入。

官方接口入口：[OpenAI](https://platform.openai.com/docs/api-reference/introduction)、[Claude](https://platform.claude.com/docs/en/api/overview)、[Gemini](https://ai.google.dev/api)、[DeepSeek](https://api-docs.deepseek.com/)、[阿里云百炼](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/text-generation)。这些链接用于实施时核验协议和能力，不意味着所有模态已接入。

## 注册表字段和行为

每个 provider 记录稳定 `providerId`、`local | cloud`、显示名、受控 endpoint、鉴权方式、密钥引用、可用模型目录。每个 model 记录模型 ID、模态、输入/输出格式、上下文窗口、工具调用、流式、取消、参考素材数量与格式、是否可用及不可用原因。Agent 与生成任务使用同一模型能力契约，但各自调用适配器可以不同。模型配置、节点与 Agent 选择器只显示已配置且能力匹配的组合；不因当前模型失败静默切换本地/云端或其他供应商。

云端 Key 经 OS 凭据能力保存，只在受控进程中使用。配置页披露该提供方会收到的数据类型和可能费用；用户选择云端模型并点击生成/发送后直接调用，不逐次弹系统确认。扩大发送范围时先更新披露和授权。本地模式不产生外部模型请求。供应商响应成功后仍须将结果写入本地项目并校验可读取，才能将任务标记成功。

## 接入验收

每家至少验证：有效/无效 Key、可用/不支持模态、工具调用与不支持工具调用、流式/非流式、取消能力、超时/断网、结果落盘、重启后任务恢复和用量展示。Agent 还要验证 50 条以上会话、一次上下文压缩、短期记忆、长期记忆与进程重启；摘要不能代替画布和任务权威状态。UI 验收按 [桌面 UI 保真清单](desktop-ui-parity.md) 执行。
