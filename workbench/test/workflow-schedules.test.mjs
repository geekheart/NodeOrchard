import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { WorkflowSchedules } from '../src/workflows/workflow-schedules.mjs';
import { WorkflowRuns } from '../src/workflows/workflow-runs.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';
import { validateScheduleTiming, nextScheduleOccurrence } from '../shared/workflow/workflow-schedule-time.mjs';

const date = value => Date.parse(value);
const once = (localDateTime = '2026-10-25T09:00', timezone = 'Asia/Shanghai') => ({ kind: 'once', localDateTime, timezone });
const daily = (time = '09:00', timezone = 'Asia/Shanghai') => ({ kind: 'daily', time, timezone });
const copy = value => JSON.parse(JSON.stringify(value));

function document(skill = false) {
  let value = createDocument({ title: '定时流程' });
  value.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: 'text', trigger: 'schedule' } }),
    createNode(skill ? 'skill' : 'tool', { x: 200, y: 0 }, { id: 'operation', config: {
      inputType: 'text', outputType: 'text', ...(skill ? { skillRef: 'fixture', version: 'sha256:' + 'a'.repeat(64) }
        : { executionMode: 'tool', toolName: 'text.trim' }),
    } }), createNode('output', { x: 400, y: 0 }, { id: 'output' })];
  value = connectNodes(value, { sourceNode: 'input', sourcePort: 'out', targetNode: 'operation', targetPort: 'in' });
  return connectNodes(value, { sourceNode: 'operation', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
}

function setup(t, { now = date('2026-10-24T00:00:00Z') } = {}) {
  const db = new DatabaseSync(':memory:');
  const app = new EventEmitter();
  app.store = { db };
  app.backend = { state: 'ready' };
  app.adapter = { state: 'ready' };
  app.events = [];
  app.publish = (type, sessionId, payload) => {
    const event = { type, sessionId, payload: copy(payload) };
    app.events.push(event); app.emit('event', event);
  };
  app.started = [];
  app.runs = new Map();
  app.workflows = {
    get: id => { if (!app.runs.has(id)) throw new Error('not found'); return copy(app.runs.get(id)); },
    start: async (body, options) => {
      if (app.onStart) await app.onStart(body, options);
      if (!options.canStart()) throw Object.assign(new Error('定时任务已暂停或关闭'), { httpStatus: 409 });
      const run = { id: randomUUID(), workflowId: body.document.id, status: 'running', startedAt: new Date(now).toISOString(), error: '',
        trigger: { type: 'schedule', scheduleId: options.scheduleId, scheduledAt: options.scheduledAt, scheduleName: options.scheduleName } };
      app.started.push({ body: copy(body), options, run });
      app.runs.set(run.id, run);
      options.onCreated(copy(run));
      return copy(run);
    },
  };
  const manager = new WorkflowSchedules(app, { now: () => now, autoStart: false });
  t.after(() => { manager.close(); db.close(); });
  return { app, db, manager, setNow: value => { now = typeof value === 'string' ? date(value) : value; },
    restart: () => { manager.close(); return new WorkflowSchedules(app, { now: () => now, autoStart: false }); } };
}

const body = (options = {}) => ({ name: '早间任务', document: document(), input: ' hello ', timing: once(), ...options });

test('time helpers validate dates, IANA zones, shape and nonexistent wall time', () => {
  assert.deepEqual(validateScheduleTiming(daily()), daily());
  for (const value of [once('2026-02-30T09:00'), once('2026-01-01T24:00'), daily('9:00'), daily('09:00', 'Invalid/Zone'),
    { ...daily(), unknown: true }, once('2026-03-08T02:30', 'America/New_York')]) assert.throws(() => validateScheduleTiming(value));
  assert.equal(nextScheduleOccurrence(once(), date('2026-10-24T00:00:00Z')), date('2026-10-25T01:00:00Z'));
  assert.equal(nextScheduleOccurrence(once(), date('2026-10-25T01:00:00Z')), null);
});

test('daily DST gaps are skipped and repeated local minutes run only at their first occurrence', () => {
  assert.equal(nextScheduleOccurrence(daily('02:30', 'America/New_York'), date('2026-03-08T00:00:00Z')), date('2026-03-09T06:30:00Z'));
  const fold = daily('01:30', 'America/New_York');
  assert.equal(nextScheduleOccurrence(fold, date('2026-11-01T00:00:00Z')), date('2026-11-01T05:30:00Z'));
  assert.equal(nextScheduleOccurrence(fold, date('2026-11-01T05:30:00Z')), date('2026-11-02T06:30:00Z'));
  assert.equal(nextScheduleOccurrence(daily('02:15', 'Australia/Lord_Howe'), date('2026-10-03T00:00:00Z')), date('2026-10-04T15:15:00Z'));
});

test('CRUD persists independent execution snapshots and a monotonic revision', t => {
  const { manager, app, restart } = setup(t);
  const draft = body();
  const saved = manager.create(draft);
  draft.document.title = 'changed'; draft.input = 'changed';
  assert.equal(saved.revision, 1);
  assert.equal(saved.document.nodes[0].config.trigger, 'schedule');
  assert.equal(manager.get(saved.id).input, ' hello ');
  assert.equal(manager.list(saved.workflowId).length, 1);
  const paused = manager.setEnabled(saved.id, false);
  assert.equal(paused.nextRunAt, null);
  assert.equal(paused.revision, 2);
  assert.equal(manager.setEnabled(saved.id, true).nextRunAt, '2026-10-25T01:00:00.000Z');
  const edited = manager.update(saved.id, body({ name: '其它名称', enabled: false }));
  assert.equal(edited.createdAt, saved.createdAt);
  assert.equal(edited.revision, 4);
  const next = restart(); t.after(() => next.close());
  assert.deepEqual(next.get(saved.id), edited);
  assert.deepEqual(next.remove(saved.id), { deleted: true, id: saved.id, workflowId: edited.workflowId });
  assert.equal(app.events.at(-1).payload.deleted, true);
  assert.throws(() => next.get(saved.id), { httpStatus: 404 });
});

test('invalid configuration is rejected atomically, including mode, graph, type and size', t => {
  const { manager } = setup(t);
  const original = manager.create(body());
  const learn = document(); learn.mode = 'learn';
  const wrong = document(); wrong.nodes[0].config.outputType = 'number';
  for (const change of [{ name: '' }, { input: false }, { input: 'x'.repeat(65536) }, { enabled: 1 }, { extra: true },
    { timing: once('2026-10-23T09:00') }, { document: learn }, { document: wrong }, { document: createDocument() }]) {
    assert.throws(() => manager.update(original.id, body(change)));
    assert.deepEqual(manager.get(original.id), original);
  }
  assert.throws(() => manager.get('../escape'));
  assert.throws(() => manager.list('__proto__'));
  assert.throws(() => manager.setEnabled(original.id, 'true'));
  assert.equal(manager.list().length, 1);
});

test('typed JSON falsy input survives the stored snapshot', t => {
  const { manager } = setup(t);
  for (const input of [false, 0, null, []]) {
    const graph = document();
    graph.nodes[0].config.outputType = 'any'; graph.nodes[0].config.required = false;
    Object.assign(graph.nodes[1].config, { executionMode: 'code', inputType: 'any', outputType: 'any', code: 'return input;' });
    assert.deepEqual(manager.create(body({ document: graph, input })).input, input);
  }
});

test('a pending image review skips subsequent schedule occurrences without creating duplicate candidates', async t => {
  const { manager, app, setNow } = setup(t);
  const saved = manager.create(body({ timing: daily() }));
  setNow('2026-10-24T01:00:00Z'); await manager.tick();
  assert.equal(app.started.length, 1);
  const first = app.started[0].run;
  app.runs.set(first.id, { ...first, status: 'waiting_review', nodes: { review: { status: 'waiting_review' } } });
  setNow('2026-10-25T01:00:00Z'); await manager.tick();
  assert.equal(app.started.length, 1);
  assert.equal(manager.get(saved.id).lastTrigger.status, 'waiting_review');
  assert.match(manager.get(saved.id).lastTrigger.error, /人工审核/);
  setNow('2026-10-26T01:00:00Z'); await manager.tick();
  assert.equal(app.started.length, 1);
  app.runs.set(first.id, { ...first, status: 'complete', nodes: { review: { status: 'complete' } } });
  setNow('2026-10-27T01:00:00Z'); await manager.tick();
  assert.equal(app.started.length, 2);
});

test('a parallel run with one waiting review also blocks duplicate scheduled candidates', async t => {
  const { manager, app, setNow } = setup(t);
  const saved = manager.create(body({ timing: daily() }));
  setNow('2026-10-24T01:00:00Z'); await manager.tick();
  const first = app.started[0].run;
  app.runs.set(first.id, { ...first, status: 'running', nodes: { independent: { status: 'running' }, image: { status: 'waiting_review' } } });
  setNow('2026-10-25T01:00:00Z'); await manager.tick();
  assert.equal(app.started.length, 1);
  assert.equal(manager.get(saved.id).lastTrigger.status, 'waiting_review');
});

test('a once claim is durable before execution, records provenance and never repeats', async t => {
  const { manager, app, setNow, db } = setup(t);
  const saved = manager.create(body());
  app.onStart = (_body, options) => {
    const stored = JSON.parse(db.prepare('SELECT value FROM workflow_schedules WHERE id=?').get(saved.id).value);
    assert.equal(stored.lastTrigger.status, 'claimed');
    assert.equal(stored.enabled, false); assert.equal(stored.nextRunAt, null);
    assert.equal(options.scheduleId, saved.id);
  };
  setNow('2026-10-25T01:00:00Z');
  await manager.tick(); await manager.tick();
  assert.equal(app.started.length, 1);
  const current = manager.get(saved.id);
  assert.equal(current.lastTrigger.status, 'started');
  assert.equal(current.lastTrigger.runId, app.started[0].run.id);
  assert.equal(current.lastTrigger.runStatus, 'running');
  assert.equal(app.started[0].run.trigger.scheduleName, '早间任务');
});

test('run status updates are saved, while streaming events do not churn schedule records', async t => {
  const { manager, app, setNow } = setup(t);
  const saved = manager.create(body()); setNow('2026-10-25T01:00:00Z'); await manager.tick();
  const before = manager.get(saved.id);
  app.publish('workflow.run', null, { ...app.started[0].run, partialText: 'part' });
  assert.equal(manager.get(saved.id).revision, before.revision);
  app.publish('workflow.run', null, { ...app.started[0].run, status: 'complete', error: '' });
  assert.equal(manager.get(saved.id).lastTrigger.runStatus, 'complete');
  assert.equal(manager.get(saved.id).revision, before.revision + 1);
  manager.remove(saved.id);
  assert.equal(app.runs.size, 1);
});

test('missed polls skip, and daily schedules advance beyond now without catch-up', async t => {
  const { manager, app, setNow } = setup(t);
  const saved = manager.create(body({ timing: daily() }));
  setNow('2026-10-27T01:02:00Z'); await manager.tick();
  const missed = manager.get(saved.id);
  assert.equal(missed.lastTrigger.status, 'missed');
  assert.equal(missed.lastTrigger.scheduledAt, '2026-10-24T01:00:00.000Z');
  assert.equal(missed.nextRunAt, '2026-10-28T01:00:00.000Z');
  assert.equal(app.started.length, 0);
});

test('restart skips all overdue schedules and never replays a persisted claim', t => {
  const { manager, app, setNow, restart, db } = setup(t);
  const old = manager.create(body());
  const claimed = manager.create(body({ name: 'crashed', timing: daily() }));
  const value = manager.get(claimed.id);
  value.lastTrigger = { scheduledAt: value.nextRunAt, triggeredAt: value.createdAt, status: 'claimed', runId: null, runStatus: null, startedAt: null, error: '' };
  value.nextRunAt = '2026-10-26T01:00:00.000Z';
  db.prepare('UPDATE workflow_schedules SET value=? WHERE id=?').run(JSON.stringify(value), value.id);
  setNow('2026-10-25T01:00:01Z');
  const next = restart(); t.after(() => next.close());
  assert.equal(next.get(old.id).lastTrigger.status, 'missed');
  assert.equal(next.get(old.id).enabled, false);
  assert.equal(next.get(claimed.id).lastTrigger.status, 'unknown');
  assert.equal(app.started.length, 0);
});

test('offline Skill schedules do not connect; pure tools still run offline', async t => {
  const { manager, app, setNow } = setup(t);
  const skill = manager.create(body({ document: document(true) }));
  const local = manager.create(body());
  app.backend.state = 'stopped'; app.adapter.state = 'stopped';
  setNow('2026-10-25T01:00:00Z'); await manager.tick();
  assert.equal(manager.get(skill.id).lastTrigger.status, 'offline');
  assert.equal(manager.get(local.id).lastTrigger.status, 'started');
  assert.equal(app.started.length, 1);
});

test('busy execution records a skipped trigger without retrying', async t => {
  const { manager, app, setNow } = setup(t);
  const saved = manager.create(body({ timing: daily() }));
  app.onStart = () => { throw Object.assign(new Error('此工作流已有正在执行的运行。'), { httpStatus: 409 }); };
  setNow('2026-10-24T01:00:00Z'); await manager.tick();
  assert.equal(manager.get(saved.id).lastTrigger.status, 'busy');
  assert.equal(manager.get(saved.id).nextRunAt, '2026-10-25T01:00:00.000Z');
  assert.equal(app.started.length, 0);
});

test('concurrent ticks and two managers claim each due task at most once', async t => {
  const fixture = setup(t);
  const { manager, app, db, setNow } = fixture;
  const next = new WorkflowSchedules(app, { now: () => date('2026-10-24T00:00:00Z'), autoStart: false });
  t.after(() => next.close());
  manager.create(body());
  let release; app.onStart = () => new Promise(resolve => { release = resolve; });
  setNow('2026-10-25T01:00:00Z');
  next.now = () => date('2026-10-25T01:00:00Z');
  const first = manager.tick();
  await manager.tick();
  await next.tick();
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workflow_schedules WHERE json_extract(value,'$.lastTrigger.status')='claimed'").get().count, 1);
  release(); await first;
  assert.equal(app.started.length, 1);
});

test('pause, update, delete and close invalidate admission during an awaited preflight', async t => {
  for (const action of ['pause', 'update', 'delete', 'close']) {
    const { manager, app, setNow } = setup(t);
    const saved = manager.create(body({ timing: daily() }));
    let release; app.onStart = () => new Promise(resolve => { release = resolve; });
    setNow('2026-10-24T01:00:00Z');
    const pending = manager.tick();
    if (action === 'pause') manager.setEnabled(saved.id, false);
    if (action === 'update') manager.update(saved.id, body({ timing: daily('10:00') }));
    if (action === 'delete') manager.remove(saved.id);
    if (action === 'close') manager.close();
    release(); await pending;
    assert.equal(app.started.length, 0, action);
    if (['pause', 'update'].includes(action)) {
      assert.equal(manager.get(saved.id).lastTrigger.status, 'cancelled');
      assert.match(manager.get(saved.id).lastTrigger.error, /创建运行前取消/);
    }
    if (action === 'close') assert.throws(() => manager.list(), { httpStatus: 503 });
  }
});

test('a slow preflight does not block a different schedule becoming due later', async t => {
  const { manager, app, setNow } = setup(t);
  const first = manager.create(body({ name: 'slow', timing: daily('09:00') }));
  const later = manager.create(body({ name: 'later', timing: daily('09:01') }));
  let release;
  app.onStart = (body, options) => options.scheduleId === first.id
    ? new Promise(resolve => { release = resolve; }) : undefined;
  setNow('2026-10-24T01:00:00Z');
  const pending = manager.tick();
  setNow('2026-10-24T01:01:00Z'); await manager.tick();
  assert.equal(manager.get(later.id).lastTrigger.status, 'started');
  assert.equal(manager.get(first.id).lastTrigger.status, 'claimed');
  assert.equal(app.started.length, 1);
  release(); await pending;
  assert.equal(app.started.length, 2);
});

test('once can be cancelled during preflight even though its claim already disabled it', async t => {
  const { manager, app, setNow } = setup(t);
  const saved = manager.create(body());
  let release; app.onStart = () => new Promise(resolve => { release = resolve; });
  setNow('2026-10-25T01:00:00Z');
  const pending = manager.tick();
  assert.equal(manager.get(saved.id).enabled, false);
  assert.equal(manager.setEnabled(saved.id, false).lastTrigger.status, 'cancelled');
  release(); await pending;
  assert.equal(app.started.length, 0);
});

test('saving invokes the same operation static validator without executing tools', t => {
  const { manager, app } = setup(t);
  let calls = 0;
  app.workflows.validateOperationNode = () => { calls++; throw new Error('fixture invalid operation'); };
  assert.throws(() => manager.create(body()), /fixture invalid/);
  assert.equal(calls, 1);
  assert.equal(manager.list().length, 0);
  assert.equal(app.started.length, 0);
});

test('one hundred task limit and expired once enable are explicit', t => {
  const { manager, setNow } = setup(t);
  const paused = manager.create(body({ enabled: false }));
  setNow('2026-10-26T00:00:00Z');
  assert.throws(() => manager.setEnabled(paused.id, true), /过期/);
  for (let index = 1; index < 100; index++) manager.create(body({ name: '任务' + index, timing: daily() }));
  assert.throws(() => manager.create(body({ timing: daily() })), /100/);
});

test('native runner checks schedule admission after async Skill lookup', async t => {
  const { app, db } = setup(t);
  let release;
  app.skill = () => new Promise(resolve => { release = () => resolve({ name: 'fixture', revision: 'sha256:' + 'a'.repeat(64), source: 'local' }); });
  const runner = new WorkflowRuns(app);
  t.after(() => runner.close());
  let allowed = true;
  const pending = runner.start({ document: document(true), input: 'text' }, { scheduleId: randomUUID(), scheduledAt: '2026-10-25T01:00:00.000Z', scheduleName: 'test', canStart: () => allowed });
  allowed = false; release();
  await assert.rejects(pending, /定时任务已暂停/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get().count, 0);
});

test('native runner persists schedule provenance in its ordinary durable execution record', async t => {
  const { app } = setup(t);
  app.preferences = { defaultWorkspace: 'default' };
  app.config = {};
  app.workspace = () => '/tmp';
  const runner = new WorkflowRuns(app, { executeOperation: async ({ input }) => ({ output: input.trim(), outputText: input.trim(), runtime: { kind: 'tool', toolName: 'text.trim' } }) });
  app.workflows = runner;
  const scheduleId = randomUUID();
  const run = await runner.start({ document: document(), input: ' value ' }, { scheduleId,
    scheduledAt: '2026-10-25T01:00:00.000Z', scheduleName: '早间任务', canStart: () => true });
  await new Promise(resolve => setImmediate(resolve));
  const saved = runner.get(run.id);
  assert.equal(saved.status, 'complete');
  assert.deepEqual(saved.trigger, { type: 'schedule', scheduleId, scheduledAt: '2026-10-25T01:00:00.000Z', scheduleName: '早间任务' });
  assert.equal(saved.output, 'value');
  await runner.close();
});
