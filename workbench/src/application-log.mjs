import { randomUUID } from 'node:crypto';

export const APPLICATION_LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error', 'fatal']);
const SEVERITY = Object.freeze(Object.fromEntries(APPLICATION_LOG_LEVELS.map((level, index) => [level, (index + 1) * 10])));
const DEFAULTS = Object.freeze({ maxEntries: 10000, maxBytes: 4 * 1024 * 1024, maxAgeDays: 14 });
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,179}$/;
const COMPONENT = /^[a-z][a-z0-9.-]{0,63}$/;
const EVENT = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const BOOT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const IDS = ['workflowId', 'runId', 'parentRunId', 'nodeId', 'sessionId', 'conversationId', 'turnId', 'requestId', 'operationId', 'learningId', 'scheduleId', 'attemptId'];
const LABELS = ['stage', 'phase', 'status', 'code', 'errorType', 'errorName', 'errorCode', 'model', 'provider', 'tool', 'mode', 'source', 'reason', 'functionName', 'timeoutKind'];
const NUMBERS = ['durationMs', 'elapsedMs', 'count', 'revision', 'attempt', 'httpStatus', 'modelCalls', 'toolCalls', 'historyRuns',
  'completed', 'failed', 'interrupted', 'unknown', 'queued', 'active', 'matched', 'imported', 'missing', 'unavailable', 'line', 'column',
  'waitMs', 'outputMs', 'promptCharacters', 'outputCharacters', 'firstResponseTimeoutMs', 'outputIdleTimeoutMs', 'maxDurationMs'];
const BOOLEANS = ['success', 'cacheHit', 'cancelled', 'timedOut', 'retryable', 'readOnly', 'partial'];
const FILTERS = ['limit', 'afterId', 'minLevel', 'component', 'workflowId', 'runId', 'nodeId', 'sessionId', 'conversationId', 'turnId', 'requestId', 'operationId', 'from', 'to'];
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const fail = message => { throw Object.assign(new Error(message), { httpStatus: 400 }); };
const own = (value, key) => value && Object.getOwnPropertyDescriptor(value, key)?.value;
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const byteSize = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const validTime = value => {
  if (typeof value !== 'string' || !ISO_TIME.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0), days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && Number(value.slice(11, 13)) <= 23;
};

// Values in a log are fixed diagnostic labels and identities, never a transcript
// or an arbitrary object. Redaction is still applied before storage and on read.
function safeLabel(value, max = 180) {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"',;}]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|csrf[_ -]?token|token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s"',;}\]&#]+/gi, '$1[REDACTED]')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  // A redacted label is omitted, rather than returning a fragment of supplied
  // content or accidentally accepting the prefix of a truncated credential.
  return clean === value && value.length <= max && LABEL.test(value) ? value : undefined;
}

