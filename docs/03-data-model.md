# CoreMatrix 数据库设计

已有账户与账本继续保留，节点管理采用增量迁移。版本 1 已迁移 locale / ledger metadata，版本 2 已迁移节点、GPU、部署、任务和占用表；版本 3 增加双模式和出租使用者字段。物理列以 `server/migrations.ts` 为准，下面节点表的字段清单表示 API 领域投影。

## 通用规则

ID 使用服务端生成 UUID；模型 ID 保留当前业务字符串。金额为 INTEGER 微元，API 时间为 UTC ISO 8601；节点和任务内部持久化时间采用 epoch 毫秒，业务日为 `YYYY-MM-DD` 的 UTC+8 日期。删除采用软删除或明确状态，不对历史账本做级联删除。

GPU 容量和使用量以 MiB 存储。前端按需转换为 GiB；设备型号中的“80GB”不能直接作为实际可用显存阈值。未知传感器值存 NULL，不存伪造的零。

## 已实现表

| 表            | 主要字段                                                                                                                                                                    | 约束与说明                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `users`       | id, name, email, role, passwordHash, balance, dailyBudget, createdAt                                                                                                        | email 唯一；role 为 user/admin；balance 非负且在 JS 安全整数内 |
| `sessions`    | tokenHash, userId, csrf, expires                                                                                                                                            | 关联用户；登录 Token 仅存摘要                                  |
| `api_keys`    | tokenHash, userId, prefix                                                                                                                                                   | 当前每用户最多一个有效 Key                                     |
| `models`      | id, data, deleted                                                                                                                                                           | `data` 为 Model JSON；删除保留记录，ID 不复用                  |
| `requests`    | id, userId, requestKey, fingerprint, day, status, reserved, response, httpStatus, modelId, modelName, inputPrice, outputPrice, inputTokens, outputTokens, amount, createdAt | UNIQUE(userId, requestKey)；status 为 pending/succeeded/failed |
| `ledger`      | id, userId, type, resource, quantity, amount, inputPrice, outputPrice, time, day, requestId, reference, actorId                                                             | requestId 和 reference 分别唯一；type 当前为 token/recharge    |
| `rate_limits` | key, count, expires                                                                                                                                                         | 登录和请求频率限制                                             |

现有 SQL 以 `server/store.ts` 为准；已有 `schema_migrations` 表。节点元数据放在 servers.data JSON；GPU 指标放在 gpus.data JSON。generation、sequence、lastHeartbeat、inventoryError、capabilities、containers 是独立物理列，Token 物理列名为 tokenHash。部署期望、阶段、健康、占用、任务租约和事件均独立持久化。

## 国际化增量

为 users 增加 `locale TEXT NOT NULL DEFAULT 'zh-CN'`，应用层限定 zh-CN/en-US/ja-JP/ko-KR。为 ledger 增加可空 `metadata TEXT` 保存结构化计量，已有中文 quantity 保留为历史原文，不猜测重写。两个字段已经迁移；原有用户和账本保持原值。

## Model JSON 增量设计

保留当前 `id/name/tag/description/inputPrice/outputPrice/gpus/vram/enabled/contextTokens/maxOutputTokens/upstreamUrl/upstreamModel/apiKeyEnv/configured`。

新增字段：

| 字段                       | 类型                      | 规则                                                         |
| -------------------------- | ------------------------- | ------------------------------------------------------------ |
| routingMode                | external / managed        | 旧记录默认 external                                          |
| runtime                    | object 或 null            | managed 部署必填；外部服务可空                               |
| runtime.artifact           | string                    | HF 仓库 ID 或 Agent 模型目录下的绝对容器路径                 |
| runtime.revision           | string                    | HF 固定 revision；本地模型使用受控版本标识                   |
| runtime.dtype              | auto / float16 / bfloat16 | 首版白名单，不接受任意引擎参数                               |
| runtime.maxModelLen        | integer                   | 必须覆盖 contextTokens + maxOutputTokens，且经模型兼容性验证 |
| runtime.minGpuMemoryMiB    | integer                   | 真机校准后的单卡显存最低值                                   |
| runtime.tensorParallelSize | integer                   | 首版等于 gpus，且部署选取相同数量 GPU                        |

原 `vram` 是资源模板展示字段，不能替代实际 MiB 校验。部署保存完整 runtime 快照；后续修改模板不改变已运行实例。

`configured` 对 external 表示 URL 已配置，不代表健康；对 managed 应由可用部署推导，禁止管理员手工指定该字段作为就绪证明。

## 新增服务器表

`servers` API 投影与持久化逻辑字段：

