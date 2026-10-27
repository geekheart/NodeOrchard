import { createHash } from 'node:crypto';
import { sanitizeDiagnosticText, sanitizeDiagnosticEvidence } from './app-diagnostics.mjs';
import { conversationTurnGroups, projectConversationIssues } from '../shared/workflow/workflow-conversation-issues.mjs';

const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const identifier = value => typeof value === 'string' && ID.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const string = { type: 'string', maxLength: 128, pattern: ID.source };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const definition = (name, description, inputSchema, effect = 'read-only') => ({ name, description, inputSchema, effect,
  readOnly: effect === 'read-only', roles: ['supervisor'], availability: 'available',
  annotations: { readOnlyHint: effect === 'read-only', destructiveHint: false, idempotentHint: true, openWorldHint: false } });
export const APPLICATION_CONVERSATION_HUB_TOOLS = Object.freeze([
  definition('conversations.list', '总控专用：按工作流读取独立会话目录和有界状态摘要，不合并各会话历史，不创建空会话。', schema({
    lifecycle: { enum: ['active', 'trashed', 'all'] }, search: { type: 'string', maxLength: 128 }, limit: { type: 'integer', minimum: 1, maximum: 200 } })),
  definition('conversation.inspect', '总控专用：按需读取指定工作流独立会话的有界脱敏消息和待处理元数据；学习/反馈材料、业务代码与检查点不展开。', schema({
    workflowId: string, limit: { type: 'integer', minimum: 1, maximum: 40 }, beforeTurnId: string }, ['workflowId'])),
  definition('conversation.delegate', '总控专用：依据本轮人工明确委派，向指定工作流助手派发只读诊断；返回消息身份和进度，不等待模型，不应用、运行、审核或学习。重复 operationId 读回原任务，不重发。', schema({
    workflowId: string, expectedRevision: { type: 'integer', minimum: 1 }, request: { type: 'string', maxLength: 8000 }, operationId: string },
  ['workflowId', 'expectedRevision', 'request', 'operationId']), 'mutation'),
]);

function plain(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !Object.hasOwn(field, 'value'))) fail('会话管理参数无效。');
}
const bounded = (value, max = 1200) => sanitizeDiagnosticText(String(value || '')).slice(0, max);
const learningRun = run => !!(run?.learningId || run?.memoryScopeId || run?.document?.mode === 'learn');
const learningTurn = (turn, document, app) => {
  if (document?.mode === 'learn' || ['skill', 'feedback'].includes(turn.user?.intent)
    || turn.actions?.some(action => /learn|feedback/.test(action.kind || '')) || turn.outcome?.learningId) return true;
  if (turn.user?.context?.runId) {
    try { return learningRun(app.workflows.get(turn.user.context.runId)); } catch { return false; }
  }
  return false;
};
const contextView = context => Object.fromEntries(['documentRevision', 'runId', 'nodeId', 'attempt', 'attemptId']
  .filter(key => context?.[key] !== undefined).map(key => [key, context[key]]));
function turnView(turn, document, app, textBudget = 6400) {
  const restricted = learningTurn(turn, document, app);
  return { id: turn.id, workflowId: turn.workflowId, status: turn.status, createdAt: turn.createdAt, updatedAt: turn.updatedAt,
    ...(turn.pendingState ? { pendingState: { status: turn.pendingState.status, label: bounded(turn.pendingState.label, 180) } } : {}),
    user: { text: restricted ? '[学习或反馈内容未向总控展开]' : bounded(turn.user?.text, Math.floor(textBudget * 0.375)), context: contextView(turn.user?.context) },
    assistant: { text: restricted ? '[学习或反馈内容未向总控展开]' : bounded(turn.assistant?.text, Math.floor(textBudget * 0.625)),
      ...(turn.assistant?.progress ? { progress: Object.fromEntries(['stage', 'label', 'status', 'elapsedMs', 'modelCalls', 'toolCalls']
        .filter(key => turn.assistant.progress[key] !== undefined).map(key => [key, typeof turn.assistant.progress[key] === 'string'
          ? bounded(turn.assistant.progress[key], 240) : turn.assistant.progress[key]])) } : {}) },
    ...(restricted ? { restricted: true } : {}),
    ...(turn.delegation ? { delegation: { readOnly: true, sourceConversationId: turn.delegation.sourceConversationId, operationId: turn.delegation.operationId } } : {}) };
}
function limit(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail('会话读取数量超出范围。');
  return value;
}

