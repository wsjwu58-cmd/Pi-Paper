# 桌面 MCP 实现与审查记录

日期：2026-10-10；接续审查：2026-10-11。状态：**开发链路已实现，独立回归与隔离桌面联调通过；完整产品验收尚未完成。**

本文保留初始开发/fixture 证据。2026-10-12 的媒体读取、真实 Agnes 账号、真实 CLI 与 Windows 最终包状态以[后续验收记录](../2026-10-11-mcp-acceptance/README.md)为准；初始 119 项计数不与后续 128 项叠加。

用户授权 Luna（max）子 Agent 实现，主 Agent负责集成、独立审查和验证。范围以 [MCP 功能规格](../../specs/desktop-mcp-functional-spec.md)、[实施计划](../../plans/2026-10-10-desktop-mcp-implementation-plan.md) 和 [使用指南](../../guides/desktop-mcp.md) 为准。

## 实现与分工

| 工作 | 实现责任 | 审查重点 |
| --- | --- | --- |
| Main、共享 TypeScript 命令、确认、项目账本 | MCP 核心子 Agent | 可信身份、授权、CAS、幂等、持久化提案与权威任务 |
| stdio、提供方配置、凭据事务和恢复 | 桥接/提供方子 Agent | 标准 SDK、来源发现、字段授权、披露、只写凭据、无秘密泄漏 |
| 原页面、Preload、画布同步与打包入口 | UI 子 Agent | 原 CanvasPage/AgentPanel/配置页适配、保存屏障、配置刷新和草稿保护 |
| 集成与独立验证 | 主 Agent | 真实接口与 DTO、一致性、失败回归、SDK 及实际 Electron 链路 |

工作区已有大量用户修改，本轮未重置、暂存、提交或清理其他工作。审查基线副本及隔离测试 profile 在本机 `.test-temp`，不是产品数据或交付内容。Pi 格式化检查前保存工作区快照，检查后恢复无关格式变化，保留 MCP 增量。

实现包含桌面启用/逐客户端授权/撤销、短码配对、导出 Codex TOML 与 Claude Code JSON、独立 stdio 入口、loopback 私有鉴权、原工具复用、画布版本与保存屏障、外部事件、配置三种输入来源、加密凭据跨文件恢复、系统生成确认及 TaskStore 查询。普通工具调用不创建内置 Agent 会话，也不调用内置文本模型。每个新桥接进程批准一次连接，存活连接内不逐次批准工具；配置披露与生成确认仍是独立边界。

## 主 Agent 最终验证

| 验证 | 结果 | 证据/范围 |
| --- | --- | --- |
| 桌面 Node 组合回归 | 119/119，0 失败、0 跳过 | [命令和计数](module-review-2026-10-11.json)、[完整日志](module-review.log)；SDK、Main、原 TypeScript runtime、提供方事务、Worker 恢复、真实任务 DTO 与 Renderer 信任边界 |
| 原 Web 定向测试 | 15/15，3 文件 | canvasPersistence、providerConfigurationEvents、i18n；保存屏障、配置事件和原页面文案 |
| 原 Agent 服务定向测试 | 15/15，3 文件 | desktop-canvas-tools、desktop-agent-store-migration、generation-tools；原服务适配、控制库升级及生成工具 |
| Pi 完整工程检查 | 通过 | [pi-check.log](pi-check.log)；Biome、固定依赖、导入、锁文件、TypeScript 及 browser smoke |
| 桌面 build:package | 通过 | [package-build.log](package-build.log)；原 Renderer、Agent Worker 与独立 SDK bundle 构建 |
| dist/app 暂存目录 smoke | 通过 | [package-smoke.log](package-smoke.log)；独立内置 Node 入口、SDK 本地 fixture、资源及 SQLite 关闭/重启持久化 |
| 隔离实际 Electron + SDK stdio + 原画布 | 通过 | [integration.json](integration.json)、原页面截图；详细链路见下文 |

定向测试命令（在各自目录运行）：

```text
vibepaper-web:
node node_modules/vitest/vitest.mjs run src/features/canvas/canvasPersistence.test.ts src/features/providers/providerConfigurationEvents.test.ts src/lib/i18n.test.ts

pi-main/packages/vibepaper-agent-service:
node ../../node_modules/vitest/dist/cli.js --run test/desktop-canvas-tools.test.ts test/desktop-agent-store-migration.test.ts test/generation-tools.test.ts

pi-main:
npm run check

vibepaper-desktop:
npm run build:package
node scripts/smoke-package.cjs dist/app
```

暂存资源目录可读的 24 提供方、93 模型是打包资源计数，不代表全部适配或官方账号已验收。构建仍有原有 Vite 大 chunk 和 Pi CJS import.meta 提示；构建成功不等于没有警告。暂存目录 smoke 未运行正式安装器，不证明三个平台已安装应用及 fuse 可用。

## 实际桌面联调

使用 `vibepaper-desktop/scripts/smoke-mcp-integration.cjs` 启动隔离 Electron 实例；先覆盖用户数据路径，再加载 Main。不会打开真实桌面 profile、用户项目或真实凭据。连接批准由测试替身完成，系统生成确认通过原 Renderer 确认卡点击；模型为本机 HTTP fixture，不访问云端。

