# 单实例生产部署与 v11 路由

本次交付包含受管实例负载分流、启动配置校验、API systemd/反向代理模板，以及双模式节点共用 TLS 代理的绑定配置。没有修改用户机器的系统服务、域名或证书；真实生产、GPU 和渠道验收仍未完成。

## 受管实例分流（D05 / v11）

共享模型从 ready、期望运行、健康未过期的部署中选择，继续过滤离线、库存异常、禁调度、已删除和模式错误的节点。维护模式仍允许已有健康实例接流。

选择顺序为 `(该部署的 pending 请求数, deployment ID)`，不按最近健康时间排序。pending 包含已预留、正在生成和消费者断线后仍未结算的请求。成功/失败完成后不再计数。选择后目标、价格和请求 ID 固定；不会因实例负载变化重发到别处。事务内重新检查选择状态，滚动退役实例不再接收新请求。

v11 仅增加 requests_pending_deployment 与 deployments_ready_model 两个部分索引和迁移记录，不改账户、价格或账本。失败迁移会回滚新索引和本次版本记录，并关闭数据库连接；不以覆盖余额或清空请求完成升级。

## 生产入口校验

`NODE_ENV=production` 要求固定 HTTPS PUBLIC_ORIGIN 和持久化目录中的绝对 DATABASE_PATH，拒绝内存库和相对路径。配置失败在创建数据库和监听之前退出。API_PORT 必须为 1–65535 整数；推理允许列表只能包含 HTTP(S) origin，禁止凭据、路径、查询和片段，规范化默认端口及大小写。

开发默认仍使用 data/corematrix.sqlite、API 3001、同源检查及原账号。生产静态构建隐藏开发环境标记，不影响开发服务器标记。

## API 与控制台

交付文件：

- [API 环境模板](../deploy/corematrix-api.env.example)
- [API systemd unit](../deploy/corematrix-api.service)
- [控制台 Nginx 模板](../deploy/nginx-console.conf.example)

模板目录约定：程序和已构建 dist 位于 `/opt/corematrix/current`，持久化数据在 `/var/lib/corematrix`，配置为 `/etc/corematrix/api.env`。API 由专用 corematrix 用户运行；unit 的私有状态目录与只读程序目录遵循 [systemd 执行环境规范](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml)。按实际 Node 安装位置校对 ExecStart，不能假定所有发行版均在 /usr/bin/node。

实施顺序：

1. 本地或受控构建环境运行 npm ci、npm run build、npm test。TLS 专项测试还需要 OpenSSL 命令；应用进程不依赖 OpenSSL CLI。
2. 生产准备专用系统用户与上述目录，状态目录归属 corematrix、权限 0700，程序目录只读且可被运行账号读取。发布 server、共享 src 资源、package.json/lock、dist 和生产 node_modules；保留现有数据，不把新空库当作升级。Node 需符合项目 22.18+ 基线。
3. 将环境模板保存为 `/etc/corematrix/api.env`（0600），填写实际 HTTPS 域名、绝对数据路径和受控代理来源。密钥在环境文件中配置，不填入模型表单或命令行。运行账号只需读程序、写持久化状态目录。
4. 先做一致性备份。已有数据库在停写、排空后使用恢复工具复制到新生产路径，检查数据库及 WAL/SHM 的归属为 corematrix 并执行只读核验，不能把开发测试夹具带到生产，也不修改原开发库属主。详见 [恢复工具](19-proxy-backup-recovery.md)。
5. 首个管理员仍由 create-admin 创建，使用同一生产数据库和运行账号，避免以 root 创建 0600 数据库后 API 无法访问。将初始化参数临时放入受控的 0600 环境文件，不传入命令行或聊天；通过 systemd 读取文件后以 corematrix 身份运行：

```sh
sudo install -d -o corematrix -g corematrix -m 0700 /var/lib/corematrix
sudo systemd-run --wait --pipe --collect --uid=corematrix --gid=corematrix \
  --working-directory=/opt/corematrix/current \
  --property=EnvironmentFile=/etc/corematrix/api.env \
  /usr/bin/node server/create-admin.ts
```

确认成功后移除 ADMIN_PASSWORD 等初始化变量，再启动 API。已有邮箱会拒绝初始化，不覆盖密码或提升普通账号。此命令需要真实 systemd 主机；下述隔离测试验证同一非 root CLI 与数据库归属，不声称已启动主机 transient unit。6. 填写 Nginx 的域名、证书和目录，并在目标 Linux 检查：

```sh
nginx -t
systemd-analyze verify /etc/systemd/system/corematrix-api.service
```

7. 检查通过后安装并启用唯一 API unit 和代理服务，观察日志与 /api/health。禁止同时启动另一写实例做“测试”，也不要运行对公网开放的 Vite 开发服务器。
8. 从实际 HTTPS 浏览器验证注册、登录、Secure/HttpOnly/SameSite Cookie、CSRF、SSE 首段及时出现、断线恢复及四语言，再启用真实渠道和节点销售。

