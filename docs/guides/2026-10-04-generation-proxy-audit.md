# 生成节点代理链路检查（2026-10-04）

本轮检查基于已修复的 Agent Worker 与 Generation Worker。当前 Windows 使用静态 HTTP 系统代理。没有读取账号 Key，没有提交新的真实生成任务。

| 链路 | 网络实现 | 检查结果 |
| --- | --- | --- |
| Agent 文本、摘要、自动续接 | Agent Worker 的 Pi 请求，Node fetch | 启动时统一初始化代理 |
| Text、Image、Video、Audio 云端生成 | Generation Worker、原 Pi 官方适配，Node fetch/http/https | 共用已修复的代理初始化 |
| 视频提交、轮询、恢复及媒体下载 | 同一 Generation Worker；Pi officialFetch 与旧 Agnes https.get | 保持代理；不会因检查而重提已提交任务 |
| 本地模型 | loopback HTTP | NO_PROXY 保留 localhost、127.0.0.1 和 IPv6 loopback |
| Compose、裁剪、三视图、视频处理、SAPI 语音 | 本机 FFmpeg/系统进程及本地文件 | 这些已实现路径不依赖云端代理 |
| DirectorStage、Stack、Group、Document | 原本地画布功能 | 不调用生成模型 |

代码检查没有发现其他创建独立云端生成进程、覆盖网络 dispatcher 或显式绕开共享代理的路径。MiniMax 的查询包装器保留全局 fetch；提交、查询和结果读取都运行在同一 Worker。旧 Agnes 下载使用 Node 原生 HTTPS，代理初始化同时覆盖该网络栈，保留既有地址与重定向检查。

真实 Electron Generation Worker 的无 Key GET 检查覆盖目录中 17 个官方域名。16 个基础路径收到 HTTP 响应（200/401/404）；MiniMax `/anthropic` 基础路径返回重定向，按禁止重定向策略报 `unexpected redirect`，属于路径探测限制。单独请求 MiniMax `/v1/files/list` 收到 200，证明其网络链路可达。另对 OpenAI、方舟、ElevenLabs、Kling、xAI、Google 的模型/鉴权相关路径收到 HTTP 响应。Node 原生 `https.get` 到 OpenAI 返回 401。此证据证明网络请求可到达 HTTP 层，不代表任何账号权限、模型能力或付费生成成功。

定向回归 32/32 通过，覆盖文本、图片、视频、Fish/Doubao 音频、媒体结果落盘、本地处理及代理配置。新增本地模拟代理测试覆盖 POST 提交、GET 轮询、二进制下载、Node 原生请求和 loopback 绕过代理；同时兼容 CONNECT 隧道。修正 Kling 集成测试 fixture：只传当前 API Key，避免与旧版 AK/SK 混用；不改变产品鉴权规则。

本轮未发现新的运行时代理遗漏，因此没有增加额外运行依赖或修改代理路由。按域名变化的 PAC、SOCKS 和运行中热切换仍按数据契约列为未完整支持，不能由本轮静态代理测试宣称完成。
