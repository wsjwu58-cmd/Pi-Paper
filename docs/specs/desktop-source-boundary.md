# 桌面分支源码边界

按用户授权，`feat/desktop-local-migration` 取消跟踪旧 Java 服务 `vibepaper-services/`、旧 Python 生成服务 `generation-service/`、旧 Python Agent 服务 `agent-service/`、`deploy/` 与根目录 Web Docker/Nginx 文件。清理采用 `git rm --cached`：已有本机文件保留并加入忽略，新克隆不再包含这些文件。项目、素材、结果、凭据与其他未跟踪文件不在清理范围内。

## 原实现对照

清理前的固定基线为 `e3c2bdc4bbc4a0ffbbb5b5af418fe5e514cbabf6`。旧领域规则、API、错误语义及状态转移仍须对照此基线验收；取消跟踪不代表已完成全部迁移。历史文档引用旧服务路径时，路径指向此 Git 基线，不要求当前检出存在对应文件。

查看单个历史文件：

```powershell
git show e3c2bdc4bbc4a0ffbbb5b5af418fe5e514cbabf6:vibepaper-services/pom.xml
```

如需完整对照目录，可导出到独立位置：

```powershell
git archive --format=zip --output=legacy-services.zip e3c2bdc4bbc4a0ffbbb5b5af418fe5e514cbabf6 vibepaper-services generation-service agent-service deploy Dockerfile docker-compose.yml nginx.conf .dockerignore
```

## 桌面运行源码

保留 `pi-paper-desktop/`、原前端 `pi-paper-web/`、原 TypeScript Agent `pi-main/packages/vibepaper-agent-service/` 及其 Pi 依赖、Skills、桌面契约与验收材料。桌面 Agent 复用原 TypeScript Agent，旧根目录 Python `agent-service/` 是另一套历史服务。

原前端与 TypeScript Agent 仍包含迁移对照、共享协议和测试代码，不能按名称批量移除。它们的进一步裁剪必须先证明不在桌面源码、构建或功能验收依赖中。现有未提交的 Agent、UI 与安装包改动单独保留。

CI 移除旧 Maven/Python 服务任务，改为桌面分支的 Pi 测试、原前端构建及桌面 Worker 检查。已移除读取旧 Java 网关文件的 Web 部署断言；保留共享配置校验测试。

## 本轮验证

- Git 跟踪清单：上述旧服务、部署目录与根部署文件共 426 个文件取消跟踪；本机三个服务的工程文件仍存在。
- `npm --prefix pi-paper-desktop run test:agent-runtime`：构建通过，Worker 加载项目 Skill，保存、重启后导入会话片段通过。
- 本地画布校验、裁剪/编组下载与节点导出定向测试：46 项通过。
- 原 TypeScript Agent 配置校验：2 项通过。
- 桌面运行源码与测试路径搜索未发现旧服务文件的运行依赖；历史行为目录中的 `agent-service/tests` 为来源说明。

这些验证不替代跨平台安装包、真实模型生成或完整 1:1 迁移验收。

## Pi-Paper 目录与可选容器部署（2026-10-06）

按用户授权，当前顶层目录改名为 `pi-paper-desktop/`、`pi-paper-web/` 和 `pi-paper-architecture-review/`，开发/打包脚本、测试、CI 和当前文档同步使用新路径。已有 `.vibepaper` 项目格式、`VibePaper` 用户目录与 Pi 内部 `vibepaper-agent-service` 包名保留兼容；历史 Git 基线中的文件路径仍按基线查看。

根 `Dockerfile`、`docker-compose.yml`、`.dockerignore` 现在是新编写的单用户 Linux Electron/noVNC 部署文件；旧 Web Docker/Nginx 文件仍只属于上面的历史基线。新部署不恢复 Java、PostgreSQL 或 Redis。部署命令、数据卷、凭据库和验证说明见 [Docker README](../../docker/README.md)。
