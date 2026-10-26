# Hermes 连接与会话协议

## 进程与连接

1. 启动应用服务，默认监听 `127.0.0.1:4318`；此时不启动模型推理。
2. 用户点击连接，服务使用 Hermes venv 的 Python 启动 `python/workflow_gateway.py`；该入口加载现有 Hermes gateway，并加入工作台自己的 Skill 快照 RPC，不修改 Hermes 安装。
3. 工作目录为本工程；`HERMES_PYTHON_SRC_ROOT` 和 `PYTHONPATH` 指向实际 Hermes 安装。协议走 stdin/stdout，诊断 stderr 单独接收。
4. 收到 `gateway.ready` 后调用 `client.capabilities({server_requests:true})`。
5. 读取 provider 与模型目录的受限信息。会话明确指定 `provider=openai-codex`，模型默认复用已配置值。连接、创建、提交和恢复前核对 fallback 与审批策略；非订阅备用路由会阻止运行。完整配置只在服务端瞬时检查，不返回前端或写入日志。
6. 应用退出时中断仍在运行的本应用会话，关闭 stdio 并等待自己启动的进程退出。

模型请求均由 Hermes 发出，工作台没有第二条模型调用链。本地内置工具与代码进程不启动模型，也不要求先连接 Hermes；Python worker 使用配置的可用 Python 解释器。后续如果引入 Pi 或其他模型运行时，应增加完整 Agent 适配器，而不是只替换一个模型 URL。

## 数据边界与身份

三个 ID 必须区分：

- `id`：工作台自己的 UUID，用于页面和应用 API。
- `storedSessionId`：Hermes 持久会话 ID，用于重启后恢复。
- `runtimeSessionId`：当前 Hermes 子进程中的会话 ID，每次恢复可能改变。

SQLite 只保存应用元数据和运行结果。对话历史通过 `session.history` 从 Hermes 读取。第一条消息前 Hermes 可能还没有持久会话；空会话在进程重启后重新创建，不伪称已恢复一段不存在的历史。

工程目录和产物位于 `workspaces/`。后续项目、任务、产物模块继续由应用管理，关联到会话和运行；Hermes 保持上下文及聊天历史的唯一权威。

## 最小业务接口

| 应用 API | 执行关系 |
| --- | --- |
| `POST /api/connect` | 进程启动、能力握手、订阅路由策略检查、`config.get(provider)`、`model.options` |
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
| `GET /api/skills` | `skills.manage(action=list)` 与 `commands.catalog` 的受限投影 |
| `GET /api/skills/:name` | 确认名称属于技能清单后读取 `learning.detail`，要求 `kind=skill` |
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

