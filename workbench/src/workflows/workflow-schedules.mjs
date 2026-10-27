import { randomUUID } from 'node:crypto';
import { planWorkflow } from '../../shared/workflow/workflow-plan.mjs';
import { validateScheduleTiming, nextScheduleOccurrence } from '../../shared/workflow/workflow-schedule-time.mjs';
import { validateWorkflowInput } from './workflow-runs.mjs';
import { redact } from '../hermes-adapter.mjs';
import { withWorkflowInputDefaults } from '../../shared/workflow/workflow-inputs.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_SCHEDULES = 100;
const LATE_MS = 60000;
const clone = value => JSON.parse(JSON.stringify(value));
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const message = error => redact(error?.message || error || '定时任务启动失败。').slice(0, 4000);
const iso = timestamp => new Date(timestamp).toISOString();

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(label + '必须是对象。');
  if (Reflect.ownKeys(value).some(key => !keys.includes(key))) fail(label + '包含未知字段。');
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !Object.hasOwn(item, 'value'))) fail(label + '不能包含访问器。');
}

export class WorkflowSchedules {
  constructor(app, { now = () => Date.now(), pollMs = 1000, autoStart = true } = {}) {
    if (typeof now !== 'function' || !Number.isInteger(pollMs) || pollMs < 10 || pollMs > 60000 || typeof autoStart !== 'boolean') fail('无效的定时管理器选项。');
    this.app = app;
    this.db = app.store.db;
    this.now = now;
    this.closed = false;
    this.pending = new Map();
    this.db.exec('CREATE TABLE IF NOT EXISTS workflow_schedules (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL)');
    this.readRow = this.db.prepare('SELECT value,revision FROM workflow_schedules WHERE id=?');
    this.writeRow = this.db.prepare('UPDATE workflow_schedules SET value=?,revision=? WHERE id=? AND revision=?');
    this.recover();
    this.onEvent = event => this.handleEvent(event);
    app.on('event', this.onEvent);
    if (autoStart) {
      this.timer = setInterval(() => { void Promise.resolve().then(() => this.tick()).catch(() => {}); }, pollMs);
      this.timer.unref?.();
    }
  }

