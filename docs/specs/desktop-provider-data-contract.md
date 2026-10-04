# 桌面官方模型配置数据契约

2026-10-03，Pi 二次开发路径。配置、任务检查点与输出由本地核心持久化，Pi 适配器只处理供应商协议。

| 数据 | 保存位置 | 字段/限制 |
| --- | --- | --- |
| 提供方设置 | userData/providers.json | schemaVersion=1；providers 按稳定 providerId 索引；baseUrl、enabledModelIds、defaultModelIds、modelDefaults、timeoutSeconds |
| 官方凭据 | userData/credentials/provider-{id}.bin | safeStorage 加密；只在受控进程解密；Renderer 不回读；Linux basic_text 不可用 |
| 提供方描述 | Pi 静态目录，经 IPC 返回 | id、name、providerType、官方 baseUrl、allowedHosts、credentialFields、configured、connectionTest.kind；字段 secret/required 独立声明 |
| 模型绑定 | Pi 静态目录，经 IPC 返回 | id、displayName、providerId、apiModelId、modelType、inputModes、implemented、enabled、unavailableReason、defaults、constraints、toolCalling/streaming/cancellation（只有明确支持时为真） |
| Agent 会话模型 | 项目 `.vibepaper/agent/sessions/*.jsonl` | `vibepaper_agent_model` 自定义条目只保存稳定 `bindingId`；不会保存 Key 或凭据；会话复制、片段保存/导入保留此 ID |
| 上游提交检查点 | 本地 SQLite task_events.data_json | providerCheckpoint={phase:'submitting'} 或 {phase:'submitted',remoteTaskId}；仅已运行云端任务写入；已有远端 ID 不允许替换 |
| 输出 | 项目 generated/{taskId}/ | 文本或最多4个索引媒体文件；原子保存、MIME/签名与大小校验；主输出及全部输出路径沿用 TaskStore 字段 |

IPC `getProviderConfiguration()` 返回公开 `{providers,models}`；`saveProviderConfiguration(input)` 接受 providerId、baseUrl、credentials、enabledModelIds、defaultModelIds、modelDefaults、timeoutSeconds；credentials 只用于写入，响应不包含秘密。空白 Key 保留已有秘密。`clearProviderConfiguration(providerId)` 移除配置和凭据；兼容清除旧 Agnes/Ark Key。

`modelDefaults` 按稳定模型绑定 ID 索引，允许保存目录声明的 ratio、size、resolution、duration、generate_audio 子集，按该型号的枚举、时长上下界和音频开关能力校验；离散时长使用 acceptedDurations，分辨率与时长联动使用 durationByResolution。未知字段（包括任何凭据）拒绝写入。公开模型 defaults 合并用户覆盖后交给原画布编辑器，新节点及切换模型沿用这些值，已有节点显式参数保持优先；手工及Agent任务创建时快照默认参数和本次覆盖，防止设置变化影响已提交任务恢复。旧 schemaVersion=1 配置无此字段时等价于空对象，可无损读取。

`testProviderConfiguration(input)` 返回 `{status,success,message}`。2026-10-04 起，连接检测使用新填写且尚未保存的凭据，或留空保留的已保存凭据，调用已核验的真实官方鉴权接口；仅 `connected` 且 `success=true` 可显示检测成功。未实现安全鉴权接口的提供方返回 `unsupported`、`success=false` 并明确未发请求，不以格式校验冒充连通。测试不得隐式生成收费内容，不回显账号余额或历史任务。型号适配、账号权限和参数仍需真实生成验收。鉴权不需要音色时允许先测 Key，保存及生成仍校验所需音色。

凭据编辑字段按 `secret` 默认使用密码黑点显示，右侧眼睛按钮只切换本次输入的隐藏／明文，不从 Main 回读已保存秘密；切换厂商恢复隐藏并清空本次输入。Key 或 Base URL 修改后清除旧检测结果，避免旧成功状态用于新的连接。探测延续官方主机白名单、超时、响应上限、禁止重定向与错误脱敏规则。

2026-10-04 网络修复：Main 的连接检测通过 `provider-network.cjs` 注入 Electron `net.fetch`，使用系统代理/PAC 网络栈，避免 Node 默认 fetch 直连超时。注入传输后再次验证每个请求的官方 HTTPS 主机、端口及用户信息限制，禁止重定向并省略会话 Cookie。使用无 Key 与无效测试凭据的 OpenAI 请求均到达鉴权接口并返回 401；没有使用用户真实 Key，因此不是账号凭据验收。网络错误与超时提示不再误导为 Key 无效，前端去除 IPC 内部通道前缀。本项只调整配置检测传输，生成 Worker 的联网能力须单独验证。

启用条件为：官方凭据齐全 ∧ 保存启用 ∧ 协议已实现 ∧ 真实调用 ID 已核验 ∧ 本次输入能力匹配。目录中的待接入目标不等于可用模型。任务与模型身份使用绑定 ID，发往供应商时解析为 apiModelId；不得将凭据放入节点参数、公开目录、事件或项目导出。

