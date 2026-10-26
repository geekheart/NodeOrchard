import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, createNode, connectNodes, getPorts, validateDocument } from '../shared/workflow/workflow-model.mjs';
import { planWorkflow, learningBranch } from '../shared/workflow/workflow-plan.mjs';
import { builtinNodePresets } from '../shared/workflow/workflow-presets.mjs';
import { validateNodeValue } from '../shared/workflow/workflow-validation.mjs';
import { prepareWorkflowVersion } from '../shared/workflow/workflow-versioning.mjs';

const factory = () => { let index = 0; return prefix => `${prefix}-version-${++index}`; };
const sourceVersion = `sha256:${'a'.repeat(64)}`;
function node(type, id, config = {}, ports) {
  return createNode(type, { x: 32, y: 64 }, { id, title: id,
    config: { ...(['input'].includes(type) ? { outputType: 'object' }
      : ['skill', 'tool', 'human', 'merge', 'subflow', 'validation'].includes(type) ? { inputType: 'object', outputType: 'object' } : {}), ...config },
    ...(ports ? { ports } : {}) });
}
function graph(nodes, edges, settings = { maxConcurrency: 3, outputDirectory: '/prepared/output' }) {
  let document = { ...createDocument({ schemaVersion: 2, title: '来源工作流', settings }), id: 'workflow-source', nodes };
  for (const [sourceNode, targetNode, targetPort = 'in', sourcePort = 'out'] of edges) document = connectNodes(document, { sourceNode, sourcePort, targetNode, targetPort });
  return validateDocument(document);
}
function simple(fields = [{ key: 'sourcePath', label: '工程文件', kind: 'file', required: true, extensions: ['.epro2'], role: 'source' },
  { key: 'count', label: '数量', kind: 'number', required: true }]) {
  return graph([node('input', 'input', { fieldName: 'preparedInput', fields, value: null }),
    node('tool', 'trim', { executionMode: 'tool', toolName: 'json.keys', resource: 'default', timeoutSeconds: 180, outputType: 'array' }),
    node('output', 'final')], [['input', 'trim'], ['trim', 'final']]);
}
function reviewSkills() {
  const nodes = [node('input', 'input', { fields: [{ key: 'sourcePath', label: '工程文件', kind: 'file', required: true }] })];
  const edges = [];
  for (const [index, toolName, resource] of [['a', 'hdk.full.native', 'eda'], ['b', 'hdk.full.process', 'default'], ['c', 'hdk.full.sop', 'default']]) {
    nodes.push(node('skill', `skill-${index}`, { skillRef: `skill-${index}-ref`, version: sourceVersion, timeoutSeconds: 300 }));
    const preset = builtinNodePresets().find(row => row.toolName === toolName);
    nodes.push(node('tool', `tool-${index}`, { executionMode: 'tool', toolName, resource, timeoutSeconds: 600,
      reviewImages: true, code: '', language: 'javascript' }, preset.definition.node.ports));
    nodes.push(node('human', `human-${index}`, { reviewTargetNodeId: `skill-${index}`, prompt: '核对当前实际产物，要求修改会回到指定 Skill。' }));
    edges.push(['input', `skill-${index}`], ['input', `tool-${index}`, 'facts'], [`skill-${index}`, `tool-${index}`, 'plan'], [`tool-${index}`, `human-${index}`], [`human-${index}`, 'merge', index]);
    if (index === 'c') edges.push(['input', `tool-${index}`, 'firmware']);
  }
  nodes.push(node('merge', 'merge', {}, { inputs: ['a', 'b', 'c'].map(id => ({ id, label: id, type: 'object', required: true })), outputs: [{ id: 'out', label: '汇总', type: 'object' }] }),
    node('output', 'final'), node('evaluation', 'evaluation', { comparison: 'model', valuePath: 'learningComparison' }),
    node('improvement', 'improvement', { targetSkillNodeIds: ['skill-a', 'skill-b', 'skill-c'] }));
  edges.push(['merge', 'final'], ['final', 'evaluation', 'in', 'learning'], ['evaluation', 'improvement']);
  return graph(nodes, edges);
}

