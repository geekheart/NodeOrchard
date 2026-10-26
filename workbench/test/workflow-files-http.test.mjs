import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Application } from '../src/application.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = 0; }
  async start() { this.calls++; throw new Error('No model in file admission tests'); }
  async request() { this.calls++; throw new Error('No model in file admission tests'); }
  async stop() {}
}

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-files-http-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), appRoot: directory, port: 0 };
  const adapter = new Offline(), app = new Application(config, adapter), bridge = createWorkbenchServer(config, app);
  const origin = await bridge.listen();
  const token = (await (await fetch(origin + '/api/bootstrap')).json()).csrfToken;
  const request = async (path, body, headers = {}) => {
    const response = await fetch(origin + path, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token, ...headers } }) });
    return { response, value: await response.json() };
  };
  t.after(async () => { await bridge.close(); assert.equal(adapter.calls, 0); await rm(directory, { force: true, recursive: true }); });
  const document = { schemaVersion: 2, id: 'file-test', title: '文件测试', settings: {}, nodes: [{ id: 'entry', type: 'input', config: {
    fieldName: 'materials', fields: [{ key: 'project', label: '工程', kind: 'file', required: true, extensions: ['.epro2'] }],
  } }] };
  return { app, directory, origin, request, document };
}

test('file preparation HTTP returns actionable missing inputs, browses real local roots and rejects unsafe reads', async t => {
  const { directory, request, document } = await setup(t);
  const response = await request('/api/workflow-v2/preflight', { document, input: {} });
  assert.equal(response.response.status, 200); assert.equal(response.value.ok, false);
  assert.equal(response.value.errors[0].label, '工程');
  const root = await request('/api/workflow-v2/files'); assert(root.value.roots.some(item => item.path === directory || item.path.endsWith(directory)));
  await writeFile(join(directory, 'actual.epro2'), 'project');
  const files = await request('/api/workflow-v2/files?directory=' + encodeURIComponent(directory));
  assert(files.value.entries.some(item => item.name === 'actual.epro2'));
  const blocked = await request('/api/workflow-v2/files?directory=' + encodeURIComponent('/etc'));
  assert.equal(blocked.response.status, 403);
  const csrf = await request('/api/workflow-v2/preflight', { document, input: {} }, { 'X-Workbench-Token': 'invalid' });
  assert.equal(csrf.response.status, 403);
});

test('artifacts HTTP serves only registered hash-bound bytes with inline preview and attachment download', async t => {
  const { app, directory, origin } = await setup(t);
  const runId = randomUUID();
  await app.workflowFiles.prepareRun({ document: { id: 'artifact-test', title: '产物测试', nodes: [] }, input: {}, runId });
  const folder = await app.workflowFiles.nodeDirectory({ runId, nodeId: 'draw' }), path = join(folder, '说明.md');
  await writeFile(path, '# 已保存');
  const artifact = await app.workflowFiles.registerArtifact({ runId, nodeId: 'draw', path });
  let response = await fetch(origin + artifact.previewUrl);
  assert.equal(response.status, 200); assert.equal(await response.text(), '# 已保存');
  assert.match(response.headers.get('content-disposition'), /^inline/);
  response = await fetch(origin + artifact.downloadUrl);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /^attachment/);
  response = await fetch(origin + '/api/workflow-v2/artifacts/' + encodeURIComponent(join(directory, 'secret.txt')));
  assert.equal(response.status, 400);
  await writeFile(path, '# changed'); response = await fetch(origin + artifact.previewUrl);
  assert.equal(response.status, 409);
});

test('review rerun and queue HTTP route to the durable executor rather than Hermes tool approvals', async t => {
  const { app, request } = await setup(t), id = randomUUID(), calls = [];
  app.workflows.approve = async (runId, body) => { calls.push(['review', runId, body]); return { id: runId, status: 'running' }; };
  app.workflows.rerun = async (runId, body) => { calls.push(['rerun', runId, body]); return { id: runId, status: 'queued' }; };
  app.workflows.queueStatus = () => ({ running: [], waiting: [{ id }], queued: [] });
  const review = await request('/api/workflow-runs/' + id + '/review', { nodeId: 'gate', action: 'approve' });
  assert.equal(review.response.status, 202); assert.equal(review.value.id, id);
  const rerun = await request('/api/workflow-runs/' + id + '/rerun', { nodeIds: ['draw'] });
  assert.equal(rerun.response.status, 202);
  const queue = await request('/api/workflow-v2/queue'); assert.equal(queue.value.waiting[0].id, id);
  assert.deepEqual(calls, [['review', id, { nodeId: 'gate', action: 'approve' }], ['rerun', id, { nodeIds: ['draw'] }]]);
});

