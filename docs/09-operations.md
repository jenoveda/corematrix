# CoreMatrix 运行与运维

当前支持本地单实例运行，GPU Agent 和部署控制代码已交付。节点配置与 systemd 接入步骤见 [Agent 手册](../agent/README.md)；真实 GPU 启动、模型兼容性及恢复仍需真机验收。

## 当前开发环境

需要 Node.js 22.18+。

```sh
npm install
cp .env.example .env
npm run dev
```

若已有 `.env`，先检查并保留配置，不直接覆盖。`npm run dev` 启动 API 与 Vite，默认端口分别为 3001 和 5173。检查 `http://127.0.0.1:5173/api/health`。

可独立运行 `npm run dev:web` 与 `npm run dev:api`。生产 API 启动命令为 `npm start`，静态页面需先 `npm run build`。

## 管理员初始化

在本机 `.env` 设置 ADMIN_EMAIL、ADMIN_PASSWORD、可选 ADMIN_NAME，运行 `npm run create-admin`。密码至少 12 字符，命令不覆盖已有邮箱或提升普通账户权限。

创建后移除初始化密码；不要把实际测试管理员凭据复制进文档。现有账号和余额位于数据库中，更新前端或文档不会重置它们。

## 当前环境变量

| 变量                                      | 当前用途                                                |
| ----------------------------------------- | ------------------------------------------------------- |
| API_PORT                                  | API 端口，默认 3001                                     |
| DATABASE_PATH                             | 开发默认 data/corematrix.sqlite；生产必须持久化绝对路径 |
| PUBLIC_ORIGIN                             | 浏览器同源写请求来源；生产必填固定 HTTPS origin         |
| INFERENCE_ALLOWED_ORIGINS                 | 外部推理地址精确白名单，逗号分隔                        |
| INFERENCE_ 前缀密钥变量                   | 模型网关读取推理密钥，模型只保存名字                    |
| NODE_ENV                                  | production 时 Cookie 启用 Secure                        |
| ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME | 仅初始化管理员命令使用                                  |

API 默认监听 127.0.0.1。不要为了让远程 Agent 访问而直接暴露开发服务器；应通过受控反向代理提供 HTTPS 接口。

## 生产访问拓扑

同一域名下，反向代理提供 `dist/` 静态资源，将 `/api` 和 `/v1` 转发到 API。部署 `PUBLIC_ORIGIN=https://实际域名`，使用 HTTPS 和 Secure Cookie。

当前单 API + SQLite 只能运行一个写实例。避免多个不同端口的 API 进程同时对同一数据库执行启动恢复；扩容前先完成共享数据库和任务协调。

Agent 需要访问该 HTTPS 域名。控制面需要访问登记的 GPU 节点推理端口；通过防火墙或私网限制为仅网关访问，不把未认证容器直接暴露公网。

## 节点接入准备

按以下顺序接入：

1. 维护者在 GPU 服务器确认 Linux、驱动、Docker 和 NVIDIA Container Toolkit。
2. 使用已验证镜像确认容器内可见相同 GPU UUID。
3. 创建受限 Agent 配置和状态目录，配置固定镜像、受控模型目录及缓存。
4. 管理台登记服务器，取得一次性节点 Token。
5. 配置 Agent 的平台 URL 和 Token，启动唯一 Agent 进程。
6. 管理台检查最新心跳、GPU 数据、预检错误与网络可达性。
7. 配置经过真机校准的模型模板，先部署小型单卡实例验证，再进行多卡测试。

不要在未知主机上执行平台提供的任意 Shell，也不要上传 SSH 密码到控制面。官方环境配置参考 [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)。

## 日常检查

| 检查                                 | 当前或目标                                              |
| ------------------------------------ | ------------------------------------------------------- |
| API 健康、错误率和延迟               | 已实现分组 HTTP 指标、阈值告警和 health；外部探测待部署 |
| 账本余额和请求对应关系               | 已实现每分钟只读对账、持久告警和 SMTP 摘要              |
| 节点心跳与采集异常                   | 已实现，真机待验收                                      |
| GPU 占用与物理容器一致               | 已实现协议与命令，真机待验收                            |
| checking/unknown/stopping 长期未完成 | 持续 5 分钟告警，确认/恢复留痕                          |
| 无健康模型实例                       | 管理台提示，网关拒绝新请求                              |
| 磁盘与模型缓存容量                   | Agent 检查缓存磁盘余量                                  |
| 四语言资源缺失                       | 构建或自动化检查阻止交付                                |

日志记录请求 ID、用户 ID、节点/任务/部署 ID、错误码和耗时。不得记录密码、Cookie、Key、Agent Token、完整环境变量和用户原始 prompt。当前幂等响应保存在数据库中，备份同样需按敏感数据保护。

## 数据备份和恢复

使用 SQLite 一致性备份 API 或在停写后备份完整数据库状态。不要在运行中只复制主 `.sqlite` 文件而忽略 WAL 中未合并数据。

恢复演练应在独立目录和端口进行：停止目标写入进程，恢复备份，检查用户和模型数量、余额、账单、pending 请求及部署占用，再验证登录和读取。不得把测试恢复覆盖到当前开发账本。

部署阶段的恢复还需向 Agent 获取容器清单。数据库恢复到旧时间点后，物理容器可能仍然存在；对账前禁止自动重新分配所有 GPU。

