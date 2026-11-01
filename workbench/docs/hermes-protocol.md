# Hermes 连接与会话协议

## 进程与连接

1. 启动应用服务，默认监听 `127.0.0.1:4318`；此时不启动模型推理。
2. 用户先独立安装并配置 Hermes，验证正常对话后，再在工作台点击连接。工作流执行与受限控制会话使用 `python/workflow_gateway.py`；普通总控使用独立的 `python/supervisor_gateway.py`。两者加载既有 Hermes 实现，不修改 Hermes 安装；总控先验证 OS 隔离及受控出站代理，再启动专用 profile。
3. 工作目录为本工程；`HERMES_PYTHON_SRC_ROOT` 和 `PYTHONPATH` 指向实际 Hermes 安装。协议走 stdin/stdout，诊断 stderr 单独接收。
4. 收到 `gateway.ready` 后调用 `client.capabilities({server_requests:true})`。
5. 核对 `approvals.mode` 为 `manual` 或 `smart`，通过 `model.options(explicit_only=true,include_unconfigured=false)` 读取当前选择及已配置提供商。浏览器只获得提供商、模型标识和认证状态；端点、密钥等完整配置不返回前端或写入日志。认证、端点解析及 fallback 由 Hermes 管理，工作台不限定 `openai-codex`。
6. 应用退出时中断仍在运行的本应用会话，关闭 stdio 并等待自己启动的进程退出。

模型请求均由 Hermes 发出，工作台没有第二条模型调用链。本地内置工具与代码进程不启动模型，也不要求先连接 Hermes；Python worker 使用配置的可用 Python 解释器。后续如果引入 Pi 或其他模型运行时，应增加完整 Agent 适配器，而不是只替换一个模型 URL。

普通总控主题绑定持久 Hermes session，原生 Agent 负责工具调用循环、Skills、记忆和压缩；应用工具经绑定轮次的 stdio 回调进入原 dispatcher。独立助手、学习控制和来源绑定的只读总控诊断继续使用各自受限策略，不因总控改造取得原生工具。配置／认证快照和只读技能来源由宿主准备，原始 Hermes 私有资料保持原位；详细身份、恢复及执行限制见[总控原生会话](supervisor-native.md)。

总控连接管理经 `workbench.connections.inspect`／`.manage`／`.respond` 复用 Hermes 原生目录、连接处理及授权卡；不将原生 `manage_connections` 直接开放给隔离 Agent。模型只发起管理请求，用户在绑定主题的卡片确认、登录或填写凭据，敏感字段不进入模型回执。工作流不能管理连接。

