# GPU 按卡时长购买与自动计费

本版已实现余额购买、整卡 JupyterLab 交付、到期停止及确认资源回收；真实 Linux/NVIDIA/Docker 节点仍须验收。范围为立即购买同机同型号整卡，1–64 卡、1–720 整小时。支持用户续费及提前退租。本篇描述立即购买；未来固定时段规则见 [GPU 预约](17-gpu-reservations.md)，在线充值见 [Stripe 支付](16-stripe-payments.md)；MIG 不支持。

## 购买与扣费

管理员在服务器编辑表单选择 `gpu-rental`，开启 `rentalSalesEnabled` 并配置 `hourlyPrice`（整数微元/GPU·小时）。旧节点默认关闭销售、价格为零。销售还要求调度启用、非维护、在线、库存正常、空闲卡和端口，以及 Go Agent 的 `workspaceReady`、`expirySupported` 能力。

平台和节点均配置同一 `INFERENCE_JUPYTER_KEY`（至少 32 字符），镜像必须固定 digest。用户访问 Jupyter 的主机名必须与控制面不同；生产环境必须是 HTTPS。目录接口不暴露节点地址、GPU UUID 或任何凭证。

1. 用户选择资源池、卡数和整小时数。报价 = 单卡小时价 × 卡数 × 小时数，CNY，服务端使用 BigInt 检查后保存整数微元。
2. `BEGIN IMMEDIATE` 内检查报价、当前可用余额、GPU 和端口；同时保存价格快照、订单、启动任务和资源占用。下单冻结全额，尚不生成消费账单。客户端不能指定归属用户或实际扣款金额。
3. 控制面首次探测 Jupyter 健康后记录 `startedAt`，`expiresAt = startedAt + hours`。此时仍冻结，等待节点保存到期保护；通常再等待一次心跳才能开放入口。
4. 节点原子保存到期时间并在后续心跳确认；控制面同时确认健康新鲜、容器存在、期望运行、未到期后，原子扣款、清空冻结并写一条 `compute` 账本。重复确认不重复收费。
5. 首次健康前启动失败、到期保护未完成，或下单超过 20 分钟仍未完成交付，释放全部冻结并停止清理；未实际交付不生成消费账单。资源仍需确认清理才释放。

钱包可用余额（无支付争议）= max(0, users.balance − Token 在途冻结 − GPU 订单冻结 − 预约冻结 − paymentDebt)，支付争议期间为 0。两种消费共享同一余额约束。管理员入账保留未结订单潜在退款所需的整数安全空间。修改节点价格不改变已有订单快照。

## 到期、提前停止和退款

- 到期后访问 API 立即拒绝生成新入口；控制面每 15 秒检查到期订单，持久化停止期望和任务。Go Agent 独立检查本机到期时间，即使控制面临时断网也执行 `docker stop` 和 `docker rm`。已打开的连接在容器实际停止时中断；停止存在轮询、Docker 宽限和执行延迟，不宣称零延迟硬截止。
- 正常到期只收约定全额，停止延迟不继续计费。节点离线或 Docker 清理失败期间 GPU、端口仍占用，不重新出售。失败停止任务在 60 秒后自动重试；管理员也可重试清理。
- 管理员提前停止或平台发现已交付容器异常丢失时，以停止请求时间为截止，确认容器删除后退款。计费秒数向上取整，最大为原定时长；消费 = ceil(小时价 × 卡数 × 已用秒 / 3600)，退款 = 已扣全额 − 消费。重复停止和回报只结算一次。
- 退款记录为负数 `compute_refund` 消费，用户钱包展示增加余额。平台净消费收入汇总 Token、GPU 消费和 GPU 退款；充值不算消费收入，模型维度图仍只统计 Token；跨日退款造成负净收入时按带符号的日表展示。
- 工作目录保留，停止任务不会删除用户文件；磁盘保留策略和配额后续另行实现。回收的是容器、GPU 和端口。

管理员原有手动分配接口仍提供无计费、无自动期限的环境，界面明确提示。付费租用必须经过用户订单接口。

## API 契约

