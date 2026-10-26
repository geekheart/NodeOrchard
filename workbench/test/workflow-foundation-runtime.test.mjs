import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDocument, createNode, connectNodes, validateDocument, updateNode } from '../shared/workflow/workflow-model.mjs';
import { planWorkflow } from '../shared/workflow/workflow-plan.mjs';
import { validationRules, validateNodeValue } from '../shared/workflow/workflow-validation.mjs';
import { WorkflowRuns } from '../src/workflows/workflow-runs.mjs';
import { WorkflowFiles } from '../src/workflows/workflow-files.mjs';

const node = (type, id, config = {}) => createNode(type, { x: 0, y: 0 }, { id, config: { ...(type === 'input' ? { outputType: 'object' } : {}), ...config } });
function graph(nodes, edges) {
  let doc = { ...createDocument({ title: '基础节点验收', schemaVersion: 2 }), nodes };
  for (const [sourceNode, targetNode] of edges) doc = connectNodes(doc, { sourceNode, sourcePort: 'out', targetNode, targetPort: 'in' });
  return doc;
}
async function until(check) { for (let count = 0; count < 600; count++) { const result = check(); if (result) return result; await delay(5); } throw Error('Timeout'); }
async function setup(t, executeOperation) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-foundation-')); const db = new DatabaseSync(join(directory, 'db.sqlite'));
  const app = new EventEmitter(); app.store = { db }; app.config = { workspaceRoot: directory, dataDir: directory }; app.preferences = {};
  app.publish = (type, sessionId, payload) => app.emit('event', { type, sessionId, payload });
  app.workflowFiles = new WorkflowFiles(app, { allowedRoots: [directory] });
  const manager = new WorkflowRuns(app, { executeOperation }); app.workflows = manager;
  t.after(async () => { await manager.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, manager, directory };
}

test('declarative rules validate required, nonempty, type, and structural equality without transforming data', () => {
  const input = { title: 'board', pins: [1, 2], count: 0, enabled: false, metadata: { x: 1, y: 2 } };
  const rules = [{ valuePath: 'title', check: 'required' }, { valuePath: 'pins', check: 'nonempty' },
    { valuePath: 'count', check: 'type', expectedType: 'number' }, { valuePath: 'enabled', check: 'required' },
    { valuePath: 'metadata', check: 'equals', expected: { y: 2, x: 1 } }];
  assert.equal(validateNodeValue(input, rules).passed, true);
  for (const value of ['', '  ', [], {}, null]) assert.throws(() => validateNodeValue(value, [{ check: 'nonempty' }]), /不能为空/);
  let failure; try { validateNodeValue(input, [{ valuePath: 'missing', check: 'required', message: '请先准备背面照片' }], '资料校验'); } catch (error) { failure = error; }
  assert.match(failure.message, /资料校验.*请先准备背面照片/); assert.equal(failure.validation.results[0].passed, false);
});

test('validation configuration rejects unsafe, ambiguous, oversized, and empty executable rules', () => {
  for (const rules of [null, [{ check: 'exec' }], [{ check: 'type' }], [{ check: 'equals' }],
    [{ check: 'required', expected: 1 }], [{ valuePath: 'constructor.secret', check: 'required' }],
    [{ check: 'equals', expected: 'a'.repeat(4097) }], Array.from({ length: 33 }, () => ({ check: 'required' }))]) {
    assert.throws(() => validationRules(rules));
  }
  const doc = graph([node('input', 'input'), node('validation', 'check', { rules: [] }), node('output', 'output')], [['input', 'check'], ['check', 'output']]);
  assert.throws(() => planWorkflow(doc), /至少需要一条/);
  const initial = node('validation', 'first'); initial.config.rules[0].valuePath = 'mutated';
  assert.equal(node('validation', 'next').config.rules[0].valuePath, '');
  let invoked = false; const unsafe = []; Object.defineProperty(unsafe, '0', { get() { invoked = true; return 1; }, enumerable: true });
  assert.throws(() => validationRules([{ check: 'equals', expected: unsafe }]), /不安全/); assert.equal(invoked, false);
});

test('v2 preset origin survives updates and round trip while unknown fields and type confusion fail', () => {
  const origin = { kind: 'preset', id: 'board-input', version: 2, title: '板卡资料', baseType: 'input' };
  let doc = { ...createDocument({ schemaVersion: 2 }), nodes: [createNode('input', { x: 0, y: 0 }, { id: 'input', origin })] };
  origin.title = 'mutated'; doc = updateNode(doc, 'input', { title: '自己的名称' });
  assert.equal(validateDocument(doc).nodes[0].origin.title, '板卡资料'); assert.equal(doc.nodes[0].origin.version, 2);
  for (const patch of [{ version: 0 }, { version: '2' }, { baseType: 'tool' }, { kind: 'unknown' }, { source: 'hidden' }]) {
    assert.throws(() => validateDocument({ ...doc, nodes: [{ ...doc.nodes[0], origin: { ...doc.nodes[0].origin, ...patch } }] }));
  }
  assert.throws(() => validateDocument({ ...doc, schemaVersion: 1 }), /未知字段/);
});

