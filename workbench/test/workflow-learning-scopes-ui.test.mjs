import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';
import { planWorkflow, learningImprovementTargets } from '../shared/workflow/workflow-plan.mjs';
import { WorkflowLearningUI, learningSetupForDocument } from '../public/workflow-learning-ui.js';
import { presetDefinitionFromNode } from '../shared/workflow/workflow-presets.mjs';
import { prepareWorkflowVersion } from '../shared/workflow/workflow-versioning.mjs';
import { WorkflowEditor } from '../public/workflow-editor.js';
import { applyWorkflowOperations } from '../shared/workflow/workflow-conversation-commands.mjs';

function learningDocument(scope = 'tools', targets = ['worker'], type = 'tool') {
  let document = createDocument({ schemaVersion: 2, title: '工具学习范围' }); document.mode = 'learn';
  document.nodes = [createNode('input', {}, { id: 'input', config: { outputType: 'object' } }),
    createNode(type, {}, { id: 'worker', config: { inputType: 'object', outputType: 'object', code: 'return input;' } }),
    createNode('output', {}, { id: 'output' }), createNode('evaluation', {}, { id: 'evaluation' }),
    createNode('improvement', {}, { id: 'improvement', config: { scope, ...(scope === 'tools' ? { targetNodeIds: targets } : {}) } })];
  for (const [sourceNode, sourcePort, targetNode] of [['input', 'out', 'worker'], ['worker', 'out', 'output'], ['output', 'learning', 'evaluation'], ['evaluation', 'out', 'improvement']]) document = connectNodes(document, { sourceNode, sourcePort, targetNode, targetPort: 'in' });
  return document;
}

test('tools learning selects explicit business tool or transform nodes without requiring a Skill', () => {
  for (const type of ['tool', 'transform']) {
    const plan = planWorkflow({ ...learningDocument('tools', ['worker'], type), mode: 'execute' });
    const targets = learningImprovementTargets(plan);
    assert.equal(targets.scope, 'tools'); assert.deepEqual(targets.ids, ['worker']); assert.equal(targets.nodes[0].type, type);
  }
  for (const ids of [[], ['input'], ['output'], ['missing']]) assert.throws(() => learningImprovementTargets(planWorkflow({ ...learningDocument('tools', ids), mode: 'execute' })), /选择|目标|主链/);
});

test('workflow learning exposes business abilities while fixed observation and boundary nodes stay outside targets', () => {
  const plan = planWorkflow({ ...learningDocument('workflow'), mode: 'execute' });
  assert.equal(plan.skillNodes.length, 0);
  const targets = learningImprovementTargets(plan);
  assert.equal(targets.scope, 'workflow'); assert.deepEqual(targets.ids, ['worker']);
  assert.deepEqual(targets.nodes.map(node => node.type), ['tool']);
});

test('the learning form submits the graph-owned tools or workflow scope without any Skill prerequisite', async () => {
  for (const scope of ['tools', 'workflow']) {
    const document = learningDocument(scope), before = structuredClone(document), requests = [];
    const editor = { doc: document, prepareRun: async () => structuredClone(document) };
    const ui = Object.assign(Object.create(WorkflowLearningUI.prototype), { editor, runtime: { editor, getBackend: () => ({ state: 'ready' }), activeRun: () => null },
      activeJob: () => null, setExpanded() {}, syncMode() {}, updateRunButton() {}, render() {}, showNotice(value) { this.notice = value; },
      maxRounds: { value: '2' }, targetScore: { value: '100' }, rubric: { value: '输出结构正确' }, dataset: { trainingCases: [{ id: 'train', name: '训练', input: { text: 'a' }, expected: { text: 'a' } }], validationCases: [] },
      revisions: new Map(), revision: 0, jobs: new Map(), storeJob(value) { this.jobs.set(value.id, value); },
      api: async (path, options) => { requests.push({ path, body: options.body }); return { id: 'learning-test', workflowId: document.id, status: 'running' }; } });
    await ui.start(); assert.equal(requests.length, 1, ui.notice);
    assert.equal(requests[0].path, '/api/workflow-learning'); assert.equal(requests[0].body.scope, scope);
    assert.deepEqual(requests[0].body.trainableNodeIds, ['worker']); assert.deepEqual(document, before);
    assert.equal(learningSetupForDocument(document).scope, scope);
  }
});

