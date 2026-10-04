# 暂不可接入的官方型号（2026-10-03）

本文记录已核实但当前不能作为 VibePaper 官方 API 模型启用的具体原因。其他缺口以模型目录和实施方案为准。核验日期：2026-10-03。

## Midjourney V8.2

Midjourney 官方版本页说明 V8.2 于 2026-07-24 成为默认版本，确认该型号仍是产品目标。官方社区准则同时明确：除少数明确授予的例外外，Midjourney 不提供 API 或第三方应用/脚本，并禁止自动化交互；服务条款也禁止使用自动化工具访问、交互或生成内容。

因此，V8.2 暂不作为可调用的官方 API 模型启用。只有 Midjourney 后续正式提供受支持的 API，或针对本集成明确授予例外，才可重新评估；不得通过网页/Discord 自动化或未授权的第三方 API 包装器实现。

来源：

- [Midjourney Version：V8.2 当前默认版本及发布日期](https://docs.midjourney.com/hc/en-us/articles/32199405667853-Version)
- [Midjourney Community Guidelines：API、第三方应用与自动化规则](https://docs.midjourney.com/hc/en-us/articles/32013696484109-Community-Guidelines)
- [Midjourney Terms of Service：禁止自动化访问、交互和生成](https://docs.midjourney.com/hc/en-us/articles/32083055291277-Terms-of-Service)

## Kimi K2.5

Kimi 官方 API 模型目录将 `kimi-k2.5` 列在 Deprecated Models 中，并明确写明其于 2026-08-31 正式停用，此后不再维护或支持。该目录列出的现行型号包括 `kimi-k3` 和 `kimi-k2.6`，但它们是不同的官方模型 ID。

因此，`kimi-k2.5` 应保持停用且不可调用。不得把它静默映射到 Kimi K3、Kimi K2.6 或其他型号；如要支持替代型号，应以各自真实 ID 作为独立模型接入并单独验证。

来源：

- [Kimi API Platform Model List：Kimi K2.5 停用日期及现行型号](https://platform.kimi.ai/docs/models)

## Doubao Voice Creation

直接声音复刻创建的是持久音色资产，不能作为普通 TTS 请求代替。官方流程要求可用 speaker ID：预付费音色需先购买槽位，后付费需先在控制台开通声音复刻 2.0 和后付费服务。后付费首次 TTS 会收费并固定音色，不能重新训练；试听音色未正式使用会按有效期删除。预付费训练和激活也有独立限制。[声音复刻下单及使用指南](https://docs.volcengine.com/docs/DoubaoVoice/Soundreplicationorderingandusageguide?lang=zh)

训练、查询、激活与音频合成是不同步骤，状态包括 Training、Success、Active、Expired、Reclaimed。音色管理使用火山 OpenAPI 签名鉴权；音色就绪后的 TTS 另需语音 Key、`seed-icl-2.0` 资源和 speaker ID。当前音频任务只管理输出文件，没有持久音色资产、训练及激活状态、槽位权限、不可逆影响确认与分阶段恢复契约。因此此目标保留不可用，不能用现有 TTS 冒充完整声音创建。[音色状态查询](https://docs.volcengine.com/docs/6561/1801952?lang=zh)、[语音合成接口](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh)

官方 LAS `las_voice_forge` 可按 style_prompt 设计声音并直接返回音频，也支持参考音频克隆，使用独立 LAS Key 和异步提交／查询协议。它适合另建一个明确的模型绑定，但不能证明等同于本目标“Doubao Voice Creation”。豆包音色设计产品动态没有给出此目标完整的公开调用契约，本轮不静默替换目标型号。[LAS 复刻语音合成 API](https://docs.volcengine.com/docs/LakeAIService/ReplicaTextToSpeech?lang=zh)、[豆包语音产品动态](https://docs.volcengine.com/docs/DoubaoVoice/Productdynamics?lang=zh)
