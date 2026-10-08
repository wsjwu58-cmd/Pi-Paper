# Pi-Paper 推广首页

面向 AI 创作者的中文静态落地页。奶油白、衬线标题与纸张质感，真实画布截图为主，小P纸艺猫作为品牌插画。独立于桌面应用与旧 Web 服务，无构建依赖、无服务端 API、无外部字体和分析脚本。

## 文件与预览

- `index.html`：中文内容、GitHub 与 v0.1.0 Releases 链接。
- `styles.css`：响应式布局、纸张纹理和视觉样式。
- `script.js`：产品截图切换、键盘导航、原生截图预览弹窗与滚动动画。
- `assets/`：已准备的产品截图、图标与小P插画。原始 PNG 留作源素材，不进入公开部署包。
- `deploy/`：本地检查、打包与服务器连接辅助脚本；不发布到网站。

在仓库根目录运行：

```powershell
python -m http.server 4180 --bind 127.0.0.1 --directory pi-paper-site
```

浏览器访问 `http://127.0.0.1:4180`。检查与打包：

```powershell
node --check pi-paper-site/script.js
python pi-paper-site/deploy/check-site.py
python pi-paper-site/deploy/package-site.py
```

公开目录输出到 `output/pi-paper-site/public/`，压缩包为 `output/pi-paper-site/pi-paper-site.zip`。部署时仅上传公开目录，禁止上传整个仓库或 `deploy/`。

## 已部署环境

- 正式推广地址：<https://wsjaly.cn/>；IP 预览地址：<http://60.205.109.84/>。
- Ubuntu 22.04.5 LTS，已有宝塔 Nginx，使用现有 80 与 443 端口。
- 独立虚拟主机：`/www/server/panel/vhost/nginx/pi-paper.conf`。
- 站点根目录：`/var/www/pi-paper/current`，指向版本目录。
- 当前版本目录：`/var/www/pi-paper/releases/20261007-domain-v3`。
- 初次版本和上一版本保留在 `.../20261007-landing-v1`、`.../20261007-landing-v1-final`，可回退。
- 原有域名站点配置未修改，发布后仍返回 HTTP 200。

服务器密码不保存在脚本、文档或网站文件中。连接辅助脚本需要本机 `paramiko`，密码在隐藏输入中读取。SSH 首次连接取得的主机指纹为：

```text
SHA256:kn08++MqH3+jMHpA2dXvasVSPFhghcS7EXCVNi4NqsY
```

后续连接须提供该指纹进行校验：

```powershell
python pi-paper-site/deploy/server-session.py 60.205.109.84 'SHA256:kn08++MqH3+jMHpA2dXvasVSPFhghcS7EXCVNi4NqsY'
```

脚本输入 JSON 操作，`upload` 目标限定在 `/var/www/pi-paper/`。新版本上传到新的 `releases/<版本>/` 后，用新符号链接原子替换 `current`；旧版本保留。修改 Nginx 配置时先备份对应文件，执行 `nginx -t` 成功后再重载，不修改其他虚拟主机。

## 域名与 HTTPS

用户已指定推广域名 `wsjaly.cn`。独立 Nginx 站点已绑定该根域名，服务器本机以对应 Host 请求验证页面、ACME 验证路径与 robots.txt 正常。`www.wsjaly.cn` 的原有站点保留。

2026-10-07 已在阿里云 DNS 添加 **A / 主机记录 `@` / 记录值 `60.205.109.84` / 默认线路 / TTL 10 分钟 / 启用**。权威 DNS 与阿里云公共 DNS 均返回该 IP；原有 `www` 记录保留。

已配置 canonical、Open Graph 地址、站点地图与 robots.txt，统一使用正式地址 `https://wsjaly.cn/`。公开域名 HTTPS 已启用，HTTP 请求返回 301 跳转至 HTTPS。

Certbot 已通过 Ubuntu 软件包安装，`certbot.timer` 已启用且运行中。证书已签发，签发者为 Let's Encrypt，SAN 为 `wsjaly.cn`，当前有效期截至 **2027-01-05 01:13:30 UTC**。证书申请采用 webroot，不停现有 Nginx；验证目录为 `/var/www/pi-paper/acme`。首次申请命令如下，后续由定时器续期：

