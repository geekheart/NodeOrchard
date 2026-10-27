import { redact } from './hermes-adapter.mjs';
import { WORKFLOW_TOOLS } from '../shared/workflow/workflow-tools.mjs';
import { workflowCapabilityManifest } from '../shared/workflow/workflow-capability-contract.mjs';
import { extname } from 'node:path';
import { stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Evidence collection is deliberately separate from execution. None of these
// readers creates/resumes sessions, changes documents, or retries a workflow.
export const APP_DIAGNOSTIC_LIMITS = Object.freeze({ payloadBytes: 64 * 1024, workflows: 30,
  sessions: 30, nodes: 80, messages: 24, toolCalls: 16, textCharacters: 6000, logCharacters: 4000, artifactBytes: 1024 * 1024 });
const MARKER = '[已截断]';
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const privateFields = new Set(['reasoning', 'reasoningcontent', 'reasoningtext', 'reasoningdetails', 'thinking', 'analysis', 'chainofthought', 'encryptedcontent']);
const secretFields = new Set(['key', 'apikey', 'token', 'accesstoken', 'refreshtoken', 'csrftoken', 'idtoken', 'authorization',
  'cookie', 'setcookie', 'password', 'secret', 'credentials', 'credential', 'clientsecret', 'privatekey']);
const normalize = key => key.toLowerCase().replace(/[^a-z]/g, '');
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const own = (object, key) => object && Object.getOwnPropertyDescriptor(object, key)?.value;
const size = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

function safeText(value) {
  return redact(String(value ?? ''))
    .replace(/<(?:think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/(?:think|thinking|analysis|reasoning)>|$)/gi, '[内部推理已省略]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|csrf[_ -]?token|token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s"',;}\]&#]+/gi, '$1[REDACTED]')
    .replace(/(^|\n)((?:set-)?cookie\s*:)\s*[^\r\n]*/gi, '$1$2 [REDACTED]');
}

function text(value, limit = APP_DIAGNOSTIC_LIMITS.textCharacters, tail = false) {
  const result = safeText(value);
  if (/^data:[^,]{0,160};base64,/i.test(result)) return '[二进制内容已省略]';
  return result.length > limit ? tail ? MARKER + result.slice(-limit) : result.slice(0, limit) + MARKER : result;
}

function argumentsObject(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('诊断参数必须是普通对象。');
  if (Object.getOwnPropertySymbols(value).length) fail('诊断参数不能包含 Symbol。');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value')) fail('诊断参数不能包含访问器。');
    if (!allowed.includes(key) || reserved.has(key)) fail('诊断参数包含未知字段。');
  }
  return value;
}

function identifier(value, label, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) || reserved.has(value)) fail(label + ' 无效。');
  return value;
}

function documentInput(value) {
  if (value === undefined || value === null) return null;
  let count = 0;
  const visit = (item, depth = 0) => {
    if (++count > 40000 || depth > 40) fail('诊断草稿过大或嵌套过深。');
    if (item === null || ['string', 'boolean', 'number'].includes(typeof item)) return;
    if (!item || typeof item !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item))) fail('诊断草稿必须是 JSON。');
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === 'length') continue;
      if (!Object.hasOwn(descriptor, 'value') || reserved.has(key)) fail('诊断草稿包含访问器或不安全字段。');
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value);
  identifier(value.id, '工作流 ID');
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) fail('诊断草稿缺少节点或连线。');
  if (size(value) > 2 * 1024 * 1024) fail('诊断草稿不能超过 2MB。', 413);
  return value;
}

