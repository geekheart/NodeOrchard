import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { workflowInputFields, workflowInputValue } from '../shared/workflow/workflow-inputs.mjs';

const fail = (message, httpStatus = 403) => { throw Object.assign(new Error(message), { httpStatus }); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  && !['__proto__', 'prototype', 'constructor'].includes(value);
const inside = (root, target) => { const part = relative(root, target); return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep); };
const DEFAULT_WORKFLOW = { workflowRead: true, workflowEdit: true, customNodes: true, workspaceRead: true, capture: true };
export const DEFAULT_ASSISTANT_PERMISSIONS = Object.freeze({
  workflow: Object.freeze({ ...DEFAULT_WORKFLOW }),
  supervisor: Object.freeze({ ...DEFAULT_WORKFLOW, crossWorkflowRead: true, manageWorkflows: true, appLogs: true, sourceRead: false, sourceRepair: false, modelExperiment: false }),
});
const KNOWLEDGE = new Set(['app.capabilities', 'node.describe', 'runtime.inspect', 'runtime.software.inspect', 'assistant.skills.list', 'assistant.skills.read', 'environment.probe']);
const READ = new Set(['app.state', 'workflows.list', 'workflow.inspect', 'workflow.folder', 'workflow.conversation', 'workflow.attachments', 'workflow.attachment.read', 'workflow.run', 'session.history', 'tools.catalog', 'workbench.inspect', 'page.inspect', 'runtime.code.check']);
const MANAGE = new Set(['workflow.copy', 'workflow.create-test', 'workflow.delete']);
const CONVERSATIONS = new Set(['conversations.list', 'conversation.inspect', 'conversation.delegate', 'conversation.escalate', 'conversation.escalation']);
const SOURCE = new Set(['app.source.list', 'app.source.read', 'app.source.search', 'app.source.patch', 'app.source.test', 'app.source.history', 'app.source.rollback']);
const SOURCE_READ = new Set(['app.source.list', 'app.source.read', 'app.source.search']);
const DISABLED_DEFAULTS = new Set(['sourceRead', 'sourceRepair', 'modelExperiment']);
const KNOWN = new Set([...KNOWLEDGE, ...READ, ...MANAGE, ...CONVERSATIONS, ...SOURCE, 'workflow.preflight', 'workflow.propose', 'artifact.inspect', 'browser.capture', 'app.logs', 'assistant.diagnose', 'assistant.trace', 'assistant.probe', 'assistant.experiment']);

// Resolve even a not-yet-created path through its existing parent. A lexical
// prefix alone admits symlinks and is insufficient for an assistant folder.
async function canonical(path) {
  let ancestor = resolve(path);
  while (true) {
    try { return resolve(await realpath(ancestor), relative(ancestor, path)); }
    catch (error) { if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error; ancestor = dirname(ancestor); }
  }
}
async function workingFolder(app, workflowId) {
  const workspace = app.config?.workspaceRoot;
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) fail('助手工作文件夹未配置。', 409);
  const configured = resolve(workspace), root = await canonical(configured);
  const folder = workflowId && app.workflowFolders ? app.workflowFolders.directory(workflowId) : resolve(configured, app.preferences?.defaultWorkspace || '.');
  const actual = await canonical(folder);
  if ((!inside(configured, folder) && !inside(root, folder)) || !inside(root, actual)) fail('助手工作文件夹越过已配置的工作区。');
  return actual;
}
function settingsValue(value) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0) fail('助手权限配置不可用，已停止调用。', 409);
  const result = { revision: value.revision };
  for (const role of ['workflow', 'supervisor']) {
    if (!value[role] || Object.keys(DEFAULT_ASSISTANT_PERMISSIONS[role]).some(key => typeof value[role][key] !== 'boolean'
      && !(role === 'supervisor' && DISABLED_DEFAULTS.has(key) && value[role][key] === undefined))) fail('助手权限配置不完整，已停止调用。', 409);
    result[role] = Object.fromEntries(Object.keys(DEFAULT_ASSISTANT_PERMISSIONS[role]).map(key => [key, DISABLED_DEFAULTS.has(key) ? value[role][key] === true : value[role][key]]));
  }
  return result;
}
function codeNodes(document, prefix = '', result = new Map(), depth = 0) {
  if (depth > 8) fail('嵌入工作流层级过深。', 400);
  for (const node of document?.nodes || []) {
    const key = prefix + node.id, config = node.config || {};
    if (config.code || config.expression || node.type === 'tool' && config.executionMode === 'code' || node.type === 'transform') {
      result.set(key, JSON.stringify({ type: node.type, code: config.code || '', expression: config.expression || '', language: config.language || 'javascript' }));
    }
    if (config.document) codeNodes(config.document, key + '/', result, depth + 1);
  }
  return result;
}

