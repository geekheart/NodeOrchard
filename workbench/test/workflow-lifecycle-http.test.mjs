import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Application } from '../src/application.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

class DisconnectedAdapter extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.starts = 0; this.requests = []; }
  async start() { this.starts++; throw new Error('Lifecycle tests must not start Hermes.'); }
  async request(method) { this.requests.push(method); throw new Error('Lifecycle tests must not call Hermes.'); }
  async stop() {}
}

function document({ id = randomUUID(), schemaVersion = 2, human = false } = {}) {
  let value = createDocument({ title: '归档与回收站 · 本地资料', schemaVersion }); value.id = id;
  value.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'entry', config: { outputType: 'text' } }),
    createNode('tool', { x: 300, y: 0 }, { id: 'trim', config: {
      executionMode: 'tool', toolName: 'text.trim', inputType: 'text', outputType: 'text',
    } }), ...(human ? [createNode('human', { x: 600, y: 0 }, { id: 'review', config: { inputType: 'text', outputType: 'text' } })] : []),
    createNode('output', { x: 900, y: 0 }, { id: 'exit' })];
  for (let index = 1; index < value.nodes.length; index++) value = connectNodes(value, {
    sourceNode: value.nodes[index - 1].id, sourcePort: 'out', targetNode: value.nodes[index].id, targetPort: 'in',
  });
  return value;
}

const scheduleBody = value => ({ name: '归档时需要停用的任务', document: value, input: ' scheduled ', enabled: true,
  timing: { kind: 'once', localDateTime: '2099-12-20T14:30', timezone: 'Asia/Shanghai' } });
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-lifecycle-http-'));
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
    return { status: response.status, body: await response.json() };
  };
  f.api = (path, body, headers = {}) => f.request(path, { body, headers });
  f.save = async value => {
    const response = await f.api('/api/workflow-library', { document: value });
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.workflow;
  };
  f.transition = (record, action, extra = {}) => f.api(`/api/workflow-library/${record.id}/${action}`,
    { expectedRevision: record.revision, ...extra });
  f.list = async (lifecycle = 'active') => {
    const response = await f.api('/api/workflow-library' + (lifecycle === 'active' ? '' : `?lifecycle=${lifecycle}`));
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.workflows;
  };
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
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Expected lifecycle HTTP state was not observed: ' + JSON.stringify(last));
}

function transitioned(response, lifecycle) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const value = response.body.workflow;
  assert.equal(value.lifecycle, lifecycle); assert(Number.isSafeInteger(value.revision)); return value;
}