// Redact before truncating so that clipping cannot turn half of a credential
// into an unrecognizable, and therefore unredacted, suffix.
function boundedEvidence(input) {
  let remaining = APP_DIAGNOSTIC_LIMITS.payloadBytes - 2048;
  const omissions = new Set(), seen = new WeakSet();
  const visit = (value, depth = 0) => {
    if (remaining < 64) { omissions.add('诊断容量上限'); return MARKER; }
    if (typeof value === 'string') {
      let result = text(value);
      if (result.includes(MARKER)) omissions.add('长文本已截断');
      if (size(result) > remaining - 32) {
        let low = 0, high = result.length;
        while (low < high) { const middle = Math.ceil((low + high) / 2); if (size(result.slice(0, middle) + MARKER) <= remaining - 32) low = middle; else high = middle - 1; }
        result = result.slice(0, low) + MARKER; omissions.add('诊断容量上限');
      }
      remaining -= size(result); return result;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') { remaining -= size(value); return value; }
    if (!value || typeof value !== 'object') return undefined;
    if (depth > 16 || seen.has(value)) { omissions.add('深层或循环内容已省略'); return '[内容已省略]'; }
    if (privateFields.has(normalize(String(own(value, 'type') || '')))) return undefined;
    seen.add(value); remaining -= 2;
    const result = Array.isArray(value) ? [] : {};
    let entries = 0;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (Array.isArray(value) && key === 'length') continue;
      if (remaining < 128 || ++entries > 100) { omissions.add('其余内容已省略'); break; }
      if (!Object.hasOwn(descriptor, 'value') || reserved.has(key) || privateFields.has(normalize(key))) continue;
      remaining -= size(key) + 2;
      const secret = secretFields.has(normalize(key));
      const item = secret ? '[REDACTED]' : visit(descriptor.value, depth + 1);
      if (secret) remaining -= size(item);
      if (item !== undefined) { if (Array.isArray(result)) result.push(item); else result[key] = item; }
    }
    seen.delete(value); return result;
  };
  const result = visit(input);
  return { ...result, diagnosticLimits: { truncated: omissions.size > 0, omissions: [...omissions], maxBytes: APP_DIAGNOSTIC_LIMITS.payloadBytes } };
}

// The assistant controller can apply the same policy to its own bounded context.
export const sanitizeDiagnosticEvidence = boundedEvidence;
export const sanitizeDiagnosticText = safeText;

const tool = (name, description, properties = {}) => Object.freeze({ name, description, readOnly: true,
  inputSchema: { type: 'object', properties, additionalProperties: false } });
const idSchema = { type: 'string', maxLength: 128 };
const TOOLS = Object.freeze([
  tool('app.state', '读取应用与 Hermes 连接状态、会话摘要和待处理请求；不读取认证配置。'),
  tool('workflows.list', '读取工作流或回收站列表，无需先选中工作流。', { lifecycle: { type: 'string', enum: ['active', 'trashed', 'all'] } }),
  tool('workflow.inspect', '读取当前草稿与已保存版本信息；不保存草稿。', { workflowId: idSchema }),
  tool('workflow.run', '读取明确指定或最新运行的节点错误、时序、日志和可见输出；绝不自动换成其他运行。', {
    workflowId: idSchema, runId: idSchema, nodeId: idSchema, runSelection: { type: 'string', enum: ['explicit', 'latest'] } }),
  tool('session.history', '只读读取会话可见消息和工具调用；旧会话直接读Hermes持久历史，排除内部推理，不恢复或重放会话。', { sessionId: idSchema }),
  tool('tools.catalog', '读取本地工作流工具与 Hermes 已缓存工具目录；不安装或运行工具。', { sessionId: idSchema }),
  tool('artifact.inspect', '只读检查指定普通运行节点已登记产物的哈希和文本/JSON摘要，不接受文件路径，不读取学习产物。', {
    runId: idSchema, nodeId: idSchema, artifactId: idSchema, includeContent: { type: 'boolean' } }),
]);

