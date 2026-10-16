# 流式推理与 Token 结算（C04，已实现）

共享模型支持 `POST /v1/chat/completions` 的 JSON 与 SSE 两种返回方式。使用平台模型 ID、会话 + CSRF 或 Bearer API Key，以及本人范围唯一的 `Idempotency-Key`。模型选择、预算、余额预占、部署排空、价格快照和原子结算复用原网关，不新增独立资金链。

## 协议

请求 `stream=true`，`n` 省略或为 1；仅支持 system/user/assistant 文本消息。网关向上游强制发送 `stream_options: {include_usage:true}`。默认总超时 60 秒，上游总响应最多 1 MiB。当前不接受工具调用、音频、多候选、图片输入或估算用量结算。

上游必须是 text/event-stream，逐条 JSON 的 choices 为零或一个，文本增量位于 delta.content/refusal。结束原因仅 stop、length、content_filter；结束后必须有且只有一条 choices 为空的最终 usage，然后 `[DONE]`。最终 prompt/completion Token 为整数、非负且不超过原预占上限；可选 total_tokens 必须等于两者之和。缺失、重复、不完整、非法 UTF-8、越界、超时或上游错误均失败解冻，不产生成功消费账单。

此契约参照 [OpenAI 流式事件](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events) 和 [Chat Completions 参数](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。不同兼容服务对最终 usage 的支持仍须实际验证。平台协议刻意要求完整结束标记后才结算；不能仅凭输出文本推算金额。

平台重写流中的 id/model/created，不暴露内部模型名、节点地址、密钥或原始异常。前端显示每个增量，直到最终结算事务成功才发送含 usage 与 billing 的最后帧，之后发送 `[DONE]`。金额仍为整数微元，billing 单价为原请求价格快照。

```text
data: {"id":"平台请求UUID","object":"chat.completion.chunk","created":1792000000,"model":"平台模型ID","choices":[{"index":0,"delta":{"role":"assistant","content":"你好"},"finish_reason":null}]}

data: {"id":"平台请求UUID","object":"chat.completion.chunk","created":1792000000,"model":"平台模型ID","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"平台请求UUID","object":"chat.completion.chunk","created":1792000000,"model":"平台模型ID","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19},"billing":{"amount":66,"currency":"CNY","unit":"micro_yuan","inputPrice":2000000,"outputPrice":6000000}}

data: [DONE]

```

以上仅为结构示例。流开始前的错误采用普通 HTTP/JSON；流开始后的错误采用 SSE `{error:{code,message},request_id}` 和 `[DONE]`，HTTP 已为 200，客户端必须检查 error 及最终 billing。收到 DONE 本身不代表支付成功。

## 停止接收与恢复

界面“停止接收”只关闭下游连接，不取消上游生成。关闭浏览器、网络断开同样如此。服务端继续读取原上游至最终用量或超时；后续生成也计入最终用量并收费。四语言界面在发送前说明该规则。若最终用量无法可信获取，则不向用户收费，平台可能承担上游成本。

浏览器 sessionStorage 只保留 `{key,createdAt}`，按用户和模型隔离，不保存消息正文。断线、未知响应、刷新后重新打开同一模型，查询 `GET /api/requests?key=<原Key>` 恢复：

| 状态      | 行为                                                          |
| --------- | ------------------------------------------------------------- |
| pending   | 显示恢复中，禁用再次发送，周期性只读查询                      |
| succeeded | 显示保存的完整回复与结算用量/金额，并更新钱包                 |
| failed    | 显示原错误并解冻；用户主动再次发送使用新 Key                  |
| 404       | 可能请求尚未到达；至少等待原请求开始后 120 秒再解除本地恢复锁 |

查询需要原用户会话或其 API Key，其他用户与不存在请求均返回 404；不会触发生成。成功 SSE 使用相同请求内容和 Key 重放时，从保存的完整回复生成增量与最终 usage，分块边界可不同；不重新调用或扣费。pending 重试 409；修改 stream 或消息等请求内容 409。旧非流式请求指纹保持兼容。

## 持久化与运行

复用 requests pending/succeeded/failed、response 与原唯一 Token 账本。账单 metadata 增加可选 `streamed:true`，没有迁移或历史金额重算。托管部署只在请求终态后才能停止；下游断开不提前清除 pending。正常 SIGTERM/SIGINT 关闭等待在途 chat Promise 完成后才关闭数据库，包括下游连接已断开的请求。强制终止仍由已有启动恢复将遗留 pending 标记失败并解冻，原 Key 保留，不能自动换 Key 重发。

生产反向代理须禁用 `/v1/chat/completions` 响应缓冲，保留 text/event-stream，并将读取超时设为大于上游总超时；响应提供 `X-Accel-Buffering:no`、`Cache-Control:no-cache,no-store`。强制退出的上游成本仍需运营记录，不能伪造用户成功账单。

## 验证记录

- `tests/streaming.test.ts`：分片 UTF-8/BOM/CRLF、多行、字节上限；发送早于完成；API Key、越权、预占、同 Key pending/完成重放、请求内容冲突和改价快照；下游断开仍结算；缺少 usage/DONE、非法/越界/总数错误、工具调用、过大、超时和错误类型均解冻；正常关闭等待断开后的在途推理。
- 全套 Node 测试 55 项通过，前后端 TypeScript 与 Vite 构建通过。
- 隔离内存 API 和 Chrome：逐段文本、完成前无费用、四语言切换、375px、停止接收后关闭/刷新恢复、无重复生成或扣款、非流式回退、缺失 usage 不收费及对账通过。未向日常数据库写测试账户或资金。
- 未部署真实推理服务，没有可用 NVIDIA 节点；以上为代码和本地协议证据，不替代真实模型 SSE、GPU、TLS 或 WebSocket 验收。
