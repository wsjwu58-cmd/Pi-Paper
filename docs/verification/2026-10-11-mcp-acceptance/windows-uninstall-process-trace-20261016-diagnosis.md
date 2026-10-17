# 2026-10-16 Windows 卸载追踪诊断

## 可确认的事实

- 用户确认本次手工卸载最终显示“卸载完成页”。追踪 JSON 本身不包含页面截图或 UI 状态，因此此项来自用户确认。
- [进程追踪记录](windows-uninstall-process-trace-20261016-111922-f3ed569f.json)在卸载前后均读到 `E:\pp\Pi-Paper\Pi-Paper.exe`、`Uninstall Pi-Paper.exe`、HKCU 卸载键和 `Software\6d7bc0c1-d3cd-50da-9feb-41d1166b5a3e` 安装键存在；HKLM 对应键不存在。HKCU 注册命令仍指向该目录并带 `/currentuser`。
- PID 5204 的 `Uninstall Pi-Paper.exe` 由 CIM 精确进程名轮询识别，ExecutablePath 与注册命令目标相符；约 0.3 秒后通过 CIM 查询不到该 PID。其后观测到子进程 `Un_A.exe`（TEMP 路径）及两个 `powershell.exe` 子进程；这些进程随后也通过 CIM 查询不到。它们的退出码均未捕获，`Un_A.exe` 未通过注册卸载器 SHA256 或命令行匹配验证。
- 记录的最终判定是进程树不再可见且文件/注册表快照稳定 30 秒，不是 NSIS 退出码或“卸载成功”信号。WMI StartTrace、StopTrace 均不可用，追踪没有捕获原生退出事件或 `ExitStatus`。

## 源码与打包配置

- 当前 [electron-builder 配置](../../../pi-paper-desktop/electron-builder.cjs)使用 NSIS、交互式向导（`oneClick: false`）、可改安装目录，并设置 `perMachine: false`、`deleteAppDataOnUninstall: false`；未配置自定义 NSIS include/script。本次实际卸载命令的 `/currentuser` 标志及 HKCU 快照表明被观察的是当前用户注册。
- 本地锁定的 electron-builder / app-builder-lib 版本为 26.15.3。其 stock [卸载模板](../../../pi-paper-desktop/node_modules/app-builder-lib/templates/nsis/uninstaller.nsh)先执行卸载 section 和文件清理，section 末尾依次尝试删除 `${UNINSTALL_REGISTRY_KEY}` 与 `${INSTALL_REGISTRY_KEY}`（第 250–254 行）。在配置的当前用户模式下，这些键应落在当前用户上下文。`deleteAppDataOnUninstall: false` 控制模板中 `%APPDATA%` 删除分支，不会跳过这两条注册表删除命令。交互式模板包含卸载完成页（[assistedInstaller.nsh](../../../pi-paper-desktop/node_modules/app-builder-lib/templates/nsis/assistedInstaller.nsh)，第 74–81 行）。

## 结论与证据缺口

目前没有证据能确定具体根因。用户看到完成页、卸载器进程及其已观测子进程消失，与卸载操作结束相符；但追踪显示安装文件和两个 HKCU 键原样保留。若运行的确是当前 stock 模板生成的卸载器并执行到卸载 section 末尾，这与模板预期的文件和注册表清理结果不一致。完成页本身不能证明对应文件删除及 `DeleteRegKey` 操作已经成功。

本次记录的注册卸载器 SHA256 为 `4820461a4d1a8b875569561f6524eb938dbf6a8963cb17ee689001a69260d656`。本机候选安装包的 SHA256 与已记录的 2026-10-15 手工安装包一致，但追踪没有记录安装包来源；且候选包内卸载器无法完整静态提取，因此仍不能将这两个卸载器哈希对应起来。WMI 事件订阅失败、没有退出码，TEMP 子进程及两个 PowerShell 子进程也没有经过内容/命令行验证；因此无法判断实际运行二进制是否与当前源码配置一致、是否走完相同清理路径，或清理命令是否生效。现有证据支持“卸载 UI 已结束但目标状态未清理”，不支持宣称根因已证实。

