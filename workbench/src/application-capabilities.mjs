import { NODE_TYPES, CODE_LANGUAGES } from '../shared/workflow/workflow-model.mjs';
import { workflowCapabilityManifest, workflowNodeContract } from '../shared/workflow/workflow-capability-contract.mjs';
import { ApplicationAssistantSkills } from './application-assistant-skills.mjs';
import { inspectCodeRuntime } from './application-runtime-inspector.mjs';
import { ASSISTANT_DIAGNOSTIC_LIMITS } from './assistant-diagnostic-turn.mjs';
import { APPLICATION_SUPERVISOR_TOOLS } from './application-supervisor-tools.mjs';
import { APPLICATION_CONVERSATION_HUB_TOOLS } from './application-conversation-hub.mjs';
import { ASSISTANT_MODEL_TOOLS } from './assistant-model-tools.mjs';
import { APPLICATION_SOURCE_TOOLS } from './application-source-tools.mjs';
import { resolveAssistantAttachments } from './assistant-attachments.mjs';
import { readConversationHistory } from './workflows/workflow-conversation-context.mjs';

const schema = properties => ({ type: 'object', properties, additionalProperties: false });
const text = { type: 'string', maxLength: 128 };
const version = { type: 'integer', enum: [1, 2] };
const definition = (name, description, properties, effect = 'read-only') => ({ name, description, inputSchema: schema(properties), effect,
  readOnly: effect === 'read-only', availability: 'available', annotations: { readOnlyHint: effect === 'read-only', destructiveHint: false,
    idempotentHint: effect === 'read-only', openWorldHint: name === 'environment.probe' } });

// Application-owned descriptors. A future MCP adapter must reuse these same
// schemas and ApplicationAssistant.call; it must not implement another policy.
export const APPLICATION_ASSISTANT_TOOLS = Object.freeze([
  definition('app.capabilities', '发现工作台真实节点、可调用操作、运行契约与内部 Skill；区分可调用、候选修改和只能由界面完成的功能。', {
    section: { enum: ['overview', 'nodes', 'operations', 'runtime', 'tools', 'skills', 'interfaces'] }, schemaVersion: version }),
  definition('node.describe', '读取指定节点的真实字段、语言、端口与代码/文件契约；代码模式支持 Python/JavaScript，无需先注册固定工具。', {
    type: { type: 'string', enum: NODE_TYPES.map(row => row.type) }, schemaVersion: version }),
  definition('runtime.inspect', '只读检查实际代码节点解释器、版本及指定库的可发现性；不安装依赖，不执行用户代码。', {
    language: { enum: [...CODE_LANGUAGES] }, modules: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 64, pattern: '^[A-Za-z_][A-Za-z0-9_]{0,63}$' } } }),
  definition('assistant.skills.list', '发现本应用内部操作 Skill 的用途与版本；无需用户选择，不是工作流业务 Skill。', {}),
  definition('assistant.skills.read', '按名称读取应用内置 Skill，了解诊断、编辑、业务代码及产物验收的具体方法。', { name: text }),
  definition('workbench.inspect', '只读检查工作台；可读取设置、模型、定时任务、节点派生目录、示例、统计及Skill图片/浏览器/桌面/MCP工具的真实就绪状态。独立助手限定当前工作流，不读取认证或修改连接。', {
    section: { enum: ['settings', 'models', 'schedules', 'node-derivations', 'node-presets', 'statistics', 'examples', 'integrations'] }, workflowId: text, days: { type: 'integer', enum: [7, 30] } }),
  definition('page.inspect', '读取发消息时当前页面的界面状态与脱敏操作、错误记录。', {}),
  definition('environment.probe', '检查固定工具版本，或检查 GitHub HTTPS 连接；代码解释器和库请使用 runtime.inspect。', { target: { enum: ['dependencies', 'github'] } }),
  definition('browser.capture', '在专用只读浏览器中真实截图或短录制，附复现步骤与错误；不会采集当前用户标签页或桌面。', {
    route: { type: 'string' }, mode: { enum: ['screenshot', 'recording'] }, durationSeconds: { type: 'number', minimum: 0.1, maximum: 10 },
    steps: { type: 'array', maxItems: 12, description: '受限应用路由导航、click/scroll；禁止业务提交、输入和任意脚本' } }),
  definition('workflow.preflight', '检查工作流默认输入及文件准备；不编译或试跑 Python，不证明依赖可用或业务产物成功。', { workflowId: text }),
  definition('workflow.folder', '只读获取指定工作流的独立文件夹、资料归集状态、保存版本与 .workflow 下载入口；不打开本机窗口、不解包、不执行。', { workflowId: text }),
  definition('workflow.conversation', '按需搜索或分页读取获准工作流的完整可见对话历史。恢复早期目标时使用；返回历史数据，不恢复旧审核、权限、操作或模型会话。单条长消息使用 turnId 和 offset 继续读取。', {
    workflowId: text, query: { type: 'string', maxLength: 200 }, beforeTurnId: text, turnId: text,
    offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 8 } }),
  definition('workflow.attachments', '读取当前获准工作流中用户保存的素材名称、路径与哈希；不执行或修改文件。', { workflowId: text }),
  definition('workflow.attachment.read', '按素材 ID 读取有界文本或二进制元数据，验证归属和哈希；图片在本轮选中后走原生图像输入，不把路径当成已看过。', {
    workflowId: text, id: text, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 8192 } }),
  definition('workflow.propose', '生成编辑器已校验的业务流程/代码修改候选，在原聊天应用；代码模式无需注册工具。此调用结束本轮等待应用，不自动执行。', {
    workflowId: text, request: { type: 'string', maxLength: 12000 } }, 'proposal'),
]);

