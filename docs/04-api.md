# CoreMatrix API 契约

> v12 增量契约：三端入口与会话见 [22](22-portals-certificates.md)，供应商固定 GPU 卡时采购、数据表与接口见 [23](23-suppliers-procurement.md)。以增量章节替代旧入口和供应商范围。

接口分为已实现接口和待开发接口。实现新功能时复用当前同源认证、错误格式与 TypeScript 数据类型；不能把本节的待开发接口当成已可调用服务。

## 通用约定

- 请求和响应采用 JSON，写请求的请求体为 `application/json`。
- 浏览器会话使用 HttpOnly、SameSite=Lax Cookie；写请求发送 `X-CSRF-Token`。
- 模型客户端使用 `Authorization: Bearer <API Key>`，仅允许调用推理接口。
- Agent 使用独立 `Authorization: Bearer <Agent Token>`，从 Token 推导节点身份，不信任请求体指定的其他节点 ID。
- 金额字段为整数微元；百分比为 0–100，GPU 显存为 MiB，时间为 UTC ISO 8601。
- 国际化目标为 zh-CN、en-US、ja-JP、ko-KR。机器字段、模型 ID 和枚举不翻译；错误展示通过稳定 code 和 details 映射。现有错误 message 仍是中文，迁移规则见 [国际化](10-i18n.md)。

当前标准错误：

```json
{
  "error": {
    "code": "insufficient_balance",
    "message": "可用余额不足以预留本次最大费用，请联系管理员入账。"
  }
}
```

错误已增量添加可选 details 和 requestId，保留 code/message；不能要求前端解析 message。完整字段映射见国际化契约。

| HTTP      | 含义                               |
| --------- | ---------------------------------- |
| 400       | 参数、状态码或模型模板不合法       |
| 401       | 未登录、凭证过期或撤销             |
| 402       | 余额或预算不足                     |
| 403       | 权限、CSRF 或来源校验失败          |
| 404       | 资源或接口不存在                   |
| 409       | 幂等冲突、资源占用冲突、状态不允许 |
| 413 / 415 | 请求过大 / 内容类型错误            |
| 429       | 频率限制                           |
| 502 / 503 | 上游失败 / 资源不可用或未配置      |

## 已实现账号接口

| 方法 | 路径                 | 请求                    | 返回                          |
| ---- | -------------------- | ----------------------- | ----------------------------- |
| POST | `/api/auth/register` | `{name,email,password}` | 201，State，并设置会话 Cookie |
| POST | `/api/auth/login`    | `{email,password}`      | 200，State，并设置会话 Cookie |
| POST | `/api/auth/logout`   | 无请求体，需 CSRF       | `{ok:true}`，删除当前会话     |
| GET  | `/api/state`         | 无                      | 当前可见 State，访客也可访问  |

name 去除首尾空白后为 1–40 字符；email 规范化为小写、最多 254 字符；password 为 12–128 字符。普通注册忽略用户提交的角色和余额。当前会话有效期为 7 天。

State 包含 user、csrfToken、balance、heldBalance、tokenSpend、dailyBudget、account、email、registered、hasKey、keyPrefix、models、servers、deployments、bills、orders；管理员另有 summary。管理员 State 返回持久化的 servers 和 deployments；普通用户不返回节点拓扑。orders 已接入本人 GPU 订单，续费退租契约见 12 文档。

访客没有用户余额和私人账单；普通用户看不到模型 upstreamUrl、upstreamModel 和 apiKeyEnv。不要把完整 State 写入 localStorage。

## 已实现模型接口

| 方法   | 路径                          | 权限           | 返回                                     |
| ------ | ----------------------------- | -------------- | ---------------------------------------- |
| GET    | `/api/models` 或 `/v1/models` | 访客及登录用户 | `{object:"list",data:[...]}`；按权限过滤 |
| GET    | `/api/admin/models`           | 管理员         | `{data:[Model...]}`                      |
| POST   | `/api/admin/models`           | 管理员         | 创建 Model，201                          |
| PUT    | `/api/admin/models/:id`       | 管理员         | 完整替换配置，200                        |
| DELETE | `/api/admin/models/:id`       | 管理员         | 软删除，`{ok:true}`                      |

当前 Model 请求示例：

```json
{
  "id": "qwen-local",
  "name": "Qwen Local",
  "tag": "通用对话",
  "description": "本地推理服务",
  "inputPrice": 2000000,
  "outputPrice": 6000000,
  "gpus": 2,
  "vram": 48,
  "enabled": false,
  "contextTokens": 32768,
  "maxOutputTokens": 4096,
  "upstreamUrl": "",
  "upstreamModel": "qwen-local",
  "apiKeyEnv": ""
}
```

