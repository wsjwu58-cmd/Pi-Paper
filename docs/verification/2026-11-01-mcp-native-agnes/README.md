# Codex Terra max 原生 MCP 生成验收（Windows）

全部真实 Codex 媒体验收使用 `gpt-6.1-terra`、`model_reasoning_effort="max"`。这是测试客户端的推理模型；图片与视频任务分别选择 Agnes Image 2.5 Flash 与 Agnes Video 2.5 Flash。不会修改日常 Codex 的默认模型。

[本地原生确认的脱敏记录](terra-max-native-local.json)：确认了独立交互式 Codex CLI 会话实际使用上述模型及推理强度，发现 14 个受限工具，读取画布、模型、目标节点，并发起一次生成提案。MCP stdio 转发器记录到一份表单请求与一份来自该客户端的响应。响应外层的 `action=accept` 只表示客户端交回表单；原提案与审批账本均为 `rejected`，TaskStore 任务数、本地模型生成次数、Agnes 请求数均为零。没有 QA 代答表单，也未观察或记录用户的屏幕；此证据属于交互式 Codex CLI 的拒绝路径。该隔离测试授权和服务已正常关闭。

真实 Agnes 付费回合应分别核对：同一 Codex 会话的 form 请求与回应、原提案提交状态、唯一目标任务、原节点结果、文件及 MCP 预览的长度和 SHA256。直接访问厂商 API、用其他宿主转交表单、仅取得任务 ID 或看到运行中都不算完整通过。历史真实媒体单项证据见[接续记录](../2026-10-11-mcp-acceptance/README.md)。

测试入口位于 `pi-paper-desktop/scripts`。先在本机可交互终端运行 `node prepare-mcp-native-agnes-media.cjs`；提示时使用隐藏输入，勿将 Key 放入命令行或 TOML。拿到 ready.json 后，在另一个可见终端运行：

```text
node start-native-codex-mcp-test.cjs "<本次 run 目录>" "<Codex CLI 可执行文件的绝对路径>" image
```

等图片结果核验后再用同一目录运行 `video`。如果已有任务只运行 `readback`；每个计费阶段都保留一次启动标记以防意外重放。受限工具授权不代替用户在真实 Codex 中填写的当次生成确认。收尾时在本次 run 目录创建 `stop.request` 并核对 result.json 的清理字段。测试不涉及安装或卸载。

本轮图片已通过：[Terra max 会话与文件校验](terra-max-image.json)、[Agnes 生成的 PNG](agnes-flash-image.png)。首次模型回合因客户端工具不足以列举历史任务，在创建节点和提案前停止，见[零提交记录](terra-max-image-first-turn-no-proposal.json)。确认 TaskStore 和提案账本均为空后，验收宿主向新回合提供经核实的前置条件。第二个真实 TUI 回合发起一次原生表单、创建一条任务，图片成功并在原节点显示为 1024×1024；MCP 读回的 PNG、落盘文件、任务摘要三者 SHA256 相同。已独立解码并检查画面确实是白色影棚中的蓝色方块。本轮采用独立 profile 安全存储预置账号，不重复计作自然语言配置实测。

准备阶段使用测试凭据独立验证启动及退出，本次[成功的零任务检查](2026-11-01T10-14-42-999Z-f97fcda5-aa0a-4c1f-9bbe-6a3dee8c91ab.json)与同目录早期启动失败的报告均不计作真实生成。

本轮视频已通过：[原生 Codex 回合](terra-max-video.json)提交一条 4 秒、720P、16:9 请求。Agnes 返回 971,780 字节的 H.264 MP4，1280×720、实际 4.48 秒。原节点起初在视口外，元素已解码；[无 Key 重开检查](native-video-reopen-20261101103245507-47372.json)在同一原节点适应视图后确认视频可见、实际播放呈现 17 帧。Codex 读回、磁盘文件、TaskStore 三者哈希一致，并已全片解码。可查看[视频](agnes-flash-video.mp4)及[综合判定](result.json)。两条任务各执行一次；重开未改变两条任务或九个任务事件。临时凭据已清除，授权已撤销。