function graph(document) {
  if (!document) return null;
  return { id: document.id, title: document.title, schemaVersion: document.schemaVersion, mode: document.mode,
    nodeCount: document.nodes?.length || 0, edgeCount: document.edges?.length || 0,
    nodes: (document.nodes || []).slice(0, APP_DIAGNOSTIC_LIMITS.nodes).map(node => ({ id: node.id, type: node.type, title: node.title,
      config: Object.fromEntries(Object.entries(node.config || {}).filter(([key]) => node.type === 'evaluation' ? ['comparison', 'valuePath'].includes(key)
        : node.type === 'improvement' ? ['scope', 'targetSkillNodeIds'].includes(key) : true)
        .map(([key, value]) => [key, key === 'document' && value ? { id: value.id, nodeCount: value.nodes?.length || 0 } : value])),
      ...(node.ports ? { ports: node.ports } : {}) })), edges: (document.edges || []).slice(0, 100) };
}

const duration = (start, end) => { const milliseconds = Date.parse(end) - Date.parse(start); return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : null; };
const learningRun = run => !!(run?.learningId || run?.memoryScopeId || run?.document?.mode === 'learn');
const runSummary = run => run ? { id: run.id, workflowId: run.workflowId, status: run.status,
  startedAt: run.startedAt, completedAt: run.completedAt,
  ...(!learningRun(run) ? { title: run.title || run.document?.title, error: run.error || '' } : {}) } : null;
const visibleValue = value => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return text(value, APP_DIAGNOSTIC_LIMITS.textCharacters, true); }
};

function sessionOwner(app, sessionId) {
  const db = app.store?.db;
  if (db?.prepare && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_runs'").get()) {
    const row = db.prepare("SELECT runs.value FROM workflow_runs AS runs WHERE json_valid(runs.value) AND (json_extract(runs.value,'$.sessionId')=? OR EXISTS "
      + "(SELECT 1 FROM json_each(runs.value,'$.nodes') AS node WHERE json_extract(node.value,'$.sessionId')=?)) LIMIT 1").get(sessionId, sessionId);
    if (row) return JSON.parse(row.value);
  }
  return (app.workflows?.list?.() || []).find(run => run.sessionId === sessionId || Object.values(run.nodes || {}).some(node => node.sessionId === sessionId));
}

export class AppDiagnostics {
  constructor(app) { this.app = app; }
  tools() { return structuredClone(TOOLS); }

  async read(name, args = {}, context = {}) {
    const descriptor = TOOLS.find(tool => tool.name === name);
    if (!descriptor) fail('未开放此诊断工具。');
    argumentsObject(args, Object.keys(descriptor.inputSchema.properties));
    if (name === 'app.state') return boundedEvidence(this.state());
    if (name === 'workflows.list') return boundedEvidence(this.workflows(args));
    if (name === 'workflow.inspect') return boundedEvidence(this.workflow(args, context));
    if (name === 'workflow.run') return boundedEvidence(this.run(args, context));
    if (name === 'session.history') return boundedEvidence(await this.history(args));
    if (name === 'artifact.inspect') return boundedEvidence(await this.artifact(args, context));
    return boundedEvidence(this.catalog(args));
  }

  state() {
    const backend = this.app.backend || {}, sessions = this.app.store?.list?.() || [];
    return { closed: !!this.app.closed, backend: Object.fromEntries(['state', 'provider', 'model', 'authenticated', 'hermesVersion', 'lastError']
      .filter(key => backend[key] !== undefined).map(key => [key, backend[key]])),
    sessions: sessions.slice(0, APP_DIAGNOSTIC_LIMITS.sessions).map(session => ({ id: session.id, title: session.title, status: session.status,
      provider: session.provider, model: session.model, hasPrompted: session.hasPrompted, createdAt: session.createdAt, updatedAt: session.updatedAt })),
    sessionCount: sessions.length, pendingRequests: [...(this.app.requests?.values?.() || [])].slice(0, 30)
      .map(request => ({ id: request.id, sessionId: request.sessionId, method: request.method, createdAt: request.createdAt })),
    adapterLog: (this.app.adapter?.log || []).slice(-10).map(entry => typeof entry === 'string' ? text(entry, 1000, true)
      : { at: entry.at, stream: entry.stream, text: text(entry.text || entry.message || '', 1000, true) }) };
  }

