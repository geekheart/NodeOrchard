import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDocument, createNode, connectNodes, getPorts, updateNode } from '../shared/workflow/workflow-model.mjs';
import { planWorkflow } from '../shared/workflow/workflow-plan.mjs';
import { analyzeSelection, extractSelection, unpackSubflow, updateEmbeddedWorkflow } from '../shared/workflow/workflow-components.mjs';
import { instantiatePreset, presetDefinitionFromNode } from '../shared/workflow/workflow-presets.mjs';
import { WorkflowRuns } from '../src/workflows/workflow-runs.mjs';
import { WorkflowFiles } from '../src/workflows/workflow-files.mjs';
import { executeOperation } from '../src/workflows/workflow-operations.mjs';

const node = (type, id, config = {}, ports) => createNode(type, { x: 200, y: 60 }, { id,
  config: { ...(type === 'input' ? { outputType: 'object' } : type === 'output' ? { stage: 'final' }
    : ['tool', 'transform', 'human', 'condition'].includes(type) ? { inputType: 'any', outputType: 'any' } : {}), ...config }, ...(ports ? { ports } : {}) });
const code = (id, body = 'return input;', ports) => node('tool', id, { code: body }, ports);
function graph(nodes, edges) {
  let doc = { ...createDocument({ title: '组合节点实际执行', schemaVersion: 2 }), nodes };
  for (const [sourceNode, targetNode, targetPort = 'in', sourcePort = 'out'] of edges) doc = connectNodes(doc, { sourceNode, sourcePort, targetNode, targetPort });
  return doc;
}
async function until(check, message = 'workflow state') { for (let count = 0; count < 1200; count++) { const result = check(); if (result) return result; await delay(5); } throw Error('Timed out: ' + message); }
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-components-')); const db = new DatabaseSync(join(directory, 'state.sqlite'));
  const app = new EventEmitter(); app.store = { db }; app.config = { workspaceRoot: directory, dataDir: directory }; app.preferences = {};
  app.publish = (type, sessionId, payload) => app.emit('event', { type, sessionId, payload });
  app.workflowFiles = new WorkflowFiles(app, { allowedRoots: [directory] }); const calls = [];
  const manager = new WorkflowRuns(app, { executeOperation: async options => { calls.push({ id: options.node.id, input: structuredClone(options.input) }); return executeOperation(options); } });
  app.workflows = manager;
  t.after(async () => { await manager.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, db, manager, calls };
}
async function execute(manager, document, input) {
  const run = await manager.start({ document, input });
  const result = await until(() => ['complete', 'error', 'interrupted', 'unknown'].includes(manager.get(run.id).status) && manager.get(run.id));
  assert.equal(result.status, 'complete', result.error); return result;
}
function multiGraph() {
  const merge = node('merge', 'merge', {}, { inputs: [{ id: 'a', label: '资料A', type: 'object', required: true }, { id: 'b', label: '资料B', type: 'object', required: true }], outputs: [{ id: 'out', label: '资料集合', type: 'object' }] });
  const calculate = code('calculate', 'return {left: input.a.value + input.b.value, right: {board: input.a.board, count: input.b.value * 2}};', {
    inputs: [{ id: 'in', label: '资料', type: 'object', required: true }], outputs: [
      { id: 'left', label: '和', type: 'number', valuePath: 'left' }, { id: 'right', label: '数据摘要', type: 'object', valuePath: 'right' }],
  });
  return graph([node('input', 'first', { fieldName: 'first' }), node('input', 'second', { fieldName: 'second' }), merge, calculate,
    node('output', 'out-left'), node('output', 'out-right')], [['first', 'merge', 'a'], ['second', 'merge', 'b'], ['merge', 'calculate'], ['calculate', 'out-left', 'in', 'left'], ['calculate', 'out-right', 'in', 'right']]);
}

