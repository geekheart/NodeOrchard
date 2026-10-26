import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Application } from '../src/application.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

class DisconnectedAdapter extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.starts = 0; this.requests = []; }
  async start() { this.starts++; throw new Error('Workflow library tests must not start Hermes.'); }
  async request(method) { this.requests.push(method); throw new Error('Workflow library tests must not call Hermes.'); }
  async stop() {}
}

function emptyDocument(id, title = '尚未配置的草稿', mode = 'execute') {
  const document = createDocument({ title }); document.id = id; document.mode = mode; return document;
}
function localDocument(id = 'library-local-flow') {
  let document = emptyDocument(id, '固定历史快照');
  document.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'entry', config: { outputType: 'text' } }),
    createNode('tool', { x: 320, y: 0 }, { id: 'trim', config: { executionMode: 'tool', toolName: 'text.trim', inputType: 'text', outputType: 'text' } }),
    createNode('output', { x: 640, y: 0 }, { id: 'exit' })];
  for (let index = 1; index < document.nodes.length; index++) document = connectNodes(document, {
    sourceNode: document.nodes[index - 1].id, sourcePort: 'out', targetNode: document.nodes[index].id, targetPort: 'in',
  });
  return document;
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-library-http-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'),
    WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace'), WORKBENCH_HERMES_ROOT: join(directory, 'unused-hermes'),
    WORKBENCH_HERMES_HOME: join(directory, 'unused-home') }), port: 0 };
  const f = { directory, config, adapters: [] };
  f.open = async () => {
    const adapter = new DisconnectedAdapter(); f.adapters.push(adapter);
    f.app = new Application(config, adapter); f.bridge = createWorkbenchServer(config, f.app);
    f.origin = await f.bridge.listen();
    f.csrfToken = (await (await fetch(f.origin + '/api/bootstrap')).json()).csrfToken;
  };
  f.close = async () => { if (f.bridge) { const bridge = f.bridge; f.bridge = null; await bridge.close(); } };
  f.restart = async () => { await f.close(); await f.open(); };
  f.request = async (path, { body, method = body === undefined ? 'GET' : 'POST', headers = {}, raw } = {}) => {
    const response = await fetch(f.origin + path, { method,
      headers: method === 'POST' ? { 'Content-Type': 'application/json', 'X-Workbench-Token': f.csrfToken, ...headers } : headers,
      ...(raw === undefined && body === undefined ? {} : { body: raw ?? JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  f.api = (path, body, headers = {}) => f.request(path, { body, headers });
  t.after(async () => {
    try { await f.close(); }
    finally {
      try { for (const adapter of f.adapters) { assert.equal(adapter.starts, 0); assert.deepEqual(adapter.requests, []); } }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
  await f.open(); return f;
}

async function until(read, predicate, timeout = 4000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    last = await read(); if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected workflow library HTTP state was not observed: ' + JSON.stringify(last));
}
function assertSaved(response) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const record = response.body.workflow;
  assert.equal(typeof record.id, 'string'); assert.equal(record.document.id, record.id);
  assert(Number.isInteger(record.revision) && record.revision > 0);
  assert.equal(record.origin, 'saved');
  assert(Number.isFinite(Date.parse(record.createdAt))); assert(Number.isFinite(Date.parse(record.updatedAt)));
  return record;
}

test('workflow library HTTP saves independent incomplete execution and learning drafts without executing them', async t => {
  const f = await fixture(t), first = emptyDocument('board-flow_A', '空白执行草稿'), second = emptyDocument('board-flow_B', '<script>literal title</script>', 'learn');
  second.nodes = [createNode('tool', { x: 120, y: 30 }, { id: 'unconnected-code', config: { code: 'throw new Error("MUST_NOT_EXECUTE");' } })];
  assert.deepEqual((await f.api('/api/workflow-library')).body.workflows, []);
  const a = assertSaved(await f.api('/api/workflow-library', { document: first }));
  const b = assertSaved(await f.api('/api/workflow-library', { document: second, expectedRevision: 0 }));
  assert.equal(a.revision, 1); assert.equal(b.revision, 1); assert.notEqual(a.id, b.id);
  assert.deepEqual(a.document, first); assert.deepEqual(b.document, second);
  first.title = '仅修改本地对象'; second.nodes[0].config.code = 'return "changed without save";';
  assert.deepEqual((await f.api(`/api/workflow-library/${a.id}`)).body.workflow, a);
  assert.deepEqual((await f.api(`/api/workflow-library/${b.id}`)).body.workflow, b);
  const listed = await f.api('/api/workflow-library');
  assert.equal(listed.status, 200); assert.deepEqual(new Set(listed.body.workflows.map(item => item.id)), new Set([a.id, b.id]));
  for (const summary of listed.body.workflows) {
    assert.equal(summary.revision, 1); assert.equal(summary.state, 'draft'); assert.equal(summary.readiness.ready, false);
    assert.equal(summary.latestRun, null); assert.equal(summary.latestLearning, null); assert.equal(summary.scheduleCount, 0);
    assert.equal(Object.hasOwn(summary, 'document'), false);
  }
  assert.deepEqual(f.app.workflows.list(), []); assert.deepEqual(f.app.learning.list(), []); assert.deepEqual(f.app.schedules.list(), []); assert.deepEqual(f.app.store.list(), []);
});

test('workflow library HTTP protects creation and updates with CSRF, origin and JSON checks', async t => {
  const f = await fixture(t), document = emptyDocument('protected-flow'), body = { document };
  for (const headers of [{ 'X-Workbench-Token': '' }, { 'X-Workbench-Token': 'incorrect' }, { Origin: 'https://example.invalid' }]) {
    assert.equal((await f.api('/api/workflow-library', body, headers)).status, 403);
  }
  assert.equal((await f.api('/api/workflow-library', body, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.request('/api/workflow-library', { method: 'POST', raw: '{invalid json' })).status, 400);
  assert.deepEqual((await f.api('/api/workflow-library')).body.workflows, []);
  const saved = assertSaved(await f.api('/api/workflow-library', body));
  const changed = { document: { ...document, title: 'blocked overwrite' }, expectedRevision: saved.revision };
  for (const headers of [{ 'X-Workbench-Token': 'incorrect' }, { Origin: 'https://example.invalid' }]) {
    assert.equal((await f.api('/api/workflow-library', changed, headers)).status, 403);
  }
  assert.equal((await f.request(`/api/workflow-library/${saved.id}`, { headers: { Origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await f.request(`/api/workflow-library/${saved.id}`, { method: 'DELETE' })).status, 404);
  assert.deepEqual((await f.api(`/api/workflow-library/${saved.id}`)).body.workflow, saved);
  assert.deepEqual(f.app.workflows.list(), []); assert.deepEqual(f.app.store.list(), []);
});

test('workflow library HTTP rejects malformed documents, IDs and revision types before storing drafts', async t => {
  const f = await fixture(t), document = emptyDocument('valid-flow');
  const invalid = [null, [], {}, { document: null }, { document, extra: 'not an API field' },
    ...[null, -1, 1.5, '0', true].map(expectedRevision => ({ document, expectedRevision })),
    { document: { ...document, mode: 'not-a-mode' } }, { document: { ...document, schemaVersion: 99 } },
    { document: { ...document, title: '' } }, { document: { ...document, nodes: {} } },
    ...['__proto__', 'constructor', 'prototype', 'slash/in/id', 'with space'].map(id => ({ document: { ...document, id } }))];
  for (const body of invalid) {
    const rejected = await f.api('/api/workflow-library', body);
    assert.equal(rejected.status, 400, JSON.stringify({ body, response: rejected.body })); assert.equal(typeof rejected.body.error, 'string');
  }
  for (const rawId of ['__proto__', 'constructor', 'prototype', 'slash%2Fin%2Fid', '%E0%A4%A']) {
    const rejected = await f.api('/api/workflow-library/' + rawId);
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  }
  assert.equal((await f.api('/api/workflow-library/missing-valid-id')).status, 404);
  assert.equal((await f.api('/api/workflow-library', { document, expectedRevision: 3 })).status, 409);
  assert.deepEqual((await f.api('/api/workflow-library')).body.workflows, []);
  assert.deepEqual(f.app.workflows.list(), []); assert.deepEqual(f.app.learning.list(), []); assert.deepEqual(f.app.schedules.list(), []); assert.deepEqual(f.app.store.list(), []);
});

test('workflow library HTTP compare-and-swap admits only one concurrent edit and never overwrites another document', async t => {
  const f = await fixture(t), document = emptyDocument('cas-flow'), independent = emptyDocument('cas-neighbor', '另一份草稿');
  const original = assertSaved(await f.api('/api/workflow-library', { document, expectedRevision: 0 }));
  const neighbor = assertSaved(await f.api('/api/workflow-library', { document: independent }));
  const omitted = await f.api('/api/workflow-library', { document: { ...document, title: 'no expected revision' } }); assert.equal(omitted.status, 409);
  const competing = ['窗口 A 保存', '窗口 B 保存'].map(title => ({ document: { ...document, title }, expectedRevision: original.revision }));
  const results = await Promise.all(competing.map(body => f.api('/api/workflow-library', body)));
  assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
  const winner = assertSaved(results.find(item => item.status === 200)); assert.equal(winner.revision, original.revision + 1);
  assert.equal(winner.createdAt, original.createdAt);
  const conflict = await f.api('/api/workflow-library', { document: { ...document, title: 'stale overwrite' }, expectedRevision: original.revision });
  assert.equal(conflict.status, 409);
  assert.deepEqual((await f.api(`/api/workflow-library/${winner.id}`)).body.workflow, winner);
  assert.deepEqual(assertSaved(await f.api('/api/workflow-library', { document: winner.document, expectedRevision: original.revision })), winner);
  assert.deepEqual(assertSaved(await f.api('/api/workflow-library', { document: winner.document })), winner);
  assert.deepEqual((await f.api(`/api/workflow-library/${neighbor.id}`)).body.workflow, neighbor);
  assert.deepEqual(f.app.workflows.list(), []); assert.deepEqual(f.app.store.list(), []);
});

test('library draft updates preserve fixed run, schedule, learning and session history across restart and isolated roots', async t => {
  const f = await fixture(t), other = await fixture(t), document = localDocument();
  const saved = assertSaved(await f.api('/api/workflow-library', { document }));
  const started = await f.api('/api/workflow-runs', { document, input: '  preserved run  ' }); assert.equal(started.status, 202, JSON.stringify(started.body));
  const completed = (await until(() => f.api(`/api/workflow-runs/${started.body.id}`), value => value.body.status === 'complete')).body;
  assert.equal(completed.output, 'preserved run');
  const scheduled = await f.api('/api/workflow-schedules', { name: '独立固定快照', document, input: 'scheduled',
    timing: { kind: 'once', localDateTime: '2099-12-20T14:30', timezone: 'Asia/Shanghai' }, enabled: true });
  assert.equal(scheduled.status, 201, JSON.stringify(scheduled.body));
  const session = f.app.store.create({ title: '既有会话 fixture', cwd: join(f.directory, 'workspace', 'default'), storedSessionId: 'historical-session-fixture', runtimeSessionId: null, model: 'fixture-model' });
  const learningId = randomUUID(), at = new Date().toISOString();
  // A persisted legacy learning fixture exercises retention without calling a model.
  const learningDocument = structuredClone(document); learningDocument.mode = 'learn';
  learningDocument.nodes[1] = createNode('skill', { x: 320, y: 0 }, { id: 'trim', config: { inputType: 'text', outputType: 'text', skillRef: 'historical-skill', version: `sha256:${'a'.repeat(64)}` } });
  const legacy = { id: learningId, workflowId: document.id, status: 'complete', phase: 'finished', document: learningDocument,
    input: 'historical sample', expected: 'historical result', config: { comparison: 'exact', targetScore: 90, maxRounds: 1, trainableNodeIds: ['trim'], validationCases: [] },
    rounds: [{ index: 0, status: 'complete', document: { ...learningDocument, mode: 'execute' }, cases: [{ role: 'train', input: 'historical sample', expected: 'historical result', output: 'historical result', status: 'complete', score: 100 }], score: 100, changes: [] }],
    bestRound: 0, bestScore: 100, bestDocument: { ...learningDocument, mode: 'execute' }, startedAt: at, completedAt: at };
  f.app.store.db.prepare('INSERT INTO workflow_learning(id,value) VALUES(?,?)').run(learningId, JSON.stringify(legacy));
  const historicalLearning = (await f.api(`/api/workflow-learning/${learningId}`)).body;
  const draft = emptyDocument(document.id, '已改为空白学习草稿', 'learn');
  const updated = assertSaved(await f.api('/api/workflow-library', { document: draft, expectedRevision: saved.revision }));
  assert.equal(updated.revision, 2); assert.deepEqual(updated.document, draft);
  const assertHistory = async () => {
    assert.deepEqual((await f.api(`/api/workflow-runs/${completed.id}`)).body, completed);
    assert.deepEqual((await f.api(`/api/workflow-schedules/${scheduled.body.schedule.id}`)).body.schedule, scheduled.body.schedule);
    assert.deepEqual((await f.api(`/api/workflow-learning/${learningId}`)).body, historicalLearning);
    const restoredSession = f.app.store.get(session.id);
    const { status: initialStatus, ...originalFields } = session, { status, ...restoredFields } = restoredSession;
    assert.deepEqual(restoredFields, originalFields); assert([initialStatus, 'disconnected'].includes(status));
  };
  await assertHistory();
  const summary = (await f.api('/api/workflow-library')).body.workflows.find(item => item.id === document.id);
  assert.equal(summary.latestRun.id, completed.id); assert.equal(summary.latestLearning.id, learningId); assert.equal(summary.scheduleCount, 1);
  assert.deepEqual((await other.api('/api/workflow-library')).body.workflows, []);
  assert.equal((await other.api(`/api/workflow-library/${document.id}`)).status, 404);
  await f.restart();
  assert.deepEqual((await f.api(`/api/workflow-library/${document.id}`)).body.workflow, updated);
  await assertHistory();
  assert.equal(f.app.workflows.list().length, 1); assert.equal(f.app.learning.list().length, 1); assert.equal(f.app.schedules.list().length, 1);
});

test('library HTTP accepts large drafts within its document budget and rejects oversized input without saving it', async t => {
  const f = await fixture(t), document = emptyDocument('large-library-draft');
  const largeNode = index => createNode('tool', { x: index * 50, y: 0 }, { id: `code-${index}`, config: { code: '// ' + 'x'.repeat(94997) } });
  document.nodes = Array.from({ length: 12 }, (_, index) => largeNode(index));
  const bytes = Buffer.byteLength(JSON.stringify({ document })); assert(bytes > 1000000 && bytes < 2 * 1024 * 1024);
  const saved = assertSaved(await f.api('/api/workflow-library', { document }));
  assert.equal(saved.document.nodes.length, 12); assert.deepEqual((await f.api(`/api/workflow-library/${document.id}`)).body.workflow, saved);
  const oversized = emptyDocument('oversized-library-draft'); oversized.nodes = Array.from({ length: 24 }, (_, index) => largeNode(index));
  // An intentionally rejected upload should not leave a half-read keepalive socket in the test fixture.
  const rejected = await f.api('/api/workflow-library', { document: oversized }, { Connection: 'close' });
  assert.equal(rejected.status, 413);
  assert.deepEqual((await f.api('/api/workflow-library')).body.workflows.map(item => item.id), [document.id]);
  assert.deepEqual(f.app.workflows.list(), []); assert.deepEqual(f.app.store.list(), []);
});
