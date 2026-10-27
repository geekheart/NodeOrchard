import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'workbench.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, cwd TEXT NOT NULL,
        stored_session_id TEXT NOT NULL, runtime_session_id TEXT,
        status TEXT NOT NULL, has_prompted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT,
        error TEXT, outcome TEXT
      );
      CREATE TABLE IF NOT EXISTS preferences (
        id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL
      );`);
    if (!this.db.prepare('PRAGMA table_info(sessions)').all().some(column => column.name === 'model')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN model TEXT NOT NULL DEFAULT ''");
    }
    if (!this.db.prepare('PRAGMA table_info(sessions)').all().some(column => column.name === 'provider')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT ''");
      // Every session created before provider persistence was explicitly routed
      // to this one provider. Preserve that historical identity on migration.
      this.db.exec("UPDATE sessions SET provider='openai-codex' WHERE model<>''");
    }
    this.db.prepare("UPDATE sessions SET runtime_session_id=NULL, status='disconnected'").run();
    this.db.prepare("UPDATE runs SET status='unknown', completed_at=?, error='应用重启；请恢复 Hermes 会话核对，未自动重试。' WHERE status IN ('running','waiting')").run(new Date().toISOString());
  }

  map(row) {
    return row && { id: row.id, title: row.title, cwd: row.cwd, storedSessionId: row.stored_session_id,
      runtimeSessionId: row.runtime_session_id, status: row.status, hasPrompted: Boolean(row.has_prompted),
      model: row.model, provider: row.provider, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  list() { return this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all().map(row => this.map(row)); }
  get(id) { return this.map(this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id)); }
  byRuntime(id) { return this.map(this.db.prepare('SELECT * FROM sessions WHERE runtime_session_id=?').get(id)); }
  create({ title, cwd, storedSessionId, runtimeSessionId, model = '', provider = '' }) {
    const id = randomUUID(); const now = new Date().toISOString();
    this.db.prepare('INSERT INTO sessions(id,title,cwd,stored_session_id,runtime_session_id,status,model,provider,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, title, cwd, storedSessionId, runtimeSessionId, 'idle', model, provider, now, now);
    return this.get(id);
  }
  update(id, { runtimeSessionId, storedSessionId, status, hasPrompted, model, provider } = {}) {
    const current = this.get(id);
    if (!current) throw new Error('会话不存在。');
    this.db.prepare('UPDATE sessions SET runtime_session_id=?,stored_session_id=?,status=?,has_prompted=?,model=?,provider=?,updated_at=? WHERE id=?')
      .run(runtimeSessionId === undefined ? current.runtimeSessionId : runtimeSessionId,
        storedSessionId ?? current.storedSessionId, status ?? current.status,
        Number(hasPrompted ?? current.hasPrompted), model ?? current.model, provider ?? current.provider, new Date().toISOString(), id);
    return this.get(id);
  }
  beginRun(sessionId) {
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    this.db.prepare('INSERT INTO runs(id,session_id,status,started_at) VALUES(?,?,?,?)').run(id, sessionId, 'running', startedAt);
    try { this.sessionUsage?.beginRun(id, sessionId, startedAt); } catch { /* Telemetry cannot block execution. */ }
    this.update(sessionId, { status: 'running' });
    return id;
  }
  finishRun(sessionId, status, error = '', outcome = '') {
    try { this.sessionUsage?.finishRuns(sessionId); } catch { /* Missing terminal telemetry is not an execution failure. */ }
    this.db.prepare("UPDATE runs SET status=?,completed_at=?,error=?,outcome=? WHERE session_id=? AND status IN ('running','waiting')")
      .run(status, new Date().toISOString(), error, outcome, sessionId);
  }
  runs(sessionId) { return this.db.prepare('SELECT * FROM runs WHERE session_id=? ORDER BY started_at').all(sessionId); }
  preferences() {
    try { return JSON.parse(this.db.prepare('SELECT value FROM preferences WHERE id=1').get()?.value || 'null'); }
    catch { return null; }
  }
  savePreferences(preferences) {
    this.db.prepare('INSERT INTO preferences(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(JSON.stringify(preferences));
  }
  statistics(days = 7, now = new Date()) {
    if (![7, 30].includes(days)) throw new Error('统计范围必须是 7 或 30 天。');
    const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const start = new Date(today.getTime() - (days - 1) * 86400000);
    const end = new Date(today.getTime() + 86400000);
    const daily = Array.from({ length: days }, (_, index) => ({
      date: new Date(start.getTime() + index * 86400000).toISOString().slice(0, 10),
      runs: 0, completed: 0, failed: 0, interrupted: 0, unknown: 0,
    }));
    const byDate = new Map(daily.map(day => [day.date, day]));
    const rows = this.db.prepare(`SELECT runs.*, sessions.title AS session_title FROM runs
      JOIN sessions ON sessions.id=runs.session_id WHERE runs.started_at>=? AND runs.started_at<?
      ORDER BY runs.started_at DESC, runs.id DESC`).all(start.toISOString(), end.toISOString());
    const totals = { sessions: this.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count,
      runs: rows.length, completed: 0, failed: 0, interrupted: 0, unknown: 0,
      active: this.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE status IN ('running','waiting')").get().count,
      successRate: null };
    for (const row of rows) {
      const day = byDate.get(row.started_at.slice(0, 10));
      if (day) day.runs++;
      const status = ({ complete: 'completed', completed: 'completed', error: 'failed', failed: 'failed',
        interrupted: 'interrupted', unknown: 'unknown' })[row.status];
      if (status) { totals[status]++; if (day) day[status]++; }
    }
    const terminal = totals.completed + totals.failed + totals.interrupted + totals.unknown;
    totals.successRate = terminal ? totals.completed / terminal : null;
    const recentRuns = rows.slice(0, 20).map(row => ({ id: row.id, sessionId: row.session_id,
      sessionTitle: row.session_title, status: row.status, startedAt: row.started_at,
      completedAt: row.completed_at, error: row.error || '' }));
    return { days, totals, daily, recentRuns };
  }
  close() { this.db.close(); }
}