test('real multi-input multi-output execution is identical before folding, after folding, and after unpacking', async t => {
  const { manager } = await setup(t); const doc = multiGraph(), frozen = structuredClone(doc);
  const input = { first: { board: 'P4C61-TINY', value: 3 }, second: { value: 8 } };
  const expected = { 'out-left': 11, 'out-right': { board: 'P4C61-TINY', count: 16 } };
  assert.deepEqual((await execute(manager, doc, input)).output, expected);
  const analysis = analyzeSelection(doc, ['merge', 'calculate']); assert.equal(analysis.inputs.length, 2); assert.equal(analysis.outputs.length, 2);
  const folded = extractSelection(doc, ['merge', 'calculate'], { title: '计算数据摘要' });
  assert.deepEqual(doc, frozen); assert.equal(getPorts(folded.node).inputs[0].id, 'arg-1');
  const inside = await execute(manager, folded.document, input); assert.deepEqual(inside.output, expected);
  assert.equal(inside.nodes[folded.node.id].subflowProgress.results.length, 1);
  const expanded = unpackSubflow(folded.document, folded.node.id); assert.equal(expanded.nodes.some(row => row.type === 'subflow'), false);
  assert.deepEqual((await execute(manager, expanded, input)).output, expected);
});

test('saved component instance remaps internal outputs and review IDs while preserving executable public interface', async t => {
  const { manager } = await setup(t); const original = multiGraph(); const folded = extractSelection(original, ['merge', 'calculate']);
  const definition = presetDefinitionFromNode(folded.node, { title: '我的数据计算组合' });
  const instance = instantiatePreset({ id: 'preset-board-summary', version: 3, definition }, { x: 500, y: 300 });
  assert.notEqual(instance.config.document.id, folded.workflow.id); assert.equal(instance.origin.version, 3);
  const oldOutputIds = new Set(folded.workflow.nodes.filter(row => row.type === 'output').map(row => row.id));
  for (const port of instance.ports.outputs) assert.equal(oldOutputIds.has(port.valuePath), false);
  const document = { ...folded.document, nodes: folded.document.nodes.map(row => row.id === folded.node.id ? instance : row),
    edges: folded.document.edges.map(edge => ({ ...edge, sourceNode: edge.sourceNode === folded.node.id ? instance.id : edge.sourceNode, targetNode: edge.targetNode === folded.node.id ? instance.id : edge.targetNode })) };
  assert.deepEqual((await execute(manager, document, { first: { board: 'S31-TINY', value: 2 }, second: { value: 5 } })).output,
    { 'out-left': 7, 'out-right': { board: 'S31-TINY', count: 10 } });
  assert.deepEqual((await execute(manager, unpackSubflow(document, instance.id), { first: { board: 'S31-TINY', value: 2 }, second: { value: 5 } })).output,
    { 'out-left': 7, 'out-right': { board: 'S31-TINY', count: 10 } });
});

test('shared upstream boundary is deduplicated and a selected source projection keeps its value', async t => {
  const { manager } = await setup(t);
  const merge = node('merge', 'join', {}, { inputs: [{ id: 'left', label: '左', type: 'number', required: true }, { id: 'right', label: '右', type: 'number', required: true }], outputs: [{ id: 'out', label: '汇总', type: 'object' }] });
  const source = code('projection', 'return {wanted: input.value, private: "not passed"};', { inputs: [{ id: 'in', label: '资料', type: 'object', required: true }], outputs: [{ id: 'selected', label: '数值', type: 'number', valuePath: 'wanted' }] });
  const doc = graph([node('input', 'input'), source, code('left', 'return input*2;'), code('right', 'return input+1;'), merge, node('output', 'output')],
    [['input', 'projection'], ['projection', 'left', 'in', 'selected'], ['projection', 'right', 'in', 'selected'], ['left', 'join', 'left'], ['right', 'join', 'right'], ['join', 'output']]);
  const folded = extractSelection(doc, ['left', 'right', 'join']);
  assert.equal(getPorts(folded.node).inputs.length, 1); assert.equal(folded.workflow.nodes.filter(row => row.type === 'input').length, 1);
  for (const document of [doc, folded.document, unpackSubflow(folded.document, folded.node.id)]) assert.deepEqual((await execute(manager, document, { value: 4 })).output, { left: 8, right: 5 });
});