## 候选安装包静态提取核对

- `output/mcp-windows-2026-10-15/Pi-Paper-0.1.0-win-x64.exe` 的 SHA256 为 `CCA3E3051BC4F3654691C0E92ABDC00B31FA48E36770E73A84A052B2114A88ED`，与 `windows-manual-build.json` 记录的安装包哈希一致；`windows-manual-lifecycle.json` 将该安装包记录为手工安装向导验收所用包。
- 本机仅找到 7-Zip 9.10 beta。它能识别 NSIS 并列出嵌入的 `Uninstall Pi-Paper.exe` 条目，但按条目提取未得到文件；对新建的唯一 `.test-temp` 目录全量提取时，7-Zip 对该条目报告 `Data Error`。留下的 131,072 字节文件 SHA256 为 `8CAD09D238D2EA14CF948EAED1DF7790302D9C15EFF6CE21715BBD0877399EA4`，不是可用于比较的完整提取物。`bsdtar` 可列出安装载荷，但列表中没有卸载器条目。本机没有发现其他 7-Zip 或 makensis 工具；未安装新工具，也未运行任何安装器或卸载器。
- 因提取物不完整，不能用其差异解释现场残留，也不能检查本次实际运行卸载器内的编译后 NSIS 控制流。此前静态阅读的 stock 模板只说明源配置预期行为，不能替代对现场二进制的验证。

## 下一次观察能力准备（尚未重跑卸载）

在私有 `.test-temp` 中准备了持有 `System.Diagnostics.Process` 句柄的只读观察器。进程被发现后核对 PID、StartTime 和可执行文件路径，再开启退出观察；进程退出后通过持有的句柄读取退出码，并转为 UInt32。原始命令行不写入报告，不操作注册项或安装文件。

审查者独立启动一个无害 PowerShell 子进程，让其自行以 255 退出，持有的句柄在退出后仍能读取相同 StartTime、`ExitCode=255`、`UInt32=255`；测试通过。该测试没有运行卸载器，不能补记实际卸载退出码。实际卸载观察器尚未运行；若短命进程在发现或附上句柄前已退出，仍会丢失退出码，报告须保留这一限制。

## 晚间实际退出码补证

上述“尚未运行”描述保留准备时点。随后用户手工完成卸载，[新追踪](windows-uninstall-process-trace-20261016-194833-932af3fc.json)持有并核对 PID、StartTime 与路径的句柄，捕获注册路径下卸载器、其 `Un_A.exe` 子进程及两个 PowerShell 子进程退出码均为 UInt32 `0`。另一个短命 conhost 子进程仅确认消失，没有退出码；WMI 启停事件仍不可用，不宣称捕获完整进程树。

在全部已观测进程退出并稳定 30 秒后，主程序、卸载器及两个 HKCU 键仍存在，HKLM 对应键不存在。用户报告已在完成页结束；退出码 `0` 不替代最终文件和注册状态验证，卸载依然未通过。新的晚间私有基线及[卸载后数据核对](windows-manual-20261016-evening-uninstall-data.json)均为 1,737 文件，内容无新增、缺失或变化。此轮没有手工删除文件或注册项；实际目标目录、shell context 与执行到的 section 仍待进一步证据，不能凭源码路径认定根因。

审查者随后[核对实际注册目录](windows-uninstall-target-check-20261016-evening.json)：HKCU 的 Registry32/Registry64 视图均有非空 `InstallLocation`，都匹配原安装目录，安装目录也不是 reparse point。锁定的 builder 按当前 appId 推导出的 GUID 与被观察键一致；当前源码中不能证实 GUID 错配。追踪里的 `/currentuser` 来自已注册命令摘要，不是本次实际进程参数的捕获，不能混用。上述结果仍不能证明现场 NSIS 的有效 `$INSTDIR`、shell context 或 section 执行路径。
