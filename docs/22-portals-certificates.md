# 三端身份隔离与平台证书

本章为 v12 接口契约，替代旧文档中同端口切换用户/管理员的说明。三端共享一个业务服务进程和 SQLite，但入口、身份检查、会话命名空间各自独立。

| 入口 | 本地开发 | Compose HTTP | Compose HTTPS | 内部 API | 构建目录 |
| --- | --- | --- | --- | --- | --- |
| 用户 | 5173 | 8080 | 443 | 3001 | dist/user |
| 管理员 | 5174 | 8081 | 8443 | 3002 | dist/admin |
| 供应商 | 5175 | 8082 | 8444 | 3003 | dist/provider |

API 仅监听 loopback。用户端开放注册、模型、订单、钱包、推理及 Agent 接口；管理端只开放管理业务和管理员登录；供应商端只开放供应商注册、登录、自己的节点与采购账单。修改 hash、传入角色或伪造入口请求头均不能跨端。管理员由 CLI 创建，不接受公开注册。邮箱全局唯一，一个邮箱只能属于一种账号。

Cookie 分别为 cm_user_session、cm_admin_session、cm_provider_session，服务端保存带入口命名空间的 Token 哈希，并再次核对账号身份。同主机不同端口仍会共享浏览器 Cookie 发送范围，不能单靠 Cookie 名隔离；重命名 Cookie 也无法跨端认证。CSRF Token 和 Origin 同时验证。三端只共享语言资源，不共享登录。供应商、管理员的密码找回暂由部署运营处理；用户邮件流程保持原接口。

## 手动上传与生效

Compose 与 `npm run dev` 启用 TLS_MANAGED=1。管理端“证书管理”可对 user/admin/provider 分别配置：

1. 固定 HTTPS origin，包含实际公开端口，无路径、查询或账号密码。
2. PEM 证书链，叶证书在前，最大 32 KiB、最多 10 张证书。
3. 未加密 PEM 私钥，最大 16 KiB。证书与私钥必须匹配。

校验 SAN 域名/IP、证书链签名、起止日期、密钥匹配和强度。证书须由浏览器及调用方信任；自签证书需要安装自己的受控 CA 信任，不能用关闭 TLS 校验代替。第一版不签发证书、不自动续期，页面显示到期时间。

首次上传仅通过可信网络或 SSH 隧道，先确认域名解析、端口映射和防火墙可达。HTTPS 端口映射必须与填写的 origin 一致。可先配置用户、供应商，最后配置管理员。保存成功即启用或热替换，失败保留原证书；同一 origin 不能用于多个端。启用后页面刷新会切换到 HTTPS，HTTP 业务 API 返回 426；health 和 portal 元数据仍可用于探活与跳转。HTTPS 登录设置 Secure/HttpOnly/SameSite Cookie。

Node 标准 TLS 监听内部 3443/3444/3445，转发至对应 Nginx/Vite，再到相应 API。Compose 清洗转发头，只信任同网络命名空间的 loopback 代理；不使用 Docker socket、不执行任意 shell 或重载主机 Nginx。开发 HTTPS 适合 localhost/127.0.0.1，端口分别为 3443/3444/3445。

GET /api/admin/certificates 返回 available 和三端公开元数据；PUT /api/admin/certificates/:portal 接收 {origin,certificate,privateKey}，要求管理员会话和 CSRF。响应不返回证书正文或私钥，浏览器不持久化密钥。私钥只保存在数据库目录旁的 platform-tls.json，文件权限 0600，原子替换并记录操作管理员和时间。该文件需与数据库分别做加密或访问受控的备份。

PUBLIC_ORIGIN、ADMIN_PUBLIC_ORIGIN、PROVIDER_PUBLIC_ORIGIN 分别设置固定来源，启用内置 TLS 后以对应证书 origin 为准。SMTP、Stripe 等渠道仍须按渠道手册配置正确的用户端 HTTPS origin 和公网回调地址。Compose 使用测试运行模式，不替代完整生产隔离验收。

## 恢复与外置代理

若管理员证书过期、域名或端口填错导致无法进入，先限制 HTTP 入口为可信网络，停止容器，保留数据卷。使用同一 Compose 项目与配置文件运行：

```sh
docker compose stop
docker compose run --rm --no-deps api node --input-type=module -e "import {rmSync} from 'node:fs'; rmSync('/var/lib/corematrix/platform-tls.json',{force:true});"
docker compose up -d --wait
```

这会清除三端证书配置，账号、订单和账本保留。通过可信 HTTP 管理入口重新上传正确证书；禁止删除数据库或整个数据卷。有 .env.compose 时每条命令保持同一 --env-file 与项目名。正常轮换应直接在 HTTPS 管理端上传，保持原配置文件备份；已过期证书启动时不会被静默丢弃。

外置 Nginx/systemd 部署默认不启用 TLS_MANAGED，证书页面显示不可用，由部署方配置代理证书。三个模板分别使用 dist/user、dist/admin、dist/provider 和 API 3001/3002/3003；管理员 HTTPS 8443、供应商 8444。生产必须设置三个不同的固定 HTTPS origin。见 [生产手册](20-production-deployment.md)。

测试覆盖角色/会话/CSRF 隔离、三端注册规则、证书域名/密钥/有效期、替换失败回滚、0600 文件、真实证书验证 HTTPS 和 Compose 重建恢复。真实域名、CA 链与目标 Linux 网络需部署时验收。
