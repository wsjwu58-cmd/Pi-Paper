# LiteLLM 提供方文档复核

日期：2026-10-03。范围：复核与 VibePaper 原模型清单相关的提供方及操作。文档和固定提交源码证据不代表真实 Key、账号权限及端到端调用已验收；本轮未执行付费生成。

## 修正结论

- LiteLLM 是调用适配层，官方厂商和 fal.ai 是上游连接，两者不是互斥方案。默认优先官方 Key，未覆盖的操作由原生适配实现。
- 原 72 项模型保留为目标；此前 46 项是候选子集，不能作为支持总量或替代原范围。原视频清单实际 25 项，标题 26 的缺项仍待补充。
- DeepSeek 原生接入使用 `deepseek/deepseek-flash` 与官方 Key；文档将其对应为 DeepSeek V4.1 Flash。无需 W&B 或其他转售渠道。
- 图片统一列 fal.ai 的旧表只代表一种上游选取。官方图片连接应优先纳入。
- 能力必须按“模型、连接、操作、参数、输入模式”核验；同一提供方支持文本不意味着视频、音乐、变声全部支持。

## 官方 Key 与适配边界

| 提供方 | LiteLLM 官方连接已确认的操作 | 接入标识／凭据 | 边界与来源 |
| --- | --- | --- | --- |
| DeepSeek | 文本、流式、推理 | `deepseek/`、`DEEPSEEK_API_KEY` | [文档](https://docs.litellm.ai/docs/providers/deepseek) |
| Anthropic | Claude 文本、消息、工具相关接口 | `anthropic/`、`ANTHROPIC_API_KEY` | [文档](https://docs.litellm.ai/docs/providers/anthropic)；不表示图片生成 |
| OpenAI | 文本、图片生成／编辑、语音、Sora 视频 | `openai/`、`OPENAI_API_KEY` | [提供方](https://docs.litellm.ai/docs/providers/openai)、[图片编辑](https://docs.litellm.ai/docs/image_edits)；逐型号、操作验证 |
| Google AI Studio | Gemini 文本、图片、TTS、Veo 视频 | `gemini/`、`GEMINI_API_KEY` | [图片](https://docs.litellm.ai/docs/providers/google_ai_studio/image_gen)、[视频](https://docs.litellm.ai/docs/providers/gemini/videos)、[提供方](https://docs.litellm.ai/docs/providers/gemini) |
| Moonshot | Kimi 文本 | `moonshot/`、`MOONSHOT_API_KEY` | [文档](https://docs.litellm.ai/docs/providers/moonshot)；全球／中国 API Base 区分 |
| Volcengine | 文本、Embedding | `volcengine/<模型或端点ID>`、`VOLCENGINE_API_KEY`／`ARK_API_KEY` | [文档](https://docs.litellm.ai/docs/providers/volcano)；不据此确认 Seedance 视频、Doubao TTS |
| xAI | Grok 文本 | `xai/`、`XAI_API_KEY` | [文档](https://docs.litellm.ai/docs/providers/xai)；Grok 视频需独立适配证明 |
| MiniMax | 文本、TTS | `minimax/`、`MINIMAX_API_KEY` | [文档](https://docs.litellm.ai/docs/providers/minimax)；H3 视频、Music、Speech 2.8 逐项验证 |
| ElevenLabs | TTS、音频转写 | `elevenlabs/`、`ELEVENLABS_API_KEY` | [文档](https://docs.litellm.ai/docs/providers/elevenlabs)；Voice Changer 不由 TTS 支持推导 |
| DashScope／Qwen | Qwen 文本等现有适配 | `dashscope/`／新别名、`DASHSCOPE_API_KEY` | [文档](https://docs.litellm.ai/docs/providers/dashscope)；Wan 视频、Qwen Image Edit Plus 操作独立验证 |
| Black Forest Labs | FLUX 图片 | `black_forest_labs/`、`BFL_API_KEY` | [文档](https://docs.litellm.ai/docs/providers/black_forest_labs) |
| Recraft | 图片生成、编辑 | `recraft/recraftv3`、`RECRAFT_API_KEY` | [文档](https://docs.litellm.ai/docs/providers/recraft) |
| Runway | 图片、视频 | `runwayml/`、`RUNWAYML_API_KEY` | [图片](https://docs.litellm.ai/docs/providers/runwayml/images)、[视频](https://docs.litellm.ai/docs/providers/runwayml/videos)；视频文档明确示例 gen4_turbo，gen4.5 候选需进一步验收 |
| Agnes | 沿用现有官方接入 | 项目原生适配 | 用户确认现有 Agnes 是官方 Key；不假设存在 LiteLLM 专用提供方 |

## 图片表可增加的官方连接

以下是同模型的连接候选，不是自动故障切换。别名及权限需以账号实际可用模型为准；生成与编辑分别验收。

| 模型 | 官方 LiteLLM 调用 ID 候选 | Key |
| --- | --- | --- |
| Nano Banana | `gemini/gemini-2.5-flash-image` | Google |
| Nano Banana 2 | `gemini/gemini-3.1-flash-image` | Google |
| Nano Banana Pro | `gemini/gemini-3-pro-image` | Google |
| GPT-Image-2 | `openai/gpt-image-2` | OpenAI |
| GPT-Image-2.5 Flare | `openai/gpt-image-2.5-flare` | OpenAI |
| GPT-Image-2.5 Sunburst | `openai/gpt-image-2.5-sunburst` | OpenAI |
| FLUX Pro 1.1 | `black_forest_labs/flux-pro-1.1` | BFL |
| FLUX Pro 1.1 Ultra | `black_forest_labs/flux-pro-1.1-ultra` | BFL |
| Recraft V3 | `recraft/recraftv3` | Recraft |

型号目录证据：[固定提交成本／模型目录](https://github.com/BerriAI/litellm/blob/8b11b682f46fab627972d7f129bb0dceed6a88a2/model_prices_and_context_window.json)。Google 图片文档还示例 preview 别名，应按真实权限选择，不把目录条目视为已验证调用。

## 视频、音频缺口的处理

Seedance／BytePlus、Kling、Wan、MiniMax 视频、Vidu、PixVerse、Grok 视频的官方操作，不因品牌出现在总目录就算已接入。当前复核证据未确认其完整官方视频适配，应保留官方原生适配任务。fal.ai 可作为用户主动配置的另一条连接；fal 上架某模型也不等于 LiteLLM 对其全部首尾帧、参考视频、音频输入等参数均已完成映射。

音频需区分 TTS、转写、变声、音乐、克隆和声音设计。ElevenLabs TTS 不等于 Voice Changer；MiniMax TTS 不等于 Music；Doubao 与 Fish Audio 的目标操作保留官方原生接入或进一步核验。

特别反例：[Gemini Lyria 文档](https://docs.litellm.ai/docs/providers/gemini/music)注明当前相关模型用于成本元数据和用量追踪，并无独立音乐生成 helper。因此页面存在或成本目录存在不能单独证明生成接口支持。

## VibePaper 路由规则

1. 用户配置并选择上游连接：官方、本地或聚合渠道；明确供应商与发送范围。
2. 同一官方连接内，操作有完整 LiteLLM 适配时走 LiteLLM；否则走官方原生适配。不能让用户为了使用同一厂商重复配置 Key。
3. 连接选择不随失败静默改变，不自动切换至 fal.ai 或其他供应商。
4. Provider Registry 显式保存 `adapterEngine`、`upstreamProvider`、`credentialRef`、`operation`、`modelId`、能力约束与验证状态。Renderer 不读取 Key。
5. 模型选择按品牌分组，必要时标连接名称；仅显示配置已保存、已启用、适配已实现且节点能力匹配的绑定。TaskStore 保留异步查询、重启恢复与本地结果落盘判定。
6. 桌面优先复用受控 Python 子进程中的 LiteLLM SDK；不为本功能引入 Docker、Redis 或强制全量 Proxy 服务。