const imageCode = `const {writeFile}=await import('node:fs/promises');const path=context.outputDirectory+'/candidate.svg';await writeFile(path,'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');return {path, board:input.board};`;
function reviewGraph() {
  return graph([node('input', 'input'), node('tool', 'image', { code: imageCode, reviewImages: true }),
    node('human', 'review', { reviewTargetNodeId: 'image', prompt: '请审核标注图片' }), node('output', 'output')], [['input', 'image'], ['image', 'review'], ['review', 'output']]);
}
test('generated nested image review blocks outer delivery, exposes real artifacts, and approval resumes exactly once', async t => {
  const { manager, calls } = await setup(t); const folded = extractSelection(reviewGraph(), ['image', 'review']);
  const preset = instantiatePreset({ id: 'preset-reviewed-image', version: 1, definition: presetDefinitionFromNode(folded.node) });
  const doc = { ...folded.document, nodes: folded.document.nodes.map(row => row.id === folded.node.id ? preset : row),
    edges: folded.document.edges.map(edge => ({ ...edge, sourceNode: edge.sourceNode === folded.node.id ? preset.id : edge.sourceNode, targetNode: edge.targetNode === folded.node.id ? preset.id : edge.targetNode })) };
  const run = await manager.start({ document: doc, input: { board: 'P4C61' } });
  await until(() => manager.get(run.id).status === 'waiting_review');
  const parent = manager.get(run.id), childId = parent.nodes[preset.id].subflowProgress.childRunId, child = manager.get(childId);
  const review = child.document.nodes.find(row => row.type === 'human'), producer = child.document.nodes.find(row => row.type === 'tool');
  assert.equal(review.config.reviewTargetNodeId, producer.id); assert.equal(parent.nodes.output.status, 'pending'); assert.equal(calls.length, 1);
  assert(child.nodes[review.id].artifacts.some(row => row.mimeType === 'image/svg+xml'));
  await manager.approve(childId, { nodeId: review.id, action: 'approve' });
  const result = await until(() => manager.get(run.id).status === 'complete' && manager.get(run.id));
  assert.equal(calls.length, 1); assert.equal(result.output.board, 'P4C61'); assert.equal(result.nodes.output.status, 'complete');
});

test('stopping folded workflow cancels waiting child and leaves no active review or admission lock', async t => {
  const { manager, calls } = await setup(t); const folded = extractSelection(reviewGraph(), ['image', 'review']);
  const run = await manager.start({ document: folded.document, input: { board: 'P4C61' } });
  await until(() => manager.get(run.id).status === 'waiting_review');
  const childId = manager.get(run.id).nodes[folded.node.id].subflowProgress.childRunId;
  assert.deepEqual(manager.get(run.id).nodes[folded.node.id].subflowProgress.childRunIds, [childId]);
  await manager.interrupt(run.id); await until(() => manager.get(childId).status === 'interrupted');
  assert.equal(manager.get(run.id).status, 'interrupted'); assert.equal(manager.get(run.id).nodes.output.attempt, 0);
  assert.deepEqual(manager.get(run.id).nodes[folded.node.id].subflowProgress.childRunIds, [childId]);
  assert.equal(manager.dag.active.size, 0); assert.equal(manager.locks.size, 0); assert.equal(calls.length, 1);
  await assert.rejects(manager.approve(childId, { nodeId: 'review', action: 'approve' }), /等待中的人工审核/);
});

test('embedded editing keeps interface and identity fixed while allowing internal tool changes', async t => {
  const { manager } = await setup(t); const folded = extractSelection(multiGraph(), ['merge', 'calculate']);
  const edited = updateNode(folded.workflow, 'calculate', { config: { code: 'return {left: input.a.value-input.b.value, right: {board: input.a.board, count: 99}};' } });
  const updated = updateEmbeddedWorkflow(folded.document, folded.node.id, edited);
  assert.deepEqual((await execute(manager, updated, { first: { board: 'P4', value: 8 }, second: { value: 3 } })).output,
    { 'out-left': 5, 'out-right': { board: 'P4', count: 99 } });
  const input = edited.nodes.find(row => row.type === 'input');
  assert.throws(() => updateEmbeddedWorkflow(folded.document, folded.node.id, updateNode(edited, input.id, { config: { fieldName: 'changed-interface' } })), /边界/);
  assert.throws(() => updateEmbeddedWorkflow(folded.document, folded.node.id, { ...edited, id: 'other-workflow' }), /不匹配/);
});