所有接口需要用户 Cookie 会话；POST 需要 CSRF，购买还需要 `Idempotency-Key`。API Key 不具备钱包购买权限。

| 接口                                             | 结果                                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `GET /api/compute/offers`                        | `{data: RentalOffer[]}`，仅可销售资源池                                                  |
| `POST /api/compute/orders`                       | 202 `{order: Order}`，原子购买                                                           |
| `GET /api/compute/orders`                        | `{data: Order[]}`，仅本人订单                                                            |
| `POST /api/compute/rentals/:deploymentId/access` | 仅本人、已扣费、已确认保护且未到期的健康环境返回 Jupyter URL；管理员手动分配按原规则检查 |
| `GET /api/state`                                 | 包含本人 orders、rentals、可用余额、冻结及账本；管理员额外获取基础设施                   |

购买请求示例：

```json
{
  "offerId": "<opaque-offer-id>",
  "cards": 2,
  "hours": 24,
  "expectedHourlyPrice": 3000000
}
```

服务端保存并比较这四个字段的幂等指纹。同一用户和同一请求键重试返回原订单，即使库存、价格随后变化；换内容返回 409 `idempotency_conflict`。库存不足返回 409 `gpu_unavailable` / `offer_unavailable`，价格变化返回 409 `rental_price_changed`，余额不足返回 402 `insufficient_balance`。

客户端在网络错误或 5xx 后锁定购买参数，用原请求键重试，避免结果未知时创建第二个订单。语言切换保留输入，不触发购买。

`RentalOffer` 包含 id/name/region/gpuName/memoryMiB/availableCards/hourlyPrice。`Order` 包含 id/deploymentId/resource/cards/hours/hourlyPrice/amount/reserved/charged/refunded/status/createdAt/startedAt/expiresAt/closedAt/accessReady；时间为 ISO 8601 或 null。状态为 provisioning → active → stopping → completed，交付失败为 failed；failed 仍可能等待物理清理，通过 closedAt 区分。

## 数据与节点协议

schema_migrations v4 增加 `rental_orders`，deploymentId 唯一关联部署，`(userId,requestKey)` 唯一。保留价格、预留、扣款、退款、开始/截止/停止请求/关闭/到期保护确认时间。GPU/端口仍使用现有唯一占用表，不创建第二套资源分配机制。

ledger 扩展为 token/recharge/compute/compute_refund；保留旧行 rowid、金额、引用和字段。GPU 消费及退款 reference 分别为 `rental:<orderId>:compute` 和 `rental:<orderId>:compute_refund`，唯一约束防止重复账单。metadata 保存 orderId、cards、hours、hourlyPrice，退款另有 chargedSeconds。

Go Agent `4-go` 心跳上报 `capabilities.expirySupported=true`；控制面返回 `serverTime` 和 `rentalDeadlines:[{deploymentId,expiresAt,revision}]`，只包含本节点订单。节点落盘成功后通过 `expiryAcks` 回传同一截止时间；代数变更或 Token 轮换清除平台保护确认。

Agent 在 STATE_DIR/rental-expiries.json 以 0600 权限保存 bootId 和基于 `/proc/uptime` 的截止时间，临时文件 fsync、rename、目录 fsync 后才确认。进程运行时使用单调时间，同一 revision 的重复心跳不得延长已知期限；只有新 revision 的续费才能延长，已过期本机实例拒绝续费复活。同一开机周期内进程重启继续原期限；整机重启保守地将原租用视为到期并清理，不自动恢复有失效风险的旧环境。目录清理须同时满足控制面不再提供该订单期限、库存成功且容器不存在。

Agent 的 systemd 服务和 Docker 必须正常运行。机器断电时 GPU 不可用；Agent 或 Docker 停止时平台无法承诺离线本机执行，应由运维恢复服务并确认清理。控制面重启读取持久订单立即检查到期，不释放 GPU 订单冻结；原有中断 Token 请求仍按原规则失败解冻。

## 验收