const INSPECTION_NAMES = new Set(['app.capabilities', 'node.describe', 'runtime.inspect', 'assistant.skills.list', 'assistant.skills.read', 'workbench.inspect', 'workflow.folder', 'workflow.conversation', 'workflow.attachments', 'workflow.attachment.read']);
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const FEATURES = [
  { id: 'conversation-portability', status: 'available', tools: ['workflow.folder', 'workflow.conversation'], note: '每个工作流文件夹永久保存完整conversation.json、可读conversation.md及绑定版本和哈希的context.json；导入新身份后恢复有界历史背景，更早全文按需读取。上下文仅为数据，不恢复旧操作、审核授权或原生模型会话。' },
  { id: 'skill-integrations', status: 'available', tools: ['workbench.inspect', 'node.describe'], note: 'integrations只读投影Hermes图片、浏览器、Computer Use及已配置MCP的依赖和启用状态；节点requiredToolsets只请求真实能力，人工启动后按attempt绑定工具与版本。媒体按真实文件归集并经过人工审核；未配置不等于可调用。' },
  { id: 'skill-authoring', status: 'ui-only', tools: [], note: 'Skills页或节点选择器由用户新建Skill，不覆盖已有目录；图片提供商由人工选择并保存到Hermes原配置，认证继续由Hermes管理。创建全局可执行资源保留人工入口，业务Skill和应用助手均无skill_manage或配置写工具。' },
  { id: 'workflow-property-inspector', status: 'ui-only', tools: [], note: '属性面板随当前视图的有效节点或连线选择打开，取消选择后自动关闭；未应用的节点属性草稿保留。此为本地界面选择状态，不提供助手操作工具。' },
  { id: 'workflow-canvas-view', status: 'ui-only', tools: [], note: '画布平移、缩放及窗口尺寸变化只更新临时视角，不触发工作流保存；保存使用适应画布的视角，重新打开时按当前可见区域适应画布。节点坐标、连线和属性编辑仍正常保存。视角为本地界面状态，不提供助手写工具。' },
  { id: 'workflow-autosave', status: 'ui-only', tools: [], note: '工作流编辑默认每10分钟保存有改动的内容；设置页可调整为1–1440分钟或关闭。编辑器Ctrl+S/⌘S及保存按钮立即保存；切页和关闭仅保留本地恢复草稿。对话及运行记录即时持久化，导出等明确操作仍保存所需快照。助手可读取当前偏好，没有偏好写工具。' },
  { id: 'workflow-examples', status: 'ui-only', inspect: 'workbench.inspect', tools: [], note: '空画布的示例目录提供执行与学习模板；载入前核对实际 Skill 版本，附默认输入与学习数据，保留当前工作流身份，不自动执行。' },
  { id: 'conversation-intent-routing', status: 'available', channel: 'conversation-request', tools: [], note: '自由消息先由AI轻量分类，再进入创建修改、诊断、咨询、反馈或长期改进处理；分类不授予操作权限。精确运行、审核及结束事项命令保留原校验。' },
  { id: 'conversation-management', status: 'available', roles: ['supervisor'], tools: ['conversations.list', 'conversation.inspect', 'conversation.delegate'],
    note: '对话管理仅展示正常工作流的独立会话，回收站会话保留且恢复后重现；总控按问题分主题，按需读取摘要或明确委派只读诊断，不自动运行、应用或合并历史。旧全局聊天及普通任务保留。' },
  { id: 'supervisor-topics', status: 'ui-only', tools: [], note: '在对话管理页新建或切换总控主题；主题不共享聊天上下文，助手没有创建或合并主题的工具。' },
  { id: 'assistant-permissions', status: 'ui-only', tools: [], note: '权限仅由用户在设置页按版本保存；AI没有权限设置写工具。独立会话固定当前工作流与工作文件夹，双方均无源码或任意终端权限。' },
  { id: 'supervisor-workflow-management', status: 'available', roles: ['supervisor'], tools: ['workflow.copy', 'workflow.create-test', 'workflow.delete'], note: '总控在人工授权范围内复制、新增测试草稿或移入回收站；不自动运行，无永久删除。' },
  { id: 'workflow-recycle-bin', status: 'ui-only', inspect: 'workflows.list', tools: [], requiresUserConfirmation: true,
    note: '工作流直接移入回收站并暂停定时任务，节点编辑器仅加载活动流程；当前流程移入回收站或删除后卸载至空态，保留本地草稿。恢复后需用户重新打开，定时任务仍停用；永久删除仅在回收站由用户输入完整名称确认，保留运行历史和产物。旧归档记录显示在回收站。' },
  { id: 'application-logs', status: 'available', roles: ['supervisor'], tools: ['app.logs'], note: '受限持久结构化日志支持debug/info/warn/error/fatal、时间/模块/关联ID筛选和分页；仅保存数字与身份元数据，按保留限制清理。Hermes原始诊断窗口仍仅当前进程。日志读取不能修改源码或权限。' },
  { id: 'assistant-model-diagnostics', status: 'available', tools: ['assistant.diagnose', 'assistant.probe'], note: '按归属轮次聚合模型时序、计量与部分输出状态；固定短请求验证当前连接，单轮一次。等待首字、输出空闲与总截止分离，保留进度；不读取控制会话正文、不切换模型或重放业务。' },
  { id: 'workflow-statistics', status: 'available', tools: ['workbench.inspect'], note: '只读工作流对话、模型用量、上下文、运行成败和登记产物统计；独立助手仅当前工作流。历史未采集Token保持未知，逐工作流CPU和内存及订阅费用尚未采集。' },
  { id: 'statistics-history-import', status: 'ui-only', inspect: 'workbench.inspect', tools: [], note: '统计页由用户触发全局历史补齐，仅扫描已知本地会话并读取Hermes固定历史库的数字；助手可读取补齐后的受限统计，全局缓存写入不作为模型工具开放。' },
  { id: 'diagnostics', status: 'available', tools: ['app.state', 'workflow.run', 'session.history', 'artifact.inspect', 'browser.capture'] },
  { id: 'conversation-lifecycle', status: 'available', channel: 'conversation-response', tools: [],
    note: '会话响应只读投影待处理状态；明确关联的成功重试接续旧聊天失败，审核按真实运行与尝试核对，不回写旧历史或业务状态。' },
  { id: 'conversation-pending-controls', status: 'ui-only', tools: [],
    note: '待处理与审核提示支持单项或整组本地隐藏、恢复；同版本刷新保持隐藏，新审核尝试或产物版本重新提示。隐藏不改变事项、运行或审核。聊天仍可折叠、明确重试或结束关注；模型没有隐藏提示、结束事项、批准审核或清除业务失败的工具。' },
  { id: 'conversation-issue-resolution', status: 'available', channel: 'conversation-command', tools: [],
    note: '用户明确说“这个问题解决了”或“不用处理了”，由本地会话指令结束明确关联或唯一的聊天事项；歧义时按原对话编号选择。此入口不调用模型，不改变运行或人工审核。' },
  { id: 'workflow-editing', status: 'proposal-only', channel: 'conversation-request', tools: ['node.describe', 'workflow.propose'],
    note: '固定代码或工具的审核修改通过版本绑定的revisionRequest进入同一对话；AI先分类，仅生成代码或配置候选，沿用原权限。',
    apply: '用户在同一聊天点击应用；保存版本和草稿指纹防冲突。新增节点后自动按依赖布局，连线新增、删除或改接后也自动重排；纯属性修改和手动移动保持原布局。布局不启动运行。应用后需明确新建运行，旧运行与产物保持冻结。' },
  { id: 'business-code', status: 'proposal-only', tools: ['node.describe', 'runtime.inspect', 'workflow.propose'], note: 'Python/JavaScript代码可写入业务节点候选，不需要注册固定工具；应用草稿后明确新建运行，不改写旧运行代码。' },
  { id: 'execution', status: 'ui-only', tools: [], note: '界面运行按钮/编辑器中明确的“运行”命令使用现有执行器；后台助手没有自动start/retry工具。workflow.run只读历史。' },
  { id: 'human-review', status: 'ui-only', requiresUserConfirmation: true, tools: [],
    note: '精确版本审核卡由用户通过、修改或停止；人工修改不限次数。Skill节点接收本次反馈；工具节点须由AI重新生成核心代码候选，沿用proposal-only流程编辑入口，后续有Skill也不重跑原工具代替修改；模型不能代批或自动重试。' },
  { id: 'schedules', status: 'ui-only', inspect: 'workbench.inspect', note: '定时任务可读取；创建、修改、暂停使用已有界面。' },
  { id: 'models-and-settings', status: 'ui-only', inspect: 'workbench.inspect', note: '可读取当前设置；模型、提供商和认证由Hermes原生入口管理。' },
  { id: 'keyboard-shortcuts', status: 'ui-only', inspect: 'workbench.inspect', tools: [],
    note: '设置中的快捷键操作表由用户录制、禁用、恢复和保存，跨页面生效并检查冲突；工作流、总控和任务对话共用发送组合。助手可读当前偏好，但没有快捷键设置写工具，快捷键不增加执行或审核权限。' },
  { id: 'workflow-folders', status: 'available', tools: ['workflow.folder'], note: '每个工作流在工作区 workflows/<id> 保存定义、完整聊天、素材和运行资料；读取目录不触发本机打开或执行。' },
  { id: 'workflow-packages', status: 'ui-only', inspect: 'workflow.folder', tools: [], note: '用户导出完整文件夹为 .workflow ZIP，导入解包为独立副本；历史只读，不恢复执行、审核或认证。选择本机文件、下载和打开文件夹由界面完成。' },
  { id: 'conversation-attachments', status: 'available', tools: ['workflow.attachments', 'workflow.attachment.read'],
    note: '聊天支持用户粘贴、拖放与选择图片/文件，素材在所属工作流目录保存且可配置为输入。AI可读获准素材的路径及有界文本，本轮选中图片通过原生图像输入分析；不自动执行素材。' },
  { id: 'node-presets', status: 'ui-only', inspect: 'workbench.inspect', note: '节点派生以基础节点或固定派生版本为父级；node-derivations读取目录，兼容node-presets。创建及发布使用界面，已有实例和未知历史来源保留。' },
  { id: 'learning', status: 'proposal-only', requiresUserConfirmation: true, tools: [], note: '学习改进支持指定Skill、指定工具或整个流程；聊天可准备配置，界面明确启动。工具和流程候选调整业务代码或内部图，固定输入输出、评价和审核边界；最佳版本审阅后应用，训练和验证材料不开放给诊断助手。' },
  { id: 'application-source-editing', status: 'unavailable', experimental: true, defaultEnabled: false, requiredPermission: 'supervisor.sourceRepair', tools: [],
    note: '人工开启后仅总控可用受控源码读取、版本补丁、隔离相关测试、记录和冲突回滚。权限控制、凭据与用户工作流数据保持保护，没有任意shell或权限设置写工具。' },
];

