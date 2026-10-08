# vibepaper-web

VibePaper 前端 MVP 演示（UI 风格对齐 [vibepaper-ai.com](https://vibepaper-ai.com)）。

## 技术栈

React 19 · TypeScript · Vite · Tailwind CSS 4 · React Router · `@xyflow/react` · Zustand · Lucide

## 启动

```bash
pnpm install
pnpm dev
```

默认打开 http://localhost:5173

## MVP 路由

| 路径 | 页面 |
|------|------|
| `/workspace` | 画布管理（管理空间） |
| `/history` | 历史记录 |
| `/gallery` | 创意广场 |
| `/profile` | 个人中心 |
| `/enterprise` | 企业中心（占位） |
| `/canvas/:id` | 无限画布编辑器 + Agent 面板 |

当前为 **Mock 数据 UI 演示**，未接真实 API。设计令牌提取自官网 CSS 变量（`--bg-primary: #f4f5f7`、`--text-primary: #111` 等）。
