# VibePaper 全服务本地桌面化实施方案

> 状态：实施中；阶段 1 宿主、阶段 2 的本地画布创建/编辑/持久化、PNG/JPEG/GIF/WebP 素材导入与画布引用，以及当前项目格式下的带校验清单备份/恢复副本已实现。Pi JSONL 与 SQLite Agent 存储适配器原型已实现，但未接入桌面 Worker。TaskStore、Agent/生成集成、任务与会话备份、跨版本恢复验证、素材完整管理及其余阶段未落地，未做跨平台验收。日期：2026-09-23。当前桌面版契约以仓库根目录 `AGENTS.md` 为准；Agent 会话与恢复的细节见 `2026-09-23-local-agent-migration-design.md`。已实现的项目格式见 `docs/specs/desktop-local-project-format.md`。

## 1. 已确定的产品决策

1. 首版同时交付 Windows、macOS、Linux 桌面安装包；单用户、单机项目，所有业务数据持久化在本机。
2. 用户可选择本机模型服务或配置自己的云端模型 API Key。默认本地模式不发外部模型请求；用户显式选择云端时，仅本次请求必要的提示词和参考素材发给供应商，结果仍保存到本地。云端供应商可能自行计费，本产品不设点数、余额或套餐。
3. 移除桌面运行链路中的注册登录、点数/充值/订阅、签到/邀请奖励、企业、运营后台、公告活动。创意广场与公开发布暂不展示，旧源码保留。
4. **不迁移旧 Web 服务的数据。** 桌面版新建空白项目，不提供旧 PostgreSQL 导入脚本；不能因此省去桌面版自身的 schema 升级、项目备份和恢复。
5. 保留现有 Node.js + TypeScript + Pi Agent Core 的 Agent，完整会话落本地 JSONL；控制状态使用本地 SQLite。Python 仅承担生成提供方适配与媒体处理，不恢复旧 Python Agent。

## 2. 现状与迁移目标

当前前端 `vibepaper-web/src/lib/api.ts` 以 `/api/v1` 和 JWT 调网关；`vibepaper-services/vibepaper-gateway/src/main/resources/application.yml` 将 `POST /tasks` 路由到 billing，再把任务查询路由到 generation。`billing-service/PointService` 冻结点数并通过 outbox 创建任务，Node Agent 的 `GenerationActionExecutor` 也直接调用 `freezeGeneration`。`generation-service` 用 PostgreSQL 保存任务、Redis 推送事件，并向 billing/identity/admin 回调。`pi-main/packages/vibepaper-agent-service/src/server.ts` 启动时要求 PostgreSQL。Java canvas/asset 已有重要领域校验和本地素材模式，不能仅换数据库驱动就视为桌面化。

目标进程：

```text
Electron Main：项目选择、生命周期、凭据、备份、受限 IPC
  ├─ Renderer：现有 React 画布和 Agent 面板
  ├─ Local Core（Node/TypeScript，唯一业务写入口）
  │   ├─ CanvasStore / AssetStore / TaskStore / ModelCatalog
  │   ├─ project.sqlite、项目文件、受控本地 API/SSE
  │   └─ 调用 Agent Worker 与 Generation Worker
  ├─ Agent Worker（Node/TypeScript + Pi Agent Core）
  │   ├─ JSONL 会话、agent/control.sqlite、Markdown Skill/记忆
  │   └─ Tool Gateway → Local Core 受控端口
  └─ Generation Worker（Python sidecar，仅模型调用/媒体处理）
      └─ 输入为任务快照；输出为临时文件与状态，不直接改项目数据库
```

在单机版收敛服务边界，但保留画布、素材、任务的领域接口；Agent 只能经 Tool Gateway 调用它们。Local Core 是项目业务数据库的单写者，Agent 的控制库是独立写者。跨两库和 JSONL 的操作使用稳定 operationId、可查询业务结果与 outbox 恢复；不得假设跨进程事务。

## 3. 逐服务处理表