test('new version is deterministic with injected IDs, independent, and leaves original configuration untouched', () => {
  const source = simple(), before = structuredClone(source);
  const first = prepareWorkflowVersion(source, { title: '新版节点', idFactory: factory() });
  const second = prepareWorkflowVersion(source, { title: '新版节点', idFactory: factory() });
  assert.deepEqual(first, second); assert.deepEqual(source, before);
  assert.notEqual(first.document.id, source.id); assert.equal(first.document.title, '新版节点');
  assert.deepEqual(first.document.settings, source.settings); assert.equal(first.document.mode, source.mode);
  const allOldIds = new Set([source.id, ...source.nodes.map(row => row.id), ...source.edges.map(row => row.id)]);
  for (const id of [first.document.id, ...first.document.nodes.map(row => row.id), ...first.document.edges.map(row => row.id)]) assert.equal(allOldIds.has(id), false);
  for (const old of source.nodes) {
    const fresh = first.document.nodes.find(row => row.id === first.report.nodeIdMap[old.id]);
    const expected = structuredClone(old.config); if (old.type === 'output') expected.stage = 'final';
    assert.deepEqual(fresh.config, expected);
    assert.deepEqual(fresh.ports, old.ports);
  }
  assert.equal(first.report.toolPresets, 1); assert.equal(first.report.validationNodes, 1);
  assert.equal(first.report.rootNodeCount, 4); assert.equal(first.report.planValidated, true);
  assert.doesNotThrow(() => planWorkflow(first.document));
});

test('all required input branches pass through typed checks, including numeric zero and missing-file feedback', () => {
  const source = simple(), result = prepareWorkflowVersion(source, { idFactory: factory() }), doc = result.document;
  const input = doc.nodes.find(row => row.type === 'input'), check = doc.nodes.find(row => row.type === 'validation');
  assert.equal(check.config.inputType, input.config.outputType); assert.equal(check.config.outputType, input.config.outputType);
  assert.equal(doc.edges.filter(edge => edge.sourceNode === input.id).length, 1);
  assert(doc.edges.some(edge => edge.sourceNode === check.id && edge.targetNode === result.report.nodeIdMap.trim));
  assert.equal(check.config.rules.filter(rule => rule.valuePath === 'count' && rule.check === 'nonempty').length, 0);
  assert.doesNotThrow(() => validateNodeValue({ sourcePath: '/prepared/input.epro2', count: 0 }, check.config.rules));
  assert.throws(() => validateNodeValue({ sourcePath: ' ', count: 0 }, check.config.rules), /工程文件不能为空/);
  assert.throws(() => validateNodeValue({ sourcePath: '/prepared/input.epro2', count: '0' }, check.config.rules), /数量应为数字/);
  assert.throws(() => validateNodeValue({ count: 0 }, check.config.rules), /请准备工程文件/);
});

test('three Skill plans, directly consumed human approvals, learning observation, and pinned versions survive upgrade', () => {
  const source = reviewSkills(), before = structuredClone(source);
  const result = prepareWorkflowVersion(source, { idFactory: factory() }), doc = result.document, ids = result.report.nodeIdMap;
  assert.deepEqual(source, before); assert.equal(result.report.skillCount, 3);
  assert.equal(result.report.toolPresets, 3); assert.equal(result.report.stageOutputs, 3);
  assert.deepEqual(result.report.learningTargets, ['a', 'b', 'c'].map(key => ids[`skill-${key}`]));
  for (const key of ['a', 'b', 'c']) {
    const oldSkill = source.nodes.find(row => row.id === `skill-${key}`), newSkill = doc.nodes.find(row => row.id === ids[`skill-${key}`]);
    assert.deepEqual(newSkill.config, oldSkill.config);
    assert(doc.edges.some(edge => edge.sourceNode === newSkill.id && edge.targetNode === ids[`tool-${key}`] && edge.targetPort === 'plan'));
    const human = doc.nodes.find(row => row.id === ids[`human-${key}`]);
    assert.equal(human.config.reviewTargetNodeId, newSkill.id);
    assert(doc.edges.some(edge => edge.sourceNode === human.id && edge.targetNode === ids.merge && edge.targetPort === key));
    const stage = result.report.details.stageOutputs.find(row => row.reviewNodeId === human.id);
    assert(doc.edges.some(edge => edge.sourceNode === human.id && edge.targetNode === stage.nodeId));
    assert.equal(doc.nodes.find(row => row.id === stage.nodeId).config.stage, 'intermediate');
  }
  const branch = learningBranch(doc);
  assert.equal(branch.sourceNodeId, ids.final); assert.equal(branch.sourcePort, 'learning');
  assert.equal(branch.evaluationNode.config.valuePath, 'learningComparison');
  assert.deepEqual(branch.improvementNode.config.targetSkillNodeIds, result.report.learningTargets);
  assert.equal(doc.nodes.at(-1).id, ids.final);
  assert.doesNotThrow(() => planWorkflow(doc));
});

