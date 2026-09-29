# 桌面版模型提供方接入契约

> 2026-09-24 起的目标规格；2026-09-28 实现状态见提供方表。当前仍没有通用 Provider Registry。模型目录和能力应在实际接入时按供应商官方文档与账号权限核验，不固定为本文撰写时的型号。

## 接入范围

| 提供方 | 接入方式 | 目标 | 当前状态 |
| --- | --- | --- | --- |
| OpenAI | 官方 API 与提供方适配器 | Agent、文本、可用的图/音/视频能力 | 待接入 |
| Anthropic Claude | 官方 Messages API | Agent、文本及实际支持的输入能力 | 待接入 |
| Google Gemini | 官方 Gemini API | Agent、文本及实际支持的多模态能力 | 待接入 |
| DeepSeek | 官方 API | Agent、文本及实际支持的输入能力 | 待接入 |
| 阿里云百炼 / Qwen | 官方 Model Studio API | Agent、文本及实际支持的图/音/视频能力 | 待接入 |
| 其他用户自定义兼容服务 | 明确的 OpenAI 兼容配置与能力探测 | 按探测结果开放功能 | 待接入 |
| Ollama、LM Studio 等本机服务 | 仅 loopback 地址，本地能力探测 | 本地 Agent、文本及实际支持的模态 | 本地文本原型 |
| Agnes | 当前专用适配器 | 文本、图像、视频联调 | 原型可用，尚未完成完整端到端验收 |
| 火山方舟 Ark | Seedance 视频生成任务 API | Seedance 2.5 文本/图片/视频/音频组合参考 | 桌面专用适配器已实现 HTTPS 参考、任务轮询与本地结果下载；mock 纵向测试通过，未用真实 Ark Key 验证。通用素材上传、音频生成及 Registry 尚未接入 |

Ark 参考请求选用 `doubao-seedance-2-5-260628`。官方[模型目录](https://docs.volcengine.com/docs/ark/model-list?lang=zh)列出全模态参考生视频能力、4–30 秒时长和 480p/720p/1080p 输出；[创建视频任务 API](https://api.volcengine.com/api-docs/view?action=CreateContentsGenerationsTasks&serviceCode=ark&version=2024-01-01)把参考视频和音频定义为 `video_url.url`、`audio_url.url`，示例使用 Ark 可访问的 HTTPS 地址。Seedance 2.5 提示指南说明单次最多 50 个图像/音视频参考，并要求首尾帧任务使用 `ratio=adaptive`；桌面请求据此限制参考总量并转换节点分辨率/首尾帧参数。

**本地视频/音频参考阻塞（2026-09-29，按 Ark 官方 API 契约核对）：** CreateContentsGenerationsTasks 的 `content` 示例与请求结构没有声明 `file_id`、`file_data` 或 Base64 字段；`video_url`/`audio_url` 下只给出 `url`。Ark [Files API](https://docs.volcengine.com/docs/ark/file-api?lang=zh)确实支持通过 `multipart/form-data` 的 `file` 上传本地二进制到 Ark 托管存储，使用 `purpose=user_data` 时只需要 Ark API Key，无需用户 TOS 凭据；默认单文件上限 512 MB、总容量 20 GB、保留 7 天（可配置 1–30 天），并支持通过[删除文件 API](https://docs.volcengine.com/docs/ark/delete-files-api?lang=en)清理。可是它返回的 `file_id` 在官方[Chat API](https://docs.volcengine.com/docs/ark/chat-api?lang=zh)和[Responses API](https://docs.volcengine.com/docs/ark/get-response-context-api?lang=en)文档中用于多模态理解；CreateContentsGenerationsTasks 没有规定如何把这个 ID 作为 Seedance 参考输入。因此不能把 `file_id`、`mm_file://`、本地路径或未声明的 `data:` URL 填进 Seedance 的 `url` 字段，也不能为这些任务先上传一份无法引用的用户媒体。当前桌面端在核验项目归属、索引 MIME/扩展名和文件大小后拒绝本地视频/音频参考，不发送本地路径或文件字节。

**解除阻塞所需输入：** Ark 官方文档或供应商书面确认需明确 Seedance 2.5 的 CreateContentsGenerationsTasks 接受 Files API `file_id`、本地字节/Base64 或数据 URL 中的哪一种，并给出可用 MIME/容器、大小限制、文件状态要求和删除/过期语义。收到这份契约后才能实现受控上传、幂等恢复与清理。当前可用输入是 Ark 可访问的 HTTPS 媒体地址：用户提供的地址，或用户已配置的 TOS Bucket 对象的预签名 HTTPS 地址；TOS 地址是否可访问应先由用户侧确认。Ark 托管存储上传不需 TOS 凭据，但 `file_id` 与 Seedance 任务 API 的连接仍缺乏官方契约。真实 Ark API Key 仍是验证端到端任务所需输入。

官方接口入口：[OpenAI](https://platform.openai.com/docs/api-reference/introduction)、[Claude](https://platform.claude.com/docs/en/api/overview)、[Gemini](https://ai.google.dev/api)、[DeepSeek](https://api-docs.deepseek.com/)、[阿里云百炼](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/text-generation)。这些链接用于实施时核验协议和能力，不意味着所有模态已接入。

## 注册表字段和行为

每个 provider 记录稳定 `providerId`、`local | cloud`、显示名、受控 endpoint、鉴权方式、密钥引用、可用模型目录。每个 model 记录模型 ID、模态、输入/输出格式、上下文窗口、工具调用、流式、取消、参考素材数量与格式、是否可用及不可用原因。Agent 与生成任务使用同一模型能力契约，但各自调用适配器可以不同。模型配置、节点与 Agent 选择器只显示已配置且能力匹配的组合；不因当前模型失败静默切换本地/云端或其他供应商。

云端 Key 经 OS 凭据能力保存，只在受控进程中使用。配置页披露该提供方会收到的数据类型和可能费用；用户选择云端模型并点击生成/发送后直接调用，不逐次弹系统确认。扩大发送范围时先更新披露和授权。本地模式不产生外部模型请求。供应商响应成功后仍须将结果写入本地项目并校验可读取，才能将任务标记成功。

## 接入验收

每家至少验证：有效/无效 Key、可用/不支持模态、工具调用与不支持工具调用、流式/非流式、取消能力、超时/断网、结果落盘、重启后任务恢复和用量展示。Agent 还要验证 50 条以上会话、一次上下文压缩、短期记忆、长期记忆与进程重启；摘要不能代替画布和任务权威状态。UI 验收按 [桌面 UI 保真清单](desktop-ui-parity.md) 执行。