| 现有单元 | 桌面版处理 | 主要实施点 |
| --- | --- | --- |
| `vibepaper-web` | 复用 UI，放进 Electron Renderer | 移除 JWT 页面守卫与云端账户请求；保留画布交互、SSE/任务历史语义；隐藏创意广场等旧入口；提供本地项目与模型设置 |
| `vibepaper-gateway` | 桌面运行时退出 | Local Core 提供兼容 `/api/v1` 路由或窄 IPC；不再透传用户/企业头，不允许 Renderer 任意调用内部端口 |
| `identity-service` | 桌面运行时退出 | 本地配置负责昵称、界面与默认模型偏好；无注册、JWT、刷新令牌、签到与邀请；保留稳定本地 profileId 供新项目关联 |
| `canvas-service` | 将必需领域能力移入 Local Core | 画布 CRUD、节点/连线、GraphService 的能力/依赖校验、分组堆叠、短剧素材、导入导出和 version 乐观锁；保留现有语义测试作为迁移对照 |
| `asset-service` | 将必需领域能力移入 Local Core | 文件导入、类型/大小校验、元数据、缩略图、引用、替换/删除影响；项目内相对路径与安全文件读取，取代 MinIO/硬编码盘符 |
| `billing-service` | 桌面运行时退出 | 删除任务入口对冻结、流水、结算、充值的调用；`POST /tasks` 改由 TaskStore 创建；旧源码仅供 Web 对照 |
| `enterprise-service` | 桌面运行时退出 | 无企业成员、邀请、共享点数池；项目文件可本机复制，但不实现多人权限或协作 |
| `gallery-service` | 桌面运行时退出，代码保留 | 隐藏创意广场、公开发布、审核、远端克隆；本地模板/画布导出作为独立后续功能 |
| `admin-service` | 桌面运行时退出 | 模型配置转本机设置；诊断日志本地保存，不部署运营后台或平台分析接口 |
| `generation-service` | 保留 Python 提供方代码，改为受控 Worker | Local Core 持有任务状态和模型目录；Python 接收执行请求并返回输出，不持有任务主库；移除 billing/identity/admin 回调、Redis/Celery/MQ 的桌面依赖 |
| `pi-main/packages/vibepaper-agent-service` | 保留 Pi Agent 能力，新增 desktop bootstrap | JSONL 完整会话、SQLite 控制账本、Markdown 记忆；Tool Gateway 调本地端口；移除桌面路径的 PG/Redis/Nacos/billing/identity 依赖 |
| `deploy/`、`docker-compose.yml` | 只供旧 Web 开发或对照 | 新增桌面开发启动与三平台打包流程；最终安装包不要求 Docker 或独立基础设施 |

## 4. 本地数据与接口契约

建议布局（实际目录由系统用户数据路径和用户选择的项目目录决定，绝不硬编码 `E:`）：

```text
<OS userData>/VibePaper/
  settings.json                 # 非密钥、项目列表和模型偏好
  catalog.sqlite                # 可重建项目索引
  memory/、skills/              # 全局本地内容
  logs/                         # 脱敏诊断日志
  <OS credential store>         # 云端 API Key，不进普通文件/项目备份
<project>/.vibepaper/
  project.json                  # schemaVersion、稳定 projectId
  project.sqlite                # canvas/node/edge/asset 元数据/task/model binding/idempotency
  assets/<sha256>/...           # 导入素材；元数据保存相对引用
  outputs/<taskId>/...          # 先写临时文件，校验后原子发布
  agent/control.sqlite
  agent/sessions/.../*.jsonl
  agent/memory/、agent/skills/
```

- `project.sqlite` 是画布、资产引用、TaskStore 和本地任务幂等的权威；图片/视频原件以项目文件为权威。资源 URL 只能由受控 API/协议解析到项目内路径，禁止 `../` 越界和 Renderer 直接读取任意本地文件。
- 写画布仍采用 `canvas.version` 条件更新；保存节点/连线与版本增加在一个事务内。保留 300–500ms 增量防抖和最终操作立即持久化。删除节点先计算关联连线与下游影响。
- 任务创建：`POST /api/v1/tasks` 接收 `Idempotency-Key`、canvasId、nodeId、modelId、参数和输入引用；事务中先插入 `queued` 任务与幂等记录，再启动 Worker。重复键返回原任务。提交与取消不再调用 billing；`GET /tasks`、单任务详情、事件流和历史仍由本地 API 提供。
- 状态主线为 `queued → running → succeeded | failed | cancelled`。进程退出前可取消的任务尽力取消；异常重启后，先核验 provider job ID、临时/正式结果和本地任务记录。结果不确定时标记可见的待恢复状态，不盲重提可能收费的云端请求。重试创建新 attempt，并保留原 taskId 与结果历史。
- `succeeded` 的事务提交必须发生在输出文件已写完、类型/可读性通过校验、节点引用可安全更新之后；事件流可以重连并从持久化状态补发，不能只依赖 Redis pub/sub。取消、重试和 Agent 续跑共享同一 TaskStore 真相。
- 本地通信优先验证受限 IPC 与现有 SSE 的兼容性；若使用 HTTP，仅监听 `127.0.0.1`/`::1` 随机端口，启动时生成秘密令牌，校验 Origin/调用者，不信任来自 Renderer 的用户或内部服务头。
- 项目目录移动用 projectId 重新定位；运行中每项目互斥，SQLite 使用 WAL。备份包含一致性 SQLite 快照、JSONL、Markdown 与实际素材/输出文件，恢复后逐项校验引用。桌面项目未来升级按 `schemaVersion` 做备份后迁移；旧 Web 数据不导入。

