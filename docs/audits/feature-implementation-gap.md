# VibePaper 功能实现缺口清单

> **审计结论：当前项目未 100% 真实实现飞书产品指南 / PRD / 技术架构中的功能。**
> 多数管理空间与画布 CRUD、计费冻结结算、任务状态机、Agent SSE/确认令牌具备真实 API 与持久化；但 **AI 生成供应商、支付通道、图视频加工、合成/导演台、Agent 规划智能** 等核心体验价值仍为 Mock 或半成品。
>
> **2026-08-02 补齐进度（本轮）**
> - 画布：右键新建、本地文件拖入、素材导入事件、输出端创建下游、连线选中黑色、风格预设、全屏预览
> - Agent UI：偏好落库、新建对话、历史切换、片段导入、Skill 空白/对话/上传三种创建、attach API
> - Agent 规划：配置 `VIBEPAPER_LLM_*` 后走 OpenAI 兼容 LLM（httpx），失败回退规则
> - Generation：按模态正确分流 mock provider；文本支持 openai-text；加工/合成/导演台改为真实 `/tasks`（本地 Pillow/ffmpeg）
> - 支付：仍保持 mock-pay（按产品要求暂不接微信/支付宝）
> - Seedance 视频：已接火山方舟 `volcengine-ark`（需配置 `VIBEPAPER_ARK_API_KEY`）
> - ComfyUI：**仍未接入**（仅探测占位；需 `VIBEPAPER_COMFYUI_BASE_URL` + workflow 提交实现）
> - Seedance 素材认证接口：仍待供应商认证 API