Nginx 示例假定一层受控入口：覆盖 X-Forwarded-For 为 TCP 客户端，按已有固定来源转发；关闭 SSE 缓冲、缓存及自动换上游，保留 API 错误状态。相关行为见 [Nginx 代理文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)。访问日志只记录方法、状态、耗时和请求 ID，不记录请求体或 URL 查询。请求解析发生在 location 选择之前，因此 HTTP 跳转、控制台 HTTPS 和节点 HTTPS 三个 server 入口统一关闭可能包含原始 URI 的请求错误日志，避免畸形请求退回父级日志泄露令牌。故障结合安全访问状态、API 请求 ID 和 Agent 诊断码排查；启动配置校验仍由 nginx -t 报告。

unit 使用 120 秒停止期限，让现有请求/邮件按程序排空；重复停止信号不会重复关闭账本。仍不承诺单 API 发布零停机。

## 双模式 GPU 节点的 TLS

交付 [节点 Nginx 模板](../deploy/nginx-node.conf.example)，配合 Go Agent：

```dotenv
COREMATRIX_INFERENCE_LOOPBACK=1
COREMATRIX_WORKSPACE_BIND_IP=127.0.0.1
```

未配置 INFERENCE_LOOPBACK 或为 0 时保留原推理发布方式；仅 1 启用 loopback，其余值拒绝启动。改变前先排空并确认停止相关容器；已有容器不会自动修改绑定或 Jupyter 参数，禁止为了应用参数删除占用账本。部署新二进制时保留 Agent 状态与租用期限文件。协议仍为兼容的 4-go。

两种模式的容器都发布到 127.0.0.1 的分配端口，TLS 代理监听节点实际 IP 的同一端口，避免推理容器绑定全部网卡时与代理冲突。节点登记使用 `https://受控节点IP`，主机名须与控制台隔离；证书需覆盖该 IP 并被控制面、浏览器信任。私有 CA 通过受控信任配置提供，不能关闭证书验证。

代理按路径转发：`/v1/` 仅允许真实控制面来源 IP（替换 CONTROL_PLANE_IP，其他来源拒绝）；Jupyter 使用既有 `/api/compute/rentals/` 基址及每实例独立凭证。必须配置控制面与节点一致的模型推理密钥，公开代理不等于允许用户绕过平台调用模型。

为登记端口范围逐一补齐 listen 指令；上游使用 `$server_port` 转发到对应 loopback 端口。只配置 8000 不能交付被分配到 8001 等端口的容器。IPv6 的 listen 地址加方括号；Node 主机 origin 仍按 URL 标准填写。