阶段 1 以带 `schemaVersion` 的 `project.json`/`canvas.json` 引导可重开的空白项目；阶段 2 已在 Electron utility process 内创建 `project.sqlite`、把旧引导 JSON 导入事务，并完成 SQLite v1→v2 的备份迁移、首批图片资产/画布引用，以及包含 SQLite/素材校验的恢复副本切片。任务权威存储、素材删除影响、任务/Agent 数据备份恢复和更广泛的升级故障回退仍待实现，不能让两套格式长期并列为权威。

## 5. 模型提供方与数据出境

- 建立一个显式 Provider Registry：`providerId`、`local/cloud`、endpoint、模型名、模态（文/图/音/视频）、输入模式、参考素材类型与数量、工具调用能力、流式/取消能力、可用性。Agent 与生成模块共用能力契约，不用点数定价判断模型可用性。
- Agent 当前 `agnesModel` 固定 `provider: "agnes"`，且无 Key 就拒绝运行；桌面版改为按本机设置选择云端或本地 provider。文本可先适配 OpenAI 兼容接口，但本地模型的工具调用、上下文窗口和多模态能力必须逐个检测，不能仅换 base URL。
- 生成服务现有文本适配、云端图/视频适配可抽取复用；`ComfyUIProvider` 目前只有连通探测、未提交 workflow，因此本地图/视频需单列实现任务，音频同理。某模态缺少可用提供方时展示“未配置/不支持”，不得静默走 mock 或云端。
- 云端模式先在设置中配置供应商、API Key 和允许发送的数据类型；任务界面显示当前为联网调用，参考素材发送前展示范围。API Key 通过 OS 凭据能力保存；日志、Agent JSONL、项目导出均不包含明文密钥。供应商费用由供应商承担计费，UI 可显示 Token/时长但不显示平台点数。
- 本地模式做网络出口验收；本地模型未安装、内存不足或服务退出时明确失败/等待，不自动切云。用户明确选择云端时，断网或 Key 无效也明确报错，不自动换另一个供应商。

## 6. 实施顺序与每阶段完成条件

| 阶段 | 工作 | 完成条件 |
| --- | --- | --- |
| 0. 契约与切片 | 固定桌面版 API/数据字典、旧接口对照、模型能力表、项目目录及备份格式；选一条“创建画布 → Agent 连线 → 提交任务 → 本地保存输出”纵向用例 | 契约评审通过；旧 Web 运行路径和工作区未提交改动不受影响 |
| 1. 桌面宿主 | 新建 `vibepaper-desktop` Electron 工程；项目选择、单实例/项目锁、受限 IPC、用户数据目录、空白项目创建；React 在桌面窗口运行 | 三平台开发构建能打开空白画布；无登录/网关/基础设施要求 |
| 2. 本地核心 | 实现 CanvasStore、AssetStore 与 `/api/v1` 兼容层；迁移 Java 领域校验和画布版本规则；本地 profile/preferences | 新建、保存、关闭重开、导入导出、引用素材和删除影响测试通过；Agent 可读本地画布摘要 |
| 3. 本地任务与模型 | TaskStore、持久事件流、Worker 协议、模型目录和云端/本地 provider；先打通一种文本与一种图像能力，再逐步验音/视频 | 手工节点生成、取消、重试、断点恢复通过；无 billing/Redis/MQ/PG；未支持模态可见不可用 |
| 4. Agent 本地化 | 按 Agent 专项方案接入 Pi JSONL、SQLite 控制账本与 Local Tool Gateway；去掉按点数确认，保留风险确认；实现本地/云端模型选择 | 同一纵向用例由自然语言完成；重启不重放写工具，跨 50+ 消息与压缩仍能正确读取画布；无 Agent PG/Redis/Nacos |
| 5. UI 与范围收敛 | 去掉桌面路由中的登录、点数、套餐、签到、邀请、企业、运营、公告、创意广场；替换账户为本地设置与任务/Token 信息 | 桌面安装包无旧服务调用和相关入口；旧 gallery 源码保留；云端发送范围提示可见 |
| 6. 交付 | 项目备份/恢复、升级迁移、日志、崩溃恢复、三平台签名/安装包、真机 E2E | Windows、macOS、Linux 各自安装包从空项目完成画布+Agent+任务+素材闭环；无 Docker 与平台账户 |