function contextView(value) {
  if (!plain(value)) return {};
  const result = {};
  for (const key of IDS) {
    const item = own(value, key);
    if (typeof item === 'string' && IDENTIFIER.test(item) && safeLabel(item)) result[key] = item;
  }
  for (const key of LABELS) {
    const item = safeLabel(own(value, key), key === 'model' ? 180 : 128);
    if (item !== undefined) result[key] = item;
  }
  for (const key of NUMBERS) {
    const item = own(value, key);
    if (typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= Number.MAX_SAFE_INTEGER
      && (!['line', 'column'].includes(key) || Number.isSafeInteger(item))) result[key] = item;
  }
  for (const key of BOOLEANS) { const item = own(value, key); if (typeof item === 'boolean') result[key] = item; }
  const method = own(value, 'method');
  if (typeof method === 'string' && /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) result.method = method;
  const file = own(value, 'file');
  if (typeof file === 'string') {
    const relative = file.replace(/\\/g, '/');
    if (relative.length <= 180 && /^(?:src|public|shared|python|hdk)\/[A-Za-z0-9_./-]+\.(?:mjs|js|py|css|html)$/.test(relative)
      && relative.split('/').every(part => part && !part.startsWith('.')) && safeLabel(relative)) result.file = relative;
  }
  const route = own(value, 'route');
  if (typeof route === 'string') {
    const path = route.split(/[?#]/, 1)[0];
    if (path.length <= 180 && /^\/(?:[A-Za-z0-9_.:/\[\]{}-]*)$/.test(path)
      && safeLabel(path.slice(1).replace(/[\[\]{}]/g, '') || 'root')) result.route = path;
  }
  return result;
}

export function validateApplicationLogFilters(value = {}) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !FILTERS.includes(key)
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('日志筛选参数包含未知字段或访问器。');
  const result = { limit: 40, ...value };
  if (!Number.isSafeInteger(result.limit) || result.limit < 1 || result.limit > 100) fail('日志条数必须为1到100。');
  if (result.afterId !== undefined && (!Number.isSafeInteger(result.afterId) || result.afterId < 0)) fail('日志游标必须是非负整数。');
  if (result.minLevel !== undefined && (typeof result.minLevel !== 'string' || !Object.hasOwn(SEVERITY, result.minLevel))) fail('日志等级无效。');
  if (result.component !== undefined && (typeof result.component !== 'string' || !COMPONENT.test(result.component))) fail('日志模块无效。');
  for (const key of IDS.filter(key => FILTERS.includes(key))) if (result[key] !== undefined
    && (typeof result[key] !== 'string' || !IDENTIFIER.test(result[key]))) fail('日志关联身份无效。');
  for (const key of ['from', 'to']) if (result[key] !== undefined) {
    if (!validTime(result[key])) fail('日志时间必须是有效且带时区的ISO时间。');
    result[key] = new Date(result[key]).toISOString();
  }
  if (result.from && result.to && result.from > result.to) fail('日志开始时间不能晚于结束时间。');
  return result;
}

export class ApplicationLog {
  constructor(db, { level = 'info', maxEntries = DEFAULTS.maxEntries, maxBytes = DEFAULTS.maxBytes,
    maxAgeDays = DEFAULTS.maxAgeDays, now = () => new Date() } = {}) {
    this.db = db; this.level = typeof level === 'string' && Object.hasOwn(SEVERITY, level) ? level : 'info'; this.enabledLevel = this.level;
    this.retention = { maxEntries: Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULTS.maxEntries,
      maxBytes: Number.isSafeInteger(maxBytes) && maxBytes >= 128 ? maxBytes : DEFAULTS.maxBytes,
      maxAgeDays: typeof maxAgeDays === 'number' && Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays : DEFAULTS.maxAgeDays };
    this.now = typeof now === 'function' ? now : () => new Date(); this.bootId = randomUUID(); this.closed = false;
    this.available = false; this.dropped = 0; this.filtered = 0; this.storageErrors = 0; this.sequence = 0;
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS application_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, level TEXT NOT NULL, severity INTEGER NOT NULL,
        component TEXT NOT NULL, event TEXT NOT NULL, boot_id TEXT NOT NULL, context TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK(bytes>=0));
        CREATE INDEX IF NOT EXISTS application_logs_at ON application_logs(at);
        CREATE INDEX IF NOT EXISTS application_logs_level_component ON application_logs(severity,component);`);
      this.prune(); this.available = true;
    } catch { this.storageErrors++; }
  }

  clock() { const value = this.now(); return new Date(value).toISOString(); }
  cutoff() { return new Date(Date.parse(this.clock()) - this.retention.maxAgeDays * 86400000).toISOString(); }
  prune() {
    this.db.prepare('DELETE FROM application_logs WHERE at<?').run(this.cutoff());
    const totals = this.db.prepare('SELECT count(*) count,coalesce(sum(bytes),0) bytes FROM application_logs').get();
    let count = totals.count, size = totals.bytes;
    if (count <= this.retention.maxEntries && size <= this.retention.maxBytes) return;
    let last = null;
    for (const row of this.db.prepare('SELECT id,bytes FROM application_logs ORDER BY id').all()) {
      if (count <= this.retention.maxEntries && size <= this.retention.maxBytes) break;
      count--; size -= row.bytes; last = row.id;
    }
    if (last !== null) this.db.prepare('DELETE FROM application_logs WHERE id<=?').run(last);
  }

  write(level, event, value = {}) {
    if (this.closed) { this.dropped++; return null; }
    if (typeof level !== 'string' || !Object.hasOwn(SEVERITY, level) || typeof event !== 'string' || event.length > 96 || !EVENT.test(event) || !safeLabel(event)) { this.dropped++; return null; }
    if (SEVERITY[level] < SEVERITY[this.level]) { this.filtered++; return null; }
    let savepoint;
    try {
      const componentValue = own(value, 'component');
      const component = typeof componentValue === 'string' && COMPONENT.test(componentValue) && safeLabel(componentValue) ? componentValue : event.split('.')[0].slice(0, 64);
      const entry = { at: this.clock(), level, component, event, bootId: this.bootId, context: contextView(value) };
      const maximum = Math.min(4096, this.retention.maxBytes) - 32;
      while (byteSize(entry) > maximum && Object.keys(entry.context).length) delete entry.context[Object.keys(entry.context).at(-1)];
      const bytes = byteSize(entry);
      if (bytes > maximum) { this.dropped++; return null; }
      savepoint = 'application_log_' + ++this.sequence;
      this.db.exec('SAVEPOINT ' + savepoint);
      const result = this.db.prepare('INSERT INTO application_logs(at,level,severity,component,event,boot_id,context,bytes) VALUES(?,?,?,?,?,?,?,?)')
        .run(entry.at, level, SEVERITY[level], component, event, entry.bootId, JSON.stringify(entry.context), bytes);
      this.prune(); this.db.exec('RELEASE ' + savepoint); savepoint = null; this.available = true;
      return { id: Number(result.lastInsertRowid), ...entry };
    } catch {
      if (savepoint) { try { this.db.exec('ROLLBACK TO ' + savepoint); this.db.exec('RELEASE ' + savepoint); } catch { /* Never disturb the caller's outcome. */ } }
      this.available = false; this.storageErrors++; this.dropped++; return null;
    }
  }

  debug(event, context) { return this.write('debug', event, context); }
  info(event, context) { return this.write('info', event, context); }
  warn(event, context) { return this.write('warn', event, context); }
  error(event, context) { return this.write('error', event, context); }
  fatal(event, context) { return this.write('fatal', event, context); }
  close() { this.closed = true; }

  read(input = {}) {
    const filters = validateApplicationLogFilters(input);
    const result = { entries: [], nextAfterId: filters.afterId ?? 0, oldestId: null, latestId: null, hasMore: false,
      truncated: false, cursorExpired: false, direction: filters.afterId === undefined ? 'latest' : 'forward',
      retention: { ...this.retention }, enabledLevel: this.level,
      persistence: { available: this.available && !this.closed, closed: this.closed, dropped: this.dropped,
        filtered: this.filtered, storageErrors: this.storageErrors } };
    if (this.closed) return result;
    try {
      const where = ['at>=?'], parameters = [this.cutoff()];
      if (filters.afterId !== undefined) { where.push('id>?'); parameters.push(filters.afterId); }
      if (filters.minLevel !== undefined) { where.push('severity>=?'); parameters.push(SEVERITY[filters.minLevel]); }
      if (filters.component !== undefined) { where.push('component=?'); parameters.push(filters.component); }
      for (const key of IDS.filter(key => FILTERS.includes(key))) if (filters[key] !== undefined) {
        where.push(`json_extract(context,'$.${key}')=?`); parameters.push(filters[key]);
      }
      if (filters.from !== undefined) { where.push('at>=?'); parameters.push(filters.from); }
      if (filters.to !== undefined) { where.push('at<=?'); parameters.push(filters.to); }
      const bounds = this.db.prepare('SELECT min(id) oldestId,max(id) latestId FROM application_logs WHERE at>=?').get(this.cutoff());
      Object.assign(result, bounds);
      result.cursorExpired = filters.afterId !== undefined && filters.afterId > 0 && bounds.oldestId !== null && filters.afterId < bounds.oldestId - 1;
      const order = filters.afterId === undefined ? 'DESC' : 'ASC';
      const rows = this.db.prepare('SELECT id,at,level,component,event,boot_id,context FROM application_logs WHERE ' + where.join(' AND ') + ' ORDER BY id ' + order + ' LIMIT ?')
        .all(...parameters, filters.limit + 1);
      result.hasMore = rows.length > filters.limit; result.truncated = result.hasMore || result.cursorExpired;
      const selected = rows.slice(0, filters.limit); if (filters.afterId === undefined) selected.reverse();
      for (const row of selected) {
        if (!Object.hasOwn(SEVERITY, row.level) || typeof row.event !== 'string' || row.event.length > 96 || !EVENT.test(row.event) || !safeLabel(row.event)
          || typeof row.component !== 'string' || !COMPONENT.test(row.component) || !safeLabel(row.component)
          || typeof row.boot_id !== 'string' || !BOOT.test(row.boot_id)
          || !validTime(row.at)) continue;
        let context; try { context = JSON.parse(row.context); } catch { continue; }
        result.entries.push({ id: row.id, at: row.at, level: row.level, component: row.component,
          event: row.event, bootId: row.boot_id, context: contextView(context) });
      }
      result.nextAfterId = selected.at(-1)?.id ?? result.nextAfterId;
      this.available = true; result.persistence.available = true; return result;
    } catch {
      this.available = false; this.storageErrors++; result.persistence.available = false;
      result.persistence.storageErrors = this.storageErrors; return result;
    }
  }
}
