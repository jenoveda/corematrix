# CoreMatrix Go 节点 Agent

Agent 已迁移为 **Go 1.24+ 标准库实现**，发布 Linux amd64 / arm64 静态二进制；节点无需安装 Go 或 Python 来运行 Agent。Jupyter 容器内仍需 Python、JupyterLab 及所需 GPU 框架。

同一二进制支持两种节点工作模式：

| 模式       | 执行内容                                       | 交付                                |
| ---------- | ---------------------------------------------- | ----------------------------------- |
| inference  | 按模型模板启动 vLLM，健康检查后接入 Token 网关 | 平台模型 API                        |
| gpu-rental | 按 GPU UUID 启动用户独占 JupyterLab 容器       | 使用者在独立节点地址打开 JupyterLab |

模式在管理台登记/编辑节点时选择。**所有部署和占用确认停止后才能切换模式**。同一张 GPU 不会同时分给模型和用户；第一版不调度 MIG、不混合两种模式运行。

## 构建和安装

开发机安装 Go 1.24+，在项目根目录运行：

```sh
npm run test:agent
npm run build:agent
```

输出 `agent/bin/linux-amd64/corematrix-agent` 和 `agent/bin/linux-arm64/corematrix-agent`。按节点架构复制对应二进制，无需在节点编译。

```sh
sudo install -m 755 corematrix-agent /usr/local/bin/corematrix-agent
sudo install -m 644 corematrix-agent.service /etc/systemd/system/corematrix-agent.service
sudo chmod 600 /etc/corematrix-agent.env
sudo systemctl daemon-reload
sudo systemctl enable --now corematrix-agent
```

迁移旧节点时先停止原服务，再更新二进制及 unit，沿用环境文件和 state 目录。重启可能等待旧心跳超过 45 秒后接管；保留原有容器、GPU 占用和模型目录。Go 的配置摘要兼容旧 Agent 容器标签，已有匹配容器会复用。

## 节点登记与环境

需要 Linux、NVIDIA 驱动、Docker 和 [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)。在管理台登记名称、地区、工作模式、控制面可达的 IP 和最多 32 个服务端口，保存一次性 Agent Token。

把 `agent.env.example` 复制为 `/etc/corematrix-agent.env`，填写实际值。Token 和共享密钥不要写进命令、文档或版本控制。生产控制面通过 HTTPS 反向代理开放 `/api/agent/`；API 默认仍监听 localhost。

| 配置                                   | 用途                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------ |
| COREMATRIX_URL                         | 控制面 HTTPS 源地址；本机 HTTP 默认可用，受控网络测试需明确 ALLOW_HTTP=1 |
| COREMATRIX_AGENT_TOKEN                 | 节点一次性凭证                                                           |
| COREMATRIX_RUNTIME_IMAGE               | vLLM 的 `repo@sha256:digest`；仅出租节点可留空                           |
| COREMATRIX_WORKSPACE_IMAGE             | 包含 Python、JupyterLab、GPU 框架的固定 digest 镜像；仅推理节点可留空    |
| COREMATRIX_MODEL_DIR / CACHE_DIR       | 只读模型目录与引擎缓存                                                   |
| COREMATRIX_AGENT_STATE_DIR             | 单实例文件锁目录                                                         |
| COREMATRIX_INFERENCE_LOOPBACK          | 设 1 将新推理容器发布到 127.0.0.1，供双模式 TLS 代理；未设/0 保留旧映射  |
| COREMATRIX_SHM_SIZE                    | 真机校准后的共享内存尺寸；示例 8g 不是容量保证                           |
| COREMATRIX_WORKSPACE_DIR               | 按实例 UUID 保存独立用户工作目录                                         |
| COREMATRIX_WORKSPACE_KEY_ENV           | Jupyter 主密钥变量名，默认 INFERENCE_JUPYTER_KEY                         |
| INFERENCE_JUPYTER_KEY                  | 至少 32 字符随机密钥，控制面和节点配置同值                               |
| COREMATRIX_WORKSPACE_BIND_IP           | 默认 127.0.0.1，供节点 HTTPS 代理；受控私网测试可改 0.0.0.0              |
| COREMATRIX_WORKSPACE_CPUS / MEMORY_MIB | 每张 GPU 对应容器 CPU / RAM 上限，默认 4 核 / 16384 MiB                  |

至少配置一种镜像。两种镜像独立预检和后台拉取，某一种失败不会阻塞另一种模式的能力上报；GPU/Docker 库存失败则停止新调度。预检验证固定 digest、容器可见 GPU；出租镜像还验证能导入 JupyterLab。

## 推理模式

管理员配置 managed 模型的仓库或 `/models/受控目录`、固定 revision、dtype、TP、上下文与经实测校准的单卡最低显存。选择推理模式节点及空闲 GPU 创建部署；控制面验证模型 ID 和真实文本请求后才接流。密钥通过 INFERENCE_ 环境变量配置，任务只传名字。

切换模型使用独立空闲 GPU 和端口；新实例失败时保留旧服务，就绪后排空旧请求，再停止容器和释放资源。

## 按卡出租与 JupyterLab

