import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApplicationSupervisorTools } from '../src/application-supervisor-tools.mjs';
import { WorkflowLibrary } from '../src/workflows/workflow-library.mjs';
import { createDocument, createNode } from '../shared/workflow/workflow-model.mjs';

const supervisor = { role: 'supervisor' };
function fixture(t, { durable = false } = {}) {
  const directory = durable ? mkdtempSync(join(tmpdir(), 'supervisor-tools-')) : null;
  let db = new DatabaseSync(directory ? join(directory, 'test.sqlite') : ':memory:');
  db.exec('CREATE TABLE workflow_runs(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE workflow_schedules(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,value TEXT NOT NULL)');
  const app = { store: { db }, events: [], adapter: { log: [] }, publish(type, sessionId, payload) {
    this.events.push({ id: this.events.length + 1, type, sessionId, payload, at: new Date().toISOString() });
  } };
  app.workflowLibrary = new WorkflowLibrary(app);
  let tools = new ApplicationSupervisorTools(app);
  t.after(() => { db.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  const reopen = () => {
    db.close(); db = new DatabaseSync(join(directory, 'test.sqlite')); app.store.db = db;
    app.workflowLibrary = new WorkflowLibrary(app); tools = new ApplicationSupervisorTools(app);
    return tools;
  };
  const save = (title = '独立原工作流') => {
    const document = createDocument({ schemaVersion: 2, title, settings: { outputDirectory: '/private/example/delivery' } });
    document.nodes.push(createNode('tool', { x: 0, y: 0 }, { id: 'custom', config: { language: 'python', code: 'return {"ok": True}' } }));
    return app.workflowLibrary.save({ document, expectedRevision: 0 });
  };
  return { app, tools, reopen, save, get db() { return db; } };
}

test('all supervisor capabilities require a server-bound supervisor role before reading or writing', async t => {
  const f = fixture(t);
  for (const role of [undefined, 'workflow', 'global', 'supervisor-user-input']) {
    for (const descriptor of f.tools.tools()) await assert.rejects(f.tools.call(descriptor.name, {}, { role }), { httpStatus: 403 });
  }
  assert.equal(f.app.workflowLibrary.list().length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM application_supervisor_operations').get().count, 0);
  assert.equal(f.tools.tools().filter(tool => tool.effect === 'mutation').length, 3);
  assert.ok(f.tools.tools().filter(tool => tool.effect === 'mutation').every(tool => !tool.readOnly));
  assert.equal(f.tools.handles('source.write'), false);
});

test('copy uses the exact source revision, keeps business nodes, resets delivery, and copies no history', async t => {
  const f = fixture(t), source = f.save();
  f.db.prepare('INSERT INTO workflow_runs(id,value) VALUES(?,?)').run('original-run', JSON.stringify({ id: 'original-run', workflowId: source.id, status: 'complete' }));
  const request = { workflowId: source.id, expectedRevision: 1, operationId: 'copy-one' };
  const receipt = await f.tools.call('workflow.copy', request, supervisor);
  assert.equal(receipt.status, 'complete'); assert.equal(receipt.sourceRevision, 1);
  assert.notEqual(receipt.targetWorkflowId, source.id); assert.equal(receipt.runStarted, false);
  const copied = f.app.workflowLibrary.get(receipt.targetWorkflowId);
  assert.deepEqual(copied.document.nodes, source.document.nodes);
  assert.equal(copied.document.settings.outputDirectory, '');
  assert.equal(copied.revision, 1); assert.equal(copied.document.title, '独立原工作流（副本）');
  assert.deepEqual(f.app.workflowLibrary.get(source.id), source);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get().count, 1);
  assert.deepEqual(await f.tools.call('workflow.copy', request, supervisor), receipt);
  assert.equal(f.app.workflowLibrary.list().length, 2);
  await assert.rejects(f.tools.call('workflow.copy', { ...request, title: '另一个目标' }, supervisor), { httpStatus: 409 });
  await assert.rejects(f.tools.call('workflow.copy', { ...request, expectedRevision: 99, operationId: 'copy-stale' }, supervisor), { httpStatus: 409 });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM application_supervisor_operations').get().count, 1);
});

test('new test workflows always receive fresh IDs and a visible test name without starting execution', async t => {
  const f = fixture(t), original = f.save();
  const request = { title: '最小复现', document: original.document, expectedRevision: 0, operationId: 'create-test-one' };
  const receipt = await f.tools.call('workflow.create-test', request, supervisor);
  assert.equal(receipt.status, 'complete'); assert.equal(receipt.title, '[测试] 最小复现');
  assert.notEqual(receipt.targetWorkflowId, original.id); assert.equal(receipt.runStarted, false);
  assert.deepEqual(f.app.workflowLibrary.get(original.id), original);
  assert.equal(f.app.workflowLibrary.get(receipt.targetWorkflowId).document.nodes[0].config.code, 'return {"ok": True}');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get().count, 0);
  const empty = await f.tools.call('workflow.create-test', { title: '空白', expectedRevision: 0, operationId: 'empty-test' }, supervisor);
  assert.deepEqual(f.app.workflowLibrary.get(empty.targetWorkflowId).document.nodes, []);
});

test('delete archives active workflows, pauses schedules and moves to recoverable trash without purging', async t => {
  const f = fixture(t), source = f.save();
  const schedule = { id: 'timer', workflowId: source.id, enabled: true, nextRunAt: '2026-10-28T00:00:00Z', revision: 1 };
  f.db.prepare('INSERT INTO workflow_schedules VALUES(?,?,?)').run(schedule.id, schedule.revision, JSON.stringify(schedule));
  const request = { workflowId: source.id, expectedRevision: 1, operationId: 'trash-one' };
  const receipt = await f.tools.call('workflow.delete', request, supervisor);
  assert.equal(receipt.status, 'complete'); assert.equal(receipt.deleted, true); assert.equal(receipt.permanent, false);
  assert.equal(receipt.recoverable, true); assert.equal(receipt.revision, 3); assert.equal(receipt.lifecycle, 'trashed');
  assert.equal(f.app.workflowLibrary.get(source.id).lifecycle, 'trashed');
  assert.deepEqual(f.app.workflowLibrary.get(source.id).document, source.document);
  const paused = JSON.parse(f.db.prepare('SELECT value FROM workflow_schedules WHERE id=?').get('timer').value);
  assert.equal(paused.enabled, false); assert.equal(paused.nextRunAt, null);
  assert.deepEqual(await f.tools.call('workflow.delete', request, supervisor), receipt);
  assert.equal(f.app.workflowLibrary.get(source.id).revision, 3);
  f.app.workflowLibrary.transition(source.id, 'restore', { expectedRevision: 3 });
  f.app.workflowLibrary.transition(source.id, 'unarchive', { expectedRevision: 4 });
  assert.deepEqual(f.app.workflowLibrary.get(source.id).document, source.document);
});

test('delete rejects busy work and stale versions before registering a mutation', async t => {
  const f = fixture(t), source = f.save();
  const request = { workflowId: source.id, expectedRevision: 1, operationId: 'busy-delete' };
  f.db.prepare('INSERT INTO workflow_runs VALUES(?,?)').run('busy', JSON.stringify({ id: 'busy', workflowId: source.id, status: 'waiting_review' }));
  await assert.rejects(f.tools.call('workflow.delete', request, supervisor), { httpStatus: 409 });
  assert.equal(f.app.workflowLibrary.get(source.id).lifecycle, 'active');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM application_supervisor_operations').get().count, 0);
});

test('receipts survive restart and a pending or unknown mutation never replays', async t => {
  const f = fixture(t, { durable: true }), source = f.save();
  const request = { workflowId: source.id, expectedRevision: 1, operationId: 'durable-copy' };
  const receipt = await f.tools.call('workflow.copy', request, supervisor);
  let restarted = f.reopen();
  assert.deepEqual(await restarted.call('workflow.copy', request, supervisor), receipt);
  assert.equal(f.app.workflowLibrary.list().length, 2);
  f.db.prepare('UPDATE application_supervisor_operations SET status=\'pending\',result=NULL WHERE operation_id=?').run(request.operationId);
  restarted = f.reopen();
  const unknown = await restarted.call('workflow.copy', request, supervisor);
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.executed, null);
  assert.equal(f.app.workflowLibrary.list().length, 2);
  assert.match(unknown.reason, /未自动重放/);
});

