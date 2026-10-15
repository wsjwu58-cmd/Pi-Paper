# 自定义 API Key 与模型配置设计草案

> 当前决策恢复 Pi 二次开发与官方 Key 接入，实施依据见 [Pi 官方接入设计](2026-10-03-pi-official-provider-implementation.md)。下文 LiteLLM 内容保留为历史讨论，配置页与选择器的视觉及交互要求继续适用。

日期：2026-10-03。状态：讨论稿，未实现、未完成型号逐项核验。本文不修改现有工程契约或声明多提供方接入完成。

最新范围调整：采用 LiteLLM 与官方原生适配混合路由；LiteLLM 未覆盖的操作使用厂商官方 API Key 接入。原 72 项仍为目标清单，46 项仅为此前整理的 LiteLLM 候选子集，不是支持上限，也不替代原范围。LiteLLM 可以直接使用官方 Key；fal.ai 是用户可选的上游渠道。优先官方连接，现有 Agnes 官方接入保留。具体操作边界见 [提供方文档复核](../research/2026-10-03-litellm-provider-documentation-audit.md)，候选调用 ID 见 [LiteLLM 模型清单与接入方式](2026-10-03-litellm-model-catalog-and-integration.md)。UI 布局、只显示已配置可用模型、系统凭据和本地任务要求继续适用。

## 1. 目标与已知事实

- 新增独立「自定义配置」页面，按用户图一采用左侧厂商列表、右侧配置详情的大卡片布局。
- 原节点模型选择器按图二采用厂商、模型两列；仅提供已保存、已启用、已实现调用适配且能力匹配的模型组合。
- 原模型选择器增加固定「自定义配置」按钮，跳转配置页并能返回原画布、节点和编辑位置。
- 官方品牌图标作为本地资源随安装包发布；不以字母徽章、手绘近似或远程 CDN 作为正常显示方式。
- 用户给出的目标清单实际为文本 20、图片 16、视频 25、音频 11，共 72 项；视频标题为 26，缺少的一项待补充。
- 已检查原 ModelPicker、ModelBrandIcon、NodeEditorPanel、AgentPanel、桌面路由、Main/Preload、Agnes/Ark 模型目录和 Generation Worker。当前为 Agnes、Ark 和本地能力的专用配置，并非通用 Registry；节点编辑器在前端拼接模型目录，模型身份主要依赖名称。
- 用户已确认：支持各厂商官方 Key，优先实现各厂商官方 API 直连。Agnes 本身也是已接入的官方提供方。官方连接为配置页默认路径和首期开发、验收重点；现有 Agnes 官方连接与本地连接保持兼容，新增聚合渠道和自定义代理延后。默认本机全局保存连接、项目仅保存选择仍为建议。
- AGENTS.md 原文将通用 Registry 排在完整迁移后；用户本次提出多模型配置的新工作范围。进入实施时须先同步该顺序及相关规格，明确本功能的优先级变化，不能宣称已有迁移全部完成。

## 2. 厂商、连接与模型的关系

分别记录三种身份：

1. **品牌 brand**：模型所属厂商，用于图标和选择器分组，例如 Anthropic、OpenAI、ByteDance。
2. **连接 connection**：实际发送请求的渠道与账户，例如 Anthropic 官方、Agnes、自定义代理、火山方舟、BytePlus、本机服务。连接拥有地址、协议、凭据引用、状态和数据发送披露。
3. **模型绑定 binding**：一个目标模型在某个连接上的实际 API ID、能力、启用状态及参数规则。同名模型可有多个绑定。

首期点击 Anthropic 等厂商默认创建该厂商官方连接，填入官方 Key 后只关联该连接实际可用的模型。一个官方连接可以覆盖多个受支持模态，不要求用户为每个模型重复填写 Key。同厂商不同 Key、地区或环境可创建多个连接，不能互相覆盖。

为后续扩展保留品牌与渠道的区别：如果以后用户明确配置第三方聚合渠道，模型可按品牌分组，但请求、错误、披露、任务记录必须指向实际连接。Agnes 按官方提供方展示，不以其名称代指聚合渠道；本期各品牌优先走各自官方接口。

