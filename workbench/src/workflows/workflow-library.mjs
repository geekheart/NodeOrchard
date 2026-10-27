import { validateDocument } from '../../shared/workflow/workflow-model.mjs';
import { planWorkflow } from '../../shared/workflow/workflow-plan.mjs';
import { redact } from '../hermes-adapter.mjs';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ACTIVE_RUN = new Set(['preparing', 'running', 'waiting', 'queued']);
const ACTIVE_LEARNING = new Set(['running', 'waiting']);
const BUSY_RUN = new Set([...ACTIVE_RUN, 'waiting_review']);
const LIFECYCLES = new Set(['active', 'archived', 'trashed']);
// Old action names remain aliases with the same revision and state barriers.
const TRANSITIONS = Object.freeze({ archive: ['active', 'trashed'], unarchive: ['trashed', 'active'],
  trash: ['active', 'trashed'], restore: ['trashed', 'active'], purge: ['trashed', 'deleted'] });
const ATTENTION = new Set(['error', 'failed', 'interrupted', 'unknown', 'exhausted', 'waiting_review']);
const LIMIT = 2 * 1024 * 1024;
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const errorText = value => value ? redact(String(value)).slice(0, 4000) : '';
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const activityTime = value => Math.max(timestamp(value?.startedAt), timestamp(value?.completedAt));

function id(value) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) fail('无效的工作流 ID。');
  return value;
}

function cleanDocument(input) {
  let document;
  try { document = validateDocument(input); }
  catch (error) { fail(error.message); }
  if (Buffer.byteLength(JSON.stringify(document), 'utf8') > LIMIT) fail('工作流不能超过 2MB。', 413);
  return document;
}

function body(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('工作流保存内容必须是对象。');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!['document', 'expectedRevision'].includes(key)) fail('工作流保存内容包含未知字段。');
    if (!Object.hasOwn(descriptor, 'value')) fail('工作流保存内容不能包含访问器。');
  }
  if (Object.getOwnPropertySymbols(value).length) fail('工作流保存内容不允许 Symbol 字段。');
  if (Object.hasOwn(value, 'expectedRevision') && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0)) fail('expectedRevision 必须是非负整数。');
  return value;
}

function transitionOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('工作流管理请求必须是对象。');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => !['expectedRevision', 'confirmationTitle'].includes(key))) fail('工作流管理请求包含未知字段。');
  if (Object.values(fields).some(field => !Object.hasOwn(field, 'value'))) fail('工作流管理请求不能包含访问器。');
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1) fail('expectedRevision 必须是正整数。');
  if (Object.hasOwn(value, 'confirmationTitle') && typeof value.confirmationTitle !== 'string') fail('确认名称必须是文本。');
  return value;
}