  workflows({ lifecycle = 'active' } = {}) {
    if (lifecycle === 'archived') lifecycle = 'trashed';
    if (!['active', 'trashed', 'all'].includes(lifecycle)) fail('工作流分类无效。');
    const items = this.app.workflowLibrary?.list?.({ lifecycle }) || [];
    return { lifecycle, count: items.length, items: items.slice(0, APP_DIAGNOSTIC_LIMITS.workflows).map(item => ({ id: item.id, title: item.title,
      mode: item.mode, revision: item.revision, lifecycle: item.lifecycle, state: item.state, readiness: item.readiness,
      nodeCount: item.nodeCount, edgeCount: item.edgeCount, updatedAt: item.updatedAt, latestRun: item.latestRun, latestLearning: item.latestLearning })) };
  }

  workflow(args = {}, context = {}) {
    const document = documentInput(context.document), workflowId = identifier(args.workflowId || context.workflowId || document?.id, '工作流 ID', true);
    if (!workflowId) return { available: false, reason: '当前未选中工作流。' };
    if (document && document.id !== workflowId) fail('当前草稿与所选工作流不一致。', 409);
    let saved = null;
    try { saved = this.app.workflowLibrary?.get?.(workflowId); }
    catch (error) { if (!document || error.httpStatus !== 404) throw error; }
    return { available: !!(document || saved), workflowId, source: document ? 'current-draft' : 'saved', savedRevision: saved?.revision ?? null,
      lifecycle: saved?.lifecycle, draftDiffers: document && saved ? JSON.stringify(document) !== JSON.stringify(saved.document) : null,
      document: graph(document || saved?.document) };
  }

  run(args = {}, context = {}) {
    const workflowId = Object.hasOwn(args, 'workflowId') ? identifier(args.workflowId, '工作流 ID') : identifier(context.workflowId || context.document?.id, '工作流 ID', true);
    const runId = Object.hasOwn(args, 'runId') ? identifier(args.runId, 'runId') : identifier(args.runSelection !== 'latest' ? context.runId : undefined, 'runId', true);
    const nodeId = Object.hasOwn(args, 'nodeId') ? identifier(args.nodeId, '节点 ID') : identifier(context.nodeId, '节点 ID', true);
    const selection = args.runSelection ?? (runId ? 'explicit' : 'latest');
    if (!['explicit', 'latest'].includes(selection)) fail('runSelection 无效。');
    if (selection === 'explicit' && !runId) fail('明确指定运行时必须提供 runId。');
    if (selection === 'latest' && args.runId) fail('latest 选择不能同时指定 runId。');
    const selected = selection === 'explicit' ? this.app.workflows.get(runId) : this.app.workflows?.list?.(workflowId)?.[0];
    if (!selected) return { available: false, selection, scope: workflowId ? 'workflow' : 'global', reason: '尚无运行记录。' };
    if (workflowId && selected.workflowId !== workflowId) fail('指定运行不属于当前工作流。', 409);
    if (learningRun(selected)) return { available: false, restricted: true, selection, scope: workflowId ? 'workflow' : 'global',
      id: selected.id, workflowId: selected.workflowId, status: selected.status, startedAt: selected.startedAt, completedAt: selected.completedAt,
      reason: '学习或训练运行仅提供状态摘要，不读取样本、输出、日志或产物。' };
    if (nodeId && !Object.hasOwn(selected.nodes || {}, nodeId)) fail('指定运行中没有该节点。', 404);
    const definition = new Map((selected.document?.nodes || []).map(node => [node.id, node]));
    const records = Object.entries(selected.nodes || {}).filter(([id]) => !nodeId || id === nodeId).slice(0, APP_DIAGNOSTIC_LIMITS.nodes);
    const nodes = records.map(([id, record]) => ({ id, type: definition.get(id)?.type, title: definition.get(id)?.title,
      status: record.status, attempt: record.attempt, attemptId: record.attemptId, sessionId: record.sessionId,
      startedAt: record.startedAt, completedAt: record.completedAt, durationMs: duration(record.startedAt, record.completedAt),
      error: text(record.error || '', 4000), partialText: text(record.partialText || '', APP_DIAGNOSTIC_LIMITS.textCharacters, true),
      outputText: text(record.outputText || '', APP_DIAGNOSTIC_LIMITS.textCharacters, true),
      logs: { stdout: text(record.logs?.stdout || '', APP_DIAGNOSTIC_LIMITS.logCharacters, true), stderr: text(record.logs?.stderr || '', APP_DIAGNOSTIC_LIMITS.logCharacters, true) },
      previousAttempts: (record.history || []).slice(-3).map(item => ({ status: item.status, attempt: item.attempt, attemptId: item.attemptId,
        startedAt: item.startedAt, completedAt: item.completedAt, error: text(item.error || '', 1000) })),
      artifacts: (record.artifacts || []).slice(0, 20).map(item => ({ id: item.id || item.artifactId, path: item.path, sha256: item.sha256, bytes: item.bytes ?? item.size, mimeType: item.mimeType })) }));
    const timeline = nodes.flatMap(node => [node.startedAt && { at: node.startedAt, kind: 'started', nodeId: node.id, attempt: node.attempt },
      node.completedAt && { at: node.completedAt, kind: 'completed', nodeId: node.id, attempt: node.attempt, status: node.status, error: node.error }].filter(Boolean))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return { available: true, selection, scope: workflowId ? 'workflow' : 'global', ...runSummary(selected), currentNodeId: selected.currentNodeId,
      activeNodeIds: selected.activeNodeIds || [], durationMs: duration(selected.startedAt, selected.completedAt),
      nodes, timeline, document: graph(selected.document), partialText: text(selected.partialText || '', APP_DIAGNOSTIC_LIMITS.textCharacters, true),
      outputText: text(selected.outputText || '', APP_DIAGNOSTIC_LIMITS.textCharacters, true),
      delivery: selected.delivery ? { status: selected.delivery.status, error: selected.delivery.error } : null };
  }

