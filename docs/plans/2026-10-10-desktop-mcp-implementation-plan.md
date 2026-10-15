# 桌面本地 MCP 实施计划

日期：2026-10-10；2026-10-11 接续实施。状态：**用户已授权 Luna（max）子 Agent 实现，主 Agent 集成审查；阶段完成情况以验收记录为准。**

用户已选择桌面应用运行、原画布页打开时调用，不做无界面后台创作；追加授权外部 Agent 协助填写并使用图片/视频模型 API Key。行为以 [MCP 功能规格](../specs/desktop-mcp-functional-spec.md)、[AGENTS.md](../../AGENTS.md) 及[提供方数据契约](../specs/desktop-provider-data-contract.md) 为准。

## 1. 交付链路

用户打开本地画布 → 在桌面启用/授权 MCP → 导出 Codex/Claude Code 连接配置 → 外部 Agent 读取能力目录 → 按用户要求配置图片/视频提供方凭据 → 完成原供应商披露授权 → 启用模型与安全鉴权检测 → 创建目标节点和参考连线 → 桌面系统确认生成 → TaskStore/原 Worker 执行 → 原节点展示可读取结果 → 外部 Agent 查询完成状态。

普通工具调用由外部 Agent 编排，不自动运行内置文本模型。Key 写入、提供方数据发送授权、生成系统确认是三个不同的边界；不能互相替代。

## 2. 当前源码依据与必须先解决的缺口

| 位置 | 当前基础 | 实施要求 |
| --- | --- | --- |
| `pi-main/packages/vibepaper-agent-service/src/tools/runtime-tools.ts` | 原工具 schema、节点/连线编排、生成准备与提交 | 提炼外部执行上下文/映射，复用业务规则；不照搬内置会话依赖 |
| `src/application/approval-service.ts`（原 Agent 服务） | 版本、过期、确认消费及幂等消费 | 补外部连接/项目与操作绑定，可信桌面确认后才提交 |
| `src/desktop/local-tool-gateway.ts`（原 Agent 服务） | 原领域命令到桌面 RPC 的适配 | 分离运行来源和权限，保留原内部调用路径 |
| `vibepaper-desktop/src/main.cjs` 的 createAgentWorker 内 dispatch | 参数白名单、当前项目、取消、生成目录与 TaskStore 接入 | 移出 Worker 私有闭包，统一授权/确认，不公开私有核心方法 |
| `vibepaper-desktop/src/local-core.cjs`、`project-store.cjs`、TaskStore | 权威状态、串行写者、CAS 与持久化 | 持续复用，不给 stdio 子进程直接打开 Store |
| `vibepaper-desktop/src/provider-settings.cjs` | 官方字段、凭据合并、安全存储与检测 | 增加全来源 revision、配置提交/恢复协调、秘密输入脱敏 |
| `vibepaper-web/src/features/providers/ProviderConfigurationPage.tsx` | 原厂商配置、密码输入、披露与检测状态 | 接待处理公开配置/授权及状态刷新，保持原 Web 分支 |
| `vibepaper-web/src/features/canvas/canvasPersistence.ts`、CanvasPage | 当前 Renderer flush、保存和载入 | Main 可请求的保存屏障、事件版本去重、未保存编辑保护 |
| `useDesktopAgentController.tsx` | 现有内置 Agent 事件刷新节点/任务 | 外部画布事件独立于内置会话订阅，复用原任务 feed |
| 桌面 build/package 脚本、electron-builder | 当前安装包与独立 Worker 构建 | 打包 stdio 启动器/运行时，避免 GUI 日志污染 stdout |

配置保存当前分步写加密凭据与 providers.json，不应宣称天然跨文件原子。新增 MCP 重试与配置并发前，必须定义中断恢复、revision 和不完整配置禁用机制，并统一原配置页与外部写入的版本控制。

## 3. 阶段与完成门槛

### M1：共享可信入口与 MCP 只读连接

1. 在原 TypeScript Agent 服务建立 MCP adapter/共享命令上下文，复用原工具 schema 与服务；桌面 CJS 只保留进程/平台适配。
2. Main 的共享入口接可信 source、client/grant、项目/画布、operation 与 cancellation；白名单拒绝未知字段、私有方法及伪造来源。
3. 实现 stdio SDK 初始化与工具发现、loopback 发现/鉴权/桌面配对、逐客户端撤销；设备级策略 schemaVersion 独立于项目备份。首期每个新桥接进程一次桌面批准和短码核对，令牌仅内存；重启客户端需重新批准，不逐工具调用确认，不以grantId/同用户pipe ACL自动鉴权。
4. 接 `get_context`、画布/节点/素材元数据、模型/提供方公开目录和授权任务读取；授权范围不足时不泄漏信息。
5. 在原设置区域加入启用/授权与连接配置导出；配置仅含路径、连接标识和非秘密参数。客户端自己安装连接，不擅自修改外部配置文件。