多媒体网关选型补充见 [LiteLLM 与 Portkey Gateway 调研](../research/2026-10-03-litellm-portkey-media-gateway-comparison.md)：优先验证 LiteLLM SDK 的媒体协议复用，Seedream、Seedance 等缺少目标专用链路的模型继续采用官方原生适配；网关不替代本地 Registry、系统凭据和 TaskStore。

BytePlus Seedance 三项保留用户指定名称；建议按 ByteDance 品牌分组，用 BytePlus 渠道标识区分，不能合并成同一个调用绑定。自定义模型允许用户选择已知品牌或「自定义」；未知品牌不冒充官方身份。名字中的 Local 不能决定 local/cloud，须由实际连接与可验证运行位置决定。

## 3. 配置页布局与入口

### 页面结构

- 在现有 HubLayout 中增加桌面路由 `/settings/models`；沿用原项目导航、字号、主题和圆角，不恢复截图中的创意广场、充值等平台功能。
- 顶部为面包屑、标题「自定义配置」、副标题「配置模型 API Key、服务地址与可用模型」，右侧为当前连接对应的官方文档按钮。
- 主卡片桌面宽屏左栏约 240–280px，右栏弹性；窄屏左栏改为厂商选择，表单双列改一列。
- 配置页左栏优先列出全部目标厂商及其官方连接；现有 Agnes 与本地服务保留入口。新增聚合渠道和自定义代理的界面延后，不占首期主配置流程。这里显示未配置品牌；画布选择器不显示未配置品牌。
- 左栏显示明确的「未配置」「已配置 · N 个已启用模型」「凭据失效」「已停用」，不能把可接入型号总数当成账号可用数量。
- 右栏顺序为：品牌标题与官方连接标识 → 官方账户/连接选择（多连接时显示） → 凭据表单 → 文/图/视频/音频筛选 → 模型列表与启用选项 → 数据发送说明 → 测试结果 → 操作按钮。
- 支持一个品牌关联多条官方连接；普通用户单连接时不增加渠道选择步骤。后续聚合渠道的配置详情再展示该连接跨品牌的模型列表。

### 表单字段

| 字段 | 行为 |
| --- | --- |
| 连接名称 | 用户可识别的名称，系统提供默认值 |
| 接入方式/协议 | 官方预设自动选择对应适配器并显示「官方直连」，普通表单不要求用户识别协议；新增自定义兼容配置延后 |
| API Key | 必要时必填；已保存只展示占位，不读取旧明文到 Renderer |
| Access Key/Secret、地区、项目等 | 按提供方鉴权 schema 显示，不能所有厂商都要求 Secret |
| Base URL | 默认使用已核验官方地址；地区通过官方端点预设切换。任意地址修改须显式转换为自定义连接并重新披露实际发送对象，不能保留「官方直连」标识；避免重复拼接 `/v1` |
| 默认模型 | 按文本、图片、视频、音频分别设置，不用一个默认值覆盖四种模态 |
| 请求超时 | 默认建议 60 秒，作为单次网络请求超时；异步任务另有整体期限和轮询策略 |
| 模型列表 | 展示名称、实际 API ID、模态、能力、验证状态及启用开关 |
| 添加自定义模型 | 显式填写展示名称、API ID、品牌、模态与支持的能力模板 |

默认不提供回调 URL：桌面异步任务优先轮询，避免要求用户部署公网回调服务。必要的厂商专属高级字段再按已核验协议开放。

按钮为「取消」「测试连接」「保存配置」。测试草稿不自动保存，保存与测试状态分离。无网络时允许保存未验证配置，但明确展示状态；未实现协议或未知能力不能因此进入画布可选列表。修改 Key、地址、协议、实际 API ID 后，相关旧测试证据失效。

已有 Key 默认只允许替换、移除，不回传明文；新输入的 Key 可临时显示/隐藏，保存后清空前端输入。移除连接不删除项目产物或历史模型信息。

### 导航与返回

入口包括现有设置入口、节点模型选择器底部，以及空模型状态中的配置按钮。携带 returnTo、节点定位、模态与品牌筛选；returnTo 只允许应用内部路由。跳转前通过原保存链刷新待落盘操作；保留视口、选中节点、编辑器及未提交提示词，不停止正在执行的 Agent 或任务。保存后刷新目录缓存；「返回画布」恢复原位置。不能默认将新配置模型套到所有已有节点。