1. 从原画布入口打开本地项目，经真实 Renderer IPC 配置本地文本绑定。
2. 进入原 MCP 设置页，启用、创建授权、接受外部读取披露并取得实际导出的 Claude Code JSON。SDK 客户端按该配置启动桥接，而非手写私有 bootstrap。
3. 使用官方 `@modelcontextprotocol/sdk@1.32.1` 建立 stdio 连接、列工具并读取授权上下文。只读配置授权的来源/字段/输入方式数组为空。
4. 创建六个图片节点，精确重放不重复；建立三条显式一对一连线。原画布显示七个总节点、三条边，保存屏障释放。
5. 为原有文本节点准备生成，等待确认期间模型请求为零；点击原 AgentPanel 的外部生成确认卡后创建持久化任务。
6. 任务成功，读取文本输出，原节点显示结果；同一提案重放仍只有一次本地模型请求。撤销连接后请求被拒绝。

最终记录：`success=true`、`exportedConfigurationUsed=true`、`oneToOneEdges=3`、`localModelRequests=1`、`taskStatus=succeeded`、`realCloudProviderRequests=0`。开发实例实际生成的是本地文本 fixture，不能替代官方图片/视频生成。

截图：

- [原 MCP 设置及客户端配置](original-mcp-settings-and-client-config.png)
- [生成前的原确认卡](generation-before-confirmation.png)
- [原节点展示生成结果](generation-result-on-original-canvas.png)

`integration-failure.json` 保留的是修复前失败诊断；当前结果以 `integration.json` 和上述最终截图为准。早期 `directed-tests.json` 与 `runtime-probe.json` 是历史模块/运行时证据，不与最新 119 项计数叠加。

## 独立审查发现与修复

- 修复提供方 clear 后旧凭据复活、revision 不一致及第二次 snapshot 为空；补 tombstone、schema 迁移备份、加密 stage/rollback 和重启保存回归。
- 提交秘密前复查 live grant、字段、来源、披露和 revision；inline 先进行无秘密预检，再读取输入。秘密不写普通账本、JSONL、配置导出、日志或错误正文。
- env 来源引用原先无法经公共工具发现，现由授权厂商目录返回不含值的 metadata；stdio 脱敏保留精确 schema 内的来源引用，拒绝注入 value。Main/SDK 图片和视频配置 fixture 包含 env、inline、原配置页路径及 canary 扫描；加密存储使用受控替身，非真实账号验收。
- 修复保存屏障 requestId、失败/取消解锁、过期 CAS、旧操作重放和画布事件；拒绝未知字段、私有方法与伪造确认。部分批量结果保留已完成节点/任务关联，不盲重放不确定提交。
- 修复离开画布后独立提供方读取被拒绝、原 MCP 设置路由丢失 Renderer 信任及超时配对延迟生成 token；撤销/Origin/无效 bearer 保持拒绝。
- 修复外部配置事件刷新和原配置页草稿覆盖；保留用户输入秘密与旧 draft revision，提交时让并发冲突可见。
- 实际联调发现本地模型被官方厂商白名单误拒绝，以及任务读取错误要求真实 DTO 不提供的 projectId；已修复，并分别新增真实 Main 回归。存在冲突项目身份或跨画布任务仍拒绝。
- 稳定错误码优先取受限 error.code，不回传原异常正文；操作效果 completed 与独立 taskStatus 分开，不被任务状态覆盖。
- Windows GUI 可执行文件不能直接当作普通 stdio 入口，改用包内独立 Node entry、`ELECTRON_RUN_AS_NODE=1` 和 SDK bundle；安装配置显式保留 runAsNode fuse，正式安装应用的行为仍待验证。

## 未完成的产品验收与接口缺口

- Codex CLI 0.154.0、Claude Code 2.1.170 已开展真实自然语言调用；模型 turn、桌面配对和工具调用分别计数，当前最终状态见后续记录。查询版本或 SDK fixture 不计完整工具会话通过。
- 用户授权的真实 Agnes 图片生成、原节点展示及媒体摘要验证已通过；Flash 视频前两次被官方创建队列以 HTTP 503 拒绝，10-13 同一模型/参数的第三次生成成功并保存真实 MP4。安全鉴权检测明确 unsupported，未改用其他模型。保存、鉴权和生成分别判定。
- Windows 正式 NSIS 已构建；最终提取载荷及实际静默升级后的包内 stdio/runAsNode、含空格路径、原生配对、原画布写入和关闭重开已通过。注册项核对与关键文件摘要一致；手工安装向导页面及卸载未验收。真实账号凭据使用 Windows safeStorage，测试完成已清除。macOS/Linux 按用户要求本轮暂不测试。
- 已补齐文本分页、输出索引 0–3 及受限图片/视频读取，并通过 128 项组合回归；真实图片、真实 Flash 视频和早期本地 MP4 的 Main/SDK 字节读取通过。真实 Flash 原节点播放与全片解码通过。图片 4 MiB、视频 8 MiB，大视频流式传输不在首期。
- 超过 20 节点批量创建、删除/清空等高风险工具未向 MCP 开放；不提供无界面后台创作、远程公网服务、自动生成批准或持久自动配对。
- 真实客户端人工并发编辑、原模型选择器核对和完整自然语言验收还需补充；回归和隔离 UI smoke 不替代这些记录。

以上未验收项不影响记录开发链路通过，也不能被构建或 fixture 结果宣称为完整交付。
