import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

const terminal = new Set(['complete', 'exhausted', 'error', 'interrupted', 'unknown']);
const normalizedCode = 'return input.trim().toLowerCase();';
class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(method) { this.calls.push(method); throw Error('Scope tests must not call Hermes'); }
  async stop() {}
}
function graph(scope = 'tools', code = 'return input;') {
  let document = createDocument({ schemaVersion: 2, title: '业务代码学习 fixture' }); document.mode = 'learn';
  document.nodes = [
    createNode('input', {}, { id: 'input', config: { outputType: 'text', defaultValue: '  HELLO WORLD  ' } }),
    createNode('tool', {}, { id: 'worker', config: { executionMode: 'code', language: 'javascript', inputType: 'text', outputType: 'text', code } }),
    createNode('output', {}, { id: 'output' }),
    createNode('evaluation', {}, { id: 'compare', config: { comparison: 'exact' } }),
    createNode('improvement', {}, { id: 'improve', config: { scope, ...(scope === 'tools' ? { targetNodeIds: ['worker'] } : {}) } }),
  ];
  for (const [sourceNode, sourcePort, targetNode] of [['input', 'out', 'worker'], ['worker', 'out', 'output'], ['output', 'learning', 'compare'], ['compare', 'out', 'improve']]) {
    document = connectNodes(document, { sourceNode, sourcePort, targetNode, targetPort: 'in' });
  }
  return document;
}
async function until(read, done, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (done(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw Error('Learning fixture did not reach the expected state');
}
async function fixture(t, document = graph()) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-learning-scope-http-')), adapter = new Offline();
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), port: 0 };
  const app = new Application(config, adapter); await app.workflowFoldersReady;
  app.captureModelRoute = async () => ({ provider: 'fixture', model: 'fixture' });
  app.workflowLibrary.save({ document, expectedRevision: 0 });
  const prompts = [], options = [], scopes = new Set(), releases = [], responses = [];
  app.learning.model = {
    async createMemoryScope({ id }) { scopes.add(id); return { id, mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false,
      snapshot: { version: 1, scopeId: id, digest: 'sha256:' + createHash('sha256').update(id).digest('hex') } }; },
    async releaseMemoryScope(id) { releases.push(id); scopes.delete(id); },
    async generate(prompt, settings) { assert(scopes.has(settings.memoryScopeId)); prompts.push(prompt); options.push(settings);
      assert(responses.length, 'No fixture optimization response queued'); const next = responses.shift(); return JSON.stringify(typeof next === 'function' ? await next(prompt, settings) : next); },
  };
  const bridge = createWorkbenchServer(config, app), origin = await bridge.listen();
  const { csrfToken } = await (await fetch(origin + '/api/bootstrap')).json();
  const api = async (path, body) => { const response = await fetch(origin + path, body === undefined ? {} : { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Workbench-Token': csrfToken }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  t.after(async () => { await bridge.close(); assert.deepEqual(adapter.calls, []); await rm(directory, { recursive: true, force: true }); });
  const payload = { document, scope: document.nodes.find(n => n.id === 'improve').config.scope, maxRounds: 2, targetScore: 100,
    rubric: '去除首尾空白并将文本转为小写，通用于不同文本。',
    trainingCases: [{ id: 'train', input: '  HELLO WORLD  ', expected: 'hello world' }],
    validationCases: [{ id: 'validation', input: '  VALIDATION_ONLY_QAZ  ', expected: 'validation_only_qaz' }] };
  const finish = id => until(async () => (await api('/api/workflow-learning/' + id)).body, job => terminal.has(job.status));
  return { app, document, api, prompts, options, scopes, releases, responses, payload, finish };
}
const improveTool = () => ({ operations: [{ op: 'update-node', nodeId: 'worker', config: { executionMode: 'code', language: 'javascript', code: normalizedCode } }], summary: '用通用文本规范化逻辑替换业务代码。' });

test('tools learning runs actual code workers, keeps validation out of optimization and applies a verified business candidate', async t => {
  const f = await fixture(t); f.responses.push(improveTool());
  const started = await f.api('/api/workflow-learning', f.payload); assert.equal(started.status, 202, JSON.stringify(started.body));
  const job = await f.finish(started.body.id); assert.equal(job.status, 'complete', job.error); assert.equal(job.bestRound, 1);
  assert.equal(job.config.scope, 'tools'); assert.deepEqual(job.rounds.map(round => round.cases.map(item => item.score)), [[0, 0], [100, 100]]);
  assert.equal(job.rounds[1].document.nodes.find(n => n.id === 'worker').config.code, normalizedCode);
  assert.equal(f.prompts.length, 1); assert.equal(f.prompts[0].includes('VALIDATION_ONLY_QAZ'), false); assert.equal(f.prompts[0].includes('validation_only_qaz'), false);
  assert(f.options.every(value => value.memoryScopeId === job.id)); assert(f.releases.includes(job.id));
  assert.equal((await f.api('/api/workflow-learning/' + job.id + '/apply', { scope: 'workflow' })).status, 400);
  const applied = await f.api('/api/workflow-learning/' + job.id + '/apply', {}); assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.scope, 'tools'); assert.equal(applied.body.document.mode, 'execute');
  assert.deepEqual(f.app.workflowLibrary.get(f.document.id).document, f.document, 'apply returns a draft and leaves the original workflow untouched');
  const run = await f.api('/api/workflow-runs', { document: applied.body.document, input: '  ANOTHER EXAMPLE  ' }); assert.equal(run.status, 202);
  const complete = await until(() => f.app.workflows.get(run.body.id), value => terminal.has(value.status));
  assert.equal(complete.status, 'complete', complete.error); assert.equal(complete.output, 'another example');
});

test('whole-workflow learning can replace an internal node and its edges while preserving the evaluation boundary', async t => {
  const f = await fixture(t, graph('workflow'));
  const inputEdge = f.document.edges.find(e => e.targetNode === 'worker'), outputEdge = f.document.edges.find(e => e.sourceNode === 'worker');
  f.responses.push({ summary: '用一个规范化节点替换旧处理步骤并重连业务路径。', operations: [
    { op: 'add-node', ref: 'normalize', type: 'transform', config: { language: 'javascript', code: normalizedCode, inputType: 'text', outputType: 'text' } },
    { op: 'remove-edge', edgeId: inputEdge.id }, { op: 'remove-edge', edgeId: outputEdge.id },
    { op: 'connect', sourceNode: 'input', sourcePort: 'out', targetNode: 'normalize', targetPort: 'in' },
    { op: 'connect', sourceNode: 'normalize', sourcePort: 'out', targetNode: 'output', targetPort: 'in' }, { op: 'remove-node', nodeId: 'worker' },
  ] });
  const started = await f.api('/api/workflow-learning', f.payload); assert.equal(started.status, 202, JSON.stringify(started.body));
  const job = await f.finish(started.body.id); assert.equal(job.status, 'complete', job.error); assert.equal(job.bestRound, 1);
  assert.equal(job.bestDocument.nodes.some(n => n.id === 'worker'), false); assert(job.bestDocument.nodes.some(n => n.type === 'transform'));
  assert.deepEqual(job.bestDocument.nodes.find(n => n.id === 'compare'), f.document.nodes.find(n => n.id === 'compare'));
  assert.equal(job.rounds[1].metrics.validation.passRate, 1);
  assert.equal((await f.api('/api/workflow-learning/' + job.id + '/apply', {})).status, 200);
  assert.deepEqual(f.app.workflowLibrary.get(f.document.id).document, f.document);
});

test('later workflow rounds optimize the new best topology instead of retaining deleted target identities', async t => {
  const f = await fixture(t, graph('workflow')); f.payload.maxRounds = 3;
  const inputEdge = f.document.edges.find(e => e.targetNode === 'worker'), outputEdge = f.document.edges.find(e => e.sourceNode === 'worker');
  f.responses.push({ summary: '替换规范化步骤，当前只处理字母与空格。', operations: [
    { op: 'add-node', ref: 'normalize', type: 'transform', config: { language: 'javascript',
      code: 'return /^[A-Z ]+$/.test(input.trim()) ? input.trim().toLowerCase() : input;', inputType: 'text', outputType: 'text' } },
    { op: 'remove-edge', edgeId: inputEdge.id }, { op: 'remove-edge', edgeId: outputEdge.id },
    { op: 'connect', sourceNode: 'input', sourcePort: 'out', targetNode: 'normalize', targetPort: 'in' },
    { op: 'connect', sourceNode: 'normalize', sourcePort: 'out', targetNode: 'output', targetPort: 'in' }, { op: 'remove-node', nodeId: 'worker' },
  ] }, prompt => {
    const source = JSON.parse(prompt.split('OPTIMIZER_SOURCE_JSON=')[1]), node = source.baseDocument.nodes.find(item => item.type === 'transform');
    assert(node); assert(source.trainableNodeIds.includes(node.id)); assert.equal(source.trainableNodeIds.includes('worker'), false);
    return { summary: '将已有最佳步骤推广到全部文本。', operations: [{ op: 'update-node', nodeId: node.id, config: { code: normalizedCode } }] };
  });
  const started = await f.api('/api/workflow-learning', f.payload), job = await f.finish(started.body.id);
  assert.equal(job.status, 'complete', job.error); assert.equal(job.bestRound, 2); assert.equal(f.prompts.length, 2);
  assert.deepEqual(job.rounds.map(round => round.metrics.overall.passRate), [0, 0.5, 1]);
  assert.equal(job.bestDocument.nodes.some(node => node.id === 'worker'), false);
});

test('a selected code exception is recorded as a failed baseline and can be repaired, never as a successful result', async t => {
  const f = await fixture(t, graph('tools', "throw new Error('bad parser');")); f.responses.push(improveTool());
  const started = await f.api('/api/workflow-learning', f.payload), job = await f.finish(started.body.id);
  assert.equal(job.status, 'complete', job.error); assert.equal(job.rounds[0].status, 'error'); assert.equal(job.bestRound, 1);
  assert(job.rounds[0].cases.every(item => item.status === 'error' && item.recoverable === true && item.score === 0));
  assert.match(f.prompts[0], /bad parser/); assert(job.rounds[1].cases.every(item => item.status === 'complete' && item.score === 100));
});

test('a real missing dependency terminates learning without asking the optimizer to repair the environment', async t => {
  const f = await fixture(t, graph('tools', "await import('missing-nodeorchard-learning-fixture-package'); return input;"));
  const started = await f.api('/api/workflow-learning', f.payload), job = await f.finish(started.body.id);
  assert.equal(job.status, 'error'); assert.equal(job.rounds.length, 1); assert.equal(f.prompts.length, 0);
  const run = f.app.workflows.get(job.rounds[0].cases[0].runId);
  assert.equal(run.status, 'error'); assert.equal(run.nodes.worker.errorCode, 'CODE_ENVIRONMENT'); assert.notEqual(run.nodes.worker.learningRecoverable, true);
  assert.equal(job.rounds[0].cases[1].status, 'pending'); assert.equal(job.bestRound, null);
});

test('a selected transform can learn from its directly connected result without requiring a Skill', async t => {
  let document = graph();
  document.nodes = document.nodes.map(node => node.id === 'worker' ? createNode('transform', {}, { id: 'worker', config: {
    inputType: 'text', outputType: 'text', language: 'javascript', code: 'return input;' } }) : node);
  document.edges = document.edges.filter(edge => edge.targetNode !== 'compare');
  document = connectNodes(document, { sourceNode: 'worker', sourcePort: 'out', targetNode: 'compare', targetPort: 'in' });
  const f = await fixture(t, document); f.responses.push({ summary: '规范化数据整理代码。', operations: [{ op: 'update-node', nodeId: 'worker', config: { code: normalizedCode } }] });
  const started = await f.api('/api/workflow-learning', f.payload); assert.equal(started.status, 202, JSON.stringify(started.body));
  const job = await f.finish(started.body.id); assert.equal(job.status, 'complete', job.error); assert.equal(job.bestRound, 1);
  assert.equal(job.config.comparisonSource.nodeId, 'worker'); assert.equal(job.rounds[1].metrics.validation.passRate, 1);
});

test('scope widening, disabled code permissions and edits to a protected input are rejected without unauthorized runs', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/workflow-learning', { ...f.payload, scope: 'workflow' })).status, 400);
  const current = f.app.assistantPermissionSettings.get();
  f.app.assistantPermissionSettings.save({ expectedRevision: current.revision, supervisor: current.supervisor, workflow: { ...current.workflow, customNodes: false } });
  assert.equal((await f.api('/api/workflow-learning', f.payload)).status, 403); assert.equal(f.app.workflows.list().length, 0); assert.equal(f.prompts.length, 0);
});