1. 将节点工作模式设为 gpu-rental，准备符合 GPU/CUDA 的 Jupyter 镜像。镜像需在 PATH 提供 `python` 和 `jupyterlab`，支持 UID/GID 1000 运行。
2. 在控制面和节点环境设置同一个 `INFERENCE_JUPYTER_KEY`，重启对应服务。每个实例使用 HMAC 派生独立访问凭证，主密钥不会进入任务、容器或用户响应。
3. 付费销售：在服务器编辑中开启按卡销售、设置单卡小时价；使用者在“独享算力”选择卡数和时长购买。免费手动分配：管理台“模型部署 → 分配 GPU 算力”填写使用者邮箱、节点和 GPU UUID。
4. Agent 启动独立容器：仅暴露选中 GPU，挂载独立 `/workspace`，非 root 用户、去除 capabilities、禁止新增权限，并限制 CPU、RAM、进程数。
5. Agent 和控制面均确认 Jupyter API 健康后，使用者在“独享算力”打开自己的 JupyterLab。平台不向其他用户或管理员返回该用户的登录链接。

当前 Go Agent 4-go 支持按卡时长购买的到期保护。管理台为 gpu-rental 节点启用销售并配置小时价，用户自助购买；先冻结余额，Jupyter 健康且节点持久化期限后才扣款。管理员手动分配仍不计费且无自动期限。详见 [订单与计费](../docs/12-gpu-rental-billing.md)。

Agent 在 STATE_DIR/rental-expiries.json 保存基于本机启动周期的到期时间，运行期间使用单调时钟；控制面断网仍每秒检查并停止到期容器。进程重启恢复原期限，机器重启保守停止旧租用；停止不会删除工作目录。请保留状态目录并保持 systemd Agent 与 Docker 运行，升级前不要清除状态文件。文件损坏会拒绝启动，需人工核对并停止失去期限保护的容器，不能直接删文件继续销售。

### 浏览器地址与 HTTPS

Jupyter 使用**独立于控制面主机名的节点地址**，防止用户 notebook 与管理台共用浏览器源或账号 Cookie。节点登记 IP 必须同时能被控制面和使用者访问；私网节点的使用者需要相应网络/VPN。平台不会把控制面会话 Cookie 代理给用户容器。

生产访问要求 HTTPS。双模式节点用 `COREMATRIX_INFERENCE_LOOPBACK=1` 和默认 `COREMATRIX_WORKSPACE_BIND_IP=127.0.0.1`，由节点代理监听实际 IP 的相同分配端口，避免 vLLM 的全部网卡绑定与 TLS 代理冲突。设置只用于新容器；变更前先排空并确认停止现有实例，不删除分配或本机期限文件。

完整模板见 [节点 TLS 配置](../deploy/nginx-node.conf.example)，步骤见 [生产部署](../docs/20-production-deployment.md#双模式-gpu-节点的-tls)。替换节点 IP、控制面来源 IP、证书，并补齐登记范围内的全部 listen 端口。IPv6 listen 需方括号。/v1 只允许控制面，Jupyter 路径保留本人独立凭证、WebSocket 和 Secure Cookie；Jupyter 仅在 loopback 后端信任已清洗的代理头。证书必须被控制面和浏览器信任，不关闭验证。

Jupyter 登录链接含实例凭证，只交付使用者，不记录查询串。模板使用无 URI 的安全访问日志，关闭可能包含完整 Token URL 的原始代理错误日志；通过状态和 Agent 固定诊断定位。不能只关访问日志却继续记录敏感错误 URI。详见 [Jupyter 官方安全说明](https://jupyter-server.readthedocs.io/en/latest/operators/security.html)。

## 停止、故障与数据

- 心跳 10s、轮询 5s、租约 60s、续租 20s、健康失效 45s、启动上限 20min。Go 使用服务端时间计算保守的本地单调时钟租约。
- 心跳、镜像预检和任务执行并发，拉镜像不会停止续租。HTTP 不跟随重定向，不打印原始 Docker 输出、Token 或密钥。
- 停止先移除匹配标签容器，再上报新鲜清单。只有无容器、无在途请求时，平台才释放 GPU 与端口。
- 节点失联、租约到期或停止失败保留占用，管理员可恢复节点并重试清理；轮换凭证不删除容器。
- 停止 Jupyter 会终止其中正在运行的计算，管理员应先与使用者协调。停止保留工作目录，不自动删除用户文件；清理与备份由运维执行。
- Jupyter 已限制 UID、权限、进程数、CPU 和内存，并具备持久化到期保护、续费版本确认及统一订单/退款规则；实际资源限制与到期行为仍需真机验收。容器共用宿主内核，当前没有 VM 级隔离、磁盘配额或独立网络策略；对外开放前按真实租户风险和容量补齐运营隔离，磁盘不足会阻止新调度。

自动检查覆盖 CSV、旧配置摘要、Docker 参数、两种执行模式、重报、租约、重定向、凭证与资源隔离。真实单卡、多卡、Jupyter kernel GPU 运算、WebSocket 和故障恢复仍按 [真机验收矩阵](../docs/08-roadmap-testing.md#真机验收矩阵) 验证。

## 用户续费（4-go）

4-go 上报 renewalSupported=true。期限包含 revision，递增版本才允许在本机未到期时延长；旧版本期限不能覆盖新期限，同版本不能重新延长。revision 与本机截止一并落盘，fsync 完成后才通过 expiryAcks 确认。兼容 3-go 旧期限文件，将缺失 revision 视为 0；升级保留 STATE_DIR。3-go 节点可继续基础购买与到期停止，但不能续费。