test('post-commit listener failure returns durable uncertainty rather than replaying a copy', async t => {
  const f = fixture(t), source = f.save();
  f.app.publish = () => { throw new Error('listener failed'); };
  const request = { workflowId: source.id, expectedRevision: 1, operationId: 'unknown-copy' };
  const receipt = await f.tools.call('workflow.copy', request, supervisor);
  assert.equal(receipt.status, 'unknown'); assert.equal(receipt.observed.revision, 1);
  assert.equal(f.app.workflowLibrary.list().length, 2);
  assert.deepEqual(await f.tools.call('workflow.copy', request, supervisor), receipt);
  assert.equal(f.app.workflowLibrary.list().length, 2);
});

test('a failed trash step preserves partial archive evidence and cannot silently retry', async t => {
  const f = fixture(t), source = f.save();
  const transition = f.app.workflowLibrary.transition.bind(f.app.workflowLibrary);
  f.app.workflowLibrary.transition = (id, action, options) => {
    if (action === 'trash') throw new Error('回收站暂不可用');
    return transition(id, action, options);
  };
  const request = { workflowId: source.id, expectedRevision: 1, operationId: 'partial-delete' };
  const receipt = await f.tools.call('workflow.delete', request, supervisor);
  assert.equal(receipt.status, 'partial'); assert.equal(receipt.lifecycle, 'archived');
  assert.equal(receipt.deleted, false); assert.equal(receipt.revision, 2);
  assert.deepEqual(await f.tools.call('workflow.delete', request, supervisor), receipt);
  assert.equal(f.app.workflowLibrary.get(source.id).revision, 2);
});

