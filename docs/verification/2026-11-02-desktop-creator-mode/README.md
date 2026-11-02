# 桌面创造模式：本地验收记录

工作树以 `27da747` 为基线。以下是 macOS 开发机上对桌面打包载荷和原前端的验证，不代表三个平台的安装包均已验收。

| 场景 | 操作与结果 |
| --- | --- |
| Agent 制作并使用模板 | 在隔离项目中从 Renderer 桥发送自然语言：“做一个商品三视图插件，分别写好正面、侧面和背面的拍摄要求，保存下来，在当前画布用一次。” 使用打包的 Worker、真实 Electron Main、Local Core 和原画布；文本供应商由本机回环 fixture 代替。断言落盘及可见节点均为 6，三条边的六个端点互不重复，任务数为 0。见[画布截图](creator-canvas.jpg)。 |
| 项目节点与命令 | 在原市场和画布测试自定义节点、基础节点菜单显隐、选区排列、分镜表预览和兼容模型查询。见[节点截图](creator-node.jpg)。原市场 smoke 也通过，应用预设、素材和模板不新增生成任务。 |
| 安装与恢复 | 覆盖保存版本、安装、启停、应用分开记账，重复请求、版本冲突、备份恢复、预设目标校验和撤销。评审发现安装时 Main 向正在执行工具的 Worker 反查 Skill 导致互等；改由宿主在本地检查冲突，上述跨进程用例已通过。 |
| Skill 和角色 | 验证 23 个官方 Skill 沿用原 key、2 个核心项不可停用、项目启停影响后续发现与加载；覆盖同名冲突、历史快照、会话角色工具交集和续接权限。 |

**回归结果**

- `pi-paper-web`：Vitest 37 个文件、183 项通过；lint 无错误，仍有警告。
- `pi-main`：运行 `npm run check`；Agent 会话、角色、Skill 和运行事件的 5 个测试文件共 41 项通过。
- `pi-paper-desktop`：使用相同 Node 运行时与本机回环权限执行 `node --test test/*.test.cjs`。改动前 524 项（495 通过、24 失败、5 跳过）；改动后 557 项（528 通过、24 失败、5 跳过）。按测试名称比较，失败集合一致。桌面全量测试未全绿。
- 打包后在 `pi-paper-desktop` 目录通过 Electron 运行 `scripts/smoke-creator-agent.cjs --staged`、`scripts/smoke-creator-commands.cjs --staged` 和原 `scripts/smoke-marketplace.cjs --staged`。前两项可分别用 `--screenshot=<文件>`、`--evidence=<目录>` 保存现场。

本次没有使用真实云端账号验证模型能否自主编排或完成付费生成，也没有重验 Windows/Linux 安装包、macOS 安装向导或外部 MCP 客户端。回环 fixture 验证宿主执行链路；不能作为真实供应商效果或端到端安装验收。
