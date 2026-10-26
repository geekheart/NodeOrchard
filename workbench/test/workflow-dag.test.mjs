import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDocument, createNode, connectNodes, validateDocument, getPorts } from '../shared/workflow/workflow-model.mjs';
import { planWorkflow } from '../shared/workflow/workflow-plan.mjs';
import { WorkflowRuns } from '../src/workflows/workflow-runs.mjs';
import { WorkflowFiles } from '../src/workflows/workflow-files.mjs';
import { WorkflowLearning } from '../src/workflows/workflow-learning.mjs';
import { createHash } from 'node:crypto';

const wire = (doc, from, to, targetPort = 'in', sourcePort = 'out') => connectNodes(doc, { sourceNode: from, sourcePort, targetNode: to, targetPort });
const node = (type, id, config = {}, ports) => createNode(type, { x: 0, y: 0 }, { id, config: { ...(type === 'input' ? { outputType: 'object' } : ['transform', 'tool', 'human', 'subflow'].includes(type) ? { inputType: 'object', outputType: 'object' } : {}), ...config }, ...(ports ? { ports } : {}) });
const code = (id, extra = {}) => node('tool', id, { executionMode: 'code', language: 'javascript', code: 'return input;', ...extra });
function graph(nodes, edges, settings = {}) { let doc = { ...createDocument({ title: 'DAG test', schemaVersion: 2, settings }), nodes }; for (const edge of edges) doc = wire(doc, ...edge); return doc; }
function split(extra = {}) { return graph([node('input', 'input'), code('left', extra), code('right', extra), node('merge', 'merge', {}, { inputs: [{ id: 'left', label: 'left', type: 'object', required: true }, { id: 'right', label: 'right', type: 'object', required: true }], outputs: [{ id: 'out', label: 'result', type: 'object' }] }), node('output', 'output')], [['input', 'left'], ['input', 'right'], ['left', 'merge', 'left'], ['right', 'merge', 'right'], ['merge', 'output']]); }
async function until(check, timeout = 3000) { const start = Date.now(); while (Date.now() - start < timeout) { const result = await check(); if (result) return result; await delay(5); } throw new Error('Timed out waiting for workflow state'); }
async function setup(t, executeOperation, { files = false, managed = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-dag-'));
  const db = new DatabaseSync(join(directory, 'data.sqlite'));
  const app = new EventEmitter(); app.store = { db }; app.config = { workspaceRoot: directory, appRoot: directory, dataDir: directory }; app.preferences = {};
  if (managed) app.config.workflowRunRoot = join(directory, 'managed-runs');
  app.publish = (type, sessionId, payload) => app.emit('event', { type, sessionId, payload });
  if (files) app.workflowFiles = new WorkflowFiles(app, { allowedRoots: [directory] });
  const manager = new WorkflowRuns(app, executeOperation ? { executeOperation } : {}); app.workflows = manager;
  t.after(async () => { await app.workflows.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, db, app, manager };
}

test('v2 named ports round-trip, select output fields, and preserve v1 strict data model', () => {
  const doc = split(); assert.equal(validateDocument(doc).schemaVersion, 2); assert.equal(planWorkflow(doc).nodeOrder.length, 5);
  assert.equal(getPorts(doc.nodes.find(node => node.id === 'merge')).inputs.length, 2);
  assert.throws(() => validateDocument({ ...doc, schemaVersion: 1 }), /未知字段/);
  assert.throws(() => planWorkflow(graph([node('input', 'input'), node('output', 'output')], [], {})), /缺少必填/);
});

test('image review requirements reject a direct or merge-based bypass before any operation', () => {
  const direct = graph([node('input', 'input'), code('image', { reviewImages: true }), node('output', 'output')], [['input', 'image'], ['image', 'output']]);
  assert.throws(() => planWorkflow(direct), /人工审核/);
  const safe = graph([node('input', 'input'), code('image', { reviewImages: true }), node('human', 'review'), node('output', 'output')], [['input', 'image'], ['image', 'review'], ['review', 'output']]);
  assert.doesNotThrow(() => planWorkflow(safe));
  const bypass = graph([...safe.nodes, code('bypass')], [['input', 'image'], ['image', 'review'], ['review', 'output'], ['image', 'bypass']]);
  assert.throws(() => planWorkflow(bypass), /人工审核/);
  const registered = code('image', { executionMode: 'tool', toolName: 'hdk.four.pinout-front', reviewImages: false });
  assert.throws(() => planWorkflow(graph([node('input', 'input'), registered, node('output', 'output')], [['input', 'image'], ['image', 'output']])), /人工审核/);
});

test('independent branches overlap and a join waits for both exact values', async t => {
  const started = []; const gates = {};
  const { manager } = await setup(t, async ({ node, input }) => { started.push(node.id); await new Promise(resolve => { gates[node.id] = resolve; }); return { output: { node: node.id, value: input.value } }; });
  const run = await manager.start({ document: split(), input: { value: 7 } });
  await until(() => started.length === 2); assert.deepEqual(new Set(started), new Set(['left', 'right']));
  assert.equal(manager.get(run.id).nodes.merge.status, 'pending'); gates.right(); await until(() => manager.get(run.id).nodes.right.status === 'complete');
  assert.notEqual(manager.get(run.id).nodes.merge.status, 'complete'); gates.left();
  const final = await until(() => manager.get(run.id).status === 'complete' && manager.get(run.id));
  assert.deepEqual(final.output, { left: { node: 'left', value: 7 }, right: { node: 'right', value: 7 } });
  assert.notEqual(final.nodes.left.attemptId, final.nodes.right.attemptId);
});

test('a failed branch blocks only its descendants and retains independent results', async t => {
  const { manager } = await setup(t, async ({ node }) => { if (node.id === 'left') throw new Error('left failed'); return { output: { okay: true } }; });
  const started = await manager.start({ document: split(), input: {} });
  const final = await until(() => manager.get(started.id).status === 'error' && manager.get(started.id));
  assert.equal(final.nodes.left.status, 'error'); assert.equal(final.nodes.right.status, 'complete'); assert.equal(final.nodes.merge.status, 'blocked'); assert.equal(final.nodes.output.status, 'blocked');
});

test('EDA resource serializes only EDA nodes while another resource progresses', async t => {
  let active = 0, peak = 0; const called = [];
  const { manager } = await setup(t, async ({ node }) => { called.push(node.id); active++; peak = Math.max(peak, active); await delay(20); active--; return { output: { id: node.id } }; });
  const run = await manager.start({ document: split({ resource: 'eda' }), input: {} });
  await until(() => manager.get(run.id).status === 'complete'); assert.equal(peak, 1); assert.equal(called.length, 2);
});

test('multiple tasks of the same workflow run with a durable excess queue', async t => {
  const gates = []; const { manager } = await setup(t, async () => { await new Promise(resolve => gates.push(resolve)); return { output: {} }; });
  const doc = graph([node('input', 'input'), code('task'), node('output', 'output')], [['input', 'task'], ['task', 'output']]);
  const runs = []; for (let index = 0; index < 3; index++) runs.push(await manager.start({ document: doc, input: { index } }));
  await until(() => gates.length === 2); assert.equal(manager.get(runs[2].id).status, 'queued'); assert.equal(manager.get(runs[2].id).queuePosition, 1);
  gates[0](); await until(() => gates.length === 3); assert.notEqual(manager.get(runs[2].id).status, 'queued'); gates[1](); gates[2]();
  await until(() => runs.every(run => manager.get(run.id).status === 'complete'));
});

test('a restored Skill queue waits for model inventory after the adapter first announces ready', async t => {
  const { manager, app } = await setup(t, async ({ input }) => ({ output: input }));
  const version = 'sha256:' + 'a'.repeat(64), histories = new Map(); let sessions = 0, checks = 0;
  app.backend = { state: 'disconnected', model: '' };
  app.checkReady = () => { checks++; if (app.backend.state !== 'ready' || !app.backend.model) throw Error('Subscription model is not ready'); };
  app.skill = async name => ({ name, content: 'Return the input.', revision: version, source: 'local' });
  app.createSession = async () => { app.checkReady(); return { id: 'inventory-session-' + (++sessions) }; };
  app.submit = async (id, text) => { histories.set(id, [{ role: 'assistant', text: JSON.stringify({ complete: true }) }]); queueMicrotask(() => app.publish('message.complete', id, { status: 'complete' })); };
  app.history = async id => ({ messages: histories.get(id) }); app.interrupt = async () => ({});
  const prepare = async (_app, _session, detail) => ({ skill: detail, text: '{}', cleanup: async () => {} });
  manager.prepareSkill = prepare;
  const doc = graph([node('input', 'input'), code('facts'), node('skill', 'skill', { inputType: 'object', outputType: 'object', skillRef: 'fixture', version }), node('output', 'output')], [['input', 'facts'], ['facts', 'skill'], ['skill', 'output']]);
  const run = await manager.start({ document: doc, input: {} }); assert.equal(manager.get(run.id).status, 'queued');
  await manager.close(); const next = new WorkflowRuns(app, { executeOperation: async ({ input }) => ({ output: input }) }); app.workflows = next; next.prepareSkill = prepare;
  let finishInventory;
  const inventory = new Promise(resolve => { finishInventory = resolve; });
  const connect = (async () => {
    app.backend.state = 'ready'; app.publish('backend.status', null, { ...app.backend });
    await inventory;
    app.backend.model = 'gpt-subscription-model'; app.publish('backend.status', null, { ...app.backend });
  })();
  await delay(15);
  assert.equal(next.get(run.id).status, 'queued'); assert.equal(next.get(run.id).nodes.facts.attempt, 0); assert.equal(next.get(run.id).nodes.skill.attempt, 0); assert.equal(sessions, 0);
  assert.match(next.get(run.id).queueReason, /模型准备/); assert(checks >= 2);
  finishInventory(); await connect;
  const result = await until(() => ['complete', 'error'].includes(next.get(run.id).status) && next.get(run.id));
  assert.equal(result.status, 'complete', result.error); assert.equal(sessions, 1); assert.equal(result.nodes.facts.attempt, 1); assert.equal(result.nodes.skill.attempt, 1);
});

test('human waiting releases admission slots for additional tasks', async t => {
  const { manager } = await setup(t, async () => ({ output: {} }));
  const doc = graph([node('input', 'input'), code('produce'), node('human', 'review'), node('output', 'output')], [['input', 'produce'], ['produce', 'review'], ['review', 'output']]);
  const ids = [];
  for (let index = 0; index < 3; index++) ids.push((await manager.start({ document: doc, input: { index } })).id);
  await until(() => ids.every(id => manager.get(id).status === 'waiting_review'));
  assert.equal(manager.queueStatus().queued.length, 0);
});

test('an output is an intermediate saved value, not a termination signal', async t => {
  const { manager } = await setup(t, async ({ input }) => ({ output: { ...input, later: true } }));
  const doc = graph([node('input', 'input'), node('output', 'preview'), code('later'), node('output', 'final')], [['input', 'preview'], ['preview', 'later'], ['later', 'final']]);
  const run = await manager.start({ document: doc, input: { first: 1 } });
  const final = await until(() => manager.get(run.id).status === 'complete' && manager.get(run.id));
  assert.deepEqual(final.outputs.preview, { first: 1 }); assert.deepEqual(final.outputs.final, { first: 1, later: true });
  assert.deepEqual(JSON.parse(await readFile(final.nodes.preview.savedPath, 'utf8')), { first: 1 });
  const invalid = { ...doc, nodes: doc.nodes.map(node => node.id === 'preview' ? { ...node, config: { ...node.config, fileName: '../overwritten.json' } } : node) };
  assert.throws(() => planWorkflow(invalid), /不能包含目录/);
});

test('completion focuses the final delivery when a stage output was appended later', async t => {
  const { manager } = await setup(t, async ({ input }) => ({ output: { ...input, delivery: true } }));
  const doc = graph([
    node('input', 'input'), code('deliver'), node('output', 'final', { stage: 'final' }),
    node('output', 'preview', { stage: 'intermediate' }),
  ], [['input', 'deliver'], ['deliver', 'final'], ['input', 'preview']]);
  const run = await manager.start({ document: doc, input: { first: 1 } });
  const completed = await until(() => manager.get(run.id).status === 'complete' && manager.get(run.id));
  assert.equal(completed.currentNodeId, 'final');
  assert.deepEqual(completed.output, { first: 1, delivery: true });
  assert.deepEqual(completed.stageOutputs, { preview: { first: 1 } });
  assert.deepEqual(JSON.parse(await readFile(completed.nodes.preview.savedPath, 'utf8')), { first: 1 });
});

test('a Skill uses an isolated workspace session and stages explicit files into a selected external output root', async t => {
  const { app, manager, directory } = await setup(t, undefined, { files: true });
  const workspace = join(directory, 'workspace'); await mkdir(workspace); app.config.workspaceRoot = workspace;
  const outputRoot = join(directory, 'deliveries'); const version = 'sha256:' + 'a'.repeat(64); const histories = new Map(); let sessionDirectory;
  app.skill = async name => ({ name, revision: version, source: 'local', content: 'fixture' });
  app.createSession = async options => { assert(options.cwd.startsWith(workspace + '/')); sessionDirectory = options.cwd; return { id: 'session-external' }; };
  app.submit = async (id, prompt) => {
    assert(prompt.includes('Controller artifact locations:')); const path = join(sessionDirectory, 'generated.txt'); await writeFile(path, 'actual Skill file');
    histories.set(id, [{ role: 'assistant', text: JSON.stringify({ path }) }]); queueMicrotask(() => app.publish('message.complete', id, { status: 'complete' }));
  };
  app.history = async id => ({ messages: histories.get(id) }); app.interrupt = async () => ({});
  manager.prepareSkill = async (_app, _session, detail) => ({ skill: detail, text: 'skill', cleanup: async () => {} });
  const doc = graph([node('input', 'input'), node('skill', 'skill', { inputType: 'object', outputType: 'object', skillRef: 'fixture', version }), node('output', 'output', { fileName: 'saved.json' })], [['input', 'skill'], ['skill', 'output']]);
  const run = await manager.start({ document: doc, input: {}, outputDirectory: outputRoot });
  const final = await until(() => ['complete', 'error'].includes(manager.get(run.id).status) && manager.get(run.id)); assert.equal(final.status, 'complete', final.error);
  assert(final.output.path.startsWith((await realpath(outputRoot)) + '/')); assert.equal(await readFile(final.output.path, 'utf8'), 'actual Skill file');
  assert.equal(final.nodes.skill.artifacts[0].sha256, createHash('sha256').update('actual Skill file').digest('hex'));
  assert.equal(final.nodes.output.artifacts.some(artifact => artifact.name === 'saved.json'), true);
});

test('human review is durable, performs no model work while waiting, and resumes after restart', async t => {
  let calls = 0; const executor = async () => { calls++; return { output: { image: 'candidate' } }; };
  const { app, manager } = await setup(t, executor);
  const doc = graph([node('input', 'input'), code('produce'), node('human', 'review', { reviewTargetNodeId: 'produce' }), node('output', 'output')], [['input', 'produce'], ['produce', 'review'], ['review', 'output']]);
  const run = await manager.start({ document: doc, input: {} }); await until(() => manager.get(run.id).status === 'waiting_review'); assert.equal(calls, 1);
  await manager.close(); const replacement = new WorkflowRuns(app, { executeOperation: executor }); app.workflows = replacement;
  assert.equal(replacement.get(run.id).status, 'waiting_review'); assert.equal(calls, 1);
  await replacement.approve(run.id, { nodeId: 'review', action: 'approve' });
  await until(() => replacement.get(run.id).status === 'complete'); assert.equal(calls, 1); assert.equal(replacement.get(run.id).nodes.review.review.decision, 'approved');
});

test('delivery deletion cannot invalidate canonical artifacts or approved versions, including after restart', async t => {
  let calls = 0;
  const executor = async ({ cwd }) => {
    calls++;
    const path = join(cwd, 'interface_back.oim.json'); await writeFile(path, '{"actual":"export"}');
    return { output: { path }, artifacts: [{ path }] };
  };
  const { app, manager, directory } = await setup(t, executor, { files: true, managed: true });
  const deliveryRoot = join(directory, 'user-deliveries');
  const doc = graph([node('input', 'input'), code('produce'), node('human', 'review'), node('output', 'output')], [['input', 'produce'], ['produce', 'review'], ['review', 'output']]);
  const started = await manager.start({ document: doc, input: {}, outputDirectory: deliveryRoot });
  await until(() => manager.get(started.id).status === 'waiting_review');
  await manager.approve(started.id, { nodeId: 'review', action: 'approve' });
  const final = await until(() => manager.get(started.id).status === 'complete' && manager.get(started.id));
  assert.equal(final.storageVersion, 2); assert.equal(final.delivery.status, 'complete');
  assert(final.outputDirectory.startsWith(await realpath(app.config.workflowRunRoot)));
  assert(final.delivery.directory.startsWith(await realpath(deliveryRoot)));
  const original = final.nodes.produce.artifacts[0];
  const reviewed = structuredClone(final.nodes.review.review);
  assert.equal(await readFile(join(final.delivery.directory, 'produce', '版本-1', 'interface_back.oim.json'), 'utf8'), '{"actual":"export"}');
  await rm(final.delivery.directory, { recursive: true });
  assert.equal((await app.workflowFiles.readArtifact(original.id)).data.toString(), '{"actual":"export"}');
  await manager.close();
  app.workflows = new WorkflowRuns(app, { executeOperation: executor });
  assert.equal((await app.workflowFiles.verifyArtifacts([original])).ok, true);
  const published = await app.workflows.publishDelivery(started.id);
  assert.equal(published.delivery.status, 'complete'); assert.equal(calls, 1);
  assert.deepEqual(published.nodes.review.review, reviewed);
  assert.equal(await readFile(join(published.delivery.directory, 'produce', '版本-1', 'interface_back.oim.json'), 'utf8'), '{"actual":"export"}');
});

test('delivery conflicts fail visibly and retry only publication without repeating nodes or review', async t => {
  let calls = 0;
  const { manager, app, directory } = await setup(t, async ({ cwd }) => {
    calls++; const path = join(cwd, 'result.txt'); await writeFile(path, 'canonical result');
    return { output: { path }, artifacts: [{ path }] };
  }, { files: true, managed: true });
  const doc = graph([node('input', 'input'), code('produce'), node('human', 'review'), node('output', 'output')], [['input', 'produce'], ['produce', 'review'], ['review', 'output']]);
  const run = await manager.start({ document: doc, input: {}, outputDirectory: join(directory, 'cloud') });
  await until(() => manager.get(run.id).status === 'waiting_review');
  const frozen = manager.get(run.id); await mkdir(frozen.deliveryDirectory, { recursive: true });
  await writeFile(join(frozen.deliveryDirectory, 'keep.txt'), 'user file');
  await assert.rejects(manager.publishDelivery(run.id), /仍在执行/);
  await manager.approve(run.id, { nodeId: 'review', action: 'approve' });
  const failed = await until(() => manager.get(run.id).status === 'error' && manager.get(run.id));
  assert.equal(failed.delivery.status, 'error'); assert.match(failed.error, /交付副本失败/);
  assert(Object.values(failed.nodes).every(record => record.status === 'complete'));
  assert.equal(await readFile(join(frozen.deliveryDirectory, 'keep.txt'), 'utf8'), 'user file');
  assert.equal((await app.workflowFiles.verifyArtifacts(failed.nodes.produce.artifacts)).ok, true);
  const retried = await manager.publishDelivery(run.id);
  assert.equal(retried.status, 'complete'); assert.equal(retried.delivery.status, 'complete'); assert.equal(calls, 1);
  assert.notEqual(retried.delivery.directory, frozen.deliveryDirectory);
  assert.deepEqual(retried.nodes.review.review, failed.nodes.review.review);
});

test('conversation review rejects old attempts and changed artifacts after asynchronous verification', async t => {
  const { manager, app } = await setup(t, async () => ({ output: {} }));
  const doc = graph([node('input', 'input'), code('produce'), node('human', 'review'), node('output', 'output')], [['input', 'produce'], ['produce', 'review'], ['review', 'output']]);
  const run = await manager.start({ document: doc, input: {} });
  await until(() => manager.get(run.id).status === 'waiting_review');
  const review = manager.get(run.id).nodes.review;
  const request = { nodeId: 'review', action: 'approve', expectedAttempt: review.attempt, expectedAttemptId: review.attemptId, expectedArtifactHashes: [] };
  await assert.rejects(manager.approve(run.id, { ...request, expectedAttemptId: 'older-attempt' }), /尝试已变化/);
  let release;
  app.workflowFiles = { verifyArtifacts: () => new Promise(resolve => { release = resolve; }) };
  const approving = manager.approve(run.id, request); await until(() => release);
  manager.dag.active.get(run.id).run.nodes.review.artifacts = [{ id: 'new-artifact', sha256: 'a'.repeat(64) }];
  release({ ok: true }); await assert.rejects(approving, /产物版本已变化/);
  assert.equal(manager.get(run.id).nodes.review.status, 'waiting_review');
  assert.equal(manager.get(run.id).nodes.output.status, 'pending');
});

test('conversation rerun rejects stale node snapshots before repeating work', async t => {
  let calls = 0; const { manager } = await setup(t, async () => { calls++; return { output: {} }; });
  const doc = graph([node('input', 'input'), code('produce'), node('output', 'output')], [['input', 'produce'], ['produce', 'output']]);
  const run = await manager.start({ document: doc, input: {} }); await until(() => manager.get(run.id).status === 'complete');
  const record = manager.get(run.id).nodes.produce;
  await assert.rejects(manager.rerun(run.id, { nodeIds: ['produce'], expectedNodes: [{ nodeId: 'produce', attempt: record.attempt, attemptId: 'older-attempt', artifactHashes: [] }] }), /尝试已变化/);
  assert.equal(calls, 1); assert.equal(manager.get(run.id).status, 'complete');
});

test('explicit redo requirements reach the selected tool producer without changing its code', async t => {
  const requests = []; const { manager } = await setup(t, async ({ node, context }) => { requests.push(context.reviewFeedback); return { output: { code: node.config.code } }; });
  const doc = graph([node('input', 'input'), code('produce'), node('output', 'output')], [['input', 'produce'], ['produce', 'output']]);
  const run = await manager.start({ document: doc, input: {} }); await until(() => manager.get(run.id).status === 'complete');
  const record = manager.get(run.id).nodes.produce;
  await manager.rerun(run.id, { nodeIds: ['produce'], feedback: '请调整这一次图像的标注', expectedNodes: [{ nodeId: 'produce', attempt: record.attempt, attemptId: record.attemptId, artifactHashes: [] }] });
  await until(() => manager.get(run.id).status === 'complete');
  assert.deepEqual(requests, ['', '请调整这一次图像的标注']);
  assert.equal(manager.get(run.id).document.nodes.find(item => item.id === 'produce').config.code, 'return input;');
  assert.equal(manager.get(run.id).nodes.produce.history.length, 1);
});

test('double review submissions are serialized and a stop invalidates an in-flight approval', async t => {
  const { manager, app } = await setup(t, async () => ({ output: {} }));
  const doc = graph([node('input', 'input'), code('produce'), node('human', 'review'), node('output', 'output')], [['input', 'produce'], ['produce', 'review'], ['review', 'output']]);
  const run = await manager.start({ document: doc, input: {} }); await until(() => manager.get(run.id).status === 'waiting_review');
  let release; app.workflowFiles = { verifyArtifacts: async () => { await new Promise(resolve => { release = resolve; }); return { ok: true }; } };
  const first = manager.approve(run.id, { nodeId: 'review', action: 'approve' }); await until(() => release);
  await assert.rejects(manager.approve(run.id, { nodeId: 'review', action: 'approve' }), /正在处理/);
  await manager.interrupt(run.id); release(); await assert.rejects(first, /候选已变化|已停止/); assert.equal(manager.get(run.id).status, 'interrupted');
});

test('explicit review revision reruns once with feedback and preserves fixed skill/config and old attempts', async t => {
  const feedback = []; const { manager } = await setup(t, async ({ context }) => { feedback.push(context.reviewFeedback); return { output: { attempt: context.attempt } }; });
  const doc = graph([node('input', 'input'), code('produce'), node('human', 'review', { reviewTargetNodeId: 'produce', maxRevisions: 1 }), node('output', 'output')], [['input', 'produce'], ['produce', 'review'], ['review', 'output']]);
  const run = await manager.start({ document: doc, input: {} }); await until(() => manager.get(run.id).status === 'waiting_review');
  await manager.approve(run.id, { nodeId: 'review', action: 'revise', feedback: 'Move label left' }); await until(() => manager.get(run.id).status === 'waiting_review');
  assert.deepEqual(feedback, ['', 'Move label left']); assert.equal(manager.get(run.id).nodes.produce.history.length, 1);
  await assert.rejects(manager.approve(run.id, { nodeId: 'review', action: 'revise', feedback: 'again' }), /次数上限/);
  await manager.approve(run.id, { nodeId: 'review', action: 'approve' }); await until(() => manager.get(run.id).status === 'complete');
});

test('partial rerun reuses completed upstream and invalidates only descendants', async t => {
  const counts = {}; const { manager } = await setup(t, async ({ node }) => { counts[node.id] = (counts[node.id] || 0) + 1; return { output: { attempt: counts[node.id] } }; });
  const run = await manager.start({ document: split(), input: {} }); await until(() => manager.get(run.id).status === 'complete');
  await manager.rerun(run.id, { nodeIds: ['left'] }); await until(() => manager.get(run.id).status === 'complete');
  assert.deepEqual(counts, { left: 2, right: 1 }); assert.equal(manager.get(run.id).nodes.left.attempt, 2); assert.equal(manager.get(run.id).nodes.right.attempt, 1);
});

test('partial rerun feedback reaches affected fixed Skills while unrelated branches are reused', async t => {
  const counts = {}, prompts = [], histories = new Map(); let session = 0;
  const { manager, app } = await setup(t, async ({ node, input }) => {
    counts[node.id] = (counts[node.id] || 0) + 1; return { output: { ...input, [node.id]: counts[node.id] } };
  });
  const content = 'Return the current facts as a bounded plan.', version = 'sha256:' + createHash('sha256').update(content).digest('hex');
  app.skill = async name => ({ name, content, revision: version, source: 'local' });
  app.createSession = async () => ({ id: 'rerun-session-' + (++session) });
  app.submit = async (id, text) => {
    prompts.push(text); histories.set(id, [{ role: 'assistant', text: JSON.stringify({ planned: true }) }]);
    queueMicrotask(() => app.publish('message.complete', id, { status: 'complete' }));
  };
  app.history = async id => ({ messages: histories.get(id) }); app.interrupt = async () => ({});
  manager.prepareSkill = async (_app, _session, detail, context) => ({ skill: detail, text: JSON.stringify(context.input), cleanup: async () => {} });
  const skill = node('skill', 'plan', { inputType: 'object', outputType: 'object', skillRef: 'fixture', version });
  const merge = node('merge', 'merge', {}, { inputs: ['front', 'back', 'native'].map(id => ({ id, label: id, type: 'object', required: true })), outputs: [{ id: 'out', label: 'out', type: 'object' }] });
  const doc = graph([node('input', 'input'), code('facts'), skill, code('front'), code('back'), code('native'), merge, node('human', 'review'), node('output', 'output')],
    [['input', 'facts'], ['facts', 'plan'], ['plan', 'front'], ['plan', 'back'], ['input', 'native'], ['front', 'merge', 'front'], ['back', 'merge', 'back'], ['native', 'merge', 'native'], ['merge', 'review'], ['review', 'output']]);
  const run = await manager.start({ document: doc, input: {} }); await until(() => manager.get(run.id).status === 'waiting_review');
  for (const feedback of [null, 4, 'x'.repeat(8001)]) await assert.rejects(manager.rerun(run.id, { nodeIds: ['facts'], feedback }), /8000/);
  assert.equal(manager.get(run.id).nodes.plan.attempt, 1);
  const feedback = 'Use the source-backed VO4 candidate; remove MAIN.';
  await manager.rerun(run.id, { nodeIds: ['facts'], feedback });
  await until(() => manager.get(run.id).status === 'waiting_review' && manager.get(run.id).nodes.plan.attempt === 2);
  assert(prompts[1].endsWith(feedback)); assert.equal(prompts[0].includes(feedback), false);
  assert.deepEqual(counts, { facts: 2, native: 1, front: 2, back: 2 });
  let current = manager.get(run.id); assert.equal(current.nodes.native.attempt, 1); assert.equal(current.nodes.plan.reviewFeedback, feedback);
  assert.equal(current.frozenSkillDetails.plan.content, content); assert.equal(current.nodes.plan.skill.revision, version); assert.deepEqual(current.document, doc);
  await manager.rerun(run.id, { nodeIds: ['facts'] });
  await until(() => manager.get(run.id).status === 'waiting_review' && manager.get(run.id).nodes.plan.attempt === 3);
  assert(prompts[2].endsWith(feedback));
  await manager.rerun(run.id, { nodeIds: ['facts'], feedback: '' });
  await until(() => manager.get(run.id).status === 'waiting_review' && manager.get(run.id).nodes.plan.attempt === 4);
  current = manager.get(run.id); assert.equal(current.nodes.plan.reviewFeedback, ''); assert.equal(prompts[3].includes('Explicit human request'), false);
  assert.equal(current.nodes.native.attempt, 1); assert.equal(current.nodes.plan.history.length, 3);
});

for (const review of [true, false]) test(`a ${review ? 'waiting-review' : 'completed'} partial rerun rejoins the durable admission queue`, async t => {
  const gates = []; let produced = 0;
  const { manager } = await setup(t, async ({ node }) => {
    if (node.id === 'hold') await new Promise(resolve => gates.push(resolve)); else produced++;
    return { output: {} };
  });
  manager.dag.maxActiveRuns = 1;
  const doc = graph([node('input', 'input'), code('produce'), ...(review ? [node('human', 'review')] : []), node('output', 'output')],
    review ? [['input', 'produce'], ['produce', 'review'], ['review', 'output']] : [['input', 'produce'], ['produce', 'output']]);
  const run = await manager.start({ document: doc, input: {} });
  await until(() => manager.get(run.id).status === (review ? 'waiting_review' : 'complete')); assert.equal(produced, 1);
  const busy = graph([node('input', 'input'), code('hold'), node('output', 'output')], [['input', 'hold'], ['hold', 'output']]);
  const first = await manager.start({ document: busy, input: {} }); await until(() => gates.length === 1);
  const next = await manager.start({ document: busy, input: {} }); assert.equal(manager.get(next.id).status, 'queued');
  await manager.rerun(run.id, { nodeIds: ['produce'] });
  assert.equal(manager.get(run.id).status, 'queued'); assert.equal(manager.get(run.id).nodes.produce.attempt, 1); assert.equal(produced, 1);
  assert.deepEqual(manager.queueStatus().queued.map(item => item.id), [next.id, run.id]);
  gates[0](); await until(() => gates.length === 2); assert.equal(manager.get(run.id).status, 'queued'); assert.equal(produced, 1);
  gates[1](); await until(() => manager.get(run.id).nodes.produce.attempt === 2 && manager.get(run.id).status === (review ? 'waiting_review' : 'complete'));
  assert.equal(produced, 2); assert.equal(manager.get(first.id).status, 'complete'); assert.equal(manager.get(next.id).status, 'complete');
});

test('actual file preparation rejects missing input before an operation and exposes registered artifacts', async t => {
  const { manager, app, directory } = await setup(t, undefined, { files: true });
  const source = join(directory, 'source.txt'); await writeFile(source, 'source');
  const inputNode = node('input', 'input', { fields: [{ key: 'source', label: 'Source', kind: 'file', required: true, extensions: ['.txt'] }] });
  const produce = code('produce', { code: "const {writeFile}=await import('node:fs/promises'); const {join}=await import('node:path'); const path=join(context.outputDirectory,'result.txt'); await writeFile(path,'candidate'); return {path,reviewFeedback:context.reviewFeedback};" });
  const doc = graph([inputNode, produce, node('human', 'review', { reviewTargetNodeId: 'produce' }), node('output', 'output')], [['input', 'produce'], ['produce', 'review'], ['review', 'output']]);
  await assert.rejects(manager.start({ document: doc, input: { source: join(directory, 'missing.txt') } }), error => error.details?.[0]?.key === 'source');
  assert.equal(manager.list().length, 0);
  const run = await manager.start({ document: doc, input: { source }, outputDirectory: join(directory, 'deliveries') });
  await until(() => manager.get(run.id).status === 'waiting_review'); const reviewed = manager.get(run.id);
  assert.equal(reviewed.nodes.review.artifacts.length, 1); const artifact = reviewed.nodes.review.artifacts[0]; assert.match(artifact.previewUrl, /artifacts/);
  await writeFile(artifact.path, 'changed');
  await assert.rejects(manager.approve(run.id, { nodeId: 'review', action: 'approve' }), /产物发生变化/);
  assert.equal(manager.get(run.id).nodes.review.status, 'waiting_review');
});

test('a custom code node cannot forward a newly created image to expensive work without a review gate', async t => {
  const { manager } = await setup(t, undefined, { files: true });
  const draw = code('draw', { code: "const {writeFile}=await import('node:fs/promises');const path=context.outputDirectory+'/new.png';await writeFile(path,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=','base64'));return {path};" });
  const doc = graph([node('input', 'input'), draw, code('expensive'), node('output', 'output')], [['input', 'draw'], ['draw', 'expensive'], ['expensive', 'output']]);
  const run = await manager.start({ document: doc, input: {} });
  const failed = await until(() => manager.get(run.id).status === 'error' && manager.get(run.id)); assert.match(failed.nodes.draw.error, /人工审核/); assert.equal(failed.nodes.expensive.attempt, 0);
});

test('embedded subflow executes a fixed snapshot and returns real child output', async t => {
  const { manager } = await setup(t, async ({ input }) => ({ output: { ...input, child: true } }));
  const child = graph([node('input', 'child-input'), code('child-task'), node('output', 'child-output')], [['child-input', 'child-task'], ['child-task', 'child-output']]);
  const parent = graph([node('input', 'input'), node('subflow', 'subflow', { document: child }), node('output', 'output')], [['input', 'subflow'], ['subflow', 'output']]);
  const run = await manager.start({ document: parent, input: { hello: 'world' } });
  const result = await until(() => manager.get(run.id).status === 'complete' && manager.get(run.id)); assert.deepEqual(result.output, { hello: 'world', child: true });
});

test('a parent subflow reattaches a durable child review after restart without replaying production', async t => {
  let calls = 0; const execute = async ({ input }) => { calls++; return { output: { ...input, made: true } }; };
  const { manager, app } = await setup(t, execute);
  const child = graph([node('input', 'child-input'), code('child-task'), node('human', 'child-review'), node('output', 'child-output')], [['child-input', 'child-task'], ['child-task', 'child-review'], ['child-review', 'child-output']]);
  const parent = graph([node('input', 'input'), node('subflow', 'subflow', { document: child }), node('output', 'output')], [['input', 'subflow'], ['subflow', 'output']]);
  const run = await manager.start({ document: parent, input: { id: 1 } });
  await until(() => manager.get(run.id).status === 'waiting_review');
  const childId = manager.get(run.id).nodes.subflow.subflowProgress.childRunId; assert.equal(calls, 1);
  await manager.close(); const next = new WorkflowRuns(app, { executeOperation: execute }); app.workflows = next;
  await until(() => next.get(run.id).status === 'waiting_review');
  await next.approve(childId, { nodeId: 'child-review', action: 'approve' });
  const result = await until(() => next.get(run.id).status === 'complete' && next.get(run.id)); assert.equal(calls, 1); assert.deepEqual(result.output, { id: 1, made: true });
});

test('foreach executes bounded child snapshots and loop stops on its condition', async t => {
  const { manager } = await setup(t);
  const child = graph([node('input', 'child-input'), code('child-task', { code: 'return {count:input.count+1};' }), node('output', 'child-output')], [['child-input', 'child-task'], ['child-task', 'child-output']]);
  const each = graph([node('input', 'input', { outputType: 'array' }), node('foreach', 'each', { document: child, maxIterations: 2 }), node('output', 'output')], [['input', 'each'], ['each', 'output']]);
  let run = await manager.start({ document: each, input: [{ count: 0 }, { count: 2 }] });
  let final = await until(() => ['complete', 'error'].includes(manager.get(run.id).status) && manager.get(run.id));
  assert.equal(final.status, 'complete', final.error); assert.deepEqual(final.output, [{ count: 1 }, { count: 3 }]);
  run = await manager.start({ document: each, input: [{ count: 0 }, { count: 1 }, { count: 2 }] });
  final = await until(() => manager.get(run.id).status === 'error' && manager.get(run.id)); assert.match(final.nodes.each.error, /次数上限/);
  const loop = graph([node('input', 'input'), node('loop', 'loop', { document: child, expression: 'input.count < 2', maxIterations: 3 }), node('output', 'output')], [['input', 'loop'], ['loop', 'output']]);
  run = await manager.start({ document: loop, input: { count: 0 } }); final = await until(() => manager.get(run.id).status === 'complete' && manager.get(run.id)); assert.deepEqual(final.output, { count: 2 });
});

test('named output field selectors transmit only the selected value and reject missing fields', async t => {
  const { manager } = await setup(t);
  const first = code('first', { code: 'return input.value === undefined ? {private:"missing value"} : {value:input.value,private:"not forwarded"};' }); first.ports = { inputs: [{ id: 'in', label: 'in', type: 'object', required: true }], outputs: [{ id: 'selected', label: 'value', type: 'number', valuePath: 'value' }] };
  const next = code('next', { inputType: 'number', code: 'return {value:input};' });
  const doc = graph([node('input', 'input'), first, next, node('output', 'output')], [['input', 'first'], ['first', 'next', 'in', 'selected'], ['next', 'output']]);
  const run = await manager.start({ document: doc, input: { value: 4 } });
  const final = await until(() => manager.get(run.id).status === 'complete' && manager.get(run.id)); assert.equal(final.nodes.next.input, 4); assert.deepEqual(final.output, { value: 4 });
  const invalid = await manager.start({ document: doc, input: {} });
  const failed = await until(() => manager.get(invalid.id).status === 'error' && manager.get(invalid.id)); assert.match(failed.nodes.first.error, /缺少端口字段/); assert.equal(failed.nodes.next.status, 'blocked');
});

test('condition routes one port and optional merge inputs do not wait for a skipped branch', async t => {
  const { manager } = await setup(t);
  const doc = graph([node('input', 'input'), node('condition', 'condition', { expression: 'input.enabled', inputType: 'object', outputType: 'object' }), code('yes'), code('no'), node('merge', 'merge', {}, { inputs: [{ id: 'yes', label: 'yes', type: 'object', required: false }, { id: 'no', label: 'no', type: 'object', required: false }], outputs: [{ id: 'out', label: 'out', type: 'object' }] }), node('output', 'output')], [['input', 'condition'], ['condition', 'yes', 'in', 'yes'], ['condition', 'no', 'in', 'no'], ['yes', 'merge', 'yes'], ['no', 'merge', 'no'], ['merge', 'output']]);
  const run = await manager.start({ document: doc, input: { enabled: true } });
  const result = await until(() => manager.get(run.id).status === 'complete' && manager.get(run.id)); assert.equal(result.nodes.no.status, 'skipped'); assert.deepEqual(result.output, { yes: { enabled: true } });
});

test('learning waits at each human gate and validation feedback never enters optimizer context', async t => {
  const { manager, app, directory } = await setup(t);
  const content = '---\nname: fixture\ndescription: fixture\nallowed-tools: []\n---\nReturn the requested object.';
  const version = 'sha256:' + createHash('sha256').update(content).digest('hex');
  app.skill = async name => ({ name, content, revision: version, source: 'local' });
  const histories = new Map(); let sessions = 0, modelCalls = 0;
  app.createSession = async () => ({ id: 'session-' + (++sessions) });
  app.history = async id => ({ messages: histories.get(id) || [] });
  app.interrupt = async () => ({});
  app.submit = async (id, text, options) => {
    assert.equal(manager.allowsSubmit(id, options.workflowRunId), true);
    histories.set(id, [{ role: 'assistant', text: JSON.stringify({ actual: JSON.parse(text.split('\nController artifact locations:')[0]).x }) }]);
    queueMicrotask(() => app.publish('message.complete', id, { status: 'complete' })); return { status: 'streaming' };
  };
  manager.prepareSkill = async (_app, _session, detail, context) => {
    assert.equal(context.learningId, context.memoryScopeId);
    return { skill: detail, bindInput: async input => ({ text: JSON.stringify(input) }), cleanup: async () => {} };
  };
  const model = { createMemoryScope: async ({ id }) => ({ id, mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false,
    snapshot: { version: 1, scopeId: id, digest: 'sha256:' + 'a'.repeat(64) } }),
    releaseMemoryScope: async () => {}, generate: async () => { modelCalls++; throw new Error('No optimizer should be called'); } };
  app.learnedSkills = { create: async () => { throw new Error('No candidate should be created'); } };
  const learning = new WorkflowLearning(app, { model }); app.learning = learning; t.after(() => learning.close());
  const skill = node('skill', 'skill', { inputType: 'object', outputType: 'object', skillRef: 'fixture', version });
  let doc = graph([node('input', 'input'), skill, node('human', 'review', { reviewTargetNodeId: 'skill' }), node('output', 'output'), node('evaluation', 'evaluate', { comparison: 'exact', valuePath: 'actual' }), node('improvement', 'improve', { targetSkillNodeIds: ['skill'] })], [['input', 'skill'], ['skill', 'review'], ['review', 'output'], ['output', 'evaluate', 'in', 'learning'], ['evaluate', 'improve']]);
  doc.mode = 'learn';
  const job = await learning.start({ document: doc, trainingCases: [{ input: { x: 1 }, expected: 1 }], validationCases: [{ input: { x: 2 }, expected: 2 }], maxRounds: 1, targetScore: 100 });
  let waiting = await until(() => learning.get(job.id).phase === 'waiting-review' && learning.get(job.id));
  assert.equal(waiting.status, 'waiting'); assert.equal(waiting.rounds[0].cases[1].status, 'pending'); assert.equal(modelCalls, 0);
  await manager.approve(waiting.activeRunId, { nodeId: 'review', action: 'approve', feedback: 'training reviewed' });
  waiting = await until(() => { const current = learning.get(job.id); return current.phase === 'waiting-review' && current.rounds[0].cases[1].runId && current; });
  await manager.approve(waiting.activeRunId, { nodeId: 'review', action: 'approve', feedback: 'private validation comment' });
  const result = await until(() => learning.get(job.id).status === 'complete' && learning.get(job.id));
  assert.equal(result.bestScore, 100); assert.equal(modelCalls, 0); assert.equal(result.memoryPolicy.memoryWriteAllowed, false);
  assert.equal(JSON.stringify(result.rounds[0].cases[1].skillInputs).includes('private validation comment'), false);
});

test('an admitted main model stays pinned through human waits and nested Skill execution', async t => {
  const { app, manager } = await setup(t);
  const version = 'sha256:' + 'b'.repeat(64), histories = new Map(), routes = [];
  let selected = { provider: 'first-provider', model: 'first-model' }, captures = 0;
  app.captureModelRoute = async () => { captures++; return { ...selected }; };
  app.skill = async name => ({ name, content: 'Return the input.', revision: version, source: 'local' });
  app.createSession = async ({ modelRoute }) => { routes.push({ ...modelRoute }); return { id: 'pinned-' + routes.length }; };
  app.submit = async id => { histories.set(id, [{ role: 'assistant', text: '{"ok":true}' }]); queueMicrotask(() => app.publish('message.complete', id, { status: 'complete' })); };
  app.history = async id => ({ messages: histories.get(id) }); app.interrupt = async () => ({});
  manager.prepareSkill = async (_app, _session, detail) => ({ skill: detail, text: '{}', cleanup: async () => {} });
  const skill = id => node('skill', id, { inputType: 'object', outputType: 'object', skillRef: 'fixture', version });
  const child = graph([node('input', 'child-in'), skill('child-skill'), node('output', 'child-out')], [['child-in', 'child-skill'], ['child-skill', 'child-out']]);
  const doc = graph([node('input', 'input'), skill('first'), node('human', 'review'), node('subflow', 'nested', { document: child }), node('output', 'output')], [['input', 'first'], ['first', 'review'], ['review', 'nested'], ['nested', 'output']]);
  const run = await manager.start({ document: doc, input: {} });
  await until(() => manager.get(run.id).status === 'waiting_review');
  selected = { provider: 'second-provider', model: 'second-model' };
  await manager.approve(run.id, { nodeId: 'review', action: 'approve' });
  const result = await until(() => ['complete', 'error'].includes(manager.get(run.id).status) && manager.get(run.id));
  assert.equal(result.status, 'complete', result.error);
  assert.equal(captures, 1);
  assert.deepEqual(result.modelRoute, { provider: 'first-provider', model: 'first-model' });
  assert.deepEqual(routes, [result.modelRoute, result.modelRoute]);
  const next = await manager.start({ document: child, input: {} });
  await until(() => manager.get(next.id).status === 'complete');
  assert.deepEqual(manager.get(next.id).modelRoute, selected);
  assert.deepEqual(routes.at(-1), selected);
});

for (const recoverable of [true, false]) {
  test(`a legacy DAG ${recoverable ? 'recovers its original model' : 'refuses an unknown model'} after a persistent human wait`, async t => {
    const { app, manager, db } = await setup(t);
    const original = { provider: 'legacy-provider', model: 'legacy-model' };
    let selected = { ...original }, captures = 0;
    const routes = [], histories = new Map();
    const version = 'sha256:' + 'c'.repeat(64);
    app.captureModelRoute = async () => { captures++; return { ...selected }; };
    app.skill = async name => ({ name, content: 'Return the input.', revision: version, source: 'local' });
    app.createSession = async ({ modelRoute }) => { routes.push({ ...modelRoute }); return { id: 'legacy-session-' + routes.length }; };
    app.submit = async id => { histories.set(id, [{ role: 'assistant', text: '{"preserved":"first result"}' }]); queueMicrotask(() => app.publish('message.complete', id, { status: 'complete' })); };
    app.history = async id => ({ messages: histories.get(id) }); app.interrupt = async () => ({});
    const prepare = async (_app, _session, detail) => ({ skill: detail, text: '{}', cleanup: async () => {} });
    manager.prepareSkill = prepare;
    const skill = id => node('skill', id, { inputType: 'object', outputType: 'object', skillRef: 'fixture', version });
    const document = graph([node('input', 'input'), skill('first'), node('human', 'review'), skill('second'), node('output', 'output')],
      [['input', 'first'], ['first', 'review'], ['review', 'second'], ['second', 'output']]);
    const started = await manager.start({ document, input: {} });
    await until(() => manager.get(started.id).status === 'waiting_review');
    await manager.close();
    const legacy = manager.get(started.id), first = legacy.nodes.first;
    delete legacy.modelRoute;
    db.prepare('UPDATE workflow_runs SET value=? WHERE id=?').run(JSON.stringify(legacy), started.id);
    selected = { provider: 'new-default-provider', model: 'new-default-model' };
    const recoveredIds = [];
    app.recoverModelRoute = ids => { recoveredIds.push(...ids); return recoverable && ids.includes(first.sessionId) ? { ...original } : null; };
    const replacement = new WorkflowRuns(app); app.workflows = replacement; replacement.prepareSkill = prepare;
    assert(recoveredIds.includes(first.sessionId));
    assert.deepEqual(replacement.get(started.id).modelRoute || null, recoverable ? original : null);
    await replacement.approve(started.id, { nodeId: 'review', action: 'approve' });
    const final = await until(() => ['complete', 'error'].includes(replacement.get(started.id).status) && replacement.get(started.id));
    assert.equal(final.status, recoverable ? 'complete' : 'error', final.error);
    assert.equal(captures, 1, 'restoring a legacy run must not read the new default');
    assert.deepEqual(final.nodes.first.output, first.output);
    assert.equal(final.nodes.first.attemptId, first.attemptId, 'the completed upstream Skill is not replayed');
    if (recoverable) assert.deepEqual(routes, [original, original]);
    else {
      assert.match(final.nodes.second.error, /旧运行.*未记录主模型/);
      assert.deepEqual(routes, [original], 'no additional Skill session is created without a recoverable model');
    }
  });
}

test('an unknown legacy parent cannot capture the new default through a nested Skill subflow', async t => {
  const { app, manager, db } = await setup(t, async ({ input }) => ({ output: { ...input, retained: true } }));
  let captures = 0, sessions = 0;
  const version = 'sha256:' + 'd'.repeat(64);
  app.captureModelRoute = async () => { captures++; return { provider: 'current-provider', model: 'current-model' }; };
  app.skill = async name => ({ name, content: 'Return the input.', revision: version, source: 'local' });
  app.createSession = async () => { sessions++; return { id: 'must-not-start' }; };
  app.submit = async () => { throw Error('Unknown legacy parent must not submit a prompt'); };
  app.history = async () => ({ messages: [] }); app.interrupt = async () => ({});
  manager.prepareSkill = async (_app, _session, detail) => ({ skill: detail, text: '{}', cleanup: async () => {} });
  const child = graph([node('input', 'child-input'), node('skill', 'child-skill', { inputType: 'object', outputType: 'object', skillRef: 'fixture', version }), node('output', 'child-output')],
    [['child-input', 'child-skill'], ['child-skill', 'child-output']]);
  const document = graph([node('input', 'input'), code('prepare'), node('human', 'review'), node('subflow', 'nested', { document: child }), node('output', 'output')],
    [['input', 'prepare'], ['prepare', 'review'], ['review', 'nested'], ['nested', 'output']]);
  const started = await manager.start({ document, input: { preserved: true } });
  await until(() => manager.get(started.id).status === 'waiting_review');
  await manager.close();
  const legacy = manager.get(started.id); delete legacy.modelRoute;
  db.prepare('UPDATE workflow_runs SET value=? WHERE id=?').run(JSON.stringify(legacy), started.id);
  app.recoverModelRoute = () => null;
  const replacement = new WorkflowRuns(app); app.workflows = replacement;
  replacement.prepareSkill = manager.prepareSkill;
  await replacement.approve(started.id, { nodeId: 'review', action: 'approve' });
  const final = await until(() => ['complete', 'error'].includes(replacement.get(started.id).status) && replacement.get(started.id));
  assert.equal(final.status, 'error');
  assert.match(final.nodes.nested.error, /旧运行.*未记录主模型/);
  assert.equal(captures, 1, 'child admission must inherit the unknown parent identity instead of capturing current defaults');
  assert.equal(sessions, 0);
  assert.deepEqual(final.nodes.prepare.output, legacy.nodes.prepare.output, 'completed artifacts remain attached to the original run');
});
