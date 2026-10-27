import { sanitizeDiagnosticText } from './app-diagnostics.mjs';

const BATCH = 50;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const TERMINAL = new Set(['complete', 'completed', 'error', 'failed', 'interrupted', 'unknown', 'cancelled']);
const COUNTERS = ['input', 'output', 'prompt', 'completion', 'total', 'calls', 'reasoning', 'cache_read', 'cache_write'];
const fail = (message, httpStatus = 502) => { throw Object.assign(new Error(message), { httpStatus }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const safeInteger = value => Number.isSafeInteger(value) && value >= 0;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const plain = (value, allowed) => {
  if (!object(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !Object.hasOwn(field, 'value'))) fail('Hermes 历史用量格式不兼容。');
};
const identity = value => { if (typeof value !== 'string' || !ID.test(value)) fail('Hermes 历史会话身份无效。'); return value; };
const timestamp = value => { if (value === null || value === undefined) return null; if (time(value) === null) fail('Hermes 历史时间无效。'); return new Date(value).toISOString(); };
const label = value => { if (typeof value !== 'string' || value.length > 240 || value.includes('://')
  || value && !/^[A-Za-z0-9][A-Za-z0-9_./:+-]*$/.test(value)) fail('Hermes 历史模型身份无效。'); return sanitizeDiagnosticText(value).slice(0, 240); };
const parse = value => { try { return JSON.parse(value); } catch { return null; } };

function usageView(value, recorded) {
  plain(value, COUNTERS);
  const usage = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null) continue;
    if (!safeInteger(item)) fail('Hermes 历史 Token 计数无效。');
    usage[key] = item;
  }
  if (recorded && !['input', 'output', 'total', 'calls'].every(key => usage[key] !== undefined)) fail('Hermes 历史核心用量不完整。');
  if (['input', 'cache_read', 'cache_write', 'prompt'].every(key => usage[key] !== undefined)
    && usage.input + usage.cache_read + usage.cache_write !== usage.prompt) fail('Hermes 历史输入用量不一致。');
  if (usage.completion !== undefined && usage.output !== undefined && usage.completion !== usage.output) fail('Hermes 历史输出用量不一致。');
  if (usage.total !== undefined && usage.prompt !== undefined && usage.output !== undefined && usage.total !== usage.prompt + usage.output) fail('Hermes 历史总用量不一致。');
  if (recorded && usage.calls === 0 && !COUNTERS.some(key => key !== 'calls' && usage[key] > 0)) fail('Hermes 未确认采集历史用量。');
  return usage;
}

function sessionView(value) {
  plain(value, ['storedSessionId', 'found', 'source', 'usage', 'tokensRecorded', 'startedAt', 'endedAt', 'firstMessageAt', 'lastMessageAt',
    'firstUserMessageAt', 'lastUserMessageAt', 'userMessageCount', 'messageCount', 'context', 'modelUsage', 'parentId', 'hasChildren', 'compressed']);
  const storedSessionId = identity(value.storedSessionId);
  if (typeof value.found !== 'boolean') fail('Hermes 历史会话状态无效。');
  if (!value.found) return { storedSessionId, found: false };
  if (value.source !== 'hermes.state-db' || typeof value.tokensRecorded !== 'boolean') fail('Hermes 历史用量来源无效。');
  const result = { storedSessionId, found: true, source: value.source, tokensRecorded: value.tokensRecorded,
    usage: usageView(value.usage, value.tokensRecorded), startedAt: timestamp(value.startedAt), endedAt: timestamp(value.endedAt),
    firstMessageAt: timestamp(value.firstMessageAt), lastMessageAt: timestamp(value.lastMessageAt),
    firstUserMessageAt: timestamp(value.firstUserMessageAt), lastUserMessageAt: timestamp(value.lastUserMessageAt),
    parentId: value.parentId == null ? null : identity(value.parentId), hasChildren: value.hasChildren ?? null, compressed: value.compressed ?? null,
    context: null, models: [] };
  for (const key of ['hasChildren', 'compressed']) if (result[key] !== null && typeof result[key] !== 'boolean') fail('Hermes 历史会话关系无效。');
  if (value.userMessageCount != null && !safeInteger(value.userMessageCount)) fail('Hermes 历史消息数量无效。');
  if (value.messageCount != null && !safeInteger(value.messageCount)) fail('Hermes 历史消息数量无效。');
  if (value.context != null) {
    const context = value.context;
    plain(context, ['used', 'max', 'percent', 'estimated', 'historical', 'kind', 'capturedAt', 'source']);
    if (!safeInteger(context.used) || context.max !== null || context.percent !== null || context.estimated !== false || context.historical !== true
      || context.kind !== 'last-request-input' || context.capturedAt !== null || context.source !== 'hermes.persisted-usage-anchor') fail('Hermes 历史上下文来源无效。');
    result.context = { used: context.used, max: null, percent: null, estimated: false, historical: true, kind: context.kind, capturedAt: null, source: context.source };
  }
  if (result.usage.total === 0 && result.context === null) result.tokensRecorded = false;
  if (value.modelUsage !== undefined && (!Array.isArray(value.modelUsage) || value.modelUsage.length > 200)) fail('Hermes 历史模型用量过大。');
  for (const model of value.modelUsage || []) {
    plain(model, ['model', 'provider', 'task', 'usage']);
    result.models.push({ model: label(model.model), provider: label(model.provider), task: label(model.task), usage: usageView(model.usage, false) });
  }
  return result;
}

