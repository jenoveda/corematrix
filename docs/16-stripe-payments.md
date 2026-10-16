# Stripe 充值与回调（C02，代码已实现，商户环境待验收）

本阶段接入 Stripe 托管 Checkout，为现有 CNY 钱包充值。用户选择金额，创建支付单后前往 Stripe；支付方式信息由 Stripe 页面收集，平台不收集卡号。页面跳转与创建支付单均不增加余额，只有经过验签并向 Stripe API 核实的回调才能记账。

充值、退款与拒付不属于模型消费收入。用户购买 Token/GPU 仍使用现有余额和冻结规则，提前退租的 GPU 费用退款仍回到钱包，与退回原支付渠道的充值退款分开。

## 配置与边界

| 变量                  | 规则                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| STRIPE_SECRET_KEY     | 未配置时关闭在线充值；sk/rk 密钥仅在 API 环境中使用，不发前端                                       |
| STRIPE_MODE           | test（默认）或 live，必须与密钥模式匹配                                                             |
| STRIPE_WEBHOOK_SECRET | 平台专用 Snapshot 事件端点的 whsec 密钥，必填；CLI 转发使用其自己的签名密钥                         |
| PUBLIC_ORIGIN         | 固定 origin，无路径、查询、fragment、用户名或密码；生产 HTTPS，开发 HTTP 仅 localhost/127.0.0.1/::1 |

采用 stripe-node 23.0.0，SDK 当前 API 版本为 `2026-09-30.endive`，版本由 lockfile 固定。Workbench 的 Snapshot 端点须匹配该版本；升级 SDK 时重新核对参数和回调兼容性。当前创建参数使用 allowed_payment_method_types=['card']、ui_mode=hosted_page，关闭 Adaptive Pricing，币种固定 CNY；商户须启用 card 并具备 CNY 收款能力。不是 Stripe Connect 或组织多商户实现，回调携带 account 时拒绝处理。

金额限制为 10–100,000 人民币、最多两位小数，API 使用整数微元，且必须为 10,000 微元的整数倍。Stripe 接口金额换算为分：amount / 10,000；不使用浮点汇率、不同币种换算、优惠券或自动税额改写钱包金额。托管 Checkout 地址限定 HTTPS checkout.stripe.com，暂不支持自定义 Checkout 域名。

SDK 单请求超时 5 秒，最多重试 1 次；进程最多同时创建 8 个 Checkout、处理 8 个不同回调。服务繁忙或核对失败返回非 2xx，让渠道重试。回调处理和数据库提交同步完成，没有先返回成功再丢弃任务；正常进程关闭等待包括已断开连接在内的支付任务完成。

## API

| 方法与路径                 | 权限与请求                                                              | 返回                                                            |
| -------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| POST /api/payments         | 会话 + CSRF + Idempotency-Key；`{amount,locale?}`，金额微元、语言白名单 | 201 `{payment}`，或错误；创建不入账                             |
| GET /api/payments          | 本人会话；可选 before 游标                                              | `{data,nextCursor}`，每页 50 条；只读，不触发 Stripe 请求或入账 |
| GET /api/payments/:id      | 本人会话；不存在及他人订单均 404                                        | `{payment}`，不接受通过 URL 传入 paid 或金额确认到账            |
| GET /api/admin/payments    | 管理员；同样分页                                                        | 全部用户订单，附 email，不返回支付链接                          |
| POST /api/payments/webhook | 不使用会话/CSRF，使用 Stripe 原始请求签名                               | 200 `{ok:true}` 只在已持久化处理结果后返回；同事件重试幂等      |

`payment` 为 id、amount、credited、reversed、review、status、createdAt、expiresAt、checkedAt、checkoutUrl，管理员附 email。金额均为微元。状态为 creating/open/paid/expired/failed/refund_pending/partially_refunded/refunded；creating 表示创建结果待确认。review 独立表示需核查的支付争议。checkoutUrl 只在本人尚未付款且未过期时返回，Stripe 内部 session/intent/charge 凭据和密钥不返回前端。

