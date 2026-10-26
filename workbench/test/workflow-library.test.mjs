import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { WorkflowLibrary } from '../src/workflows/workflow-library.mjs';
import { WorkflowSchedules } from '../src/workflows/workflow-schedules.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
function runnable(title = '可执行工作流') {
  let document = createDocument({ title });
  document.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: 'text' } }),
    createNode('tool', { x: 250, y: 0 }, { id: 'tool', config: { executionMode: 'tool', toolName: 'text.trim', inputType: 'text', outputType: 'text' } }),
    createNode('output', { x: 500, y: 0 }, { id: 'output' })];
  document = connectNodes(document, { sourceNode: 'input', sourcePort: 'out', targetNode: 'tool', targetPort: 'in' });
  return connectNodes(document, { sourceNode: 'tool', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
}

function setup(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE workflow_runs(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE workflow_learning(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE workflow_schedules(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,value TEXT NOT NULL);`);
  const app = new EventEmitter(); app.store = { db }; app.events = [];
  app.publish = (type, sessionId, payload) => { const event = { type, sessionId, payload }; app.events.push(copy(event)); app.emit('event', event); };
  const put = (table, value) => table === 'workflow_schedules'
    ? db.prepare('INSERT OR REPLACE INTO workflow_schedules(id,revision,value) VALUES(?,?,?)').run(value.id, value.revision || 1, JSON.stringify(value))
    : db.prepare(`INSERT OR REPLACE INTO ${table}(id,value) VALUES(?,?)`).run(value.id, JSON.stringify(value));
  t.after(() => db.close());
  return { db, app, put };
}

function run(document, status = 'complete', date = '2026-10-24T01:00:00.000Z', extra = {}) {
  return { id: randomUUID(), workflowId: document.id, document: copy(document), status, startedAt: date,
    completedAt: ['preparing', 'running', 'waiting'].includes(status) ? null : date, error: '', ...extra };
}

test('multiple execution, learning and empty drafts save independently and return copies', t => {
  const { app } = setup(t); const library = new WorkflowLibrary(app);
  const first = runnable(); const second = createDocument({ title: '学习草稿' }); second.mode = 'learn';
  const a = library.save({ document: first }); const b = library.save({ document: second, expectedRevision: 0 });
  assert.equal(a.origin, 'saved'); assert.equal(a.revision, 1);
  assert.equal(b.origin, 'saved'); assert.equal(b.document.mode, 'learn');
  first.title = '外部修改'; a.document.title = '返回值修改';
  assert.equal(library.get(a.id).document.title, '可执行工作流');
  assert.equal(library.list().length, 2);
  const summary = library.list().find(item => item.id === a.id);
  assert.equal(summary.state, 'ready'); assert.deepEqual(summary.readiness, { ready: true, error: '' });
  assert.equal(summary.nodeCount, 3); assert.equal(summary.edgeCount, 2);
  assert.equal(Object.hasOwn(summary, 'document'), false);
  assert.equal(library.list().find(item => item.id === b.id).state, 'draft');
  assert.throws(() => library.get('../escape'), { httpStatus: 400 });
  assert.throws(() => library.get('__proto__'), { httpStatus: 400 });
  assert.throws(() => library.get(randomUUID()), { httpStatus: 404 });
});

test('revision compare-and-swap rejects stale windows and identical retries do not write', t => {
  const { app } = setup(t); const library = new WorkflowLibrary(app);
  const original = library.save({ document: runnable() });
  const changed = { ...original.document, title: '已编辑' };
  const saved = library.save({ document: changed, expectedRevision: original.revision });
  assert.equal(saved.revision, 2); assert.equal(saved.createdAt, original.createdAt);
  const eventCount = app.events.length;
  assert.deepEqual(library.save({ document: saved.document, expectedRevision: 1 }), saved);
  assert.deepEqual(library.save({ document: saved.document }), saved);
  for (const expectedRevision of [undefined, 0, 1, 3]) {
    assert.throws(() => library.save({ document: { ...changed, title: '过期窗口' },
      ...(expectedRevision === undefined ? {} : { expectedRevision }) }), { httpStatus: 409 });
  }
  assert.deepEqual(library.get(saved.id), saved); assert.equal(app.events.length, eventCount);
  assert.throws(() => library.save({ document: runnable(), expectedRevision: 1 }), { httpStatus: 409 });
});

test('invalid save envelopes and documents are rejected before any write or event', t => {
  const { app } = setup(t); const library = new WorkflowLibrary(app); const document = runnable();
  for (const expectedRevision of [null, -1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => library.save({ document, expectedRevision }), { httpStatus: 400 });
  }
  for (const value of [null, [], {}, { document, extra: true }, { document: { ...document, mode: 'other' } },
    { document: { ...document, nodes: [document.nodes[0], document.nodes[0]] } }]) assert.throws(() => library.save(value));
  let reads = 0;
  assert.throws(() => library.save({ get document() { reads++; return document; } }));
  assert.equal(reads, 0); assert.deepEqual(library.list(), []); assert.deepEqual(app.events, []);
});

test('saved document size is limited by UTF-8 bytes rather than character count', t => {
  const { app } = setup(t); const library = new WorkflowLibrary(app);
  const document = createDocument();
  document.nodes = Array.from({ length: 8 }, (_, index) => createNode('tool', { x: index * 100, y: 0 }, {
    id: 'large-' + index, config: { code: '中'.repeat(100000) },
  }));
  assert.throws(() => library.save({ document }), { httpStatus: 413 });
  assert.equal(library.list().length, 0);
});

test('first seed imports latest original snapshots across all history types and preserves multiple workflows', t => {
  const { app, put, db } = setup(t);
  const a = runnable('旧执行'); const b = runnable('另一个工作流'); const transient = runnable('仅学习样例');
  put('workflow_runs', run(a, 'complete', '2026-10-20T00:00:00Z'));
  put('workflow_learning', { ...run({ ...a, title: '原始学习', mode: 'learn' }, 'complete', '2026-10-21T00:00:00Z'),
    bestDocument: { ...a, title: '未应用候选' } });
  put('workflow_schedules', { id: randomUUID(), workflowId: a.id, document: { ...a, title: '较新定时快照' }, enabled: false,
    createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', revision: 1 });
  put('workflow_runs', run({ ...a, title: '学习样例候选不可导入' }, 'complete', '2026-10-24T00:00:00Z', { learningId: randomUUID() }));
  put('workflow_runs', run(b));
  put('workflow_runs', run(transient, 'complete', '2026-10-24T00:00:00Z', { learningId: randomUUID() }));
  put('workflow_runs', { ...run(runnable('不匹配ID')), workflowId: 'different-workflow' });
  put('workflow_runs', { ...run(runnable('损坏旧图')), document: { schemaVersion: 0 } });
  const count = db.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get().count;
  const library = new WorkflowLibrary(app);
  assert.equal(library.list().length, 2);
  const saved = library.get(a.id);
  assert.equal(saved.document.title, '较新定时快照'); assert.equal(saved.origin, 'history'); assert.equal(saved.revision, 1);
  assert.equal(saved.updatedAt, '2026-10-23T00:00:00.000Z');
  assert.equal(library.get(b.id).document.title, b.title);
  assert.throws(() => library.get(transient.id), { httpStatus: 404 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get().count, count);
  assert.equal(app.events.length, 0);
});

test('history source can be claimed as saved even when document content is identical', t => {
  const { app, put } = setup(t); const document = runnable();
  put('workflow_runs', run(document));
  const library = new WorkflowLibrary(app); const imported = library.get(document.id);
  assert.throws(() => library.save({ document }), { httpStatus: 409 });
  const saved = library.save({ document, expectedRevision: imported.revision });
  assert.equal(saved.origin, 'saved'); assert.equal(saved.revision, 2);
  assert.equal(saved.createdAt, imported.createdAt);
  assert.deepEqual(library.save({ document, expectedRevision: 1 }), saved);
});

test('history seeding is transactional and once-only; later restarts never overwrite saved drafts', t => {
  const { app, put, db } = setup(t); const document = runnable();
  put('workflow_runs', run(document));
  const first = new WorkflowLibrary(app); const imported = first.get(document.id);
  const saved = first.save({ document: { ...document, title: '浏览器较新草稿', nodes: [], edges: [] }, expectedRevision: imported.revision });
  put('workflow_runs', run({ ...document, title: '后来历史不能盖掉草稿' }, 'complete', '2099-01-01T00:00:00Z'));
  const later = runnable('标记之后的新历史'); put('workflow_runs', run(later));
  const restarted = new WorkflowLibrary(app);
  assert.deepEqual(restarted.get(document.id), saved);
  assert.throws(() => restarted.get(later.id), { httpStatus: 404 });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workflow_library_meta WHERE key='history-seed-v1'").get().count, 1);
});

test('first migration INSERT OR IGNORE protects documents already saved before historical import', t => {
  const { app, put, db } = setup(t); const first = new WorkflowLibrary(app); const document = runnable('已保存');
  const saved = first.save({ document });
  db.prepare("DELETE FROM workflow_library_meta WHERE key='history-seed-v1'").run();
  put('workflow_runs', run({ ...document, title: '较旧历史' }));
  const other = runnable('可同时补入'); put('workflow_runs', run(other));
  const migrated = new WorkflowLibrary(app);
  assert.deepEqual(migrated.get(document.id), saved);
  assert.equal(migrated.get(other.id).origin, 'history');
  assert.equal(migrated.list().length, 2);
});

test('board states reflect reusable readiness and current execution, not permanent completion', t => {
  const { app, put } = setup(t); const library = new WorkflowLibrary(app); const document = runnable();
  library.save({ document });
  const state = () => library.list()[0];
  assert.equal(state().state, 'ready');
  const record = run(document, 'preparing'); put('workflow_runs', record);
  assert.equal(state().state, 'running');
  record.status = 'waiting'; put('workflow_runs', record); assert.equal(state().state, 'running');
  record.status = 'complete'; record.completedAt = '2026-10-24T02:00:00Z'; put('workflow_runs', record);
  assert.equal(state().state, 'ready');
  assert.equal(state().latestRun.id, record.id); assert.equal(state().latestRun.status, 'complete');
  record.status = 'error'; record.error = '执行失败'; put('workflow_runs', record);
  assert.equal(state().state, 'attention'); assert.equal(state().latestRun.error, '执行失败');
  put('workflow_runs', run(document, 'complete', '2026-10-25T00:00:00Z'));
  assert.equal(state().state, 'ready');
});

test('learning activity is separate from ordinary runs and newest successful work clears old attention', t => {
  const { app, put } = setup(t); const library = new WorkflowLibrary(app); const document = runnable();
  library.save({ document });
  const old = run(document, 'error', '2026-10-20T00:00:00Z'); put('workflow_runs', old);
  const learning = { ...run(document, 'running', '2026-10-21T00:00:00Z'), phase: 'optimizing', bestScore: 80, bestRound: 1 };
  put('workflow_learning', learning);
  const sample = run(document, 'running', '2026-10-22T00:00:00Z', { learningId: learning.id }); put('workflow_runs', sample);
  let summary = library.list()[0];
  assert.equal(summary.state, 'running'); assert.equal(summary.latestRun.id, old.id); assert.equal(summary.latestLearning.id, learning.id);
  learning.status = 'exhausted'; learning.completedAt = '2026-10-22T01:00:00Z'; put('workflow_learning', learning);
  summary = library.list()[0]; assert.equal(summary.state, 'attention'); assert.equal(summary.latestLearning.bestScore, 80);
  put('workflow_runs', run(document, 'complete', '2026-10-23T00:00:00Z'));
  assert.equal(library.list()[0].state, 'ready');
});

test('learning mode readiness checks its execution graph and unique Skill refs support board search', t => {
  const { app } = setup(t); const library = new WorkflowLibrary(app); const document = runnable(); document.mode = 'learn';
  const operation = document.nodes[1]; operation.type = 'skill'; operation.config = {
    inputType: 'text', outputType: 'text', skillRef: 'known-skill', version: 'sha256:' + 'a'.repeat(64), timeoutSeconds: 120, failurePolicy: 'stop',
  };
  library.save({ document });
  const summary = library.list()[0];
  assert.equal(summary.mode, 'learn'); assert.equal(summary.state, 'ready'); assert.deepEqual(summary.skillNames, ['known-skill']);
  assert.equal(library.get(document.id).document.mode, 'learn');
});

test('enabled schedule counts and next time follow real scheduler create, pause, edit and delete', t => {
  const { app } = setup(t); const library = new WorkflowLibrary(app); const document = runnable();
  const saved = library.save({ document }); app.workflows = { validateOperationNode() {} };
  const schedules = new WorkflowSchedules(app, { now: () => Date.parse('2026-10-24T00:00:00Z'), autoStart: false });
  t.after(() => schedules.close());
  const first = schedules.create({ name: '早', document, input: 'a', timing: { kind: 'daily', time: '09:00', timezone: 'Asia/Shanghai' } });
  const second = schedules.create({ name: '晚', document, input: 'b', timing: { kind: 'daily', time: '10:00', timezone: 'Asia/Shanghai' } });
  let summary = library.list()[0]; assert.equal(summary.scheduleCount, 2); assert.equal(summary.nextRunAt, first.nextRunAt);
  schedules.setEnabled(first.id, false);
  summary = library.list()[0]; assert.equal(summary.scheduleCount, 1); assert.equal(summary.nextRunAt, second.nextRunAt);
  const changed = schedules.update(second.id, { name: '更晚', document: { ...document, title: '定时独立快照' }, input: 'new', timing: { kind: 'daily', time: '11:00', timezone: 'Asia/Shanghai' } });
  assert.equal(library.list()[0].nextRunAt, changed.nextRunAt); assert.deepEqual(library.get(saved.id), saved);
  schedules.remove(second.id);
  summary = library.list()[0]; assert.equal(summary.scheduleCount, 0); assert.equal(summary.nextRunAt, null);
});

test('document saves publish compact summaries and never alter previous run snapshots', t => {
  const { app, put, db } = setup(t); const library = new WorkflowLibrary(app); const document = runnable();
  const first = library.save({ document }); const previous = run(document); put('workflow_runs', previous);
  library.save({ document: { ...document, title: '新文档标题' }, expectedRevision: first.revision });
  const event = app.events.at(-1);
  assert.equal(event.type, 'workflow.document'); assert.equal(event.payload.workflow.title, '新文档标题');
  assert.equal(Object.hasOwn(event.payload.workflow, 'document'), false);
  assert.equal(event.payload.workflow.latestRun.id, previous.id);
  assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(previous.id).value), previous);
});

test('deleted workflow tombstones reject cached saves and stay deleted across restarts and history migrations', t => {
  const { app, put, db } = setup(t); const library = new WorkflowLibrary(app);
  const deleted = runnable('旧测试草稿'); const retained = runnable('正式工作流');
  const cached = library.save({ document: deleted });
  const saved = library.save({ document: retained });
  const previousRun = run(deleted); put('workflow_runs', previousRun);
  const previousLearning = { ...run({ ...deleted, mode: 'learn' }), bestDocument: { ...deleted, title: '未应用候选' } };
  put('workflow_learning', previousLearning);
  const previousSchedule = { id: randomUUID(), workflowId: deleted.id, document: copy(deleted), revision: 1,
    enabled: false, createdAt: '2026-10-24T00:00:00Z' };
  put('workflow_schedules', previousSchedule);
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO workflow_library_meta(key,value) VALUES(?,?)').run('deleted:' + deleted.id, JSON.stringify({ deletedAt: '2026-10-24T08:00:00Z' }));
  db.prepare('DELETE FROM workflow_documents WHERE id=?').run(deleted.id);
  db.exec('COMMIT');
  const eventCount = app.events.length;
  const isGone = error => error.httpStatus === 410 && error.message === '此工作流已删除，旧草稿不会自动恢复到看板。';
  assert.deepEqual(library.list().map(record => record.id), [retained.id]);
  assert.throws(() => library.get(deleted.id), isGone);
  for (const expectedRevision of [undefined, 0, cached.revision]) {
    assert.throws(() => library.save({ document: cached.document,
      ...(expectedRevision === undefined ? {} : { expectedRevision }) }), isGone);
  }
  assert.equal(db.prepare('SELECT 1 FROM workflow_documents WHERE id=?').get(deleted.id), undefined);
  assert.equal(app.events.length, eventCount);
  const restarted = new WorkflowLibrary(app);
  assert.throws(() => restarted.get(deleted.id), isGone);
  assert.deepEqual(restarted.get(retained.id), saved);
  // Even a repeated/new history migration must not recreate deleted documents
  // from preserved execution, learning, or schedule snapshots.
  db.prepare("DELETE FROM workflow_library_meta WHERE key='history-seed-v1'").run();
  const fresh = runnable('可正常补入的历史'); put('workflow_runs', run(fresh));
  const migrated = new WorkflowLibrary(app);
  assert.deepEqual(new Set(migrated.list().map(record => record.id)), new Set([retained.id, fresh.id]));
  assert.throws(() => migrated.get(deleted.id), isGone);
  assert.throws(() => migrated.save({ document: cached.document, expectedRevision: 0 }), isGone);
  assert.deepEqual(migrated.get(retained.id), saved);
  assert.equal(migrated.get(fresh.id).origin, 'history');
  assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(previousRun.id).value), previousRun);
  assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM workflow_learning WHERE id=?').get(previousLearning.id).value), previousLearning);
  assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM workflow_schedules WHERE id=?').get(previousSchedule.id).value), previousSchedule);
  const updated = migrated.save({ document: { ...retained, title: '正式工作流照常修改' }, expectedRevision: saved.revision });
  assert.equal(updated.revision, 2);
});

test('a tombstone also hides a leftover document and blocks the identical-content retry path', t => {
  const { app, db } = setup(t); const library = new WorkflowLibrary(app);
  const saved = library.save({ document: runnable('已标记删除') });
  db.prepare('INSERT INTO workflow_library_meta(key,value) VALUES(?,?)').run('deleted:' + saved.id, '2026-10-24T08:00:00Z');
  assert.equal(library.list().length, 0);
  assert.throws(() => library.get(saved.id), { httpStatus: 410 });
  assert.throws(() => library.save({ document: saved.document, expectedRevision: saved.revision }), { httpStatus: 410 });
  assert.throws(() => library.save({ document: saved.document, expectedRevision: 0 }), { httpStatus: 410 });
});