test('validation failure blocks its downstream tool, preserves per-rule results, and uses no model or executor', async t => {
  let calls = 0; const { manager } = await setup(t, async ({ input }) => { calls++; return { output: input }; });
  const doc = graph([node('input', 'input'), node('validation', 'check', { rules: [{ valuePath: 'board', check: 'nonempty', message: '请准备板卡名称' }] }),
    node('tool', 'tool', { code: 'return input;' }), node('output', 'output')], [['input', 'check'], ['check', 'tool'], ['tool', 'output']]);
  const run = await manager.start({ document: doc, input: {} });
  const final = await until(() => manager.get(run.id).status === 'error' && manager.get(run.id));
  assert.equal(calls, 0); assert.equal(final.nodes.check.status, 'error'); assert.equal(final.nodes.check.validation.passed, false);
  assert.match(final.nodes.check.error, /请准备板卡名称/); assert.equal(final.nodes.tool.status, 'blocked'); assert.equal(final.nodes.output.status, 'blocked');
});

test('successful validation preserves exact data and stage output is saved outside the final result', async t => {
  const { manager } = await setup(t, async ({ input }) => ({ output: input }));
  const doc = graph([node('input', 'input'), node('validation', 'check', { rules: [{ valuePath: 'board', check: 'type', expectedType: 'text' }] }),
    node('output', 'preview', { stage: 'intermediate', fileName: '阶段结果.json' }), node('output', 'final', { stage: 'final' })], [['input', 'check'], ['check', 'preview'], ['check', 'final']]);
  const input = { board: 'P4C61-TINY', enabled: false };
  const run = await manager.start({ document: doc, input });
  const final = await until(() => manager.get(run.id).status === 'complete' && manager.get(run.id));
  assert.deepEqual(final.nodes.check.output, input); assert.equal(final.nodes.check.validation.passed, true);
  assert.deepEqual(final.output, input); assert.deepEqual(final.stageOutputs, { preview: input }); assert.deepEqual(final.outputs, { preview: input, final: input });
  assert.deepEqual(JSON.parse(await readFile(final.nodes.preview.savedPath, 'utf8')), input);
  assert(final.nodes.preview.artifacts.some(row => row.role === 'stage-result')); assert.equal(final.nodes.preview.outputStage, 'intermediate');
});

function imageGraph(stage, bypass = false) {
  return graph([node('input', 'input'), node('tool', 'image', { code: 'return input;', reviewImages: true }),
    node('output', 'preview', { stage }), node('human', 'review'), node('output', 'final', { stage: 'final' }),
    ...(bypass ? [node('tool', 'bypass', { code: 'return input;' })] : [])],
  [['input', 'image'], ['image', 'preview'], ['image', 'review'], ['review', 'final'], ...(bypass ? [['preview', 'bypass']] : [])]);
}
test('stage preview needs a human route and cannot bypass review into a capability or final output', () => {
  assert.doesNotThrow(() => planWorkflow(imageGraph('intermediate')));
  assert.throws(() => planWorkflow(imageGraph('final')), /人工审核/);
  assert.throws(() => planWorkflow(imageGraph('intermediate', true)), /人工审核/);
  const noReview = imageGraph('intermediate'); noReview.edges = noReview.edges.filter(edge => edge.targetNode !== 'review' && edge.sourceNode !== 'review');
  noReview.nodes = noReview.nodes.filter(node => !['review', 'final'].includes(node.id));
  assert.throws(() => planWorkflow(noReview), /最终交付/);
  const disguised = imageGraph('intermediate'); disguised.edges = disguised.edges.filter(edge => edge.targetNode !== 'review');
  disguised.nodes = disguised.nodes.filter(node => node.id !== 'review'); disguised.edges = disguised.edges.filter(edge => edge.targetNode !== 'final');
  const direct = connectNodes(disguised, { sourceNode: 'preview', sourcePort: 'out', targetNode: 'final', targetPort: 'in' });
  assert.throws(() => planWorkflow(direct), /人工审核/);
  const legacy = graph([node('input', 'input'), node('tool', 'image', { code: 'return input;', reviewImages: true }),
    node('output', 'preview'), node('human', 'review'), node('output', 'final')], [['input', 'image'], ['image', 'preview'], ['preview', 'review'], ['review', 'final']]);
  assert.doesNotThrow(() => planWorkflow(legacy), 'already accepted pre-stage workflows keep their original contract');
  const explicitFinal = updateNode(legacy, 'preview', { config: { stage: 'final' } });
  assert.throws(() => planWorkflow(explicitFinal), /人工审核/);
});

test('a real image preview saves while waiting and final delivery remains blocked until human approval', async t => {
  let calls = 0; const { manager } = await setup(t, async ({ cwd }) => { calls++; const path = join(cwd, 'candidate.svg');
    await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    return { output: { path }, artifacts: [{ path, kind: 'image' }] }; });
  const run = await manager.start({ document: imageGraph('intermediate'), input: {} });
  const waiting = await until(() => manager.get(run.id).status === 'waiting_review' && manager.get(run.id));
  assert.equal(waiting.nodes.preview.status, 'complete'); assert.equal(waiting.nodes.final.status, 'pending'); assert.equal(calls, 1);
  assert(waiting.nodes.review.artifacts.some(row => row.mimeType.startsWith('image/')));
  await manager.approve(run.id, { nodeId: 'review', action: 'approve' });
  const final = await until(() => manager.get(run.id).status === 'complete' && manager.get(run.id));
  assert.equal(final.nodes.final.status, 'complete'); assert.equal(calls, 1); assert.deepEqual(final.output, final.nodes.image.output);
});
