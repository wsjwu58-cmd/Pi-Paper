# 桌面界面语言验收（2026-10-08）

来源：[AppImage PR #9800 的界面语言要求](https://github.com/AppImage/appimage.github.io/pull/9800#issuecomment-6046397629)。实现中文区域默认中文、其余区域默认英文，并增加「跟随系统 / 中文 / English」的持久化选择。

## 实现范围

- 在原前端页面、画布、节点编辑器、Agent、素材、Skill、记忆、导演台和模型配置组件中接入英文词典，原 Web 路径保持中文。
- Renderer 挂载前读取 Main 的系统区域与保存偏好；切换立即更新界面、文档语言与标题。原生对话框的应用标题和提示跟随语言，系统对话框自带按钮由操作系统负责。
- 偏好保存到独立 `ui-settings.json`，使用受限 IPC、枚举校验与原子替换；项目名、节点内容、用户提示词、实际 Agent/供应商回复与业务枚举保持原文。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| TypeScript 与 Vite 生产构建 | 通过 |
| 前端测试（浏览器存储夹具） | 27 个文件、128 项通过 |
| 语言、可信来源、节点导出、项目导航桌面测试 | 18 项通过 |
| Windows Electron，系统区域 `fr` | 默认英文；中文、英文、跟随系统切换通过 |
| 中文手动偏好，非中文区域重启 | 保留中文，见 `restart.json` |
| 原生项目选择标题 | 英文与中文均通过 |
| 用户中文项目名和节点正文 | 未改变，通过真实本地项目读取确认 |
| Linux 区域优先级 | 单元测试覆盖 `LC_ALL / LC_MESSAGES / LANG` 及回退 |

Electron smoke 使用仓库 `.test-temp/ui-language-smoke-profile` 隔离目录，创建两个真实本地节点，未读写真实用户配置和 Key；没有调用模型。报告见 [smoke.json](smoke.json)、[restart.json](restart.json)。截图覆盖画布展示、历史记录、配置、画布、Agent 和素材入口。

### 复现

从仓库根目录执行（已有依赖与 Pi 构建产物）：

```powershell
npm --prefix pi-paper-web run build
node --test --test-isolation=none pi-paper-desktop/test/ui-language.test.cjs pi-paper-desktop/test/renderer-trust.test.cjs pi-paper-desktop/test/node-export.test.cjs pi-paper-desktop/test/project-navigation.test.cjs
& ./pi-paper-desktop/node_modules/.bin/electron.cmd ./pi-paper-desktop/scripts/smoke-ui-language.cjs
& ./pi-paper-desktop/node_modules/.bin/electron.cmd ./pi-paper-desktop/scripts/smoke-ui-language.cjs --resume
```

macOS/Linux 对应使用 `./pi-paper-desktop/node_modules/.bin/electron`。Electron 脚本最终结果以报告中的 `success` 为准；`--resume` 必须在首次 smoke 成功之后单独运行。

本机 Node 25 的 Web Storage 与原 `nodeDownloads.test.ts` 测试环境冲突，直接运行全套 Vitest 会在该文件加载时遇到 `localStorage.getItem is not a function`。完整 128 项验证为 Vitest 增加临时 `setupFiles`，替代 Node 原生 Web Storage；未修改产品代码或该既有测试。仓库根目录 `.test-temp/i18n/storage-setup.ts` 夹具为：

```ts
import { vi } from '../../pi-paper-web/node_modules/vitest/dist/index.js'
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
```

`pi-paper-web/.test-temp/vitest-ui-language.config.mts` 合并原配置：

```ts
import { defineConfig, mergeConfig } from 'vite'
import config from '../vite.config.ts'
export default mergeConfig(config, defineConfig({ test: { setupFiles: ['../.test-temp/i18n/storage-setup.ts'] } }))
```

运行 `npm --prefix pi-paper-web run test -- --config .test-temp/vitest-ui-language.config.mts`。临时夹具仅用于这次本机测试，不属于产品配置。

## 截图与边界

![英文画布展示](workspace-en.png)
![中文画布展示](workspace-zh.png)
![英文模型配置](providers-en.png)
![英文 Agent 面板](agent-en.png)
![英文素材库](assets-en.png)

其他截图：[英文历史记录](history-en.png)、[英文画布](canvas-en.png)、[中文偏好重启](workspace-zh-after-restart.png)。此次验证运行于 Windows，未构建或发布新的 AppImage，也未完成 Linux/macOS 安装包的实际系统区域验收。外部内容、供应商原始错误、用户 Skill 与 Agent 输出不做自动翻译。