常用错误：payment_unavailable（未配置、繁忙或核对不可用）、payment_unknown（创建结果未知，使用原 Key 重试）、payment_creation_expired（超过原创建重试窗口）、payment_mismatch（身份/金额/状态无法核对）、invalid_payment_signature、idempotency_conflict。所有会话接口遵循同源和 CSRF；签名回调不依赖浏览器 Origin。

## 创建与恢复

先持久化 payment_orders，记录本人、金额、币种、首次语言和客户端 Key，再调用 Stripe。相同 Key 不同金额 409，相同金额复用原订单及服务端参数；UI 切换语言不改变该订单首次参数。Stripe Idempotency-Key 为 cm_checkout_<平台订单UUID>，同进程并发复用同一 Promise，重启后仍用原 Key 请求渠道。

Checkout 有效期一小时，未知创建结果只允许在原开始后 15 分钟内重试；该限制保证重试仍使用相同 expires_at 且早于渠道幂等保留时限，不在很久后重建不确定的支付单。超时订单保留以便核对，不覆盖或删除；已绑定的会话继续返回原结果，已支付回调仍可安全入账。

浏览器 sessionStorage 只保存用户范围的 `{key,amount}`，未知响应后锁定金额、关闭/刷新后可恢复原请求。收到成功的创建响应后清除本地尝试，历史订单保留在服务端。支付链接在新标签页打开，回到钱包时刷新状态；也可手动刷新。success_url/cancel_url 均指向固定站点钱包，返回页面本身不产生资金变更。创建按账户限制 10 个新订单/分钟，重复 Key 不增加新订单。

## 回调与资金事务

