import { sanitizeDiagnosticText } from './app-diagnostics.mjs';
import { projectConversationIssues, conversationTurnGroups } from '../shared/workflow/workflow-conversation-issues.mjs';

const ACTIVE = new Set(['queued', 'preparing', 'running', 'waiting', 'waiting_review', 'thinking']);
const COMPLETE = new Set(['complete', 'completed', 'applied', 'dismissed']);
const FAILED = new Set(['error', 'failed', 'exhausted']);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const text = (value, max = 240) => sanitizeDiagnosticText(typeof value === 'string' ? value : '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, max);
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const array = value => { const parsed = parse(value); return Array.isArray(parsed) ? parsed : []; };
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const latest = (a, b) => (time(b) ?? -1) > (time(a) ?? -1) ? b : a;
const duration = (start, end) => time(start) !== null && time(end) !== null && time(end) >= time(start) ? time(end) - time(start) : null;
const addNullable = (left, right) => number(right) === null ? left : (left ?? 0) + right;
const bytes = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const conversationMetrics = () => ({ turns: 0, complete: 0, failed: 0, pending: 0, modelCalls: 0, toolCalls: 0, elapsedMs: 0, lastAt: null });
const executionMetrics = () => ({ runs: 0, complete: 0, failed: 0, interrupted: 0, unknown: 0, active: 0, successRate: null,
  totalDurationMs: 0, averageDurationMs: null, durationSamples: 0, nodeAttempts: 0, learningRuns: 0, lastAt: null });
const usageMetrics = () => ({ input: null, output: null, prompt: null, completion: null, reasoning: null, total: null, calls: null,
  measuredRuns: 0, unmeasuredRuns: 0, partialRuns: 0 });
const group = () => ({ conversations: conversationMetrics(), execution: executionMetrics(), usage: usageMetrics(),
  context: null, artifacts: { count: 0, registeredBytes: 0, unknownSizes: 0 }, storage: { recordBytes: 0 }, models: [] });
const day = date => ({ date, conversations: conversationMetrics(), execution: executionMetrics(), usage: usageMetrics() });

function dateFormatter(timeZone) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { throw Object.assign(new Error('统计时区无效。'), { httpStatus: 400 }); }
}
function dayKey(value, formatter) {
  if (time(value) === null) return null;
  const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function midnight(date, timeZone) {
  const target = Date.parse(date + 'T00:00:00Z'); let result = target;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(result)).map(part => [part.type, part.value]));
    const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    result += target - local;
  }
  return new Date(result).toISOString();
}
function periodFor(days, now, timeZone) {
  if (![7, 30].includes(days)) throw Object.assign(new Error('统计范围必须是 7 或 30 天。'), { httpStatus: 400 });
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) throw Object.assign(new Error('统计时间无效。'), { httpStatus: 400 });
  const formatter = dateFormatter(timeZone), today = dayKey(now.toISOString(), formatter), anchor = Date.parse(today + 'T00:00:00Z');
  const dates = Array.from({ length: days }, (_, index) => new Date(anchor - (days - 1 - index) * 86400000).toISOString().slice(0, 10));
  const tomorrow = new Date(anchor + 86400000).toISOString().slice(0, 10);
  return { formatter, dates, period: { days, timeZone, start: midnight(dates[0], timeZone), end: midnight(tomorrow, timeZone) } };
}
function addConversation(metrics, row) {
  metrics.turns++;
  if (COMPLETE.has(row.status) || row.status === 'proposed') metrics.complete++;
  if (FAILED.has(row.status)) metrics.failed++;
  if (row.isPending) metrics.pending++;
  metrics.modelCalls += integer(row.modelCalls); metrics.toolCalls += integer(row.toolCalls);
  metrics.elapsedMs += number(row.elapsedMs) ?? duration(row.at, row.updatedAt) ?? 0;
  metrics.lastAt = latest(metrics.lastAt, row.updatedAt || row.at);
}
function addExecution(metrics, row) {
  metrics.runs++;
  if (COMPLETE.has(row.status)) metrics.complete++;
  else if (FAILED.has(row.status)) metrics.failed++;
  else if (['interrupted', 'cancelled'].includes(row.status)) metrics.interrupted++;
  else if (ACTIVE.has(row.status)) metrics.active++;
  else metrics.unknown++;
  if (row.source === 'learning') metrics.learningRuns++;
  if (row.durationMs !== null) { metrics.totalDurationMs += row.durationMs; metrics.durationSamples++; }
  metrics.nodeAttempts += integer(row.nodeAttempts);
  metrics.lastAt = latest(metrics.lastAt, row.completedAt || row.startedAt);
}
function finishExecution(metrics) {
  const terminal = metrics.complete + metrics.failed + metrics.interrupted + metrics.unknown;
  metrics.successRate = terminal ? metrics.complete / terminal : null;
  metrics.averageDurationMs = metrics.durationSamples ? metrics.totalDurationMs / metrics.durationSamples : null;
}
function addUsage(metrics, record) {
  const usage = record?.usage || {}, measured = record?.status === 'measured' && number(usage.total) !== null;
  const partial = !measured && record?.status !== 'missing' && ['input', 'output', 'prompt', 'completion', 'total', 'calls'].some(key => number(usage[key]) !== null);
  metrics[measured ? 'measuredRuns' : partial ? 'partialRuns' : 'unmeasuredRuns']++;
  if (!measured && !partial) return;
  for (const key of ['input', 'output', 'prompt', 'completion', 'reasoning', 'total', 'calls']) metrics[key] = addNullable(metrics[key], usage[key]);
}
function contextView(snapshot) {
  const usage = snapshot?.usage || {}, used = number(usage.context_used), max = number(usage.context_max);
  if (used === null && max === null) return null;
  // Context snapshots are never accumulated across model sessions.
  const percent = used !== null && max !== null && max > 0 ? Math.min(100, Math.max(0, used / max * 100)) : null;
  return { used, max, percent, estimated: usage.context_estimated === true, source: text(usage.context_source || snapshot.source, 100),
    capturedAt: snapshot.contextCapturedAt || snapshot.capturedAt || null, sessionId: text(snapshot.sessionId, 128) };
}