| 字段                            | 类型           | 说明                                     |
| ------------------------------- | -------------- | ---------------------------------------- |
| id                              | TEXT PK        | 平台节点 ID                              |
| name, region                    | TEXT           | 管理员元数据                             |
| inferenceHost                   | TEXT           | 管理员登记的推理主机，不能由 Agent 覆写  |
| portStart, portEnd              | INTEGER        | 允许分配的主机端口范围                   |
| schedulingEnabled               | INTEGER BOOL   | 禁用后禁止新部署和新推理请求             |
| maintenance                     | INTEGER BOOL   | 仅禁止新部署，保留现有接流               |
| agentTokenHash                  | TEXT           | 专用节点 Token 摘要                      |
| activeInstanceId, generation    | TEXT / INTEGER | 当前 Agent 实例与代数                    |
| bootId, lastSequence            | TEXT / INTEGER | 心跳去重，拒绝旧数据覆盖新数据           |
| lastHeartbeatAt                 | TEXT nullable  | 使用服务端接收时间                       |
| inventoryError                  | TEXT nullable  | GPU 或 Docker 采集错误摘要               |
| capabilities                    | TEXT JSON      | 驱动、Docker、Agent 版本及支持的运行模板 |
| createdAt, updatedAt, deletedAt | TEXT           | 历史记录软删除                           |

在线状态由心跳时间和节点标志推导，不把“在线”作为永久布尔值写死。首版删除节点前必须不存在未释放占用或未完成任务。

## 新增 GPU 表

`gpus`：`id TEXT PK`、`serverId FK`、`uuid TEXT`、`index INTEGER`、`name TEXT`、`totalMemoryMiB INTEGER`、`usedMemoryMiB INTEGER NULL`、`utilizationPercent INTEGER NULL`、`temperatureC INTEGER NULL`、`externalBusy BOOL`、`present BOOL`、`observedAt TEXT`。

约束：UNIQUE(serverId, uuid)，利用率在 0–100 内，已知显存使用量不大于总量。整卡 UUID 识别设备，重启后 index 改变不修改占用对象。曾存在而本次未出现的 GPU 标记 present=false，保留历史记录和占用。

## 新增部署表

`deployments` 已实现逻辑字段（runtime 快照放在 spec JSON）：

| 字段                      | 类型              | 说明                                                                            |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| id                        | TEXT PK           | 一个部署对应一个模型实例和一个容器                                              |
| serverId, modelId         | TEXT FK           | 所属节点和平台模型                                                              |
| spec                      | TEXT JSON         | 不可变模型版本、运行模板、节点镜像 digest 和 GPU UUID 快照                      |
| desiredState              | running / stopped | 管理员期望状态                                                                  |
| phase                     | TEXT              | queued、starting、checking、ready、draining、stopping、stopped、failed、unknown |
| replaces                  | TEXT FK nullable  | 被替换部署；一条活跃替换链不得分叉                                              |
| endpointPort              | INTEGER           | 平台分配，不能由 Agent 任意指定                                                 |
| containerId               | TEXT nullable     | 由 Agent 回报后校验平台标签                                                     |
| healthAt                  | TEXT nullable     | 最近成功的服务探测时间                                                          |
| errorCode, errorMessage   | TEXT nullable     | 失败原因，脱敏并限制长度                                                        |
| actorId                   | TEXT FK           | 创建管理员                                                                      |
| operationKey, fingerprint | TEXT              | 部署创建幂等；UNIQUE(actorId, operationKey)                                     |
| createdAt, updatedAt      | TEXT              | 审计和排序                                                                      |

单个部署首版一个副本，多个副本通过创建多个部署实现。跨模型切换使用新 deployment ID，不改写旧部署 modelId。

## GPU 和端口占用

`gpu_allocations`：`id`、`gpuId FK`、`deploymentId FK`、`orderId nullable`、`createdAt`、`releasedAt nullable`。

当前 GPU 占用统一关联 deploymentId，付费租用通过 rental_orders.deploymentId 唯一关联订单，避免维护第二套占用关系。所有尚未 released 的记录均视为占用，包括启动中、异常和等待清理的部署。

必须创建条件唯一索引：

```sql
CREATE UNIQUE INDEX gpu_one_active_allocation
ON gpu_allocations(gpuId) WHERE releasedAt IS NULL;
```

另设 `port_allocations`：`id`、`serverId`、`port`、`deploymentId`、`createdAt`、`releasedAt`，对 `(serverId, port)` 建立同样的活跃唯一索引。容器停止确认后再释放，不能因旧部署已退路由就释放端口。

## 任务和事件

`deployment_jobs`：`id`、`serverId`、`deploymentId`、`kind(start/stop)`、`status(queued/leased/succeeded/failed/cancelled)`、`specSnapshot`、`attempt`、`nodeGeneration`、`leaseTokenHash`、`leaseExpiresAt`、`deadlineAt`、`lastError`、`createdAt`、`updatedAt`。

领取任务时在事务中从 queued 或可重试状态转 leased。每次新领取增加 attempt 并生成租约凭证。租约回报只能更新同一任务、同一 attempt、同一节点 generation。

`deployment_events`：`id`、`deploymentId`、`jobId nullable`、`attempt nullable`、`eventId`、`fingerprint`、`type`、`message`、`createdAt`。UNIQUE(jobId, attempt, eventId) 保证重复回报不会重复推进状态。fingerprint 来自不含租约密钥的规范化事件字段，用于拒绝同 eventId 不同内容。消息最多 2,000 字符，不存密钥和原始环境变量。