  async history({ sessionId }) {
    identifier(sessionId, '会话 ID');
    const session = this.app.store.get(sessionId);
    if (!session) fail('会话不存在。', 404);
    // A caller cannot bypass the workflow evidence restriction by naming its
    // model session directly. Only ordinary execution sessions are readable.
    const owner = sessionOwner(this.app, sessionId);
    if (learningRun(owner) || this.app.learningModel?.ownsSession?.(sessionId) || this.app.assistantModel?.ownsSession?.(sessionId)) return { available: false, restricted: true, sessionId,
      reason: '学习、训练或应用控制会话不向诊断公开内部模型历史。' };
    const runs = (this.app.store.runs(sessionId) || []).slice(-10).map(run => ({ id: run.id, status: run.status,
      startedAt: run.startedAt || run.started_at, completedAt: run.completedAt || run.completed_at, error: run.error || '', outcome: run.outcome || '' }));
    if ((!session.runtimeSessionId && !session.storedSessionId) || this.app.adapter?.state !== 'ready') return { available: false, sessionId, runs,
      reason: '此会话当前未连接；诊断不会自动恢复或重放，可先使用已保存的运行证据。' };
    try {
      let history, source = 'runtime-session';
      if (session.runtimeSessionId) {
        try { history = await this.app.adapter.request('session.history', { session_id: session.runtimeSessionId }, 3000); }
        catch (error) { if (!session.storedSessionId) throw error; }
      }
      if (!history) {
        source = 'readonly-stored-session';
        history = await this.app.adapter.request('workbench.assistant.history', { stored_session_id: session.storedSessionId }, 3000);
        if (history.storedSessionId !== session.storedSessionId || history.policy?.readOnly !== true || history.policy?.agentCreated !== false
          || history.policy?.sessionResumed !== false || history.policy?.memoryRead !== false || history.policy?.reasoningIncluded !== false) {
          fail('Hermes 未确认只读历史策略，已停止读取；不会恢复或重放会话。', 409);
        }
      }
      const visible = (history.messages || []).filter(message => ['user', 'assistant', 'tool', 'function'].includes(message.role));
      const messages = visible.slice(-APP_DIAGNOSTIC_LIMITS.messages).map(message => {
        const content = Array.isArray(message.content) ? message.content.filter(part => ['text', 'input_text', 'output_text'].includes(part?.type))
          .map(part => part.text || '').join('\n') : typeof message.content === 'string' ? message.content : '';
        const toolCalls = (message.tool_calls || message.toolCalls || []).slice(0, APP_DIAGNOSTIC_LIMITS.toolCalls).map(call => {
          let args = call.function?.arguments ?? call.arguments;
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* Keep visible non-JSON arguments as redacted text. */ } }
          return { id: call.id, name: call.function?.name || call.name, arguments: args };
        });
        return { role: message.role, ...(message.name ? { name: message.name } : {}),
          ...(message.tool_call_id || message.toolCallId ? { toolCallId: message.tool_call_id || message.toolCallId } : {}),
          content: visibleValue(content),
          ...(typeof message.text === 'string' ? { text: text(message.text, APP_DIAGNOSTIC_LIMITS.textCharacters, true) } : {}),
          ...(['tool', 'function'].includes(message.role) ? {
            ...(message.context !== undefined ? { context: visibleValue(message.context) } : {}),
            ...(message.args !== undefined ? { args: visibleValue(message.args) } : {}),
          } : {}), ...(toolCalls.length ? { toolCalls } : {}), partial: !!message.partial };
      });
      return { available: true, sessionId, source, runs, messageCount: visible.length,
        sourceTruncated: !!history.truncated || visible.length > APP_DIAGNOSTIC_LIMITS.messages, messages };
    } catch (error) { return { available: false, sessionId, runs, reason: text(error.message || '无法读取 Hermes 历史。', 2000) }; }
  }

  catalog({ sessionId } = {}) {
    const session = sessionId ? this.app.store.get(identifier(sessionId, '会话 ID')) : null;
    if (sessionId && !session) fail('会话不存在。', 404);
    const infos = session ? [this.app.sessionInfo?.get(session.runtimeSessionId)] : [...(this.app.sessionInfo?.values?.() || [])];
    const names = new Map();
    for (const info of infos) for (const value of Array.isArray(info?.tools) ? info.tools : []) {
      const name = typeof value === 'string' ? value : value?.name || value?.function?.name;
      if (typeof name === 'string' && name.length <= 200 && !names.has(name)) names.set(name, { name,
        ...(typeof value?.description === 'string' ? { description: text(value.description, 500) } : {}) });
    }
    return { diagnosticTools: this.tools(), workflowTools: WORKFLOW_TOOLS.map(tool => ({ id: tool.id, label: tool.label,
      description: tool.description, inputType: tool.inputType, outputType: tool.outputType })),
    hermesTools: [...names.values()].slice(0, 100), hermesCatalogSource: 'cached-session-info',
    workbench: workflowCapabilityManifest(),
    discover: ['app.capabilities', 'node.describe', 'runtime.inspect', 'assistant.skills.list', 'assistant.skills.read'],
    note: '注册工具只是工具节点的一种模式；code模式支持Python/JavaScript，不要求注册工具。目录未证明依赖或外部服务可用。' };
  }

  async artifact({ runId, nodeId, artifactId, includeContent = true }, context = {}) {
    identifier(runId, 'runId'); identifier(nodeId, '节点 ID'); identifier(artifactId, '产物 ID');
    if (typeof includeContent !== 'boolean') fail('includeContent 必须是布尔值。');
    const run = this.app.workflows.get(runId);
    if (learningRun(run)) fail('不能读取学习或训练运行的产物。', 403);
    const node = run.document?.nodes?.find(node => node.id === nodeId), record = run.nodes?.[nodeId];
    if (!node || !record || ['evaluation', 'improvement'].includes(node.type)) fail('不能读取此节点的产物。', 403);
    const reference = (record.artifacts || []).find(item => (item.artifactId || item.id) === artifactId);
    if (!reference) fail('产物不属于指定运行节点的当前版本。', 404);
    const files = this.app.workflowFiles;
    if (!files?.getArtifact || !files?.readArtifact) fail('应用未提供产物读取能力。', 503);
    const artifact = files.getArtifact(artifactId);
    if (artifact.runId !== runId || artifact.nodeId !== nodeId || artifact.attempt !== record.attempt
      || reference.sha256 !== artifact.sha256 || (reference.attempt !== undefined && reference.attempt !== artifact.attempt)) fail('产物归属或版本与当前运行节点不一致。', 409);
    if (/(?:training|learning|evaluation|sample|memory)/i.test([artifact.kind, artifact.role].filter(Boolean).join(' '))) fail('不能读取学习、训练或记忆产物。', 403);
    const artifactPath = context.permissionScope ? context.artifactPath : artifact.path;
    if (context.permissionScope && typeof artifactPath !== 'string') fail('产物缺少已核对的助手文件范围。', 403);
    const metadata = { id: artifact.id, runId, nodeId, attempt: artifact.attempt, name: artifact.name, path: artifactPath,
      size: artifact.size, sha256: artifact.sha256, mimeType: artifact.mimeType, createdAt: artifact.createdAt, modifiedAt: artifact.modifiedAt };
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 0 || artifact.size > APP_DIAGNOSTIC_LIMITS.artifactBytes) return {
      available: true, verified: false, metadata, contentAvailable: false, reason: '超过诊断读取上限，仅返回已登记元数据；尚未重新校验文件内容。' };
    if (files.permitted) {
      const path = await files.permitted(artifactPath), current = await stat(path);
      if (path !== artifactPath || !current.isFile() || current.size !== artifact.size) fail('产物位置或大小已变化，已停止诊断读取。', 409);
    }
    let checked;
    if (context.permissionScope) {
      const data = await readFile(artifactPath);
      if (data.length !== artifact.size || createHash('sha256').update(data).digest('hex') !== artifact.sha256) fail('产物副本哈希发生变化，已停止诊断读取。', 409);
      checked = { record: artifact, data };
    } else checked = await files.readArtifact(artifactId);
    const readable = ['.txt', '.md', '.json', '.csv', '.tsv', '.log', '.yaml', '.yml', '.xml'].includes(extname(artifact.path || '').toLowerCase())
      || ['text/plain', 'application/json'].includes(artifact.mimeType);
    if (!includeContent || !readable) return { available: true, verified: true, metadata, contentAvailable: false,
      reason: includeContent ? '二进制或非文本产物仅返回已验证元数据。' : '本次仅检查元数据和哈希。' };
    return { available: true, verified: true, metadata, contentAvailable: true, content: visibleValue(checked.data.toString('utf8')) };
  }

  async snapshot(options = {}) {
    argumentsObject(options, ['workflowId', 'document', 'runId', 'runSelection', 'nodeId']);
    const document = documentInput(options.document), workflowId = identifier(options.workflowId || document?.id, '工作流 ID', true);
    const runSelection = options.runSelection || (options.runId ? 'explicit' : 'latest');
    const run = this.run({ ...(workflowId ? { workflowId } : {}), ...(options.runId ? { runId: options.runId } : {}),
      runSelection, ...(options.nodeId ? { nodeId: options.nodeId } : {}) });
    const latest = this.app.workflows?.list?.(workflowId)?.[0];
    return boundedEvidence({ selection: { workflowId: workflowId || null, runSelection, requestedRunId: options.runId || null, nodeId: options.nodeId || null },
      run, latestRun: latest ? { ...runSummary(latest), sameAsSelected: latest.id === run.id, scope: workflowId ? 'workflow' : 'global' } : null,
      workflow: this.workflow({ ...(workflowId ? { workflowId } : {}) }, { document }), state: this.state(), workflows: this.workflows() });
  }
}
