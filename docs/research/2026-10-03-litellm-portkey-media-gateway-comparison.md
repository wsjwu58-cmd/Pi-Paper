# LiteLLM 与 Portkey Gateway：官方 Key 多媒体接入调研

调研日期：2026-10-03。适用项目：VibePaper 单用户 Electron 桌面版。目标是用户自己的厂商官方 Key，重点评估图片生成/编辑/扩图、视频生成、语音/变声/声音创建/音乐。Agnes 按用户确认，属于已接入的官方提供方。

## 1. 结论与选型

**在两者之间，优先选 LiteLLM 复用多媒体协议适配；不建议把 Portkey Gateway 作为当前创作模型接入的唯一底座。**

推荐方案是 **VibePaper Provider Registry + 本地 TaskStore + 官方原生适配器 + 按需使用 LiteLLM Python SDK**。LiteLLM 放在现有受控生成 Worker 边界内，Portkey 暂不成为默认运行依赖。文字与 Agent 保留原 Pi 服务链路，不因选型重写。

原因不是厂商或模型数量，而是公开源码中能复用的真实链路：

- LiteLLM 有独立的 Gemini 图片生成/编辑、Veo 视频异步协议、ElevenLabs TTS、MiniMax TTS 实现。
- Portkey 公开 Gateway 有图片与音频统一入口、路由、重试和通用透传，但本次检查的两个公开分支没有对应的统一视频生命周期和上述全部专用媒体适配。
- 两者都不能直接兑现用户清单中所有官方模型。默认图片 Seedream、默认视频 Seedance 的官方特殊参数和任务生命周期，仍应优先原生接入。
- Portkey 的 TypeScript/Hono 技术栈更贴近桌面 Node 环境；LiteLLM 的 Python 依赖与跨平台打包成本更高。如果只复用一两个接口，直接官方 SDK/HTTP 可能比引入整个库更省事。因此 LiteLLM 是候选复用件，正式运行依赖应经过小范围验证。

这是基于协议实现的选型判断，不是实测性能排行；没有用真实 Key 调用付费生成，没有测冷启动、包体、吞吐或故障率。

## 2. 方法与证据边界

同时查阅官方文档、固定提交的源代码、提供方注册表、请求参数转换、响应与错误处理、上游测试文件。避免把网站当前产品能力直接计为开源代码能力。

| 项目 | 源码快照 | 说明 |
| --- | --- | --- |
| LiteLLM | `8b11b682f46fab627972d7f129bb0dceed6a88a2` | main 快照，pyproject 声明版本 1.105.0 |
| Portkey Gateway main | `669825cbe89ee51569918b8f78a9db486fd69dd4` | 公开主分支 |
| Portkey Gateway 2.0.0 | `8febc1dc1d85053dd374922e547b4db1af0fab79` | README 指向的 2.0.0 预发布分支快照 |

源码检索材料保存在 `.firecrawl/litellm-portkey-research/`。负面结论限定为上述快照中“未确认原生适配”，不代表不能使用透传，也不代表未来版本不会增加。

区分四类证据：

1. **专用适配**：网关实际完成鉴权、请求转换、响应处理，异步模型还需提交/查询/下载。
2. **兼容接口或透传**：官方协议足够兼容时可能复用，但 VibePaper 仍负责特有参数和状态。
3. **官网托管产品文档**：能说明网站服务能力，不能直接证明公开仓库提供相同实现。
4. **聚合渠道**：通过 fal.ai、Together 等使用同名模型，不满足该模型厂商官方 Key 优先要求。

用户给的视频清单标题写 26，实际列出 25。本文按已列出的 25 项评估。具体展示名、官方 apiModelId、地区、版本、账号权限仍需逐项核验，未做“全部模型已可调用”的承诺。

## 3. 核心对比

