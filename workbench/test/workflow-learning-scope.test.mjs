import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';
import { validateLearningCandidate, mergeLearningCandidate, learningSnapshotChanged } from '../shared/workflow/workflow-learning-scope.mjs';

const revision = 'sha256:' + 'a'.repeat(64), improved = 'sha256:' + 'b'.repeat(64);
function graph(scope = 'skills') {
  let document = createDocument({ schemaVersion: 2, title: '固定学习目标' }); document.mode = 'learn';
  document.nodes = [
    createNode('input', {}, { id: 'input', config: { outputType: 'text', defaultValue: '演示输入' } }),
    createNode('skill', {}, { id: 'skill', config: { skillRef: 'source-skill', version: revision, inputType: 'text', outputType: 'text' } }),
    createNode('tool', {}, { id: 'worker', config: { executionMode: 'code', code: 'return input;', inputType: 'text', outputType: 'text' } }),
    createNode('output', {}, { id: 'output' }),
    createNode('evaluation', {}, { id: 'evaluation', config: { comparison: 'exact' } }),
    createNode('improvement', {}, { id: 'improvement', config: { scope, ...(scope === 'skills' ? { targetSkillNodeIds: ['skill'] } : scope === 'tools' ? { targetNodeIds: ['worker'] } : {}) } }),
  ];
  for (const [sourceNode, targetNode, sourcePort = 'out'] of [['input', 'skill'], ['skill', 'worker'], ['worker', 'output'], ['output', 'evaluation', 'learning'], ['evaluation', 'improvement']]) {
    document = connectNodes(document, { sourceNode, sourcePort, targetNode, targetPort: 'in' });
  }
  return document;
}

test('Skill learning changes only selected fixed references and preserves its base snapshot', () => {
  const before = graph(), candidate = structuredClone(before);
  candidate.nodes.find(node => node.id === 'skill').config.skillRef = 'wb-learn-candidate';
  candidate.nodes.find(node => node.id === 'skill').config.version = improved;
  const saved = structuredClone(before), result = validateLearningCandidate(before, candidate, { trainableNodeIds: ['skill'] });
  assert.equal(result.mode, 'execute'); assert.equal(result.nodes.find(node => node.id === 'skill').config.version, improved);
  assert.deepEqual(before, saved);
  candidate.nodes.find(node => node.id === 'worker').config.code = 'return "unselected";';
  assert.throws(() => validateLearningCandidate(before, candidate, { trainableNodeIds: ['skill'] }), /范围|Skill|目标|修改/);
});

test('specified tool learning changes business code while keeping its execution and graph contracts', () => {
  const base = graph('tools'), candidate = structuredClone(base), options = { scope: 'tools', trainableNodeIds: ['worker'] };
  candidate.nodes.find(node => node.id === 'worker').config.code = 'return input.toLowerCase();';
  assert.equal(validateLearningCandidate(base, candidate, options).nodes.find(node => node.id === 'worker').config.code, 'return input.toLowerCase();');
  for (const mutate of [
    document => { document.nodes.find(node => node.id === 'worker').config.timeoutSeconds++; },
    document => { document.nodes.find(node => node.id === 'worker').config.resource = 'build'; },
    document => { document.nodes.find(node => node.id === 'skill').config.version = improved; },
    document => { document.nodes.find(node => node.id === 'worker').title = '掩饰修改'; },
    document => { document.edges.reverse(); },
    document => { document.nodes.reverse(); },
  ]) {
    const invalid = structuredClone(candidate); mutate(invalid);
    assert.throws(() => validateLearningCandidate(base, invalid, options), /工具学习|配置|目标|范围/);
  }
});

test('scope and target identities come from the frozen graph rather than caller expansion', () => {
  const base = graph('tools');
  for (const options of [
    { scope: 'skills', trainableNodeIds: ['skill'] }, { scope: 'workflow', trainableNodeIds: [] },
    { scope: 'tools', trainableNodeIds: [] }, { scope: 'tools', trainableNodeIds: ['worker', 'skill'] },
    { scope: 'tools', trainableNodeIds: ['worker', 'worker'] },
  ]) assert.throws(() => validateLearningCandidate(base, base, options), /范围|目标/);
  let reads = 0;
  assert.throws(() => validateLearningCandidate(base, base, { get scope() { reads++; return 'tools'; }, trainableNodeIds: ['worker'] }), /选项/);
  assert.equal(reads, 0);
});

