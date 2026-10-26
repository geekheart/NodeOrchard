import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';
import { WorkflowRuns } from '../src/workflows/workflow-runs.mjs';
import { WorkflowFiles } from '../src/workflows/workflow-files.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { const result = check(); if (result) return result; await delay(5); }
  throw new Error('Timed out waiting for isolated workflow state');
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-delivery-lifecycle-'));
  const db = new DatabaseSync(join(directory, 'test.sqlite'));
  const app = new EventEmitter();
  app.store = { db }; app.config = { appRoot: directory, dataDir: directory, workspaceRoot: directory, workflowRunRoot: join(directory, 'local-runs') }; app.preferences = {};
  app.publish = (type, sessionId, payload) => app.emit('event', { type, sessionId, payload });
  app.workflowFiles = new WorkflowFiles(app, { allowedRoots: [directory], openDirectory: async () => {} });
  let calls = 0;
  const executeOperation = async ({ cwd }) => {
    calls++; const path = join(cwd, 'result.txt'); await writeFile(path, 'locally generated and reviewed');
    return { output: { path }, artifacts: [{ path }] };
  };
  const replaceManager = () => { app.workflows = new WorkflowRuns(app, { executeOperation }); return app.workflows; };
  const manager = replaceManager();
  t.after(async () => { await app.workflows.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  let document = createDocument({ schemaVersion: 2, title: 'Publication lifecycle fixture' });
  document.nodes = [
    createNode('input', {}, { id: 'input', config: { outputType: 'object' } }),
    createNode('tool', {}, { id: 'produce', config: { executionMode: 'code', language: 'javascript', code: 'return input;', inputType: 'object', outputType: 'object' } }),
    createNode('human', {}, { id: 'review', config: { inputType: 'object', outputType: 'object' } }),
    createNode('output', {}, { id: 'output' }),
  ];
  for (const [sourceNode, targetNode] of [['input', 'produce'], ['produce', 'review'], ['review', 'output']]) document = connectNodes(document, { sourceNode, sourcePort: 'out', targetNode, targetPort: 'in' });
  const started = await manager.start({ document, input: {}, outputDirectory: join(directory, 'deliveries') });
  await until(() => manager.get(started.id).status === 'waiting_review');
  await manager.approve(started.id, { nodeId: 'review', action: 'approve', feedback: 'Accepted in isolated fixture' });
  const run = await until(() => manager.get(started.id).status === 'complete' && manager.get(started.id));
  return { directory, app, db, manager, replaceManager, run, calls: () => calls };
}

test('restart during publication preserves approval and exposes copy-only recovery instead of a nonexistent review wait', async t => {
  const { app, db, manager, replaceManager, run, calls } = await fixture(t);
  await manager.close();
  await rm(run.delivery.directory, { recursive: true });
  const interrupted = { ...structuredClone(run), status: 'running', completedAt: null,
    delivery: { status: 'publishing', directory: run.deliveryDirectory } };
  db.prepare('UPDATE workflow_runs SET value=? WHERE id=?').run(JSON.stringify(interrupted), run.id);
  const replacement = replaceManager();
  await delay(15);
  const recovered = replacement.get(run.id);
  assert.equal(recovered.status, 'error'); assert.equal(recovered.delivery.status, 'error');
  assert.match(recovered.delivery.error, /本机原件已保留.*重试保存副本/);
  assert.equal(replacement.dag.active.has(run.id), false); assert.equal(replacement.locks.has(run.workflowId), false);
  assert.equal(calls(), 1); assert.deepEqual(recovered.nodes, run.nodes);
  const result = await replacement.publishDelivery(run.id);
  assert.equal(result.status, 'complete'); assert.equal(result.delivery.status, 'complete'); assert.equal(calls(), 1);
  assert.deepEqual(result.nodes.review.review, run.nodes.review.review);
  assert.equal((await app.workflowFiles.readArtifact(run.nodes.produce.artifacts[0].id)).data.toString(), 'locally generated and reviewed');
  assert.equal(await readFile(join(result.delivery.directory, 'produce', '版本-1', 'result.txt'), 'utf8'), 'locally generated and reviewed');
});

test('close waits for an authorized copy-only retry and persists its result before the store can close', async t => {
  const { app, db, manager, run, calls } = await fixture(t);
  await rm(run.delivery.directory, { recursive: true });
  const entered = deferred(), release = deferred(); let held = false;
  app.workflowFiles.copyArtifact = async (source, target, flags) => {
    if (!held) { held = true; entered.resolve(); await release.promise; }
    await copyFile(source, target, flags);
  };
  const publication = manager.publishDelivery(run.id);
  let closing;
  try {
    await entered.promise;
    assert.equal(manager.get(run.id).delivery.status, 'publishing');
    let closed = false; closing = manager.close().then(() => { closed = true; });
    await delay(15); assert.equal(closed, false);
    await assert.rejects(manager.publishDelivery(run.id), error => error.httpStatus === 503);
    release.resolve(); const [result] = await Promise.all([publication, closing]);
    assert.equal(closed, true); assert.equal(result.status, 'complete'); assert.equal(result.delivery.status, 'complete');
    const persisted = JSON.parse(db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(run.id).value);
    assert.equal(persisted.delivery.status, 'complete'); assert.equal(persisted.status, 'complete');
    assert.deepEqual(persisted.nodes, run.nodes); assert.equal(calls(), 1); assert.equal(manager.dag.publications.size, 0);
  } finally {
    // Release the fake disk before fixture teardown can close the database.
    release.resolve(); await Promise.allSettled([publication, closing]);
  }
});

test('a failed delivery copy can be retried without executing capabilities or reopening accepted reviews', async t => {
  const { app, manager, run, calls } = await fixture(t);
  await rm(run.delivery.directory, { recursive: true });
  app.workflowFiles.copyArtifact = async () => { throw new Error('isolated delivery disk failure'); };
  const failed = await manager.publishDelivery(run.id);
  assert.equal(failed.status, 'error'); assert.equal(failed.delivery.status, 'error');
  assert.match(failed.delivery.error, /isolated delivery disk failure/);
  assert.deepEqual(failed.nodes, run.nodes); assert.equal(calls(), 1);
  app.workflowFiles.copyArtifact = copyFile;
  const recovered = await manager.publishDelivery(run.id);
  assert.equal(recovered.status, 'complete'); assert.equal(recovered.delivery.status, 'complete');
  assert.equal(recovered.delivery.revision, run.delivery.revision + 2);
  assert.equal(calls(), 1); assert.deepEqual(recovered.nodes, run.nodes);
  assert.equal(await readFile(join(recovered.delivery.directory, 'produce', '版本-1', 'result.txt'), 'utf8'), 'locally generated and reviewed');
});
