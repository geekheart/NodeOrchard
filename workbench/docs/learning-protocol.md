# 学习编排与隔离协议

## 学习编排与候选版本

`WorkflowLearning` 使用独立的 `workflow_learning` SQLite 表和 `learning.run` SSE，不放宽普通执行端点对 `mode=learn` 的拒绝。每个学习批次冻结起始图、样例、答案、评价标准及允许改进的范围；各轮文档只在此范围内变化。内部把每轮文档转为 execute，携带可信的第二参数 `learningId/memoryScopeId/onCreated` 调用同一个 `WorkflowRuns`；浏览器不能通过执行载荷伪造内部授权。学习期间持有工作流锁，整个批次与手工执行互斥。`allowsWorkflow(workflowId,learningId,memoryScopeId)` 同时核对活跃批次、锁、未停止状态和已确认策略，scope ID 必须等于批次 ID。异步 Skill 预检后再次核对，停止后的迟到准备不能创建新运行。

### 学习范围与候选校验

画布的“学习改进”节点使用下列配置，启动请求中的 `scope`、`trainableNodeIds` 只能与图中范围一致，不能扩大授权。旧批次缺省为 `skills`，原 Skill／反馈候选保持兼容。

| `scope` | 节点目标字段 | 允许的候选变化 |
| --- | --- | --- |
| `skills` | `targetSkillNodeIds` | 选定 Skill 的指令正文与固定候选引用；图、工具代码和其它节点保持不变 |
| `tools` | `targetNodeIds` | 指定 `tool`／`transform` 的业务核心配置；工具仅 `code`、`language`、`executionMode`、`toolName` 可变，数据整理仅 `code`、`language` 可变；数据接口、时限、资源、审核、来源和图结构固定 |
| `workflow` | 不另选节点，采用原图业务范围 | 增删内部业务节点、调整配置及连线；保留输入／输出、评价和审核边界 |

工具和工作流候选复用现有原子编辑操作。可把注册工具节点派生为独立业务代码，候选接口不提供注册工具、HDK、应用源码或原 Skill 资源的补丁操作。`workflow-learning-scope.mjs` 在候选生成后及最佳版本应用前复核范围：工作流身份、标题、设置、输入／输出、比较源身份与端口／字段路径、学习支路、原人工审核及其连接均固定。直接观察工具或代码产物时，其业务核心仍可改进；可以新增人工审核加强检查，不能关闭原图片审核要求。已有节点类型与派生来源、Skill 固定引用、子流程来源及内嵌快照保持；新增 Skill 只复用原图的真实固定引用，新增子流程只复用已固定来源。

`tools`／`workflow` 需要用户在设置中开放工作流读取、编辑和自定义节点权限。后续调度和应用重新检查，关闭权限后拒绝继续；助手没有改设置的接口。候选仅在独立学习轮次执行，未应用的文档不覆盖工作流库；完整已验证最佳版本经用户应用到草稿，保留当前视口和已有节点位置，草稿身份、来源或配置变化时拒绝覆盖。普通业务代码在可信本机进程执行，不是 OS 沙箱；上述字段守卫不保证任意代码无法访问其它文件或产生外部副作用。

### 数据集与兼容接口

`shared/workflow/workflow-dataset.mjs` 提供前后端共享的解析、规范化及统计函数。数据集包含至少 **1 条训练样例**，训练与验证合计最多 **20 条**；每个 `input` / `expected` 的完整 JSON UTF-8 编码最多 **64 KiB**，整个规范化数据集最多 **256 KiB**。每条样例有稳定的 `id`、`name`、原始类型的 `input` 和 `expected`；缺省 ID / 名称在规范化时生成。全体 ID 必须唯一；规范 JSON 相同的输入不能重复，也不能跨训练 / 验证组出现或提供互相冲突的答案。

导入支持分组 JSON 或带 `split=train|validation` 的样例数组、每行一条样例的 JSONL，以及 CSV。CSV 用 `input_format` / `expected_format` 明确区分文本和 JSON，避免把 `false`、`0` 或 JSON 对象统一读成字符串；解析错误包含相应记录行号。导入和校验只处理数据，不会启动工作流或模型。