test('preset source metadata is attached without replacing custom instance ports or tool configuration', () => {
  const source = simple();
  source.nodes.find(row => row.id === 'trim').config.timeoutSeconds = 777;
  const original = source.nodes.find(row => row.id === 'trim');
  original.ports = { inputs: [{ id: 'in', label: '保留我的输入名称', type: 'object', required: true }],
    outputs: [{ id: 'out', label: '保留我的结果名称', type: 'array', valuePath: '' }] };
  const { document, report } = prepareWorkflowVersion(source, { idFactory: factory() });
  const current = document.nodes.find(row => row.id === report.nodeIdMap.trim);
  assert.deepEqual(current.config, original.config);
  assert.deepEqual(current.ports, original.ports);
  assert.deepEqual(current.origin, { kind: 'preset', id: 'builtin-tool-json-keys', version: 1, title: '读取对象字段', baseType: 'tool' });
  original.origin = { kind: 'preset', id: 'my-special-preset', version: 5, title: '我的工具', baseType: 'tool' };
  const preserved = prepareWorkflowVersion(source, { idFactory: factory() });
  assert.deepEqual(preserved.document.nodes.find(row => row.id === preserved.report.nodeIdMap.trim).origin, original.origin);
  assert.equal(preserved.report.toolPresets, 0);
});

test('review-bound Pinout verifier still directly consumes the human node, never the new stage output', () => {
  const fromPreset = (name, id) => {
    const preset = builtinNodePresets().find(row => row.toolName === name);
    return node('tool', id, preset.definition.node.config, preset.definition.node.ports);
  };
  const source = graph([node('input', 'input', { fields: [{ key: 'sourcePath', label: '来源工程', kind: 'file', required: true }] }),
    node('skill', 'skill', { skillRef: 'pinout-layout', version: sourceVersion }),
    fromPreset('hdk.four.pinout-front', 'front'), fromPreset('hdk.four.pinout-back', 'back'),
    node('merge', 'images', {}, { inputs: [{ id: 'front', label: '正面', type: 'object', required: true }, { id: 'back', label: '背面', type: 'object', required: true }], outputs: [{ id: 'out', label: '两面图', type: 'object' }] }),
    node('human', 'review', { prompt: 'VO4，无 MAIN，核对当前两张实际图片。', reviewTargetNodeId: 'skill' }),
    fromPreset('hdk.pinout.verify', 'verify'), node('output', 'final')],
  [['input', 'skill'], ['input', 'front', 'facts'], ['input', 'back', 'facts'], ['skill', 'front', 'plan'], ['skill', 'back', 'plan'],
    ['front', 'images', 'front'], ['back', 'images', 'back'], ['images', 'review'], ['review', 'verify', 'images'], ['verify', 'final']]);
  const { document, report } = prepareWorkflowVersion(source, { idFactory: factory() }), ids = report.nodeIdMap;
  const consumed = document.edges.filter(edge => edge.targetNode === ids.verify && edge.targetPort === 'images');
  assert.equal(consumed.length, 1); assert.equal(consumed[0].sourceNode, ids.review);
  assert.equal(document.nodes.find(row => row.id === consumed[0].sourceNode).type, 'human');
  for (const side of ['front', 'back']) assert(document.edges.some(edge => edge.sourceNode === ids.skill && edge.targetNode === ids[side] && edge.targetPort === 'plan'));
  assert.equal(document.nodes.find(row => row.id === ids.review).config.reviewTargetNodeId, ids.skill);
  assert.equal(report.stageOutputs, 1); assert.match(report.notes[0], /不会重新导出上游图片/);
});