// Human authorization is read from the original message, never forwarded tool
// evidence. Delegation is a chat write, but its child task is strictly read-only.
export function authorizeConversationDelegation(app, args, context) {
  const text = typeof context?.text === 'string' ? context.text : '';
  const unquoted = text.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, ' 资料引用 ');
  if (!text.trim() || /(?:不要|别|禁止|无需|不用|暂不|先不).{0,24}(?:委派|派发|分配|交给|助手|delegate)/i.test(unquoted)) fail('本轮没有明确授权向工作流助手派发诊断任务。', 403);
  const action = /(?:委派|派发|分配|交给|让.{0,60}助手.{0,60}(?:检查|诊断|分析|排查)|\bdelegate\b)/i;
  const clauses = text.split(/[。；;，,\n]/).filter(clause => action.test(clause.replace(/“[^”]*”|「[^」]*」|"[^"\n]*"|`[^`\n]*`/g, '资料引用'))
    && !/^(?:为什么|为啥|如何|怎么|解释|日志|记录|报告)|(?:是否|该不该|应不应该|什么意思|失败了|报错了)/.test(clause.trim()));
  if (!clauses.length) fail('请明确要求将诊断交给指定工作流助手。', 403);
  const workflows = app.workflowLibrary.list({ lifecycle: 'all' }), target = workflows.find(row => row.id === args.workflowId);
  for (const clause of clauses) {
    const named = workflows.filter(row => clause.includes(row.id) || row.title?.length > 1 && clause.includes(row.title)
      && workflows.filter(item => item.title === row.title).length === 1);
    if (named.length ? named.some(row => row.id === args.workflowId) : context.workflowId === args.workflowId
      || /(?:各|所有|每个|全部).{0,16}(?:工作流|流程).{0,16}助手/.test(clause)) return;
  }
  if (!target) fail('委派目标工作流不存在。', 404);
  fail('委派目标必须来自本轮人工消息或当前明确选中的工作流。', 403);
}