`POST /api/workflow-learning` 接受 `trainingCases` 与 `validationCases`。旧 `input/expected + validationCases` 请求继续映射为一条训练样例；显式提供 `trainingCases` 时不能同时带旧 `input` 或 `expected`，避免歧义。新旧入口均遵守合计 20 条与容量约束，并检查每例输入符合入口类型、答案符合最后能力的输出类型。规范数据集保存在 `job.config.trainingCases/validationCases`；顶层 `input/expected` 保留首条训练样例的兼容投影。

### 完整轮次与指标

第 0 轮是基线，`maxRounds` 包含基线。每轮按固定顺序先运行全部训练样例，再运行全部验证样例；每例都运行完整混合工作流。轮次创建时就预填全部 `cases`，保留 `id/name/role`、输入和答案；未执行项为 pending，没有伪造输出。停止、断线或重启保留已完成结果、当前项的真实状态以及剩余 pending 项。

`round.metrics` 分别汇总 `train`、`validation`、`overall`，每组包含 `total/passed/failed/pending/evaluated/passRate/averageScore/minScore`。分母始终是固定数据集中的预期样例数，包括尚未执行或尚未评分的样例；只有工作流 complete、存在正式输出且有效分数达到 `targetScore` 才通过。执行 error 或 complete 却缺少有效正式输出计为已评估的零分失败；unknown、interrupted、skipped 或尚未有效评分仍待核对。组内全部评估完毕才显示 `passed/total` 通过率，否则为 `null`；空验证组也为 `null`。平均分和最低分只概括已有有效评估，不能替代完整通过率。

精确比较规范文本换行和首尾空白，或深比较 JSON（忽略对象键序，保留数组顺序与值类型）。模型比较逐例单独调用，将该例的完整已知答案、实际输出和 rubric 送入无工具评价会话，返回分数与理由；不把 20 例拼入一条超长评分提示，也不截断答案或输出后宣称完整评分。模型分数是评价模型的估计。只有全部样例的完整执行与评分有效、且全部达到目标分数，批次才达标。

最佳版本只从全部工作流 complete 且评分完整的轮次中选择，依次比较：

1. 有验证组时，训练 / 验证两组通过率中的较小值；无验证组时采用训练通过率。
2. 总体通过率。
3. 总体最低分。
4. 总体平均分。

因此相同最低分下，更多样例通过也能更新最佳版本；不会只比较一个最低分或用平均分掩盖失败。兼容字段 `round.score/job.bestScore` 仍保存最低分。旧记录在 GET / list 时只派生 ID、名称与指标，不重新执行新数据集校验，不改写已存样例或重新排列历史 `bestRound`；再次发起学习才应用新约束。

选中 Skill 的明确输出格式／类型错误，以及工具／工作流范围内已确认的业务代码错误，可保留错误状态和诊断、记零分后生成改进候选。代码错误须有执行器确认的可恢复标记及 `CODE_FAILED`／`OUTPUT_INVALID`／`OUTPUT_LIMIT`，没有正式产物；明确识别的依赖、文件、权限或连接类环境错误（`CODE_ENVIRONMENT`）、解释器启动失败、超时、执行状态不明或完整性失败终止学习。分类依据错误码或异常类型，无法保证识别没有类型证据的包装异常。含执行失败样例的轮次不成为最佳版本，不能用零分诊断冒充执行成功。

### 全训练上下文与分批诊断

后续轮次从最佳已验证文档出发；尚无合格版本时使用当前失败轮的真实诊断。`skills` 轮换调整一个已选 Skill，`tools`／`workflow` 生成允许范围内的节点或图编辑候选。改写上下文覆盖**全部训练样例**的最佳与最近尝试，包括实际结果、分数、反馈、节点实际输入及最近候选差异；不只读取第一条训练样例。不将验证输入、答案、输出或逐例反馈组入改写／诊断提示。验证组仍参与完整评分与版本选择，因此这里只报告用户所给数据集上的结果，不能据此推断为未见数据的泛化能力。