test('an existing reviewed stage output is reused while final output remains the focused last output', () => {
  const source = reviewSkills();
  source.nodes.push(node('output', 'existing-stage', { stage: 'intermediate', fileName: 'approved.json' }));
  source.edges.push({ id: 'existing-stage-edge', sourceNode: 'human-a', sourcePort: 'out', targetNode: 'existing-stage', targetPort: 'in' });
  const { document, report } = prepareWorkflowVersion(source, { idFactory: factory() });
  assert.equal(report.stageOutputs, 2);
  assert.equal(document.nodes.find(row => row.id === report.nodeIdMap['existing-stage']).config.fileName, 'approved.json');
  assert.equal(document.nodes.at(-1).id, report.nodeIdMap.final);
});

test('legacy outputs use business edges to distinguish intermediate stages from final learning observations', () => {
  const source = graph([node('input', 'input'), node('output', 'middle'), node('tool', 'tool', { code: 'return input;' }),
    node('output', 'final'), node('evaluation', 'evaluation'), node('improvement', 'improvement')],
  [['input', 'middle'], ['middle', 'tool'], ['tool', 'final'], ['final', 'evaluation', 'in', 'learning'], ['evaluation', 'improvement']]);
  const { document, report } = prepareWorkflowVersion(source, { idFactory: factory() });
  assert.equal(document.nodes.find(row => row.id === report.nodeIdMap.middle).config.stage, 'intermediate');
  assert.equal(document.nodes.find(row => row.id === report.nodeIdMap.final).config.stage, 'final');
  assert.equal(learningBranch(document).sourceNodeId, report.nodeIdMap.final);
  assert.equal(learningBranch(document).sourcePort, 'learning');
});

test('nested snapshots get fresh identities, remapped approval and multi-output projections, with stable public port IDs', () => {
  const child = reviewSkills(); child.id = 'workflow-child';
  child.nodes = child.nodes.filter(row => !['evaluation', 'improvement'].includes(row.type));
  child.edges = child.edges.filter(edge => !['evaluation', 'improvement'].includes(edge.targetNode) && edge.sourceNode !== 'evaluation');
  child.nodes.push(node('output', 'other-final', { stage: 'final' }));
  child.edges.push({ id: 'other-final-edge', sourceNode: 'merge', sourcePort: 'out', targetNode: 'other-final', targetPort: 'in' });
  const component = node('subflow', 'component', { document: child, workflowRef: '', maxDepth: 4 }, {
    inputs: [{ id: 'input', label: '内部资料', type: 'object', required: true }],
    outputs: [{ id: 'first', label: '首个结果', type: 'object', valuePath: 'final.someField' }, { id: 'second', label: '第二结果', type: 'object', valuePath: 'other-final' }],
  });
  const source = graph([node('input', 'root-input'), component, node('output', 'root-final')], [['root-input', 'component', 'input'], ['component', 'root-final', 'in', 'first']]);
  const { document, report } = prepareWorkflowVersion(source, { idFactory: factory() });
  const current = document.nodes.find(row => row.id === report.nodeIdMap.component), nested = current.config.document;
  assert.notEqual(nested.id, child.id); assert.equal(report.documentCount, 2);
  assert.deepEqual(current.ports.inputs, component.ports.inputs);
  assert.deepEqual(current.ports.outputs.map(row => row.id), ['first', 'second']);
  const nestedFinal = nested.nodes.find(row => row.title === 'final'), otherFinal = nested.nodes.find(row => row.title === 'other-final');
  assert.equal(current.ports.outputs[0].valuePath, `${nestedFinal.id}.someField`); assert.equal(current.ports.outputs[1].valuePath, otherFinal.id);
  const human = nested.nodes.find(row => row.title === 'human-a'), skill = nested.nodes.find(row => row.title === 'skill-a');
  assert.equal(human.config.reviewTargetNodeId, skill.id);
  assert.equal(Object.keys(report.nodeIdMap).length, source.nodes.length);
  const ids = new Set();
  for (const doc of [document, nested]) for (const id of [doc.id, ...doc.nodes.map(row => row.id), ...doc.edges.map(row => row.id)]) { assert(!ids.has(id)); ids.add(id); }
});