价格范围为 0–10,000 元每百万 Token，以微元提交。gpus 为 1–64，vram 为 1–1024，contextTokens 为 1–1,000,000，maxOutputTokens 为 1–100,000。模型 ID 最长 100 字符，不能在 PUT 修改，删除后不能复用。

非空 upstreamUrl 必须匹配服务端白名单，禁止 URL 中包含认证信息、query 和 hash。apiKeyEnv 为空或为 `INFERENCE_` 开头的大写变量名，不允许直接提交密钥值。

已实现受管模型增量字段 routingMode 和 runtime 见 [数据库设计](03-data-model.md)。模型存在未停止部署时，DELETE 目标契约返回 409 `model_in_use`，引导先停止部署；不得因删除配置让节点容器无人管理。

## 已实现钱包和 Key

| 方法   | 路径                                         | 请求           | 返回                                                        |
| ------ | -------------------------------------------- | -------------- | ----------------------------------------------------------- |
| GET    | `/api/wallet`                                | 会话           | `{balance,heldBalance,dailyBudget,todaySpend,bills}`        |
| GET    | `/api/wallet/bills?type=all&before=<cursor>` | 会话           | `{data:Bill[],nextCursor:number\|null}`，每页 50 条本人账单 |
| PUT    | `/api/wallet/budget`                         | `{amount}`     | `{ok:true}`；amount 为 1–100,000 元的微元整数               |
| POST   | `/api/keys`                                  | 会话与 CSRF    | 201，`{key:"cm_..."}`，只展示本次明文                       |
| DELETE | `/api/keys`                                  | 会话与 CSRF    | `{ok:true}`                                                 |
| POST   | `/api/admin/credits`                         | 管理员，见下方 | `{ok:true}`                                                 |

人工入账请求：

```json
{
  "email": "user@example.com",
  "amount": 100000000,
  "reason": "线下款项已确认",
  "reference": "credit-unique-001"
}
```

amount 为 1 微元至 100,000 元；reason 为 1–200 字符；reference 为 8–100 位字母、数字或 `._-`。相同 reference、相同用户金额和说明重复提交不会重复入账；内容不同返回 409。

`GET /api/wallet` 和 State 的 `bills` 保留最近 500 条兼容字段。钱包页面使用 `/api/wallet/bills` 查询更早记录，按账本追加顺序倒序而不是可重复的 time 排序。首次省略 before；后续传服务端 nextCursor（1 至 Number.MAX_SAFE_INTEGER 的整数），null 表示没有更多。每页 50 条，游标取本页最后一条记录，新增账单不会让后续页重复或跳过旧记录，刷新从最新记录重新开始。type 省略或 all 为全部，也可为 token/recharge/compute/compute_refund/recharge_refund；过滤覆盖本人全部历史，不只过滤已加载页面。非法类型或游标 400，未登录 401。GET 不修改余额、预算、预留或账本。

返回 Bill 保留当次 inputPrice/outputPrice、原始说明和结构化 metadata，不重新计算历史费用。返回不含 userId、actorId、凭证或内部行号，nextCursor 仅用于翻页。即使管理员或传入其他 userId/游标，也只能看到当前会话本人的账单；API Key 不授予私人钱包查询权限。此接口不承诺 CSV/完整历史一次性导出。

## 已实现推理与计费

`POST /v1/chat/completions` 接受会话或 API Key，必须传 `Idempotency-Key`。

```json
{
  "model": "qwen-local",
  "max_tokens": 1024,
  "stream": false,
  "messages": [{ "role": "user", "content": "你好" }]
}
```

messages 为 1–32 条，role 仅 system/user/assistant，每条 content 去除首尾空白后为 1–16,000 字符。请求体最多 65,536 字节。max_tokens 默认 1024，不大于模型输出上限；stream 可为布尔值或省略（默认 false）。true 使用 SSE，仅接受 n=1 或省略，并强制向上游请求最终 usage；详细帧、重放和断线规则见 [流式契约](14-streaming-billing.md)。

成功响应的关键字段：

```json
{
  "id": "request-uuid",
  "object": "chat.completion",
  "model": "qwen-local",
  "choices": [
    { "message": { "role": "assistant", "content": "真实模型输出" } }
  ],
  "usage": {
    "prompt_tokens": 1200,
    "completion_tokens": 600,
    "total_tokens": 1800
  },
  "billing": {
    "amount": 6000,
    "currency": "CNY",
    "unit": "micro_yuan",
    "inputPrice": 2000000,
    "outputPrice": 6000000
  }
}
```

