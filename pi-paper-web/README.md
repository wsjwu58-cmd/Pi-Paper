# Pi-Paper Web / Renderer

Pi-Paper 原前端页面与组件源码，使用 React 19、TypeScript、Vite、Tailwind CSS 4、React Router、`@xyflow/react`、Zustand 和 Lucide。目录由 `vibepaper-web` 更名为 `pi-paper-web`；原画布、节点编辑器、素材与 Agent 面板在此接入桌面本地适配，不另建平行简化 UI。

## 当前运行方式

默认分支是 `feat/desktop-local-migration`。正常创作由 [`pi-paper-desktop`](../pi-paper-desktop/README.md) 的 Electron Main、受限 IPC、本地核心和独立 Agent Worker 提供能力。从仓库根目录执行：

```bash
pnpm --dir pi-paper-web install --frozen-lockfile
npm --prefix pi-paper-desktop ci
npm --prefix pi-paper-desktop run dev
```

完整 Pi 依赖和模型目录准备见[根 README](../README.md)。开发模式会启动 Vite 并打开 Electron。单独执行 `pnpm dev` 或打开 `http://127.0.0.1:5173` 只能访问前端开发服务器，浏览器没有 Electron 项目桥接，不能作为完整桌面部署。

需要浏览器访问当前桌面应用时，使用 [Docker/noVNC 部署](../docker/README.md)。它运行同一套 Electron 和原页面，浏览器负责远程桌面传输。

## 构建与检查

```bash
pnpm --dir pi-paper-web build
pnpm --dir pi-paper-web lint
pnpm --dir pi-paper-web test
```

桌面打包会把 Vite 产物放入安装包的 `renderer/`。开发与安装包行为都以[桌面工程契约](../AGENTS.md)和[UI 对照规格](../docs/specs/desktop-ui-parity.md)为准。

## 桌面入口

| 路径 | 用途 |
| --- | --- |
| `/workspace` | 画布展示、打开或新建本地项目 |
| `/history` | 本地真实任务历史 |
| `/settings/providers` | 官方提供方配置与模型绑定 |
| `/canvas/:id` | 原画布、节点编辑器与 Agent 面板 |

历史 Web 版的用户、企业、点数、创意广场等源码仍可能保留，用于迁移对照；不属于桌面导航或运行链路。当前前端不是 Mock UI 演示，已接入能力及剩余验收缺口见根 README 和桌面规格。
