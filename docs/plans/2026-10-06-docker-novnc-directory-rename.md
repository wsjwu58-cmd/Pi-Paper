# Docker/noVNC 与 Pi-Paper 目录更名验证

用户授权为当前桌面版添加 Docker/noVNC 部署，并上传到 `feat/desktop-local-migration`；将顶层 `vibepaper-desktop`、`vibepaper-web`、`vibepaper-architecture-review` 更名为对应的 `pi-paper-*`，更新根目录和三个目录的 README。

## 最终实现

- 根 `Dockerfile` 从同一套原 Renderer、Electron Main/IPC、本地核心与 Pi Agent 构建完整 Linux x64 桌面，运行阶段包含 Xvfb、Openbox、x11vnc、noVNC、D-Bus、GNOME Keyring 和 FFmpeg。
- Compose 默认绑定 `127.0.0.1:8080`，要求独立的 noVNC 与系统凭据库密码文件。运行桌面的用户为 UID/GID 1000；密码和用户项目不进入镜像或 Git。
- `desktop-home`、`projects` 两个持久卷分别保存配置/凭据库与项目。容器重启会清理 Xvfb 与 Chromium 临时单实例锁；不清理项目锁、数据库、会话或用户文件。
- 三个顶层工程目录、架构页面文件名，以及代码、测试、CI、打包和当前文档的目录引用均已同步更新。已有 `.vibepaper` 项目格式、`VibePaper` 用户目录、内部 Pi 包名和供应商请求标识保持兼容。
- 同步引入已发布版本使用的打包配置、公共模型目录快照、离线目录恢复脚本和 Windows ICO 修复；没有合入当前主工作区其他未提交的 Agent 改动。

## 验证证据

[Linux Docker 完整验收](https://github.com/wsjwu58-cmd/Pi-Paper/actions/runs/37397662837) 在 Ubuntu 24.04 原生 runner 上通过：

1. Compose 配置检查、完整镜像构建与 Electron 可见窗口健康检查。
2. 实际包内 Electron 运行 SQLite 画布保存/恢复，Agent Worker 加载项目 Skill 并保存、重启导入会话片段。
3. Playwright 通过 noVNC WebSocket 使用 VNC 密码连接真实虚拟桌面并保存截图；截图显示原画布展示、历史记录和 API 配置入口。
4. 重启容器，再次等待桌面健康检查，核对项目卷中的文件仍可读取。

本地还通过了 Compose/CI YAML 解析，以及项目导航、素材操作、画布导出桥接、任务搜索和官方文档路径相关测试。Git 跟踪清单中不再存在三个旧顶层目录；当前活动目录引用已逐项搜索。

首次检查发现 Xvfb 在容器重启后保留显示锁；修复固定临时锁清理后，上述完整重启检查通过。[首次诊断记录](https://github.com/wsjwu58-cmd/Pi-Paper/actions/runs/37397255802) 仅用于追溯问题，不作为最终通过证据。

当前部署命令和限制见 [Docker README](../../docker/README.md)。该验证不等同于真实供应商生成、全部原版 UI/领域保真、浏览器文件传输或音频传输验收。