上例金额为说明精度的示例，不是固定扣费值。用量取自上游可信响应。相同请求 ID 和内容成功重试返回原结果；不同内容返回 409 `idempotency_conflict`；处理中返回 409 `request_pending`；失败重放返回原失败结果。

当前上游调用默认 60 秒超时，响应最大 1 MiB。推理服务异常不把内部密钥、节点路径或原始异常直接返回用户。

`GET /api/requests?key=<Idempotency-Key>` 接受会话或 API Key，只返回本人请求的 `{id,status,reserved,amount,modelId,createdAt,result}`。pending 的 result 为 null，succeeded 为已结算完整回复，failed 为已保存错误。不存在或不属于本人均为 404。该只读接口不会重新调用推理服务。

## 已实现服务器接口

以下接口仅管理员可访问，所有写操作需 CSRF。

| 方法   | 路径                           | 用途                                 |
| ------ | ------------------------------ | ------------------------------------ |
| GET    | `/api/admin/servers`           | 节点摘要列表                         |
| POST   | `/api/admin/servers`           | 登记节点，返回一次性 Token           |
| GET    | `/api/admin/servers/:id`       | 节点、GPU、部署及最近状态            |
| PUT    | `/api/admin/servers/:id`       | 编辑元数据、维护及调度开关           |
| POST   | `/api/admin/servers/:id/token` | 轮换节点 Token，只展示新明文一次     |
| DELETE | `/api/admin/servers/:id`       | 满足无占用、无待执行任务条件后软删除 |

登记请求：

```json
{
  "name": "杭州 GPU 01",
  "region": "杭州",
  "inferenceHost": "http://10.0.0.8",
  "portStart": 8000,
  "portEnd": 8031
}
```

name 为 1–80 字符、region 为 1–80 字符。inferenceHost 仅 scheme + host，不含 userinfo/path/query/hash；主机必须是部署者控制的 IP 字面量；不支持 DNS 名、端口或路径，拒绝 link-local 元数据地址。端口范围在 1024–65535 内，首版最多 32 个端口；平台从中分配，不接收 Agent 任意 URL。

登记响应为 `{server:Server,agentToken:"node_..."}`，初始状态 pending，gpus=[]。服务器列表和后续 GET 不得返回 token 明文或 hash。

Server 投影包含 id、name、region、inferenceHost、portStart、portEnd、status、schedulingEnabled、maintenance、lastHeartbeatAt、inventoryError、gpus、allocatedGpuCount、freeGpuCount。status 为 pending/online/offline/disabled；先判断禁用，再判断心跳。maintenance 为独立标志，不覆盖离线状态；维护节点的现有健康服务仍可接流。

修改主机或端口范围时，若有活跃部署、任务或占用则返回 409。删除有占用节点返回 409 `server_in_use`。离线状态不会绕过该条件。

## 已实现部署接口

| 方法 | 路径                                       | 用途                                  |
| ---- | ------------------------------------------ | ------------------------------------- |
| GET  | `/api/admin/deployments`                   | 部署列表，支持 serverId 过滤          |
| POST | `/api/admin/deployments`                   | 原子预留并提交启动任务，202           |
| GET  | `/api/admin/deployments/:id`               | 详情、GPU、健康、关联任务和错误       |
| GET  | `/api/admin/deployments/:id/events`        | 按事件 ID 游标分页，默认 50、最多 200 |
| POST | `/api/admin/deployments/:id/stop`          | 设置停止期望并排空，202               |
| POST | `/api/admin/deployments/:id/retry-cleanup` | 重试停止或清理，202                   |

POST 创建需传 `Idempotency-Key`：

```json
{
  "serverId": "server-uuid",
  "modelId": "qwen-local",
  "gpuUuids": ["GPU-example-a", "GPU-example-b"],
  "replaces": "old-deployment-uuid"
}
```

replaces 可省略。GPU UUID 数量等于模型模板 gpus，全部属于同一在线节点，不能重复、缺失或已占用。端口由服务端选择，运行参数取服务端模型快照。

返回 `{deployment:Deployment}`。同一管理员、同一幂等键、相同内容返回原部署；不同内容 409；状态、显存、UUID、端口或资源冲突返回可识别错误。首版一次创建一个副本，多副本通过多个部署实现。

部署 phase 统一为 queued/starting/checking/ready/draining/stopping/stopped/failed/unknown。失败是否释放资源以 allocation 状态为准，不能仅根据 phase 推断。