test('archive, recycle, restore and purge preserve real output and all history, while schedules stay disabled after restoration', async t => {
  const f = await fixture(t), value = document(), neighbor = document();
  let record = await f.save(value); await f.save(neighbor);
  const started = await f.api('/api/workflow-runs', { document: value, input: '  preserved output  ' });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const run = (await until(() => f.api(`/api/workflow-runs/${started.body.id}`), result => result.body.status === 'complete')).body;
  assert.equal(run.output, 'preserved output');
  const file = run.nodes.exit.savedPath, fileHash = hash(await readFile(file));
  const originalSource = join(f.directory, 'user-owned-input.epro2'); await writeFile(originalSource, 'source must remain intact');
  const scheduleResponse = await f.api('/api/workflow-schedules', scheduleBody(value));
  assert.equal(scheduleResponse.status, 201, JSON.stringify(scheduleResponse.body)); const schedule = scheduleResponse.body.schedule;
  assert.equal(schedule.enabled, true);
  // Historical rows are isolated test fixtures, never mutations of the user's library.
  const learningId = randomUUID(), now = new Date().toISOString();
  const learning = JSON.stringify({ id: learningId, workflowId: value.id, status: 'complete', phase: 'finished',
    document: { ...value, mode: 'learn' }, config: { trainingCases: [], validationCases: [] }, rounds: [],
    bestDocument: null, bestScore: null, bestRound: null, startedAt: now, completedAt: now });
  f.app.store.db.prepare('INSERT INTO workflow_learning(id,value) VALUES(?,?)').run(learningId, learning);
  const feedback = JSON.stringify({ schemaVersion: 2, runId: run.id, workflowId: value.id, revision: 1,
    createdAt: now, updatedAt: now, comment: '保留的综合反馈', targets: [] });
  f.app.store.db.prepare('INSERT INTO workflow_feedback(run_id,revision,workflow_id,value) VALUES(?,1,?,?)').run(run.id, value.id, feedback);
  const preservedRun = f.app.store.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(run.id).value;
  const assertHistory = async () => {
    assert.equal(f.app.store.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(run.id).value, preservedRun);
    assert.equal(f.app.store.db.prepare('SELECT value FROM workflow_learning WHERE id=?').get(learningId).value, learning);
    assert.equal(f.app.store.db.prepare('SELECT value FROM workflow_feedback WHERE run_id=?').get(run.id).value, feedback);
    assert.equal((await f.api(`/api/workflow-runs/${run.id}`)).body.output, 'preserved output');
    assert.equal((await f.api(`/api/workflow-learning/${learningId}`)).status, 200);
    assert.equal((await f.api(`/api/workflow-runs/${run.id}/feedback`)).body.feedback.comment, '保留的综合反馈');
    const download = await fetch(f.origin + '/api/workflow-v2/artifacts/' + run.nodes.exit.artifacts[0].id);
    assert.equal(download.status, 200); assert.equal(await download.text(), 'preserved output');
    assert.equal(hash(await readFile(file)), fileHash); assert.equal(await readFile(originalSource, 'utf8'), 'source must remain intact');
  };
  record = transitioned(await f.transition(record, 'archive'), 'archived');
  assert.deepEqual((await f.list()).map(item => item.id), [neighbor.id]);
  assert.deepEqual((await f.list('archived')).map(item => item.id), [value.id]);
  const disabled = (await f.api(`/api/workflow-schedules/${schedule.id}`)).body.schedule;
  assert.equal(disabled.enabled, false); assert.equal(disabled.nextRunAt, null); assert(disabled.revision > schedule.revision);
  assert.deepEqual(disabled.document, schedule.document);
  record = transitioned(await f.transition(record, 'trash'), 'trashed');
  assert.deepEqual((await f.list('trashed')).map(item => item.id), [value.id]);
  assert.deepEqual(new Set((await f.list('all')).map(item => item.id)), new Set([value.id, neighbor.id]));
  record = transitioned(await f.transition(record, 'restore'), 'archived');
  assert.equal((await f.api(`/api/workflow-schedules/${schedule.id}`)).body.schedule.enabled, false);
  record = transitioned(await f.transition(record, 'unarchive'), 'active');
  assert.equal((await f.api(`/api/workflow-schedules/${schedule.id}`)).body.schedule.enabled, false);
  await assertHistory();
  record = transitioned(await f.transition(record, 'archive'), 'archived');
  record = transitioned(await f.transition(record, 'trash'), 'trashed');
  const purged = await f.transition(record, 'purge', { confirmationTitle: value.title });
  assert.equal(purged.status, 200, JSON.stringify(purged.body)); assert.equal(purged.body.deleted, true); assert.equal(purged.body.id, value.id);
  assert.equal((await f.api(`/api/workflow-library/${value.id}`)).status, 410);
  assert.deepEqual((await f.list('all')).map(item => item.id), [neighbor.id]); await assertHistory();
  await f.restart(); await assertHistory();
  assert.equal((await f.api(`/api/workflow-library/${value.id}`)).status, 410);
  assert.equal((await f.api(`/api/workflow-schedules/${schedule.id}`)).body.schedule.enabled, false);
  assert.equal((await f.api(`/api/workflow-library/${neighbor.id}`)).status, 200);
});

test('lifecycle HTTP requires explicit ordered states, exact purge title and the current revision', async t => {
  const f = await fixture(t), value = document(); let record = await f.save(value);
  for (const action of ['trash', 'restore', 'purge']) {
    assert.equal((await f.transition(record, action, action === 'purge' ? { confirmationTitle: value.title } : {})).status, 409);
  }
  const original = record;
  record = transitioned(await f.transition(record, 'archive'), 'archived');
  assert(record.revision > original.revision);
  assert.equal((await f.transition(original, 'trash')).status, 409);
  assert.equal((await f.transition(record, 'purge', { confirmationTitle: value.title })).status, 409);
  record = transitioned(await f.transition(record, 'trash'), 'trashed');
  assert.equal((await f.transition(record, 'unarchive')).status, 409);
  for (const confirmationTitle of ['', value.title + ' ', '另一工作流', value.title.toUpperCase()]) {
    if (confirmationTitle === value.title) continue;
    assert.equal((await f.transition(record, 'purge', { confirmationTitle })).status, 400);
  }
  assert.equal((await f.api(`/api/workflow-library/${value.id}`)).body.workflow.lifecycle, 'trashed');
  assert.equal((await f.transition(record, 'purge', { confirmationTitle: value.title })).status, 200);
  assert.equal((await f.transition(record, 'restore')).status, 410);
});