回调最大 256 KiB，要求 application/json。使用 Stripe SDK 对原始字节和 Stripe-Signature 验证时间及签名，再验证 live/test 模式。按事件 ID 去重并保存指纹；相同 ID 不同内容拒绝。同一事件并发只执行一次外部核对。参见 [Stripe Webhook 要求](https://docs.stripe.com/webhooks)。

监听以下 Snapshot 事件：

- checkout.session.completed、checkout.session.async_payment_succeeded、checkout.session.async_payment_failed、checkout.session.expired。
- charge.refunded、refund.created、refund.updated、refund.failed。
- charge.dispute.created、charge.dispute.updated、charge.dispute.closed、charge.dispute.funds_withdrawn、charge.dispute.funds_reinstated。

事件仅用于找到对应本地订单，不信任其中的到账金额或过期状态。通过本服务器密钥重新读取 Checkout，展开 payment_intent.latest_charge，核对平台订单与用户 metadata、client_reference_id、唯一绑定的 Session/Intent/Charge、CNY、金额、到期时间、paid、complete、succeeded、captured。未完成的付款不入账，过期通知不能让已到账余额倒退。与平台无关的事件只记接收记录，不产生充值。流程依据：[Stripe Checkout 履约](https://docs.stripe.com/checkout/fulfillment.md?payment-ui=stripe-hosted)。

入账事务同时增加余额、写唯一 recharge 账单、保存支付关联与 credited、写回调记录。价格单位与原钱包一致；一份 Checkout 只能给一个平台订单入账一次。网络/核对/提交失败不记录已成功处理，渠道重试继续核对。事件只保存 ID、类型、指纹、本地订单与时间，不保存完整带个人资料的原始回调。

## 退款、失败恢复与拒付

当前由管理员在 Stripe Dashboard 发起原渠道退款；平台未新增用户提现或自动原渠道退款入口。渠道退款回调与现有 GPU 退租退款是不同账本动作。

回调会分页读取当前 Charge 的退款历史，每笔存储 refund ID、订单、金额及状态，核对用途、币种与原金额。单笔订单最多自动核对 1,000 笔退款，超限不部分结算、返回 503，须升级后台分页对账后再重放。缺失退款历史、金额冲突或越界也不会确认处理成功。

pending/requires_action/succeeded 退款均先调减可消费钱包，避免退款处理中继续花掉同一笔钱；界面 pending 显示“退款处理中”，不宣称银行已到账。failed/canceled 退回的资金恢复到钱包，先冲减尚未覆盖的欠款，再增加余额。状态合并防止旧 pending/succeeded 快照覆盖已失败/取消状态。同一退款金额不可变，不覆盖旧账单；恢复以负金额 recharge_refund 补偿记录，保留审计链。Stripe 说明退款可能失败或取消，资金返回商户，参见 [退款状态与事件](https://docs.stripe.com/refunds)。

争议处理中 review 冻结新增消费；已授权在途请求及已付 GPU 订单继续按原规则结算。胜诉解除 review；败诉按损失金额调减充值信用，再次资金退回并核实 won 时补偿恢复。结合退款的总信用调减不超过原充值金额，争议与退款重叠不重复向用户扣同一份信用。事件时间与终态优先级防止旧争议覆盖新结论；渠道手续费和额外商户损失记实际运营成本，不假装是用户 Token 消费。

余额不够退回时，记录 users.paymentDebt。每个数据库事务结束时仅用未冻结资金偿还欠款；Token/GPU holds 保持有资金覆盖。释放冻结、后续充值或 GPU 退款都可偿还欠款；剩余欠款/争议期间阻止新的 Token 请求、GPU 下单和续费，退租仍允许。用户端可用余额最低为零，并显示待补缴金额；不把负欠款伪装为可消费余额。

对账恒等式：`余额 − paymentDebt = recharge 入账 − recharge_refund 净调减 − Token/GPU 净消费`。recharge_refund 可为负数，表示退款失败/取消或拒付恢复的补偿。资金核查同时验证各支付单原始入账及净调减汇总，欠款和 review 会进入运维问题列表。报表 credits 为充值净额，消费收入/毛利不包含充值、渠道退款或恢复。

## 数据与发布

schema v8 新增 users.paymentDebt（默认 0），payment_orders、payment_events、payment_refunds，并扩展 ledger.type 支持 recharge_refund。原账本逐行保留 rowid、ID、金额、关联、原文与 metadata，不重算余额或修改密码。SQLite 单实例边界不变。

上线前在 Stripe Sandbox 验证：CNY/card 收款能力、托管 Checkout、成功/取消/失败、重复通知、超时重放、部分/完整退款、pending 到 failed/canceled、争议和恢复，以及现有余额与对账。Workbench 端点设为公开 HTTPS `/api/payments/webhook`，注册以上事件并匹配 API 版本；反向代理保留原始请求体、签名和 Content-Type。服务停机超过渠道重试期时，用 Stripe 工具重新投递相关事件，不人工覆盖余额。

当前支付未配置真实商户密钥，paymentsEnabled=false，不伪造可支付或到账。启用仅表示配置存在，不能替代真实收款验收。维护者在服务器 `.env` 设置密钥，勿发聊天。未调用真实 Stripe API、未使用真实卡或发起真实支付/退款。

## 验证记录

- tests/payments.test.ts：16 项支付专项，包含配置与权限、分单位与限额、未知创建结果/重启、真实 SDK 原始签名、过期签名/篡改、金额/模式/身份不符、并发回调、幂等入账、旧通知、退款先到、处理中/失败/取消、在途冻结/欠款/补缴、拒付与恢复、分页隐私、渠道故障、过大回调、退款历史缺失及断线关闭排空。
- tests/rental-orders.test.ts 新增 GPU 冻结在支付信用调减时仍保留、新购买与续费拦截、退租可执行。
- 全套 Node 测试 79 项；TypeScript/Vite 生产构建与浏览器专项通过。浏览器使用独立内存数据库和本地 SDK 测试回调，覆盖四语言、375px、丢失响应原单恢复、回调前不入账、到账刷新、退款失败恢复、管理端隐私和只读对账。
- 本地测试不是 Stripe Sandbox 或真实商户验收，SMTP 投递、GPU/TLS/WebSocket 真机及全量生产监控等剩余门槛仍见 [交付核查](13-delivery-status.md)。
