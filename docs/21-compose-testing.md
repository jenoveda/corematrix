# Docker Compose 测试部署

适用于 Linux amd64/arm64、Docker Engine 与 Docker Compose 插件 2.24+。首次构建需要访问官方镜像仓库和 npm registry；服务器无需安装 Node、Go、Nginx 或数据库。镜像使用固定版本摘要，API 和 Nginx 均以非 root 账号运行。

## 一键启动

在项目根目录执行：

```sh
docker compose up -d --build --wait
docker compose ps
```

默认访问：

- 用户端：`http://服务器IP:8080/#/user/models`
- 注册与登录：`http://服务器IP:8080/#/user/account`
- 管理端：`http://服务器IP:8081/#/admin/overview`
- 供应商端：`http://服务器IP:8082/#/provider/overview`
- 健康检查：`http://服务器IP:8080/api/health`

这套配置使用构建后的静态页面与真实 API，适合可信测试网络。HTTP 会话不带 Secure 属性；公网生产环境应按 [生产部署](20-production-deployment.md) 配置 HTTPS 与 `NODE_ENV=production`。Compose 不启动 GPU Agent、vLLM 或 JupyterLab，也不预置管理员、余额、支付确认或虚构节点。

管理端“证书管理”可分别上传用户、管理、供应商的证书链与私钥，启用 HTTPS 后对应 HTTP 业务接口拒绝访问，页面切换到 HTTPS。首先确认公开端口可达，用户/供应商配置完成后再启用管理员证书。详见 [证书校验、备份与恢复](22-portals-certificates.md)。六个公开端口不能被其他服务占用；可通过端口变量调整。

## 配置与管理员

无需配置即可启动和注册普通用户。需要修改端口或创建首个管理员时：

```sh
cp deploy/compose.env.example .env.compose
chmod 600 .env.compose
```

编辑 `.env.compose`，填写自己的 `ADMIN_EMAIL`、`ADMIN_PASSWORD`（12–128 字符），可选填写 `ADMIN_NAME`。包含 `$` 等特殊字符的密码使用 dotenv 单引号包裹，避免 Compose 插值。不要填写本机测试账号的密码。需要固定浏览器来源时，分别将 PUBLIC_ORIGIN、ADMIN_PUBLIC_ORIGIN、PROVIDER_PUBLIC_ORIGIN 设置为各自实际访问的 HTTP origin（例如 `http://192.0.2.10:8080`），不包含路径；留空时按请求 Host 检查同源。

```sh
docker compose --env-file .env.compose up -d --build --wait
docker compose --env-file .env.compose exec api node server/create-admin.ts
```

管理员命令使用同一数据卷与非 root 账号；已有邮箱会拒绝创建，不会覆盖密码或提升普通用户权限。创建成功后从 `.env.compose` 删除 `ADMIN_PASSWORD` 等初始化变量，再执行 `docker compose --env-file .env.compose up -d --force-recreate --wait`，同时重建前后端容器，移除旧容器环境中的初始化密码。之后在 8081 管理端登录。用户、供应商分别在自己的端口注册登录，同一邮箱只能绑定一种身份。

有 `.env.compose` 时，后续 Compose 命令统一带 `--env-file .env.compose`，使端口等插值与 API 环境一致。本机 `.env` 不会作为 API 配置传入容器；可选 `.env.compose` 不参与镜像构建，也不会进入 Git。

HTTP 端口 8080/8081/8082 分别通过 COREMATRIX_PORT、COREMATRIX_ADMIN_PORT、COREMATRIX_PROVIDER_PORT 修改；HTTPS 443/8443/8444 分别通过对应的 COREMATRIX_HTTPS_PORT、COREMATRIX_ADMIN_HTTPS_PORT、COREMATRIX_PROVIDER_HTTPS_PORT 修改。默认监听全部主机接口；如果通过 SSH 隧道测试，可设置 `COREMATRIX_BIND_IP=127.0.0.1` 并运行 `ssh -L 8080:127.0.0.1:8080 用户@服务器`，浏览器访问 `http://127.0.0.1:8080`。

## 服务与持久化

- `api`：Node.js 24，三端 API 分别监听容器内 loopback 3001/3002/3003，数据库路径 `/var/lib/corematrix/corematrix.sqlite`。
- `web`：Nginx 静态页面及 `/api`、`/v1` 代理，分别监听 8080/8081/8082，与 `api` 共享网络命名空间。因此发布端口配置在 `api` 服务上，但对外只开放 Nginx 入口，不发布内部 API。
- `corematrix-data`：按 Compose 项目名隔离的数据卷，包含 SQLite、WAL/SHM 和含私钥的 platform-tls.json（0600）。证书文件须另行受控备份，数据库备份命令不含该文件。默认项目名由目录名决定；保持目录名或显式 `-p` 项目名一致，避免误以为数据丢失。

前后端应作为一组启停或重建，不单独替换 API 网络命名空间。健康检查会验证 API，以及 Nginx 到 API 的代理通路。反向代理覆盖转发头，API 只信任同一命名空间中的 loopback 代理。访问日志不记录 URL 查询、Cookie 或授权头，SSE 关闭代理缓冲与自动重试。

业务配置继续使用 [环境变量示例](../.env.example)，按需添加到 `.env.compose`；Compose 固定测试模式、API 端口、持久化路径和受信代理。API 容器内的 `127.0.0.1` 不能用于访问主机或外部 GPU 节点，应填写容器可达的实际服务地址并配置 `INFERENCE_ALLOWED_ORIGINS`。没有接入真实服务前，推理和真实 GPU 销售仍需后续验收。

## 日常操作

以下示例用于无 `.env.compose` 的默认部署；有配置文件时统一追加前述 `--env-file` 参数。

```sh
# 查看服务与日志
docker compose ps
docker compose logs --tail=100 api web

# 更新代码后本机重新构建并启动，不依赖云端构建
git pull --ff-only
docker compose up -d --build --wait

# 停止并移除容器，数据卷保留
docker compose down

# 重新启动，继续使用原有数据
docker compose up -d --wait
```

升级前按 [数据库备份和恢复](19-proxy-backup-recovery.md) 做一致性备份，不直接复制正在写入的 SQLite 文件。不要对需要保留的数据执行 `docker compose down -v`：`-v` 会删除数据卷及其中的账号、订单和账本。每个数据库只运行一个 API 写实例，不扩容 API 副本。

## 本次验证范围

2026-10-16 已在 Docker Linux/arm64 容器中构建两个镜像并验证三套静态页面、独立身份入口、证书校验 HTTPS、替换失败保留配置和重建后证书/账号持久化，以及：Compose 配置校验、前端静态资源与 SPA 回退、代理健康检查、注册登录、初始余额为零、管理员 CLI、角色隔离、CSRF/Origin 校验、非 root 运行、本地环境文件及数据未复制入镜像，以及 `down` 后重新 `up` 仍保留账号和语言偏好。验证使用随机命名的独立项目和数据卷，结束后清理，没有读取或替换日常业务库。

尚未在目标 Linux 服务器、amd64 实机、真实 GPU 或真实支付/邮件渠道验收；镜像构建通过不代表上述外部服务已接入。

可复现命令：`npm run test:compose`。该命令构建随机命名的独立栈，使用临时管理员、临时证书和数据卷，验证后只清理自己的栈。需要 Docker、Compose 2.24+、Node 和 OpenSSL；不读取日常 .env、.env.compose 或数据库。