Jupyter 在 loopback 后端启用 trust_xheaders；模板覆盖 X-Forwarded-Proto/For，清除客户端替代转发头，并给 Cookie 加 Secure，保留 XSRF Cookie 的可读性。非 loopback 的受控 HTTP 测试不自动信任代理头。Jupyter 终止 TLS 的要求见 [Jupyter Server 配置](https://jupyter-server.readthedocs.io/en/latest/other/full-config.html#serverapp-trust-xheaders)。Nginx 需要支持 proxy_cookie_flags 的版本，并在目标机器执行 nginx -t；不要把指令兼容性当作已验收。

节点安全访问日志仅保留状态/耗时，原始代理错误日志关闭以免泄漏带 Token 的 URL。按实际镜像、驱动、磁盘容量调整上传与工作目录管理；工作目录不会因回收而自动删除。内网测试例外不等于生产 HTTP 可售卖。

以上代理模板假定节点直接接收来自控制面的连接；有 CDN/LB 等中间层时须按真实拓扑重新验证 ACL 和来源，不能放开一个共享代理地址后宣称完成隔离。工作模式切换仍要求无活跃资源、待执行任务和预约，不能绕过已有安全检查。

## 验证与边界

- 新增 3 项负载路由、1 项失败迁移、3 项运行配置和 3 项生产边缘测试；全套 137 项 Node 测试与生产构建通过。
- 本机 TLS 测试使用临时证书，客户端明确只信任该证书；系统默认不信任时连接被拒绝，没有关闭 TLS 校验。验证 Secure Cookie、同源/CSRF、清洗转发头、请求 ID 和 SSE 首段早于结束及唯一结算。
- Go race 通过，覆盖新增绑定、原映射/摘要兼容和 Jupyter 代理信任范围；Linux amd64/arm64 静态构建通过。
- 当前 macOS 未安装 Nginx/systemd。隔离 Linux/arm64 已验证 Nginx 1.30.6 的模板和实际传输，以及 systemd 252.39 的 API unit 校验、Node 24.22.0 非 root API 和 Linux Agent 测试（详见后文）。未安装生产 unit、启动 systemd PID 1、签发公网证书或修改 DNS；这些证据不能替代真实 vLLM/JupyterLab、生产网络或 systemd service 隔离验收。
- H01–H07、实际模型 SSE、生产 TLS/恢复、Stripe Sandbox/商户收款、SMTP 收件及成本来源仍需实际环境证据；不能据此将整体目标标记完成。

## 可复现的 Nginx 模板语法检查

需要 Docker（Linux containers）、Node、Go 1.24+ 和 OpenSSL。先缓存验证使用的固定官方镜像摘要，再执行：

```sh
docker pull nginx@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5
npm run test:nginx
```

`scripts/verify-nginx.mjs` 直接读取两个 deploy 模板，仅替换测试证书/静态目录、节点监听 IP 和控制面允许 IP，包装为完整配置后交给真实 Nginx。测试容器使用 `--pull=never --network=none --read-only`，不发布端口；只挂载临时目录，并使用 tmpfs 保存临时运行文件。测试私钥权限 0600，结束后删除临时证书、配置及测试二进制，不读取 `.env`、业务数据库或生产私钥，不安装主机 Nginx。另以无效指令验证检查确实返回失败。

随后按镜像的 amd64/arm64 架构，用 Go 标准库编译 `tests/nginx/runtime_test.go`，在同一无网络容器内启动真实 Nginx 和 loopback 协议后端。当前 Linux/arm64、Nginx 1.30.6 已验证：

- 默认不信任临时证书时连接失败，显式信任测试证书后正常握手；没有关闭 TLS 校验。
- HTTP 跳转保留路径/查询并固定控制台域名，伪造 Host 不改变跳转目标；静态 SPA 路由回退有效。
- 控制台覆盖客户端 X-Forwarded-For/Proto，清除 Forwarded/X-Real-IP，并保留 Cookie；节点同样清洗 Jupyter 转发头和保留基路径。
- 节点推理路径只允许配置的 TCP 源 IP，伪造转发头不能越过 ACL；Bearer 授权正常转发，未暴露路径返回 404。
- 控制台和节点 SSE 都在后端仍等待完成时收到首段，结束标记正常传递。
- 工作区 Cookie 增加 Secure 并保留 XSRF 所需可读性；WebSocket 返回有效 101 握手，并双向传递 masked 文本帧和响应。
- 上游断连返回 502且没有隐式重试；三个入口在 location 选择前拒绝畸形 Content-Length 并返回 400。实际成功/400/502/101 访问日志存在，即使父级 error_log 为 info，日志也不含测试查询令牌、Cookie 或 Bearer Key。

该测试只验证模板与协议传输：没有运行 vLLM、Jupyter Server 或 CUDA，不验证模型结果、工作区鉴权/XSRF/文件上传、真实 GPU 网络、公网证书或 systemd。生产部署仍需对替换完真实参数的配置再执行 nginx -t，并完成本章的访问/隔离/恢复验收与 H01–H07。

## 可复现的 Linux 服务与运行检查

需要 Docker、Node、Go 1.24+，以及本地已安装的项目依赖。第一次拉取和构建需要访问官方 Node 镜像及 Debian 软件源；以下镜像只用于验收工具，不是生产服务镜像。

```sh
docker pull node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
docker build --pull=false -t corematrix-linux-qa:node24 -f tests/linux/Dockerfile tests/linux
npm run test:linux
```

验收命令仅复制 server/src/tests 源码、公开部署模板、package.json 和实际 stripe/nodemailer 依赖到私有临时目录，不复制 `.env`、data、现有账号或 Docker socket。容器运行期间 `--network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges`，不发布端口；代码和夹具只读，数据写到归属 UID/GID 1001 的 0700 tmpfs。命令结束删除临时副本，并清理本次命名容器；安装包阶段禁止自动启动服务。

本次 Linux/arm64、Node 24.22.0、systemd 252.39 实测通过：

- 原始 API unit 的 `systemd-analyze --man=no verify`；错误 ExecStart 的负向检查失败，校验器使用真实 Node 可执行文件。
- 非 root 管理员 CLI 初始化、管理员登录、重复初始化不覆盖密码且不能提升已有普通用户；数据库 0600、UID/GID 正确。
- 真实 production API 入口在只读代码目录运行，源码与 /etc 写入被拒绝，SQLite 状态目录可写。
- 普通注册忽略角色/初始余额，Cookie 安全标记、管理员隔离、四语言偏好、钱包查询、重启后账号/会话/偏好保留，以及 SIGTERM 正常退出。
- Go Agent 的 18 项测试编译为 Linux 静态测试程序后通过；全套 146 项 Node 测试在同一 Linux 非 root 条件通过，含账务、部署、恢复与 TLS 场景。

边界：未启动 systemd PID 1，未执行真实 unit 的启停/重启/namespace 沙箱，也未验证 Agent unit 的 Docker 依赖或真实 GPU Docker 命令。Agent 测试中的硬件/命令仍为受控输出，不能替代 H01–H07；该测试也不代替生产持久磁盘恢复、渠道收款/投递或公网访问。其他 Linux 发行版、Node/systemd 版本应在实际目标环境重新验证。
