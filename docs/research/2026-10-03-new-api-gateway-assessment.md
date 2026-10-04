# New API 对 VibePaper 的适用性评估

日期：2026-10-03。仅文档与源码研究，未部署、未使用真实 Key 调用。New API 主仓库研究快照：`1a4166d8e8ba9802d2ca56fe8ecf0ed5404e80d5`；发布页最新条目为 `v1.0.0-rc.41`。插件按版本路径核对，不能把 main 的全部功能视为旧稳定版本能力。

## 判断

New API 可作为用户自行部署的可选网关，且其官方任务插件对本项目需要的国产图片、视频覆盖值得优先验证。桌面版默认内置仍建议保留本地 Registry 和官方直连：网关任务、渠道凭据、后台账户与定价设置，会增加单用户桌面运行及配置负担。此建议并不代表 New API 必须依赖 Docker、Redis 或外部数据库；其支持 SQLite，Redis 可选。

## 与原清单相关的源码证据

| 插件 | 已声明目标型号／能力 | 尚不能据此确认 |
| --- | --- | --- |
| doubao 1.2.1 | Seedance 2.0、Fast、Mini、2.5、1.5 Pro；Seedream 5.0、5.0 Pro；声明 OpenAI Video 和 Images；Bearer 官方凭据 | BytePlus 区域路径、全部首尾帧及参考音视频参数需逐项验收 |
| alibaba 1.4.1 | Wan 2.7／3.0 视频；Wan 2.7 Image Pro、Qwen Image Edit Plus、Z-Image Turbo；声明 OpenAI Video／Images | 所有扩图、编辑参数及账户权限 |
| hailuo 1.2.0 | MiniMax H3、Hailuo 2.3 Fast；H3 多模态参考；使用官方视频接口 | H3 Local、MiniMax Music 与全部音频模型 |
| google 1.0.2 | Veo 3.1 preview、fast preview | 清单中的 Veo 3.1 Lite 尚无目录证据 |
| kling 1.1.0 | 官方 Access Key／Secret Key 签 JWT；目录示例 v1、v1.6、v2-master | Kling V3／3.0 Omni：不可仅改模型名宣称全功能支持 |
| vidu 1.0.2 | 官方 Token；目录示例 Q2、Q1、2.0、1.5 | Vidu Q3 Pro 的参数与操作 |

PixVerse、Grok 视频、Agnes、Happyhorse 等未在本次官方插件索引中发现对应专用插件；不将其判为不可扩展，但保留官方适配任务。音频应继续逐项区分 TTS、变声、音乐、克隆和声音设计，OpenAI Audio 路径不是完整覆盖证据。Midjourney Proxy、SunoAPI 的存在也不表示使用对应品牌官方 Key。

来源：[官方插件索引](https://github.com/QuantumNous/new-api-plugins/blob/main/index.json)、[豆包插件](https://github.com/QuantumNous/new-api-plugins/blob/main/plugins/tasks/doubao/1.2.1/plugin.js)、[阿里插件](https://github.com/QuantumNous/new-api-plugins/blob/main/plugins/tasks/alibaba/1.4.1/plugin.js)、[海螺插件](https://github.com/QuantumNous/new-api-plugins/blob/main/plugins/tasks/hailuo/1.2.0/plugin.js)、[可灵插件](https://github.com/QuantumNous/new-api-plugins/blob/main/plugins/tasks/kling/1.1.0/plugin.js)、[Vidu 插件](https://github.com/QuantumNous/new-api-plugins/blob/main/plugins/tasks/vidu/1.0.2/plugin.js)。

## 建议接入边界

- 用户已有或自部署网关：VibePaper 配置网关 Base URL 与实例调用 Key，上游官方 Key 由网关管理员配置。不能声称网关连接 Key 就是厂商 Key。
- 本地 TaskStore 创建任务；网关返回的任务 ID 仅作上游关联。查询、重启恢复和结果下载继续由本地任务链路管理，结果落盘可读后才成功。
- 模型目录按品牌分组，同时记录真实网关与上游连接；`/v1/models` 不能单独提供首尾帧、扩图、参考图上限等完整能力契约。
- 固定网关版本及插件版本后验收。视频 POST 提交重试必须验证幂等，不直接沿用文本故障重试导致重复付费；不自动跨供应商切换。
- 保留官方直连以及 Agnes、本地模型连接。没有网关也能使用桌面应用。
- 不首期同时串联 LiteLLM 和 New API；网关连接由受控进程直接调用已验证的协议。

## 桌面内置评估门槛

New API 是完整服务，包括用户、渠道、日志、用量、定价和任务体系；内置需额外处理进程启动、loopback 认证、端口、更新、插件安装、数据库备份及凭据存储。官方发布工作流可见 Linux／Windows 构建，macOS 打包能力需另行验证。系统凭据库要求仍以本项目契约为准，不能未经审查将官方 Key 复制到网关普通数据库。

主仓库采用 AGPL-3.0，官方插件仓库采用 Apache-2.0；如果计划修改并随闭源桌面安装包分发，需先确认具体许可证义务，不由本研究作法律结论。

来源：[项目 README](https://github.com/QuantumNous/new-api/blob/main/README.md)、[发布记录](https://github.com/QuantumNous/new-api/releases)、[构建工作流](https://github.com/QuantumNous/new-api/blob/main/.github/workflows/release.yml)、[主仓库许可证](https://github.com/QuantumNous/new-api/blob/main/LICENSE)、[插件仓库](https://github.com/QuantumNous/new-api-plugins)。

推荐第一条验证链路：网关官方 Ark Key → Seedance 2.5 文生视频／首尾帧 → 本地任务恢复 → 结果落盘；其次 Seedream 5.0 Pro 编辑、Wan 视频及 MiniMax H3。验证通过后再决定它是可选连接还是值得投入桌面内置改造。
