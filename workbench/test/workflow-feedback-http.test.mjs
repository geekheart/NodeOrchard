import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Application } from '../src/application.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

class OfflineHermes extends EventEmitter {
  state = 'stopped';
  requests = [];
  async request(...args) { this.requests.push(args); throw new Error('Hermes 未连接。'); }
  async stop() {}
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-feedback-http-'));
  const config = { ...readConfig(), port: 0, dataDir: join(directory, 'data'), workspaceRoot: join(directory, 'workspace'), workflowRunRoot: join(directory, 'runs') };
  const adapter = new OfflineHermes();
  const app = new Application(config, adapter);
  let document = createDocument({ title: '离线评价已完成执行' });
  document.id = 'feedback-http-flow';
  document.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: 'text' } }),
    createNode('skill', { x: 300, y: 0 }, { id: 'skill', title: '正文整理', config: {
      skillRef: 'fixture-skill', version: `sha256:${'a'.repeat(64)}`, inputType: 'text', outputType: 'text',
    } }), createNode('output', { x: 600, y: 0 }, { id: 'output' })];
  document = connectNodes(document, { sourceNode: 'input', sourcePort: 'out', targetNode: 'skill', targetPort: 'in' });
  document = connectNodes(document, { sourceNode: 'skill', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
  const run = { id: 'http-feedback-run', workflowId: document.id, title: document.title, status: 'complete', document,
    nodeOrder: ['input', 'skill', 'output'], skills: [{ nodeId: 'skill', name: 'fixture-skill', revision: `sha256:${'a'.repeat(64)}` }],
    input: '文档', output: '已整理文档', nodes: Object.fromEntries(document.nodes.map(node => [node.id, { status: 'complete' }])) };
  app.workflows.save(run, false);
  const bridge = createWorkbenchServer(config, app);
  const origin = await bridge.listen();
  t.after(async () => { try { await bridge.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  const boot = await (await fetch(origin + '/api/bootstrap')).json();
  const api = async (path, body, options = {}) => {
    const response = await fetch(origin + path, body === undefined ? options : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': boot.csrfToken, ...options.headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, adapter, api, origin, run, path: `/api/workflow-runs/${run.id}/feedback`, csrfToken: boot.csrfToken };
}

const payload = (overrides = {}) => ({ expectedRevision: 0, comment: '检查遗漏的原理图日期，并使用本次发布日期。', ...overrides });

test('HTTP feedback reads and saves with Hermes disconnected and never modifies the run', async t => {
  const f = await fixture(t);
  const before = await f.api(`/api/workflow-runs/${f.run.id}`);
  const initial = await f.api(f.path);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.feedback, null);
  assert.equal(initial.body.canReview, true);
  assert.equal(initial.body.targets[0].skillRef, 'fixture-skill');
  const saved = await f.api(f.path, payload());
  assert.equal(saved.status, 200);
  assert.equal(saved.body.feedback.revision, 1);
  assert.equal(saved.body.feedback.schemaVersion, 2);
  assert.equal(saved.body.feedback.targets[0].title, '正文整理');
  assert.equal(saved.body.feedback.comment, payload().comment);
  assert(!Object.hasOwn(saved.body.feedback, 'items'));
  assert.deepEqual((await f.api(f.path)).body.feedback, saved.body.feedback);
  assert.deepEqual(await f.api(`/api/workflow-runs/${f.run.id}`), before);
  assert.equal(f.adapter.requests.length, 0);
  const stale = await f.api(f.path, payload());
  assert.equal(stale.status, 409);
  assert.equal((await f.api(f.path, payload({ expectedRevision: 1, comment: '' }))).body.feedback.comment, '');
});

test('HTTP feedback endpoints require CSRF, same origin, JSON and strict server-bound payloads', async t => {
  const f = await fixture(t);
  assert.equal((await f.api(f.path, payload(), { headers: { 'X-Workbench-Token': '' } })).status, 403);
  assert.equal((await f.api(f.path + '/learn', { feedbackRevision: 1 }, { headers: { 'X-Workbench-Token': '' } })).status, 403);
  assert.equal((await f.api(f.path, payload(), { headers: { Origin: 'http://foreign.example' } })).status, 403);
  assert.equal((await f.api(f.path, payload(), { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  for (const body of [payload({ workflowId: 'forged' }), payload({ targets: [{ nodeId: 'output' }] }),
    { expectedRevision: 0, items: [{ nodeId: 'skill', score: 80, comment: 'old', selectedForLearning: true }] },
    payload({ score: 100 }), payload({ items: [] }), payload({ comment: null }), payload({ comment: '字'.repeat(8001) })]) {
    assert.equal((await f.api(f.path, body)).status, 400);
  }
  assert.equal((await f.api('/api/workflow-runs/missing/feedback')).status, 404);
  assert.equal((await f.api('/api/workflow-runs/%/feedback')).status, 400);
  assert.equal((await f.api(f.path)).body.feedback, null);
});

test('HTTP learning binds the saved current revision and rejects old, absent or blank comprehensive feedback', async t => {
  const f = await fixture(t);
  const dispatched = [];
  f.app.learning.startFeedback = async input => { dispatched.push(input); return { id: 'feedback-learning-job', kind: 'feedback', status: 'running' }; };
  assert.equal((await f.api(f.path + '/learn', { feedbackRevision: 1 })).status, 409);
  assert.equal((await f.api(f.path, payload())).status, 200);
  for (const body of [{}, { feedbackRevision: '1' }, { feedbackRevision: 1, items: [] }]) {
    assert.equal((await f.api(f.path + '/learn', body)).status, 400);
  }
  const started = await f.api(f.path + '/learn', { feedbackRevision: 1 });
  assert.equal(started.status, 202);
  assert.equal(started.body.id, 'feedback-learning-job');
  assert.deepEqual(dispatched, [{ runId: f.run.id, feedbackRevision: 1 }]);
  await f.api(f.path, payload({ expectedRevision: 1, comment: '' }));
  assert.equal((await f.api(f.path + '/learn', { feedbackRevision: 1 })).status, 409);
  assert.equal((await f.api(f.path + '/learn', { feedbackRevision: 2 })).status, 400);
  assert.equal(dispatched.length, 1);
});

test('HTTP active and learning samples remain readable but cannot receive feedback', async t => {
  const f = await fixture(t);
  for (const extra of [{ status: 'running' }, { learningId: 'private-training', memoryScopeId: 'private-training' }]) {
    f.app.workflows.save({ ...f.run, ...extra }, false);
    const view = await f.api(f.path);
    assert.equal(view.status, 200);
    assert.equal(view.body.canReview, false);
    assert.match(view.body.reason, /结束|学习样例/);
    assert.equal((await f.api(f.path, payload())).status, 409);
  }
});

test('HTTP imported histories are readable and reject feedback, learning, review, rerun and delivery without dispatch', async t => {
  const f = await fixture(t);
  await f.api(f.path, payload());
  f.app.workflows.save({ ...f.run, importedArchive: true }, false);
  const before = f.app.workflows.get(f.run.id), calls = [];
  f.app.learning.startFeedback = async input => { calls.push(input); throw new Error('Archived learning must not dispatch'); };
  const view = await f.api(f.path); assert.equal(view.status, 200); assert.equal(view.body.canReview, false);
  assert.equal(view.body.feedback.revision, 1);
  for (const [path, body] of [
    [f.path, payload({ expectedRevision: 1 })], [f.path + '/learn', { feedbackRevision: 1 }],
    [`/api/workflow-runs/${f.run.id}/review`, { nodeId: 'skill', action: 'approve' }],
    [`/api/workflow-runs/${f.run.id}/rerun`, { nodeIds: ['skill'] }],
    [`/api/workflow-runs/${f.run.id}/publish`, {}],
  ]) {
    const response = await f.api(path, body); assert.equal(response.status, 409); assert.match(response.body.error, /导入.*历史/);
  }
  assert.deepEqual(f.app.workflows.get(f.run.id), before);
  assert.equal(f.app.feedback.current(f.run.id).revision, 1); assert.deepEqual(calls, []); assert.deepEqual(f.adapter.requests, []);
});

test('HTTP applies feedback candidates only through their separate explicit empty-body endpoint', async t => {
  const f = await fixture(t);
  const calls = [];
  f.app.learning.get = id => ({ id, workflowId: f.run.workflowId, kind: 'feedback', status: 'complete' });
  f.app.learning.applyFeedback = async id => { calls.push(id); return { document: f.run.document, learningId: id, validationStatus: 'pending' }; };
  const path = '/api/workflow-learning/feedback-candidate/apply-feedback';
  for (const body of [null, [], { force: true }, { document: f.run.document }]) assert.equal((await f.api(path, body)).status, 400);
  assert.equal((await f.api(path, {}, { headers: { 'X-Workbench-Token': '' } })).status, 403);
  const applied = await f.api(path, {});
  assert.equal(applied.status, 200);
  assert.equal(applied.body.learningId, 'feedback-candidate');
  assert.equal(applied.body.validationStatus, 'pending');
  assert.deepEqual(calls, ['feedback-candidate']);
  const verifiedApply = await f.api('/api/workflow-learning/feedback-candidate/apply', {});
  assert.equal(verifiedApply.status, 409);
  assert.match(verifiedApply.body.error, /待验证候选/);
  assert.equal(f.adapter.requests.length, 0);
});