## 4. 图二模型选择器

- 左列：当前节点模态下有可选模型的品牌、官方图标、可选绑定数量。右列：模型名称、渠道副标题、能力摘要、当前选择标记。
- 多渠道同名模型显示不同连接名称；绑定 ID 为选中值，展示名称不承担身份。
- 底部固定「＋ 自定义配置」，不随列表滚走；空状态也保留该入口。
- 支持键盘方向键、Enter、Escape、搜索和列表独立滚动；弹层在窗口边缘自动翻转，不能被节点容器裁剪。
- 保存配置后通过配置版本事件刷新 React Query 缓存和 Agent 目录，无需重启或重开项目。

可选条件：连接已保存且启用，凭据满足其鉴权要求，模型绑定已启用，适配器已实现，目标输出模态匹配，操作能力已知且符合要求，没有明确的权限拒绝或配置无效状态。

测试状态与运行健康分开：未验证可显示「未验证」；明确无权限的绑定不可选；网络中断、429、临时 5xx 不直接删除目录条目。某个操作缺少参考输入时保留模型及原编辑器，生成按钮提示所需输入；不把编辑模型误当纯文生图使用。

已保存节点引用的失效模型仍显示原名称及「需重新配置」，并禁用新提交，不伪造备用条目或静默换模型。批量运行只跳过/报告确实不可用目标；不得替换到其他渠道。

## 5. 目标模型分组

下表为产品目录建议，尚非全部型号官方 API 已存在、账号可用或本项目已接入的声明。实际 ID、API、地区和能力逐渠道核验。所有 72 项保留在配置目录，未完成接入的标「待接入」，不出现在画布可选列表。

官方优先的判定：逐项记录官方 API 是否提供该型号、实际模型 ID、账号/地区权限和可支持操作。官方尚未确认提供 API 的型号标「官方接入待核验」；没有官方 API 的型号标明对应缺口，不在首期用第三方接口代替。Banana 等别名必须先映射至厂商确认的真实型号。仅支持本机部署的能力进入本地连接路径，不能用云端 Key 冒充本地运行。

| 品牌/分组 | 目标型号 |
| --- | --- |
| Anthropic | Claude Fable 5.1；Claude Haiku 4.5；Claude Opus 5；Claude Opus 5.5；Claude Sonnet 4.6 |
| DeepSeek | DeepSeek V4.1 Flash |
| Google | Gemini 3.1 Pro；Gemini 3.6 Flash；Gemini 3.8 Flash；Veo 3.1；Veo 3.1 Lite；Gemini Omni Flash |
| OpenAI | GPT-5.6 Sol；GPT-5.6 Terra；GPT-5.6 Luna；GPT-6 Astra；GPT-6 Sol；GPT-6 Luna；GPT-Image-2；GPT-Image-2.5 Flare；GPT-Image-2.5 Sunburst |
| xAI / Grok | Grok 4.3；Grok 4.7；Grok Imagine；Grok Imagine Video；Grok Imagine Video 1.5 |
| Moonshot / Kimi | Kimi K2.5 |
| ByteDance | Seed 2.0 Mini；Seed 2.1 Pro；Seedream 5.0；Seedream 5.0 Pro；Seedance 2.0；Seedance 2.5；Seedance 2.0 Fast；Seedance 2.0 Mini；BytePlus Seedance 2.0；BytePlus Seedance 2.0 Fast；BytePlus Seedance 2.0 Mini；Seedance 1.5 Pro；Doubao Voice Creation；Doubao TTS v1；Doubao TTS v2 |
| Agnes | Agnes Image 2.0 Flash；Agnes Image 2.1 Flash；Agnes Image 2.5 Flash；Agnes Video 2.5 Flash |
| Aliyun / Qwen / Wan | Qwen Image Edit Plus；Wan 2.7 Image Pro；Z-Image Turbo；Wan 2.7；Wan 3.0；品牌资产可以细分 Qwen、Wan，渠道可能为百炼或其他已支持服务 |
| Kling | Kling 3.0 Omni；Kling V3 |
| MiniMax | MiniMax Hailuo 2.3 Fast；MiniMax H3；MiniMax H3 Local；MiniMax Music 2.6；MiniMax Speech 2.8 HD；MiniMax Speech 2.8 Turbo |
| ElevenLabs | ElevenLabs Voice Changer；Eleven Flash v2.5；Eleven Multilingual v2 |
| Fish Audio | Fish Audio S1；Fish Audio S2 Pro |
| Vidu | Vidu Q3 Pro |
| PixVerse | PixVerse V6 |
| Midjourney | Midjourney V8.2，接入渠道/API 待核验，不预设有可用官方接口 |
| Banana，归属待核验 | Banana 2；Banana 2 Lite；Banana Pro。确认真实型号及品牌映射后再归入 Google 或其他品牌，不由昵称推断官方 ID |
| Happyhorse，归属待核验 | Happyhorse；Happyhorse 1.1。保留独立目录条目，确认供应商与协议后绑定 |

