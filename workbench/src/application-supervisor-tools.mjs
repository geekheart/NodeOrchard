import { createHash, randomUUID } from 'node:crypto';
import { createDocument, validateDocument } from '../shared/workflow/workflow-model.mjs';
import { sanitizeDiagnosticEvidence, sanitizeDiagnosticText } from './app-diagnostics.mjs';
import { APPLICATION_LOG_LEVELS, validateApplicationLogFilters } from './application-log.mjs';

const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const identifier = { type: 'string', maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' };
const revision = { type: 'integer', minimum: 1 };
const title = { type: 'string', maxLength: 120 };
const mutation = (name, description, properties, required) => ({ name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false }, effect: 'mutation',
  readOnly: false, availability: 'available', roles: ['supervisor'],
  annotations: { readOnlyHint: false, destructiveHint: name === 'workflow.delete', idempotentHint: true, openWorldHint: false } });

export const APPLICATION_SUPERVISOR_TOOLS = Object.freeze([
  mutation('workflow.copy', '总控专用：按明确源版本复制工作流为新草稿，不复制聊天、运行或定时任务，不运行。operationId 必须稳定；目标交付目录重置为默认。',
    { workflowId: identifier, expectedRevision: revision, title, operationId: identifier }, ['workflowId', 'expectedRevision', 'operationId']),
  mutation('workflow.create-test', '总控专用：新增独立测试工作流草稿；可提供完整节点文档，名称自动标记测试；不运行。新对象 expectedRevision 必须为 0，operationId 必须稳定。',
    { title, document: { type: 'object' }, expectedRevision: { type: 'integer', enum: [0] }, operationId: identifier },
    ['title', 'expectedRevision', 'operationId']),
  mutation('workflow.delete', '总控专用：按明确版本将工作流直接移入可恢复回收站，同时暂停定时任务，忙碌流程拒绝。无永久删除权限，不取消或重跑业务。',
    { workflowId: identifier, expectedRevision: revision, operationId: identifier }, ['workflowId', 'expectedRevision', 'operationId']),
  { name: 'app.logs', description: '总控专用：按 DEBUG/INFO/WARN/ERROR/FATAL 最低等级、模块、时间或关联身份读取脱敏持久日志。优先查看 structured.entries；默认取最新窗口，完整正向分页从 afterId:0 开始，用 nextAfterId 跨重启续读，每次受证据预算限制至多40条。currentProcess 仅附当前进程 Hermes 诊断窗口，不能共用持久游标。无任意文件、源码写入或执行能力。',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 },
      afterId: { type: 'integer', minimum: 0 }, minLevel: { type: 'string', enum: [...APPLICATION_LOG_LEVELS] },
      component: { type: 'string', maxLength: 64, pattern: '^[a-z][a-z0-9.-]{0,63}$' },
      workflowId: identifier, runId: identifier, nodeId: identifier, sessionId: identifier, conversationId: identifier,
      turnId: identifier, requestId: identifier, operationId: identifier,
      from: { type: 'string', format: 'date-time', maxLength: 40 }, to: { type: 'string', format: 'date-time', maxLength: 40 },
    }, additionalProperties: false }, effect: 'read-only', readOnly: true,
    availability: 'available', roles: ['supervisor'],
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
]);

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function plain(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('总控工具参数必须是普通对象。');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) fail('总控工具参数包含未知字段或访问器。');
  }
}

function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
    || ['__proto__', 'prototype', 'constructor'].includes(value)) fail('总控工具对象或操作 ID 无效。');
  return value;
}

function cleanTitle(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || value.includes('\0')) fail('工作流名称必须是 1 到 120 个字符。');
  return value;
}

function jsonDocument(input) {
  let count = 0;
  const seen = new WeakSet();
  const visit = (value, depth = 0) => {
    if (++count > 50000 || depth > 40) fail('测试工作流过大或嵌套过深。');
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
    if (!value || typeof value !== 'object' || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value)) || seen.has(value)) fail('测试工作流必须是有限 JSON 对象。');
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || !Object.hasOwn(descriptor, 'value')) fail('测试工作流不能包含访问器或不安全字段。');
      visit(descriptor.value, depth + 1);
    }
    seen.delete(value);
  };
  visit(input);
  return input;
}

function cleanRequest(name, args) {
  const tool = APPLICATION_SUPERVISOR_TOOLS.find(item => item.name === name);
  if (!tool) fail('未开放此总控工具。', 403);
  plain(args, Object.keys(tool.inputSchema.properties));
  if (name === 'app.logs') {
    return validateApplicationLogFilters(args);
  }
  id(args.operationId);
  if (!Number.isSafeInteger(args.expectedRevision) || (name === 'workflow.create-test' ? args.expectedRevision !== 0 : args.expectedRevision < 1)) fail('工作流预期版本无效。');
  if (name !== 'workflow.create-test') id(args.workflowId);
  if (args.title !== undefined) cleanTitle(args.title);
  if (name === 'workflow.create-test' && args.title === undefined) fail('新增测试工作流需要名称。');
  let document;
  if (Object.hasOwn(args, 'document')) {
    // Validate before serializing or hashing so getters and non-JSON values do
    // not execute as a side effect of operation identity calculation.
    try { document = validateDocument(jsonDocument(args.document)); } catch (error) { fail(error.message); }
    if (Buffer.byteLength(JSON.stringify(document)) > 2 * 1024 * 1024) fail('测试工作流不能超过 2MB。', 413);
  }
  return { ...args, ...(document ? { document } : {}) };
}