test('lifecycle HTTP enforces CSRF, method, body, ID and list-filter validation without changing state', async t => {
  const f = await fixture(t), value = document(), record = await f.save(value), path = `/api/workflow-library/${value.id}/archive`;
  for (const headers of [{ 'X-Workbench-Token': '' }, { 'X-Workbench-Token': 'incorrect' }, { Origin: 'https://example.invalid' }]) {
    assert.equal((await f.api(path, { expectedRevision: record.revision }, headers)).status, 403);
  }
  assert.equal((await f.api(path, { expectedRevision: record.revision }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.request(path, { method: 'POST', raw: '{invalid json' })).status, 400);
  for (const method of ['GET', 'DELETE', 'PUT', 'PATCH']) assert.equal((await f.request(path, { method })).status, 404);
  for (const body of [null, [], {}, { revision: 1 }, { expectedRevision: 1, extra: true },
    { expectedRevision: 1, confirmationTitle: value.title }, ...[null, true, '1', -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1].map(expectedRevision => ({ expectedRevision }))]) {
    assert.equal((await f.api(path, body)).status, 400, JSON.stringify(body));
  }
  for (const id of ['__proto__', 'constructor', 'slash%2Fin', '%E0%A4%A']) {
    assert.equal((await f.api(`/api/workflow-library/${id}/archive`, { expectedRevision: 1 })).status, 400);
  }
  assert.equal((await f.api('/api/workflow-library/missing/unknown', { expectedRevision: 1 })).status, 404);
  assert.equal((await f.api('/api/workflow-library/missing/archive', { expectedRevision: 1 })).status, 404);
  assert.equal((await f.api('/api/workflow-library?lifecycle=unsupported')).status, 400);
  assert.equal((await f.api(`/api/workflow-library/${value.id}`)).body.workflow.lifecycle, 'active');
});

test('lifecycle transitions conflict with concurrent edits and stale cached saves cannot resurrect inactive documents', async t => {
  const f = await fixture(t), value = document(); let record = await f.save(value);
  const outcomes = await Promise.all([f.transition(record, 'archive'),
    f.api('/api/workflow-library', { document: { ...value, title: '并发编辑后的名称' }, expectedRevision: record.revision })]);
  assert.deepEqual(outcomes.map(item => item.status).sort(), [200, 409]);
  record = (await f.api(`/api/workflow-library/${value.id}`)).body.workflow;
  if (record.lifecycle === 'active') record = transitioned(await f.transition(record, 'archive'), 'archived');
  const staleSaves = async status => {
    for (const body of [{ document: value }, { document: record.document || value, expectedRevision: record.revision },
      { document: value, expectedRevision: 0 }]) assert.equal((await f.api('/api/workflow-library', body)).status, status);
  };
  await staleSaves(409);
  record = transitioned(await f.transition(record, 'trash'), 'trashed'); await staleSaves(409);
  const current = (await f.api(`/api/workflow-library/${value.id}`)).body.workflow;
  assert.equal((await f.transition(record, 'purge', { confirmationTitle: current.document.title })).status, 200);
  await staleSaves(410); await f.restart(); await staleSaves(410);
  assert.deepEqual(await f.list('all'), []);
});

test('archived, trashed and purged documents reject v1/v2 execution, rerun and schedule reactivation but allow fresh temporary workflows', async t => {
  const f = await fixture(t);
  for (const schemaVersion of [1, 2]) {
    const value = document({ schemaVersion }); let record = await f.save(value);
    const initial = await f.api('/api/workflow-runs', { document: value, input: ' initial ' }); assert.equal(initial.status, 202, JSON.stringify(initial.body));
    const run = (await until(() => f.api(`/api/workflow-runs/${initial.body.id}`), result => result.body.status === 'complete')).body;
    const scheduled = await f.api('/api/workflow-schedules', scheduleBody(value));
    assert.equal(scheduled.status, 201, JSON.stringify(scheduled.body)); const schedule = scheduled.body.schedule;
    for (const [action, status] of [['archive', 409], ['trash', 409], ['purge', 410]]) {
      const changed = await f.transition(record, action, action === 'purge' ? { confirmationTitle: value.title } : {});
      if (action !== 'purge') record = transitioned(changed, action === 'archive' ? 'archived' : 'trashed'); else assert.equal(changed.status, 200);
      const started = await f.api('/api/workflow-runs', { document: value, input: ' must not run ' });
      assert.equal(started.status, status, JSON.stringify(started.body));
      if (schemaVersion === 2) assert.equal((await f.api(`/api/workflow-runs/${run.id}/rerun`, { nodeIds: ['trim'] })).status, status);
      assert.equal((await f.api(`/api/workflow-schedules/${schedule.id}/enabled`, { enabled: true })).status, status);
      assert.equal((await f.api('/api/workflow-schedules', scheduleBody(value))).status, status);
      assert.equal(f.app.workflows.list(value.id).length, 1, 'rejected starts create no extra run');
    }
  }
  const temporary = document();
  const started = await f.api('/api/workflow-runs', { document: temporary, input: ' temporary ' });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal((await until(() => f.api(`/api/workflow-runs/${started.body.id}`), result => result.body.status === 'complete')).body.output, 'temporary');
});

test('a real human-review wait blocks archival until the running graph is stopped', async t => {
  const f = await fixture(t), value = document({ human: true }); const record = await f.save(value);
  const started = await f.api('/api/workflow-runs', { document: value, input: ' review pending ' }); assert.equal(started.status, 202);
  await until(() => f.api(`/api/workflow-runs/${started.body.id}`), result => result.body.status === 'waiting_review');
  const before = (await f.api(`/api/workflow-runs/${started.body.id}`)).body;
  assert.equal((await f.transition(record, 'archive')).status, 409);
  assert.deepEqual((await f.api(`/api/workflow-runs/${started.body.id}`)).body, before);
  assert.equal((await f.api(`/api/workflow-runs/${started.body.id}/interrupt`, {})).body.status, 'interrupted');
  transitioned(await f.transition(record, 'archive'), 'archived');
});

test('persisted queued runs and learning phases block lifecycle changes without touching their histories', async t => {
  const f = await fixture(t), value = document(); const record = await f.save(value);
  const insert = f.app.store.db.prepare('INSERT INTO workflow_runs(id,value) VALUES(?,?)');
  for (const status of ['preparing', 'running', 'waiting', 'queued', 'waiting_review']) {
    const id = randomUUID(), raw = JSON.stringify({ id, workflowId: value.id, status, document: value, nodes: {}, startedAt: new Date().toISOString() });
    insert.run(id, raw); assert.equal((await f.transition(record, 'archive')).status, 409, status);
    assert.equal(f.app.store.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(id).value, raw);
    f.app.store.db.prepare('DELETE FROM workflow_runs WHERE id=?').run(id);
  }
  const insertLearning = f.app.store.db.prepare('INSERT INTO workflow_learning(id,value) VALUES(?,?)');
  for (const phase of ['preparing-memory', 'running-sample', 'evaluating', 'rewriting', 'waiting-review', 'stopping']) {
    const id = randomUUID(), raw = JSON.stringify({ id, workflowId: value.id, status: phase === 'waiting-review' ? 'waiting' : 'running', phase,
      document: { ...value, mode: 'learn' }, config: { trainingCases: [], validationCases: [] }, rounds: [], startedAt: new Date().toISOString() });
    insertLearning.run(id, raw); assert.equal((await f.transition(record, 'archive')).status, 409, phase);
    assert.equal(f.app.store.db.prepare('SELECT value FROM workflow_learning WHERE id=?').get(id).value, raw);
    f.app.store.db.prepare('DELETE FROM workflow_learning WHERE id=?').run(id);
  }
  f.app.workflows.locks.set(value.id, {}); assert.equal((await f.transition(record, 'archive')).status, 409); f.app.workflows.locks.delete(value.id);
  f.app.learning.locks.set(value.id, {}); assert.equal((await f.transition(record, 'archive')).status, 409); f.app.learning.locks.delete(value.id);
  transitioned(await f.transition(record, 'archive'), 'archived');
});

test('archive racing an awaited DAG preflight cannot admit an archived workflow', async t => {
  const f = await fixture(t), value = document(); let record = await f.save(value);
  const original = f.app.workflowFiles.prepareRun.bind(f.app.workflowFiles);
  let release, entered; const gate = new Promise(resolve => { entered = resolve; });
  f.app.workflowFiles.prepareRun = async (...args) => { entered(); await new Promise(resolve => { release = resolve; }); return original(...args); };
  const starting = f.api('/api/workflow-runs', { document: value, input: ' race ' });
  await gate;
  let archived;
  try { archived = await f.transition(record, 'archive'); }
  finally { release(); }
  const started = await starting;
  assert([200, 409].includes(archived.status), JSON.stringify(archived.body));
  if (archived.status === 200) {
    assert.equal(started.status, 409, 'the final admission check must reject a workflow archived during preflight');
    assert.equal(f.app.workflows.list(value.id).length, 0); record = archived.body.workflow;
  } else {
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await until(() => f.api(`/api/workflow-runs/${started.body.id}`), result => result.body.status === 'complete');
    record = transitioned(await f.transition(record, 'archive'), 'archived');
  }
  assert.equal((await f.api(`/api/workflow-library/${value.id}`)).body.workflow.lifecycle, 'archived');
  assert.equal((await f.api('/api/workflow-runs', { document: value, input: ' denied after race ' })).status, 409);
});

test('an embedded archived child snapshot cannot bypass lifecycle execution admission', async t => {
  const f = await fixture(t), child = document(); let childRecord = await f.save(child);
  childRecord = transitioned(await f.transition(childRecord, 'archive'), 'archived');
  let parent = createDocument({ title: '包含冻结子流程', schemaVersion: 2 });
  parent.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'entry', config: { outputType: 'text' } }),
    createNode('subflow', { x: 300, y: 0 }, { id: 'child', config: { inputType: 'text', outputType: 'text', workflowRef: child.id,
      version: 'sha256:' + hash(JSON.stringify(child)), document: child } }),
    createNode('output', { x: 600, y: 0 }, { id: 'exit' })];
  for (const [from, to] of [['entry', 'child'], ['child', 'exit']]) parent = connectNodes(parent, { sourceNode: from, sourcePort: 'out', targetNode: to, targetPort: 'in' });
  for (const includeReference of [true, false]) {
    const snapshot = structuredClone(parent);
    if (!includeReference) delete snapshot.nodes[1].config.workflowRef;
    const response = await f.api('/api/workflow-runs', { document: snapshot, input: ' no stale child ' });
    assert.equal(response.status, 409, JSON.stringify(response.body));
  }
  assert.equal(f.app.workflows.list().length, 0);
});