// Only application callers create scopes. Neither a model tool argument nor a
// context object can invent a supervisor identity or replace the pinned folder.
export class ApplicationAssistantPermissions {
  constructor(app, { readSettings = () => app.assistantPermissionSettings?.get?.() } = {}) {
    this.app = app; this.readSettings = readSettings; this.scopes = new WeakSet();
  }
  async bind({ role, workflowId, document, readOnly = false, workflowBound = false } = {}) {
    if (!['workflow', 'supervisor'].includes(role)) fail('助手角色必须由服务端明确绑定。');
    if (workflowId !== undefined && !id(workflowId)) fail('助手工作流范围无效。', 400);
    if (role === 'workflow' && !workflowId) fail('独立会话必须绑定当前工作流。');
    if (document && document.id !== workflowId) fail('助手草稿与当前工作流不一致。', 409);
    if (typeof workflowBound !== 'boolean' || workflowBound && (role !== 'supervisor' || !readOnly || !workflowId)) fail('来源绑定诊断范围无效。', 403);
    const settings = settingsValue(await this.readSettings());
    const actual = await workingFolder(this.app, role === 'workflow' || workflowBound ? workflowId : undefined);
    if (typeof readOnly !== 'boolean') fail('助手诊断模式无效。');
    const scope = Object.freeze({ role, readOnly, workflowBound, workflowId: workflowId || null, workingFolder: actual,
      revision: settings.revision, permissions: Object.freeze(settings[role]), baseDocument: document ? structuredClone(document) : null });
    this.scopes.add(scope); return scope;
  }
  check(scope) {
    if (!scope || !this.scopes.has(scope)) fail('助手调用缺少服务端权限范围。');
    return scope;
  }
  async current(scope) {
    this.check(scope);
    const settings = settingsValue(await this.readSettings());
    if (settings.revision !== scope.revision || JSON.stringify(settings[scope.role]) !== JSON.stringify(scope.permissions)) fail('助手权限已变化，请重新发送消息。', 409);
    if (await workingFolder(this.app, scope.role === 'workflow' || scope.workflowBound ? scope.workflowId : undefined) !== scope.workingFolder) fail('助手工作文件夹已变化，请重新发送消息。', 409);
    return scope;
  }
  allowed(name, scope) {
    this.check(scope); const p = scope.permissions;
    if (!KNOWN.has(name)) return false;
    if (SOURCE_READ.has(name)) return scope.role === 'supervisor' && (p.sourceRead === true || p.sourceRepair === true);
    if (SOURCE.has(name)) return scope.role === 'supervisor' && p.sourceRepair === true && !scope.readOnly;
    if (name === 'assistant.experiment') return scope.role === 'supervisor' && p.modelExperiment === true && p.workflowRead && p.appLogs && !scope.readOnly;
    if (name === 'conversation.escalate') return scope.role === 'workflow' && p.workflowRead && !scope.readOnly;
    if (name === 'conversation.escalation') return scope.role === 'workflow' && p.workflowRead;
    if (scope.workflowBound && CONVERSATIONS.has(name)) return false;
    if (scope.readOnly && (MANAGE.has(name) || ['workflow.propose', 'conversation.delegate', 'assistant.probe'].includes(name))) return false;
    if (CONVERSATIONS.has(name)) return scope.role === 'supervisor' && p.workflowRead && p.crossWorkflowRead
      && (name !== 'conversation.delegate' || p.manageWorkflows);
    if (KNOWLEDGE.has(name)) return true;
    if (['assistant.diagnose', 'assistant.trace', 'assistant.probe'].includes(name)) return p.workflowRead && (scope.role === 'workflow' || p.appLogs);
    if (name === 'app.logs') return scope.role === 'supervisor' && p.appLogs;
    if (MANAGE.has(name)) return scope.role === 'supervisor' && p.manageWorkflows;
    if (name === 'workflow.propose') return p.workflowRead && p.workflowEdit;
    if (['workflow.preflight', 'artifact.inspect', 'workflow.attachments', 'workflow.attachment.read'].includes(name)) return p.workflowRead && p.workspaceRead;
    if (name === 'browser.capture') return p.workflowRead && p.capture;
    return READ.has(name) && p.workflowRead;
  }
  tools(descriptors, scope) { return descriptors.filter(tool => this.allowed(tool.name, scope)).map(tool => structuredClone(tool)); }
  async path(path, scope, { access = 'read', material = {} } = {}) {
    await this.current(scope);
    if (access !== 'read') fail('助手没有任意文件或源码写权限；业务代码只能通过节点候选接口修改。');
    if (!scope.permissions.workspaceRead) fail('当前助手未获准读取工作文件夹。');
    if (typeof path !== 'string' || !path || path.includes('\0') || !isAbsolute(path)) fail('资料必须使用当前工作文件夹内的绝对路径。');
    let target = await canonical(resolve(path));
    if (!inside(scope.workingFolder, target) && this.app.workflowFolders?.resolveMaterial) {
      const workflowId = scope.workflowId || material.workflowId;
      if (workflowId) {
        this.workflow(workflowId, scope);
        const { workflowId: ignored, ...identity } = material;
        const cached = await this.app.workflowFolders.resolveMaterial(workflowId, path, identity);
        if (cached) target = await canonical(cached.path);
      }
    }
    if (!inside(scope.workingFolder, target)) fail('资料超出当前助手工作文件夹。');
    if (this.app.config?.appRoot) {
      const sourceRoot = await canonical(this.app.config.appRoot);
      const projectRoot = await canonical(this.app.config.projectRoot || dirname(this.app.config.appRoot));
      const protectedPaths = await Promise.all([sourceRoot, join(projectRoot, 'docs'), ...['AGENTS.md', 'README.md', 'THIRD_PARTY_NOTICES.md', '.git', '.gitignore'].map(name => join(projectRoot, name))].map(canonical));
      if (protectedPaths.some(source => inside(source, target) || inside(target, source))) fail('助手不能通过资料接口访问工作台源码或配置目录。');
    }
    if (relative(scope.workingFolder, target).split(sep).some(part => part.startsWith('.'))
      || /^(?:id_(?:rsa|ed25519)|credentials(?:\..*)?|authorized_keys|known_hosts)$/i.test(basename(target))) fail('助手不能读取隐藏或凭据资料。');
    return target;
  }
  workflow(workflowId, scope) {
    if (!id(workflowId)) fail('必须明确有效的工作流范围。', 400);
    if (scope.role === 'workflow' || scope.workflowBound || !scope.permissions.crossWorkflowRead) {
      if (!scope.workflowId || workflowId !== scope.workflowId) fail('此助手只能访问当前工作流。');
    }
    return workflowId;
  }
  run(runId, scope) {
    if (!id(runId)) fail('运行编号无效。', 400);
    const run = this.app.workflows.get(runId); this.workflow(this.ownerWorkflow(run), scope); return run;
  }
  ownerWorkflow(run) {
    const visited = new Set();
    while (run.parentRunId) {
      if (!id(run.parentRunId) || visited.has(run.parentRunId) || visited.size > 32) fail('运行的父级归属无效。', 409);
      visited.add(run.parentRunId); run = this.app.workflows.get(run.parentRunId);
    }
    return run.workflowId;
  }
  session(sessionId, scope) {
    if (!id(sessionId)) fail('会话编号无效。', 400);
    if (scope.role === 'supervisor' && scope.permissions.crossWorkflowRead && !scope.workflowBound) return;
    const db = this.app.store?.db;
    let owners;
    if (db?.prepare && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_runs'").get()) {
      owners = db.prepare("SELECT runs.value FROM workflow_runs AS runs WHERE json_valid(runs.value) AND (json_extract(runs.value,'$.sessionId')=? OR EXISTS "
        + "(SELECT 1 FROM json_each(runs.value,'$.nodes') AS node WHERE json_extract(node.value,'$.sessionId')=?))").all(sessionId, sessionId).map(row => JSON.parse(row.value));
    } else owners = (this.app.workflows?.list?.() || []).filter(run => run.sessionId === sessionId
      || Object.values(run.nodes || {}).some(node => node.sessionId === sessionId));
    if (!owners?.length || owners.some(run => this.ownerWorkflow(run) !== scope.workflowId)) fail('此会话不属于当前工作流。');
  }
  async document(document, scope, { baseDocument = scope?.baseDocument, allowNewWorkflow = false } = {}) {
    await this.current(scope);
    if (allowNewWorkflow) {
      if (scope.role !== 'supervisor' || !scope.permissions.manageWorkflows || !id(document?.id)) fail('当前助手没有新建工作流的权限。');
    } else this.workflow(document?.id, scope);
    if (!scope.permissions.customNodes) {
      const previous = codeNodes(baseDocument);
      if ([...codeNodes(document)].some(([nodeId, code]) => previous.get(nodeId) !== code)) fail('当前助手未获准派生或修改业务代码节点。');
    }
    const result = structuredClone(document), material = { workflowId: document.id };
    const visit = async (current, previous, depth = 0) => {
      if (depth > 8) fail('嵌入工作流层级过深。', 400);
      if (current.settings?.outputDirectory) {
        try { current.settings.outputDirectory = await this.path(current.settings.outputDirectory, scope, { material }); }
        catch (error) {
          // A legacy delivery preference is not permission to write there.
          // Keep its frozen value in the DB; planning uses the owned default.
          if (!this.app.workflowFolders || error.httpStatus !== 403 || !/超出当前/.test(error.message)
            || previous?.settings?.outputDirectory !== current.settings.outputDirectory) throw error;
          current.settings.outputDirectory = await this.path(join(this.app.workflowFolders.directory(document.id), 'outputs'), scope);
        }
      }
      for (const node of current.nodes || []) {
        if (node.config?.workflowRef) this.workflow(node.config.workflowRef, scope);
        if (node.type === 'input') {
          const fields = workflowInputFields(node), value = workflowInputValue(current, undefined, node);
          for (const field of fields.filter(field => ['file', 'folder', 'image'].includes(field.kind))) {
            const path = fields.length === 1 && (typeof value !== 'object' || value === null) ? value : value?.[field.key];
            if (typeof path === 'string' && path.trim()) {
              const local = await this.path(path, scope, { material: { ...material, kind: 'input' } });
              const slot = Object.hasOwn(node.config, 'defaultValue') ? 'defaultValue' : 'value';
              if (node.config[slot] && typeof node.config[slot] === 'object') node.config[slot][field.key] = local;
              else if (fields.length === 1 && Object.hasOwn(node.config, slot)) node.config[slot] = local;
            }
          }
          if (['file', 'folder', 'image'].includes(node.config?.sourceKind) && node.config?.path) node.config.path = await this.path(node.config.path, scope, { material: { ...material, kind: 'input' } });
        }
        if (node.config?.document) await visit(node.config.document, previous?.nodes?.find(item => item.id === node.id)?.config?.document, depth + 1);
      }
    };
    await visit(result, baseDocument);
    return result;
  }
  async admit(name, args = {}, scope, context = {}) {
    await this.current(scope);
    if (!this.allowed(name, scope)) fail('当前助手权限未开放此工具。');
    if (!args || typeof args !== 'object' || Array.isArray(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args))
      || Object.getOwnPropertySymbols(args).length || Object.entries(Object.getOwnPropertyDescriptors(args))
        .some(([key, field]) => ['__proto__', 'constructor', 'prototype', 'role', 'permissions', 'permissionScope', 'workingFolder', 'workflowBound'].includes(key) || !Object.hasOwn(field, 'value'))) fail('助手工具参数包含不受信任的权限或访问器。', 400);
    args = { ...args }; context = { ...context, role: scope.role, permissionScope: scope };
    const scoped = scope.role === 'workflow' || scope.workflowBound || !scope.permissions.crossWorkflowRead;
    if (scoped) {
      if ((scope.role === 'workflow' || scope.workflowBound) && ['assistant.diagnose', 'assistant.trace'].includes(name) && args.conversationId) fail('当前工作流助手不能读取总控会话。');
      if (context.workflowId && context.workflowId !== scope.workflowId || context.document && context.document.id !== scope.workflowId) fail('调用上下文越过当前工作流。');
      if (args.workflowId) this.workflow(args.workflowId, scope);
      context.workflowId = scope.workflowId;
      if (['workflow.inspect', 'workflow.folder', 'workflow.conversation', 'workflow.attachments', 'workflow.attachment.read', 'workflow.run', 'workflow.preflight', 'workflow.propose', 'workbench.inspect', 'runtime.code.check'].includes(name)) args.workflowId = scope.workflowId;
      if (['assistant.diagnose', 'assistant.trace'].includes(name) && scope.workflowId && !args.conversationId) args.workflowId = scope.workflowId;
    }
    const runId = args.runId || (!['session.history', 'tools.catalog'].includes(name) ? context.runId : null);
    if (runId) this.run(runId, scope);
    if (args.sessionId) this.session(args.sessionId, scope);
    if (['workflow.conversation', 'workflow.attachments', 'workflow.attachment.read'].includes(name)) this.workflow(args.workflowId || context.workflowId, scope);
    if (name === 'artifact.inspect') {
      const artifact = this.app.workflowFiles.getArtifact(args.artifactId);
      if (artifact.runId !== args.runId || artifact.nodeId !== args.nodeId) fail('产物不属于指定运行节点。');
      context.artifactPath = await this.path(artifact.path, scope, { material: { workflowId: this.ownerWorkflow(this.app.workflows.get(artifact.runId)),
        sha256: artifact.sha256, size: artifact.size, kind: 'artifact', runId: artifact.runId, nodeId: artifact.nodeId, artifactId: artifact.id } });
    }
    if (name === 'workflow.preflight' || name === 'workflow.propose') {
      const workflowId = args.workflowId || context.workflowId;
      this.workflow(workflowId, scope);
      const document = context.document?.id === workflowId ? context.document : this.app.workflowLibrary.get(workflowId).document;
      context.documentView = await this.document(document, scope, { baseDocument: document });
    }
    if (name === 'workbench.inspect' && scoped && !['models', 'schedules', 'statistics', 'examples', 'integrations', 'skills'].includes(args.section)) fail('独立会话只可读取当前流程统计、定时任务、模型身份、工具依赖、技能来源或公共示例目录。');
    if (name === 'workbench.inspect' && scoped && args.section === 'statistics' && !args.workflowId) fail('统计读取必须绑定当前工作流。');
    if (name === 'browser.capture' && scoped) {
      const route = args.route || context.page?.route || `/#/workflows/${scope.workflowId}`;
      const match = route.match(/^\/?#\/workflows\/([A-Za-z0-9_-]+)$/);
      if (!match || match[1] !== scope.workflowId) fail('独立会话只可采集当前工作流页面。');
      for (const step of args.steps || []) if (step.route && step.route !== route) fail('独立会话录制不能导航到其它页面。');
      args.route = route.startsWith('#/') ? '/' + route : route;
    }
    return { args, context };
  }
  project(value, scope) {
    this.check(scope);
    const scoped = scope.role === 'workflow' || scope.workflowBound || !scope.permissions.crossWorkflowRead;
    const ownedRun = run => {
      if (!run || typeof run !== 'object') return false;
      if (run.workflowId === scope.workflowId) return true;
      try { this.run(run.id || run.runId, scope); return true; } catch { return false; }
    };
    const ownedSession = sessionId => { try { this.session(sessionId, scope); return true; } catch { return false; } };
    const route = value => /^\/?#\/workflows\/([A-Za-z0-9_-]+)$/.exec(value || '')?.[1] === scope.workflowId;
    const visit = (input, key = '') => {
      if (!input || typeof input !== 'object') return input;
      if (Array.isArray(input)) return input.map(row => visit(row));
      if (!scope.permissions.workflowRead && (key === 'page' || input.source === 'current-application-page')) return { source: 'current-application-page', restricted: true, reason: '当前助手未获准读取工作流页面证据。' };
      const result = Object.fromEntries(Object.entries(input).filter(([name]) => !(name === 'adapterLog' && !scope.permissions.appLogs)).map(([name, row]) => [name, visit(row, name)]));
      if (!scope.permissions.workflowRead) for (const key of ['run', 'latestRun', 'workflow', 'workflows', 'sessions', 'pendingRequests', 'runs', 'workflowRuns', 'requests', 'document', 'sessionCount']) delete result[key];
      if (scoped) {
        for (const name of ['run', 'latestRun']) if (result[name] && !ownedRun(result[name])) result[name] = { available: false, restricted: true, reason: '运行不属于当前工作流。' };
        if (result.workflow?.workflowId && result.workflow.workflowId !== scope.workflowId || result.workflow?.document?.id && result.workflow.document.id !== scope.workflowId) delete result.workflow;
        for (const name of ['runs', 'workflowRuns']) if (Array.isArray(result[name])) result[name] = result[name].filter(ownedRun);
        if (Array.isArray(result.requests)) result.requests = result.requests.filter(request => ownedSession(request.sessionId));
        if (Array.isArray(result.events)) result.events = result.events.filter(event => route(event.route));
        if (key === 'page' || result.source === 'current-application-page') {
          if (!route(result.route)) return { source: 'current-workflow-page', route: `#/workflows/${scope.workflowId}`, restricted: true };
          if (result.state?.workflowId && result.state.workflowId !== scope.workflowId) delete result.state;
        }
      }
      if (scoped && result.workflows?.items) {
        result.workflows.items = result.workflows.items.filter(item => item.id === scope.workflowId); result.workflows.count = result.workflows.items.length;
      }
      if (scoped && Array.isArray(result.items) && result.items.every(item => item.id && (item.lifecycle || item.revision !== undefined))) {
        result.items = result.items.filter(item => item.id === scope.workflowId); result.count = result.items.length;
      }
      if (scoped && (Array.isArray(result.sessions) || Array.isArray(result.pendingRequests))) {
        if (Array.isArray(result.sessions)) { result.sessions = result.sessions.filter(session => ownedSession(session.id)); result.sessionCount = result.sessions.length; }
        if (Array.isArray(result.pendingRequests)) result.pendingRequests = result.pendingRequests.filter(request => ownedSession(request.sessionId));
      }
      if (scoped && Array.isArray(result.hermesTools)) result.hermesTools = [];
      for (const key of ['tools', 'assistantTools', 'diagnosticTools']) if (Array.isArray(result[key]) && result[key].every(tool => typeof tool?.name === 'string')) result[key] = this.tools(result[key], scope);
      if (Array.isArray(input.tools) && input.tools.length && input.tools.every(tool => typeof tool === 'string')) {
        result.tools = input.tools.filter(name => this.allowed(name, scope));
        if (!result.tools.length && typeof result.status === 'string') { result.status = 'unavailable'; result.note = '当前助手权限未开放此能力。'; delete result.apply; }
      }
      return result;
    };
    return visit(value);
  }
}