test('noncontiguous, image-only, learning-observed, and learning-target selections are rejected before changing original graph', () => {
  const source = reviewGraph(); assert.throws(() => extractSelection(source, ['image']), /人工审核/);
  const chain = graph([node('input', 'input'), code('a'), code('b'), code('c'), node('output', 'output')], [['input', 'a'], ['a', 'b'], ['b', 'c'], ['c', 'output']]);
  assert.throws(() => extractSelection(chain, ['a', 'c']), /中间节点/); assert.throws(() => extractSelection(source, ['review']), /修改目标一并/);
  let learning = { ...chain, nodes: [...chain.nodes, node('evaluation', 'compare'), node('improvement', 'improve', { targetSkillNodeIds: [] })] };
  learning = connectNodes(learning, { sourceNode: 'a', sourcePort: 'out', targetNode: 'compare', targetPort: 'in' });
  learning = connectNodes(learning, { sourceNode: 'compare', sourcePort: 'out', targetNode: 'improve', targetPort: 'in' });
  assert.throws(() => extractSelection(learning, ['a']), /学习对比/);
  const targeted = { ...chain, nodes: [...chain.nodes, node('improvement', 'target', { targetSkillNodeIds: ['b'] })] };
  assert.throws(() => extractSelection(targeted, ['b']), /学习改进目标/);
  assert.doesNotThrow(() => planWorkflow(chain));
});

test('unconnected optional merge inputs preserve absence through extract and unpack', async t => {
  const { manager } = await setup(t);
  const merge = node('merge', 'join', {}, { inputs: [{ id: 'required', label: '必填', type: 'object', required: true }, { id: 'optional', label: '可选', type: 'object', required: false }], outputs: [{ id: 'out', label: '汇总', type: 'object' }] });
  const doc = graph([node('input', 'input'), merge, node('output', 'output')], [['input', 'join', 'required'], ['join', 'output']]);
  const expected = { required: { board: 'P4' } }; assert.deepEqual((await execute(manager, doc, { board: 'P4' })).output, expected);
  const folded = extractSelection(doc, ['join']);
  assert.deepEqual((await execute(manager, folded.document, { board: 'P4' })).output, expected);
  assert.deepEqual((await execute(manager, unpackSubflow(folded.document, folded.node.id), { board: 'P4' })).output, expected);
});

test('condition branch outputs cannot be folded across an interface that cannot preserve skipped-port routing', () => {
  const doc = graph([node('input', 'input'), node('condition', 'condition', { expression: 'input.enabled' }), code('yes'), code('no'),
    node('output', 'output-yes'), node('output', 'output-no')], [['input', 'condition'], ['condition', 'yes', 'in', 'yes'], ['condition', 'no', 'in', 'no'], ['yes', 'output-yes'], ['no', 'output-no']]);
  assert.throws(() => extractSelection(doc, ['condition']), /条件|分支|选区/);
  assert.throws(() => extractSelection(doc, ['condition', 'yes', 'no']), /条件|分支|选区/);
});

test('condition branches enclosed through an optional merge execute identically before folding and after unpacking', async t => {
  const { manager } = await setup(t);
  const merge = node('merge', 'join', {}, { inputs: [{ id: 'yes', label: '是', type: 'object', required: false }, { id: 'no', label: '否', type: 'object', required: false }], outputs: [{ id: 'out', label: '选择结果', type: 'object' }] });
  const doc = graph([node('input', 'input'), node('condition', 'condition', { expression: 'input.enabled' }), code('yes', 'return {choice:"yes",value:input.value};'),
    code('no', 'return {choice:"no",value:input.value};'), merge, node('output', 'output')], [['input', 'condition'], ['condition', 'yes', 'in', 'yes'],
    ['condition', 'no', 'in', 'no'], ['yes', 'join', 'yes'], ['no', 'join', 'no'], ['join', 'output']]);
  const folded = extractSelection(doc, ['condition', 'yes', 'no', 'join']), unpacked = unpackSubflow(folded.document, folded.node.id);
  for (const enabled of [true, false]) {
    const input = { enabled, value: 42 }, key = enabled ? 'yes' : 'no';
    const expected = { [key]: { choice: key, value: 42 } };
    for (const document of [doc, folded.document, unpacked]) assert.deepEqual((await execute(manager, document, input)).output, expected);
  }
});

test('generic code producer and consumer can be folded independently using ordinary values', () => {
  const doc = graph([node('input', 'input'), code('prepared'), code('consumer'), node('output', 'output')],
    [['input', 'prepared'], ['prepared', 'consumer'], ['consumer', 'output']]);
  for (const ids of [['prepared'], ['consumer'], ['prepared', 'consumer']]) {
    assert.doesNotThrow(() => planWorkflow(extractSelection(doc, ids).document));
  }
});