// A cumulative session can only replace one exact local run. Re-evaluate this
// at read time as well: a later prompt must never reuse an older allocation.
export function historicalAllocation(record, session, runs, storedIdCount = 1) {
  const rejected = reason => ({ runId: null, reason });
  if (!record?.tokensRecorded) return rejected('unreported');
  if (!session || session.id !== record.sessionId || session.stored_session_id !== record.storedSessionId) return rejected('identity-changed');
  if (storedIdCount !== 1) return rejected('shared-stored-session');
  if (record.parentId || record.hasChildren !== false || record.compressed !== false) return rejected('lineage-unknown-or-shared');
  if (runs.length !== 1) return rejected(runs.length ? 'multiple-local-runs' : 'no-local-run');
  const run = runs[0];
  if (!TERMINAL.has(run.status) || time(run.started_at) === null || time(run.completed_at) === null || time(run.completed_at) < time(run.started_at)) return rejected('unfinished-local-run');
  const first = record.firstUserMessageAt || record.firstMessageAt, last = record.lastMessageAt;
  if (time(first) === null || time(last) === null || time(last) < time(first)) return rejected('message-time-unavailable');
  if (time(first) < time(run.started_at) - 5000 || time(last) > time(run.completed_at) + 5000) return rejected('history-outside-local-run');
  return { runId: run.id, reason: 'single-ended-local-run' };
}

export function historicalRunUsage(record, session, runs, storedIdCount, live) {
  const allocation = historicalAllocation(record, session, runs, storedIdCount);
  if (!allocation.runId || record.allocation?.runId !== allocation.runId) return live;
  if (live?.status === 'measured' || live?.status === 'reset') return live;
  if (live?.status === 'partial' && Object.entries(live.usage || {}).some(([key, value]) => COUNTERS.includes(key) && safeInteger(value)
    && (record.usage?.[key] === undefined || record.usage[key] < value))) return live;
  return { runId: allocation.runId, sessionId: session.id, usage: record.usage, status: 'measured', source: 'hermes.history', final: true, historical: true };
}

export class HistoricalUsage {
  constructor(app) {
    this.app = app; this.db = app.store.db; this.pending = null; this.closed = false;
    this.db.exec('CREATE TABLE IF NOT EXISTS hermes_usage_history (session_id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  read(sessionId) { return parse(this.db.prepare('SELECT value FROM hermes_usage_history WHERE session_id=?').get(sessionId)?.value); }
  close() { this.closed = true; }
  refresh() {
    if (this.pending) return this.pending;
    this.pending = this.collect().finally(() => { this.pending = null; });
    return this.pending;
  }
  async collect() {
    if (this.closed || this.app.closed) fail('工作台已关闭。', 409);
    if (this.app.adapter.state !== 'ready') fail('请先连接 Hermes 后补齐历史用量。', 503);
    const local = this.db.prepare('SELECT id,stored_session_id FROM sessions ORDER BY rowid').all();
    const refs = new Map();
    for (const session of local) {
      identity(session.id); identity(session.stored_session_id);
      if (!refs.has(session.stored_session_id)) refs.set(session.stored_session_id, []);
      refs.get(session.stored_session_id).push(session);
    }
    const summary = { matched: 0, imported: 0, updated: 0, unchanged: 0, missing: 0, unavailable: 0, attributedRuns: 0, ambiguousSessions: 0, contextSnapshots: 0 };
    const ids = [...refs.keys()];
    for (let offset = 0; offset < ids.length; offset += BATCH) {
      const batch = ids.slice(offset, offset + BATCH);
      const response = await this.app.adapter.request('workbench.usage.history', { stored_session_ids: batch }, 20000);
      if (this.closed || this.app.closed) fail('工作台已关闭，未写入历史用量。', 409);
      plain(response, ['schemaVersion', 'sessions']);
      if (response.schemaVersion !== 1 || !Array.isArray(response.sessions) || response.sessions.length !== batch.length) fail('Hermes 历史用量响应不完整。');
      const expected = new Set(batch), seen = new Set(), validated = [];
      for (const raw of response.sessions) {
        const row = sessionView(raw);
        if (!expected.has(row.storedSessionId) || seen.has(row.storedSessionId)) fail('Hermes 历史响应包含未请求或重复会话。');
        seen.add(row.storedSessionId); validated.push(row);
      }
      const importedAt = new Date().toISOString();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of validated) for (const target of refs.get(row.storedSessionId)) {
          const session = this.db.prepare('SELECT id,stored_session_id FROM sessions WHERE id=?').get(target.id);
          if (!session || session.stored_session_id !== row.storedSessionId) fail('会话身份在读取历史期间已变化。', 409);
          if (!row.found) { summary.missing++; continue; }
          summary.matched++;
          const record = { ...row, sessionId: session.id, importedAt };
          const runs = this.db.prepare('SELECT id,status,started_at,completed_at FROM runs WHERE session_id=? ORDER BY rowid').all(session.id);
          const count = this.db.prepare('SELECT count(*) n FROM sessions WHERE stored_session_id=?').get(row.storedSessionId).n;
          record.allocation = historicalAllocation(record, session, runs, count);
          if (record.allocation.runId) summary.attributedRuns++; else if (record.tokensRecorded) summary.ambiguousSessions++;
          if (record.context) summary.contextSnapshots++;
          if (!record.tokensRecorded) summary.unavailable++;
          if (record.tokensRecorded || record.context) summary.imported++;
          const previous = this.read(session.id);
          if (previous && JSON.stringify({ ...previous, importedAt: null }) === JSON.stringify({ ...record, importedAt: null })) summary.unchanged++;
          else { this.db.prepare('INSERT INTO hermes_usage_history(session_id,value) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET value=excluded.value').run(session.id, JSON.stringify(record)); summary.updated++; }
        }
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    return { ...summary, readOnlySource: true, source: 'hermes.state-db', completedAt: new Date().toISOString() };
  }
}