工作流与两类助手通过同一宿主工具通道调用本机／私网 MCP 和桌面驱动：`workbench.local-tools.catalog`／`.mcp`／`.desktop` 只接受已登记服务或获准应用及宿主绑定范围。工作流内 `mcp__*`／`computer_use` 保留原生工具循环，通过服务端 JSON-RPC `workbench.local-tools.call` 回调；运行、节点尝试、随机令牌、工具集合和调用身份均由宿主校验，结束后失效。总控使用对应应用工具，原生直接和延迟 MCP／桌面入口不旁路执行。两条入口都重新核对人工权限、目录、版本及当前操作审批，见[软件接入](skill-integrations.md#软件接入)。

顶部模型入口通过受限的 `workbench.model.set` 调用 Hermes 原生 `switch_model(is_global=true)` 和 `persist_model_selection`，更新 Hermes 全局默认选择。提供商必须由模型目录明确标记为 `authenticated=true`；模型可从建议清单选择或手动填写 ID，由 Hermes 核验。遇到费用、数据策略等选择提示时拒绝在工作台代为确认，用户须在 Hermes 原生界面处理后刷新。只有 RPC 结果及重新读取的目录均与请求的提供商、模型完全一致，工作台才确认切换成功。

会话创建、工作流运行准入和学习批次准备时分别固定主提供商与模型；运行内的 Skill、修改尝试与子流程，以及学习批次内的样例、评价、诊断与改写沿用固定选择。默认模型切换不改写已有记录。固定的是主提供商与模型，Hermes 的认证及 fallback 仍由其自身配置管理。`WORKBENCH_HERMES_MODEL` 和旧本地 `defaultModel` 均不覆盖 Hermes 默认选择。

当前接口已核验 Hermes 0.21.4，不代表所有 Hermes 版本均已验证。安装及独立对话验证步骤见 [使用说明](user-guide.md#启动)。

## 工作流原生定时

既有 `POST /api/workflow-schedules` 及更新、暂停、删除界面保持；SQLite 保存工作流和输入的冻结定义。生产 Hermes 适配器使用 `python/workflow_scheduler.py` 专用 stdio 进程，按任务时区使用独立私有 cron profile。它复用 Hermes 的 `cron.jobs` 存储、`compute_next_run`、`get_due_jobs`、`claim_job_for_fire` 和 `cron.executions` 账本；单次映射原生 once，每日映射原生 cron。Node 不另做生产到期扫描，也不启动模型判断是否该执行。

原生 fire 回执绑定定时 ID、定义哈希、原生 job／execution ID、计划时刻和下一时刻，宿主先持久核对，再进入既有 `WorkflowRuns`。文件与 Skill 预检、工作流归属、归档暂停、忙碌跳过及人工审核沿用原准入；定义或生命周期变化后的迟到 fire 不运行。原生账本的 `workflow-admitted` 只表示触发已交给工作流，业务成功与产物仍以工作流运行及审核记录为准。

这不是系统开机 daemon：工作台服务必须运行、电脑必须唤醒且可执行。关闭或睡眠期间错过的触发跳过；中断后的未确认 claim 保留 unknown，不重放。现有界面继续只提供单次／每日，不把 Hermes 支持其它时间表达式等同于界面已开放。每日任务遵循原时区语义：不存在的本地时间跳过，重复分钟只选首次；原生引擎故障明确报告不可用，不降级成应用计时器。原生专用 profile 不修改用户原 Hermes cron 配置或业务工作流快照。

## 代理继承

每次启动 Hermes 子进程前，工作台先合并当前进程与显式子进程环境。只要其中存在 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 或对应小写键，就完整保留显式代理选择，包括空值，不再用系统代理补齐。此规则不改模型、提供商或认证配置。

上述规则描述工作流 gateway。原生总控使用宿主管理的出站代理：原生进程只可连接该代理，不能直接使用系统代理或访问本机工作台。宿主可沿已有代理配置访问公网目标，但仍须拒绝本机／私有目的、验证解析后的地址并防止绕路；网络能力不是任意本机服务访问权，见[原生隔离](supervisor-native.md#进程文件与网络隔离)。

没有显式代理键时，仅在 macOS 有界、只读查询系统静态 HTTP／HTTPS 代理，将已启用且地址、端口有效的项投影到 Hermes 子进程环境。已有 `NO_PROXY`／`no_proxy` 保留；缺省时转换系统 `ExceptionsList` 中有效的主机、域名与 CIDR 项，并包含本机回环地址，复杂通配与简单主机排除规则不转换。其它平台、读取失败或没有有效静态项目时保留原环境；PAC-only、自动发现和 SOCKS-only 不被猜测转换，也不下载或执行 PAC。系统或环境代理变化对下一次 Hermes 子进程启动生效。

该步骤只准备网络环境，不修改系统代理、Hermes 安装或配置，不主动探测网络、不发起模型调用，也不重试业务工作流。`hermes.proxy.environment` 日志仅记录固定来源、状态、诊断码与协议数量，见[应用日志](application-logging.md)；采用代理不代表已经连通、认证或完成模型任务。助手可按现有软件日志权限读取这些诊断，没有代理设置或修改入口。

## 数据边界与身份

三个 ID 必须区分：

- `id`：工作台自己的 UUID，用于页面和应用 API。
- `storedSessionId`：Hermes 持久会话 ID，用于重启后恢复。
- `runtimeSessionId`：当前 Hermes 子进程中的会话 ID，每次恢复可能改变。

普通 Hermes 任务与总控原生会话的历史由 Hermes 持久管理，工作台保存应用元数据及页面消息投影；旧应用助手正文继续保留在原记录中。原生历史通过 `session.history` 读取。第一条消息前 Hermes 可能还没有持久会话；空会话在进程重启后按已记录的主提供商与模型重新创建，不伪称已恢复一段不存在的历史。未记录模型的旧空会话拒绝重建。恢复有历史的会话时核对 Hermes 实际返回的模型与已记录选择；工作流及学习托管历史使用只读延迟恢复。

旧工作流运行或学习批次缺少主模型时，仅在关联会话能够确认唯一提供商与模型的情况下补回；无法确认则拒绝继续模型步骤，保留已有产物和审核结果，不采用当前默认模型猜测恢复。

默认工作目录为项目根目录 `workflow/`，相对目录 `.` 直接使用该根。执行原件放在独立本机应用数据目录，交付副本放在 `workflow/outputs/` 或指定位置。显式配置优先；旧 `workspaces/`、`.local/` 及历史路径保留可读。项目、任务与产物由应用管理并关联到会话和运行；Hermes 保持上下文及聊天历史的唯一权威。

## 最小业务接口

Skill 工具扩展提供 `workbench.tools.catalog`、`workbench.skills.catalog`、`workbench.skill.create`／`workbench.skill.delete` 与 `workbench.image.provider`，分别用于只读依赖／来源目录、人工创建／归档删除和图片服务选择。它们不进入模型工具目录；生成回执与删除身份见[来源与删除](skill-integrations.md#来源与删除)，准备／结束仍绑定能力版本和可信图片回执。

| 应用 API | 执行关系 |
| --- | --- |
| `POST /api/connect` | 进程启动、能力握手、`config.get(approvals.mode)`、受限 `model.options` |
| `GET /api/models` | 重新读取 Hermes 当前默认选择、已配置提供商、建议模型及认证状态 |
| `POST /api/models` | 受限 `workbench.model.set`；Hermes 原生全局模型选择、持久化及严格读回确认 |
| `POST /api/sessions` | `session.create` |
| `POST /api/sessions/:id/messages` | `prompt.submit` |
| `POST /api/sessions/:id/interrupt` | `session.interrupt` |
| `POST /api/sessions/:id/resume` | `session.resume` 或连接内 `session.activate` |
| `GET /api/sessions/:id/history` | `session.history` |
| `POST /api/requests/:id/reply` | 对原 JSON-RPC request ID 返回结果 |
| `GET /api/events` | 会话、文字、工具、人工请求等事件的同源 SSE |
| `GET /api/settings` | 工作台本地偏好、受限环境信息；已连接时读取审批模式 |
| `POST /api/settings` | 仅保存白名单中的工作台偏好到本地 SQLite |
| `GET /api/statistics?days=7\|30` | 应用本地运行记录统计；不调用模型或读取账户用量 |
| `GET /api/skills` | 优先读取 `workbench.skills.catalog` 的可信来源；旧网关退回受保护目录，不开放删除 |
| `GET /api/skills/:name` | 确认名称属于技能清单后读取 `learning.detail`，要求 `kind=skill` |
| `GET /api/skills?view=management` | 增加固定只读工作台模板／内部助手说明，不作为可执行节点 |
| `POST /api/skills/:name/delete` | 人工、CSRF、版本和引用核对；生成包受控归档，学习版本保留删除标记 |
| `POST /api/app-assistant/conversations/:id/connections/:operationId` | 绑定总控主题的人工连接授权卡回复；检查当前连接管理权限，不把凭据交给模型 |
| `POST /api/tool-approvals/:owner/:approvalId` | 对准确版本工具请求仅允许本次或拒绝；重新检查当前角色、轮次／运行及权限，重启未完成审批不恢复执行 |
| `GET/POST /api/workflow-schedules` 及既有单项操作 | 读取／保存冻结定义并同步到 Hermes 原生 cron；真正到期由原生 claim 回调原工作流准入 |
| `POST /api/workflow-runs` | 接收 `{document,input}`，校验并准备全链，启动首个能力后返回运行快照；不等待整链或长代码进程结束 |
| `GET /api/workflow-runs?workflowId=…` | 从本地 SQLite 读取最近 20 次运行，可按工作流筛选 |
| `GET /api/workflow-runs/:id` | 读取流程、Skill 元数据、逐节点 I/O、runtime 与日志快照 |
| `POST /api/workflow-runs/:id/interrupt` | 中断当前 Skill 或终止本地代码进程；等待后端确认，尚未执行的节点不再调度 |
| `POST /api/workflow-learning` | 校验学习目标与固定图，创建有轮数上限的学习批次并返回 202 |
| `GET /api/workflow-learning?workflowId=…` | 读取最近 20 个学习批次 |
| `GET /api/workflow-learning/:id` | 读取每轮样例、评价、候选正文及最佳版本 |
| `POST /api/workflow-learning/:id/interrupt` | 停止当前样例 / 控制会话，禁止后续迭代 |
| `POST /api/workflow-learning/:id/apply` | 复核并发布已验证最佳候选，返回可应用到草稿的 execute 文档 |

应用不把任意 Hermes RPC 透传给浏览器。浏览器写操作需要应用启动时产生的校验值，并检查 Host、Origin；服务仅监听回环地址。

## 执行与完成语义

`prompt.submit` 的 `streaming` 响应只表示接受提交。界面继续消费 `message.start`、`message.delta`、`tool.start`、`tool.complete`，直到最终 `message.complete`。

只有 `status=complete` 且没有 `error/partial` 才记为成功。停止记为 `interrupted`；请求超时或进程消失记为 `unknown`，恢复历史后核对。应用不会在断连后自动重复发送任务，以免重复产生文件或外部副作用。

首次验收还需读回真实文件并核对随机标记，因此“模型说完成”不单独作为通过依据。


受保护助手准备接受可选规范UUID `request_id`，绑定当前控制调用。`model.request.trace` 仅投影实例SDK的时序、HTTP状态、请求关联ID和固定SSE类型计数；Node核对已登记session与requestId后写入专用有界元数据表，不原样转发浏览器。`assistant.trace`读取该记录不恢复原生会话，`assistant.experiment`只在人工独立授权后使用新受保护会话发送合成文本，详见[请求级链路](application-diagnostics.md#请求级链路与近似实验)。
