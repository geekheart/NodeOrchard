# 应用日志

日志为全局助手提供故障定位证据，不授予源码、业务执行或权限设置的写入能力。`app.logs` 仍由总控身份与人工 `appLogs` 开关控制，独立工作流助手沿用原有工作流和运行读取入口。

实验性源码修复另由人工 `sourceRepair` 开关和专用工具控制，日志读取不取得该权限。修改前后源码、备份和测试详情保存在私有修复记录，通用日志仅接收允许的操作身份、阶段、状态及计数；记录与回滚语义见[总控源码自修复](application-source-repair.md)。

| 等级 | 用途 |
| --- | --- |
| DEBUG | 请求或内部细节；默认不持久，用户可在启动环境设置 `WORKBENCH_LOG_LEVEL=debug` |
| INFO | 启停、连接、工作流与节点状态、助手诊断阶段等关键生命周期 |
| WARN | 请求被拒绝、取消、部分结果和状态待确认等需要关注的情况 |
| ERROR | 执行、接口或处理失败 |
| FATAL | 启动或服务不可用等致命故障 |

默认阈值为info。日志等级不向助手开放修改入口，不改变用户的模型路由、审批、超时、重试或取消规则。过去未记录的日志无法补造。

## 存储与字段

`application_logs` 位于工作台现有私有数据库，按全局自增ID保存时间、等级、模块、稳定事件名、启动身份和白名单上下文。默认保留最多10000条、4MiB及14天，先到限制先清理；清理仅作用于日志表。新进程沿用持久游标，bootId区分启动；读取时报告当前保留窗口、是否还有下一页及截断状态。

上下文只接收关联ID、状态、阶段、时间与计数等受限字段。错误分类和允许的源码相对定位用于关联排查；原始Error、stack、聊天正文、模型参数、业务输入输出、代码、学习答案、请求体、请求头及凭据不入库。HTTP仅记录固定路由模板，查询参数与未知原路径不持久。读取时再次投影与脱敏，调用方不能传入文件或数据库路径。

高频文本delta和Token快照不逐条持久；状态与诊断阶段变化去重后记录。日志写入或观察失败不改变业务结果，不递归发布日志事件，不因日志故障重试模型或工作流。

聊天文件同步失败记录 `workflow.conversation.persistence.failed`，恢复成功记录 `.synced`，相同失败状态去重；仅含工作流、修订、状态及固定错误分类，不记录文件路径、对话或上下文正文。独立的待同步元数据不改变已完成的模型回复，导出会等待成功刷盘。

Skill 创建、提供商选择及删除通过 `skill.integration.*` 记录操作身份、阶段、耗时和结果。删除区分预检拒绝、确认完成与结果未知；不记录 Skill 正文、包内路径、生成提示词或认证。结果未知不因日志或刷新自动重放，来源与删除边界见[Skill 管理](skill-integrations.md#来源与删除)。

助手模型新增 `assistant.model.state` 事件，保存会话身份、阶段、调用总耗时、等待／输出耗时、字符数量和超时分类；流块不逐块持久。对应 `application_model_calls` 保存数字调用快照，供按归属聚合诊断，旧快照的 running 不证明重启后仍在执行。`assistant.probe.started/completed/failed` 记录固定短探测结果；不保存探测正文。`assistant.turn.state.durationMs` 为轮次时长，原 `elapsedMs` 为进度观察值，不能用最后阶段耗时推算全轮。

Hermes 子进程启动记录 `hermes.proxy.environment`，仅含 `component: hermes`、固定枚举 `source/status/code` 与协议数量 `count`。它区分显式环境保留、系统静态代理采用及未采用原因，不保存代理地址、绕过列表、PAC 内容或凭据。该记录说明启动环境的来源，不证明网络、认证或模型任务成功；继承规则见[代理继承](hermes-protocol.md#代理继承)。

## 全局助手读取

`app.logs` 支持 `minLevel`、`component`、`from/to` 及 `workflowId/runId/nodeId/sessionId/conversationId/turnId/requestId/operationId`，同时支持 `limit` 和 `afterId`。优先读取warn以上，再按关联ID补充info阶段。HTTP响应的 `X-Request-Id` 由服务端生成；页面请求错误自动携带同一ID，助手通过 `page.inspect` 即可关联软件日志。

持久结果使用 `structured.entries`。分页以实际交付的nextAfterId继续，不能用进程内事件序号代替。工具按模型上下文与响应预算交付完整条目，较大的请求可能缩小为更短的交付窗口，hasMore和truncated提示后续可读；不因截断跳过未交付记录。

`currentProcess` 中的Hermes诊断只保留当前进程窗口，不能当作历史日志。日志不可用、debug未开启或记录已过期时，助手说明证据缺口并继续使用真实运行、会话与产物工具，不虚构缺失记录，不要求用户重复粘贴仍可读取的日志。

请求级诊断的详细元数据保存在独立有界 `application_model_request_traces`，不保存任意请求／响应头。只允许上游请求关联ID、状态码、数字Retry-After、时序、固定流事件计数和错误分类；通用 `assistant.request.trace` 日志仅保存会话／控制请求身份、阶段、状态、耗时及HTTP状态。原始payload不发布到浏览器事件历史。链路读取见[请求级链路](application-diagnostics.md#请求级链路与近似实验)。

模型实验 `assistant.experiment.started/completed/failed` 仅记录准入身份、目标总控轮次、调用数、字符规模和状态；合成prompt及模型正文不入日志。持久准入保存在 `assistant_model_experiments`，未知状态不重放，不修改工作流或原始历史。

压缩SSE只在已受保护SDK实例解码后的字节流中统计类型；不另行解压或保存正文，缓存重读不重计。新增观察超过8MiB时明确计数不可观测并继续原业务流；代理隧道TLS计入观测TLS总时长。

请求链路仅保存响应头声明格式与编码的固定枚举（不保存原始头值），以及SSE不可观测的固定原因；旧记录保持unknown/null。头部MIME声明不能代替正文协议证据，更不能把未观测的SSE当作无响应。
