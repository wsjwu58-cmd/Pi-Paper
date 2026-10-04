# 模型配置：官方 API Key 入口

核对日期：2026-10-04。入口与必填项按当前 [官方提供方目录](../../pi-main/packages/ai/src/media/catalog.ts) 整理；所有链接均指向厂商控制台或官方文档。登录、账户可用地区、模型开通权限及计费资格由各厂商控制台决定。

下表中的“必填字段”对应 VibePaper 当前配置表单。Voice ID、Speaker ID、Workspace ID、Region 和 AppID 是配置值，不是 API Key；它们按模型要求填写。取得密钥后直接在应用里配置和检测，不要把密钥贴到聊天中。

| 提供方 / 模型范围 | 官方密钥入口 | 表单必填字段 | 区域与配置说明 |
| --- | --- | --- | --- |
| Anthropic / Claude | [Claude Console](https://console.anthropic.com/)；[Claude API 入门](https://docs.anthropic.com/claude/docs/getting-access-to-claude) | API Key | 登录 Console 后在 API Keys 管理区创建。 |
| DeepSeek | [API Keys](https://platform.deepseek.com/api_keys)；[官方鉴权文档](https://api-docs.deepseek.com/api/deepseek-api/) | API Key | 目录使用 `api.deepseek.com`。 |
| Google AI Studio / Gemini、Veo | [AI Studio API Keys](https://aistudio.google.com/api-keys)；[官方 API Key 说明](https://ai.google.dev/gemini-api/docs/api-key) | API Key | 使用 AI Studio 创建的 Gemini API Key；具体模型仍需账户和地区可用。 |
| OpenAI | [API Keys](https://platform.openai.com/api-keys) | API Key | 这是 OpenAI API Platform 的密钥。 |
| xAI / Grok | [API Keys](https://console.x.ai/team/default/api-keys)；[官方 Quickstart](https://docs.x.ai/developers/quickstart) | API Key | 目录的 API 地址为 `api.x.ai`。 |
| Moonshot / Kimi | [Kimi Open Platform API Keys](https://platform.kimi.ai/console/api-keys)；[官方鉴权说明](https://platform.kimi.ai/docs/api/overview) | API Key | 官方文档链接到 Kimi Open Platform；目录请求地址为 `api.moonshot.ai`。 |
| 火山方舟：Seed、Seedream、Seedance、豆包文本/图片 | [火山方舟 API Key 管理](https://ark.volcengine.com/region:cn-beijing/apiKey)；[官方创建说明](https://docs.volcengine.com/docs/ark/api-key?lang=zh) | API Key | 当前目录这几个火山方舟配置共用同一方舟账号体系和 `cn-beijing` API Key，不必为 Seed、Seedream、Seedance 或豆包重复注册账号。Key 创建于所选项目，目标模型服务还需在方舟开通。 |
| BytePlus ModelArk / Seedance | [ModelArk API Keys](https://ai.byteplus.com/ark/region:ap-southeast-1/apiKey)；[官方创建说明](https://docs.byteplus.com/en/docs/modelark/api-key) | API Key | 对应 BytePlus 的 `ap-southeast-1` 服务与独立控制台账号；不要拿火山方舟国内 Key 代替。 |
| 阿里云百炼：文本、图片 | [百炼 API Key（华北2/北京）](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key)；[官方获取说明](https://help.aliyun.com/zh/model-studio/get-api-key)；[地域与接入域名](https://help.aliyun.com/zh/model-studio/regions) | API Key | 当前目录使用 `dashscope.aliyuncs.com/compatible-mode/v1`，对应华北2（北京）兼容接入域名；应使用北京地域的 Key。百炼各地域的 Key、域名和模型列表独立，不能跨地域混用。官方已注明该兼容域名自 2026-09-30 起不支持新特性；这是当前目录所用端点的限制。 |
| 阿里云百炼：视频（Wan） | [百炼 API Key（华北2/北京）](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key)；[Workspace ID 说明](https://help.aliyun.com/zh/model-studio/obtain-the-app-id-and-workspace-id)；[地域与接入域名](https://help.aliyun.com/zh/model-studio/regions) | API Key、Workspace ID、Region | 视频配置额外要求 Workspace ID 和 Region；实际请求由本地核心派生为 `https://{Workspace ID}.{Region}.maas.aliyuncs.com/api/v1`。使用对应工作空间地域的 Key；从本表北京入口取得 Key 时，应选择北京工作空间与 `cn-beijing`。 |
| MiniMax：视频、语音、音乐 | [API Keys](https://platform.minimax.io/user-center/basic-information/interface-key)；[官方 API 概览](https://platform.minimax.io/docs/api-reference/api-overview) | API Key；语音模型可填 Voice ID | 当前目录走 `api.minimax.io`。目录中的 Voice ID 字段为可选项，具体音色按所选语音模型要求。 |
| Agnes | [Agnes 官网](https://agnes-ai.com/)；[官方文档：API Key 管理位置](https://wiki.agnes-ai.com/en/docs/overview) | API Key | 官方文档确认：登录 Agnes AI Console，在 API Key management 页面创建并复制。文档没有公开直达该 Console 的稳定链接，因此从官网进入后按文档导航。API 请求地址为 `apihub.agnes-ai.com/v1`。 |
| ElevenLabs | [API Keys](https://elevenlabs.io/app/developers/api-keys)；[官方 API 鉴权说明](https://elevenlabs.io/docs/api-reference/authentication) | API Key、Voice ID | Voice ID 是所选音色的标识，不是密钥；当前目录将它列为必填。 |
| 豆包语音 v3 | [豆包语音 API Key 管理](https://console.volcengine.com/speech/new/setting/apikeys?projectName=default)；[官方 API Key 使用说明](https://docs.volcengine.com/docs/DoubaoVoice/APIKeyUsage?lang=zh) | API Key、Speaker ID（2.0 音色） | 这是豆包语音控制台的独立 API Key，不与火山方舟文本/视频 Key 混用。官方说明称请求填 API Key header，不需要 AppID。 |
| 豆包语音 v1（兼容） | [火山引擎语音控制台](https://console.volcengine.com/speech/app)；[官方 v1 接口说明](https://www.volcengine.com/docs/6561/2228192) | Access Token、AppID、Voice Type | 这是目录保留的兼容鉴权形式；Voice Type 是 v1 音色标识。v1 官方接口文档标注为不推荐。 |
| Fish Audio | [API Keys](https://fish.audio/app/api-keys/)；[官方取 Key 指南](https://docs.fish.audio/developer-guide/getting-started/api-key) | API Key | Reference ID（参考音色）是可选字段。 |
| Kling | [Kling 开发者 API Key 控制台](https://kling.ai/dev/api-key)；[官方鉴权说明](https://kling.ai/document-api/api/get-started/authentication) | API Key（推荐）；或旧版 Access Key + Secret Key | 官方当前鉴权对所有模型使用单个 API Key；AK/SK 仅适用于 legacy 版。当前配置支持两种格式，建议优先在开发者控制台创建 API Key。接口文档给出的服务域名为 `api-singapore.klingai.com`。 |
| Vidu | [Vidu API Keys](https://platform.vidu.com/api-keys)；[官方 Quickstart](https://platform.vidu.com/docs/quick-start) | API Key | 官方 Quickstart 说明创建密钥时需填写昵称；当前目录只要求 API Key。 |
| PixVerse | [官方 API Key 获取指南](https://docs.platform.pixverse.ai/how-to-get-api-key-882968m0)；[PixVerse API 平台](https://platform.pixverse.ai/) | API Key | 登录平台后从左侧菜单进入 API Keys 并创建。 |
| Midjourney、旧 HappyHorse | 无可用 Key 入口 | 当前目录不可配置 | 当前目录将 Midjourney 标记为无公开官方生成 API；旧 HappyHorse 的精确调用 ID/协议未核验。不能用其他提供方 Key 或网页登录态替代。 |

## 需要留意的实际检测条件

当前真实鉴权检测已接通 14 个配置分组：Anthropic、DeepSeek、Google、OpenAI、xAI、Moonshot、BytePlus、方舟 Seedance、MiniMax、ElevenLabs、Fish Audio、Kling、Vidu、PixVerse。方舟文本/图片、豆包文本/图片、百炼文本/图片和视频、Agnes、豆包语音 v3/v1 暂不支持安全检测；页面会提前提示，仍可保存配置。方舟使用同一个 Key 的用户可先在 Seedance 分组检测，但结果不代表其他型号权限也已验证。

- 火山方舟目录中的 `volcengine`、`doubao`、`volcengine-ark` 是同一方舟 API Key 入口的不同模型分组；BytePlus 使用另一套控制台和 Key。
- 豆包语音 v3 使用豆包语音 API Key；方舟 Key 不应填到语音 v3 配置中。豆包语音 v1 使用 AppID 和 Access Token，与 v3 字段不同。
- 百炼文本/图片当前使用北京 DashScope 兼容域名；视频实际按 Workspace ID 和 Region 派生工作空间地址。地域 Key 与接入域名不能跨区混用。官方指出 DashScope 兼容域名从 2026-09-30 起不支持新特性，文本/图片目录仍使用该兼容域名。
- Kling 当前官方鉴权推荐单个 API Key；只有调用 legacy 版本时才填写 AK/SK。
- 只有目录声明并实现为真实网络探测的提供方才会向厂商服务发送认证请求；`format-only` 配置只校验字段，不会验证 Key 是否能调用。目录标为不支持检测的提供方应明确显示这一状态且不发请求。通过提供方级探测只说明这次凭据与入口可用，不代表每个模型、模态或账户权限都已验证。
