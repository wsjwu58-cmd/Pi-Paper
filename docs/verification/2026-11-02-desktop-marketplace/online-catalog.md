# 在线目录验证 · 2026-11-02

## 真实公共来源

在 macOS 开发环境使用 `pi-paper-desktop/scripts/verify-marketplace-online.cjs` 访问 `wsjwu58-cmd/Pi-Paper` 的 `feat/desktop-local-migration`。Git smart-HTTP 公共 refs 返回分支提交 `8c61a80f695ed32e691cd01ee609c2a72cb1cf97`；随后从该提交读取索引及以下两个文件，实际大小、SHA-256、目录元数据和应用版本检查均通过，并导入隔离的临时本地目录：

| 条目 | 类型 | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| `scene-composition` 1.0.0 | 图片预设包 | 1037 | `67a0bfb1e73b3bda87d4067f4ad01b66c6f1db4a64e2b588edc841c3a43f0c98` |
| `pi-storyboard-brief` 1.0.0 | 独立 Pi Skill | 735 | `f579633e03cef1a102aad211361fbb16f320318186e629ebe3c584c526c1ae88` |

替换请求函数为必定失败后，缓存索引和已导入包仍可读取。该脚本没有向项目安装组件或提交生成。GitHub REST 匿名 API 在本次网络出口返回限额错误，因此实现通过固定仓库的 Git smart-HTTP refs 查询分支；下载依旧固定到该提交，不使用 REST 凭据。摘要只证明内容与索引一致，不构成发布者签名。

## 自动测试

`node --test pi-paper-desktop/test/marketplace-online.test.cjs pi-paper-desktop/test/marketplace.test.cjs`：13/13 通过，覆盖在线/离线、固定提交、大小与摘要错误、超限响应、重定向、过期索引、项目 Skill、未信任 Renderer、本地 Skill、陌生组件类型与目标兼容性。前端 `MarketplacePage.test.tsx` 5/5 通过，TypeScript 构建通过。按发布流程单独 bundle Pi Skill 解析模块，确认解析入口可用。

以上是源码和真实公共网络验证；不等同于正式安装包中通过图形界面点击完成的跨平台验收。
