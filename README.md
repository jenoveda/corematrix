# CoreMatrix

React + TypeScript 双端控制台，Node.js HTTP 后端，SQLite 持久化账户、会话、模型、计费账本、GPU 分配和部署任务。支持简体中文、英文、日文、韩文。

## 持续集成

[GitHub Actions CI](https://github.com/jenoveda/corematrix/actions/workflows/ci.yml) 在每次推送和 Pull Request 时自动执行，也支持手动运行。两个任务在 Ubuntu 上并行检查：

- 后端测试：Node.js 24，`npm ci` 后执行 `npm test`。
- Go Agent 测试：Go 版本读取 `agent/go.mod`，执行 `go -C agent test -race ./...`。

前后端构建通过本地 `npm run build` 执行，云端不运行构建任务。CI 不需要配置业务密钥，测试使用独立临时数据与替身服务；真实 GPU、模型推理、支付及邮件投递仍需单独验收。流程配置见 [ci.yml](.github/workflows/ci.yml)。

## 开发设计文档

后续产品、架构、数据库、接口、服务器 Agent、部署、计费、四语言和测试任务见 [开发文档目录](docs/README.md)。其中标明已实现能力与待开发契约。

## Docker Compose 测试部署

Linux 服务器安装 Docker Engine 与 Compose 插件 2.24+ 后，在项目根目录执行 `docker compose up -d --build --wait`，即可启动前后端。默认地址为 `http://服务器IP:8080`，数据库保存在独立 Docker 数据卷中，不读取本机 `.env` 或 `data/`。

端口、管理员初始化、升级和数据保留步骤见 [Compose 测试部署手册](docs/21-compose-testing.md)。此配置只用于可信测试网络的 HTTP 功能测试；HTTPS 生产部署继续使用 [生产部署说明](docs/20-production-deployment.md)。

## 本地启动

需要 Node.js **22.18+**。SQLite 使用 Node 内置 `node:sqlite`，不需要安装数据库服务。

```sh
npm install
cp .env.example .env
npm run dev
```

一条命令启动 API（默认 3001）和 Vite（默认 5173）。打开终端打印的 Vite 地址：

- 用户端：`/#/user/models`
- 注册 / 登录：`/#/user/account`
- 管理端：`/#/admin/overview`（需要管理员登录）

普通注册账户的余额为 **0**、角色为普通用户。所有数据保存在 `data/corematrix.sqlite`；前端不再读取旧演示 localStorage。旧浏览器模拟数据不会导入真实账本。

## 创建首个管理员

在 `.env` 填写自己的 `ADMIN_EMAIL`、`ADMIN_PASSWORD`（12–128 个字符）和可选的 `ADMIN_NAME`，再运行：

```sh
npm run create-admin
```

命令不输出密码；邮箱已存在时不会覆盖密码或把普通用户升级为管理员。创建后移除 `.env` 中的 `ADMIN_PASSWORD`，用配置的邮箱和密码在账户页面登录。没有内置通用账号或默认密码。

Stripe 在线充值已实现，配置完成后可在用户钱包创建支付单，签名回调确认后到账，支持退款、失败恢复及拒付资金处理。配置与边界见 [Stripe 支付](docs/16-stripe-payments.md)。管理员仍可在“模型与定价 → 用户资金入账”按已确认的线下款项或授信，为已注册用户入账。操作保存管理员 ID、金额、说明与唯一编号；重复编号不会重复增加余额。

## 邮箱验证与密码找回

SMTP 适配已实现；在 `.env` 配置 SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM 和固定 PUBLIC_ORIGIN 后重启 API。生产使用 HTTPS，邮件连接强制 TLS/STARTTLS。账户页可发送验证邮件，登录页可找回密码；重置会撤销旧会话和 API Key，保留余额与订单。未配置时明确禁用发信。配置、接口和验收边界见 [账号邮件](docs/15-account-mail.md)。

## 配置推理网关

当前尚未部署实际模型，所以预置模型默认下架、推理地址为空。不会返回虚构的模型回复或按固定 Token 扣费。

1. 部署提供 OpenAI 兼容 JSON 接口的模型服务，例如 vLLM。
2. 在 `.env` 的 `INFERENCE_ALLOWED_ORIGINS` 中列出允许访问的源地址，例如 `http://127.0.0.1:8000`。多个源用逗号分隔；修改环境变量后重启 API。
3. 如服务需要密钥，将密钥保存在 `.env` 的 `INFERENCE_` 前缀变量中，例如 `INFERENCE_VLLM_KEY`。**不要在模型表单填写密钥值。**
4. 在管理台“模型与定价”编辑模型，填写完整推理 URL（如 `http://127.0.0.1:8000/v1/chat/completions`）、上游模型 ID、密钥变量名、输入/输出上限与单价，再上架。
5. 给测试账户入账后，通过在线体验或 API Key 调用。

网关支持 `system/user/assistant` 文本消息、非流式 JSON 和 `stream=true` SSE（单个文本回复）。流式上游必须支持 `stream_options.include_usage=true`，返回有效结束原因、最终 usage 和 `[DONE]`，才能结算。停止接收或关闭页面不会停止服务端生成，后续生成仍按最终用量计费；可查询原请求恢复结果。缺少可信最终用量不扣费。协议、故障边界和恢复接口见 [流式推理与计费](docs/14-streaming-billing.md)。网关不跟随上游重定向。

## 四语言与受管部署

页头和弹窗支持简体中文、英文、日文、韩文切换。访客偏好只保存语言；登录账号通过 `/api/account/preferences` 保存偏好。切换不重载页面、不清空表单；币种仍为 CNY，业务时区仍为 Asia/Shanghai。

管理员可在“算力服务器”登记节点、管理维护/调度开关、轮换一次性 Agent Token、查看实际 GPU 与占用。在“模型与定价”设置 managed runtime 后，可选择空闲 GPU 提交部署、滚动切换、排空停止、重试清理和查看事件。仅通过健康验证的实例会进入 managed 推理路由。

Go Agent 提供 Linux amd64 / arm64 静态二进制，支持 inference（Token 推理）和 gpu-rental（JupyterLab 整卡环境）两种模式。管理台可启用按卡销售并设置小时价，用户在“独享算力”选择卡数和时长、冻结余额、健康交付后扣费，到期自动停止并确认回收。管理员仍可手动分配不计费环境。详见 [GPU 购买与计费](docs/12-gpu-rental-billing.md)。

Linux + NVIDIA + Docker 接入步骤见 [Agent 接入说明](agent/README.md)。没有默认真机或模拟节点注入日常数据库；节点离线、任务失败时不会自动释放资源。当前已完成协议与命令边界测试，真实单卡、多卡、模型兼容性仍待真机验收。

## 计费与一致性

- 金额存储为整数微元：1 元 = 1,000,000 微元。输入、输出单价均为**每百万 Token 的微元金额**。
- 费用 = `(输入 Token × 输入单价 + 输出 Token × 输出单价) / 1,000,000`，向上取整到一个微元。
- 调用前按**配置的输入 Token 上限 + 请求 max_tokens**预留最大费用；同时检查可用余额、当日预算及其他处理中请求。预留可能高于实际费用。
- 成功时仅依据服务端收到的上游 usage 原子扣款、写账单、保存结果并释放预留。客户端传入的用量、金额、角色和余额均不作为计费依据。
- 上游失败、超时或 usage 无效时不扣款并释放预留。上游可能已经产生实际成本，该类异常应由运维排查。
- `Idempotency-Key` 在用户范围内唯一。相同内容的成功重试返回已保存结果，不再次请求或扣款；处理中返回 409；相同 ID 不同内容返回 409。失败请求也保留原结果，主动重新尝试应使用新 ID。
- 修改单价、下架或删除模型不改变处理中请求的价格快照和历史账单。删除为软删除，不可复用原模型 ID。
- 每日预算按 UTC+8 的**请求开始日期**归集。收入累计来自实际消费，人工入账不计为模型收入。
- 单实例重启会把遗留待处理请求标为中断、释放预留并保留该请求 ID，避免自动重发扣费。

## API

同源浏览器会话使用 HttpOnly、SameSite=Lax Cookie。登录/注册和 `/api/state` 返回 `csrfToken`；所有经过会话鉴权的写请求携带 `X-CSRF-Token`。邮箱确认与密码重置凭一次性链接鉴权。Bearer API Key 只用于模型推理及查询本人请求结果。

| 方法          | 路径                        | 用途                                                       |
| ------------- | --------------------------- | ---------------------------------------------------------- |
| POST          | `/api/auth/register`        | `{name,email,password}` 注册并登录                         |
| POST          | `/api/auth/login`           | `{email,password}` 登录                                    |
| POST          | `/api/auth/logout`          | 退出当前会话                                               |
| GET           | `/api/state`                | 当前用户、模型、钱包、账单；管理员包含真实汇总             |
| GET           | `/api/models`、`/v1/models` | 查询可见模型                                               |
| GET           | `/api/wallet`               | 当前账户余额、预留、今日用量和最近 500 条账单              |
| PUT           | `/api/wallet/budget`        | `{amount}` 修改每日预算，单位微元                          |
| POST / DELETE | `/api/keys`                 | 创建（明文仅返回一次）/ 撤销 API Key                       |
| GET / POST    | `/api/admin/models`         | 管理员查询 / 创建模型                                      |
| PUT / DELETE  | `/api/admin/models/:id`     | 管理员修改 / 软删除模型                                    |
| POST          | `/api/admin/credits`        | `{email,amount,reason,reference}` 管理员人工入账，单位微元 |
| POST          | `/v1/chat/completions`      | 网关推理与 Token 结算，必须传 `Idempotency-Key`            |
| GET           | `/api/health`               | 健康检查                                                   |

创建模型示例（所有字段提交，`PUT` 语义同样是完整替换）：

```json
{
  "id": "qwen3-32b-local",
  "name": "Qwen3-32B",
  "tag": "通用对话",
  "description": "本地模型服务",
  "inputPrice": 2000000,
  "outputPrice": 6000000,
  "gpus": 2,
  "vram": 48,
  "enabled": true,
  "contextTokens": 32768,
  "maxOutputTokens": 4096,
  "upstreamUrl": "http://127.0.0.1:8000/v1/chat/completions",
  "upstreamModel": "your-served-model-name",
  "apiKeyEnv": ""
}
```

external 模式的 GPU 参数仅为展示元数据；managed 模式通过节点 Agent 实际分配 GPU 和启动容器。输入/输出上限应与推理引擎一致，超出上限的上游 usage 会被视为异常，不扣款。

调用示例（用你创建的 Key 替换变量）：

```sh
curl http://127.0.0.1:5173/v1/chat/completions \
  -H "Authorization: Bearer $COREMATRIX_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: unique-request-001' \
  -d '{"model":"qwen3-32b-local","max_tokens":1024,"stream":false,"messages":[{"role":"user","content":"你好"}]}'
```

错误使用 `{ "error": { "code": "...", "message": "..." } }`。常见状态：400 参数错误，401 未认证，403 无权限 / CSRF，402 余额或预算不足，409 重复或冲突，429 频率限制，502 上游错误，503 未配置服务。

## 检查

```sh
npm test
npm run build
npm run test:agent
```

测试使用临时本地上游和独立 SQLite 数据库，覆盖注册、会话、越权、CSRF、模型配置、API Key、幂等计费、失败释放、价格快照、并发预留、预算和重启恢复。测试上游不会用于正常运行。

## 边界与运行注意

- 当前适合本地开发、单实例运行。SQLite 进程内启动恢复不能用于多副本同时启动；扩容前需迁移共享数据库和持久化任务协调。不要在运行中复制单个 SQLite 文件作为备份，应使用 SQLite 一致性备份方式，并保护数据库、WAL 与环境文件。
- API 默认只监听 127.0.0.1。生产部署需要同源 HTTPS 反向代理，将 `/api`、`/v1` 转发到 API，其余静态文件指向 `dist/`。设置 `NODE_ENV=production` 与 `PUBLIC_ORIGIN=https://你的域名`；生产 Cookie 启用 Secure。Vite 开发服务器不用于生产。
- Stripe 和 SMTP 适配已完成，真实商户收款与邮件投递待环境验收。预约已实现，自动成本来源接入仍依赖实际供应商/设备数据。页面中这些功能会显示未接入，而不会伪造成功数据。
- 密码使用 scrypt + 随机盐；会话与 API Key 保存 SHA-256 哈希，不保存其明文。请求消息不写日志，但已完成回复会保存在 SQLite 中用于幂等重放，需要保护数据库访问权限。
- Node SQLite API 参考：[Node.js 官方文档](https://nodejs.org/api/sqlite.html)。

用户可在独享算力订单中续费和提前退租。续费沿用原价，节点确认持久化新期限后生效；退租后自动停止，清理确认后按秒精度退回未使用费用。续费要求 Go Agent 4-go（renewalSupported），参见 [计费与续费退租契约](docs/12-gpu-rental-billing.md)。

GPU 支持未来固定时段预约、报价冻结、原价交付、延迟少收费、取消与冲突保护；规则和接口见 [预约契约](docs/17-gpu-reservations.md)。

全量交付范围和未完成验收见 [交付核查](docs/13-delivery-status.md)。成本报表已支持实际单据登记、作废、期间汇总和资金对账。

## 运维告警

管理员在 `/#/admin/operations` 查看每分钟资金/节点/部署检查、HTTP 指标、确认和恢复历史。配置 SMTP、OPS_ALERT_EMAIL 和可选 OPS_ALERT_LOCALE 后启用新告警/恢复邮件摘要；未配置仍记录。检查不改余额或释放 GPU，通知有持久化重试，SMTP 接受不代表收件。详见 [运维告警契约](docs/18-operations-alerts.md)。

## 受信代理和备份恢复

生产反向代理可用 TRUSTED_PROXY_IPS 配置其连接 API 的精确 IP，默认忽略转发头。登录与邮件限额按可信来源解析客户端，转发 Host/Proto 不改变同源规则。

```sh
npm run db:backup -- data/backups/pre-release.sqlite
npm run db:restore -- data/backups/pre-release.sqlite data/recovery-check/corematrix.sqlite
npm run db:verify -- data/recovery-check/corematrix.sqlite
```

备份包含已提交 WAL；恢复目标必须不存在，不覆盖当前数据库或启动第二个 API。verify 只读，异常需人工核查。每次选新文件名，并安全保管备份；真实节点与外部支付恢复仍需独立对账。详见 [代理与备份恢复](docs/19-proxy-backup-recovery.md)。

## 生产部署

生产入口要求固定 HTTPS PUBLIC_ORIGIN 和持久化绝对 DATABASE_PATH。API service、控制台和双模式节点 TLS 模板位于 deploy；推理可用 COREMATRIX_INFERENCE_LOOPBACK=1 避免与节点 TLS 代理端口冲突。受管模型按最少在途请求分流，平局按部署 ID，保留计费和幂等。步骤及待验收边界见 [生产部署](docs/20-production-deployment.md)。

有 Docker、Go 与 OpenSSL 时，可按 [固定镜像检查步骤](docs/20-production-deployment.md#可复现的-nginx-模板语法检查) 运行 `npm run test:nginx`，在无网络 Linux 容器中检查两份模板语法和实际 HTTPS/ACL/SSE/WebSocket 传输。该命令不读取业务配置、不发布端口；实际模型、Jupyter 和生产验收仍需部署环境。

可按 [Linux 服务检查步骤](docs/20-production-deployment.md#可复现的-linux-服务与运行检查) 构建独立验收工具镜像并运行 `npm run test:linux`。它验证 API unit、真实非 root API、管理员初始化与重启，以及 Linux Agent/Node 测试；不挂载实际数据、不启动主机系统服务。
