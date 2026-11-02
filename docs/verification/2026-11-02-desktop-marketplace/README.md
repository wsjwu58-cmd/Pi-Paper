# 桌面插件市场首期验证

2026-11-02，在 macOS ARM64 上使用隔离项目和用户配置进行验证。首期目录随应用交付，也支持本地 JSON 包。Windows、Linux 正式安装包、远程市场及付费生成待另行验收。

| 验证入口 | 观察到的结果 |
| --- | --- |
| TypeScript、完整前端 Vitest、Vite | 编译和生产构建成功。Node 24 开启 Web Storage 并使用临时文件后，32 个测试文件、158 项用例通过。 |
| 市场服务、原项目 Skill、路由测试 | 12 项通过。覆盖选装、停用、升级冲突、回退、保留用户启停及卸载选择、导入校验、项目隔离、真实素材入库与备份恢复。 |
| 画布集成 | 同一模板插入两次后为 14 个节点、12 条边，两次插入之间没有交叉引用。幂等重放不会重复增加节点，过期版本无法覆盖画布。 |
| macOS Electron 桌面流程 | 从工作区打开插件市场，安装四类棚拍组件。从原 Agent 服务读到已启用的商品棚拍 Skill。通过画布工具插入 7 个节点、6 条有效连线，将背景素材添加到画布，向选中图片节点应用提示词预设。重载后共 8 个节点可读，生成任务数为 0。 |
| 打包载荷 | build-package 成功生成独立应用目录，Agent Worker 重启测试通过。使用随项目的 Electron 加载该目录复验上述市场流程。这一步验证安装载荷，不代表安装向导、签名或升级流程通过。 |

![隔离项目中的商品棚拍组件选择页](marketplace.png)

复现时在仓库根目录运行：

```sh
node pi-paper-desktop/scripts/build-package.cjs
node --test pi-paper-desktop/test/marketplace.test.cjs pi-paper-desktop/test/project-agent-skills.test.cjs pi-paper-desktop/test/renderer-trust.test.cjs
node pi-paper-desktop/node_modules/electron/cli.js pi-paper-desktop/scripts/smoke-marketplace.cjs --staged
```

存量测试限制：另跑 project-navigation.test.cjs 时，三项用例在旧 Electron mock 的 app.commandLine.getSwitchValue 处中止。此次市场交付对真实 Electron 使用上述独立项目完成了导航验证。