function abort(signal) {
  if (signal?.aborted) throw Object.assign(new Error('总控操作已取消，未开始修改。'), { name: 'AbortError', httpStatus: 409 });
}

// This broker is deliberately unable to evaluate code, run workflows or open a
// supplied path. ApplicationAssistant must also bind the role server-side.
export class ApplicationSupervisorTools {
  constructor(app) {
    this.app = app; this.db = app.store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS application_supervisor_operations (
      operation_id TEXT PRIMARY KEY, tool TEXT NOT NULL, request_hash TEXT NOT NULL,
      target_id TEXT NOT NULL, status TEXT NOT NULL, result TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
  }

  tools() { return structuredClone(APPLICATION_SUPERVISOR_TOOLS); }
  handles(name) { return APPLICATION_SUPERVISOR_TOOLS.some(tool => tool.name === name); }

  async call(name, args = {}, context = {}) {
    if (context.role !== 'supervisor') fail('此工具仅限总控助手，独立会话无跨工作流管理或全局日志权限。', 403);
    const request = cleanRequest(name, args);
    if (name === 'app.logs') { abort(context.signal); return this.logs(request); }
    // A previous operation is an immutable receipt even if its source has since
    // changed. A pending receipt means outcome unknown, never permission to run
    // the same side effect again after a crash or a lost model response.
    const requestHash = hash([name, request]);
    const previous = this.db.prepare('SELECT * FROM application_supervisor_operations WHERE operation_id=?').get(request.operationId);
    if (previous) {
      if (previous.tool !== name || previous.request_hash !== requestHash) fail('此 operationId 已用于不同操作，请核对原始回执。', 409);
      return previous.result ? JSON.parse(previous.result) : {
        operationId: request.operationId, tool: name, targetWorkflowId: previous.target_id, status: 'unknown', executed: null,
        reason: '操作已登记但结果尚未确认；未自动重放，请读取目标工作流核对。',
      };
    }
    abort(context.signal);
    const library = this.app.workflowLibrary;
    let source;
    if (name !== 'workflow.create-test') {
      source = library.get(request.workflowId);
      if (source.revision !== request.expectedRevision) fail('工作流版本已变化，请读取最新版本后再操作。', 409);
      if (name === 'workflow.delete') {
        if (source.lifecycle === 'trashed') fail('此工作流已在回收站。', 409);
        library.assertIdle(request.workflowId);
      }
    }
    const targetId = name === 'workflow.delete' ? request.workflowId : 'workflow-' + randomUUID();
    const at = new Date().toISOString();
    this.db.prepare('INSERT INTO application_supervisor_operations(operation_id,tool,request_hash,target_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(request.operationId, name, requestHash, targetId, 'pending', at, at);
    let result;
    try {
      if (name === 'workflow.delete') result = this.remove(request, source);
      else {
        const base = name === 'workflow.copy' ? structuredClone(source.document)
          : request.document || createDocument({ schemaVersion: 2, title: request.title });
        const title = name === 'workflow.copy' ? request.title || (source.document.title.slice(0, 116) + '（副本）')
          : ('[测试] ' + request.title).slice(0, 120);
        const document = { ...base, id: targetId, title,
          ...(base.settings ? { settings: { ...base.settings, outputDirectory: '' } } : {}) };
        const saved = library.save({ document, expectedRevision: 0 });
        result = { status: 'complete', executed: true, targetWorkflowId: saved.id, revision: saved.revision,
          lifecycle: saved.lifecycle, title: saved.document.title, ...(source ? { sourceWorkflowId: source.id, sourceRevision: source.revision } : {}),
          created: true, runStarted: false, copiedConversations: false, copiedRuns: false, copiedSchedules: false };
      }
    } catch (error) {
      // Domain operations may commit before a synchronous event listener throws.
      // Keep that ambiguity durable rather than claiming no change or retrying.
      let observed = null;
      try { const record = library.get(targetId); observed = { revision: record.revision, lifecycle: record.lifecycle, title: record.document.title }; } catch {}
      result = { status: 'unknown', executed: null, targetWorkflowId: targetId, reason: sanitizeDiagnosticText(error.message).slice(0, 2000),
        ...(observed ? { observed } : {}), replayed: false, runStarted: false };
    }
    const receipt = { operationId: request.operationId, tool: name, ...result, completedAt: new Date().toISOString() };
    this.db.prepare('UPDATE application_supervisor_operations SET status=?,result=?,updated_at=? WHERE operation_id=?')
      .run(receipt.status, JSON.stringify(receipt), receipt.completedAt, request.operationId);
    return receipt;
  }

  remove(request, source) {
    const library = this.app.workflowLibrary;
    library.transition(source.id, 'trash', { expectedRevision: request.expectedRevision });
    const saved = library.get(source.id);
    return { status: 'complete', executed: true, targetWorkflowId: saved.id, revision: saved.revision,
      lifecycle: saved.lifecycle, deleted: true, permanent: false, recoverable: true, runStarted: false,
      recovery: '在回收站恢复到工作流；定时任务保持暂停，需用户重新启用。' };
  }

  logs(input = {}) {
    const filters = validateApplicationLogFilters(input), { limit } = filters;
    if (!this.app.logger?.read) {
      if (Object.keys(filters).some(key => !['limit', 'afterId'].includes(key))) return {
        available: false, source: 'application-log', persistentHistory: false, filtersApplied: false,
        structured: { entries: [], nextAfterId: filters.afterId ?? 0, hasMore: false, persistence: { available: false } },
        note: '分级持久日志尚不可用，未将筛选条件假应用到旧内存窗口。',
      };
      return this.legacyLogs(filters);
    }
    const requestedLimit = limit, deliveryLimit = Math.min(limit, 40);
    const read = this.app.logger.read({ ...filters, limit: deliveryLimit });
    const entries = []; let budget = 32 * 1024;
    for (const entry of read.entries || []) {
      const clean = sanitizeDiagnosticEvidence({ entry: { id: entry.id, at: entry.at, level: entry.level, component: entry.component,
        event: entry.event, bootId: entry.bootId, context: entry.context } }).entry;
      const bytes = Buffer.byteLength(JSON.stringify(clean), 'utf8');
      if (bytes > budget) break;
      entries.push(clean); budget -= bytes;
    }
    const omitted = entries.length < (read.entries?.length || 0);
    const structured = { entries, nextAfterId: entries.at(-1)?.id ?? filters.afterId ?? 0,
      oldestId: read.oldestId, latestId: read.latestId, hasMore: !!read.hasMore || omitted,
      truncated: !!read.truncated || omitted, cursorExpired: !!read.cursorExpired, direction: read.direction,
      requestedLimit, deliveryLimit, retention: read.retention, enabledLevel: read.enabledLevel, persistence: read.persistence };
    // Each persisted entry has already been bounded and scrubbed. The complete
    // entry window stays below the diagnostic budget so later prompt bounding
    // cannot advance the cursor beyond records the assistant actually receives.
    const adapterLog = sanitizeDiagnosticEvidence({ adapterLog: (this.app.adapter?.log || []).slice(-Math.min(limit, 8)) }).adapterLog || [];
    return { available: read.persistence?.available === true, source: 'application-log', persistentHistory: true, structured,
      currentProcess: { source: 'hermes-diagnostics-memory', persistentHistory: false,
        adapterLog: adapterLog.map(line => typeof line === 'string' ? line.slice(-1000) : '[非文本诊断已省略]') },
      note: 'afterId 与 nextAfterId 仅用于 structured.entries。direction=latest 时 hasMore 可表示更早历史；需要完整遍历时从 afterId:0 正向读取。currentProcess 不使用该游标。' };
  }

  legacyLogs({ limit = 40, afterId = 0 } = {}) {
    const retained = this.app.events || [], matching = retained.filter(event => event.id > afterId);
    const events = matching.slice(-limit).map(event => {
      const payload = event.payload || {}, subject = payload.workflow || payload.run || payload.session || payload;
      // Only identity/status/error fields are visible. In particular learning
      // event payloads may contain private samples and must never pass through.
      return { id: event.id, type: event.type, at: event.at,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        ...(typeof subject.workflowId === 'string' ? { workflowId: subject.workflowId } : {}),
        ...(typeof subject.id === 'string' ? { objectId: subject.id } : {}),
        ...(typeof subject.state === 'string' ? { state: subject.state } : {}),
        ...(typeof subject.status === 'string' ? { status: subject.status } : {}),
        ...(!/learn|train|evaluat|improv/i.test(event.type) && typeof subject.error === 'string' ? { error: sanitizeDiagnosticText(subject.error).slice(0, 4000) } : {}),
        ...(event.type === 'backend.status' && typeof subject.lastError === 'string' ? { lastError: sanitizeDiagnosticText(subject.lastError).slice(0, 4000) } : {}) };
    });
    return sanitizeDiagnosticEvidence({ available: true, source: 'current-process-memory', persistentHistory: false,
      retainedWindow: { firstId: retained[0]?.id ?? null, lastId: retained.at(-1)?.id ?? null, count: retained.length },
      truncated: matching.length > limit || !!(retained[0] && afterId && retained[0].id > afterId + 1),
      events, adapterLog: (this.app.adapter?.log || []).slice(-Math.min(limit, 60)),
      note: '仅含当前进程保留的应用事件摘要与 Hermes 诊断日志；重启前日志或已淘汰事件不在此窗口。' });
  }
}