## 6. 默认模型与能力

### 默认规则

- Text：Claude Fable 5.1。
- Image：Seedream 5.0 Pro；1:1、2K。
- Video：Seedance 2.5；adaptive、480p、15 秒、生成音频开启。
- Audio：用户未指定，不臆定统一默认。按 TTS、变声、音乐、声音创建分别管理。

这些是目标默认值，仅在相应绑定已配置且支持所需参数时生效。优先级为已有节点显式选择 → 项目偏好 → 本机用户偏好 → 已可用的目标默认；均不可用时显示「请选择已配置模型」，不偷偷选择首个条目。预设默认仅影响新建节点或未设置的参数，不能覆盖现有节点内容。

### 能力规则

- 以每个 binding 的能力和参数 schema 驱动原编辑器，前端显示与 Main/Worker 校验共享规则来源。
- 图片区分生成、编辑、扩图；Banana Pro、Wan 2.7 Image Pro、Seedream 5.0/Pro 的生成及扩图为用户目标要求；Qwen Image Edit Plus 按编辑入口处理。不得仅靠品牌判断能力。
- 用户目标参考上限：Banana 2、Seedream 5.0 为 14；GPT-Image-2 系列为 16；Seedream 5.0 Pro 为 10。实际生效上限还须满足该渠道、输入模式、格式、大小及总 payload 约束；未核验不承诺支持。
- 视频支持文生、首帧、首尾帧、组合参考、编辑等已实现模式。Seedance 2.5 官方任务文档允许普通生成时长 4–30 秒，15 秒目标有效；首帧/首尾帧等锁定画幅模式要求 adaptive。视频编辑/延长另有 duration=-1 等规则，不将 15 秒强加到所有模式。
- 换模型后保留仍合法参数；无效参数在原编辑器给出调整提示。输入模式强制 adaptive 时禁用画幅选择并说明原因；请求前由受控核心再次校验。
- 音频细分 TTS、voice-changer、music、voice-create，Voice Changer 要求音频，TTS/Speech 接 Text 输入，声音创建按已核验接口允许参考音频或描述。原编辑器中切换能力模式，不增加独立音频创作面板。
- Agent 选择器另外过滤工具调用、上下文、流式与输入能力；文本输出可用不等于可用作 Agent。Agent 自动压缩仍计入真实摘要用量。
- ImageUpscale、VideoUpscale、Compose、DirectorStage、Stack、Group、Document 无生成模型选择；内部任务执行器身份可保留，不作为模型选项展示。现有超分路径如依赖云端生成适配，需单独审计并更新契约，不能只隐藏选择器就宣布不依赖模型。

## 7. 数据、边界与调用

### 数据结构

| 对象 | 主要字段 |
| --- | --- |
| Brand | brandId、名称、官方文档、打包图标与来源 |
| Connection | connectionId、providerId、名称、local/cloud、adapterId、baseUrl、地区、credentialRef、enabled、configRevision、发送范围 |
| ModelDefinition | modelKey、displayName、brandId、输出模态、目标能力、验证来源与状态 |
| ModelBinding | bindingId、connectionId、modelKey、apiModelId、enabled、能力 schema、参数规则、验证时间/结果 |
| Defaults | 各模态/操作的 bindingId 与合法参数 |