function workflowCandidate(base) {
  let candidate = structuredClone(base);
  candidate.nodes = candidate.nodes.filter(node => node.id !== 'worker');
  candidate.edges = candidate.edges.filter(edge => !['worker'].includes(edge.sourceNode) && !['worker'].includes(edge.targetNode));
  candidate.nodes.push(createNode('transform', { x: 800, y: 180 }, { id: 'new-worker', title: '规范化文字', config: { inputType: 'text', outputType: 'text', code: 'return input.toLowerCase();' } }));
  candidate = connectNodes(candidate, { sourceNode: 'skill', sourcePort: 'out', targetNode: 'new-worker', targetPort: 'in' });
  return connectNodes(candidate, { sourceNode: 'new-worker', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
}

test('workflow learning can replace an internal business step and reconnect its graph', () => {
  const base = graph('workflow'), candidate = workflowCandidate(base), saved = structuredClone(base);
  const result = validateLearningCandidate(base, candidate, { scope: 'workflow' });
  assert.equal(result.mode, 'execute'); assert.equal(result.nodes.some(node => node.id === 'worker'), false);
  assert.equal(result.nodes.find(node => node.id === 'new-worker').config.code, 'return input.toLowerCase();');
  assert.deepEqual(base, saved);
  assert.doesNotThrow(() => validateLearningCandidate(base, candidate, { scope: 'workflow', trainableNodeIds: ['skill', 'worker'] }));
});

test('workflow learning freezes identity, inputs, results, comparison rules and provenance', () => {
  const base = graph('workflow');
  base.nodes.find(node => node.id === 'worker').origin = { kind: 'preset', id: 'preset-original-worker', version: 1, title: '原工具', baseType: 'tool' };
  for (const mutate of [
    document => { document.id = 'foreign-workflow'; },
    document => { document.title = '改评分目标'; },
    document => { document.settings.outputDirectory = '/unapproved'; },
    document => { document.nodes.find(node => node.id === 'input').config.defaultValue = '已知答案'; },
    document => { document.nodes.find(node => node.id === 'output').config.fileName = 'changed.json'; },
    document => { document.nodes.find(node => node.id === 'evaluation').config.comparison = 'model'; },
    document => { document.nodes.find(node => node.id === 'evaluation').config.valuePath = 'answer'; },
    document => { document.nodes.find(node => node.id === 'improvement').config.scope = 'tools'; },
    document => { document.nodes.find(node => node.id === 'worker').origin.version++; },
    document => { document.nodes.find(node => node.id === 'skill').config.version = improved; },
  ]) {
    const candidate = structuredClone(base); mutate(candidate);
    assert.throws(() => validateLearningCandidate(base, candidate, { scope: 'workflow' }), /不能|来源|固定|支路|目标/);
  }
});

test('workflow learning may improve an observed tool implementation without changing its comparison interface', () => {
  const base = graph('workflow');
  const observation = base.edges.find(edge => edge.targetNode === 'evaluation'); observation.sourceNode = 'worker'; observation.sourcePort = 'out';
  const candidate = structuredClone(base); candidate.nodes.find(node => node.id === 'worker').config.code = 'return input.toLowerCase();';
  assert.doesNotThrow(() => validateLearningCandidate(base, candidate, { scope: 'workflow' }));
  for (const mutate of [
    document => { document.nodes.find(node => node.id === 'worker').config.outputType = 'any'; },
    document => { document.nodes.find(node => node.id === 'worker').ports = { inputs: [{ id: 'in', label: '输入', type: 'text' }], outputs: [{ id: 'out', label: '输出', type: 'text', valuePath: 'answer' }] }; },
    document => { document.edges.find(edge => edge.targetNode === 'evaluation').sourceNode = 'output'; document.edges.find(edge => edge.targetNode === 'evaluation').sourcePort = 'learning'; },
  ]) {
    const invalid = structuredClone(candidate); mutate(invalid);
    assert.throws(() => validateLearningCandidate(base, invalid, { scope: 'workflow' }), /比较|支路|接口/);
  }
});

test('new Skills reuse only the original graph fixed reference and new nodes cannot invent provenance', () => {
  const base = graph('workflow'); let candidate = structuredClone(base);
  const source = candidate.nodes.find(node => node.id === 'skill');
  candidate.nodes.push({ ...structuredClone(source), id: 'new-skill' });
  candidate.edges = candidate.edges.filter(edge => !(edge.sourceNode === 'skill' && edge.targetNode === 'worker'));
  candidate = connectNodes(candidate, { sourceNode: 'skill', sourcePort: 'out', targetNode: 'new-skill', targetPort: 'in' });
  candidate = connectNodes(candidate, { sourceNode: 'new-skill', sourcePort: 'out', targetNode: 'worker', targetPort: 'in' });
  assert.doesNotThrow(() => validateLearningCandidate(base, candidate, { scope: 'workflow' }));
  const invented = structuredClone(candidate); invented.nodes.find(node => node.id === 'new-skill').config.skillRef = 'unknown-skill';
  assert.throws(() => validateLearningCandidate(base, invented, { scope: 'workflow' }), /真实|固定/);
  const fakeOrigin = structuredClone(candidate); fakeOrigin.nodes.find(node => node.id === 'new-skill').origin = { kind: 'preset', id: 'imaginary-parent', version: 1, title: '伪造派生', baseType: 'skill' };
  assert.throws(() => validateLearningCandidate(base, fakeOrigin, { scope: 'workflow' }), /来源/);
});

test('workflow learning cannot smuggle new or modified referenced subflow snapshots', () => {
  let base = graph('workflow');
  base.nodes.push(createNode('subflow', {}, { id: 'fixed-child', config: { inputType: 'text', outputType: 'text', workflowRef: 'workflow-known-child', version: revision } }));
  base.edges = base.edges.filter(edge => !(edge.sourceNode === 'skill' && edge.targetNode === 'worker'));
  base = connectNodes(base, { sourceNode: 'skill', sourcePort: 'out', targetNode: 'fixed-child', targetPort: 'in' });
  base = connectNodes(base, { sourceNode: 'fixed-child', sourcePort: 'out', targetNode: 'worker', targetPort: 'in' });
  const replaced = structuredClone(base); replaced.nodes.find(node => node.id === 'fixed-child').config.workflowRef = 'workflow-unapproved-child';
  assert.throws(() => validateLearningCandidate(base, replaced, { scope: 'workflow' }), /子流程来源/);
  const altered = structuredClone(base); altered.nodes.find(node => node.id === 'fixed-child').config.version = improved;
  assert.throws(() => validateLearningCandidate(base, altered, { scope: 'workflow' }), /子流程来源/);
  let added = structuredClone(base);
  added.nodes.push(createNode('subflow', {}, { id: 'new-child', config: { inputType: 'text', outputType: 'text', workflowRef: 'workflow-unapproved-child', version: revision } }));
  added.edges = added.edges.filter(edge => !(edge.sourceNode === 'worker' && edge.targetNode === 'output'));
  added = connectNodes(added, { sourceNode: 'worker', sourcePort: 'out', targetNode: 'new-child', targetPort: 'in' });
  added = connectNodes(added, { sourceNode: 'new-child', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
  assert.throws(() => validateLearningCandidate(base, added, { scope: 'workflow' }), /子流程.*来源/);
});

function reviewedGraph() {
  let base = graph('workflow');
  base.nodes.find(node => node.id === 'worker').config.reviewImages = true;
  base.nodes.push(createNode('human', {}, { id: 'review', config: { inputType: 'text', outputType: 'text', reviewTargetNodeId: 'worker', prompt: '确认产物' } }));
  base.edges = base.edges.filter(edge => !(edge.sourceNode === 'worker' && edge.targetNode === 'output'));
  base = connectNodes(base, { sourceNode: 'worker', sourcePort: 'out', targetNode: 'review', targetPort: 'in' });
  return connectNodes(base, { sourceNode: 'review', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
}

test('workflow candidates cannot disable image review, remove human gates or reconnect around them', () => {
  const base = reviewedGraph();
  for (const mutate of [
    document => { document.nodes.find(node => node.id === 'worker').config.reviewImages = false; },
    document => { document.nodes.find(node => node.id === 'review').config.prompt = '直接批准'; },
    document => { document.nodes = document.nodes.filter(node => node.id !== 'review'); document.edges = document.edges.filter(edge => edge.sourceNode !== 'review' && edge.targetNode !== 'review'); document.edges.push({ id: 'bypass', sourceNode: 'worker', sourcePort: 'out', targetNode: 'output', targetPort: 'in' }); },
    document => { document.edges.push({ id: 'extra-bypass', sourceNode: 'worker', sourcePort: 'out', targetNode: 'output', targetPort: 'in' }); },
  ]) {
    const candidate = structuredClone(base); mutate(candidate);
    assert.throws(() => validateLearningCandidate(base, candidate, { scope: 'workflow' }), /审核|人工|必填|图片|端口/);
  }
});

test('workflow learning may add a real human gate for a new image-producing business step', () => {
  const base = graph('workflow'); let candidate = structuredClone(base);
  candidate.nodes.find(node => node.id === 'worker').config.reviewImages = true;
  candidate.nodes.push(createNode('human', {}, { id: 'new-review', config: { inputType: 'text', outputType: 'text', prompt: '核对本轮产物', reviewTargetNodeId: 'worker' } }));
  candidate.edges = candidate.edges.filter(edge => !(edge.sourceNode === 'worker' && edge.targetNode === 'output'));
  candidate = connectNodes(candidate, { sourceNode: 'worker', sourcePort: 'out', targetNode: 'new-review', targetPort: 'in' });
  candidate = connectNodes(candidate, { sourceNode: 'new-review', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
  assert.doesNotThrow(() => validateLearningCandidate(base, candidate, { scope: 'workflow' }));
});

test('merge protects later edits and keeps current camera and positions when applying graph changes', () => {
  const base = graph('workflow'), candidate = workflowCandidate(base), current = structuredClone(base);
  current.mode = 'execute'; current.viewport = { x: 120, y: -80, zoom: 0.5 }; current.nodes.find(node => node.id === 'skill').x = 450;
  const result = mergeLearningCandidate(current, candidate, { baseDocument: base, scope: 'workflow' });
  assert.deepEqual(result.viewport, current.viewport); assert.equal(result.nodes.find(node => node.id === 'skill').x, 450);
  assert.equal(result.nodes.find(node => node.id === 'new-worker').x, 800);
  current.nodes.find(node => node.id === 'skill').config.version = improved;
  assert.throws(() => mergeLearningCandidate(current, candidate, { baseDocument: base, scope: 'workflow' }), /草稿已变化/);
});

test('snapshot guard observes parent provenance and order without invoking unsafe accessors', () => {
  const base = graph(), moved = structuredClone(base); moved.mode = 'execute'; moved.viewport.x += 5; moved.nodes[0].x += 30;
  assert.equal(learningSnapshotChanged(base, moved), false);
  moved.nodes[1].origin = { kind: 'preset', id: 'source', version: 1, title: '来源', baseType: 'skill' };
  assert.equal(learningSnapshotChanged(base, moved), true);
  const reordered = structuredClone(base); reordered.nodes.reverse(); assert.equal(learningSnapshotChanged(base, reordered), true);
  let reads = 0; const unsafe = structuredClone(base); Object.defineProperty(unsafe.nodes[1], 'origin', { enumerable: true, get() { reads++; return null; } });
  assert.equal(learningSnapshotChanged(base, unsafe), true); assert.equal(reads, 0);
});

test('old Skill feedback without a learning branch remains bounded to selected original Skill references', () => {
  const base = graph(); base.nodes = base.nodes.filter(node => !['evaluation', 'improvement'].includes(node.type));
  const ids = new Set(base.nodes.map(node => node.id)); base.edges = base.edges.filter(edge => ids.has(edge.sourceNode) && ids.has(edge.targetNode));
  const candidate = structuredClone(base); candidate.nodes.find(node => node.id === 'skill').config.version = improved;
  assert.doesNotThrow(() => mergeLearningCandidate(base, candidate, { baseDocument: base, trainableNodeIds: ['skill'] }));
  assert.throws(() => validateLearningCandidate(base, base, { scope: 'tools', trainableNodeIds: ['worker'] }), /支路|连接/);
});

test('Skill feedback may narrow the graph-approved Skill targets without changing the unselected Skill', () => {
  let base = graph();
  base.nodes.push(createNode('skill', {}, { id: 'second-skill', config: { skillRef: 'second-source', version: revision, inputType: 'text', outputType: 'text' } }));
  base.nodes.find(node => node.id === 'improvement').config.targetSkillNodeIds = ['skill', 'second-skill'];
  base.edges = base.edges.filter(edge => !(edge.sourceNode === 'skill' && edge.targetNode === 'worker'));
  base = connectNodes(base, { sourceNode: 'skill', sourcePort: 'out', targetNode: 'second-skill', targetPort: 'in' });
  base = connectNodes(base, { sourceNode: 'second-skill', sourcePort: 'out', targetNode: 'worker', targetPort: 'in' });
  const candidate = structuredClone(base); candidate.nodes.find(node => node.id === 'skill').config.version = improved;
  assert.doesNotThrow(() => validateLearningCandidate(base, candidate, { trainableNodeIds: ['skill'] }));
  candidate.nodes.find(node => node.id === 'second-skill').config.version = improved;
  assert.throws(() => validateLearningCandidate(base, candidate, { trainableNodeIds: ['skill'] }), /只能修改/);
});