test('a schedule claimed before archival is fenced during its awaited preflight and is never replayed after restart', async t => {
  const f = await fixture(t), value = document(); let record = await f.save(value);
  const scheduled = await f.api('/api/workflow-schedules', scheduleBody(value)); assert.equal(scheduled.status, 201, JSON.stringify(scheduled.body));
  const schedule = scheduled.body.schedule, original = f.app.workflowFiles.prepareRun.bind(f.app.workflowFiles);
  let release, entered; const gate = new Promise(resolve => { entered = resolve; });
  f.app.workflowFiles.prepareRun = async (...args) => { entered(); await new Promise(resolve => { release = resolve; }); return original(...args); };
  f.app.schedules.clock = () => Date.parse(schedule.nextRunAt) + 100;
  const ticking = f.app.schedules.tick(); await gate;
  assert.equal(f.app.schedules.pending.size, 1);
  let archived;
  try { archived = await f.transition(record, 'archive'); }
  finally { release(); }
  await ticking;
  assert.equal(f.app.schedules.pending.size, 0);
  if (archived.status === 200) {
    record = archived.body.workflow; assert.equal(f.app.workflows.list(value.id).length, 0, 'the old claimed snapshot did not start');
  } else {
    assert.equal(archived.status, 409, JSON.stringify(archived.body));
    await until(() => f.app.workflows.list(value.id), runs => runs.length === 1 && runs[0].status === 'complete');
    record = transitioned(await f.transition(record, 'archive'), 'archived');
  }
  assert.equal(record.lifecycle, 'archived');
  const count = f.app.workflows.list(value.id).length;
  assert.equal((await f.api(`/api/workflow-schedules/${schedule.id}`)).body.schedule.enabled, false);
  await f.app.schedules.tick(); assert.equal(f.app.workflows.list(value.id).length, count);
  await f.restart(); await f.app.schedules.tick();
  assert.equal(f.app.workflows.list(value.id).length, count);
  assert.equal((await f.api(`/api/workflow-schedules/${schedule.id}`)).body.schedule.enabled, false);
});

