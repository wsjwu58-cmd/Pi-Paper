# Windows 验收安装器

安装器保留在本机，未提交二进制或发布 GitHub Release。以下路径以仓库根目录为基准，文件摘要用于识别实际验收载荷。

| 构建 | 本机文件 | SHA256 | 证据 |
| --- | --- | --- | --- |
| 2026-10-19，产品源码 `934862b` | `output/mcp-windows-2026-10-19/Pi-Paper-0.1.0-win-x64.exe` | `88a2f0384460ce537a0d22b58ca0eb36e215419708fb33053e579b74e40de336` | [构建及包内检查](windows-build-20261019-rate-model-fix.json)、[升级及正常关闭重开](windows-installed-runtime-20261019.json)；120,400,704 bytes，含独立限流和生成模型字段说明 |
| 2026-10-17，正式配置，产品源码 `a4ac061` | `output/mcp-windows-2026-10-17/Pi-Paper-0.1.0-win-x64.exe` | `89c81eefa757a6dedec351d781ad27d0c7d596fbd74089ae5f8041c1e34d380f` | [构建](windows-build-20261017-client-confirmation.json)、[正常启动重开](windows-installed-runtime-20261018.json)；120,400,523 bytes |
| 2026-10-17，显式开启卸载诊断，产品源码 `a4ac061` | `output/mcp-windows-2026-10-17-diagnostics/Pi-Paper-0.1.0-win-x64.exe` | `909be7a876fafc12ed2328b456f6f0d77b503f7b7bf2d89c30581628a09a073b` | [安装及卸载清理](windows-manual-20261017-client-confirmation.json)；120,402,606 bytes，不是默认分发包 |
| 2026-10-16 晚间，产品源码 `141dd277849b7e13237836c8a22a382854be0366` | `output/mcp-windows-2026-10-16-evening/Pi-Paper-0.1.0-win-x64.exe` | `f113cd34b2ed212e8c15820bbf4895ebc60fe0cc1152771d2e0883365c591f9b` | [构建及 Node 载荷检查](windows-build-2026-10-16-evening.json)；120,341,708 bytes，包含已授权披露卡终态修复，尚未手工安装 |
| 2026-10-16，源码 `858fbbeb14d0438d4700859514c14f419faf3247` | `output/mcp-windows-2026-10-16/Pi-Paper-0.1.0-win-x64.exe` | `07b308f606fe5b47e34e9bbc11477cc4d5b4b6804b4c2f98e7a7c2a1db35243e` | [构建及载荷检查](windows-build-2026-10-16.json)、[交互式重装及重开](windows-manual-lifecycle-20261016.json)；120,341,693 bytes，含授权环境变量导出修复 |
| 2026-10-15，源码 `6491cd8805d358bba05c8ebc443252940b8c2c2d` | `output/mcp-windows-2026-10-15/Pi-Paper-0.1.0-win-x64.exe` | `cca3e3051bc4f3654691c0e92abdc00b31fa48e36770e73a84a052b2114a88ed` | [构建摘要](windows-manual-build.json)、[手工安装及运行](windows-manual-lifecycle.json)；120,341,655 bytes |
| 2026-10-12，历史构建 | `output/mcp-windows-2026-10-12/Pi-Paper-0.1.0-win-x64.exe` | `b1a2edf5a2e5973d4912bbf63eb8c3406f9eedfc3bfa882b1209c59d5bc4ea9d` | [历史升级记录](windows-installed-upgrade.json) |

上述构建版本号均为 0.1.0，不能用版本号替代文件摘要。10-15 构建的手工安装向导与安装后关闭重开已通过；10-16 构建另有包内 Electron Node 检查、交互式重装和隔离资料正常本地启动/关闭/重开证据。10-16 中间向导页面由用户操作，审查者未观察目录页，不计注册项全空的首次安装；一次受限环境重开出现 0x80000003，正常本地进程重开成功，原失败单独保留。

10-17 诊断包的原卸载流程已实测清除文件和注册项，用户资料内容不变；旧轮次残留原因仍未证实。10-19 正式包完成现有安装升级及正常启动、关闭和重开，只观察了升级进度页，未再次卸载。签名可信度及 macOS/Linux 本轮仍未验收。