test('a protected input rewrite never executes a candidate or changes the original document', async t => {
  const f = await fixture(t); f.responses.push({ summary: 'invalid', operations: [{ op: 'update-node', nodeId: 'input', config: { defaultValue: 'hello world' } }] });
  const started = await f.api('/api/workflow-learning', f.payload), job = await f.finish(started.body.id);
  assert.equal(job.status, 'error'); assert.equal(job.rounds.length, 1); assert.equal(f.app.workflows.list().length, 2);
  assert.deepEqual(f.app.workflowLibrary.get(f.document.id).document, f.document);
});

test('applying a verified tool candidate refuses a changed saved workflow', async t => {
  const f = await fixture(t); f.responses.push(improveTool());
  const started = await f.api('/api/workflow-learning', f.payload), job = await f.finish(started.body.id); assert.equal(job.status, 'complete', job.error);
  const record = f.app.workflowLibrary.get(f.document.id);
  f.app.workflowLibrary.save({ document: { ...f.document, title: '用户后续编辑' }, expectedRevision: record.revision });
  const applied = await f.api('/api/workflow-learning/' + job.id + '/apply', {}); assert.equal(applied.status, 409); assert.match(applied.body.error, /草稿已变化/);
});

test('stopping tool optimization aborts the model and ignores its late candidate', async t => {
  const f = await fixture(t); let release, signal;
  f.responses.push((_prompt, options) => { signal = options.signal; return new Promise(resolve => { release = () => resolve(improveTool()); }); });
  const started = await f.api('/api/workflow-learning', f.payload);
  await until(() => Promise.resolve(release), Boolean);
  await f.api('/api/workflow-learning/' + started.body.id + '/interrupt', {}); assert.equal(signal.aborted, true); release();
  const stopped = await f.finish(started.body.id); assert.equal(stopped.status, 'interrupted'); assert.equal(stopped.rounds.length, 1);
  assert.equal(f.app.workflows.list().length, 2); assert.deepEqual(f.app.workflowLibrary.get(f.document.id).document, f.document);
});
