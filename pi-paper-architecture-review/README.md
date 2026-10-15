# Pi-Paper Architecture Review

项目的静态架构评审展示与配套资源。目录由 `vibepaper-architecture-review` 更名为 `pi-paper-architecture-review`，展示入口同步改为 [`pi-paper-architecture-review.html`](./pi-paper-architecture-review.html)。

可直接用浏览器打开 HTML，或从仓库根目录用静态服务器查看：

```bash
npx --yes http-server pi-paper-architecture-review
```

`assets/` 与 `_shared/` 为评审页面所需资源。这里保留历史架构材料，页面中的旧 Web 服务与多用户方案不能视为当前桌面版运行依赖或完成证据。

当前源码由 [`pi-paper-desktop`](../pi-paper-desktop/README.md)、[`pi-paper-web`](../pi-paper-web/README.md) 和 `pi-main/` 组成。最新契约见 [`AGENTS.md`](../AGENTS.md)，容器部署见 [`docker/README.md`](../docker/README.md)。