| 评估项 | LiteLLM | Portkey 公开 Gateway | 项目判断 |
| --- | --- | --- | --- |
| 官方图片适配 | OpenAI、Gemini、Vertex、部分 Dashscope 等专用实现；兼容接口回退 | OpenAI、Vertex 等图片适配；主分支 Google/Dashscope 注册以聊天/嵌入为主 | LiteLLM 可复用范围更贴近图片节点 |
| 图片编辑 | 独立 image_edit；OpenAI multipart、多图、mask；Gemini generateContent 多图编辑 | 有 images/edits，OpenAI multipart 透传；不同厂商覆盖需单独查 | LiteLLM 较完整，扩图仍需原生能力判断 |
| 视频任务 | 独立视频配置和提交/状态/下载接口，含 Gemini/Vertex Veo | 两个快照没有统一 videos 专用路由；通用代理可转发原生请求 | LiteLLM 明显更适合复用视频协议 |
| ElevenLabs/MiniMax TTS | 有官方专用转换 | 官网有 ElevenLabs 统一 TTS 文档，两个源码快照未确认对应提供方适配 | 自包含桌面版优先 LiteLLM 或直连 |
| 变声、声音创建、音乐 | TTS 支持不能视为这些能力的支持 | 可透传，不等于统一能力支持 | 两者均需要补原生业务适配 |
| 官方中国创作模型 | Seedance、Wan、Kling 等专用链路有明显缺口 | 同样存在缺口 | 原生适配器不可省 |
| 接入桌面 Node 栈 | Python SDK，需受控子进程和打包 | TypeScript/Hono，可 Node 子进程 | Portkey 工程嵌入更轻便 |
| 任务恢复、输出落盘 | 提供协议工具，不替代本地领域状态 | 同左 | 始终由 TaskStore/AssetStore 负责 |