完成门槛：Codex 与 Claude Code 各一次标准 MCP 初始化、读取授权画布；未启动、无授权、跨项目、撤销、陈旧实例和非法 RPC 均可验证拒绝。此阶段不宣称可编辑或生成。

### M2：画布命令、幂等与原界面同步

1. 接原建节点、更新、连线与布局服务；客户端显式 operationId/expectedVersion，不用 JSON-RPC id 作幂等键。
2. 实现 Main → 原 Renderer 保存屏障和写入队列。保护屏障期间的后续编辑，窗口关闭/保存失败不派发外部写入。
3. 新增不依赖内置 Agent session 的画布版本事件，接原 CanvasPage；事件去重、权威版本重载及待保存编辑协调。
4. 原服务的批量部分完成按实回报，超时先查原命令账本；高风险工具待撤销/确认能力接通后开放。

完成门槛：外部建改连布局在原 UI 即时可见；三个参考对应三个目标；用户拖拽/提示词编辑与外部命令交错时不丢失编辑；同键重试无重复节点，异内容冲突。保存屏障必须用真实 Renderer 链路验收。

### M3：图片/视频模型配置与凭据写入

1. 接提供方公开 schema 与稳定 bindingId；实现独立 provider.configure 授权，按厂商/字段限制。
2. 接 configure_provider 的 authorized_env、desktop_input、明确授权 inline 三种来源。env 注册映射不允许任意枚举/路径读取；inline 授权及外部记录风险由连接设置说明。
3. 接原 provider-settings 校验/加密存储，不回读秘密；Key/端点改变失效检测。入口在任何日志/审计处理前移除秘密。
4. 为原配置页与 MCP 统一 revision/CAS，定义安全暂存、提交与恢复账本；部分失败不显示 saved 或允许新生成。真实 schema 版本在代码落地时分配。
5. 原配置页接受待处理模型/参数和供应商披露，授予指定数据发送范围；已有范围内不逐次确认配置写入/检测。
6. 安全鉴权检测只调用已核验官方端点，返回 connected/failed/unsupported；不支持时明确说明，不以生成代替免费检测。

完成门槛：外部自然语言完成图片/视频配置并在原选择器显示；凭据缺失/无效、字段不匹配、模型未实现、revision 冲突、安全存储不可用均有明确结果。用假秘密 canary 检查响应、日志、JSONL、普通账本、导出及配置片段无泄漏；专门验证外部原文保留不被错误承诺为已消除。

### M4：桌面确认、任务生成与恢复

1. MCP prepare_generation 映射原单个/批量准备，复用能力、参考、参数规范化与 ApprovalService；返回持久化提案。
2. 原确认组件展示外部请求来源、目标、模型、输入、参考及覆盖影响；不显示内部标识/平台点数。
3. 确认由可信桌面入口消费，Main 服务复核授权/版本/引用/有效期；以稳定幂等键调用现有 TaskStore/生成 Worker。
4. get_operation、check_task_status 与受限结果读取接权威存储；保持原节点结果与错误展示，不添加正常创作任务抽屉。
5. 覆盖确认消费后崩溃、TaskStore 已写但关联漏写、提交结果不确定及 MCP 断线；按账本恢复，不重新 POST 上游。

完成门槛：配置成功后能准备图片/视频生成，桌面确认后才创建任务；拒绝/过期/重启/版本变化/confirmed:true 不产生任务；客户端退出不取消已提交任务。fixture 与真实账号生成分列，至少图片/视频各一条真实成功文件与原节点展示证据。

### M5：安装交付与兼容验收

1. 三平台安装包包含专用 stdio 启动器及运行时，含空格路径、不依赖全局 Node；核对 Electron GUI/Node 模式限制，不假设正常应用可执行文件天然就是 stdio server。
2. Codex 与 Claude Code 分别导出可运行配置，记录实际客户端、SDK、协议和安装包版本；再抽测一个标准 MCP 客户端。
3. 配对、撤销、升级、发现文件陈旧、安全存储缺失、连接数/请求上限及应用关闭行为验收。
4. 凭据写入配置恢复和任务恢复各执行故障注入，保留自然语言对话、已脱敏截图和输出证据。

