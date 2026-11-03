# 桌面版 CI/CD

## 触发与依赖

| 事件 | 自动验证 | 产物与发布 |
| --- | --- | --- |
| 普通分支 push、PR、合并队列 | 工作流语法、门禁回归；运行代码变更时执行 Agent、前端、桌面检查 | 在 Linux staged app 中运行市场 UI 冒烟 |
| 仅文档变更 | 工作流检查与固定名称的 CI gate | 路径判定显式跳过应用构建 |
| 集成分支 `feat/desktop-local-migration` 或仓库默认分支 push | 上述验证 | 通过质量门禁后构建 Windows x64、macOS x64/arm64、Linux x64 候选包 |
| Docker 配置或工作流变更 | 额外运行 Compose、noVNC、原生运行时及重启检查 | Docker 日志和截图 |
| 每日北京时间 02:23、手动运行 CI | 全量验证，包括 Docker 和四组安装产物 | 候选包保留 14 天 |
| 推送 `desktop-vMAJOR.MINOR.PATCH` | 版本与源码预检、全量验证、正式签名及公证检查 | 全部通过后创建 GitHub 预发布版本 |
| 手动运行 Desktop release | 检查现有预发布、观察期、审批、SHA 和全部文件摘要 | 将同一预发布版本提升为正式版 |

`changes → Agent / web / desktop` 并行执行。工作流检查独立运行。`Quality gate` 汇总必需检查，只有成功后才启动四组打包。Docker 独立运行。`CI gate` 最后汇总质量、按条件必需的打包与 Docker 结果。缺失、失败、取消及意外跳过的必需任务都会使门禁失败。

将分支保护必需检查设为 `CI gate`，并配置 PR 审查要求。路径筛选在工作流内部完成，纯文档提交仍产生门禁结果。主干直接推送权限、审查要求及标签修改限制由 GitHub 仓库规则管理。工作流文件无法替代这些仓库设置。

同一分支的新 CI 运行会取消旧验证。发布链路使用独立全局并发组并保留正在执行的发布。正式版提升还校验版本递增，防止旧候选覆盖新版。GitHub 的任务依赖、环境保护与并发配置分别控制执行顺序、放行和互斥。[GitHub 工作流语法](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)、[部署控制](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)

## 构建与版本追溯

统一使用 Node 24、pnpm 9.15.9 和冻结锁文件。桌面检查还固定 Python 3.12，用于既有 TOML 配置解析 fixture。`.github/actions/setup-desktop` 安装 Pi、Renderer、Desktop 三组依赖，恢复随包模型目录并离线构建实际使用的 Pi 基础包。Worker 构建引用前端共享模块，因此必须准备 Renderer 依赖。

每个平台构建一次安装包，安装后或解包后验证同一份载荷，再计算 SHA-256。每个 `manifest-<platform>-<arch>.json` 记录版本、源码 SHA、平台架构、运行编号、运行次数和文件摘要。候选包名称含源码 SHA，测试报告与截图也按 SHA 关联。

普通候选使用 `electron-builder.ci.cjs`，macOS 使用内部验证用 ad-hoc 签名。正式版本使用现有 `electron-builder.cjs` 的 Developer ID、hardened runtime、公证、stapler 和 Gatekeeper 检查。缺少签名条件会在正式打包开始前失败。

预发布收集四组已通过检查的包，逐文件复算摘要并验证清单。先创建 draft，全部上传成功后公开为 prerelease。上传中断时可以重试 draft；已公开版本禁止覆写。预发布文件长期保存在 GitHub Release，提升正式版仅修改发布状态和验收记录。当前 Windows 产物尚无 Authenticode 签名，发布说明会明确记录。

## 正式发布前的仓库配置