test('tool improvement references clear on standalone derivation and remap when a workflow version is copied', () => {
  const document = learningDocument('tools'), improvement = document.nodes.find(node => node.type === 'improvement');
  const standalone = presetDefinitionFromNode(improvement); assert.deepEqual(standalone.node.config.targetNodeIds, []);
  let index = 0; const prepared = prepareWorkflowVersion(document, { title: '副本', upgradeNodes: false, addValidation: false, addStageOutputs: false, idFactory: prefix => `${prefix}-copy-${++index}` });
  const next = prepared.document, target = next.nodes.find(node => node.type === 'tool').id;
  assert.notEqual(target, 'worker'); assert.deepEqual(next.nodes.find(node => node.type === 'improvement').config.targetNodeIds, [target]);
  assert.deepEqual(improvement.config.targetNodeIds, ['worker']);
});

test('the editor applies selected tool code or a complete workflow candidate as one undo while keeping the current layout', () => {
  for (const scope of ['tools', 'workflow']) {
    const base = learningDocument(scope); let candidate = structuredClone(base); candidate.mode = 'execute';
    if (scope === 'tools') candidate.nodes.find(node => node.id === 'worker').config.code = 'return { ...input, normalized: true };';
    else {
      const edge = candidate.edges.find(edge => edge.sourceNode === 'worker' && edge.targetNode === 'output');
      candidate = applyWorkflowOperations(candidate, [{ op: 'add-node', ref: 'normalize', type: 'transform', title: '整理', x: 700, y: 240, config: { inputType: 'object', outputType: 'object', code: 'return { ...input, normalized: true };' } },
        { op: 'remove-edge', edgeId: edge.id }, { op: 'connect', sourceNode: 'worker', sourcePort: 'out', targetNode: 'normalize', targetPort: 'in' },
        { op: 'connect', sourceNode: 'normalize', sourcePort: 'out', targetNode: 'output', targetPort: 'in' }]).document;
    }
    const current = structuredClone(base); current.nodes.find(node => node.id === 'worker').x = 444; current.viewport.x = 99;
    const editor = Object.assign(Object.create(WorkflowEditor.prototype), { doc: current, propertyDrafts: new Map(), history: [], future: [], cancelGesture() {}, cancelConnection() {}, pruneSelection() {}, renderGraph() {}, renderProperties() {}, scheduleSave() {} });
    editor.applyLearningDocument(candidate, { baseDocument: base, scope, trainableNodeIds: ['worker'] });
    assert.equal(editor.doc.mode, 'execute'); assert.equal(editor.doc.nodes.find(node => node.id === 'worker').x, 444); assert.equal(editor.doc.viewport.x, 99); assert.equal(editor.history.length, 1);
    if (scope === 'tools') assert.match(editor.doc.nodes.find(node => node.id === 'worker').config.code, /normalized/);
    else assert.equal(editor.doc.nodes.filter(node => node.type === 'transform').length, 1);
  }
});

test('applying a tool-only best candidate forwards its scope, skips Skill discovery and reports a later refresh failure accurately', async () => {
  const document = learningDocument('tools'), candidate = structuredClone(document); candidate.mode = 'execute'; candidate.nodes.find(node => node.id === 'worker').config.code = 'return { normalized: true };';
  const sample = { id: 'train', name: '训练', input: { text: 'a' }, expected: { normalized: true } };
  const job = { id: 'learning-test', workflowId: document.id, document, status: 'complete', bestRound: 1, bestScore: 100, bestDocument: candidate,
    config: { scope: 'tools', targetScore: 100, trainableNodeIds: ['worker'], trainingCases: [sample], validationCases: [] }, rounds: [{ index: 1, status: 'complete', score: 100, cases: [{ ...sample, role: 'train', status: 'complete', output: { normalized: true }, score: 100 }] }] };
  let forwarded, notice;
  const ui = Object.assign(Object.create(WorkflowLearningUI.prototype), { editor: { doc: structuredClone(document), propertyDrafts: new Map(), applyLearningDocument(_document, options) { forwarded = options; }, toast() {} },
    runtime: { async loadSkills() { assert.fail('Tool-only candidate must not query the Skill catalog'); }, refreshBackend() { throw Error('界面刷新中断'); }, showNotice(value) { notice = value; }, setExpanded() {} },
    jobs: new Map([[job.id, job]]), jobId: job.id, render() {}, syncMode() {}, showNotice(value) { notice = value; },
    api: async () => ({ learningId: job.id, document: candidate, round: 1, score: 100 }) });
  await ui.applyBest(); assert.equal(forwarded.scope, 'tools'); assert.deepEqual(forwarded.trainableNodeIds, ['worker']);
  assert.match(notice, /已将.*应用到草稿.*刷新失败/); assert.doesNotMatch(notice, /候选未应用/);
});