test('optional input from an outside conditional branch is rejected before folding can turn absence into null', () => {
  const merge = node('merge', 'join', {}, { inputs: [{ id: 'required', label: '基础资料', type: 'object', required: true }, { id: 'optional', label: '可选资料', type: 'object', required: false }], outputs: [{ id: 'out', label: '汇总', type: 'object' }] });
  const doc = graph([node('input', 'input'), node('condition', 'condition', { expression: 'input.enabled' }), code('yes'), merge, node('output', 'output')],
    [['input', 'condition'], ['condition', 'yes', 'in', 'yes'], ['input', 'join', 'required'], ['yes', 'join', 'optional'], ['join', 'output']]);
  assert.doesNotThrow(() => planWorkflow(doc));
  assert.throws(() => extractSelection(doc, ['join']), /可选|条件|分支/);
});

test('unpacking a manually authored subflow retains saved intermediate files and does not add them to final delivery', async t => {
  const { manager } = await setup(t);
  const preview = node('output', 'preview', { stage: 'intermediate', fileName: 'preview.json' }); preview.title = '阶段预览';
  const childFinal = node('output', 'child-final', { stage: 'final', fileName: 'child-result.json' }); childFinal.title = '子流程返回';
  const child = graph([node('input', 'child-input'), code('first', 'return {board:input.board,step:1};'), preview,
    code('later', 'return {...input,step:2};'), childFinal], [['child-input', 'first'], ['first', 'preview'], ['preview', 'later'], ['later', 'child-final']]);
  const subflow = node('subflow', 'component', { document: child, inputType: 'object', outputType: 'any' });
  const parent = graph([node('input', 'input'), subflow, node('output', 'parent-final')], [['input', 'component'], ['component', 'parent-final']]);
  const before = await execute(manager, parent, { board: 'P4C61' }); const childId = before.nodes.component.subflowProgress.childRunId;
  assert.equal(childId, null);
  const children = before.nodes.component.subflowProgress.childRunIds; assert.equal(children.length, 1);
  const childRun = manager.get(children[0]); assert.equal(childRun.parentRunId, before.id);
  assert(childRun); const beforePreview = JSON.parse(await readFile(childRun.nodes.preview.savedPath, 'utf8'));
  const expanded = unpackSubflow(parent, 'component'); const expandedPreview = expanded.nodes.find(row => row.title === '阶段预览');
  assert(expandedPreview); assert.equal(expandedPreview.config.stage, 'intermediate');
  const after = await execute(manager, expanded, { board: 'P4C61' });
  assert.deepEqual(after.output, before.output); assert.deepEqual(after.output, { board: 'P4C61', step: 2 });
  assert.deepEqual(JSON.parse(await readFile(after.nodes[expandedPreview.id].savedPath, 'utf8')), beforePreview);
  assert.deepEqual(after.stageOutputs[expandedPreview.id], { board: 'P4C61', step: 1 });
});

test('unpacking restores an external review revision target to the actual producer rather than its saved-output node', async t => {
  const { manager } = await setup(t);
  const doc = graph([node('input', 'input'), code('producer', 'return {...input,produced:true};'),
    node('human', 'review', { reviewTargetNodeId: 'producer' }), node('output', 'output')], [['input', 'producer'], ['producer', 'review'], ['review', 'output']]);
  const folded = extractSelection(doc, ['producer']); assert.equal(folded.document.nodes.find(row => row.id === 'review').config.reviewTargetNodeId, folded.node.id);
  const expanded = unpackSubflow(folded.document, folded.node.id); const review = expanded.nodes.find(row => row.id === 'review');
  assert.equal(expanded.nodes.find(row => row.id === review.config.reviewTargetNodeId).type, 'tool');
  for (const document of [doc, folded.document, expanded]) {
    const run = await manager.start({ document, input: { board: 'P4' } });
    await until(() => manager.get(run.id).status === 'waiting_review');
    await manager.approve(run.id, { nodeId: 'review', action: 'approve' });
    assert.deepEqual((await until(() => manager.get(run.id).status === 'complete' && manager.get(run.id))).output, { board: 'P4', produced: true });
  }
});