小上下文直接生成候选，记录 `round.optimizerContext=full`。完整提示超过 190000 字符时切到 `diagnostics`，批次阶段显示 diagnosing：逐条训练样例分别完整比较最佳 / 最近尝试的答案与实际结果，再将完整输入、答案及两份诊断归纳为该例摘要，最后用全部训练摘要和候选正文生成新版本。每份诊断必须是严格 JSON，编码后最多 **2048 UTF-8 字节**；中间诊断逐次持久化以供核对。原始样例及已有正式运行结果仍完整保留，诊断超限、结构错误或最终提示仍超预算时明确失败，不静默裁掉样例或截断数据。

`learning.run` 只在新子运行、子运行状态改变、样例完成、评分或其它学习阶段推进时发布。编排器缓存当前子运行的 `{runId,status}`；同一状态下每个文字 / 日志快照不会重写并广播整份学习批次。节点流式显示仍由 `workflow.run` 承担。

Skill 候选仓库 `LearnedSkills` 保存不可变引用 `wb-learn-<UUID>`、正文 SHA-256、来源 Skill／指纹、父版本、批次与节点。未应用候选不进入普通目录。应用时再次校验来源，发布最佳轮次的 Skill 候选供属性选择器使用；工具与图候选保存在各轮文档和修改前后记录中。服务端和编辑器共用范围校验与原快照守卫，只将已验证版本应用到草稿。原 Hermes Skill 不被写入；若来源正文变化，旧候选停止解析，要求重新学习。

Skill 候选执行通过 `workbench.skill.prepare(candidate_content,source_revision)` 复用原 Hermes 原生 scaffold 与资源加载。源包先按原指纹验证并完整复制，再仅替换私有副本 `SKILL.md`；frontmatter 保持一致，源包与候选包分别计算完整性指纹。此路径不编辑源脚本或资源；业务代码和图结构的候选使用上表中的独立范围。

### 整批学习记忆 scope 与确认门槛

新学习批次先进入 `phase=preparing-memory`。`LearningModel.createMemoryScope({id:job.id,signal,onSession})` 创建未发送提示的 anchor 会话，调用 `workbench.learning.memory.capture`，在第一条基线样例前固定一次 Hermes builtin `memory/user` 快照及其启用标记。快照正文仅存在 gateway 进程；SQLite、SSE 和浏览器只保存 scope ID 与策略元数据，不保存这份记忆正文。该批次所有轮次的训练 / 验证 Skill、评分、诊断及改写均绑定同一个 scope，不为后续新会话重新读取实时内置记忆。

编排器必须收到与批次 UUID 一致的 ID、`mode=batch-snapshot`、`memoryWriteAllowed=false`、`externalMemoryAllowed=false` 明确确认，才允许创建首个样例运行或发出学习模型提示。`memoryPolicy` 记录如下：

| `mode` | `memoryWriteAllowed` / `externalMemoryAllowed` | 含义 |
| --- | --- | --- |
| `pending` | `null` / `null` | 尚未确认；不得运行样例、评分、诊断或改写 |
| `batch-snapshot` | `false` / `false` | 本批已确认固定只读内置快照，并禁用外部动态记忆路径 |
| `legacy` | `null` / `null` | 旧记录没有完整批次隔离证据；仅作历史展示 |

已确认记录保留 `memoryScopeId` 作为历史证据，并不表示进程重启后 scope 仍可用。旧记录在读取时派生 `legacy`，不改写历史事实，也不为其补造隔离声明。

含人工审核的批次，以及可能新增审核的 `workflow` 范围，在基线前持久化原批次 `memorySnapshot` 凭据。只有原快照摘要、学习／运行／样例身份和纯人工等待均能核对时，才恢复同一快照继续等待或处理审核；不会为恢复重新读取实时记忆，也不重放结果未知的业务执行。

Node / Python RPC 契约为：

| RPC | 参数 | 确认结果 |
| --- | --- | --- |
| `workbench.learning.memory.capture` | `{session_id,memory_scope_id}` | `{policy}`；要求新 anchor 会话与规范 UUID |
| `workbench.learning.prepare` | `{session_id,memory_scope_id}` | `{policy}`；评价、诊断和改写控制会话绑定 scope |
| `workbench.skill.prepare` | 原有 Skill 参数加 `memory_scope_id` | 原有准备结果及 `policy`；学习 Skill 绑定同一 scope |
| `workbench.learning.memory.release` | `{memory_scope_id}` | `{released:true,memoryScopeId}` |