test('cancelled admissions, unknown fields, accessors and invalid documents have no side effects', async t => {
  const f = fixture(t), source = f.save(), controller = new AbortController(); controller.abort();
  const request = { workflowId: source.id, expectedRevision: 1, operationId: 'cancelled-copy' };
  await assert.rejects(f.tools.call('workflow.copy', request, { ...supervisor, signal: controller.signal }), { name: 'AbortError' });
  for (const extra of [{ path: '/outside' }, { code: 'writeAppSource()' }, { expectedRevision: 0 }]) {
    await assert.rejects(f.tools.call('workflow.copy', { ...request, ...extra }, supervisor));
  }
  let invoked = false;
  await assert.rejects(f.tools.call('workflow.copy', { ...request, get title() { invoked = true; return 'bad'; } }, supervisor));
  assert.equal(invoked, false);
  await assert.rejects(f.tools.call('workflow.create-test', { title: 'bad', expectedRevision: 0, operationId: 'bad-doc', document: { get schemaVersion() { invoked = true; return 2; } } }, supervisor));
  assert.equal(invoked, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM application_supervisor_operations').get().count, 0);
  assert.equal(f.app.workflowLibrary.list().length, 1);
});

test('global logs expose bounded redacted metadata without learning data, reasoning or arbitrary file reads', async t => {
  const f = fixture(t);
  f.app.events = [
    { id: 21, type: 'backend.status', at: '2026-10-27T00:00:00Z', payload: { state: 'error', token: 'do-not-expose', hidden: 'private-payload' } },
    { id: 22, type: 'workflow.run', payload: { run: { id: 'ordinary', workflowId: 'wf', status: 'error', error: 'token=secret-value' } } },
    { id: 23, type: 'workflow.learning', payload: { id: 'learning', status: 'error', error: 'known-answer', trainingAnswer: 'known-answer', reasoning: 'private-thought' } },
  ];
  f.app.adapter.log = ['password=super-secret', '<think>internal thought</think> visible diagnostic'];
  const logs = await f.tools.call('app.logs', { limit: 2, afterId: 21 }, supervisor);
  assert.equal(logs.source, 'current-process-memory'); assert.equal(logs.persistentHistory, false);
  assert.deepEqual(logs.events.map(event => event.id), [22, 23]);
  assert.equal(logs.retainedWindow.firstId, 21); assert.equal(logs.events[1].error, undefined);
  const rendered = JSON.stringify(logs);
  for (const secret of ['known-answer', 'private-thought', 'private-payload', 'secret-value', 'super-secret', 'internal thought', 'do-not-expose']) assert.equal(rendered.includes(secret), false, secret);
  await assert.rejects(f.tools.call('app.logs', { path: '/private/logs' }, supervisor));
  await assert.rejects(f.tools.call('app.logs', { limit: 1000 }, supervisor));
});