export class ApplicationConversationHub {
  constructor(app) { this.app = app; this.db = app.store.db; }
  tools() { return structuredClone(APPLICATION_CONVERSATION_HUB_TOOLS); }
  handles(name) { return APPLICATION_CONVERSATION_HUB_TOOLS.some(tool => tool.name === name); }
  rows(workflowId, count = 200, before) {
    return this.db.prepare(`SELECT rowid,value FROM workflow_conversation_turns WHERE workflow_id=?${before ? ' AND rowid<?' : ''} ORDER BY rowid DESC LIMIT ?`)
      .all(workflowId, ...(before ? [before] : []), count).reverse().map(row => JSON.parse(row.value));
  }
  pending(workflowId) {
    return this.app.conversations.pending(workflowId).map(item => ({ id: item.id, kind: item.kind, status: item.status,
      label: bounded(item.label, 180), context: contextView(item.context) }));
  }
  project(workflowId, turns) { return projectConversationIssues(turns, { reviewState: context => this.app.conversations.reviewState(workflowId, context) }); }
  list(args = {}) {
    plain(args, ['lifecycle', 'search', 'limit']);
    const lifecycle = args.lifecycle === 'archived' ? 'trashed' : args.lifecycle || 'active', max = limit(args.limit, 100, 200);
    if (!['active', 'trashed', 'all'].includes(lifecycle)) fail('会话工作流分类无效。');
    if (args.search !== undefined && (typeof args.search !== 'string' || args.search.length > 128 || args.search.includes('\0'))) fail('会话检索条件无效。');
    const search = (args.search || '').trim().toLowerCase(), source = this.app.workflowLibrary.list({ lifecycle })
      .filter(row => !search || (row.title + ' ' + row.id).toLowerCase().includes(search));
    const workflows = source.slice(0, max).map(row => {
      const turns = this.project(row.id, this.rows(row.id)), total = this.db.prepare('SELECT COUNT(*) AS count FROM workflow_conversation_turns WHERE workflow_id=?').get(row.id).count;
      const last = turns.at(-1), active = turns.some(turn => ['thinking', 'queued'].includes(turn.status));
      const unread = conversationTurnGroups(turns).unresolved.filter(turn => !['thinking', 'queued'].includes(turn.status));
      const pending = this.pending(row.id), latestRun = row.latestRun && !row.latestRun.learningId ? Object.fromEntries(['id', 'status', 'startedAt', 'completedAt']
        .filter(key => row.latestRun[key] !== undefined).map(key => [key, row.latestRun[key]])) : null;
      const view = last ? turnView(last, { mode: row.mode }, this.app) : null;
      return { workflowId: row.id, title: bounded(row.title, 240), lifecycle: row.lifecycle, mode: row.mode, revision: row.revision,
        latestRun, conversation: { revision: this.db.prepare('SELECT revision FROM workflow_conversations WHERE workflow_id=?').get(row.id)?.revision || 0,
          turnCount: total, pendingCount: pending.length + unread.filter(turn => !turn.actions?.some(action => action.kind?.startsWith('review-'))).length,
          active, status: active ? 'thinking' : pending.length || unread.length ? 'attention' : last?.status || 'empty',
          updatedAt: last?.updatedAt || row.updatedAt, lastMessage: view ? bounded(view.assistant.text || view.user.text, 240) : '',
          ...(total > 200 ? { pendingWindowTruncated: true } : {}) } };
    });
    return { workflows, total: source.length, truncated: source.length > max };
  }
  read(args) {
    plain(args, ['workflowId', 'limit', 'beforeTurnId']);
    if (!identifier(args.workflowId)) fail('工作流 ID 无效。');
    const record = this.app.workflowLibrary.get(args.workflowId), max = limit(args.limit, 20, 40);
    let before;
    if (args.beforeTurnId !== undefined) {
      if (!identifier(args.beforeTurnId)) fail('会话翻页身份无效。');
      before = this.db.prepare('SELECT rowid FROM workflow_conversation_turns WHERE workflow_id=? AND id=?').get(args.workflowId, args.beforeTurnId)?.rowid;
      if (!before) fail('此工作流没有对应的翻页消息。', 404);
    }
    const rows = this.rows(args.workflowId, max + 1, before), hasMore = rows.length > max, turns = this.project(args.workflowId, rows.slice(-max));
    return sanitizeDiagnosticEvidence({ workflowId: record.id, title: bounded(record.document.title, 240), lifecycle: record.lifecycle,
      workflowRevision: record.revision, revision: this.db.prepare('SELECT revision FROM workflow_conversations WHERE workflow_id=?').get(record.id)?.revision || 0,
      turns: turns.map(turn => turnView(turn, record.document, this.app, Math.min(6400, Math.floor(40000 / max)))), pending: this.pending(record.id).slice(0, 40),
      hasMore, nextBeforeTurnId: hasMore ? turns[0]?.id : null, operationsIncluded: false, learningEvidenceIncluded: false });
  }
  checkRole(context, workflowId, { delegate = false } = {}) {
    const p = this.app.assistantPermissionSettings?.get?.()?.supervisor;
    if (context?.role !== 'supervisor' || !p?.workflowRead || !p.crossWorkflowRead && (!workflowId || context.workflowId !== workflowId)
      || delegate && !p.manageWorkflows) fail('当前助手没有此会话管理权限。', 403);
  }
  async call(name, args = {}, context = {}) {
    if (!this.handles(name)) fail('未开放此会话管理工具。', 403);
    const descriptor = APPLICATION_CONVERSATION_HUB_TOOLS.find(tool => tool.name === name);
    plain(args, Object.keys(descriptor.inputSchema.properties)); this.checkRole(context, args.workflowId, { delegate: name === 'conversation.delegate' });
    if (name === 'conversations.list') return this.list(args);
    if (name === 'conversation.inspect') return this.read(args);
    return this.delegate(args, context);
  }
  async delegate(args, context = {}) {
    this.checkRole(context, args.workflowId, { delegate: true });
    plain(args, ['workflowId', 'expectedRevision', 'request', 'operationId']);
    if (!identifier(args.workflowId) || !identifier(args.operationId) || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 1
      || typeof args.request !== 'string' || !args.request.trim() || args.request.length > 8000 || args.request.includes('\0')) fail('只读诊断委派参数无效。');
    authorizeConversationDelegation(this.app, args, context);
    const clientMessageId = 'delegate-' + createHash('sha256').update(args.operationId).digest('hex');
    const existing = this.db.prepare('SELECT workflow_id,value,private_value FROM workflow_conversation_turns WHERE client_message_id=?').get(clientMessageId);
    if (existing) {
      const turn = JSON.parse(existing.value), privateValue = JSON.parse(existing.private_value);
      if (existing.workflow_id !== args.workflowId || !privateValue.readOnly || turn.user.text !== args.request || turn.user.context.documentRevision !== args.expectedRevision
        || turn.delegation?.sourceConversationId !== context.sourceConversationId) fail('此委派 ID 已用于不同内容，请核对原任务。', 409);
      return this.receipt(turn, args.operationId, true);
    }
    if (context.signal?.aborted) fail('只读诊断委派已停止，未发送任务。', 409);
    const record = this.app.workflowLibrary.get(args.workflowId);
    if (record.revision !== args.expectedRevision) fail('工作流版本已变化，请重新读取后再委派。', 409);
    this.app.workflowLibrary.assertRunnable(record.id);
    if (typeof this.app.conversations.messageReadOnly !== 'function') fail('当前未提供受控只读委派入口。', 503);
    const response = await this.app.conversations.messageReadOnly(record.id, { clientMessageId, text: args.request,
      context: { documentRevision: record.revision }, document: record.document },
    { operationId: args.operationId, sourceConversationId: context.sourceConversationId });
    return this.receipt(response.turn, args.operationId, false);
  }
  receipt(turn, operationId, replayed) {
    return sanitizeDiagnosticEvidence({ status: ['thinking', 'queued'].includes(turn.status) ? 'delegated' : turn.status,
      executed: true, readOnly: true, workflowId: turn.workflowId, targetWorkflowId: turn.workflowId, turnId: turn.id, operationId,
      childStatus: turn.status, replayed, workflowExecuted: false, workflowModified: false,
      next: { tool: 'conversation.inspect', arguments: { workflowId: turn.workflowId } } });
  }
}