  clock() {
    const timestamp = this.now();
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) fail('无效的调度器时间。');
    return timestamp;
  }

  checkOpen() { if (this.closed) fail('定时管理器已关闭。', 503); }
  checkId(id) { if (typeof id !== 'string' || !UUID.test(id)) fail('无效的定时任务 ID。'); }

  read(id) {
    const row = this.readRow.get(id);
    return row ? JSON.parse(row.value) : null;
  }

  save(schedule, previousRevision, publish = true) {
    const value = { ...schedule, revision: previousRevision + 1, updatedAt: iso(this.clock()) };
    if (!this.writeRow.run(JSON.stringify(value), value.revision, value.id, previousRevision).changes) return null;
    if (publish && !this.closed) this.app.publish('workflow.schedule', null, { schedule: clone(value) });
    return value;
  }

  list(workflowId) {
    this.checkOpen();
    if (workflowId !== undefined && (typeof workflowId !== 'string' || !IDENTIFIER.test(workflowId)
      || ['__proto__', 'constructor', 'prototype'].includes(workflowId))) fail('无效的工作流 ID。');
    const rows = workflowId === undefined
      ? this.db.prepare("SELECT value FROM workflow_schedules ORDER BY json_extract(value,'$.createdAt') DESC,rowid DESC").all()
      : this.db.prepare("SELECT value FROM workflow_schedules WHERE json_extract(value,'$.workflowId')=? ORDER BY json_extract(value,'$.createdAt') DESC,rowid DESC").all(workflowId);
    return rows.map(row => JSON.parse(row.value));
  }

  get(id) {
    this.checkOpen(); this.checkId(id);
    const schedule = this.read(id);
    if (!schedule) fail('定时任务不存在。', 404);
    return schedule;
  }

  configuration(body, enabledDefault) {
    object(body, ['name', 'document', 'input', 'timing', 'enabled', 'outputDirectory'], '定时任务');
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120 || body.name.includes('\0')) fail('定时任务名称必须为 1–120 个字符。');
    const enabled = body.enabled === undefined ? enabledDefault : body.enabled;
    if (typeof enabled !== 'boolean') fail('enabled 必须是布尔值。');
    const planned = planWorkflow(body.document);
    this.app.workflowLibrary?.assertRunnable?.(planned.document.id);
    for (const node of planned.operationNodes) if (node.type === 'tool') this.app.workflows.validateOperationNode?.(node);
    // V2 performs file admission again on every trigger, before any model call.
    // Saving a schedule freezes field bindings; it does not authorize guessing a
    // missing file or reusing an older preflight's hashes.
    const supplied = withWorkflowInputDefaults(planned.document, body.input);
    const input = planned.document.schemaVersion === 2 ? clone(supplied === undefined ? {} : supplied) : validateWorkflowInput(supplied, planned);
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 64 * 1024) fail('输入不能超过 64KB JSON。', 413);
    if (body.outputDirectory !== undefined && (typeof body.outputDirectory !== 'string' || body.outputDirectory.length > 4000 || body.outputDirectory.includes('\0'))) fail('输出目录格式不正确。');
    const timing = validateScheduleTiming(body.timing);
    const next = nextScheduleOccurrence(timing, this.clock());
    if (timing.kind === 'once' && next === null) fail('单次任务时间必须晚于当前时间；过期任务不会补跑，请重新选择时间。');
    return { name: body.name.trim(), workflowId: planned.document.id, document: planned.document, input, timing, enabled,
      nextRunAt: enabled ? iso(next) : null, ...(body.outputDirectory !== undefined ? { outputDirectory: body.outputDirectory } : {}) };
  }

  create(body) {
    this.checkOpen();
    if (this.db.prepare('SELECT COUNT(*) AS count FROM workflow_schedules').get().count >= MAX_SCHEDULES) fail('最多保存 100 个定时任务。', 409);
    const config = this.configuration(body, true);
    const now = iso(this.clock());
    const schedule = { id: randomUUID(), ...config, revision: 1, createdAt: now, updatedAt: now, lastTrigger: null };
    this.db.prepare('INSERT INTO workflow_schedules(id,revision,value) VALUES(?,?,?)').run(schedule.id, 1, JSON.stringify(schedule));
    this.app.publish('workflow.schedule', null, { schedule: clone(schedule) });
    return clone(schedule);
  }

  cancelPending(id, previous, reason = '定时任务已修改') {
    const token = this.pending.get(id);
    if (!token || token.admitted) return previous;
    token.cancelled = true;
    return previous ? { ...previous, lastTrigger: { ...previous.lastTrigger, status: 'cancelled',
      error: reason + '；已在创建运行前取消本次触发，未补跑。' } } : previous;
  }

  onWorkflowArchived(workflowId) {
    // The library has already paused schedules in its SQLite transaction.
    // Cancel any admission still awaiting files/Skills without writing stale
    // schedule snapshots back over that transaction.
    for (const [id, token] of this.pending) {
      if (!token.admitted && this.read(id)?.workflowId === workflowId) token.cancelled = true;
    }
  }

  update(id, body) {
    let previous = this.get(id);
    const config = this.configuration(body, previous.enabled);
    previous = this.cancelPending(id, previous);
    const saved = this.save({ ...previous, ...config }, previous.revision);
    if (!saved) fail('定时任务已变化，请刷新后重试。', 409);
    return clone(saved);
  }

  setEnabled(id, enabled) {
    let previous = this.get(id);
    if (typeof enabled !== 'boolean') fail('enabled 必须是布尔值。');
    if (enabled) this.app.workflowLibrary?.assertRunnable?.(previous.workflowId);
    const pending = this.pending.get(id);
    if (previous.enabled === enabled && !(pending && !pending.admitted && !enabled)) return previous;
    const next = enabled ? nextScheduleOccurrence(previous.timing, this.clock()) : null;
    if (enabled && next === null) fail('单次任务时间已过期，请编辑时间后再启用。');
    previous = this.cancelPending(id, previous, enabled ? '定时任务已重新启用' : '定时任务已暂停');
    const saved = this.save({ ...previous, enabled, nextRunAt: next === null ? null : iso(next) }, previous.revision);
    if (!saved) fail('定时任务已变化，请刷新后重试。', 409);
    return clone(saved);
  }

  remove(id) {
    const previous = this.get(id);
    this.cancelPending(id);
    this.db.prepare('DELETE FROM workflow_schedules WHERE id=?').run(id);
    const payload = { deleted: true, id, workflowId: previous.workflowId };
    this.app.publish('workflow.schedule', null, payload);
    return payload;
  }

  advance(schedule, timestamp) {
    if (schedule.timing.kind === 'once') return { ...schedule, enabled: false, nextRunAt: null };
    return { ...schedule, nextRunAt: iso(nextScheduleOccurrence(schedule.timing, Math.max(timestamp, Date.parse(schedule.nextRunAt)))) };
  }

  trigger(scheduledAt, status, error = '') {
    return { scheduledAt, triggeredAt: iso(this.clock()), startedAt: null, status, runId: null, runStatus: null, error };
  }

  recover() {
    const now = this.clock();
    for (const row of this.db.prepare('SELECT value FROM workflow_schedules').all()) {
      let schedule = JSON.parse(row.value);
      let changed = false;
      if (schedule.lastTrigger?.status === 'claimed') {
        schedule.lastTrigger = { ...schedule.lastTrigger, status: 'unknown', error: '应用在启动确认前重启；未重放此触发，请检查运行记录。' };
        changed = true;
      } else if (schedule.lastTrigger?.runId) {
        try {
          const run = this.app.workflows.get(schedule.lastTrigger.runId);
          if (run.status !== schedule.lastTrigger.runStatus || (run.error || '') !== schedule.lastTrigger.error) {
            schedule.lastTrigger = { ...schedule.lastTrigger, runStatus: run.status, error: message(run.error || '') };
            if (!run.error) schedule.lastTrigger.error = '';
            changed = true;
          }
        } catch { /* Deleted or unavailable history does not authorize a replay. */ }
      }
      if (schedule.enabled && schedule.nextRunAt && Date.parse(schedule.nextRunAt) <= now) {
        schedule = { ...this.advance(schedule, now), lastTrigger: this.trigger(schedule.nextRunAt, 'missed', '应用未在触发时间运行；已跳过，未补跑。') };
        changed = true;
      }
      if (changed) this.save(schedule, schedule.revision, false);
    }
  }

  handleEvent(event) {
    if (this.closed || event.type !== 'workflow.run' || typeof event.payload?.id !== 'string') return;
    const run = event.payload;
    for (const row of this.db.prepare("SELECT value FROM workflow_schedules WHERE json_extract(value,'$.lastTrigger.runId')=?").all(run.id)) {
      const schedule = JSON.parse(row.value);
      const error = run.error ? message(run.error) : '';
      if (schedule.lastTrigger.runStatus === run.status && schedule.lastTrigger.error === error) continue;
      this.save({ ...schedule, lastTrigger: { ...schedule.lastTrigger, runStatus: run.status, error } }, schedule.revision);
    }
  }

  updateClaim(id, token, patch) {
    if (this.closed || token.cancelled) return;
    const current = this.read(id);
    if (!current || current.lastTrigger?.scheduledAt !== token.scheduledAt) return;
    return this.save({ ...current, lastTrigger: { ...current.lastTrigger, ...patch } }, current.revision);
  }

  async dispatch(schedule, token) {
    try {
      this.app.workflowLibrary?.assertRunnable?.(schedule.workflowId);
      const hasSkills = schedule.document.nodes.some(node => node.type === 'skill');
      if (hasSkills && (this.app.backend?.state !== 'ready' || this.app.adapter?.state !== 'ready')) {
        this.updateClaim(schedule.id, token, { status: 'offline', error: 'Hermes 未连接；已跳过本次触发，未自动连接或补跑。' });
        return;
      }
      const run = await this.app.workflows.start({ document: schedule.document, input: schedule.input,
        ...(schedule.outputDirectory !== undefined ? { outputDirectory: schedule.outputDirectory } : {}) }, {
        scheduleId: schedule.id, scheduledAt: token.scheduledAt, scheduleName: schedule.name,
        canStart: () => {
          if (this.closed || token.cancelled || this.pending.get(schedule.id) !== token) return false;
          this.app.workflowLibrary?.assertRunnable?.(schedule.workflowId);
          return true;
        },
        onCreated: run => {
          token.admitted = true;
          this.updateClaim(schedule.id, token, { status: 'started', runId: run.id, startedAt: run.startedAt, runStatus: run.status, error: run.error || '' });
        },
      });
      if (!token.admitted) throw new Error('执行器未确认创建运行；未自动重试。');
      this.updateClaim(schedule.id, token, { runStatus: run.status, error: run.error ? message(run.error) : '' });
    } catch (error) {
      if (this.closed || token.cancelled) return;
      const text = message(error);
      const status = /未连接|连接.*断开|连接 Hermes/.test(text) ? 'offline'
        : error?.httpStatus === 409 && /正在|已有|学习|占用/.test(text) ? 'busy' : 'error';
      this.updateClaim(schedule.id, token, { status: token.admitted ? 'started' : status, error: text });
    } finally {
      if (this.pending.get(schedule.id) === token) this.pending.delete(schedule.id);
    }
  }

  tick() {
    if (this.closed) return Promise.resolve();
    const work = [];
    const now = this.clock();
    for (const row of this.db.prepare("SELECT value FROM workflow_schedules WHERE json_extract(value,'$.enabled')=1 AND json_extract(value,'$.nextRunAt') IS NOT NULL ORDER BY json_extract(value,'$.nextRunAt'),id").all()) {
      const schedule = JSON.parse(row.value);
      try { this.app.workflowLibrary?.assertRunnable?.(schedule.workflowId); }
      catch (error) {
        this.save({ ...schedule, enabled: false, nextRunAt: null,
          lastTrigger: { ...schedule.lastTrigger, status: 'cancelled', error: message(error) } }, schedule.revision);
        this.onWorkflowArchived(schedule.workflowId);
        continue;
      }
      const due = Date.parse(schedule.nextRunAt);
      if (due > now || this.pending.has(schedule.id)) continue;
      const missed = now - due > LATE_MS;
      let waiting = null;
      if (schedule.lastTrigger?.runId) {
        try {
          const run = this.app.workflows.get(schedule.lastTrigger.runId);
          if (run.status === 'waiting_review' || Object.values(run.nodes || {}).some(node => node.status === 'waiting_review')) waiting = run;
        } catch { /* Only an existing, durable review blocks a repeat. */ }
      }
      if (!missed && waiting) {
        this.save({ ...this.advance(schedule, now), lastTrigger: {
          ...this.trigger(schedule.nextRunAt, 'waiting_review', '上一次任务仍待人工审核，已跳过本次定时触发。'),
          runId: waiting.id, runStatus: waiting.status,
        } }, schedule.revision);
        continue;
      }
      const claimed = this.save({ ...this.advance(schedule, now), lastTrigger: this.trigger(schedule.nextRunAt,
        missed ? 'missed' : 'claimed', missed ? '已错过触发时间；已跳过，未补跑。' : '') }, schedule.revision);
      if (!claimed || missed) continue;
      const token = { scheduledAt: schedule.nextRunAt, cancelled: false, admitted: false };
      this.pending.set(schedule.id, token);
      work.push(this.dispatch(clone(claimed), token));
    }
    // A slow Skill lookup/preparation must not block a later poll from claiming
    // other schedules. The per-id token and SQLite revision fence duplicates.
    return Promise.allSettled(work).then(() => undefined);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.app.off('event', this.onEvent);
    for (const token of this.pending.values()) if (!token.admitted) token.cancelled = true;
    // Do not wait for network/model acknowledgements. WorkflowRuns owns admitted
    // runs and its shutdown; an unacknowledged durable claim is never replayed.
  }
}
