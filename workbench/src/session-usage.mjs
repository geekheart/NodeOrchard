// Hermes reports cumulative session counters. Persist snapshots and per-run
// deltas; never sum repeated streaming snapshots or guess missing history.
const COUNTERS = ['input', 'output', 'prompt', 'completion', 'reasoning', 'total', 'calls', 'compressions'];
const CORE = ['input', 'output', 'total', 'calls'];
const INTEGERS = [...COUNTERS, 'context_used', 'context_max', 'active_subagents'];
const RATIOS = ['context_percent', 'cache_hit_pct'];
const RATES = ['avg_latency_s', 'avg_tps'];
const CONTEXT_MEASUREMENTS = ['context_used', 'context_max', 'context_percent'];
const SOURCES = new Set(['session.create', 'session.resume', 'session.info', 'session.usage', 'message.complete']);
const CONTEXT_SOURCES = new Set(['provider_usage', 'local_estimate', 'provider_usage_plus_estimate']);
const own = (value, key) => { const field = Object.getOwnPropertyDescriptor(value, key); return field && Object.hasOwn(field, 'value') ? field.value : undefined; };
const object = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const counters = usage => Object.fromEntries(COUNTERS.filter(key => usage?.[key] !== undefined).map(key => [key, usage[key]]));
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString();

export function sanitizeSessionUsage(value) {
  if (!object(value)) return null;
  const usage = {};
  for (const key of INTEGERS) { const item = own(value, key); if (Number.isSafeInteger(item) && item >= 0) usage[key] = item; }
  for (const key of RATIOS) { const item = own(value, key); if (typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 100) usage[key] = item; }
  for (const key of RATES) { const item = own(value, key); if (typeof item === 'number' && Number.isFinite(item) && item >= 0 && item < 1e6) usage[key] = item; }
  const estimated = own(value, 'context_estimated'), source = own(value, 'context_source');
  if (typeof estimated === 'boolean') usage.context_estimated = estimated;
  if (CONTEXT_SOURCES.has(source)) usage.context_source = source;
  return Object.keys(usage).length ? usage : null;
}

export class SessionUsage {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS session_usage (session_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_usage (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS run_usage_session ON run_usage(session_id);`);
  }
  read(sessionId) { const row = this.db.prepare('SELECT value FROM session_usage WHERE session_id=?').get(sessionId); return row ? JSON.parse(row.value) : null; }
  readRun(runId) { const row = this.db.prepare('SELECT value FROM run_usage WHERE run_id=?').get(runId); return row ? JSON.parse(row.value) : null; }
  runs() { return this.db.prepare('SELECT value FROM run_usage ORDER BY rowid').all().map(row => JSON.parse(row.value)); }
  writeSession(value) { this.db.prepare('INSERT INTO session_usage(session_id,value) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET value=excluded.value').run(value.sessionId, JSON.stringify(value)); }
  writeRun(value) { this.db.prepare('INSERT INTO run_usage(run_id,session_id,value) VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET value=excluded.value').run(value.runId, value.sessionId, JSON.stringify(value)); }
  registerNew(sessionId) {
    if (this.read(sessionId)) return;
    this.writeSession({ sessionId, capturedAt: null, contextCapturedAt: null, source: 'session.create', generation: 0, newSession: true, usage: {} });
  }
  beginRun(runId, sessionId, startedAt) {
    if (this.readRun(runId)) return;
    const snapshot = this.read(sessionId);
    const previousRun = this.db.prepare('SELECT id,completed_at FROM runs WHERE session_id=? AND rowid<(SELECT rowid FROM runs WHERE id=?) ORDER BY rowid DESC LIMIT 1').get(sessionId, runId);
    const previousUsage = previousRun && this.readRun(previousRun.id);
    // A tick from an earlier unfinished/unmeasured turn is not the next turn's
    // baseline. A new snapshot taken after that turn settles can establish it.
    const stale = previousRun && !previousUsage?.final && (!snapshot?.capturedAt
      || !previousRun.completed_at || snapshot.capturedAt <= previousRun.completed_at);
    const baseline = snapshot?.newSession
      ? Object.fromEntries(COUNTERS.map(key => [key, snapshot.usage[key] ?? 0])) : stale ? {} : counters(snapshot?.usage);
    this.writeRun({ runId, sessionId, startedAt: timestamp(startedAt), updatedAt: null, source: null,
      generation: snapshot?.generation ?? 0, baseline, usage: {}, status: 'missing', final: false,
      baselineComplete: CORE.every(key => baseline[key] !== undefined) });
    if (snapshot?.newSession) this.writeSession({ ...snapshot, newSession: false });
  }
  finishRuns(sessionId) {
    for (const row of this.db.prepare("SELECT id FROM runs WHERE session_id=? AND status IN ('running','waiting')").all(sessionId)) {
      const record = this.readRun(row.id);
      if (record && !record.final && record.status === 'measured') this.writeRun({ ...record, status: 'partial' });
    }
  }
  observe(sessionId, value, { source = 'session.usage', at, final = false } = {}) {
    const usage = sanitizeSessionUsage(value);
    if (!usage || !SOURCES.has(source) || !this.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(sessionId)) return null;
    const previous = this.read(sessionId), capturedAt = timestamp(at);
    const reset = COUNTERS.some(key => usage[key] !== undefined && previous?.usage?.[key] !== undefined && usage[key] < previous.usage[key]);
    const generation = (previous?.generation ?? 0) + Number(reset);
    const contextCapturedAt = CONTEXT_MEASUREMENTS.some(key => usage[key] !== undefined) ? capturedAt : reset ? null
      : previous?.contextCapturedAt ?? (CONTEXT_MEASUREMENTS.some(key => previous?.usage?.[key] !== undefined) ? previous.capturedAt : null);
    // Omitted counters remain unknown rather than being silently replaced by 0.
    const snapshot = { sessionId, capturedAt, contextCapturedAt, source, generation, newSession: previous?.newSession === true,
      usage: reset ? usage : { ...(previous?.usage || {}), ...usage } };
    this.writeSession(snapshot);
    const run = this.db.prepare("SELECT id FROM runs WHERE session_id=? AND status IN ('running','waiting') ORDER BY rowid DESC LIMIT 1").get(sessionId);
    const record = run && this.readRun(run.id);
    if (record) {
      const baseline = { ...record.baseline }, delta = { ...record.usage };
      const incomplete = !record.baselineComplete;
      // A terminal frame containing only context or some counters cannot make
      // earlier ticker readings a complete, authoritative terminal measurement.
      const terminalComplete = Boolean(final && CORE.every(key => usage[key] !== undefined));
      const terminalPartial = final && !terminalComplete && !record.final;
      if (reset || record.generation !== generation) {
        this.writeRun({ ...record, generation, baseline: counters(usage), usage: {}, status: 'reset', baselineComplete: false,
          final: terminalComplete, source, updatedAt: capturedAt });
      } else {
        for (const key of COUNTERS) {
          if (usage[key] === undefined) continue;
          if (baseline[key] === undefined) baseline[key] = usage[key];
          else delta[key] = usage[key] - baseline[key];
        }
        const hasDelta = Object.keys(delta).length > 0;
        const status = record.status === 'reset' ? 'reset' : !hasDelta ? 'missing' : incomplete || terminalPartial ? 'partial' : 'measured';
        this.writeRun({ ...record, baseline, usage: delta, status, final: Boolean(terminalComplete || record.final), source, updatedAt: capturedAt });
      }
    }
    return snapshot;
  }
}
