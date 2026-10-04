# LiteLLM 模型清单与接入方式（VibePaper 讨论稿）

> 历史研究；用户最新决定恢复 Pi 二次开发，当前实施见 [Pi 官方接入设计](2026-10-03-pi-official-provider-implementation.md)。以下目录不作为运行中的接入配置。

日期：2026-10-03。范围：保留原 72 项模型目标，优先使用 LiteLLM 已覆盖的官方 Key 调用路径；未覆盖的操作补充官方原生适配，fal.ai 等聚合渠道可选。下列 46 项是候选子集，不是 LiteLLM 支持上限或最终全量目录。仅调整设计与清单，没有修改运行中的模型选择器或接入实现。

## 选取规则

首批候选共 **46 个模型：文本 20、图片 10、视频 9、音频 7**。全部调用 ID 已与 LiteLLM 固定提交 `8b11b682f46fab627972d7f129bb0dceed6a88a2` 的模型目录核对，并检查相应提供方适配路径。目录存在和协议可复用，不等于用户账号已有权限，也不等于 VibePaper 已完成接入；正式显示需连接已配置、绑定已启用、能力符合节点、端到端验证通过。

LiteLLM 是调用适配库/网关，仍需上游 Key。此前图片表统一列 fal.ai 是渠道选择，不是技术限制；OpenAI、Google、Black Forest Labs、Recraft 均有官方 Key 图片接入。按用户官方优先要求，应优先选择这些官方连接，fal.ai 保留为可选连接。文本和部分视频/TTS 同样通过 LiteLLM 使用官方 Key。自部署 LiteLLM 不提供模型余额。最新边界见 [提供方文档复核](../research/2026-10-03-litellm-provider-documentation-audit.md)。