test('large required forms split checks into bounded validation nodes without dropping fields or fanout', () => {
  const fields = Array.from({ length: 32 }, (_, i) => ({ key: `field${i}`, label: `字段${i}`, kind: 'text', required: true }));
  const source = simple(fields), { document, report } = prepareWorkflowVersion(source, { idFactory: factory() });
  const checks = document.nodes.filter(row => row.type === 'validation');
  assert.equal(checks.length, 3); assert.equal(report.validationNodes, 3);
  assert.equal(checks.reduce((sum, row) => sum + row.config.rules.length, 0), 96);
  for (const check of checks) assert(check.config.rules.length <= 32);
  const input = Object.fromEntries(fields.map(field => [field.key, 'prepared']));
  for (const check of checks) assert.doesNotThrow(() => validateNodeValue(input, check.config.rules));
  assert.doesNotThrow(() => planWorkflow(document));
});

test('optional-only fields do not add blocking checks, and switches support cloning without node upgrade', () => {
  const source = simple([{ key: 'optional', label: '可选备注', kind: 'text', required: false }]);
  const result = prepareWorkflowVersion(source, { idFactory: factory() });
  assert.equal(result.report.validationNodes, 0);
  const plain = prepareWorkflowVersion(reviewSkills(), { upgradeNodes: false, addValidation: false, addStageOutputs: false, idFactory: factory() });
  assert.equal(plain.report.toolPresets, 0); assert.equal(plain.report.validationNodes, 0); assert.equal(plain.report.stageOutputs, 0);
  assert.equal(plain.document.nodes.length, reviewSkills().nodes.length);
  assert.equal(plain.document.nodes.some(row => row.origin), false);
});

test('source learning mode stays intact while its executable snapshot is statically checked', () => {
  const source = reviewSkills(); source.mode = 'learn';
  const result = prepareWorkflowVersion(source, { idFactory: factory() });
  assert.equal(result.document.mode, 'learn'); assert.equal(result.report.planValidated, true);
  assert.doesNotThrow(() => planWorkflow({ ...result.document, mode: 'execute' }));
});

test('invalid source, collisions, unsupported input projections, and malformed options fail before returning a new graph', () => {
  const source = simple();
  assert.throws(() => prepareWorkflowVersion(createDocument()), /v2/);
  assert.throws(() => prepareWorkflowVersion(source, { title: '' }), /名称/);
  assert.throws(() => prepareWorkflowVersion(source, { upgradeNodes: 'yes' }), /布尔/);
  assert.throws(() => prepareWorkflowVersion(source, { idFactory: 1 }), /函数/);
  assert.throws(() => prepareWorkflowVersion(source, { unknown: true }), /未知新版选项/);
  assert.throws(() => prepareWorkflowVersion(source, { idFactory: () => 'same-id' }), /唯一/);
  assert.throws(() => prepareWorkflowVersion(source, { idFactory: () => 'input' }), /旧版 ID/);
  assert.throws(() => prepareWorkflowVersion(source, { idFactory: () => '../unsafe' }), /有效/);
  source.nodes[0].ports = { inputs: [], outputs: [{ id: 'out', label: '投影', type: 'object', valuePath: 'project' }] };
  assert.throws(() => prepareWorkflowVersion(source, { idFactory: factory() }), /未投影/);
});
