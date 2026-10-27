import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { createDocument } from '../shared/workflow/workflow-model.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(name) { this.calls.push(name); throw Error('Example tests never invoke Hermes'); }
  async stop() {}
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-examples-')), adapter = new Offline();
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), port: 0 };
  const app = new Application(config, adapter); await app.workflowFoldersReady;
  const bridge = createWorkbenchServer(config, app), origin = await bridge.listen(), csrf = (await (await fetch(origin + '/api/bootstrap')).json()).csrfToken;
  t.after(async () => { await bridge.close(); assert.deepEqual(adapter.calls, []); await rm(directory, { recursive: true, force: true }); });
  const post = (id, body, extra = {}) => fetch(origin + '/api/workflow-examples/' + id + '/prepare', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': csrf, ...extra }, body: JSON.stringify(body) });
  return { app, adapter, origin, post };
}

test('example HTTP prepares drafts with defaults and explicit prerequisites without creating a workflow, folder, run or learning batch', async t => {
  const f = await fixture(t), workflowId = 'workflow-' + randomUUID();
  const listed = await (await fetch(f.origin + '/api/workflow-examples')).json(); assert.equal(listed.examples.length, 8);
  const local = await f.post('local-data', { workflowId }); assert.equal(local.status, 200);
  const result = await local.json(); assert.equal(result.ready, true); assert.equal(result.document.id, workflowId); assert.equal(result.example.requiresModel, false);
  const blocked = await (await f.post('learning-text', { workflowId })).json(); assert.equal(blocked.ready, false); assert.equal(blocked.learningConfig.maxRounds, 2);
  assert.equal(blocked.learningConfig.trainingCases.length, 1); assert.equal(blocked.learningConfig.validationCases.length, 1);
  assert.match(blocked.requirements.join(' '), /Hermes/);
  for (const table of ['workflow_documents', 'workflow_runs', 'workflow_learning', 'workflow_conversation_turns']) assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM ' + table).get().count, 0);
  await assert.rejects(stat(f.app.workflowFolders.directory(workflowId)), { code: 'ENOENT' });
});

test('example HTTP enforces CSRF, origin, exact identities and lifecycle, and pins actual Skill bytes when connected', async t => {
  const f = await fixture(t), workflowId = 'workflow-' + randomUUID(), body = { workflowId };
  assert.equal((await f.post('local-data', body, { 'X-Workbench-Token': '' })).status, 403);
  assert.equal((await f.post('local-data', body, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.post('unknown-example', body)).status, 404);
  assert.equal((await f.post('local-data', { workflowId: '../escape' })).status, 400);
  assert.equal((await f.post('local-data', { ...body, path: '/tmp/custom.json' })).status, 400);
  assert.equal((await fetch(f.origin + '/api/workflow-examples?path=/tmp')).status, 400);
  f.adapter.state = 'ready'; f.app.backend.state = 'ready';
  const content = 'actual isolated fixture Skill', revision = 'sha256:' + createHash('sha256').update(content).digest('hex');
  f.app.skill = async name => ({ name, content, revision });
  const prepared = await (await f.post('humanizer', body)).json(); assert.equal(prepared.ready, true);
  assert.equal(prepared.document.nodes.find(node => node.type === 'skill').config.version, revision);
  const existing = createDocument({ schemaVersion: 2 }); f.app.workflowLibrary.save({ document: existing, expectedRevision: 0 });
  f.app.workflowLibrary.transition(existing.id, 'trash', { expectedRevision: 1 });
  assert.equal((await f.post('local-data', { workflowId: existing.id })).status, 409);
});

test('dependency-free example defaults execute real local workers without a model, and review stops at its intended human gate', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const until = async (id, wanted) => { for (let count = 0; count < 600; count++) { const run = f.app.workflows.get(id); if (wanted.includes(run.status)) return run; if (['error', 'unknown', 'interrupted'].includes(run.status)) assert.fail(run.error); await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Local example did not settle'); };
  for (const id of ['local-data', 'document-review']) {
    const prepared = await f.app.workflowExamples.prepare(id, { workflowId: 'workflow-' + randomUUID() });
    const run = await f.app.workflows.start({ document: prepared.document }), complete = await until(run.id, ['complete']);
    if (id === 'local-data') { assert.equal(complete.output.checked, true); assert.equal(complete.output.itemCount, 2); assert.equal(complete.output.enabled, false); }
    else { assert.equal(complete.output['sample-output'].complete, true); assert.equal(complete.output['sample-output'].owner, '示例负责人'); assert.equal(complete.nodes['sample-human'].status, 'skipped'); }
  }
  const prepared = await f.app.workflowExamples.prepare('publication-review', { workflowId: 'workflow-' + randomUUID() });
  const run = await f.app.workflows.start({ document: prepared.document }), waiting = await until(run.id, ['waiting_review']);
  assert.equal(Object.values(waiting.nodes).filter(node => node.status === 'waiting_review').length, 1);
});
