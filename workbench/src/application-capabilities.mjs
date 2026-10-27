import { NODE_TYPES, CODE_LANGUAGES } from '../shared/workflow/workflow-model.mjs';
import { workflowCapabilityManifest, workflowNodeContract } from '../shared/workflow/workflow-capability-contract.mjs';
import { ApplicationAssistantSkills } from './application-assistant-skills.mjs';
import { inspectCodeRuntime } from './application-runtime-inspector.mjs';
import { ASSISTANT_DIAGNOSTIC_LIMITS } from './assistant-diagnostic-turn.mjs';

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
  definition('workbench.inspect', '读取设置、模型目录、定时任务或节点预设的当前状态；不修改任何设置或任务。', {
    section: { enum: ['settings', 'models', 'schedules', 'node-presets'] }, workflowId: text }),
  definition('page.inspect', '读取发消息时当前页面的界面状态与脱敏操作、错误记录。', {}),
  definition('environment.probe', '检查固定工具版本，或检查 GitHub HTTPS 连接；代码解释器和库请使用 runtime.inspect。', { target: { enum: ['dependencies', 'github'] } }),
  definition('browser.capture', '在专用只读浏览器中真实截图或短录制，附复现步骤与错误；不会采集当前用户标签页或桌面。', {
    route: { type: 'string' }, mode: { enum: ['screenshot', 'recording'] }, durationSeconds: { type: 'number', minimum: 0.1, maximum: 10 },
    steps: { type: 'array', maxItems: 12, description: '受限应用路由导航、click/scroll；禁止业务提交、输入和任意脚本' } }),
  definition('workflow.preflight', '检查工作流默认输入及文件准备；不编译或试跑 Python，不证明依赖可用或业务产物成功。', { workflowId: text }),
  definition('workflow.propose', '生成编辑器已校验的业务流程/代码修改候选，在原聊天应用；代码模式无需注册工具。此调用结束本轮等待应用，不自动执行。', {
    workflowId: text, request: { type: 'string', maxLength: 12000 } }, 'proposal'),
]);

