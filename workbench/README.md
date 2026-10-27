# NodeOrchard · 应用与部署参考

项目介绍、界面截图与完整首次部署流程见 [项目首页](../README.md)。本页保留详细目录与配置说明。

本机单用户应用，以 Hermes 为 Agent 核心，由 Hermes 管理模型连接、认证、Skills 和记忆。支持工作流看板、节点编排、AI 对话修改、并行调度、人工审核、定时运行及多样例 Skill 学习。

顶部提示横幅右侧的关闭按钮可隐藏当前消息；后续新提示仍会显示，Hermes 连接与运行状态不受影响。

## 运行与工作环境

需要 Node.js ≥ 22.13。主应用使用 Node 内置模块，无需安装前端框架或独立数据库服务。**使用 AI 功能前，先按 [Hermes 官方指南](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart)安装 Hermes Agent**，运行 `hermes model` 配置提供商和模型，再用 `hermes` 验证一次对话。当前适配已验证 Hermes 0.21.4。

从项目根目录运行 `npm --prefix workbench start`，或在本目录运行 `npm start`，打开 http://127.0.0.1:4318 。

默认查找 Hermes 安装 `~/.hermes/hermes-agent`，在界面点击“连接 Hermes”后读取当前模型与已配置目录。顶部可切换服务商和模型，选择由 Hermes 原生接口校验并持久化；新增提供商和认证先在 Hermes 完成，再刷新目录。支持 Hermes 已配置且认证已确认的提供商，ChatGPT 订阅是其中一种选择。纯本地工具／代码流程可离线运行；工程转换和编译需要相应本机依赖，缺失时明确报告。

主模型按会话、工作流运行和学习批次固定；顶层切换只影响新建任务和新发起运行，已有会话、后续节点和子流程保留原主模型，回退策略仍由 Hermes 管理。工作台不再使用本机 `defaultModel` 或 `WORKBENCH_HERMES_MODEL` 覆盖；需要原生策略确认的模型按界面提示到 Hermes 处理。

| 位置 | 用途 | Git |
| --- | --- | --- |
| 项目根目录 `workflow/` | 默认 cwd，首次启动自动创建 | 忽略 |
| `workflow/artifacts/` | 普通会话产物 | 忽略 |
| `workflow/outputs/` | 默认交付副本 | 忽略 |
| `workflow/config/` | 本机资源覆盖与当前板卡配置 | 忽略 |
| `workflow/workflow-sessions/` | 各节点的隔离 Skill 会话与冻结 bundle | 忽略 |
| `workbench/.local/` | 现有 SQLite、Skill 快照、依赖与缓存 | 忽略，保留历史 |
| `workbench/workspaces/` | 旧会话和交付目录 | 忽略，保留历史 |
| 本机应用数据目录 `…/PersonalAgentWorkbench/runs/` | 权威执行原件、回执、节点版本 | 仓库外 |
| `skills/` | 内置 Skill、固件模板和 schema | 源码 |
| `hdk/learning/` 中的案例与答案 | 私人学习记录 | 忽略，通用 schema／说明除外 |

新任务的默认相对目录为 `.`，直接在 `workflow/` 工作。旧内置偏好 `default` 仅在旧默认布局升级时迁移一次，自定义配置保持；不批量搬移历史文件或改写审核。

迁移已有流程时，在软件的“运行前准备”中选择 `workflow/config/` 下的当前配置，清空旧的输出根目录即可继承新默认值。复制配置先校验内容 SHA，保留配置内已核验的资料路径；不要全局替换历史目录。已有学习合同与旧门禁仍可能被兼容能力引用，应保留其本机原件，不能为了清理目录重写哈希或删除学习记录。

权威原件与交付副本分离。复制失败或副本后来被删改，可使用“重试保存交付副本”或“检查并补齐交付副本”，只保存副本，不重跑节点或人工审核。macOS 原件默认位于 `~/Library/Application Support/PersonalAgentWorkbench/runs/`，Windows 使用 Local AppData，Linux 使用 XDG state。

