# Pi Agent 全链路验证实现报告（2026-08-29）

## 已交付

- 真实 Agent API 多轮评测客户端、确认提交、SSE 解析、resume 和证据脱敏。
- 评测 Schema 与覆盖缺口门禁；声明的 node/media/task/event/lineage/error 未满足时用例失败。
- 图片、视频、音频和通用媒体探针；当前无真实媒体，所有 `media-probe.json` 明确记录 `not_run`。
- 16 个结构化用例，覆盖完整短剧约束（15 个 4 秒镜头）、导演台、关键帧、派生、音频/字幕、Skill、幂等/并发和供应商故障边界。
- 7 个缺失的垂直创作 Skill 及可重复生成 manifest。
- 旧数据库迁移兼容、Skill bootstrap 参数类型修复、SSE request ID 透传。
- Agnes 三模型配置：`agnes-2.5-flash`、`agnes-image-2.1-flash`、`agnes-video-2.5-flash`；评测夹具 Canvas 版本同步、种子节点、嵌套工具断言和旧 `agent_actions.estimated_cost` 迁移兼容。

## 验证命令与结果

```text
cd E:\VibePaperProject\pi-main
node ..\..\node_modules\vitest\dist\cli.js --run
```

结果：47 个测试文件、121 个测试通过。

```text
cd E:\VibePaperProject\generation-service
uv run --python .venv\Scripts\python.exe --with pytest pytest -q
```

结果：11 个测试通过。

```text
npm run build --workspace=@vibepaper/pi-agent-service
cd E:\VibePaperProject\pi-paper-web
pnpm test
pnpm build
pwsh -File E:\VibePaperProject\scripts\e2e\check-evidence.ps1 -Root E:\VibePaperProject\output\evals\2026-08-29
```

结果：Agent 构建、Web 3 个测试文件/6 个测试、Web 构建、证据校验均通过。真实 Agnes 评测中资产只读用例已通过；商品视觉单任务曾真实取得 `succeeded`、JPEG 输出及 freeze→settle→unfreeze_settle 账本闭环，但完整长链最新重试在首轮 Agnes 文本阶段被有限窗口中止，关键帧长链未取得终态，因此没有伪造为通过。浏览器已在 `5173` 完成真实注册和画布编辑器截图，证据位于 `output/evals/2026-08-29-browser-evidence/screenshots/`。证据目录中仍有历史 `MODEL_UNAVAILABLE` 与 `blocked_external` 结果，阅读时需以运行时间和本 bugfix 记录为准。

## 主要残余风险

即使已配置 Agnes key，长链未取得稳定终态时，也不能把确认阈值、generation-service、点数冻结结算和媒体质量判定当作已验证。尤其是完整短剧必须以最终 15 镜成片为准，三镜诊断或“返回脚本”不能计入通过。