```sh
certbot certonly --webroot -w /var/www/pi-paper/acme -d wsjaly.cn --cert-name wsjaly.cn --non-interactive --agree-tos --register-unsafely-without-email
```

独立站点已启用 `deploy/nginx-https.conf`，`nginx -t` 与重载成功。续期重载脚本 `deploy/renew-nginx.sh` 已安装到 `/etc/letsencrypt/renewal-hooks/deploy/pi-paper-nginx.sh`，权限 755；脚本只在该域名续期后检查配置并重载 Nginx。脚本语法与实际重载已验证，`certbot renew --cert-name wsjaly.cn --dry-run --no-random-sleep-on-renew` 演练成功。首次演练遇到 CA 二次验证连接超时，确认防火墙和验证路径正常后复测通过。证书私钥只留在服务器，不下载到仓库。

修改域名前的 Nginx 备份位于 `/var/www/pi-paper/backups/nginx-20261007-before-domain.conf`，启用 HTTPS 前的备份为 `/var/www/pi-paper/backups/nginx-20261007-before-https.conf`，上一版内容在 `/var/www/pi-paper/releases/20261007-scroll-motion-v2`，可分别恢复配置和内容。

## 内容维护

GitHub 仓库：<https://github.com/wsjwu58-cmd/Pi-Paper>。通过 GitHub API 核实当前默认分支为 `feat/desktop-local-migration`，v0.1.0 提供 Windows x64、macOS arm64/x64、Linux AppImage/deb。下载按钮统一进入该版本的 Releases 页面，让用户查看说明并选择架构。

不宣传模型调用免费、全部模型已完成验证或云端请求不离开本机。下载包可用与各平台完整验收分别说明；能力和边界以桌面版 README、功能规格及版本说明为准。参考录屏用于版式观察，不发布录屏或参考产品素材。

## 验证

- HTML 本地资源、图片 alt、外链安全属性与 JavaScript 语法通过检查。
- 浏览器检查 1440px 桌面、390px 与 320px 手机宽度，无横向溢出。
- 实测三张产品截图切换、方向键导航、截图弹窗与 Escape 关闭。
- Nginx 配置检查、服务器本机与公网 HTTP 检查通过；原有网站 HTTP 200。
- 正式域名 HTTPS 首页、CSS、JavaScript、robots.txt 与 sitemap.xml 均返回 200；HTTP 返回 301；浏览器在 `https://wsjaly.cn/` 显示完整首页。
- DNS 截图为 `output/landing-reference/wsjaly-dns-records.jpg`，正式首页截图为 `output/landing-reference/wsjaly-https-home.jpg`。证书续期演练通过。
- 最终公网浏览器验证与截图记录在 `output/landing-reference/`。

暂未提供真实操作演示视频。首版已使用真实产品截图；后续可录制一段 15–30 秒从参考到分镜、生成、合成的桌面操作，作为下一版演示内容。

## 滚动效果（2026-10-07）

- 标题和内容进入视口时淡入上移，功能卡、步骤与下载卡错峰展开，只在首次进入时播放。
- 首屏和展示截图随滚动轻微缩放；纸张贴纸和小P插画随滚动产生轻微视差，手机幅度降至 6px。
- 流程区域进入视口时绘制连线，依次显示想法、分镜、图像、视频和作品节点。
- 使用原生 IntersectionObserver、Web Animations API 与按需 requestAnimationFrame，不引入动画库，不拦截原生滚动。仅更新视口内的四个动画对象，停止滚动后不持续运行帧循环。
- 支持系统“减少动态效果”的即时切换、无 JavaScript 静态展示、键盘聚焦和打印时显示全部内容。已有页面跳转、截图切换与下载链接继续使用原逻辑。
- 浏览器实测滚动触发、连线完成、手机无横向溢出，以及减少动态效果时取消动画并显示内容。
