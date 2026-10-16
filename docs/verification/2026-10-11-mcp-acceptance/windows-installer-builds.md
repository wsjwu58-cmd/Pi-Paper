# Windows 验收安装器

安装器保留在本机，未提交二进制或发布 GitHub Release。以下路径以仓库根目录为基准，文件摘要用于识别实际验收载荷。

| 构建 | 本机文件 | SHA256 | 证据 |
| --- | --- | --- | --- |
| 2026-10-16，源码 `858fbbeb14d0438d4700859514c14f419faf3247` | `output/mcp-windows-2026-10-16/Pi-Paper-0.1.0-win-x64.exe` | `07b308f606fe5b47e34e9bbc11477cc4d5b4b6804b4c2f98e7a7c2a1db35243e` | [构建及载荷检查](windows-build-2026-10-16.json)；120,341,693 bytes，含授权环境变量导出修复；此构建尚未进行手工安装 |
| 2026-10-15，源码 `6491cd8805d358bba05c8ebc443252940b8c2c2d` | `output/mcp-windows-2026-10-15/Pi-Paper-0.1.0-win-x64.exe` | `cca3e3051bc4f3654691c0e92abdc00b31fa48e36770e73a84a052b2114a88ed` | [构建摘要](windows-manual-build.json)、[手工安装及运行](windows-manual-lifecycle.json)；120,341,655 bytes |
| 2026-10-12，历史构建 | `output/mcp-windows-2026-10-12/Pi-Paper-0.1.0-win-x64.exe` | `b1a2edf5a2e5973d4912bbf63eb8c3406f9eedfc3bfa882b1209c59d5bc4ea9d` | [历史升级记录](windows-installed-upgrade.json) |

上述构建版本号均为 0.1.0，不能用版本号替代文件摘要。10-15 构建的手工安装向导与安装后关闭重开已通过；10-16 构建另有包内 Electron Node 运行检查，手工安装尚未验收。卸载后注册项残留及签名可信度仍未验收通过。macOS/Linux 本轮未测试。