阶段 2–4 的实施应按纵向切片反复穿透，不等所有模块整体重写才测试。各阶段用现有 API 行为与画布验收用例对照；旧数据迁移、旧账本兼容、公开画廊不构成门禁。

迁移实现进展（2026-09-23）：Agent 存储适配原型现位于 `pi-main/packages/vibepaper-agent-service/src/desktop/`，提供项目单写者锁、Pi JSONL 会话存储、SQLite Run/操作/outbox 存储，以及 outbox 补投 JSONL。SQLite 适配器通过 `SessionRunService` 可选原子接口将 Run 终态、事件和 outbox 一起提交。会话索引使用稳定 `projectId` 键支持项目目录搬迁。此原型尚未由桌面 Worker 装配，也未与本地 Canvas/Asset/Task Tool Gateway、确认/记忆端口和桌面备份链路连接，相关阶段验收仍待完成。

本地任务存储进展（2026-09-23）：桌面 `project.sqlite` 已升级到 schema v3，新增带 `Idempotency-Key`、画布版本/节点关联、模态与提供方信息的 TaskStore，以及顺序事件表。进程重开时，遗留 `running` 任务转为 `interrupted`，不自动重新提交；只有 `queued` 可直接领取，运行中任务需要 Worker 协调取消。成功终态要求结果位于任务专属项目目录且文件可读，记录 SHA-256/大小；项目备份清单会包含已登记的成功结果，v3 升级先生成数据库回退副本。当前只接通本地核心存储接口，尚无模型目录、生成 Worker、任务 UI 或 Tool Gateway；云端任务在授权/数据告知链路接入前明确拒绝。

## 7. 关键故障测试与退出旧依赖判据

1. `POST /tasks` 返回丢失后重复请求只存在一条任务；Agent 写画布成功但 JSONL 未追加时，恢复后只补记录，不再执行相同操作。
2. 输出文件写到一半、模型进程退出、云端请求超时、应用强退时，不宣布成功；重启后依据本地任务和供应商 operationId 恢复或提示人工处理。
3. 画布版本变化使旧确认失效；指定参考节点与目标节点先连线再生成，三个来源与三个目标只生成明确的 1:1 关系。
4. 断网可打开项目与已有结果；本地模式抓包无外部模型/遥测请求。云端模式显示供应商及发送内容类型，Key 错误和模型能力不匹配均可见。
5. 移动项目目录、备份/恢复、同时打开同一项目、SQLite WAL 中途备份、JSONL 尾行损坏都有测试。升级迁移失败回滚到升级前备份；不触碰旧 Web 数据库。
6. 最终桌面启动清单和打包内容不包含 `billing-service`、`identity-service`、`enterprise-service`、`gallery-service`、`admin-service`、Java gateway、PostgreSQL、Redis、Nacos、RocketMQ、MinIO、Docker 运行时。Python Worker 和本地模型服务按能力配置，不要求用户安装开发工具链。

## 8. 当前风险与设计约束

- Java Canvas/Asset 的 GraphService、分组堆叠和短剧资产规则需要逐项迁移；仅把 UI 打包成 Electron 无法满足脱离基础设施运行。
- Agent 当前 `createApp` 在多处直接构建 PG Repository 且 `readHistory` 只读最近 48 条文本；Pi JSONL 虽存在，但接入需要存储端口、完整消息记录、工具结果关联与恢复原型。
- Python 生成服务的任务状态、模型价格与 billing 回调交织。必须让 Local Core 先拥有 TaskStore，再切除估价/冻结/结算字段；云端供应商请求超时后不得自动重复提交。
- 三平台的 Python Worker/媒体依赖、文件权限、视频编解码和本地模型能力有差异；每个平台都需要独立构建与真实安装测试。应用可连接用户已有本地模型服务，不把模型权重打进首版安装包。
- 创意广场代码保留但入口禁用，不能让其网络请求在桌面启动时被动触发。旧 Web 数据不迁移，意味着旧项目和历史会话不会自动出现在新桌面应用中，这属于已确定的产品边界。