全局配置使用 schemaVersion、原子写、迁移备份；凭据只保存系统保护的引用。项目保存稳定 bindingId 与不含密钥的模型显示快照，方便跨机打开时显示原选择并提示重新绑定。旧项目 ID 不变，不能用展示名覆盖存储身份。

TaskStore 在提交前落盘 bindingId、连接 ID、API ID、配置版本、合法参数快照、输入素材引用、远端任务 ID、幂等键等。远端提交后的地址/路由快照不随用户随后修改连接而改变；密钥不进任务或项目。轮换凭据后恢复查询若无权限，明确要求处理，不能重放已提交任务。

### 分层

原配置页/ModelPicker/NodeEditorPanel/AgentPanel → 显式桌面适配 → 受限 IPC → Main 的 Registry/凭据/校验 → Generation Worker 或原 Pi Agent 服务适配器 → 本地服务/云端接口。

- 统一目录由核心生成，原节点编辑器不再自行拼接 Agnes/Ark/local 的目录。
- Renderer 可以提交刚输入的 Key 用于保存/测试，但不得持有已存 Key、直接读取系统凭据或直接调用云端。
- Main 根据 bindingId 解析协议、地址、真实模型与权限，不信任 Renderer 自报可用能力。
- 不用通用 OpenAI Chat 协议代替图/音/视频协议；新增适配器按发现模型、校验、提交、查询、取消、下载、用量等能力实现。目录发现为可选；无列表 API 时使用经核验的目录/手工 ID，不伪造发现成功。
- Agent 接入改原 pi-main/packages/vibepaper-agent-service 的协议/模型适配及 Tool Gateway，桌面 Worker 只承载通信和生命周期。
- 本地连接仅允许 loopback；云端连接默认 HTTPS。端点验证、重定向和下载独立管控，跨域跳转不转发鉴权头，不接受内嵌 URL 密钥；任意高级请求脚本不在范围内。

### 配置与测试事务

保存时验证 schema、地址和绑定，准备新凭据与配置，原子切换已生效版本后再清理旧凭据；失败保留旧配置，新孤立凭据可回收。删除、轮换与任务恢复使用明确引用语义。

测试分层展示结果：地址可达、鉴权通过、目录发现、目标模型权限、操作能力。不能用 GET /models 成功证明所有模态可生成。无可用免费探测接口时标「无法通过连接测试验证模型权限」，必要的真实生成测试由用户明确发起并显示可能费用；不暗中生成媒体。

记录单次请求耗时、测试时间与验证范围，不把一次测试写为「最低延迟」。错误区分无效 Key、权限、限流、协议不匹配、无模型、超时、网络问题、文件输入约束和结果下载失败，详情移除密钥。

### 任务与授权

异步媒体任务优先轮询，持久化远端 ID 和恢复位置；提交响应不等于成功，只有结果已落盘且可读才成功。提交结果不明时进入可解释的恢复/核对状态，不盲目重试 POST 导致重复费用。停止轮询不表示供应商取消成功；不支持取消时明确提示远端可能继续执行并收费。

配置页披露实际渠道、上游供应商（已知时）、发送文本/图片/音视频/会话范围及供应商费用；改渠道或扩大上传范围重新取得对应授权。普通手工生成/发送不逐次弹确认。Agent 生成仍沿用原单个/批量确认卡，绑定画布版本、操作、bindingId、参数与配置版本；渠道或影响变化使旧确认失效。

## 8. 测试与交付次序

