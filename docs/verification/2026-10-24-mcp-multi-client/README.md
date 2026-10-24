# 2026-10-24 多客户端 MCP 接入验收

本轮扩展 Codex、Claude Code、Cursor、WorkBuddy、TRAE 的独立授权与配置导出。配置导出和协议兼容不等于各客户端的自然语言全链路通过。历史官方媒体结果见 [10-11 接续记录](../2026-10-11-mcp-acceptance/README.md)。

## 已完成

- [协议、安全、媒体恢复回归](protocol-security-regression-20261024.json)：21 文件、195/195 通过，零跳过；无真实提供方调用。普通沙箱的子进程限制失败原样保留，允许本地子进程后通过。后续重点复核 stdio 29 项和 Main 31 项均通过，属于上述覆盖，不叠加计数。
- 前端 MCP 授权/配置选择 6/6 通过；TypeScript、Vite、Worker 构建及 Worker Skill/片段重启检查通过。
- Windows 最新解包载荷通过包内 MCP Node 入口、24 提供方/93 模型目录、SQLite 画布持久化与 Worker 重启检查。未安装、升级或卸载日常应用，已安装旧版本不因源码更新自动更新。
- 修复空 `elicitation: {}` 被误拒绝的问题。依 [MCP 规范](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)，它等价于仅表单能力；显式 form 与 URL 同时声明也支持。无能力或仅 URL 的客户端仍在创建提案前拒绝。使用公开 SDK request/result schema，未修改依赖或代答表单。
- [透明观察器 fixture](observer-sdk-transparent-stdio-20261024.json)：实际 SDK stdio 转发、3 MiB 输入输出、取消表单、错误和异常退出。它是本地 fixture，不是下表的真实客户端。

## 真实客户端状态

本轮连接原 Main 和原 CanvasPage 的隔离项目。透明观察器只转发消息；不回答表单，不记录参数、返回正文、提示词或环境值。通过初始化与非空受限 tools/list 证明连接和工具发现，不能据此证明模型调用工具或用户看到确认。

| 客户端 | 实测 | 尚缺 |
| --- | --- | --- |
| Claude Code 2.1.170 | 隔离配置的 `claude mcp list` 返回连接成功；实际初始化、14 个工具；声明兼容空 elicitation | 原生表单及真实模型回合；先前用户取消的账号会话不冒充通过 |
| Cursor 3.15.6 | 实际 Cursor MCP 进程初始化、14 个工具；声明 form | 自然语言工具调用及原生确认；已请求用户在原生表单拒绝本地测试提案 |
| TRAE CN 3.3.94（协议 clientVersion 1.107.1） | 实际初始化、14 个工具；未声明 elicitation | 普通自然语言回合；当前客户端无法满足生成确认契约，生成必须拒绝 |
| WorkBuddy 5.5.6 | 配置导出及 fixture 通过；临时配置已准备 | 尚无实际 MCP 握手记录；窗口工具反复报告最小化/状态冲突，不能计为连接或确认成功 |
| Codex | 历史真实 get_context 已通过，见前轮记录 | 当前桌面原生表单；QA 宿主转交确认仍不算原生弹窗 |

真实连接的脱敏证据见 `real-client-connections-20261024.json`。客户端版本由本机 CLI/应用元数据核对；对端 `clientInfo` 本身不承担身份认证。

## 未完成的交付门槛

原生客户端确认、当前完整视频 MCP 回合、WorkBuddy 实际连接、跨客户端媒体展示仍未全部通过。已成功的 Agnes 官方图片/Flash 视频及实际文件读取证据继续有效，但不能填补这些缺口。macOS/Linux 无测试机器，仍未验收；用户要求不重复安装/卸载，本轮保留历史安装生命周期结论。任何上述缺口都不因本轮配置代码和单元测试通过而改标成功。

临时客户端配置仅访问隔离画布，无 Key；验收结束须移除本轮新增项，撤销测试授权。清理状态后续单独记录，不能预先宣称完成。