| 项 | 内容 |
|----|------|
| 审计日期 | 2026-08-02 |
| 对照来源 | [飞书《VibePaper产品介绍与使用说明》](https://zcntlxao3dgg.feishu.cn/wiki/GM9ywBfj7iCkCTk5gMqcA2ZVnzb) · `docs/VibePaper产品需求文档新版.md` · `docs/技术概要设计方案.md` · `docs/VibePaper 产品功能清单.md` · `AGENTS.md` |
| 方法 | 静态代码审计（前端 `pi-paper-web`、Java 微服务、`generation-service`、`agent-service`）；未做端到端运行验收 |
| 状态定义 | **MOCK** = 假数据 / Toast 假装成功 / Mock Provider；**PARTIAL** = 有真实 API 或 UI 但缺关键路径；**MISSING** = 代码中不存在 |

---

## 0. 总览

| 类别 | 数量级 | 说明 |
|------|--------|------|
| 真实闭环较强 | 约十余项 | 认证、画布 CRUD/保存、节点连线基础、任务提交+SSE、点数冻结结算、历史/奖励/邀请/公告、分享发布等 |
| 虚拟 / Mock | 重点 8+ 块 | 全部生成 Provider、Mock 支付、图/视频加工、Seedance、合成、导演台、Agent 规则规划、Skill 对话总结 |
| 半成品 / 缺口 | 二十余项 | 右键新建、风格预设、三视图、编组堆叠交互、Agent 偏好/历史/Skill 三创建法、创意广场预览、企业转入素材 UI、LangGraph、OpenAPI 客户端、测试等 |
| 契约明确不做（V1.0） | 1 | 同一画布多人实时协同（飞书文案有，PRD/`AGENTS.md` 明确否） |

---

## 1. 明确虚拟 / Mock 实现（按影响排序）

### 1.1 AI 模型生成（全部 Mock Provider）

| 功能（指南/PRD） | 状态 | 证据 | 说明 |
|------------------|------|------|------|
| 文本/图片/视频/音频生成调用真实模型 | **MOCK** | `generation-service/src/generation/providers/providers.py`：`MockText/Image/Video/AudioProvider`；`model_service.py` 种子模型均 `provider: "mock"` | 任务状态机、冻结结算、SSE 为真；产出为占位文本/本地合成图/伪视频文件 |
| ComfyUI / 供应商网关 | **MISSING** | 技术概要要求 ComfyUI 等；代码仅注释提及 | 无真实供应商适配器 |
| 合成节点真实拼接 | **MOCK** | 前端 `nodes/index.tsx` Toast「合成任务已发起（Mock）」；后端有 `MockComposeProvider` 但 UI **未** `POST /tasks` | 指南要求多段视频预览+合成 |
| 导演台真实拍照渲染 | **MOCK** | `nodes/index.tsx` Toast「拍照完成（Mock）」；`MockDirectorProvider` 未接任务提交 | 指南要求完整导演台编辑页与拍照输出 |

### 1.2 支付充值

| 功能 | 状态 | 证据 | 说明 |
|------|------|------|------|
| 购买点数 / 订阅支付 | **MOCK** | `billing-service` `RechargeController` `POST …/mock-pay`；前端 `SubscriptionMenu.tsx` / `SubscriptionsPage.tsx` 下单后调 mock-pay | 账户、流水、冻结结算为真；渠道默认 `mock` |
| 真实支付回调（微信/支付宝等） | **MISSING** | `RechargeService` 注释写明开发期 mock | PRD 待确认项亦指向模拟回调可切换 |

### 1.3 图片 / 视频加工（飞书指南重点 · PRD P1）

| 功能 | 状态 | 证据 |
|------|------|------|
| 图片裁剪（单图/四宫格/九宫格） | **MOCK** | `nodes/index.tsx` `ImageActions`：仅写 `params.operation` + Toast「…（Mock）」；无选区 UI、无任务 |
| 图片扩图 | **MOCK** | 同上 |
| 图片超分 | **MOCK** | 同上 |
| Seedance 2.0 素材认证（黄/绿/红状态） | **MOCK** | 本地 `useState` 切换 pending/approved，无后端/供应商接口 |
| 视频剪辑（首尾框选） | **MOCK** | `VideoActions` Toast Mock |
| 视频提取帧 | **MOCK** | 同上 |
| 视频超分 | **MOCK** | 同上 |
| 视频 Seedance 认证 | **MISSING/MOCK** | 视频侧无认证按钮；指南要求有 |

> 下载到本地、存入素材库（任务成功后）经 `OutputActions` / `saveOutputToLibrary` 为真实路径，不列入本表。

### 1.4 Agent 智能层

| 功能 | 状态 | 证据 |
|------|------|------|
| 自然语言理解与全流程自动创作（指南核心亮点） | **PARTIAL → 实质 MOCK 规划** | `agent-service/.../planner.py` 标注「mock 规划」：关键词规则提取节点；非默认 LLM |
| LangGraph 编排（技术概要 / AGENTS） | **MISSING（可选依赖未落地）** | `pyproject.toml` 有 `langgraph` extra；`src` 无图编排实现 |
| 从当前对话生成 Skill（自动总结） | **MOCK** | `skill_service.generate_from_session()` mock 总结；前端亦未接该创建方式 |

### 1.5 前端明示假成功

| 位置 | 行为 |
|------|------|
| `pi-paper-web/src/features/canvas/nodes/index.tsx` | 裁剪/扩图/超分、剪辑/提帧/超分、合成、导演台拍照：`toastSuccess('…（Mock）')` |
| 同上 `AudioNodeView` | 「上传参考」选文件后仅 Toast「参考音频已上传」，无实际上传 API |
| `AdminPage.tsx` 新建模型 | 硬编码 `provider: 'mock'` |

---

## 2. 未实现或严重半成品（相对飞书指南）

### 2.1 基础画布（指南 §1.1）

| 功能 | 状态 | 缺口说明 | PRD 优先级 |
|------|------|----------|------------|
| 新建卡片 · 右键空白区 | **MISSING** | 全前端无 `onContextMenu`；仅左侧添加 + 双击菜单 | P0 AC-02 |
| 上传本地素材 · 右键上传 | **MISSING** | 四种方式中右键路径缺失 | P0 |
| 上传 · 画布空白拖入原始文件 | **PARTIAL** | 支持拖入素材库 JSON；未见通用本地文件 drop | P0 |
| 素材库「导入画布」菜单项触发 | **PARTIAL** | 派发 `vp-add-asset-node` 但无监听；拖拽路径可用 | P0 |
| 连线 · 点击句柄呼出模态创建上下游 | **MISSING** | 仅拖拽连线；无模态选类型并自动创建 | P0 AC-06 |
| 连线选中态黑色 | **MISSING** | 仅有蓝(有效)/灰(无效)；无选中黑色 | P0 |
| 风格功能 · 预设风格选择器 | **PARTIAL** | `NodeShell` 为自由文本「风格」，无预设列表 UI | 指南有；参数层可传 |
| 三视图功能 | **MISSING** | 代码与 PRD 附录均未实现该专属能力 | 指南有；PRD 未单列 |
| 运镜功能 | **PARTIAL** | UI 有运镜下拉并写入 `modelParams.camera`；Mock 视频忽略语义 | 指南有 |
| 图片/视频全屏展示 | **MISSING** | 未见专用全屏查看器 | 指南有 |
| 一键整理 | **PARTIAL** | 前端简易网格排布，非 ELK/专业布局 | P0 |
| 编组 · 颜色/网格/水平/取消/下载 | **PARTIAL** | 可创建编组并持久化；缺颜色、布局切换、取消编组、真实下载 | P1 |
| 堆叠 · 拼图预览/展开收起/拉出/取消/下载 | **PARTIAL** | 可创建堆叠 API；前端缺拼图预览与展开/拉出交互 | P1 |
| 个人素材 → 团队素材库 | **PARTIAL** | `asset-service` 有 `to-enterprise` API；前端素材库无入口 | P1 |

### 2.2 Agent（指南 §1.2）

| 功能 | 状态 | 缺口说明 | PRD |
|------|------|----------|-----|
| 偏好设置（文本/图/视频模型+分辨率） | **PARTIAL** | Agent 面板内偏好多为本地 state + Toast；真正偏好在订阅菜单 `PUT /me/preferences` | P0 |
| Skill · 从对话生成 / 上传 .md | **PARTIAL** | 后端支持；前端仅 `prompt` 空白创建 | P1 |
| 历史对话切换加载 | **PARTIAL** | 列表展示 sessions/fragments；不能点进恢复消息 | P1 |
| 新建对话按钮 | **PARTIAL** | 打开面板自动建会话；无「新对话」重置入口 | P0/P1 |
| 保存会话片段后跨画布导入 | **PARTIAL** | 可保存；导入 API 无 UI | P1 |
| 短期记忆 UI | **PARTIAL/MISSING** | 后端有 short-term 更新；面板主要露长期记忆列表 | P2 |
| 长期记忆完整参与上下文 | **PARTIAL** | 有 CRUD 展示；与「越用越懂你」产品叙事差距大 | P2 |

### 2.3 管理空间（指南 §2）

| 功能 | 状态 | 缺口说明 | PRD |
|------|------|----------|-----|
| 创意广场 · 成品预览 / 制作过程图 / 全屏 | **PARTIAL** | 列表/搜索/克隆/删除真实；预览偏占位，过程图无完整 React Flow 回放 | P1 |
| 个人中心 · 界面主题设置 | **PARTIAL** | 主题/语言在订阅菜单；个人中心页未完整覆盖指南描述 | P0 |
| 企业中心 · 企业点数充值页 | **PARTIAL** | 成员/分配/CSV/用量/解散等有；企业专属充值入口弱，仍依赖个人 mock-pay | P1 |
| 企业 · 多人同一画布实时协同 | **MISSING（契约否）** | 飞书亮点写「多人协同」；`AGENTS.md`/PRD：V1.0 **不支持**实时共编 | 明确不做 |
| 订阅菜单 · 企业顾问联系方式 | **MISSING/弱** | 文案有企业方案说明；未见顾问联系闭环 | P0 周边 |

### 2.4 技术架构 / 工程契约缺口

| 项 | 状态 | 对照 |
|----|------|------|
| OpenAPI → `src/api/generated` 前端类型 | **MISSING** | `AGENTS.md` / 技术概要；现用手写 `lib/api.ts` + `lib/types.ts` |
| 单元/集成/E2E 测试与计费 ≥90% 覆盖 | **MISSING** | 应用源码未见 `*Test.java` / Vitest / Playwright 套件 |
| 真实 LLM Agent + LangGraph Worker | **MISSING/可选未启用** | 技术概要 §5；现为规则 planner |
| XXL-JOB / Seata 等 | 未在本次逐项核验运行时 | 冻结超时有调度器类（`FreezeExpireScheduler`）等，不等同完整运维栈验收 |
| 自动化 CI 门禁全绿证据 | **未验证** | 执行计划勾选项多为未勾选模板状态 |

---

## 3. 后台管理（功能清单 · 多为 P1/P2）

| 功能 | 状态 | 说明 |
|------|------|------|
| 用户管理 / 内容审核 / 模型 / 套餐 / 交易列表 / 公告 / 审计 / API Key | **PARTIAL→偏 REAL** | `AdminPage` + admin-service 有主路径；深度（筛选、详情、批量、报表）未达清单全部条目 |
| 新建模型接真实 Provider | **MOCK** | 强制 `provider: 'mock'` |
| API 健康监控 / 调用日志完整度 | **PARTIAL** | 有限流字段等；是否达清单「健康监控+调用日志」需产品验收 |
| 会员体系管理 | **PARTIAL（P2）** | 有 tiers 展示页；非完整权益/升级规则配置 |
| 促销折扣、差异化定价完整配置 | **PARTIAL** | 有基础价/套餐；清单级促销矩阵未必齐全 |

---

## 4. 已真实实现（对照用，非缺口）

以下路径在审计中判定为「真实 API + 持久化 + 可用 UI」（**生成内容质量仍依赖 Mock Provider**）：

- 注册 / 登录 / JWT 刷新 / 个人资料
- 画布列表 CRUD、导入导出 `schema_version`、乐观锁保存
- 节点增删改移、框选、连线增删、选择/抓手、适应视图
- 文本/图/音/视频节点参数表单 → 估价 → 冻结 → 建任务 → SSE → 成功后下载/存素材库
- 个人素材库侧边栏 CRUD（图标/列表）、拖拽入画
- Agent 面板开合、SSE 对话、工具调用改画布/触发生成、高风险确认令牌、用量查询
- 任务历史筛选、分享链接、发布创意广场、克隆
- 奖励签到/每日任务、邀请中心、公告
- 企业邀请、成员分配/回收/移出、分配记录 CSV、用量、改名/解散
- 点数账户、流水只追加、冻结超时解冻逻辑（实现存在；需集成测试背书）

---

## 5. 与优先级的对照建议

| 优先级 | 缺口焦点 |
|--------|----------|
| **P0 / MVP** | 右键新建与 AC-06 下游创建模态；风格/运镜等体验对齐；**真实模型至少接通一类**（或正式接受 Mock 为 Demo 退出条件——执行计划允许 Mock 不阻塞联调，但不等于「100% 真实」）；支付可继续 Mock 但需产品签字；Agent 偏好落库；自动化测试与 OpenAPI 契约 |
| **P1** | 图/视频加工与 Seedance、合成/导演台接真任务、编组堆叠完整 UX、Skill 三创建法与会话史、创意广场预览质量、企业素材转入 UI、运营后台深度 |
| **P2** | 短长期记忆产品化、会员体系后台 |
| **产品文案 vs 工程契约** | 飞书「多人协同」「越用越懂你」超出 V1.0 范围，应改文案或排期，避免验收歧义 |

---

## 6. 结论一句话

**不是 100% 真实实现**：外壳与计费/画布主链路大多可用，但飞书指南中的「真实模型创作、媒体加工、合成导演台、Agent 智能与记忆、真实支付」以及多项交互细节仍为 **Mock、半成品或未实现**。若以「可本地联调 Demo」衡量接近执行计划 Phase 2–3；若以飞书指南 + PRD 全功能 + 技术架构真实供应商为准，缺口仍大。

---

## 7. 附录：关键证据路径速查

```
generation-service/src/generation/providers/providers.py   # 全 Mock Provider
generation-service/src/generation/services/model_service.py # 种子 provider=mock
vibepaper-services/billing-service/.../RechargeController.java # mock-pay
pi-paper-web/src/features/canvas/nodes/index.tsx          # 加工/合成/导演台 Mock Toast
pi-paper-web/src/features/canvas/nodes/NodeShell.tsx      # 风格文本、运镜下拉
pi-paper-web/src/features/canvas/AgentPanel.tsx           # Agent 偏好/Skill/历史半成品
agent-service/src/agent/agent/planner.py                   # 规则 mock 规划
docs/plans/execution-plan.md                               # 允许 MockProvider 不阻塞联调
AGENTS.md §7                                               # V1.0 禁止多人实时共编
```

飞书原文抓取备份：`.firecrawl/feishu-guide.md`