1. 配置 `desktop-preview` 与 `desktop-production` 环境。`desktop-production` 必须设置 required reviewers，工作流会读取环境规则并检查。将生产环境允许来源限定为可信发布分支。配置规则保护 `desktop-v*` 标签，限制创建者并阻止移动、删除。
2. 在仓库 Actions secrets 配置 `MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` 和 `APPLE_TEAM_ID`。这些值仅映射到正式签名步骤。CI 与测试无需模型 Key。
3. `DESKTOP_RELEASE_BRANCH` 默认是 `feat/desktop-local-migration`。切换发布主干后更新该变量。标签目标必须属于这一分支历史。
4. 更新桌面 `package.json` 与锁文件中的版本，经 PR 审查合入。推送匹配的 `desktop-vMAJOR.MINOR.PATCH` 标签触发预发布。
5. 预发布至少观察 24 小时。该时长是本次设计采用的默认策略。记录 Windows、macOS、Linux 安装运行、项目打开与保存、关闭重启、升级、卸载及备份恢复结果。记录崩溃、启动失败、任务失败和数据兼容问题，任一未解决的阻断问题都应暂停提升。
6. 在可信分支手动运行 `Desktop release`，填写现有预发布标签和 HTTPS 验收记录地址，随后由生产环境审核人批准。工作流校验成功的原始发布运行、标签对应 SHA、四平台文件及摘要、观察期和递增版本后提升。

24 小时检查只度量等待时间。安装验收和观察期问题判断由验收记录与审核人负责。CI 的 Electron 测试宿主使用已安装资源，并另行验证安装载荷中的原生运行时；图形安装向导、系统信任、真实供应商生成及升级卸载仍须独立计证据。

## 项目升级与恢复

桌面数据保存在用户本机，版本兼容围绕项目 `schemaVersion`、SQLite、JSONL、插件状态与设置格式检查。发布前说明新旧版本可读取的格式与迁移顺序，执行现有迁移、备份、恢复、会话恢复和任务幂等测试。优先追加兼容结构，保留升级前备份，后续版本再清理过渡结构。

预发布出现异常时停止正式提升，在 Release 页面标记问题与受影响版本，保留源码、日志和原安装包供定位，发布新的修复版本。正式版出现异常时，维护者可以把上一稳定 Release 重新设为 latest，并在问题版本说明中记录恢复决策。自动提升逻辑会拒绝版本倒退，紧急恢复由维护者明确执行。

应用降级前先备份当前项目。已经升级的数据只在上一版明确兼容时直接打开，否则使用升级前备份的独立副本恢复，或等待向前修复版本。恢复后核对画布、素材文件、任务账本和会话，再恢复创作。供应商端已提交任务应先查询本地账本与上游状态，避免恢复期间重复提交。

## 2026-11-03 故障与验证

- 远端 `d9ae5fe40b` 的桌面 CI 在 Worker 构建失败，错误为前端共享模块无法解析 `react`。原桌面 job 只安装 Pi 和 Desktop 依赖。现统一安装三组依赖。[失败运行](https://github.com/wsjwu58-cmd/Pi-Paper/actions/runs/41568827902)
- 同一版本的四组市场安装验证在复选框计数处失败。预设配置也有复选框，全页面计数与点击会混入这些控件。现从被测载荷读取组件清单，按组件 `aria-label` 定位与选择，并在失败时保存截图。[失败运行](https://github.com/wsjwu58-cmd/Pi-Paper/actions/runs/41568827833)
- 新增前端测试门禁发现 `nodeDownloads.test.ts` 在模块导入前缺少 `localStorage` fixture，已在 hoisted setup 中补齐。
- 工作流通过 actionlint 1.7.7 的 YAML、表达式与依赖语法检查；门禁、路径分类和发布清单回归 9 项通过。
- 发布 CLI 的隔离 fixture 通过 draft 上传、预发布、审批条件检查、文件复验与正式版提升全过程。
- 新的 macOS ARM64 CI 配置已在临时目录完成候选载荷打包，随包 Electron 的 MCP fixture、SQLite 保存重启与 Worker 会话恢复检查通过。这项证据对应内部 ad-hoc 载荷。
- 当前本地源码的前端 166 项、Agent 384 项通过，standalone 构建、Worker 恢复与市场 UI 冒烟通过。原有 lint 警告和 CJS `import.meta` 构建警告仍存在。
- 在远端 `d9ae5fe40b` 源码临时副本应用本次市场与测试修复后，桌面 563 项通过、5 项条件跳过，前端 183 项通过，standalone 构建及市场 UI 冒烟通过。该副本复用了本机已安装的锁文件依赖。
- 推送版本以远端 `d1ad63b` 为基线完成独立集成，沿用其中按组件名称选择的市场测试和新增界面用例，并补充失败截图。原目录中的其他未提交修改仍保留。正式 macOS 配置启用 Developer ID 签名与公证，CI 候选配置单独使用 ad-hoc 签名。
- 该提交将触发重构后的 GitHub Actions。正式签名、公证、环境审批和预发布提升另需发布标签与仓库配置后验证。