/** Local, read-only projection. No controller/list helpers that can lazily write,
 * no account usage RPC, no business inputs, prompts, source code, or file paths. */
export function collectWorkbenchStatistics(app, { days = 7, now = new Date(), timeZone = 'Asia/Shanghai' } = {}) {
  const db = app.store.db, { formatter, dates, period } = periodFor(days, now, timeZone);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const query = (table, sql) => tables.has(table) ? db.prepare(sql).all() : [];
  const inPeriod = value => time(value) !== null && time(value) >= Date.parse(period.start) && time(value) < Date.parse(period.end);
  const daily = dates.map(day), byDate = new Map(daily.map(row => [row.date, row]));
  const workflows = new Map(), owners = new Map(), ambiguousSessions = new Set(), activity = [], supervisorOwner = Symbol('supervisor');
  const markOwner = (sessionId, owner) => {
    if (typeof sessionId !== 'string' || !sessionId || !owner) return;
    if (owners.has(sessionId) && owners.get(sessionId) !== owner) ambiguousSessions.add(sessionId);
    else owners.set(sessionId, owner);
  };
  const deleted = new Map(query('workflow_library_meta', "SELECT substr(key,9) id,json_extract(value,'$.title') title FROM workflow_library_meta WHERE key LIKE 'deleted:%'").map(row => [row.id, row.title]));
  const lifecycle = new Map(query('workflow_lifecycle', 'SELECT workflow_id,lifecycle FROM workflow_lifecycle').map(row => [row.workflow_id, row.lifecycle === 'archived' ? 'trashed' : row.lifecycle]));
  const ensureWorkflow = (id, title, mode) => {
    if (typeof id !== 'string' || !id) return null;
    if (!workflows.has(id)) workflows.set(id, { ...group(), id: text(id, 128), title: text(deleted.get(id) || title) || '历史工作流',
      lifecycle: deleted.has(id) ? 'deleted' : lifecycle.get(id) || 'historical', mode: mode === 'learn' ? 'learn' : 'execute',
      revision: null, recentRuns: [], recentConversations: [], daily: dates.map(day) });
    return workflows.get(id);
  };
  for (const row of query('workflow_documents', "SELECT id,revision,json_extract(document,'$.title') title,json_extract(document,'$.mode') mode,length(CAST(document AS BLOB)) record_bytes FROM workflow_documents")) {
    const workflow = ensureWorkflow(row.id, row.title, row.mode); if (!workflow) continue;
    workflow.revision = row.revision; workflow.lifecycle = deleted.has(row.id) ? 'deleted' : lifecycle.get(row.id) || 'active';
    workflow.storage.recordBytes += bytes(row.record_bytes);
  }
  const runs = query('workflow_runs', `SELECT id,json_extract(value,'$.workflowId') workflowId,json_extract(value,'$.document.title') title,
    json_extract(value,'$.document.mode') mode,json_extract(value,'$.parentRunId') parentRunId,json_extract(value,'$.learningId') learningId,
    json_extract(value,'$.sessionId') sessionId,json_extract(value,'$.status') status,json_extract(value,'$.startedAt') startedAt,
    json_extract(value,'$.completedAt') completedAt,json_extract(value,'$.error') error,length(CAST(value AS BLOB)) record_bytes FROM workflow_runs`);
  const runsById = new Map(runs.map(row => [row.id, row]));
  const rootRun = row => { const seen = new Set(); let current = row;
    while (current?.parentRunId && runsById.has(current.parentRunId) && !seen.has(current.parentRunId)) { seen.add(current.id); current = runsById.get(current.parentRunId); }
    return current;
  };
  const workflowForRun = new Map();
  for (const row of runs) {
    const root = rootRun(row), workflow = ensureWorkflow(root.workflowId, root.title, root.mode);
    if (!workflow) continue; workflowForRun.set(row.id, workflow.id); markOwner(row.sessionId, workflow.id);
    workflow.storage.recordBytes += bytes(row.record_bytes);
  }
  const attemptsByRun = new Map();
  for (const row of query('workflow_runs', `SELECT r.id runId,json_extract(n.value,'$.sessionId') sessionId,
    json_extract(n.value,'$.attempt') attempt,n.key nodeId FROM workflow_runs r,json_each(r.value,'$.nodes') n`)) {
    markOwner(row.sessionId, workflowForRun.get(row.runId));
    if (!attemptsByRun.has(row.runId)) attemptsByRun.set(row.runId, new Map());
    attemptsByRun.get(row.runId).set(row.nodeId, integer(row.attempt));
  }
  for (const row of query('workflow_runs', `SELECT r.id runId,n.key nodeId,json_extract(h.value,'$.sessionId') sessionId,
    json_extract(h.value,'$.attempt') attempt FROM workflow_runs r,json_each(r.value,'$.nodes') n,json_each(n.value,'$.history') h`)) {
    markOwner(row.sessionId, workflowForRun.get(row.runId));
    const attempts = attemptsByRun.get(row.runId); if (attempts) attempts.set(row.nodeId, Math.max(attempts.get(row.nodeId) || 0, integer(row.attempt)));
  }
  const childAttempts = new Map();
  for (const row of runs) {
    const root = rootRun(row); childAttempts.set(root.id, (childAttempts.get(root.id) || 0) + [...(attemptsByRun.get(row.id)?.values() || [])].reduce((sum, value) => sum + value, 0));
  }
  for (const row of runs) {
    if (row.parentRunId || !inPeriod(row.startedAt)) continue;
    const workflow = workflows.get(workflowForRun.get(row.id)); if (!workflow) continue;
    const view = { id: text(row.id, 128), status: text(row.status, 40), startedAt: row.startedAt, completedAt: row.completedAt,
      durationMs: duration(row.startedAt, row.completedAt), nodeAttempts: childAttempts.get(row.id) || 0,
      source: row.learningId ? 'learning' : 'execute', error: text(row.error, 600) };
    addExecution(workflow.execution, view); workflow.recentRuns.push(view);
    const key = dayKey(row.startedAt, formatter), localDay = workflow.daily.find(item => item.date === key), globalDay = byDate.get(key);
    if (localDay) addExecution(localDay.execution, view); if (globalDay) addExecution(globalDay.execution, view);
    activity.push({ kind: 'run', id: view.id, workflowId: workflow.id, title: workflow.title, status: view.status,
      at: row.completedAt || row.startedAt, durationMs: view.durationMs });
  }
  const supervisor = { ...group(), conversationCount: 0, recentConversations: [] };
  const turnProjection = `json_extract(value,'$.status') status,json_extract(value,'$.createdAt') at,json_extract(value,'$.updatedAt') updatedAt,
    json_extract(value,'$.modelSessionId') modelSessionId,json_extract(value,'$.modelSessionIds') modelSessionIds,
    json_extract(value,'$.retryOfTurnId') retryOfTurnId,json_extract(value,'$.user.text') userText,json_extract(value,'$.user.context') userContext,
    json_extract(value,'$.outcome') outcome,json_extract(value,'$.actions') actions,
    json_extract(value,'$.assistant.progress.modelCalls') modelCalls,json_extract(value,'$.assistant.progress.toolCalls') toolCalls,
    json_extract(value,'$.assistant.progress.elapsedMs') elapsedMs,length(CAST(value AS BLOB)) record_bytes`;
  const readTurns = (rows, target) => {
    const groups = new Map();
    for (const row of rows) {
      const owner = target(row); if (!owner) continue;
      const key = owner.id || row.groupId || 'global-application';
      if (!groups.has(key)) groups.set(key, { owner, rows: [] });
      groups.get(key).rows.push(row);
    }
    for (const { owner, rows: grouped } of groups.values()) {
      const metadata = grouped.map(row => ({ id: row.id, status: row.status, workflowId: owner.id,
        retryOfTurnId: row.retryOfTurnId, user: { text: row.userText, context: parse(row.userContext) || {} },
        actions: parse(row.actions) || [], outcome: parse(row.outcome) }));
      const projected = projectConversationIssues(metadata, owner.id && typeof app.conversations?.reviewState === 'function'
        ? { reviewState: context => app.conversations.reviewState(owner.id, context) } : {});
      const pending = new Set(conversationTurnGroups(projected).unresolved.map(row => row.id));
      for (const row of grouped) row.isPending = pending.has(row.id);
    }
    for (const row of rows) {
      const owner = target(row); if (!owner) continue;
      markOwner(row.modelSessionId, owner.id || supervisorOwner);
      for (const sessionId of array(row.modelSessionIds)) markOwner(sessionId, owner.id || supervisorOwner);
      owner.storage.recordBytes += bytes(row.record_bytes);
      if (!inPeriod(row.at)) continue;
      const view = { id: text(row.id, 128), status: text(row.status, 40), at: row.at, updatedAt: row.updatedAt,
        durationMs: number(row.elapsedMs) ?? duration(row.at, row.updatedAt), modelCalls: integer(row.modelCalls), toolCalls: integer(row.toolCalls) };
      addConversation(owner.conversations, row); owner.recentConversations.push(view);
      const key = dayKey(row.at, formatter), localDay = owner.daily?.find(item => item.date === key), globalDay = byDate.get(key);
      if (localDay) addConversation(localDay.conversations, row); if (globalDay) addConversation(globalDay.conversations, row);
      activity.push({ kind: 'conversation', id: view.id, workflowId: owner.id || null, title: owner.title || '总控助手', status: view.status, at: row.updatedAt || row.at, durationMs: view.durationMs });
    }
  };
  readTurns(query('workflow_conversation_turns', `SELECT id,workflow_id workflowId,${turnProjection} FROM workflow_conversation_turns ORDER BY rowid`), row => ensureWorkflow(row.workflowId));
  const supervisorTurns = query('application_conversation_turns', `SELECT id,${turnProjection}${tables.has('application_conversation_membership')
    ? ',(SELECT conversation_id FROM application_conversation_membership WHERE turn_id=application_conversation_turns.id) groupId' : ''}
    FROM application_conversation_turns ORDER BY rowid`);
  readTurns(supervisorTurns, () => supervisor);
  supervisor.conversationCount = query('application_conversations', 'SELECT id FROM application_conversations').length
    + (supervisorTurns.some(row => !row.groupId) ? 1 : 0);
  for (const row of query('workflow_learning', `SELECT json_extract(value,'$.workflowId') workflowId,json_extract(value,'$.modelSessionId') modelSessionId,
    json_extract(value,'$.modelSessionIds') modelSessionIds,length(CAST(value AS BLOB)) record_bytes FROM workflow_learning`)) {
    const owner = ensureWorkflow(row.workflowId); if (!owner) continue; owner.storage.recordBytes += bytes(row.record_bytes);
    markOwner(row.modelSessionId, owner.id); for (const sessionId of array(row.modelSessionIds)) markOwner(sessionId, owner.id);
  }
  for (const row of query('workflow_artifacts', `SELECT json_extract(value,'$.runId') runId,json_extract(value,'$.size') size,
    length(CAST(value AS BLOB)) record_bytes FROM workflow_artifacts`)) {
    const owner = workflows.get(workflowForRun.get(row.runId)); if (!owner) continue;
    owner.artifacts.count++; owner.storage.recordBytes += bytes(row.record_bytes);
    if (number(row.size) === null) owner.artifacts.unknownSizes++; else owner.artifacts.registeredBytes += row.size;
  }
  const snapshots = new Map(query('session_usage', 'SELECT session_id,value FROM session_usage').map(row => [row.session_id, parse(row.value)]));
  const runUsage = new Map(query('run_usage', 'SELECT run_id,value FROM run_usage').map(row => [row.run_id, parse(row.value)]));
  const sessions = new Map(query('sessions', 'SELECT id,model,provider FROM sessions').map(row => [row.id, row]));
  const totals = { ...group(), workflowCount: workflows.size, activeWorkflows: 0, recycledWorkflows: 0, deletedWorkflows: 0, historicalWorkflows: 0 };
  const ordinary = { ...group(), sessionCount: 0 }, ownerOf = id => ambiguousSessions.has(id) ? ordinary : owners.get(id) === supervisorOwner ? supervisor : workflows.get(owners.get(id)) || ordinary;
  const modelMaps = new Map();
  for (const [sessionId, snapshot] of snapshots) {
    const owner = ownerOf(sessionId), context = contextView({ ...snapshot, sessionId });
    if (context && (!owner.context || (time(context.capturedAt) ?? -1) >= (time(owner.context.capturedAt) ?? -1))) owner.context = context;
  }
  for (const row of query('runs', 'SELECT id,session_id,started_at FROM runs ORDER BY started_at,id')) {
    if (!inPeriod(row.started_at)) continue;
    const owner = ownerOf(row.session_id), usage = runUsage.get(row.id), key = dayKey(row.started_at, formatter);
    addUsage(owner.usage, usage); addUsage(totals.usage, usage);
    const globalDay = byDate.get(key), localDay = owner.daily?.find(item => item.date === key);
    if (globalDay) addUsage(globalDay.usage, usage); if (localDay) addUsage(localDay.usage, usage);
    if (!modelMaps.has(owner)) modelMaps.set(owner, new Map());
    const models = modelMaps.get(owner), session = sessions.get(row.session_id), modelKey = `${session?.provider || ''}\0${session?.model || ''}`;
    if (!models.has(modelKey)) models.set(modelKey, { provider: text(session?.provider, 100), model: text(session?.model, 180) || '未记录模型', runs: 0, usage: usageMetrics() });
    const model = models.get(modelKey); model.runs++; addUsage(model.usage, usage);
  }
  ordinary.sessionCount = [...sessions.keys()].filter(id => ownerOf(id) === ordinary).length;
  for (const owner of [...workflows.values(), supervisor, ordinary]) {
    finishExecution(owner.execution); owner.models = [...(modelMaps.get(owner)?.values() || [])];
    if (owner.recentRuns) owner.recentRuns = owner.recentRuns.sort((a, b) => (time(b.startedAt) || 0) - (time(a.startedAt) || 0)).slice(0, 12);
    if (owner.recentConversations) owner.recentConversations = owner.recentConversations.sort((a, b) => (time(b.at) || 0) - (time(a.at) || 0)).slice(0, 12);
    for (const row of owner.daily || []) finishExecution(row.execution);
  }
  for (const owner of workflows.values()) {
    totals[owner.lifecycle === 'active' ? 'activeWorkflows' : owner.lifecycle === 'trashed' ? 'recycledWorkflows' : owner.lifecycle === 'deleted' ? 'deletedWorkflows' : 'historicalWorkflows']++;
    for (const section of ['conversations', 'execution', 'artifacts', 'storage']) for (const [key, value] of Object.entries(owner[section])) {
      if (key === 'lastAt') totals[section][key] = latest(totals[section][key], value);
      else if (typeof value === 'number' && !['successRate', 'averageDurationMs'].includes(key)) totals[section][key] += value;
    }
  }
  for (const [key, value] of Object.entries(supervisor.conversations)) {
    if (key === 'lastAt') totals.conversations[key] = latest(totals.conversations[key], value);
    else totals.conversations[key] += value;
  }
  totals.storage.recordBytes += supervisor.storage.recordBytes;
  finishExecution(totals.execution); for (const row of daily) finishExecution(row.execution);
  return { schemaVersion: 1, generatedAt: now.toISOString(), period, totals, daily,
    workflows: [...workflows.values()].sort((a, b) => (time(b.execution.lastAt || b.conversations.lastAt) || 0) - (time(a.execution.lastAt || a.conversations.lastAt) || 0) || a.id.localeCompare(b.id)),
    supervisor, ordinary, recentActivity: activity.sort((a, b) => (time(b.at) || 0) - (time(a.at) || 0)).slice(0, 40),
    coverage: { measuredRuns: totals.usage.measuredRuns, partialRuns: totals.usage.partialRuns, unmeasuredRuns: totals.usage.unmeasuredRuns,
      ambiguousSessions: ambiguousSessions.size, historicalLearningSessionCoverage: 'partial' },
    notes: { execution: '工作流执行按顶层运行计数，含学习样本；子流程节点尝试和模型用量归入顶层工作流。成功率分母包含成功、失败、停止和结果未知，排除进行中。',
      usage: 'Token 为所选期间模型运行的 Hermes 累计快照差值；未采集不补零，部分采集不代表完整消耗，总量不重复加算推理 Token。',
      context: '上下文为最近一次已上报的模型会话快照；不跨会话相加，估算值单独标记。',
      storage: '登记产物字节与记录字节是当前保留的累计登记数据，不等于实际磁盘占用。',
      history: '统计保留回收站及已删除工作流的历史消耗。旧学习评价与总控会话可能缺少模型归属。',
      unavailable: ['逐工作流 CPU / RAM 未采集', '订阅费用未采集'] } };
}