scope 策略统一包含 `memoryAllowed:true`、`memoryWriteAllowed:false`、`externalMemoryAllowed:false`、`memoryMode:'batch-snapshot'`、`memoryScopeId`、`skillMutationBlocked:true`；控制会话另要求 `toolsAllowed:false`。`memoryAllowed` 只表示可读固定快照。普通执行不带学习 scope，继续使用原 memory 行为。工作流执行器和 Skill 桥接分别复核学习 ID / scope 以及 gateway 策略，未知或已释放 scope 直接拒绝，不回退实时记忆。

### 学习工具边界与生命周期

`LearningModel` 经 Hermes session/create/submit/history 路径调用本学习批次固定的主提供商与模型。样例执行、评价、诊断和改写沿用该选择，Hermes 默认模型切换不改写在途批次；认证、端点与 fallback 仍由 Hermes 管理。控制会话清空 Agent 工具列表，并在前置、延迟及底层 dispatch 拒绝工具调用。学习 Skill 会话保留其它执行工具与 Hermes 审批，但禁用原生 `memory`、外部 memory provider 工具，以及可能在 scope 外继续执行的 `delegate_task`、`cronjob_manage`、`message_agent` 和 `kanban_*`。这些额外限制只作用于学习 scope，不改变普通执行的工具策略。

scope 内关闭 memory / Skill review，不再从可写 memory store 重新加载；停用外部 provider 的动态检索、预取、同步、压缩、session-end 和 shutdown 消息写回。外部 provider 在接收学习提示前退出。原生接口不兼容时拒绝准备，不先发送提示；Agent 重建后重新施加相同绑定与防护。控制会话归属单独持久化，仅内部一次性请求标识允许提交，任务页无法追加消息。模型结果仍须同时有成功终态和最终持久历史，JSON 结构也由宿主验证。

结束、停止、超时、断线或关闭后停止新调度并尝试幂等 release；满足上方条件的纯人工审核等待可悬挂并保留原快照凭据。捕获确认尚未返回时也先释放，迟到成功或失败再次清理。gateway 删除可供新会话使用的 scope，并在本进程保留 tombstone；未知 ID 的 release 也登记 tombstone，拒绝同 ID 的迟到捕获。既有会话绑定仍保留只读防护，release 不解除绑定，也不妨碍迟到 finish 的完整性审计。迟到会话创建、提交 ACK、历史或模型结果不能恢复执行，管理器关闭后不再写数据库。重启时除可核对的纯审核等待外，活跃批次标为 unknown，不重新捕获 scope 或重放业务；托管会话冷恢复使用 Hermes 的 lazy 只读路径，避免默认 auto-continue 推理。

托管历史冷恢复还必须收到 Hermes 的 `info.lazy=true` 明确确认。应用为这类 runtime 保留 history-only 标记，读取历史和 activate 继续走不建 Agent 的原生路径；对此类历史的 interrupt 返回 `{interrupted:false,historyOnly:true}`，关闭时也不向其发送 native interrupt。这样不会因 Hermes 的 `_sess()` 懒加载在停止旧历史时创建未绑定 scope 的 Agent，再在关闭 / 回收时把旧验证历史提交到记忆 provider。该判断依据已确认的只读恢复标记，不能仅以本地 complete / unknown 状态推断没有实时任务；普通会话和实际运行中的停止机制保持原样。

整批内置记忆策略不等同于 OS 沙箱：学习 Skill 的文件 / 终端工具与本地代码仍在可信宿主运行，可读写其它文件或产生外部副作用；停止不会撤销它们。固定快照也可能已有相关事实，验证集仍参与版本选择，不能宣称它是全新事实或独立最终测试集。原有未完整隔离批次的样例与实际输出曾可能经共享 memory 影响后续上下文；新策略不追溯修正旧结果。所有样例结果与候选前后正文保留供核对，轮数上限不是 Token 或订阅预算。