自动测试覆盖 HTTP 权限/CSRF、报价变化、重复和竞争下单、同余额冻结、健康及到期确认扣费、启动失败/超时解冻、到期拒绝访问、离线保留占用、确认停止后退款和幂等。Go race 测试覆盖落盘/恢复、开机周期改变、文件失败不确认、离线停止重试、未到期容器保留、目录保留和并发读写。

生产接入后还必须验证真实单卡/多卡 Jupyter GPU 运算、TLS/WebSocket、断开控制面后到期停止、Agent 重启恢复期限、Docker 停止故障与回收后重新购买。当前不把模拟命令测试当作真机验收。

## 用户续费与提前退租（v5）

用户只能操作本人付费订单。两个接口均要求 Cookie 会话、CSRF 与 Idempotency-Key；不接受客户端指定金额、归属用户或到期时间。

| 接口                                       | 请求              | 响应                                                 |
| ------------------------------------------ | ----------------- | ---------------------------------------------------- |
| `POST /api/compute/orders/:orderId/renew`  | `{hours: 1..720}` | 202 `{order,action}`，续费已扣款、等待节点确认       |
| `POST /api/compute/orders/:orderId/cancel` | `{}`              | 202 `{order,action}`，停止请求已持久化，退款等待清理 |

action 包含 id/kind/hours/amount/status/expiresAt；状态 pending/succeeded/failed。同用户同请求键和同操作内容重试返回原 action 及订单当前状态，参数或操作类型不同返回 409 idempotency_conflict。已结束操作重试也不会再次扣款、延长、停止或退款。

续费只允许健康、在线且已确认期限的 active 订单，原期限至少剩余 30 秒，节点必须上报 renewalSupported=true（Go 4-go）。每次续费 1–720 整小时，延长后的剩余租期最多 720 小时；订单累计小时可以超过 720，已使用的时长不占未来期限额度。同订单只允许一笔等待确认的续费。

在同一 SQLite 事务中，按原订单单卡小时价 × 卡数 × 新增小时计算费用，检查扣除 Token/GPU 冻结后的可用余额，扣款并追加 compute 账本，增加原订单 hours/amount/charged，expiresAt 从原到期时间增加，expiryRevision 加一，保存 pending action。节点改价不影响续费单价。账本 reference 为 `rental:<orderId>:renew:<actionId>`，metadata.renewal=true；资源占用、部署、工作目录和卡数不变。

confirmedExpiresAt 保留原已确认期限。Agent 将新 revision 和截止时间持久化成功，再在心跳中返回匹配的 revision 与 expiresAt；平台确认健康、运行期望和精确版本后更新 confirmedExpiresAt，action 转 succeeded。页面显示原有效期限和待确认的新期限；待确认期间只能保障原期限，不能宣称新期限已经生效。旧 revision 的回报不能确认续费；节点已过期时拒绝延长，不能复活停止环境。

如果原已确认期限到达仍未收到确认，控制面按原期限停止，不继续收取该期限之后的费用；pending action 转 failed。已扣续费与其他未使用费用一起在容器删除确认后退回。清理延迟不追加收费。停止期望一旦写入，迟到的确认不能恢复运行。

提前退租也允许取消 provisioning 订单：未扣款订单全额释放冻结，已扣款订单立即记录停止请求时间并禁止新入口，自动停止容器；未确认续费转 failed。GPU 和端口保留到容器清理确认，随后按本文已有秒级公式从**含续费的总扣款**中扣除已用费用，生成唯一 compute_refund 并退回余额。原单价不变使多个续费时段可以统一结算，不重复收取已使用时间。

新增错误码：rental_not_active、renewal_pending、renewal_too_late、renewal_node_unavailable（409）、renewal_limit（400）；余额不足仍为 402 insufficient_balance。资源离线或清理失败时退款等待确认，系统自动重试清理；用户重复点击或重放请求不会提前释放资源。

schema v5 增加 rental_actions 及订单两个期限字段。Agent 期限文件新增 revisions 字段，兼容旧文件缺省 revision=0；同 revision 仍使用较早的单调截止时间防止时钟修正延长，新 revision 才允许延长。升级保留数据库和节点状态目录，平台无需重建旧订单或重新扣款。