以下为基础错误码；字段/资源 details 和请求 ID 已接入，最新完整契约见 10 国际化。

| code                    | HTTP | details                             |
| ----------------------- | ---- | ----------------------------------- |
| server_offline          | 409  | serverId                            |
| server_not_schedulable  | 409  | serverId, reason                    |
| gpu_unavailable         | 409  | gpuUuids                            |
| insufficient_gpu_memory | 409  | gpuUuid, requiredMiB, availableMiB  |
| port_exhausted          | 409  | serverId                            |
| deployment_conflict     | 409  | replaces                            |
| model_runtime_missing   | 400  | modelId                             |
| deployment_conflict     | 409  | 当前也用于过期租约或 Agent 代数冲突 |

## 已实现 Agent 协议

Agent Token 使用独立前缀 `node_`，摘要匹配后从服务端记录获得 serverId。所有接口仅作用于该节点；携带用户 API Key 或浏览器 Cookie 不能调用。

### 心跳

`POST /api/agent/heartbeat`，请求示例：

```json
{
  "instanceId": "agent-process-uuid",
  "bootId": "linux-boot-id",
  "sequence": 42,
  "generation": 1,
  "capabilities": {
    "agentVersion": "1",
    "dockerReady": true,
    "driverVersion": "measured-driver",
    "runtimeImageDigest": "sha256:measured-digest"
  },
  "inventoryError": null,
  "gpus": [
    {
      "uuid": "GPU-example-a",
      "index": 0,
      "name": "measured-name",
      "totalMemoryMiB": 81000,
      "usedMemoryMiB": 1200,
      "utilizationPercent": 3,
      "temperatureC": 40,
      "externalBusy": false
    }
  ],
  "containers": [
    {
      "deploymentId": "deployment-uuid",
      "containerId": "docker-id",
      "state": "running",
      "endpointPort": 8000
    }
  ]
}
```

示例设备数据不代表任何具体型号的保证值。未知传感器为 null；采集失败时 inventoryError 非空，不用空 GPU 列表覆盖库存为“所有资源释放”。首版最多 64 张卡、256 个平台容器。

首次 generation 传 null，服务端为合法新实例分配代数。在线节点已被另一 instanceId 持有时拒绝 409；离线后接管增加 generation。成功返回 `{ok:true,generation:1,serverTime:"...",heartbeatSeconds:10}`。

sequence 必须在同一 instanceId 内递增，重复 heartbeat 可幂等确认但不能刷新旧指标覆盖新指标。节点状态按服务端接收时间计算，不信任节点时钟。

### 领取任务

`POST /api/agent/jobs/claim`，请求 `{instanceId,generation}`，返回 `{job:null}` 或任务：

```json
{
  "job": {
    "id": "job-uuid",
    "deploymentId": "deployment-uuid",
    "kind": "start",
    "attempt": 1,
    "generation": 1,
    "leaseToken": "one-attempt-secret",
    "leaseExpiresAt": "2026-10-15T12:01:00Z",
    "spec": {
      "gpuUuids": ["GPU-example-a"],
      "endpointPort": 8000,
      "servedModelName": "qwen-local",
      "artifact": "Qwen/Qwen3-0.6B",
      "revision": "pinned-revision",
      "dtype": "auto",
      "maxModelLen": 4096,
      "apiKeyEnv": "INFERENCE_NODE_KEY"
    }
  }
}
```

模型仓库只作为格式示例。spec 还应携带登记时验证的预期 imageDigest；Agent 仅执行与本地受控镜像 digest 匹配的任务，不接受任意镜像、Shell、主机挂载和明文密钥。

### 续租和回报

- `POST /api/agent/jobs/:id/renew`：`{instanceId,generation,attempt,leaseToken}`。
- `POST /api/agent/jobs/:id/report`：上述字段加 `{eventId,event,message,containerId?}`。
- event 仅 starting、healthy、stopped、failed；message 限 2,000 字符，并限定为安全诊断代码（字母、数字和基础标点），不传原始 Docker 日志。

同一 eventId、attempt 的重报返回 200，不重复更新；内容不一致 409。旧 attempt、generation、已撤销 Token 或其他节点任务不能修改当前部署。

healthy 回报先进入 checking，控制面探测通过后才能 ready。failed 回报不自动释放 GPU；stopped 事件经容器清单确认后才释放。租约过期的 Agent 不继续新副作用，先恢复心跳和对账。

## 已实现语言偏好接口