function argsObject(args, allowed) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) fail('能力工具参数必须为普通对象。');
  if (Object.getOwnPropertySymbols(args).length) fail('能力工具参数无效。');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(args))) {
    if (!allowed.includes(key) || !Object.hasOwn(descriptor, 'value')) fail('能力工具参数包含未知字段或访问器。');
  }
}

export class ApplicationCapabilities {
  constructor(app, { skills = new ApplicationAssistantSkills(app.config?.appRoot) } = {}) { this.app = app; this.skills = skills; }
  sourceRepairEnabled(scope) {
    if (scope) return scope.role === 'supervisor' && !scope.readOnly && scope.permissions?.sourceRepair === true;
    return this.app.assistantPermissionSettings?.get?.()?.supervisor?.sourceRepair === true;
  }
  features(scope) {
    return structuredClone(FEATURES).map(feature => feature.id === 'application-source-editing' && this.sourceRepairEnabled(scope)
      ? { ...feature, status: 'available', tools: APPLICATION_SOURCE_TOOLS.map(tool => tool.name) } : feature.id === 'application-source-editing'
        ? { id: feature.id, status: 'unavailable', defaultEnabled: false, tools: [] } : feature);
  }
  tools(scope) {
    const all = [...this.app.diagnostics.tools().map(tool => ({ ...tool, effect: 'read-only', availability: 'available',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })), ...structuredClone(APPLICATION_ASSISTANT_TOOLS), ...structuredClone(APPLICATION_SUPERVISOR_TOOLS), ...structuredClone(APPLICATION_CONVERSATION_HUB_TOOLS), ...structuredClone(ASSISTANT_MODEL_TOOLS), ...(this.sourceRepairEnabled(scope) ? structuredClone(APPLICATION_SOURCE_TOOLS) : [])];
    if (new Set(all.map(tool => tool.name)).size !== all.length) fail('应用工具目录存在重复名称。', 500);
    return all;
  }
  handles(name) { return INSPECTION_NAMES.has(name); }
  async bootstrap(userText = '', { schemaVersion = 2, permissionScope } = {}) {
    const sourceRepair = this.sourceRepairEnabled(permissionScope);
    const manifest = (await this.skills.list()).filter(skill => sourceRepair || skill.name !== 'repair-application'), selected = [];
    const names = new Set();
    if (sourceRepair) names.add('repair-application');
    if (/(?:失败|报错|异常|超时|修复|诊断|不工作|为什么|为啥)/i.test(userText)) names.add('diagnose-workflow');
    if (/(?:python|javascript|\bjs\b|代码|脚本|工具节点)/i.test(userText)) { names.add('author-code-node'); names.add('edit-workflow'); }
    else if (/(?:搭建|修改|替换|节点|连线|流程|默认值)/i.test(userText)) names.add('edit-workflow');
    if (/(?:文件|产物|导出|excel|xlsx|验收|验证结果)/i.test(userText)) names.add('verify-result');
    for (const name of [...names].slice(0, 4)) selected.push(await this.skills.read(name));
    return { contractVersion: 1, workbench: workflowCapabilityManifest({ schemaVersion }), features: this.features(permissionScope).filter(feature => sourceRepair || feature.id !== 'application-source-editing'),
      skillManifest: manifest, loadedSkills: selected };
  }
  async read(name, args = {}, context = {}) {
    const definition = APPLICATION_ASSISTANT_TOOLS.find(tool => tool.name === name);
    if (!INSPECTION_NAMES.has(name) || !definition) fail('未开放此能力工具。');
    argsObject(args, Object.keys(definition.inputSchema.properties));
    if (args.schemaVersion !== undefined && ![1, 2].includes(args.schemaVersion)) fail('能力目录版本无效。');
    if (name === 'assistant.skills.list') return { skills: await this.skills.list() };
    if (name === 'assistant.skills.read') return this.skills.read(args.name);
    if (name === 'runtime.inspect') return inspectCodeRuntime(this.app, args, { signal: context.signal });
    if (name === 'workbench.inspect') return this.inspectWorkbench(args);
    if (name === 'workflow.conversation') {
      const workflowId = args.workflowId || context.workflowId || context.document?.id;
      this.app.workflowLibrary.assertAvailable(workflowId);
      return readConversationHistory(this.app.store.db, workflowId, args, {
        readOnly: context.permissionScope?.readOnly === true || context.permissionScope?.role === 'supervisor',
        document: this.app.workflowLibrary.get?.(workflowId)?.document,
        readRun: this.app.workflows?.get ? id => this.app.workflows.get(id) : undefined,
      });
    }
    if (name === 'workflow.attachments' || name === 'workflow.attachment.read') {
      const workflowId = args.workflowId || context.workflowId || context.document?.id;
      this.app.workflowLibrary.assertAvailable(workflowId);
      if (name === 'workflow.attachments') return { workflowId, attachments: this.app.workflowAttachments.list(workflowId).slice(-100) };
      await resolveAssistantAttachments(this.app, [{ id: args.id, workflowId }], {
        role: context.permissionScope?.role, workflowId, document: context.document, permissionScope: context.permissionScope,
      });
      return this.app.workflowAttachments.read(workflowId, args.id, { offset: args.offset, limit: args.limit });
    }
    if (name === 'workflow.folder') {
      const workflowId = args.workflowId || context.workflowId || context.document?.id;
      const record = this.app.workflowLibrary.get(workflowId);
      return { workflowId: record.id, directory: this.app.workflowFolders.directory(record.id), revision: record.revision,
        ...this.app.workflowFolders.status(record.id),
        layout: ['workflow.json', 'conversation.json', 'conversation.md', 'context.json', 'inputs/', 'outputs/', 'runs/', 'history/', 'skills/'],
        export: { format: '.workflow', url: `/api/workflow-library/${record.id}/export?expectedRevision=${record.revision}` } };
    }
    if (name === 'node.describe') return workflowNodeContract(args.type, { schemaVersion: args.schemaVersion ?? context.document?.schemaVersion ?? 2 });
    const schemaVersion = args.schemaVersion ?? context.document?.schemaVersion ?? 2, section = args.section || 'overview';
    if (section === 'skills') return { skills: await this.skills.list() };
    if (section === 'interfaces') return { contractVersion: 1, tools: this.tools(context.permissionScope), features: this.features(context.permissionScope),
      protocol: { current: 'internal-broker', externalMcpServerAvailable: false, reuse: 'MCP适配器须复用相同schema、调度器及权限，不复制业务执行逻辑。',
        conversationIssues: { projection: 'read-only', retryLink: 'retryOfTurnId', controls: 'conversation-command-and-ui',
          resolutionLink: 'replyToTurnId', resolutionCommands: ['这个问题解决了', '不用处理了'], resolutionRouting: 'local-command',
          resolutionTarget: 'explicit-or-unique', ambiguousSelection: 'frozen-candidate-ordinal',
          automaticBusinessResolution: false, reviewIdentityRequired: true },
        diagnostics: { batchQueries: ASSISTANT_DIAGNOSTIC_LIMITS.batchQueries, batchEffect: 'read-only', batchExecution: 'sequential-after-admission',
          stageProgress: true, persistedCheckpoints: true, automaticReplay: false,
          defaultToolRequests: ASSISTANT_DIAGNOSTIC_LIMITS.toolRequests, defaultDurationMs: ASSISTANT_DIAGNOSTIC_LIMITS.durationMs } } };
    return { contractVersion: 1, ...workflowCapabilityManifest({ schemaVersion, section }),
      ...(section === 'tools' ? { assistantTools: this.tools(context.permissionScope), codeModeRequiresRegistration: false } : {}),
      ...(section === 'overview' ? { features: structuredClone(FEATURES), skills: await this.skills.list(), next: ['node.describe', 'runtime.inspect', 'assistant.skills.read'] } : {}) };
  }
  async inspectWorkbench({ section, workflowId, days = 7 }) {
    if (workflowId !== undefined && (typeof workflowId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workflowId))) fail('工作流编号无效。');
    if (section === 'settings') { const settings = await this.app.settings(); return { section, preferences: settings.preferences, approvalMode: settings.approvalMode }; }
    if (section === 'models') return { section, ...(await this.app.modelOptions()) };
    if (section === 'integrations') return { section, ...(await this.app.skillIntegrations.inspect()) };
    if (section === 'schedules') return { section, schedules: this.app.schedules.list(workflowId).slice(0, 100).map(row =>
      Object.fromEntries(['id', 'name', 'workflowId', 'revision', 'enabled', 'timing', 'nextRunAt', 'lastTrigger', 'lastError', 'createdAt', 'updatedAt']
        .filter(key => row[key] !== undefined).map(key => [key, row[key]]))) };
    if (section === 'node-presets') return { section, presets: this.app.nodePresets.list() };
    if (section === 'node-derivations') return { section, derivations: this.app.nodePresets.list() };
    if (section === 'examples') return { section, examples: this.app.workflowExamples.list(), loading: '从空画布的载入示例选择；不会开始执行或学习。' };
    if (section === 'statistics') {
      if (![7, 30].includes(days)) fail('统计周期只支持7或30天。');
      const dashboard = this.app.statistics(days).dashboard;
      if (workflowId) {
        const workflow = dashboard.workflows.find(row => row.id === workflowId);
        if (!workflow) fail('工作流统计不存在。', 404);
        return { section, period: dashboard.period, generatedAt: dashboard.generatedAt, workflow };
      }
      return { section, period: dashboard.period, generatedAt: dashboard.generatedAt, totals: dashboard.totals,
        workflows: dashboard.workflows.slice(0, 100).map(({ recentRuns, recentConversations, daily, ...row }) => row),
        truncated: dashboard.workflows.length > 100, supervisor: dashboard.supervisor };
    }
    fail('工作台检查分区无效。');
  }
}
