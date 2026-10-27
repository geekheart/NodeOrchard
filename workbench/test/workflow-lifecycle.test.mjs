import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { WorkflowLibrary } from '../src/workflows/workflow-library.mjs';
import { createDocument } from '../shared/workflow/workflow-model.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
function setup(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE workflow_runs(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE workflow_learning(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE workflow_feedback(run_id TEXT,revision INTEGER,workflow_id TEXT,value TEXT);
    CREATE TABLE workflow_schedules(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,value TEXT NOT NULL);`);
  const app = new EventEmitter(); app.store = { db }; app.events = [];
  app.workflows = { locks: new Map(), active: new Map(), dag: { active: new Map(), mutations: new Set() } };
  app.learning = { locks: new Map(), active: new Map() };
  app.publish = (type, sessionId, payload) => { const event = { type, sessionId, payload: copy(payload) }; app.events.push(event); app.emit('event', event); };
  const library = new WorkflowLibrary(app); app.workflowLibrary = library;
  const record = library.save({ document: createDocument({ title: '我的 HDK 流程' }) });
  app.events.length = 0;
  const put = (table, value) => table === 'workflow_schedules'
    ? db.prepare('INSERT OR REPLACE INTO workflow_schedules(id,revision,value) VALUES(?,?,?)').run(value.id, value.revision || 1, JSON.stringify(value))
    : db.prepare(`INSERT OR REPLACE INTO ${table}(id,value) VALUES(?,?)`).run(value.id, JSON.stringify(value));
  const transition = (action, extra = {}) => library.transition(record.id, action, { expectedRevision: library.get(record.id).revision, ...extra });
  t.after(() => db.close());
  return { app, db, library, record, put, transition };
}

test('lifecycle is separate from the graph and requires trash before purge', t => {
  const { library, record, transition, db, app } = setup(t);
  assert.equal(record.lifecycle, 'active'); assert.equal(record.archivedAt, null); assert.equal(record.trashedAt, null);
  assert.equal(library.list()[0].state, 'draft');
  for (const action of ['purge', 'restore', 'unarchive']) assert.throws(() => transition(action), { httpStatus: 409 });
  const trashed = transition('trash').workflow;
  assert.equal(trashed.lifecycle, 'trashed'); assert.equal(trashed.revision, 2); assert.equal(trashed.archivedAt, null); assert.ok(trashed.trashedAt);
  assert.equal(trashed.state, 'draft'); assert.deepEqual(library.get(record.id).document, record.document);
  assert.equal(library.list().length, 0); assert.equal(library.list({ lifecycle: 'archived' })[0].id, record.id);
  assert.equal(library.list({ lifecycle: 'all' }).length, 1);
  for (const action of ['archive', 'trash']) assert.throws(() => transition(action), { httpStatus: 409 });
  assert.ok(trashed.updatedAt > record.updatedAt);
  assert.equal(library.list({ lifecycle: 'trashed' })[0].id, record.id);
  assert.throws(() => transition('purge', { confirmationTitle: record.document.title + ' ' }), { httpStatus: 400 });
  assert.deepEqual(transition('purge', { confirmationTitle: record.document.title }), { deleted: true, id: record.id, lifecycle: 'deleted' });
  assert.equal(library.list({ lifecycle: 'all' }).length, 0);
  assert.throws(() => library.get(record.id), { httpStatus: 410 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workflow_lifecycle').get().count, 0);
  const tombstone = JSON.parse(db.prepare('SELECT value FROM workflow_library_meta WHERE key=?').get('deleted:' + record.id).value);
  assert.equal(tombstone.revision, 3); assert.equal(tombstone.title, record.document.title);
  assert.equal(app.events.at(-1).type, 'workflow.lifecycle'); assert.equal(app.events.at(-1).payload.deleted, true);
});

test('restore directly restores editing with a new revision and no graph mutations', t => {
  const { library, record, transition } = setup(t);
  transition('trash');
  const active = transition('restore').workflow;
  assert.equal(active.lifecycle, 'active'); assert.equal(active.revision, 3); assert.equal(active.archivedAt, null); assert.equal(active.trashedAt, null);
  assert.deepEqual(library.get(record.id).document, record.document); assert.doesNotThrow(() => library.assertRunnable(record.id));
  assert.equal(library.list().length, 1);
  const saved = library.save({ document: { ...record.document, title: '恢复后编辑' }, expectedRevision: 3 });
  assert.equal(saved.revision, 4); assert.equal(saved.lifecycle, 'active');
});

test('legacy action aliases retain state and revision barriers without replaying mutations', t => {
  const { library, record, transition, app } = setup(t);
  const trashed = transition('archive').workflow;
  assert.equal(trashed.lifecycle, 'trashed'); assert.equal(trashed.revision, 2);
  const events = app.events.length;
  assert.throws(() => library.transition(record.id, 'archive', { expectedRevision: 1 }), { httpStatus: 409 });
  assert.throws(() => transition('archive'), { httpStatus: 409 });
  assert.throws(() => library.transition(record.id, 'unarchive', { expectedRevision: 1 }), { httpStatus: 409 });
  assert.equal(app.events.length, events); assert.equal(library.get(record.id).revision, 2);
  const active = transition('unarchive').workflow;
  assert.equal(active.lifecycle, 'active'); assert.equal(active.revision, 3); assert.equal(active.archivedAt, null); assert.equal(active.trashedAt, null);
  assert.throws(() => transition('unarchive'), { httpStatus: 409 });
  assert.equal(library.save({ document: record.document, expectedRevision: 1 }).revision, 3);
});

test('inactive definitions reject identical cached saves, stale transitions, and execution admission', t => {
  const { library, record, transition } = setup(t);
  assert.doesNotThrow(() => library.assertRunnable('not-yet-saved'));
  transition('trash');
  assert.throws(() => library.save({ document: record.document, expectedRevision: 1 }), { httpStatus: 409 });
  assert.throws(() => library.save({ document: record.document }), { httpStatus: 409 });
  assert.throws(() => library.transition(record.id, 'trash', { expectedRevision: 1 }), { httpStatus: 409 });
  assert.throws(() => library.assertRunnable(record.id), { httpStatus: 409 });
  transition('purge', { confirmationTitle: record.document.title });
  assert.throws(() => library.assertRunnable(record.id), { httpStatus: 410 });
  assert.throws(() => library.save({ document: record.document, expectedRevision: 0 }), { httpStatus: 410 });
  assert.throws(() => library.transition(record.id, 'archive', { expectedRevision: 1 }), { httpStatus: 410 });
});

test('transition envelopes are strict and reject getters without invoking them', t => {
  const { library, record, app } = setup(t);
  for (const options of [null, [], {}, { expectedRevision: 0 }, { expectedRevision: '1' }, { expectedRevision: 1, surprise: true },
    { expectedRevision: 1, confirmationTitle: null }, { expectedRevision: 1, [Symbol('key')]: true }]) {
    assert.throws(() => library.transition(record.id, 'archive', options), { httpStatus: 400 });
  }
  let reads = 0;
  assert.throws(() => library.transition(record.id, 'archive', { get expectedRevision() { reads++; return 1; } }), { httpStatus: 400 });
  assert.equal(reads, 0);
  for (const action of ['delete', '__proto__', null]) assert.throws(() => library.transition(record.id, action, { expectedRevision: 1 }), { httpStatus: 400 });
  for (const lifecycle of ['deleted', '', null, 0]) assert.throws(() => library.list({ lifecycle }), { httpStatus: 400 });
  assert.equal(app.events.length, 0); assert.equal(library.get(record.id).revision, 1);
});

test('trash atomically pauses enabled and claimed schedules and publishes only after its durable commit', t => {
  const { db, app, library, record, put, transition } = setup(t);
  const enabled = { id: randomUUID(), workflowId: record.id, revision: 7, enabled: true, nextRunAt: '2099-01-01T00:00:00Z', document: record.document,
    lastTrigger: { status: 'claimed', scheduledAt: '2026-10-25T00:00:00Z' } };
  const disabled = { ...copy(enabled), id: randomUUID(), enabled: false, nextRunAt: null, revision: 4, lastTrigger: null };
  const claimed = { ...copy(enabled), id: randomUUID(), enabled: false, nextRunAt: null, revision: 2 };
  const other = { ...copy(enabled), id: randomUUID(), workflowId: 'other-workflow', lastTrigger: null };
  for (const schedule of [enabled, disabled, claimed, other]) put('workflow_schedules', schedule);
  const read = id => JSON.parse(db.prepare('SELECT value FROM workflow_schedules WHERE id=?').get(id).value);
  let hooks = 0;
  app.schedules = { onWorkflowArchived(id, schedules) {
    hooks++; assert.equal(id, record.id); assert.equal(schedules.length, 2);
    assert.equal(library.get(record.id).lifecycle, 'trashed'); assert.equal(read(enabled.id).enabled, false);
    // A read-only observer can open a new transaction only after COMMIT.
    db.exec('BEGIN'); db.exec('ROLLBACK');
  } };
  transition('trash');
  const paused = read(enabled.id);
  assert.equal(paused.enabled, false); assert.equal(paused.nextRunAt, null); assert.equal(paused.revision, 8);
  assert.equal(paused.lastTrigger.status, 'cancelled'); assert.match(paused.lastTrigger.error, /已移入回收站/);
  assert.equal(read(claimed.id).lastTrigger.status, 'cancelled'); assert.equal(read(claimed.id).revision, 3);
  assert.equal(db.prepare('SELECT revision FROM workflow_schedules WHERE id=?').get(enabled.id).revision, 8);
  assert.deepEqual(read(disabled.id), disabled); assert.deepEqual(read(other.id), other); assert.equal(hooks, 1);
  assert.equal(app.events.filter(event => event.type === 'workflow.schedule').length, 2);
  transition('restore');
  assert.deepEqual(read(enabled.id), paused); assert.equal(hooks, 1);
});

test('failed trash rolls back lifecycle, document revision, and schedule pause without events or hooks', t => {
  const { db, app, library, record, put, transition } = setup(t);
  const schedule = { id: randomUUID(), workflowId: record.id, revision: 1, enabled: true, nextRunAt: '2099-01-01T00:00:00Z' };
  put('workflow_schedules', schedule);
  let hooks = 0; app.schedules = { onWorkflowArchived() { hooks++; } };
  db.exec("CREATE TRIGGER reject_trash BEFORE UPDATE ON workflow_documents BEGIN SELECT RAISE(ABORT,'fixture write failure'); END");
  assert.throws(() => transition('trash'), /fixture write failure/);
  assert.deepEqual(library.get(record.id), record); assert.equal(library.list().length, 1);
  assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM workflow_schedules WHERE id=?').get(schedule.id).value), schedule);
  assert.equal(app.events.length, 0); assert.equal(hooks, 0);
});

test('running, queued, preparing, waiting, human review, sample runs and feedback learning block lifecycle changes', t => {
  const { db, library, record, put, transition } = setup(t);
  for (const status of ['preparing', 'queued', 'running', 'waiting', 'waiting_review']) {
    for (const learningId of [undefined, randomUUID()]) {
      const run = { id: randomUUID(), workflowId: record.id, status, ...(learningId ? { learningId } : {}) };
      put('workflow_runs', run);
      assert.throws(() => transition('trash'), { httpStatus: 409 });
      db.prepare('DELETE FROM workflow_runs WHERE id=?').run(run.id);
    }
  }
  const review = { id: randomUUID(), workflowId: record.id, status: 'error', nodes: { human: { status: 'waiting_review' } } };
  put('workflow_runs', review); assert.throws(() => transition('trash'), { httpStatus: 409 });
  db.prepare('DELETE FROM workflow_runs').run();
  for (const status of ['preparing', 'queued', 'running', 'waiting', 'waiting_review']) for (const kind of ['feedback', 'batch']) {
    const job = { id: randomUUID(), workflowId: record.id, status, kind };
    put('workflow_learning', job); assert.throws(() => transition('trash'), { httpStatus: 409 });
    db.prepare('DELETE FROM workflow_learning WHERE id=?').run(job.id);
  }
  assert.equal(library.get(record.id).revision, 1); transition('trash');
  put('workflow_runs', { id: randomUUID(), workflowId: record.id, status: 'queued' });
  assert.throws(() => transition('restore'), { httpStatus: 409 });
  db.prepare('DELETE FROM workflow_runs').run();
  put('workflow_learning', { id: randomUUID(), workflowId: record.id, status: 'running', kind: 'feedback' });
  assert.throws(() => transition('purge', { confirmationTitle: record.document.title }), { httpStatus: 409 });
});

test('in-memory admission leases and DAG mutation fences block trash before durable execution exists', t => {
  const { app, library, record, transition, put, db } = setup(t);
  for (const owner of [app.workflows, app.learning]) {
    owner.locks.set(record.id, {}); assert.throws(() => transition('trash'), { httpStatus: 409 }); owner.locks.clear();
    const field = owner === app.learning ? 'job' : 'run';
    owner.active.set('pending-id', { [field]: { workflowId: record.id } });
    assert.throws(() => transition('trash'), { httpStatus: 409 }); owner.active.clear();
  }
  app.workflows.dag.active.set('pending-id', { run: { workflowId: record.id } });
  assert.throws(() => transition('trash'), { httpStatus: 409 }); app.workflows.dag.active.clear();
  const run = { id: randomUUID(), workflowId: record.id, status: 'complete' }; put('workflow_runs', run);
  app.workflows.dag.mutations.add(run.id); assert.throws(() => transition('trash'), { httpStatus: 409 });
  app.workflows.dag.mutations.clear();
  put('workflow_runs', { ...run, workflowId: 'unrelated', status: 'running' });
  transition('trash'); assert.equal(library.get(record.id).lifecycle, 'trashed');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get().count, 1);
});

test('purge preserves immutable history, feedback and paused schedule snapshots and cannot seed-resurrect', t => {
  const { app, db, library, record, put, transition } = setup(t);
  const run = { id: randomUUID(), workflowId: record.id, document: record.document, status: 'complete', startedAt: '2026-10-25T00:00:00Z' };
  const learning = { ...copy(run), id: randomUUID(), kind: 'feedback' };
  const schedule = { ...copy(run), id: randomUUID(), revision: 1, enabled: true, nextRunAt: '2099-01-01T00:00:00Z' };
  put('workflow_runs', run); put('workflow_learning', learning); put('workflow_schedules', schedule);
  const feedback = { workflowId: record.id, comment: '保留意见' };
  db.prepare('INSERT INTO workflow_feedback VALUES(?,?,?,?)').run(run.id, 1, record.id, JSON.stringify(feedback));
  transition('trash'); transition('purge', { confirmationTitle: record.document.title });
  assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(run.id).value), run);
  assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM workflow_learning WHERE id=?').get(learning.id).value), learning);
  assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM workflow_feedback WHERE run_id=?').get(run.id).value), feedback);
  const retainedSchedule = JSON.parse(db.prepare('SELECT value FROM workflow_schedules WHERE id=?').get(schedule.id).value);
  assert.equal(retainedSchedule.enabled, false); assert.equal(retainedSchedule.nextRunAt, null); assert.deepEqual(retainedSchedule.document, record.document);
  db.prepare("DELETE FROM workflow_library_meta WHERE key='history-seed-v1'").run();
  const restarted = new WorkflowLibrary(app);
  assert.equal(restarted.list({ lifecycle: 'all' }).length, 0);
  assert.throws(() => restarted.get(record.id), { httpStatus: 410 });
  assert.throws(() => restarted.save({ document: record.document, expectedRevision: 0 }), { httpStatus: 410 });
});

test('lifecycle persists across library restarts and history migration preserves trashed definitions', t => {
  const { app, db, library, record, put, transition } = setup(t);
  const trashed = transition('trash').workflow;
  put('workflow_runs', { id: randomUUID(), workflowId: record.id, status: 'complete', document: { ...record.document, title: '历史不能覆盖归档' } });
  db.prepare("DELETE FROM workflow_library_meta WHERE key='history-seed-v1'").run();
  const restarted = new WorkflowLibrary(app);
  assert.equal(restarted.list().length, 0);
  const summary = restarted.list({ lifecycle: 'archived' })[0];
  assert.deepEqual({ ...summary, latestRun: null }, trashed); assert.equal(summary.latestRun.status, 'complete');
  assert.deepEqual(restarted.get(record.id).document, record.document);
  assert.throws(() => restarted.save({ document: library.get(record.id).document, expectedRevision: trashed.revision }), { httpStatus: 409 });
});

test('legacy archived rows project into trash without rewriting their stored definitions or timestamps', t => {
  const { app, db, library, record, transition } = setup(t);
  const archivedAt = '2026-10-24T01:02:03.000Z';
  db.prepare('INSERT INTO workflow_lifecycle(workflow_id,lifecycle,archived_at,trashed_at) VALUES(?,?,?,NULL)')
    .run(record.id, 'archived', archivedAt);
  const stored = () => ({ document: db.prepare('SELECT * FROM workflow_documents WHERE id=?').get(record.id),
    lifecycle: db.prepare('SELECT * FROM workflow_lifecycle WHERE workflow_id=?').get(record.id) });
  const before = stored(), changes = db.prepare('SELECT total_changes() AS count').get().count;
  const restarted = new WorkflowLibrary(app);
  for (const instance of [library, restarted]) {
    const value = instance.get(record.id);
    assert.equal(value.lifecycle, 'trashed'); assert.equal(value.archivedAt, archivedAt); assert.equal(value.trashedAt, archivedAt);
    assert.equal(value.revision, record.revision); assert.equal(value.updatedAt, record.updatedAt); assert.deepEqual(value.document, record.document);
    assert.deepEqual(instance.lifecycle(record.id), { lifecycle: 'trashed', archivedAt, trashedAt: archivedAt });
    assert.deepEqual(instance.list(), []);
    for (const lifecycle of ['all', 'trashed', 'archived']) {
      const result = instance.list({ lifecycle }); assert.equal(result.length, 1); assert.equal(result[0].lifecycle, 'trashed');
    }
    assert.throws(() => instance.assertRunnable(record.id), { httpStatus: 409 });
    assert.throws(() => instance.save({ document: record.document, expectedRevision: record.revision }), { httpStatus: 409 });
  }
  assert.deepEqual(stored(), before); assert.equal(db.prepare('SELECT total_changes() AS count').get().count, changes);
  const active = transition('restore').workflow;
  assert.equal(active.lifecycle, 'active'); assert.equal(active.revision, 2); assert.equal(active.archivedAt, null); assert.equal(active.trashedAt, null);
  assert.deepEqual(library.get(record.id).document, record.document);
});

test('legacy archived definitions support purge and the unarchive alias without an intermediate mutation', t => {
  for (const action of ['purge', 'unarchive']) {
    const { db, library, record, transition } = setup(t);
    db.prepare('INSERT INTO workflow_lifecycle(workflow_id,lifecycle,archived_at,trashed_at) VALUES(?,?,?,NULL)')
      .run(record.id, 'archived', '2026-10-24T01:02:03.000Z');
    const result = transition(action, action === 'purge' ? { confirmationTitle: record.document.title } : {});
    if (action === 'purge') { assert.equal(result.deleted, true); assert.throws(() => library.get(record.id), { httpStatus: 410 }); }
    else { assert.equal(result.workflow.lifecycle, 'active'); assert.equal(result.workflow.revision, 2); }
  }
});