export class WorkflowLibrary {
  constructor(app) {
    this.app = app;
    this.db = app.store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS workflow_documents (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, document TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'saved'
    ); CREATE TABLE IF NOT EXISTS workflow_library_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workflow_lifecycle (
      workflow_id TEXT PRIMARY KEY, lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','archived','trashed')),
      archived_at TEXT, trashed_at TEXT
    );`);
    if (!this.db.prepare('PRAGMA table_info(workflow_documents)').all().some(column => column.name === 'origin')) {
      this.db.exec("ALTER TABLE workflow_documents ADD COLUMN origin TEXT NOT NULL DEFAULT 'saved'");
    }
    this.read = this.db.prepare('SELECT * FROM workflow_documents WHERE id=?');
    this.seedHistory();
  }

  tableExists(name) { return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }

  isDeleted(workflowId) {
    return !!this.db.prepare('SELECT 1 FROM workflow_library_meta WHERE key=?').get('deleted:' + workflowId);
  }

  assertAvailable(workflowId) {
    if (this.isDeleted(workflowId)) fail('此工作流已删除，旧草稿不会自动恢复到看板。', 410);
  }

  lifecycle(workflowId) {
    const row = this.db.prepare('SELECT lifecycle,archived_at,trashed_at FROM workflow_lifecycle WHERE workflow_id=?').get(workflowId);
    // Read old archives as trash without rewriting user definitions or history.
    return { lifecycle: row?.lifecycle === 'archived' ? 'trashed' : row?.lifecycle || 'active',
      archivedAt: row?.archived_at || null, trashedAt: row?.trashed_at || (row?.lifecycle === 'archived' ? row.archived_at : null) || null };
  }

  assertRunnable(workflowId) {
    const workflow = id(workflowId);
    this.assertAvailable(workflow);
    const { lifecycle } = this.lifecycle(workflow);
    if (lifecycle !== 'active') fail('此工作流已移入回收站，请先恢复后再使用。', 409);
  }

  record(row) {
    return { id: row.id, document: JSON.parse(row.document), revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, origin: row.origin,
      ...this.lifecycle(row.id) };
  }

  get(workflowId) {
    const workflow = id(workflowId);
    this.assertAvailable(workflow);
    const row = this.read.get(workflow);
    if (!row) fail('工作流文档不存在。', 404);
    return this.record(row);
  }

  save(input) {
    const request = body(input);
    const document = cleanDocument(request.document);
    this.assertRunnable(document.id);
    const serialized = JSON.stringify(document);
    const previous = this.read.get(document.id);
    // A lost response can safely retry an identical document. This path never
    // writes, including when a different window already saved the same content.
    if (previous?.document === serialized && previous.origin === 'saved') return this.record(previous);
    if (previous ? request.expectedRevision !== previous.revision : (request.expectedRevision !== undefined && request.expectedRevision !== 0)) {
      fail('工作流文档已变化，请重新打开最新版本后再保存。', 409);
    }
    const now = new Date().toISOString();
    if (previous) {
      const result = this.db.prepare("UPDATE workflow_documents SET document=?,origin='saved',revision=revision+1,updated_at=? WHERE id=? AND revision=?")
        .run(serialized, now, document.id, request.expectedRevision);
      if (!result.changes) fail('工作流文档已变化，请重新打开最新版本后再保存。', 409);
    } else {
      try {
        this.db.prepare("INSERT INTO workflow_documents(id,revision,created_at,updated_at,document,origin) VALUES(?,1,?,?,?,'saved')")
          .run(document.id, now, now, serialized);
      } catch (error) {
        if (this.read.get(document.id)) fail('工作流文档已由其它窗口创建，请重新打开后再保存。', 409);
        throw error;
      }
    }
    const saved = this.get(document.id);
    this.app.publish?.('workflow.document', null, { workflow: this.summary(saved, this.activities()) });
    return saved;
  }

  assertIdle(workflowId) {
    // Locks cover asynchronous Skill/version resolution before its first durable
    // run or learning record exists. Sample and feedback jobs count equally.
    if (this.app.workflows?.locks?.has(workflowId) || this.app.learning?.locks?.has(workflowId)
      || this.app.learning?.isLocked?.(workflowId)) fail('此工作流仍在准备、排队、执行、学习或等待审核，请先停止后再管理。', 409);
    for (const [manager, field] of [[this.app.workflows, 'run'], [this.app.workflows?.dag, 'run'], [this.app.learning, 'job']]) {
      if (!manager?.active?.values) continue;
      for (const state of manager.active.values()) if (state?.[field]?.workflowId === workflowId) {
        fail('此工作流仍在准备、排队、执行、学习或等待审核，请先停止后再管理。', 409);
      }
    }
    if (this.tableExists('workflow_runs')) {
      const rows = this.db.prepare("SELECT id,value FROM workflow_runs WHERE json_valid(value) AND json_extract(value,'$.workflowId')=?").all(workflowId);
      for (const row of rows) {
        const run = JSON.parse(row.value);
        if (BUSY_RUN.has(run.status) || Object.values(run.nodes || {}).some(node => node?.status === 'waiting_review')
          || this.app.workflows?.dag?.mutations?.has(row.id)) fail('此工作流还有排队、运行、待审核或正在重跑的任务，请先停止后再管理。', 409);
      }
    }
    if (this.tableExists('workflow_learning')) {
      const row = this.db.prepare("SELECT 1 FROM workflow_learning WHERE json_valid(value) AND json_extract(value,'$.workflowId')=? AND json_extract(value,'$.status') IN ('preparing','queued','running','waiting','waiting_review') LIMIT 1").get(workflowId);
      if (row) fail('此工作流还有执行中或待审核的学习批次，请先停止后再管理。', 409);
    }
  }

  pauseSchedules(workflowId, now) {
    if (!this.tableExists('workflow_schedules')) return [];
    const paused = [];
    for (const row of this.db.prepare("SELECT id,revision,value FROM workflow_schedules WHERE json_valid(value) AND json_extract(value,'$.workflowId')=?").all(workflowId)) {
      const previous = JSON.parse(row.value);
      if (!previous.enabled && previous.nextRunAt == null && previous.lastTrigger?.status !== 'claimed') continue;
      const schedule = { ...previous, enabled: false, nextRunAt: null, revision: row.revision + 1, updatedAt: now };
      if (schedule.lastTrigger?.status === 'claimed') schedule.lastTrigger = { ...schedule.lastTrigger, status: 'cancelled', error: '工作流已移入回收站；本次定时触发已取消，未补跑。' };
      const result = this.db.prepare('UPDATE workflow_schedules SET revision=?,value=? WHERE id=? AND revision=?')
        .run(schedule.revision, JSON.stringify(schedule), row.id, row.revision);
      if (!result.changes) fail('关联定时任务已变化，请刷新后重试。', 409);
      paused.push(schedule);
    }
    return paused;
  }

  transition(workflowId, action, options) {
    const workflow = id(workflowId), request = transitionOptions(options);
    if (typeof action !== 'string' || !Object.hasOwn(TRANSITIONS, action)) fail('无效的工作流管理操作。');
    if (action !== 'purge' && Object.hasOwn(request, 'confirmationTitle')) fail('只有永久删除操作接受确认名称。');
    let schedules = [], result;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const record = this.get(workflow);
      if (record.revision !== request.expectedRevision) fail('工作流文档已变化，请刷新最新版本后再操作。', 409);
      const [required, next] = TRANSITIONS[action];
      if (record.lifecycle !== required) fail('工作流状态已变化；请先移入回收站，再恢复或永久删除。', 409);
      if (action === 'purge' && request.confirmationTitle !== record.document.title) fail('请输入完整工作流名称以确认永久删除。');
      this.assertIdle(workflow);
      const now = new Date(Math.max(Date.now(), timestamp(record.updatedAt) + 1)).toISOString();
      if (next === 'trashed') schedules = this.pauseSchedules(workflow, now);
      if (action === 'purge') {
        this.db.prepare('INSERT INTO workflow_library_meta(key,value) VALUES(?,?)')
          .run('deleted:' + workflow, JSON.stringify({ deletedAt: now, revision: record.revision + 1, title: record.document.title }));
        this.db.prepare('DELETE FROM workflow_documents WHERE id=? AND revision=?').run(workflow, record.revision);
        this.db.prepare('DELETE FROM workflow_lifecycle WHERE workflow_id=?').run(workflow);
        result = { deleted: true, id: workflow, lifecycle: 'deleted' };
      } else {
        const archivedAt = null;
        const trashedAt = next === 'trashed' ? now : null;
        this.db.prepare(`INSERT INTO workflow_lifecycle(workflow_id,lifecycle,archived_at,trashed_at) VALUES(?,?,?,?)
          ON CONFLICT(workflow_id) DO UPDATE SET lifecycle=excluded.lifecycle,archived_at=excluded.archived_at,trashed_at=excluded.trashed_at`)
          .run(workflow, next, archivedAt, trashedAt);
        if (!this.db.prepare('UPDATE workflow_documents SET revision=revision+1,updated_at=? WHERE id=? AND revision=?')
          .run(now, workflow, record.revision).changes) fail('工作流文档已变化，请刷新最新版本后再操作。', 409);
        result = { workflow: this.summary(this.get(workflow), this.activities()) };
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    // No network work is allowed in the scheduler hook: it only fences pending
    // in-memory admissions after their durable schedules have been paused.
    if (TRANSITIONS[action][1] === 'trashed') this.app.schedules?.onWorkflowArchived?.(workflow, schedules);
    for (const schedule of schedules) this.app.publish?.('workflow.schedule', null, { schedule });
    this.app.publish?.('workflow.document', null, result);
    this.app.publish?.('workflow.lifecycle', null, result);
    return result;
  }

  seedHistory() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare("SELECT 1 FROM workflow_library_meta WHERE key='history-seed-v1'").get()) {
        this.db.exec('COMMIT'); return;
      }
      const candidates = new Map();
      for (const table of ['workflow_runs', 'workflow_learning', 'workflow_schedules']) {
        if (!this.tableExists(table)) continue;
        const rows = this.db.prepare(`SELECT json_extract(value,'$.document') AS document,
          json_extract(value,'$.workflowId') AS workflow_id,
          json_extract(value,'$.startedAt') AS started_at,
          json_extract(value,'$.createdAt') AS created_at,
          json_extract(value,'$.updatedAt') AS updated_at
          FROM ${table} WHERE json_valid(value) AND json_type(value,'$.document')='object'
          ${table === 'workflow_runs' ? "AND json_extract(value,'$.learningId') IS NULL" : ''}`).all();
        for (const row of rows) {
          try {
            const document = cleanDocument(JSON.parse(row.document));
            if (row.workflow_id !== document.id || this.isDeleted(document.id)) continue;
            // Learning sample runs contain transient candidate references. Only
            // the ordinary execution, original learning job, or saved schedule
            // document is a reusable historical source, never an unapplied best.
            const at = table === 'workflow_schedules' ? row.updated_at || row.created_at : row.started_at || row.created_at || row.updated_at;
            const time = timestamp(at);
            const current = candidates.get(document.id);
            if (!current || time > current.time) candidates.set(document.id, { document, time, at: time ? new Date(time).toISOString() : new Date().toISOString() });
          } catch { /* Invalid old snapshots do not prevent opening the library. */ }
        }
      }
      const insert = this.db.prepare("INSERT OR IGNORE INTO workflow_documents(id,revision,created_at,updated_at,document,origin) VALUES(?,1,?,?,?,'history')");
      for (const { document, at } of candidates.values()) insert.run(document.id, at, at, JSON.stringify(document));
      this.db.prepare("INSERT INTO workflow_library_meta(key,value) VALUES('history-seed-v1','complete')").run();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  activities() {
    const index = new Map();
    const entry = workflowId => {
      if (!index.has(workflowId)) index.set(workflowId, { latestRun: null, latestLearning: null, active: false, scheduleCount: 0, nextRunAt: null });
      return index.get(workflowId);
    };
    if (this.tableExists('workflow_runs')) {
      const rows = this.db.prepare(`SELECT json_extract(value,'$.workflowId') AS workflow_id,
        json_extract(value,'$.id') AS id, json_extract(value,'$.status') AS status,
        json_extract(value,'$.error') AS error, json_extract(value,'$.startedAt') AS started_at,
        json_extract(value,'$.completedAt') AS completed_at, json_extract(value,'$.trigger') AS trigger
        FROM workflow_runs WHERE json_valid(value) AND json_extract(value,'$.learningId') IS NULL ORDER BY rowid DESC`).all();
      for (const row of rows) {
        const data = entry(row.workflow_id);
        const run = { id: row.id, status: row.status, error: errorText(row.error), startedAt: row.started_at, completedAt: row.completed_at,
          ...(row.trigger ? { trigger: JSON.parse(row.trigger) } : {}) };
        data.active ||= ACTIVE_RUN.has(run.status);
        if (!data.latestRun || activityTime(run) > activityTime(data.latestRun)) data.latestRun = run;
      }
    }
    if (this.tableExists('workflow_learning')) {
      const rows = this.db.prepare(`SELECT json_extract(value,'$.workflowId') AS workflow_id,
        json_extract(value,'$.id') AS id, json_extract(value,'$.status') AS status,
        json_extract(value,'$.phase') AS phase, json_extract(value,'$.error') AS error,
        json_extract(value,'$.startedAt') AS started_at, json_extract(value,'$.completedAt') AS completed_at,
        json_extract(value,'$.bestScore') AS best_score, json_extract(value,'$.bestRound') AS best_round
        FROM workflow_learning WHERE json_valid(value) ORDER BY rowid DESC`).all();
      for (const row of rows) {
        const data = entry(row.workflow_id);
        const job = { id: row.id, status: row.status, phase: row.phase, error: errorText(row.error), startedAt: row.started_at,
          completedAt: row.completed_at, bestScore: row.best_score, bestRound: row.best_round };
        data.active ||= ACTIVE_LEARNING.has(job.status);
        if (!data.latestLearning || activityTime(job) > activityTime(data.latestLearning)) data.latestLearning = job;
      }
    }
    if (this.tableExists('workflow_schedules')) {
      const rows = this.db.prepare(`SELECT json_extract(value,'$.workflowId') AS workflow_id,
        MIN(json_extract(value,'$.nextRunAt')) AS next_run_at, COUNT(*) AS count
        FROM workflow_schedules WHERE json_valid(value) AND json_extract(value,'$.enabled')=1
        GROUP BY json_extract(value,'$.workflowId')`).all();
      for (const row of rows) Object.assign(entry(row.workflow_id), { scheduleCount: row.count, nextRunAt: row.next_run_at });
    }
    return index;
  }

  summary(record, activities) {
    const document = record.document;
    let readiness;
    try { planWorkflow({ ...document, mode: 'execute' }); readiness = { ready: true, error: '' }; }
    catch (error) { readiness = { ready: false, error: errorText(error.message) }; }
    const data = activities.get(record.id) || { latestRun: null, latestLearning: null, active: false, scheduleCount: 0, nextRunAt: null };
    const recent = [data.latestRun, data.latestLearning].filter(Boolean).sort((a, b) => activityTime(b) - activityTime(a))[0];
    const state = data.active ? 'running' : ATTENTION.has(recent?.status) ? 'attention' : readiness.ready ? 'ready' : 'draft';
    return { id: record.id, title: document.title, mode: document.mode, revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt,
      lifecycle: record.lifecycle, archivedAt: record.archivedAt, trashedAt: record.trashedAt,
      nodeCount: document.nodes.length, edgeCount: document.edges.length,
      skillNames: [...new Set(document.nodes.filter(node => node.type === 'skill' && node.config.skillRef).map(node => node.config.skillRef))],
      state, readiness, latestRun: data.latestRun, latestLearning: data.latestLearning, scheduleCount: data.scheduleCount, nextRunAt: data.nextRunAt };
  }

  list({ lifecycle = 'active' } = {}) {
    if (!LIFECYCLES.has(lifecycle) && lifecycle !== 'all') fail('无效的工作流分类。');
    if (lifecycle === 'archived') lifecycle = 'trashed';
    const activities = this.activities();
    return this.db.prepare(`SELECT document.* FROM workflow_documents AS document
      WHERE NOT EXISTS (SELECT 1 FROM workflow_library_meta AS meta WHERE meta.key='deleted:' || document.id)
      ORDER BY document.updated_at DESC,document.rowid DESC`).all()
      .map(row => this.record(row)).filter(record => lifecycle === 'all' || record.lifecycle === lifecycle)
      .map(record => this.summary(record, activities));
  }
}