const INSPECTION_NAMES = new Set(['app.capabilities', 'node.describe', 'runtime.inspect', 'assistant.skills.list', 'assistant.skills.read', 'workbench.inspect']);
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const FEATURES = [
  { id: 'diagnostics', status: 'available', tools: ['app.state', 'workflow.run', 'session.history', 'artifact.inspect', 'browser.capture'] },
  { id: 'conversation-lifecycle', status: 'available', channel: 'conversation-response', tools: [],
    note: '会话响应只读投影待处理状态；明确关联的成功重试接续旧聊天失败，审核按真实运行与尝试核对，不回写旧历史或业务状态。' },
  { id: 'conversation-pending-controls', status: 'ui-only', tools: [],
    note: '同一聊天界面折叠待处理区、明确重试或手动结束聊天关注；模型没有结束事项、批准审核或清除业务失败的工具。' },
  { id: 'workflow-editing', status: 'proposal-only', tools: ['node.describe', 'workflow.propose'], apply: '用户在同一聊天点击应用；保存版本和草稿指纹防冲突。' },
  { id: 'business-code', status: 'proposal-only', tools: ['node.describe', 'runtime.inspect', 'workflow.propose'], note: 'Python/JavaScript代码可写入业务节点候选，不需要注册固定工具。' },
  { id: 'execution', status: 'ui-only', tools: [], note: '界面运行按钮/编辑器中明确的“运行”命令使用现有执行器；后台助手没有自动start/retry工具。workflow.run只读历史。' },
  { id: 'human-review', status: 'ui-only', requiresUserConfirmation: true, tools: [], note: '同一聊天的精确版本审核卡由用户通过、要求修改或停止，模型不能代批。' },
  { id: 'schedules', status: 'ui-only', inspect: 'workbench.inspect', note: '定时任务可读取；创建、修改、暂停使用已有界面。' },
  { id: 'models-and-settings', status: 'ui-only', inspect: 'workbench.inspect', note: '可读取当前设置；模型、提供商和认证由Hermes原生入口管理。' },
  { id: 'node-presets', status: 'ui-only', inspect: 'workbench.inspect', note: '可读预设目录，创建与版本保存使用已有界面。' },
  { id: 'learning', status: 'proposal-only', requiresUserConfirmation: true, tools: [], note: '现有聊天可准备明确目标的学习候选；训练答案和验证样本不开放给全局诊断模型。' },
  { id: 'application-source-editing', status: 'unavailable', tools: [], note: '没有任意终端、源码补丁或任意文件读写工具。' },
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
  tools() {
    const all = [...this.app.diagnostics.tools().map(tool => ({ ...tool, effect: 'read-only', availability: 'available',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })), ...structuredClone(APPLICATION_ASSISTANT_TOOLS)];
    if (new Set(all.map(tool => tool.name)).size !== all.length) fail('应用工具目录存在重复名称。', 500);
    return all;
  }
  handles(name) { return INSPECTION_NAMES.has(name); }
  async bootstrap(userText = '', { schemaVersion = 2 } = {}) {
    const manifest = await this.skills.list(), selected = [];
    const names = new Set();
    if (/(?:失败|报错|异常|超时|修复|诊断|不工作|为什么|为啥)/i.test(userText)) names.add('diagnose-workflow');
    if (/(?:python|javascript|\bjs\b|代码|脚本|工具节点)/i.test(userText)) { names.add('author-code-node'); names.add('edit-workflow'); }
    else if (/(?:搭建|修改|替换|节点|连线|流程|默认值)/i.test(userText)) names.add('edit-workflow');
    if (/(?:文件|产物|导出|excel|xlsx|验收|验证结果)/i.test(userText)) names.add('verify-result');
    for (const name of [...names].slice(0, 4)) selected.push(await this.skills.read(name));
    return { contractVersion: 1, workbench: workflowCapabilityManifest({ schemaVersion }), features: structuredClone(FEATURES),
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
    if (name === 'node.describe') return workflowNodeContract(args.type, { schemaVersion: args.schemaVersion ?? context.document?.schemaVersion ?? 2 });
    const schemaVersion = args.schemaVersion ?? context.document?.schemaVersion ?? 2, section = args.section || 'overview';
    if (section === 'skills') return { skills: await this.skills.list() };
    if (section === 'interfaces') return { contractVersion: 1, tools: this.tools(), features: structuredClone(FEATURES),
      protocol: { current: 'internal-broker', externalMcpServerAvailable: false, reuse: 'MCP适配器须复用相同schema、调度器及权限，不复制业务执行逻辑。',
        conversationIssues: { projection: 'read-only', retryLink: 'retryOfTurnId', controls: 'ui-only',
          automaticBusinessResolution: false, reviewIdentityRequired: true },
        diagnostics: { batchQueries: ASSISTANT_DIAGNOSTIC_LIMITS.batchQueries, batchEffect: 'read-only', batchExecution: 'sequential-after-admission',
          stageProgress: true, persistedCheckpoints: true, automaticReplay: false,
          defaultToolRequests: ASSISTANT_DIAGNOSTIC_LIMITS.toolRequests, defaultDurationMs: ASSISTANT_DIAGNOSTIC_LIMITS.durationMs } } };
    return { contractVersion: 1, ...workflowCapabilityManifest({ schemaVersion, section }),
      ...(section === 'tools' ? { assistantTools: this.tools(), codeModeRequiresRegistration: false } : {}),
      ...(section === 'overview' ? { features: structuredClone(FEATURES), skills: await this.skills.list(), next: ['node.describe', 'runtime.inspect', 'assistant.skills.read'] } : {}) };
  }
  async inspectWorkbench({ section, workflowId }) {
    if (workflowId !== undefined && (typeof workflowId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workflowId))) fail('工作流编号无效。');
    if (section === 'settings') { const settings = await this.app.settings(); return { section, preferences: settings.preferences, approvalMode: settings.approvalMode }; }
    if (section === 'models') return { section, ...(await this.app.modelOptions()) };
    if (section === 'schedules') return { section, schedules: this.app.schedules.list(workflowId).slice(0, 100).map(row =>
      Object.fromEntries(['id', 'name', 'workflowId', 'revision', 'enabled', 'timing', 'nextRunAt', 'lastTrigger', 'lastError', 'createdAt', 'updatedAt']
        .filter(key => row[key] !== undefined).map(key => [key, row[key]]))) };
    if (section === 'node-presets') return { section, presets: this.app.nodePresets.list() };
    fail('工作台检查分区无效。');
  }
}