test('a real image-producing workflow exposes its intermediate file and waits before downstream work', async t => {
  const { app, directory, origin, request } = await setup(t);
  const source = join(directory, 'board.epro2'); await writeFile(source, 'fixture project');
  let document = createDocument({ title: '图片审核实际执行', schemaVersion: 2 });
  document.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'entry', config: { outputType: 'object', fieldName: 'materials',
    fields: [{ key: 'project', label: '工程', kind: 'file', extensions: ['.epro2'] }] } }),
    createNode('tool', { x: 250, y: 0 }, { id: 'draw', config: { inputType: 'object', outputType: 'object', executionMode: 'code', language: 'javascript',
      code: "const fs = await import('node:fs/promises'); const path = context.outputDirectory + '/candidate.png'; await fs.writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=', 'base64')); return {path};" } }),
    createNode('human', { x: 500, y: 0 }, { id: 'review', config: { inputType: 'object', outputType: 'object', prompt: '检查图片', reviewTargetNodeId: 'draw' } }),
    createNode('tool', { x: 750, y: 0 }, { id: 'compose', config: { inputType: 'object', outputType: 'object', executionMode: 'code', language: 'javascript',
      code: "const fs = await import('node:fs/promises'); const path = context.outputDirectory + '/guide.md'; await fs.writeFile(path, '# Uses approved image'); return {path};" } }),
    createNode('output', { x: 1000, y: 0 }, { id: 'result' })];
  for (let index = 1; index < document.nodes.length; index++) document = connectNodes(document, {
    sourceNode: document.nodes[index - 1].id, sourcePort: 'out', targetNode: document.nodes[index].id, targetPort: 'in',
  });
  const start = await request('/api/workflow-runs', { document, input: { materials: { project: source } } });
  assert.equal(start.response.status, 202, JSON.stringify(start.value));
  let run;
  const waitFor = async predicate => {
    const deadline = Date.now() + 5000;
    do { run = app.workflows.get(start.value.id); if (predicate(run)) return run; await new Promise(resolve => setTimeout(resolve, 10)); } while (Date.now() < deadline);
    assert.fail('Expected actual workflow state, got: ' + JSON.stringify(run));
  };
  await waitFor(value => value.status === 'waiting_review' || ['error', 'unknown'].includes(value.status));
  assert.equal(run.status, 'waiting_review', JSON.stringify(run));
  assert.equal(run.nodes.compose.status, 'pending');
  const earlyPublish = await request('/api/workflow-runs/' + run.id + '/publish', {});
  assert.equal(earlyPublish.response.status, 409, 'publication cannot bypass a pending human review');
  const artifact = run.nodes.draw.artifacts[0]; assert.equal(artifact.mimeType, 'image/png');
  const preview = await fetch(origin + artifact.previewUrl); assert.equal(preview.status, 200); assert.equal(preview.headers.get('content-type'), 'image/png');
  const approve = await request('/api/workflow-runs/' + run.id + '/review', { nodeId: 'review', action: 'approve' });
  assert.equal(approve.response.status, 202, JSON.stringify(approve.value));
  await waitFor(value => ['complete', 'error', 'unknown'].includes(value.status));
  assert.equal(run.status, 'complete', JSON.stringify(run));
  assert(run.nodes.compose.artifacts.some(item => item.name === 'guide.md'));
  const attempts = Object.fromEntries(Object.entries(run.nodes).map(([id, state]) => [id, state.attemptId]));
  await rm(run.delivery.directory, { recursive: true });
  assert.equal((await fetch(origin + artifact.previewUrl)).status, 200, 'deleting the delivery copy cannot remove the reviewed original');
  const bad = await request('/api/workflow-runs/' + run.id + '/publish', { nodeIds: ['compose'] });
  assert.equal(bad.response.status, 400);
  const csrf = await request('/api/workflow-runs/' + run.id + '/publish', {}, { 'X-Workbench-Token': 'invalid' });
  assert.equal(csrf.response.status, 403);
  const published = await request('/api/workflow-runs/' + run.id + '/publish', {});
  assert.equal(published.response.status, 200); assert.equal(published.value.run.delivery.status, 'complete');
  assert.deepEqual(Object.fromEntries(Object.entries(published.value.run.nodes).map(([id, state]) => [id, state.attemptId])), attempts);
});
