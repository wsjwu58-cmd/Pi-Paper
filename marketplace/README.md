# 在线创作目录

桌面市场仅在用户点击刷新或下载时访问 GitHub。刷新时解析 `feat/desktop-local-migration` 的提交 SHA，再从该提交读取 `marketplace/index.json`；下载所选条目时使用同一 SHA，检查文件实际字节数、SHA-256、应用版本范围、目录元数据与包格式。已导入的资源可离线安装和使用。

目录由应用配置固定指向 `wsjwu58-cmd/Pi-Paper`，不接受索引中的外部下载 URL。摘要确保文件与所选提交的目录一致，不是发布者签名；该目录的可信度取决于 GitHub 仓库及其发布权限。发布更新时，每个改变的包应增加版本，并以文件实际 UTF-8 字节重新计算大小与 SHA-256。不要修改相同版本的内容。

`package` 条目指向 `marketplace/packages/` 下符合市场 v1 格式的 JSON。`pi-skill` 指向 `marketplace/skills/<name>/SKILL.md`，只导入名称、说明和指令；不能包含需要访问辅助文件、安装脚本或不受支持的权限/兼容性元数据的 Skill。不执行 npm 或其他安装命令。独立性检查是保守筛选，不能证明任意自然语言没有隐藏依赖；用户可在安装前预览指令。每条 `target` 显式指定受支持的 Pi-Paper 版本闭区间。