## requests 增量

增加可空 `deploymentId FK`，当前外部推理请求保持 NULL。受管请求在费用预留事务中写入所选部署，固定本次目标；pending 请求是该实例排空的依据。

增量索引 `(deploymentId, status)` 用于统计在途请求。不能删除仍被请求记录引用的部署。

## 迁移顺序

1. 使用一致性备份，并建立 `schema_migrations(version, appliedAt)`。
2. 在事务中新增 servers、gpus、deployments、allocations、jobs、events 和必要索引。
3. 为 requests 增加可空 deploymentId，并按国际化迁移增加 users.locale 与 ledger.metadata，不修改已有金额和状态。
4. 为旧 Model JSON 增加 routingMode=external、runtime=null，保留已有 URL 和价格。
5. 更新共享 TypeScript 类型、快照与权限过滤，再开放 API 和前端入口。
6. 空库与现有数据库各执行一次升级测试，再执行二次启动验证迁移幂等。

`CREATE TABLE IF NOT EXISTS` 不能替代已有表的字段迁移。失败迁移应回滚，不得清库重建或修改已创建的管理员账号。已运行新版本写入新状态后，回退旧代码前先停调度并评估兼容性，不能盲目降级。

## 对账要求

每个活跃 GPU 占用都必须关联部署或有效订单；每个 ready 部署都必须有对应 GPU、端口和健康记录；每个成功 Token 请求都必须恰有一条消费账单。对账异常进入运维错误状态，不自动删记录来让数据“看起来正常”。

## 双模式增量（版本 3）

节点 workMode 存在 servers.data 中，旧节点默认 inference；可选 gpu-rental，存在任何未停止部署时禁止切换。deployments 增加 workloadType（默认 inference）和 ownerId；两种任务继续使用同一 gpu_allocations / port_allocations 唯一约束与任务租约。

为兼容现有非空 modelId 外键，出租部署使用保留的软删除模型记录 `__gpu-rental__`，不会出现在模型目录或推理路由。出租实例的 spec.workloadType=gpu-rental，只使用 GPU UUID、端口、受控镜像 digest 和密钥变量名，模型 runtime 字段不参与执行。

出租任务不生成订单或 GPU 账单；用户 State.rentals 仅返回本人实例的 ID、阶段、GPU 卡数、创建时间和分配状态，不包含节点拓扑、主密钥或登录 URL。

## 已实现 v4：GPU 订单与账本

rental_orders 保存归属、部署、卡数、整小时、单价/总价快照、冻结/扣款/退款、状态与关键时间，deploymentId 及用户幂等键唯一。ledger 增加 compute / compute_refund 并保留原账本 rowid。字段和状态见 [GPU 订单数据与协议](12-gpu-rental-billing.md#数据与节点协议)。

## 账号邮件增量（版本 7）

users 新增 emailVerifiedAt TEXT，可空，旧账号保持未验证。新增 account_tokens(tokenHash PRIMARY KEY,userId FK,purpose CHECK verify/reset,expires INTEGER,createdAt INTEGER,UNIQUE(userId,purpose))。仅存随机凭证的哈希，单次消费与密码/会话/Key 更新在同一事务；原余额和账本不改。完整生命周期见 [账号邮件](15-account-mail.md)。

## 支付增量（版本 8）

新增 users.paymentDebt 默认 0、payment_orders、payment_events、payment_refunds，并扩展 ledger.type 支持 signed recharge_refund；逐行保留历史账本。每个事务结束时只用未冻结资金偿还已记录欠款。字段、约束、状态合并、净资金对账与发布验收见 [Stripe 支付](16-stripe-payments.md)。

## 预约增量（版本 9）

rental_reservations 保存用户、节点/资源报价快照、卡数/时段、UUID/端口计划、冻结与取消原因，唯一 (userId,requestKey) 及交付 orderId。rental_orders 增加可空 reservationId/scheduledStart/scheduledEnd，唯一索引限制一个预约一个交付订单。旧账号、余额、密码和账本不重算。预约与订单原子转移冻结，详情及状态见 [预约契约](17-gpu-reservations.md)。

## v10 运维表

ops_alerts 保存候选、触发、首次确认和恢复；未恢复的 code/entityId 唯一。ops_checks 保存最后执行/成功时间和指标快照；ops_notifications 保存摘要载荷与 SMTP 尝试状态，管理员接口不返回收件人或载荷。迁移不改业务表或资金。详见 [运维告警](18-operations-alerts.md)。

## v11 路由索引

新增 requests_pending_deployment（status=pending 的 deploymentId）和 deployments_ready_model（ready、期望运行的 modelId/healthAt），支持最少在途路由及排空查询，不改变历史记录。迁移事务失败会回滚本次 DDL/版本并关闭连接。详见 [生产与路由](20-production-deployment.md)。