test('inactive workflows cannot begin sample learning, feedback learning or candidate application and make no model or memory call', async t => {
  const f = await fixture(t), value = document(), content = 'Fixture Skill with stable original instructions.', revision = 'sha256:' + hash(content);
  value.nodes[1] = createNode('skill', { x: 300, y: 0 }, { id: 'trim', config: {
    skillRef: 'fixture-lifecycle-skill', version: revision, inputType: 'text', outputType: 'text',
  } });
  value.nodes.push(createNode('evaluation', { x: 900, y: 250 }, { id: 'compare', config: { comparison: 'exact' } }),
    createNode('improvement', { x: 1200, y: 250 }, { id: 'improve', config: { targetSkillNodeIds: ['trim'] } }));
  let linked = connectNodes(value, { sourceNode: 'exit', sourcePort: 'learning', targetNode: 'compare', targetPort: 'in' });
  linked = connectNodes(linked, { sourceNode: 'compare', sourcePort: 'out', targetNode: 'improve', targetPort: 'in' });
  let record = await f.save(linked);
  const id = randomUUID(), now = new Date().toISOString(), run = { schemaVersion: 2, id, workflowId: linked.id,
    title: linked.title, status: 'complete', document: linked, input: 'original input', output: 'original result',
    skills: [{ nodeId: 'trim', name: 'fixture-lifecycle-skill', revision, source: 'local' }],
    nodes: Object.fromEntries(linked.nodes.map(node => [node.id, { status: ['compare', 'improve'].includes(node.id) ? 'skipped' : 'complete',
      input: 'original input', output: 'original result', artifacts: [] }])), startedAt: now, completedAt: now };
  f.app.store.db.prepare('INSERT INTO workflow_runs(id,value) VALUES(?,?)').run(id, JSON.stringify(run));
  const savedFeedback = await f.api(`/api/workflow-runs/${id}/feedback`, { expectedRevision: 0, comment: '修改说明中的问题，保留原始输入事实。' });
  assert.equal(savedFeedback.status, 200, JSON.stringify(savedFeedback.body));
  const learningId = randomUUID(), feedbackJobId = randomUUID();
  const learning = { id: learningId, workflowId: linked.id, status: 'complete', phase: 'finished', document: { ...linked, mode: 'learn' },
    rounds: [{ index: 0, status: 'complete', cases: [], changes: [] }], bestDocument: linked, bestRound: 0, bestScore: 100,
    config: { trainingCases: [], validationCases: [] }, startedAt: now, completedAt: now };
  const feedbackJob = { ...learning, id: feedbackJobId, kind: 'feedback', reason: 'feedback-candidate-ready', validationStatus: 'not-run',
    sourceRunId: id, candidateDocument: linked, feedbackRevision: 1, feedbackSnapshot: savedFeedback.body.feedback };
  const insert = f.app.store.db.prepare('INSERT INTO workflow_learning(id,value) VALUES(?,?)');
  insert.run(learningId, JSON.stringify(learning)); insert.run(feedbackJobId, JSON.stringify(feedbackJob));
  const calls = { skill: 0, memory: 0, generate: 0, publish: 0 };
  f.app.checkReady = () => {};
  f.app.skill = async () => { calls.skill++; return { name: 'fixture-lifecycle-skill', content, revision, source: 'local' }; };
  f.app.learning.model.createMemoryScope = async () => { calls.memory++; throw Error('Inactive workflow captured memory.'); };
  f.app.learning.model.generate = async () => { calls.generate++; throw Error('Inactive workflow called a model.'); };
  f.app.learnedSkills.publish = async () => { calls.publish++; throw Error('Inactive workflow published a candidate.'); };
  for (const [action, status] of [['archive', 409], ['trash', 409], ['purge', 410]]) {
    const changed = await f.transition(record, action, action === 'purge' ? { confirmationTitle: linked.title } : {});
    if (action === 'purge') assert.equal(changed.status, 200); else record = transitioned(changed, action === 'archive' ? 'archived' : 'trashed');
    const requests = [
      ['/api/workflow-learning', { document: { ...linked, mode: 'learn' }, input: 'training', expected: 'expected', targetScore: 100, maxRounds: 1 }],
      [`/api/workflow-runs/${id}/feedback/learn`, { feedbackRevision: 1 }],
      [`/api/workflow-learning/${learningId}/apply`, {}],
      [`/api/workflow-learning/${feedbackJobId}/apply-feedback`, {}],
    ];
    for (const [path, body] of requests) {
      const rejected = await f.api(path, body); assert.equal(rejected.status, status, JSON.stringify({ path, response: rejected.body }));
      assert.match(rejected.body.error, /归档|回收站|已删除/, path);
    }
    assert.deepEqual(calls, { skill: 0, memory: 0, generate: 0, publish: 0 });
    assert.equal(f.app.learning.list(linked.id).length, 2, 'rejected learning admission does not create a new batch');
  }
});