1. **契约和接入清单**：同步 AGENTS、provider、UI/backend parity、数据字典、接口类型；对 72 项建立「显示名—渠道 API ID—协议—能力—来源—实现/实测状态」矩阵；补视频缺失项。
2. **第一条可运行链**：统一 Registry + 系统凭据 + 官方配置页 + 原两列选择器；优先接 Anthropic 官方和字节系官方连接以覆盖目标默认文/图/视频。现有 Agnes、Ark、本地连接迁入统一目录并验证旧项目兼容，不以先扩展 Agnes 替代官方接入。
3. **默认文图视频闭环**：按官方型号、账号与协议核验结果，接 Claude Fable 5.1、Seedream 5.0 Pro、Seedance 2.5 的官方 API；文图视频都验证真实输入、参数和本地结果。缺官方接口、权限或测试账号不能标完成，也不静默改走聚合渠道。
4. **覆盖剩余官方厂商**：建议先补 OpenAI、Google、DeepSeek、Moonshot、xAI 的文本与其已核验媒体能力；再补阿里云、Kling、MiniMax、Vidu、PixVerse、BytePlus 的对应官方能力及 ElevenLabs、Fish Audio、Doubao 等音频能力。具体批次可按可用账号和接口调整，始终先完成官方适配。统一配置页面可以先发布，但待接入条目保持明确状态，不靠禁用或 mock 达成全模型验收。
5. **恢复和打包**：无效 Key、断网、429、超时、提交结果不明、取消、重启、切项目、换 Key/渠道、项目目录移动、两个同名模型渠道；Windows/macOS/Linux 系统凭据和安装包验证。
6. **后续渠道扩展**：官方优先范围交付后，再扩展聚合渠道、自定义代理和新的本地能力，复用连接与绑定结构。

必要验收场景：

- 无配置的空画布只显示配置入口；配置/启用一个模型只出现正确品牌与模态。
- 同名模型来自两个渠道，确实分别调用对应 Key/地址；禁用一个不影响另一个。
- 旧节点失效选择保留名称与结果，生成阻止且给出重新配置入口。
- 三个参考对三个目标一对一编排正确；参考上限、模式、时长和 adaptive 在 Renderer 与核心一致。
- 配置页返回保留视口、节点、提示词，后台任务不被路由切换终止。
- Key 不出现在 settings 明文、项目、日志、JSONL 或导出；系统安全存储不可用时明确失败，无明文回退。
- 本地模式、页面打开、品牌图标渲染不产生外部请求；只有用户发起的测试/发现/生成及其恢复链按授权联网。
- 原 Web 路径保持原默认行为；桌面不显示点数、不新增任务抽屉。
- 单元/协议契约测试验证边界；真实 Key 集成测试验证渠道；原组件桌面截图/录屏验证 UI。每项单独报告，不能用构建通过替代运行能力证据。

## 9. 实施位置

- 新页面建议放 pi-paper-web/src/features/settings/ModelConfigurationPage.tsx，复用原组件与布局。
- 修改 pi-paper-web/src/app/router.tsx、原设置/导航入口、components/ui/ModelPicker.tsx、ModelBrandIcon.tsx。
- 原 NodeEditorPanel.tsx、videoNodeParameters.ts、AgentPanel.tsx 统一读取目录和参数规则。
- 扩展 pi-paper-web/src/desktop/desktop-bridge.d.ts、pi-paper-desktop/src/preload.cjs、main.cjs 的受限接口。
- 新增本地 Registry、配置存储、凭据封装及分协议适配器，保留现有 TaskStore 和 Generation Worker 生命周期。
- 不在平行 DesktopWorkspace 上实现本功能，不改动当前无关的未提交修改。

## 10. 官方参考与待讨论项

已核验结构性协议依据：

- Claude 使用 Messages API，并提供独立模型目录 API：[Claude API overview](https://platform.claude.com/docs/en/api/overview)。
- Veo 视频生成返回异步 operation，需查询完成并下载结果：[Veo Gemini API](https://ai.google.dev/gemini-api/docs/veo?hl=en)。
- Seedance 2.5 时长与不同模式的 ratio/duration 约束：[创建视频任务](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)、[Seedance 2.5](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh)。

未逐项核验其余所有型号、参考上限与账号权限；实施矩阵必须补充供应商文档、实际 API ID 与实测证据。

已确认：各厂商官方 Key 支持，官方 API 优先实现；默认三模型优先核验并接入其官方渠道。

待讨论：配置是否本机全局；视频第 26 项名称；各厂商测试账号是否具备目标型号权限；声音节点各操作默认值。配置范围可按本稿建议继续细化，其余不凭空补齐。设计讨论与代码编写不要求用户把 Key 发到聊天；真实集成验收时通过应用安全配置入口输入。