完成门槛：M1–M4 门槛在安装包成立；任一平台或真实厂商未验收时列为缺口，不能用开发目录 smoke 代替交付完成。

## 4. 测试与证据约定

### 2026-10-12 接续实施与验收结果

以下描述当前代码与实际验证，不改变 M1–M5 的完整验收门槛。证据见[最新验收记录](../verification/2026-10-11-mcp-acceptance/README.md)及[初始审查记录](../verification/2026-10-10-desktop-mcp/README.md)。

| 阶段 | 当前结果 | 尚缺证据/能力 |
| --- | --- | --- |
| M1 | SDK stdio、Main 配对/授权/撤销、公开目录、原设置页导出已接通；Codex 实际 CLI 已连接并调用工具 | Claude Code 真实会话按用户最新要求取消本轮验收 |
| M2 | 原工具复用、保存屏障、CAS/幂等、独立画布事件通过回归；SDK 三条一对一连线及 Codex 自然语言 2 节点/1 连线有记录 | 人工并发编辑验收；实际客户端全链路另列 |
| M3 | 图片/视频配置 Main/SDK fixture、env 来源发现、三种输入链路、披露/字段授权、加密事务恢复及 canary 扫描通过；真实 Agnes Key 经授权 sourceRef 写入 Windows safeStorage，清理/扫描通过 | 真实客户端自然语言配置及原选择器人工核对；Agnes 安全鉴权检测明确 unsupported |
| M4 | 原确认组件、任务/幂等通过；真实 Codex 本地文本生成完整回合经审查通过，原始自动记录的末尾撤销 QA 误判保留；真实 Agnes 图片与指定 Flash 视频生成通过，前两次队列 503 保留历史证据；文本分页/多输出及受限媒体读取已实现，真实图片和真实 Flash MP4 的 Main/SDK 字节摘要匹配，原节点视频播放与完整解码通过 | 实际客户端图片/视频自然语言全链路；修正后完整 CLI 脚本未重跑；Claude 真实会话本轮用户取消 |
| M5 | Windows 正式 NSIS 构建与实际静默升级通过，注册核对/9 个关键文件摘要一致；含空格载荷及实际已安装程序验证包内 Node stdio、原生配对、幂等/画布同步、关闭重开保留身份和节点连线 | Windows 手工安装向导页面、卸载及真实客户端包内全链路；macOS/Linux 按用户要求暂不验收 |

桌面组合回归增至 128/128，原 Web 定向测试 15/15，原 Agent 服务定向测试 15/15；Pi 完整 `npm run check` 通过。目录计数（24 提供方、93 模型）仅证明包内资源可读，不代表这些模型全部完成官方账号验收。

- 单元/契约：权限、schema、秘密脱敏、sourceRef、revision、确认失效与错误映射；共享服务同时覆盖原 UI/内置 Agent 回归。
- 集成：真实 Local Core、控制存储、provider-settings 安全存储替身与真实 TaskStore；故障注入验证跨文件配置恢复和任务关联恢复。
- stdio smoke：实际 SDK 客户端初始化/列工具/调用/错误/断线，验证 stdout 只有协议消息。不可只测试直接函数调用。
- UI：原 CanvasPage 未保存编辑、外部事件、配置页状态、原节点生成结果；自然语言请求不注入工具名/内部 ID。
- 真实账号：用户通过授权链路提供 Key，明确供应商费用与发送范围；鉴权和付费生成证据分开，fixture 无真实秘密。
- 证据建议路径：`docs/verification/2026-10-10-desktop-mcp/`，实施时创建；状态表记录场景、平台/客户端版本、命令或操作、结果、文件可读检查及未通过原因。

## 5. 文档与变更边界

设计阶段已新增文档并更新工程契约；用户随后授权实施接口、SDK、原页面适配和安装入口。初始实现 fixture 不使用真实 Key；接续验收经用户明确授权使用 Agnes 图片/视频 Flash 真实账号，视频模型固定使用用户指定的 Flash，未改用收费普通模型。每阶段同步 MCP 规格的数据字典、提供方数据契约、Agent 规格、真实 bridge/IPC 类型和安装说明；新增字段必须有版本升级及回退，完成状态以实际测试证据为准。

后续如需要窗口关闭后的创作、直接 HTTP MCP、公网服务、额外高风险工具或自动生成政策，先更新契约与授权范围。本计划不把既有提供方迁移回归测试数字继承为 MCP 验收结果。