证据入口：[LiteLLM 图片文档](https://docs.litellm.ai/docs/image_generation)、[图片编辑文档](https://docs.litellm.ai/docs/image_edits)、[视频文档](https://docs.litellm.ai/docs/videos)、[Portkey 主路由](https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/index.ts)、[Portkey 2.0 主路由](https://github.com/Portkey-AI/gateway/blob/8febc1dc1d85053dd374922e547b4db1af0fab79/src/index.ts)。

## 4. 图片：生成、编辑、参考图、扩图分别评估

### 4.1 LiteLLM 可复用内容

OpenAI GPT 图片生成配置声明 background、moderation、output_compression、output_format、quality、size 等字段；图片编辑支持 multipart 与多图。Gemini 图片生成/编辑使用其原生 generateContent，编辑将参考图转为 inline base64，并返回图片数据。Google imageConfig 可承载画幅和图片尺寸，不能把所有供应商都简化成一个 size 字符串。

但是 **image_edit 不自动等于 mask 局部重绘或扩图**。Gemini 编辑适配声明 n、size、imageConfig，本次快照不能据此确认统一 mask 能力。VibePaper 要分别记录 edit、inpaint、outpaint，按模型展示入口。

依据：[GPT 图片转换](https://github.com/BerriAI/litellm/blob/8b11b682f46fab627972d7f129bb0dceed6a88a2/litellm/llms/openai/image_generation/gpt_transformation.py)、[OpenAI 编辑转换](https://github.com/BerriAI/litellm/blob/8b11b682f46fab627972d7f129bb0dceed6a88a2/litellm/llms/openai/image_edit/transformation.py)、[Gemini 编辑转换](https://github.com/BerriAI/litellm/blob/8b11b682f46fab627972d7f129bb0dceed6a88a2/litellm/llms/gemini/image_edit/transformation.py)。

### 4.2 Portkey 的字段过滤是实际风险

主分支 OpenAI imageGenerate 配置主要包含 prompt/model/n/quality/response_format/size/style/user。JSON 转换只遍历配置声明的字段，其他字段不会进入转换结果。因而走该统一入口时，background、output_format、output_compression 等新参数存在被过滤的问题。n 还按 1–10 自动限幅；这是生成张数，不是参考图数量。

images/edits 的 FormData 会直接透传，所以不能把 JSON 入口的过滤问题一概套到 multipart 编辑。使用 generic proxy 可以保留原生 JSON，但需要绕开统一转换，并自行验证响应与路由语义。正式接入必须对最终发送的请求做断言。

依据：[OpenAI 图片参数配置](https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/providers/openai/imageGenerate.ts)、[请求转换](https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/services/transformToProviderRequest.ts)。

### 4.3 对用户 16 个图片模型的落地判断

| 模型组 | LiteLLM 复用判断 | Portkey 复用判断 | 推荐实施 |
| --- | --- | --- | --- |
| GPT-Image-2、2.5 Flare、2.5 Sunburst | GPT 图片协议可复用；具体 ID、编辑上限与版本须验证 | OpenAI 图片基础可复用，新字段过滤要处理 | LiteLLM 或官方 SDK；逐型号验证 16 图输入 |
| Banana 2、2 Lite、Pro | 若对应 Google 官方 Gemini 图像型号，可复用生成/编辑；展示名需映射 | main 的 Google 无对应统一图片转换；可原生透传 | Google 原生协议或 LiteLLM；验证 2K、参考图、编辑/扩图 |
| Seedream 5.0、5.0 Pro | 没有据此确认该版本专用 Ark 图像适配；兼容路径可能复用基础请求 | 未确认专用实现 | 优先 Ark 官方原生；保留 14/10 图等模型差异 |
| Qwen Image Edit Plus | Dashscope 有 Qwen 图片生成代码，但不等于该编辑型号 | Dashscope 注册不能证明图片编辑支持 | 官方编辑协议原生适配 |
| Wan 2.7 Image Pro | 未确认目标官方专用适配 | 未确认 | 官方原生生成/扩图协议 |
| Z-Image Turbo | 未确认目标官方服务与专用适配 | 未确认 | 先核验官方服务、再实现 |
| Grok Imagine | xAI 在 LiteLLM OpenAI 兼容图片生成回退名单内；特殊字段与编辑另验 | x-ai 注册以文本为主，可透传 | xAI 官方接口，兼容部分按验证结果复用 |
| Agnes Image 2.0/2.1/2.5 Flash | 两者没有项目 Agnes 专用适配证据 | 同左 | 保留现有 Agnes 官方适配 |
| Midjourney V8.2 | 网关支持第三方渠道不能解决官方 API 可得性 | 同左 | 官方可用性未满足时不进入已配置可用目录 |

LiteLLM 的 FalAI ByteDance 图像转换是 fal.ai 渠道，不是 Ark 官方 Key 适配。OpenAI-compatible 回退也不是“所有名为 volcengine 的媒体模型都被验证支持”。依据：[图片调用分派](https://github.com/BerriAI/litellm/blob/8b11b682f46fab627972d7f129bb0dceed6a88a2/litellm/images/main.py)、[Fal ByteDance 转换](https://github.com/BerriAI/litellm/blob/8b11b682f46fab627972d7f129bb0dceed6a88a2/litellm/llms/fal_ai/image_generation/bytedance_transformation.py)、[Dashscope 图片转换](https://github.com/BerriAI/litellm/blob/8b11b682f46fab627972d7f129bb0dceed6a88a2/litellm/llms/dashscope/image_generation/transformation.py)。

Midjourney 官方当前说明除少量明确授权例外外，不提供 API。应把官方接入资格当成单独待核验项，不能用第三方代理补成“官方 Key 支持”。[官方说明](https://docs.midjourney.com/hc/en-us/articles/32013696484109-Community-Guidelines)。

## 5. 视频：LiteLLM 的优势最大，但并不覆盖主清单

### 5.1 Veo 可复用什么

LiteLLM Gemini 视频适配使用 x-goog-api-key 调用 predictLongRunning，处理 operation 状态与视频获取。统一 seconds 转 durationSeconds，已知 size 预设转 aspectRatio/resolution，input_reference 转 image。

需要关注三个边界：

- 未识别的非空 size 会默认转成 16:9；项目应先校验，避免用户参数被改写。
- 当前 request transform 显式把 image 放入 instances，其余参数放入 parameters。因此 referenceImages、lastFrame 等原生字段不能仅凭 extra_body 可用就认定发送层级正确，必须逐项检查。
- 同一适配中的 list/delete/remix/edit/extension 等方法有 NotImplementedError。统一视频 API 存在这些入口，不代表 Veo 也支持。删除任务记录与取消供应商生成也不能混为一谈。

依据：[Gemini 视频转换完整源码](https://github.com/BerriAI/litellm/blob/8b11b682f46fab627972d7f129bb0dceed6a88a2/litellm/llms/gemini/videos/transformation.py)。

### 5.2 Portkey 可以代理视频，但不能省掉生命周期实现

公开主分支和 2.0 快照有通用 POST/GET/DELETE 代理入口，因此不能说“完全无法发送视频请求”。但本次没有确认专用统一视频 adapter，提交、查询、媒体鉴权下载、供应商状态映射、恢复和取消仍需要自行完成。

如果主要使用它的透传，多媒体适配代码几乎仍要全部写，网关额外带来的价值主要是路由与可靠性策略。对于本地单用户桌面版，这个价值不足以优先替代现有 Generation Worker。[通用代理处理](https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/handlers/proxyHandler.ts)。

### 5.3 对 25 个视频模型的判断

| 用户模型组 | 官方 Key 可复用情况 | 推荐 |
| --- | --- | --- |
| Veo 3.1、3.1 Lite | LiteLLM 有 Gemini/Vertex 视频适配，型号与能力仍需核验 | LiteLLM 候选，重点验证首尾帧/参考图/音轨 |
| Seedance 2.0、2.5、2.0 Fast、2.0 Mini、1.5 Pro | 未确认 LiteLLM/Portkey 目标 Ark 专用视频链路 | 复用项目现有 Ark 路线，原生完善 |
| BytePlus Seedance 2.0/Fast/Mini | 未确认两者专用实现；不能沿用 Ark 地址和账户假设 | 独立 BytePlus 官方连接/适配 |
| Kling 3.0 Omni、Kling V3 | 未确认两者原生官方适配 | 原生提交/查询/下载 |
| Grok Imagine Video、1.5 | LiteLLM 视频配置名单未确认 xAI 专用 adapter；其 Batch 透传不等于统一视频任务 | 原生 xAI 视频接口 |
| Wan 2.7、3.0 | Dashscope 文字/图片生成支持不等于 Wan 视频支持 | 原生异步适配 |
| MiniMax Hailuo 2.3 Fast、H3、H3 Local | MiniMax TTS 支持不能推出 Hailuo；Local 还需明确运行协议 | 云端/本地分别核验原生适配 |
| Vidu Q3 Pro、PixVerse V6 | 未确认目标官方 adapter | 原生适配 |
| Agnes Video 2.5 Flash | 保留已接入官方链路 | 迁入统一 Registry，不替换渠道 |
| Happyhorse、Happyhorse 1.1、Gemini Omni Flash | 未确认这些具体目标的官方接入契约及原生 adapter | 待官方文档与账号验证 |

LiteLLM 配置管理中原生视频包括 OpenAI、Azure、Gemini、Vertex、Runway；另有 FAL、Hosted vLLM、EdenAI 路径。后者不能作为目标品牌官方 Key 已接入的证据。[ProviderConfigManager](https://github.com/BerriAI/litellm/blob/8b11b682f46fab627972d7f129bb0dceed6a88a2/litellm/utils.py)。

项目现有契约特别指出：Ark Files API 的 file_id 尚无明确证据可以接入 Seedance 2.5 生成任务的参考视频/音频字段。引入任一网关都不能消除这个上传契约缺口；应继续遵循 desktop-provider-registry.md，不能擅自上传后拼接未声明的引用。

## 6. 音频：TTS 与创作音频需要分开

| 用户模型/任务 | LiteLLM | Portkey 公开源码与官网区别 | 推荐 |
| --- | --- | --- | --- |
| Eleven Flash v2.5、Multilingual v2 | 有官方 TTS adapter，xi-api-key 与 voice_id 转换 | 官网声明统一 TTS/STT；两个公开快照未确认 ElevenLabs 专用 provider | LiteLLM 或官方 TTS |
| ElevenLabs Voice Changer | TTS adapter 不覆盖 speech-to-speech | 官网其他声音 API 也要求 custom host 原生路径 | 原生变声适配，输入参考音频 |
| MiniMax Speech 2.8 HD/Turbo | 有 MiniMax HTTP TTS adapter；2.8 具体 ID/字段需验证 | 未确认专用 TTS adapter | LiteLLM 基础 TTS，特殊能力原生补齐 |
| MiniMax Music 2.6 | MiniMax TTS 不覆盖音乐 | 未确认专用 adapter | 独立音乐接口与参数 |
| Doubao TTS v1/v2 | 未确认豆包官方 TTS adapter | 未确认 | 原生鉴权/资源 ID/流式协议 |
| Doubao Voice Creation | 未确认声音克隆/设计专用 adapter | 未确认 | 独立创建、训练/查询、voice_id 保存 |
| Fish Audio S1/S2 Pro | 未确认官方专用 adapter | 未确认 | 原生 TTS、参考音频与声音资源 |

### 6.1 LiteLLM 音频实现的具体限制

ElevenLabs：支持官方 text-to-speech，OpenAI 常见 voice 名会映射到 ElevenLabs 声音 ID，未知名称按原 ID 使用。项目应保存用户明确选择的 voice_id，不依赖跨供应商声音别名。输出支持音频格式映射，默认可为无 WAV 头的 PCM；不能只把字节保存成 .mp3。需要真实 MIME、采样率、编码和容器检测。

MiniMax：当前适配调用官方 /v1/t2a_v2，speed 会限制在 0.5–2.0，HTTP 请求使用 stream:false。返回 hex 音频可以解码；若响应使用 audio_url，当前转换会抛出“URL 格式尚不支持”的错误，而不是自动下载。因而长音频、URL 输出、WebSocket 流式不能直接宣称覆盖。

依据：[ElevenLabs adapter](https://github.com/BerriAI/litellm/blob/8b11b682f46fab627972d7f129bb0dceed6a88a2/litellm/llms/elevenlabs/text_to_speech/transformation.py)、[MiniMax adapter](https://github.com/BerriAI/litellm/blob/8b11b682f46fab627972d7f129bb0dceed6a88a2/litellm/llms/minimax/text_to_speech/transformation.py)、[MiniMax 文档](https://docs.litellm.ai/docs/providers/minimax)。

### 6.2 Portkey 官网不能直接作为开源部署验收

当前 ElevenLabs 官网集成文档示例连接 api.portkey.ai，使用 Portkey Key 与平台 Model Catalog。它还明确说明 voice cloning、dubbing、voice design 不属于统一 audio 入口，需 custom host 透传。

这支持“托管服务有 TTS/STT 能力”的判断，但不能用来证明公开 main/2.0 代码已经包含同样的部署能力。选开源本地版本必须拿固定源码自行验证；本次判断以源码为准。[Portkey ElevenLabs 官方集成文档](https://portkey.ai/docs/integrations/llms/elevenlabs)。

## 7. 路由：网关负责选路，项目负责正确性

两者都有路由与重试能力，但创作任务不能套用普通聊天的失败后换模型策略。

VibePaper 应先根据用户选择固定 providerId、connectionId、apiModelId、adapterVersion、能力版本和参数快照，再交给 adapter。任务提交成功后，查询/下载始终沿原连接；不因用户切换默认模型重新选路。密钥只保存 credentialRef，恢复时从系统凭据能力取得，不把 Key 写入任务快照。

- **提交重试**：供应商不支持幂等时，网络超时可能已经创建收费任务；不要通用重试或自动 fallback。明确提交结果未知，依据供应商查询能力恢复。
- **轮询重试**：同一 upstream task 的读取可做退避重试，不能重新创建任务。
- **下载重试**：可重试读取，支持临时文件与原子落盘；过期 URL 从原连接重新查询。
- **取消**：记录用户取消意图；只有供应商确认取消才报告停止远端生成。不支持时说明远端可能继续计费，停止本地派发与回显。
- **恢复**：本地持久化 task 与 upstream ID 后恢复查询；不盲重放创建。
- **成功**：输出写入项目并可读取后才 succeeded，不以 HTTP 200 或网关 success 代替。

不启用跨官方供应商静默 fallback、跨 Key 自动轮换、生成缓存命中假装新生成。网关模型列表也不能代替用户账号权限或逐模型能力验证。

## 8. 推荐桌面架构

```text
原 Canvas / ModelPicker / 配置页
          │ 受限 IPC，只传连接引用与业务参数
Electron Main / 本地核心
          ├─ Provider Registry：型号、操作能力、连接状态
          ├─ OS 凭据库：Key
          ├─ TaskStore / AssetStore：任务权威状态、本地输出
          └─ 受控 Generation Worker
                 ├─ Agnes 官方现有 adapter
                 ├─ Ark / BytePlus / Kling / Wan / ... 原生 adapter
                 └─ LiteLLM SDK：经验证的 OpenAI / Gemini / Veo / TTS
```

配置页按厂商列连接，画布按品牌分组，只展示已保存凭据、已启用、能力匹配且验证策略通过的绑定。把“凭据已保存”“连接测试成功”“具体模型可用”分开；模型列表可获取不等于媒体权限可用，也不能后台自动发收费生成。

LiteLLM 只作为 Python 库按需调用，不引入完整 Proxy 控制台、虚拟 Key、账户/预算系统。Python >=3.10,<3.15；依赖和运行时需锁版本、离线随安装包打包，Windows/macOS/Linux 分别验证。关闭不需要的日志回调与外部遥测路径，实际检查密钥/素材不进入日志。若 Python SDK 的打包收益不足，Registry 接口允许替换为原生 HTTP adapter。

Portkey 核心 TypeScript/Hono 同样可以本地运行，不需要因采用它而依赖 Docker；不过其 runtime 优势不能代替缺失的媒体 adapter。现阶段不同时引入两个网关，避免多一层请求转换和恢复责任。

两者开源核心均有 MIT 授权基础；LiteLLM 仓库对 enterprise 部分有单独边界。分发时以锁定版本 LICENSE/依赖清单为准，不把企业功能算进免费核心。[LiteLLM LICENSE](https://github.com/BerriAI/litellm/blob/8b11b682f46fab627972d7f129bb0dceed6a88a2/LICENSE)、[Portkey 仓库](https://github.com/Portkey-AI/gateway)。

## 9. 先做一个有限的验证，再定最终依赖

### 阶段 A：验证 LiteLLM 的实际收益

只验证四条代表链路：GPT 图片生成与多图编辑、Gemini 图片生成/编辑、Veo 文/图生视频、ElevenLabs 与 MiniMax 基础 TTS。以原生官方请求为对照，比较最终 body、header、multipart、输出格式与错误，不只看 SDK 返回成功。

最低验收：

- 图片：1:1 与 2K 参数没有被替换；多参考图数量、格式、顺序正确；mask/outpaint 按真实支持开放；透明背景/编码字段未丢。
- 视频：提交一次、查同一任务、下载落盘；首尾帧与多参考图层级正确；音轨和时长真实符合请求；不支持操作明确报错。
- 音频：voice_id、采样率、编码/容器正确；MiniMax URL 模式与流式缺口显式处理；变声、克隆、音乐不冒充 TTS。
- 故障：无效 Key、限流、网络中断、提交结果未知、重启恢复、下载过期、取消和删除连接。
- 桌面：三平台运行时启动/关闭/崩溃恢复，安装包大小与冷启动实测；无需用户安装 Python/Docker。
- 数据：Renderer 无 Key；日志/JSONL/导出无 Key；本地模型不联网，云端请求范围与用户配置披露一致。

### 阶段 B：按产品优先级原生接入

先完善默认 Seedream/Seedance 官方链路与既有 Agnes；随后扩展 Google、OpenAI、TTS，再接 Kling、Wan、Vidu、PixVerse、Fish、豆包、音乐与声音创建。BytePlus 独立验证，不与 Ark 账户混用。保留待核验目录但不让未配置模型进入画布选择器。

如阶段 A 证明 LiteLLM 参数保真或打包维护成本不合适，改为原生 adapter 不影响前端配置、Registry 和 TaskStore。Portkey 可以在以后增加独立服务器或需要集中治理时重新评估，无须现在成为桌面必需组件。

## 10. 本轮交付与未完成事项

已完成：官方文档与固定源码比对、公开分支区分、图片/视频/音频适配与缺口矩阵、路由恢复设计、桌面复用建议。

未完成：真实 Key 调用、逐个型号官方 ID 核验、全部参数组合端到端测试、打包与性能基准。本报告提供的是选型依据和可执行验证范围，不是模型接入完成记录。