## 故障处置

### 网关调用失败

先根据 request ID 判断 pending、succeeded 或 failed，再决定是否使用原幂等键重试。检查模型上架、路由、密钥变量、白名单、上游 usage 和网络，不手工删除请求记录。

### 节点离线

暂停该节点新部署和新推理接入，保留 allocation。恢复网络与 Agent 后检查完整清单；不能仅因节点显示离线就把 GPU 分配给其他订单。

### 启动或停止结果未知

定位 deployment ID 的平台容器，核对 spec 和任务 attempt。确认真实容器状态后由受控回报和清理流程收敛，不直接修改数据库 phase 或 releasedAt。

### 密钥泄漏

用户 Key 通过撤销/重建处理。节点 Token 轮换后更新 Agent 配置并对账；轮换不代表旧容器停止。推理密钥需要控制面和对应节点同时更新，验证新请求成功后清除旧配置。

## 发布顺序

1. 保存一致性备份并运行迁移测试。
2. 暂停新部署，允许在途推理按既有策略完成。
3. 更新 API、前端和数据库；检查已有会话及账本。
4. 兼容旧 Agent 协议后再逐节点升级 Agent。
5. 验证节点对账、路由和真实调用，再恢复新部署入口。

没有多副本架构之前不承诺 API 发布零停机；不要把模型滚动切换等同于控制面自身高可用。

## GPU 时长购买与到期保护（已实现）

升级 Go Agent 至 4-go、配置 Jupyter 镜像和平台/节点一致的密钥，再启用节点销售和单卡小时价。Agent 在 STATE_DIR 持久化基于本机启动周期的截止时间，控制面断网仍独立停止到期容器。不要清除期限文件后继续运行旧容器。上线前验证真实 GPU、HTTPS/WebSocket、断网到期和重启；细节见 [GPU 购买与计费](12-gpu-rental-billing.md)。

## SMTP 账号邮件

启用环境变量、TLS 规则、一次性链接和投递失败处置见 [账号邮件](15-account-mail.md)。首次上线须用受控收件人验证发送、收取、垃圾邮件、过期和密码重置后旧会话/Key 撤销，不能只把 mailEnabled 当作送达证据。已实现 TRUSTED_PROXY_IPS 精确受信代理与转发链解析；留空仍按 TCP 对端限额，公网前须按实际拓扑配置并清洗转发头。详见 [代理与恢复工具](19-proxy-backup-recovery.md)。

## Stripe 支付运维

固定来源、密钥模式、Snapshot API 版本、Webhook 事件、退款/拒付恢复、欠款以及上线前 Sandbox 验收见 [支付契约](16-stripe-payments.md)。paymentsEnabled 只代表配置存在，不代表真实收款已验收；未配置时保持禁用。渠道重试超期的回调须从 Stripe 重放，不能根据用户截图或浏览器 URL 直接加余额。

## 预约运维

预约保留具体 GPU/端口的时间计划，维护和工作模式变更前检查管理台预约；需要取消时填写用户可见原因。控制面恢复会保留冻结并检查逾期预约，不根据计划时间直接释放物理资源。停止失败的原容器必须确认清理，不能通过删预约/占用表“腾卡”。无需升级 Go 4-go 协议，预约在控制面转换为已有付费订单与固定期限。参见 [预约契约](17-gpu-reservations.md)。

## 运维告警（v10）

管理台“运维告警”已接入每分钟检查、HTTP 分组指标、未恢复/确认/恢复历史和持久化 SMTP 重试队列。配置 OPS_ALERT_EMAIL 和可选 OPS_ALERT_LOCALE 后重启；未配置仍记录但不发邮件。资金检查只读，失败不清除原告警。阈值、权限、通知语义及外部健康探测边界见 [运维告警契约](18-operations-alerts.md)。

## 代理与数据库工具

受信代理 IP、在线备份、只读核验和新路径恢复命令已交付；db:verify 不会偿还欠款或清空占用。已完成本机活跃 WAL/恢复登录测试和当前数据库的独立副本核验，生产 TLS、实际存储/节点恢复仍待验收。命令、退出码、权限与切换顺序见 [代理与备份恢复](19-proxy-backup-recovery.md)。

## 生产模板与多实例模型路由

API systemd、控制台 Nginx 和双模式节点 TLS 模板见 [生产部署](20-production-deployment.md)。它们未安装到当前系统；隔离 Linux 容器已验证真实 Nginx 语法及 HTTPS/ACL/SSE/WebSocket 传输。生产入口验证固定 HTTPS 来源与持久化绝对路径；受管模型采用最少在途/部署 ID 排序，v11 仅新增部分索引。实际 systemd、生产证书、模型/Jupyter 与节点访问仍需目标环境验证。

Linux API/Agent 的可复现检查见 [服务与运行检查](20-production-deployment.md#可复现的-linux-服务与运行检查)。`npm run test:linux` 已验证 systemd 252 的 API unit、非 root 管理员初始化/生产入口/数据库权限/重启，以及 18 项 Agent 和 146 项 Node 测试；仅使用私有副本与 tmpfs，不读取真实配置或账本。systemd 的实际启停/沙箱和 Docker/GPU 节点仍是独立验收门槛。