`PUT /api/account/preferences`，登录用户提交 `{"locale":"ja-JP"}`，需 CSRF，返回 `{"locale":"ja-JP"}`。只接受 zh-CN/en-US/ja-JP/ko-KR；其他值返回 400 `unsupported_locale`。

State.user 增加 locale，未设置的历史用户默认 zh-CN；访客可仅保存浏览器语言偏好。细节以 [国际化](10-i18n.md) 为准。

## Go Agent 双模式增量

Agent 二进制同时支持 inference 与 gpu-rental。节点 workMode 缺失时视为 inference，修改模式需全部资源确认停止。旧 Agent 的心跳仍可用于 inference，缺少 workspaceReady 时不能提交出租任务。

心跳 capabilities 增加 inferenceReady、workspaceReady、workspaceImageDigest、workspaceKeyEnv、inferenceError、workspaceError。两种镜像独立预检，库存失败禁止两种模式调度。出租 start spec.workloadType=gpu-rental，stop 和既有领取/续租/事件协议保持不变。

- `POST /api/admin/rentals`：管理员提交 `{serverId,ownerEmail,gpuUuids}`，需 CSRF 和 Idempotency-Key，返回 `{deployment}`。用户必须已注册、节点为出租模式、对应镜像/密钥配置有效，原子预留整卡和端口。
- `GET /api/state`：State.rentals 返回当前用户被分配的环境，其他人的实例和节点拓扑不返回。
- `POST /api/compute/rentals/:id/access`：仅实例本人、会话及 CSRF，健康新鲜且实例允许运行时返回 `{url}`，内含独立节点 Jupyter 登录凭证。生产要求 HTTPS，节点主机名不得与控制面相同。凭证不保存到 localStorage、账单、日志或共享文档。
- 停止与事件复用 `/api/admin/deployments/:id/stop`、`retry-cleanup`、`events`；停止出租容器会中断 notebook 计算，资源仍须清单确认后释放。

新增错误 node_mode_mismatch、workspace_not_ready、workspace_host_required 均提供四语言映射。管理员分配仍不计费；用户按卡购买、到期回收 API 见 [GPU 订单契约](12-gpu-rental-billing.md#api-契约)。

## 成本和期间报表（已实现）

管理员 GET /api/admin/reports、GET /api/admin/reconciliation、POST /api/admin/costs、POST /api/admin/costs/:id/void 的完整参数、幂等与资金边界见 [v6 契约](13-delivery-status.md#成本和对账契约v6)。

## 账号邮件（C01 已实现）

SMTP 验证/找回/重置 API、权限、限流、有效期和失败状态见 [账号邮件](15-account-mail.md#api)。用户 DTO 新增 emailVerifiedAt:string|null，状态 DTO 新增 mailEnabled:boolean；不返回链接凭证或 SMTP 配置。

## Stripe 在线充值（C02 已实现）

创建/查询本人支付单、管理员分页和原始签名回调接口见 [Stripe 支付](16-stripe-payments.md#api)。状态 DTO 新增 paymentsEnabled、paymentDebt、paymentReview；/api/wallet 同步返回欠款和复核标志。余额与历史账本字段兼容，新增 recharge_refund 可为负数（失败退款/拒付恢复）。

## GPU 预约（C03 已实现）

目录按 hours/startsAt 查询未来容量，新增预约创建、本人/管理员列表与取消接口，GET /api/state 返回本人 reservations，管理员另有 reservationSchedule。Order 新增可空 reservationId/scheduledStart/scheduledEnd；预约报价上限与实际交付费用分别展示。UTC 校验、幂等、固定截止、冲突和取消契约见 [GPU 预约](17-gpu-reservations.md#api)。

## 运维接口（已实现）

GET /api/admin/operations、POST /api/admin/operations/alerts/:id/ack、POST /api/admin/operations/notifications/:id/retry 均管理员限定，写请求要求 CSRF。筛选/游标、告警生命周期、SMTP 重试限制及 /api/health 的 503 语义见 [运维契约](18-operations-alerts.md)。响应新增随机 X-Request-ID，不记录查询和请求正文。

## 结构化错误增量（已实现）

错误保留 error.code/message，增加可选 error.details 和顶层 requestId，与 X-Request-ID 一致。text/int/object 使用规范字段路径和 min/max；资金预占与 GPU 显存不足可返回本人资金/所选资源的 required/available 约束。细分配置错误、单位和允许字段见 [国际化错误契约](10-i18n.md#错误详情交付记录2026-10-16)。客户端不得依赖 message 解析字段或显示上游原文。推理错误保留旧 request_id，失败重放仍使用持久化推理 ID；未创建推理记录的 HTTP ID 只用于诊断。