## 代码边界

- `src/`：应用装配、HTTP/SSE、配置、偏好、持久化与适配器。
- `src/workflows/`：调度、文件、审核、版本、对话、学习及定时任务。
- `shared/workflow/`：前后端共用的纯模型、端口、规则、规划与数据契约。
- `shared/diagnostics.mjs`：有界诊断摘要与凭据脱敏，不裁剪实际运行数据。
- `public/`：页面、画布、DOM 交互与主题。
- `python/`：Hermes JSON-RPC、Skill 冻结与 Python 代码执行。
- `hdk/`：固定工程能力、转换器集成和验收；`skills/`：能力指令与资源模板。
- `test/`：Node、Python 测试及脱敏 fixture；`scripts/`：检查与转换工具。
- `examples/`：通用流程与数据集；`docs/`：操作、设计与维护说明。

依赖方向为“界面／后端 → 共享领域逻辑”。共享模块不依赖 DOM、HTTP 或数据库；静态服务仅提供白名单资源。旧 schema1 保留线性兼容，新 schema2 按依赖并行调度。

## 验证与发布

在本目录运行：

```sh
npm test
npm run check:git
```

测试入口固定为 `test/*.test.mjs`，所需 Python 测试由包装器调用。不要用裸 `node --test` 扫描常驻 fixture。

发布检查涵盖已跟踪与未被忽略的候选文件，同时检查真实个人主目录字面量；不修改暂存区、不上传。仅检查文件路径边界时可直接运行 `node scripts/check-git-boundary.mjs`。

一次性、绑定个人历史运行的工作流生成器已移除；实际流程从编辑器构建或导入用户自己的备份。测试构建器只存在于 fixture，不会生成业务产物。公开示例不包含本机板卡配置、黄金答案或学习结果。

## 配置

| 环境变量 | 默认值／用途 |
| --- | --- |
| `WORKBENCH_PORT` | `4318`，仅监听 `127.0.0.1` |
| `WORKBENCH_WORKSPACE_ROOT` | 项目根目录 `workflow/`；显式指定工作环境 |
| `WORKBENCH_DATA_DIR` | `workbench/.local/`；SQLite 与私有状态 |
| `WORKBENCH_RUN_ROOT` | 本机应用数据目录；权威执行原件 |
| `WORKBENCH_HERMES_ROOT` | `~/.hermes/hermes-agent` |
| `WORKBENCH_HERMES_PYTHON` | Hermes 安装内 `venv/bin/python` |
| `WORKBENCH_HERMES_HOME` | `~/.hermes` |
| `WORKBENCH_HDK_SOURCE_ROOT` | 旧工程能力的本机资料根；可显式指定 |
| `WORKBENCH_HDK_PROCESS_TEMPLATE` | 本机工艺模板文件；不会打包到源码 |
| `WORKBENCH_HDK_PINOUT_REFERENCE` | 本机 Pinout 学习参考图 |
| `WORKBENCH_HDK_RESOURCE_OVERLAY` | 默认 `workflow/config/hdk-resources.local.json`；仅覆盖本机资料位置 |
| `WORKBENCH_HDK_ESPRESSIF_HOME` | 默认 `~/.espressif`；本机固件工具链根目录 |
| `WORKBENCH_HDK_COMPILER_BIN` | 可显式指定交叉编译器目录，否则使用工具链根内预设的固定版本目录 |
| `WORKBENCH_HDK_CMAKE_BIN` | 可显式指定 CMake 工具目录 |
| `WORKBENCH_HDK_NINJA_BIN` | 可显式指定 Ninja 工具目录 |

显式设置数据目录／工作环境的隔离实例在其隔离目录派生运行根；生产默认仍使用独立本机存储。

更多说明：[完整操作指南](docs/user-guide.md) · [整体架构](docs/architecture.md) · [节点与恢复](docs/workflow-inputs-and-recovery.md) · [工程能力](hdk/ARCHITECTURE.md) · [协作规则](../AGENTS.md)。