[模型目录源码](https://github.com/BerriAI/litellm/blob/8b11b682f46fab627972d7f129bb0dceed6a88a2/model_prices_and_context_window.json)、[可机器读取的选取清单](../research/2026-10-03-litellm-selected-models.json)。

## 文本：20

| 展示名称 | 品牌 | 上游连接 | LiteLLM 调用 ID |
| --- | --- | --- | --- |
| Claude Fable 5.1 | Anthropic | Anthropic | `anthropic/claude-fable-5-1` |
| Claude Haiku 4.5 | Anthropic | Anthropic | `anthropic/claude-haiku-4-5` |
| Claude Opus 5 | Anthropic | Anthropic | `anthropic/claude-opus-5` |
| Claude Opus 5.5 | Anthropic | Anthropic | `anthropic/claude-opus-5-5` |
| Claude Sonnet 4.6 | Anthropic | Anthropic | `anthropic/claude-sonnet-4-6` |
| GPT-5.6 Sol | OpenAI | OpenAI | `openai/gpt-5.6-sol` |
| GPT-5.6 Terra | OpenAI | OpenAI | `openai/gpt-5.6-terra` |
| GPT-5.6 Luna | OpenAI | OpenAI | `openai/gpt-5.6-luna` |
| GPT-6 Astra | OpenAI | OpenAI | `openai/gpt-6-astra` |
| GPT-6 Sol | OpenAI | OpenAI | `openai/gpt-6-sol` |
| GPT-6 Luna | OpenAI | OpenAI | `openai/gpt-6-luna` |
| Gemini 3.1 Pro Preview | Google | Google AI Studio | `gemini/gemini-3.1-pro-preview` |
| Gemini 3.6 Flash | Google | Google AI Studio | `gemini/gemini-3.6-flash` |
| Gemini 3.8 Flash | Google | Google AI Studio | `gemini/gemini-3.8-flash` |
| DeepSeek V4.1 Flash | DeepSeek | DeepSeek 官方 | `deepseek/deepseek-flash` |
| Grok 4.3 | xAI | xAI | `xai/grok-4.3` |
| Grok 4.7 | xAI | xAI | `xai/grok-4.7` |
| Kimi K2.5 | Moonshot | Moonshot | `moonshot/kimi-k2.5` |
| Seed 2.0 Mini | ByteDance | Volcengine | `volcengine/doubao-seed-2-0-mini-260215` |
| Seed 2.1 Pro | ByteDance | Volcengine | `volcengine/doubao-seed-2-1-pro-260628` |

## 图片：10（此前 fal.ai 渠道候选，非强制渠道）

| 展示名称 | 品牌 | 上游连接 | LiteLLM 调用 ID |
| --- | --- | --- | --- |
| Nano Banana | Google | fal.ai | `fal_ai/fal-ai/nano-banana` |
| Nano Banana 2 | Google | fal.ai | `fal_ai/fal-ai/nano-banana-2` |
| Nano Banana Pro | Google | fal.ai | `fal_ai/fal-ai/nano-banana-pro` |
| GPT-Image-2 | OpenAI | fal.ai | `fal_ai/openai/gpt-image-2` |
| GPT-Image-2.5 Flare | OpenAI | fal.ai | `fal_ai/openai/gpt-image-2.5/flare/text-to-image` |
| GPT-Image-2.5 Sunburst | OpenAI | fal.ai | `fal_ai/openai/gpt-image-2.5/sunburst/text-to-image` |
| FLUX Pro 1.1 | Black Forest Labs | fal.ai | `fal_ai/fal-ai/flux-pro/v1.1` |
| FLUX Pro 1.1 Ultra | Black Forest Labs | fal.ai | `fal_ai/fal-ai/flux-pro/v1.1-ultra` |
| Recraft V3 | Recraft | fal.ai | `fal_ai/fal-ai/recraft/v3/text-to-image` |
| Seedream 3 | ByteDance | fal.ai | `fal_ai/fal-ai/bytedance/seedream/v3/text-to-image` |

## 视频：9

| 展示名称 | 品牌 | 上游连接 | LiteLLM 调用 ID |
| --- | --- | --- | --- |
| Seedance 2.0 | ByteDance | fal.ai | `fal_ai/bytedance/seedance-2.0/text-to-video` |
| Seedance 2.5 | ByteDance | fal.ai | `fal_ai/bytedance/seedance-2.5/text-to-video` |
| MiniMax H3 | MiniMax | fal.ai | `fal_ai/minimax/h3/text-to-video` |
| Veo 3.1 | Google | Google AI Studio | `gemini/veo-3.1-generate-001` |
| Veo 3.1 Fast | Google | Google AI Studio | `gemini/veo-3.1-fast-generate-001` |
| Veo 3.1 Lite Preview | Google | Google AI Studio | `gemini/veo-3.1-lite-generate-preview` |
| Sora 2 | OpenAI | OpenAI | `openai/sora-2` |
| Sora 2 Pro | OpenAI | OpenAI | `openai/sora-2-pro` |
| Runway Gen-4.5 | Runway | Runway | `runwayml/gen4.5` |

## 音频：7

| 展示名称 | 品牌 | 上游连接 | LiteLLM 调用 ID |
| --- | --- | --- | --- |
| Eleven Multilingual v2 | ElevenLabs | ElevenLabs | `elevenlabs/eleven_multilingual_v2` |
| Eleven v3 | ElevenLabs | ElevenLabs | `elevenlabs/eleven_v3` |
| MiniMax Speech 2.6 HD | MiniMax | MiniMax | `minimax/speech-2.6-hd` |
| MiniMax Speech 2.6 Turbo | MiniMax | MiniMax | `minimax/speech-2.6-turbo` |
| Gemini 3.8 Flash TTS | Google | Google AI Studio | `gemini/gemini-3.8-flash-tts` |
| Gemini 3.8 Flash-Lite TTS | Google | Google AI Studio | `gemini/gemini-3.8-flash-lite-tts` |
| GPT-4o Mini TTS | OpenAI | OpenAI | `openai/gpt-4o-mini-tts` |

文本部分基本保留原清单。Gemini 3.1 Pro 明确标 Preview。根据 [LiteLLM DeepSeek 文档](https://docs.litellm.ai/docs/providers/deepseek)，DeepSeek 官方连接可直接使用 `deepseek/deepseek-flash`，文档明确将其对应到 DeepSeek V4.1 Flash；无需增加 W&B 连接。此前仅根据目录中的 W&B 精确型号名称选择渠道不完整，现已修正。该文档也说明旧 `deepseek-v4-flash` 别名由 V4.1 Flash 提供服务；实际版本仍以供应商当前别名映射为准。

图片清单把 Banana 统一使用渠道实际 Nano Banana 名称；Seedream 暂列明确有专用适配的 v3，不用 v3 冒充原目标 5.0/5.0 Pro。基础首批范围是生成，编辑、mask、扩图和高参考图上限逐型号验收后开放。GPT-Image 的 fal 生成和编辑属于不同模型路径。

视频中 Seedance 2.0/2.5 在 UI 各显示一项，按输入模式选择下列 endpoint，不作为六个独立模型显示：

| 展示型号 | 文生视频 | 图生视频 | 参考素材生视频 |
| --- | --- | --- | --- |
| Seedance 2.0 | `fal_ai/bytedance/seedance-2.0/text-to-video` | `fal_ai/bytedance/seedance-2.0/image-to-video` | `fal_ai/bytedance/seedance-2.0/reference-to-video` |
| Seedance 2.5 | `fal_ai/bytedance/seedance-2.5/text-to-video` | `fal_ai/bytedance/seedance-2.5/image-to-video` | `fal_ai/bytedance/seedance-2.5/reference-to-video` |
| MiniMax H3 | `fal_ai/minimax/h3/text-to-video` | 不以单图入口冒充专用支持 | `fal_ai/minimax/h3/reference-to-video` |

fal 的 input_reference 当前要求可访问的图片 URL，不能直接填项目路径。输入本地媒体需要单独实现受控上传及引用验证，扩大发送范围需体现在配置页披露中。H3 的参考图字段与 Seedance 不同；参数默认不能跨型号复制。

音频首批均是 TTS，不包含变声、声音克隆/设计或音乐。MiniMax 先用 2.6，不将未核验的 2.8 写成已支持。ElevenLabs 音频容器与声音 ID、MiniMax HTTP 非流式与 URL 返回限制仍需按调研报告处理。

## 所需连接与凭据

Key 只存系统凭据库。下列环境变量名是 LiteLLM 文档/适配器使用的开发约定，产品可以从凭据库取出后按调用传 `api_key`，不要求用户手工设置环境变量或将 Key 放进 YAML。

| 连接 | 需要填写 | 用途 |
| --- | --- | --- |
| fal.ai | fal API Key；SDK 常用 FAL_AI_API_KEY | 本清单全部图片，Seedance 2.0/2.5、MiniMax H3 |
| Anthropic | Anthropic API Key | Claude 文本 |
| OpenAI | OpenAI API Key | GPT 文本、Sora、GPT-4o Mini TTS |
| Google AI Studio | Gemini API Key | Gemini 文本、Veo、Gemini TTS |
| xAI | xAI API Key | Grok 文本 |
| Moonshot | Moonshot API Key | Kimi 文本 |
| Volcengine | Ark API Key，必要时核对模型/推理接入点 ID | Seed 文本 |
| DeepSeek | DeepSeek 官方 API Key | DeepSeek V4.1 Flash |
| ElevenLabs | ElevenLabs API Key；另选择真实 voice_id | ElevenLabs TTS |
| MiniMax | MiniMax API Key；另选择声音与地区地址 | MiniMax TTS |
| Runway | Runway API Key | Gen-4.5 视频 |

不要要求用户配置全部连接。选中的模型只需要其对应连接；例如先填 fal Key，就能进入本清单图像与 Seedance/H3 的接入验证。LiteLLM SDK 路线无需单独 LiteLLM 平台 Key；连接用户自己部署的 Proxy 时另需其地址和网关访问令牌。

## 推荐接入方式

```text
原 ModelPicker / 配置页
        │ 受限 IPC，业务参数 + 模型绑定 ID
本地 Provider Registry + OS 凭据库 + TaskStore
        │
受控 Python Generation Worker
        │ LiteLLM SDK
        ├─ fal.ai
        ├─ Anthropic / OpenAI / Google / ...
        └─ 下载结果到项目、校验、原子落盘
```

原前端组件和 Pi Agent 链路继续复用；文字节点可以用 LiteLLM，Agent 是否替换模型调用由其原 Pi 适配边界单独处理，不把 LiteLLM completion 直接当成原 Agent 会话、工具、确认、记忆和上下文机制。

| 节点 | SDK 调用 | 如果连接外部 LiteLLM Proxy |
| --- | --- | --- |
| Text | `acompletion`，需要 Responses 的模型按能力使用 `aresponses` | `/v1/chat/completions` 或 `/v1/responses` |
| Image 生成 | `aimage_generation` | `/v1/images/generations` |
| Image 编辑 | `aimage_edit`，逐型号配置编辑 route | `/v1/images/edits` |
| Video | `avideo_generation → avideo_status → avideo_content` | `POST /v1/videos → GET /v1/videos/{id} → GET /v1/videos/{id}/content` |
| Audio TTS | `aspeech` | `/v1/audio/speech` |

SDK 示例仅展示路由，真实代码中的 `provider_key` 必须来自受控凭据能力：

```python
import litellm

# 图片生成
image = await litellm.aimage_generation(
    model="fal_ai/fal-ai/nano-banana-pro",
    prompt="一张电影海报",
    api_key=provider_key,
)

# 视频创建：立即持久化返回 ID，后续恢复查询同一任务
video = await litellm.avideo_generation(
    model="fal_ai/bytedance/seedance-2.5/text-to-video",
    prompt="镜头缓缓推近森林中的木屋",
    api_key=provider_key,
)
```

例子不代表所有画幅、分辨率、时长和音频字段使用相同名字。保存每个绑定的能力与参数 schema；请求前校验，不能打开 drop_params 后静默丢弃用户参数。视频创建超时且供应商可能已受理时，不自动重新创建或切换模型。任务恢复绑定原连接和 upstream ID；成功以输出已落盘且可读取为准。

桌面默认使用 SDK，无须 Docker、PostgreSQL、Redis 或公网服务。LiteLLM 发布版本、Python 运行时与依赖需锁定，包含 fal 最新适配所需功能；目录来源 main 的版本号不等于该 PyPI 正式包已经发布或通过安装包测试。三平台分别验收。

## 扩展候选，不进入首批自动启用列表

- Kling 3.0/Omni、Wan 2.7/3.0、Vidu Q3、PixVerse V6、Grok 视频/1.5：fal 已有模型 endpoint，但当前 LiteLLM fal 通用映射主要围绕 Seedance/H3，需补原生字段并验证后再加入。
- Seedream 5.0/5.0 Pro、Banana 2 Lite、Qwen Image Edit Plus、Wan 图片、Z-Image：尚未在本轮确认精确 LiteLLM 操作路径与能力，不只凭渠道同名列表开放。
- Runway 目录还登记了 `runwayml/seedance2`、`runwayml/seedance2_5`、`runwayml/seedance2_fast`、`runwayml/seedance2_mini`、`runwayml/hailuo3`、`runwayml/gemini_omni_flash`。可作为同型号的后续渠道绑定，但先验证账户权限与各操作参数，避免一开始增加重复模型行。
- 变声、声音创建、Fish/Doubao TTS、MiniMax Music：不因 LiteLLM 有 audio/speech 就标支持。
- Agnes：现有官方接口继续保留为兼容路径，单独分组；不宣称 LiteLLM 已提供 Agnes adapter，也不删除旧项目绑定。
- 超分、Compose、DirectorStage、Stack、Group、Document 沿用原无模型设计。

## 默认选择建议

文本保留 Claude Fable 5.1；图片改为 Nano Banana Pro（fal.ai），1:1/2K 作为需验证的期望默认；视频保留 Seedance 2.5（fal.ai），15 秒/480p/生成音频作为需验证的期望默认；音频建议 Eleven Multilingual v2 并要求选择有效声音。

默认值只在该连接已配置、型号已启用且参数能力验证通过时生效。没有可用默认模型时提示配置，不自动联网换模型；fal 渠道能力不能沿用原 Ark 默认参数契约。模型选择器按品牌，配置页按实际连接，模型行显示“通过 fal.ai”等渠道。

## 验收与来源

46 项调用 ID 已静态核对；没有真实 Key 实测，不代表 46 条链路已完成。执行时按连接测试、参数保真、正确媒体输入、生成结果本地落盘、重启恢复与错误反馈逐条验收。

- [LiteLLM 模型目录](https://github.com/BerriAI/litellm/blob/8b11b682f46fab627972d7f129bb0dceed6a88a2/model_prices_and_context_window.json)
- [fal 接入说明](https://docs.litellm.ai/docs/providers/fal_ai)
- [fal 视频源码](https://github.com/BerriAI/litellm/blob/8b11b682f46fab627972d7f129bb0dceed6a88a2/litellm/llms/fal_ai/videos/transformation.py)
- [Runway 视频源码](https://github.com/BerriAI/litellm/blob/8b11b682f46fab627972d7f129bb0dceed6a88a2/litellm/llms/runwayml/videos/transformation.py)
- [图片编辑](https://docs.litellm.ai/docs/image_edits)、[视频调用](https://docs.litellm.ai/docs/videos)
- [ElevenLabs](https://docs.litellm.ai/docs/providers/elevenlabs)、[MiniMax](https://docs.litellm.ai/docs/providers/minimax)
- [Gemini 3.8 TTS](https://docs.litellm.ai/blog/gemini_3_8_flash_tts)