Agent 会话只允许选择已配置、已启用、协议已实现且明确支持工具调用的文本绑定。新会话把所选稳定 ID 写入 Pi JSONL，后续消息、确认后的恢复和任务自动续接都读取同一个会话绑定；自动续接按该绑定重新解析其提供方凭据，不读取全局 Agnes Key，也不借用其他厂商的 Key。凭据缺失或绑定不可用时，续接保持待处理并在原 Agent 会话显示原因，直到同一会话模型连接恢复。旧 JSONL 会话和没有模型字段的旧片段显式解释为 `agnes-2.5-flash`，保留既有 Agnes 行为；复制与新格式片段都保存原 bindingId。片段或会话导出仅含模型绑定 ID，不含任何 Key。

模型可声明 `requiredCredentials`，在提供方通用字段以外校验音色等前置条件；缺少字段时该模型 enabled=false，不影响同提供方其他模态。百炼视频用独立 `alibaba-video` 连接，凭据 apiKey/workspaceId/region；只允许六个已核实官方 Region，受控进程派生精确 workspace 主机，不接受任意域名。豆包语音用独立 `doubao-voice` 连接，凭据 apiKey/voiceId，避免混用方舟聊天 Key。

Worker 将画布的 aspect 规范为 ratio，resKey 作为 UI 状态移除，视频 size 与 resolution 统一；冲突值明确报错。已读取的参考字段转换为 references 后移除重复 UI 元数据。风格和运镜作为用户选择的提示词要求保留，未知供应商参数仍由适配器拒绝。变声操作允许空提示词，但必须有明确目标音色及一份参考音频；当前只有 ElevenLabs 变声路径允许安全读取本地音频。读取仍检查项目归属、大小、MIME、内容签名及读取期间文件变更。

检查点使用既有 schema 的事件字段，不新增数据库列。重启后有 submitted ID 的任务回到 queued，领取时附带该检查点，继续查询；submitting 结果未知时禁止重新提交。原有无检查点云端任务继续使用既有中断恢复限制。

Pi 在本地参数及参考地址预检后、POST 前等待 onSubmitting 持久化；获得上游 ID 后等待 onSubmitted 持久化，再进行 GET 轮询。持久化失败必须停止后续操作，不能用空回调假装已有耐久检查点。预检失败不会标记提交结果未知。

### 2026-10-04 Agent Worker 代理连通性修复

后续图片任务的 `fetch failed` 排查确认独立 Generation Worker 尚未接入同一代理初始化。现已在 Main 启动媒体 Worker 时传入静态系统代理快照，在真实 Worker 加载时调用共享的 Node 原生代理初始化，覆盖媒体提交、查询及下载使用的 Node fetch/http/https；本地 loopback 保持绕过代理。异步启动后重新检查任务取消状态，避免取消期间发起上游提交。网络错误在原节点显示明确原因，不自动重提结果不确定的媒体请求。真实 Generation Worker 无 Key 官方查询返回 401；46 项媒体 Worker/代理回归测试通过。本轮未发送付费图片生成请求，仍须由用户重试节点验证完整图片生成及结果落盘。

配置检测使用 Electron `net.fetch`，Agent Worker 原先使用未启用代理的 Node `fetch`，二者存在网络行为差异。在 Electron 44.4.4 / Node 24.21.0 utility process 中，以无凭据 `GET https://api.openai.com/v1/models` 验证：原链路 10 秒超时，启用代理后返回 401。该结果只证明可到达服务端，不证明 Key、模型权限或付费生成成功。

Main 在启动 Agent Worker 前读取系统对 OpenAI 官方 API 地址的代理解析结果，将静态 HTTP/HTTPS 代理快照交给受控 Worker；未解析到可用静态代理时保留显式 HTTP_PROXY/HTTPS_PROXY 环境配置。Worker 在任何模型请求之前调用 Node 原生 `http.setGlobalProxyFromEnv`，保留 TLS 校验；本地 localhost、127.0.0.1 和 IPv6 loopback 绕过代理。代理设置不进入 Renderer、项目或会话文件，不新增网关依赖。当前覆盖普通系统 HTTP/HTTPS 代理；按目标域名不同路由的 PAC、SOCKS 与运行中代理切换仍未实现完整等价，需要独立适配和验收。修改代理后重新打开项目或重启应用以刷新 Worker 快照。本轮不改变媒体 Generation Worker。

真实账号诊断从已保存的操作系统加密凭据读取 Key，密钥只在受控进程内存传递。首次诊断启动结果未捕获，不能作为账号验收证据；再次诊断因可能重复产生费用被自动审批阻止，本轮不宣称真实账号文本生成成功。

用户随后明确授权再执行一次最小文本请求。诊断的本地凭据解密上下文须与正式应用一致（应用名及 userData 为 VibePaper）；此前初始化失败发生在任何网络请求之前。修正后真实账号验证：官方 `/v1/models` 返回 200，配置的 `gpt-6-luna` 在可用模型列表中；Electron utility process 原始无 Key 直连超时，使用生产 `workerProxyEnvironment` / `initializeWorkerProxy` 后，原 Pi `streamSimple` 完成一次 GPT-6 Luna 文本请求，stopReason 为 stop、返回非空文本、totalTokens 为 15。请求 maxRetries 为 0、maxTokens 为 64；未执行工具、修改画布或提交媒体生成任务。该证据证明本次官方 Key、型号及 Worker SSE 请求可用，不代表所有厂商或持续网络稳定性已验收。没有保存或输出明文密钥。