test('completed component keeps durable deduplicated child run IDs across manager restart with exact parent binding', async t => {
  const { manager, app } = await setup(t); const folded = extractSelection(multiGraph(), ['merge', 'calculate']);
  const result = await execute(manager, folded.document, { first: { board: 'P4C61', value: 4 }, second: { value: 6 } });
  const progress = result.nodes[folded.node.id].subflowProgress;
  assert.equal(progress.childRunId, null); assert.equal(progress.childRunIds.length, 1);
  const childId = progress.childRunIds[0]; const child = manager.get(childId);
  assert.equal(child.parentRunId, result.id); assert.equal(child.status, 'complete');
  await manager.close(); const reopened = new WorkflowRuns(app, { executeOperation }); app.workflows = reopened;
  try {
    const restored = reopened.get(result.id).nodes[folded.node.id].subflowProgress;
    assert.deepEqual(restored.childRunIds, [childId]); assert.equal(restored.childRunId, null);
    assert.equal(reopened.get(childId).parentRunId, result.id); assert.equal(reopened.get(childId).nodes.calculate.status, 'complete');
    assert.deepEqual(reopened.get(childId).nodes.calculate.input, { a: { board: 'P4C61', value: 4 }, b: { value: 6 } });
    assert.equal(reopened.dag.active.size, 0);
  } finally { await reopened.close(); }
});

test('legacy waiting child progress gains the history list once without replaying after restart', async t => {
  const { manager, app, db, calls } = await setup(t); const folded = extractSelection(reviewGraph(), ['image', 'review']);
  const run = await manager.start({ document: folded.document, input: { board: 'P4C61' } });
  await until(() => manager.get(run.id).status === 'waiting_review');
  const childId = manager.get(run.id).nodes[folded.node.id].subflowProgress.childRunId; assert.equal(calls.length, 1);
  await manager.close();
  const row = db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(run.id); const legacy = JSON.parse(row.value);
  delete legacy.nodes[folded.node.id].subflowProgress.childRunIds;
  db.prepare('UPDATE workflow_runs SET value=? WHERE id=?').run(JSON.stringify(legacy), run.id);
  const reopened = new WorkflowRuns(app, { executeOperation: async options => { calls.push({ id: options.node.id }); return executeOperation(options); } }); app.workflows = reopened;
  try {
    await until(() => reopened.get(run.id).nodes[folded.node.id].subflowProgress.childRunIds?.length === 1);
    assert.deepEqual(reopened.get(run.id).nodes[folded.node.id].subflowProgress.childRunIds, [childId]);
    assert.equal(reopened.get(childId).parentRunId, run.id); assert.equal(calls.length, 1);
    await reopened.approve(childId, { nodeId: 'review', action: 'approve' });
    const final = await until(() => reopened.get(run.id).status === 'complete' && reopened.get(run.id));
    assert.deepEqual(final.nodes[folded.node.id].subflowProgress.childRunIds, [childId]);
    assert.equal(final.nodes[folded.node.id].subflowProgress.childRunId, null); assert.equal(calls.length, 1);
  } finally { await reopened.close(); }
});

test('bounded iteration preserves every admitted child in execution order after the active child clears', async t => {
  const { manager } = await setup(t);
  const child = graph([node('input', 'child-input'), code('increment', 'return {value:input.value+1};'), node('output', 'child-output')], [['child-input', 'increment'], ['increment', 'child-output']]);
  const parent = graph([node('input', 'input', { outputType: 'array' }), node('foreach', 'each', { document: child, maxIterations: 2 }), node('output', 'output')], [['input', 'each'], ['each', 'output']]);
  const final = await execute(manager, parent, [{ value: 1 }, { value: 4 }]); const progress = final.nodes.each.subflowProgress;
  assert.equal(progress.childRunId, null); assert.equal(progress.childRunIds.length, 2); assert.equal(new Set(progress.childRunIds).size, 2);
  assert.deepEqual(final.output, [{ value: 2 }, { value: 5 }]);
  assert.deepEqual(progress.childRunIds.map(id => manager.get(id).nodes['child-input'].output), [{ value: 1 }, { value: 4 }]);
  for (const id of progress.childRunIds) { assert.equal(manager.get(id).parentRunId, final.id); assert.equal(manager.get(id).status, 'complete'); }
});
