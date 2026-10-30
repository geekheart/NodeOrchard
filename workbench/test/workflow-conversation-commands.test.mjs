import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, createNode, connectNodes, getPorts } from '../shared/workflow/workflow-model.mjs';
import { applyWorkflowOperations, documentFingerprint, sameDocumentContent } from '../shared/workflow/workflow-conversation-commands.mjs';

const blank = () => createDocument({ schemaVersion: 2, title: '对话操作测试' });
const factory = () => { let count = 0; return prefix => `${prefix}-${++count}`; };
const trimFlow = () => [
  { op: 'add-node', ref: 'source', type: 'input', title: '文本输入', config: { outputType: 'text' } },
  { op: 'add-node', ref: 'trim', type: 'tool', config: { executionMode: 'tool', toolName: 'text.trim' } },
  { op: 'add-node', ref: 'result', type: 'output', title: '输出' },
  { op: 'connect', sourceNode: 'source', sourcePort: 'out', targetNode: 'trim', targetPort: 'in' },
  { op: 'connect', sourceNode: 'trim', sourcePort: 'out', targetNode: 'result', targetPort: 'in' },
];

test('layout-only content comparison preserves the strict plan fingerprint and all business fields', () => {
  const document = applyWorkflowOperations(blank(), trimFlow(), { idFactory: factory() }).document;
  const arranged = { ...structuredClone(document), viewport: { x: 50, y: 80, zoom: .5 }, nodes: document.nodes.map(node => ({ ...node, x: node.x + 64, y: node.y + 80 })) };
  assert.equal(sameDocumentContent(document, arranged), true); assert.notEqual(documentFingerprint(document), documentFingerprint(arranged));
  const changed = structuredClone(arranged); changed.nodes[1].config.toolName = 'text.uppercase';
  assert.equal(sameDocumentContent(document, changed), false);
  const disconnected = { ...arranged, edges: [] }; assert.equal(sameDocumentContent(document, disconnected), false);
});

test('layout-only comparison does not ignore changes inside an embedded workflow', () => {
  const child = blank(); child.nodes.push(createNode('input', { x: 1, y: 2 }, { id: 'child-input' }));
  const document = blank(); document.nodes.push(createNode('subflow', {}, { id: 'subflow', config: { document: child } }));
  const changed = structuredClone(document); changed.nodes[0].config.document.nodes[0].x = 99;
  assert.equal(sameDocumentContent(document, changed), false);
});

test('semantic edit batch creates typed manual-model nodes and edges without mutating original', () => {
  const document = blank(), original = structuredClone(document), operations = trimFlow(), originalOperations = structuredClone(operations);
  const result = applyWorkflowOperations(document, operations, { idFactory: factory() });
  assert.deepEqual(document, original); assert.deepEqual(operations, originalOperations);
  assert.equal(result.document.id, document.id); assert.equal(result.document.nodes.length, 3); assert.equal(result.document.edges.length, 2);
  assert.equal(result.document.nodes[1].config.toolName, 'text.trim'); assert.equal(result.document.nodes[1].config.inputType, 'text');
  assert.equal(result.document.nodes[2].config.stage, 'final'); assert.equal(result.createdIds.source, 'node-1'); assert.equal(result.summary.length, 5);
});

test('invalid later operation atomically rejects the entire batch and checks typed ports', () => {
  const document = blank(), before = structuredClone(document);
  assert.throws(() => applyWorkflowOperations(document, [...trimFlow(), { op: 'connect', sourceNode: 'source', sourcePort: 'in', targetNode: 'result', targetPort: 'in' }]), /第 6 项.*端口/);
  assert.deepEqual(document, before);
  const wrongType = trimFlow(); wrongType[0].config.outputType = 'object';
  assert.throws(() => applyWorkflowOperations(document, wrongType), /端口类型不兼容/); assert.deepEqual(document, before);
});

test('connect uses registered generic tool types and preserves explicit review configuration', () => {
  const result = applyWorkflowOperations(blank(), [{ op: 'add-node', ref: 'keys', type: 'tool', config: { executionMode: 'tool', toolName: 'json.keys', reviewImages: false } }]);
  const tool = result.document.nodes[0]; assert.deepEqual(getPorts(tool).inputs.map(row => row.id), ['in']);
  assert.equal(tool.config.inputType, 'object'); assert.equal(tool.config.outputType, 'array'); assert.equal(tool.config.reviewImages, false);
  assert.throws(() => applyWorkflowOperations(blank(), [{ op: 'add-node', ref: 'bad', type: 'tool', config: { toolName: 'secret.exec' } }]), /已注册/);
  const switched = applyWorkflowOperations(result.document, [{ op: 'update-node', nodeId: tool.id, config: { toolName: 'text.trim' } }]).document.nodes[0];
  assert.deepEqual(getPorts(switched).inputs.map(row => row.id), ['in']); assert.equal(getPorts(switched).inputs[0].type, 'text');
});

test('review and Skill-improvement references resolve only to prior commands in the same batch', () => {
  const result = applyWorkflowOperations(blank(), [
    { op: 'add-node', ref: 'skill', type: 'skill' },
    { op: 'add-node', ref: 'human', type: 'human', config: { reviewTargetNodeId: 'skill' } },
    { op: 'add-node', ref: 'improve', type: 'improvement', config: { targetSkillNodeIds: ['skill'] } },
  ]);
  assert.equal(result.document.nodes[1].config.reviewTargetNodeId, result.createdIds.skill);
  assert.deepEqual(result.document.nodes[2].config.targetSkillNodeIds, [result.createdIds.skill]);
});

test('configure, title and explicit remove/reconnect match ordinary editor operations', () => {
  const created = applyWorkflowOperations(blank(), trimFlow(), { idFactory: factory() });
  const edge = created.document.edges[0], trim = created.document.nodes[1];
  const result = applyWorkflowOperations(created.document, [
    { op: 'update-node', nodeId: trim.id, title: '大写处理', config: { toolName: 'text.uppercase' }, x: 900, y: 220 },
    { op: 'set-title', title: '新名称' }, { op: 'remove-edge', edgeId: edge.id },
    { op: 'connect', sourceNode: edge.sourceNode, sourcePort: edge.sourcePort, targetNode: edge.targetNode, targetPort: edge.targetPort },
    { op: 'remove-node', nodeId: created.document.nodes[2].id },
  ]);
  assert.equal(result.document.title, '新名称'); assert.equal(result.document.nodes[1].config.toolName, 'text.uppercase');
  assert.equal(result.document.nodes[1].x, 900); assert.equal(result.document.nodes.length, 2); assert.equal(result.document.edges.length, 1);
  assert.equal(created.document.nodes[1].config.toolName, 'text.trim');
});

test('parallel merge ports can be explicitly configured using the existing typed port schema', () => {
  const result = applyWorkflowOperations(blank(), [
    { op: 'add-node', ref: 'a', type: 'input', config: { outputType: 'text' } },
    { op: 'add-node', ref: 'b', type: 'input', config: { outputType: 'text' } },
    { op: 'add-node', ref: 'merge', type: 'merge', ports: { inputs: [{ id: 'left', label: '左', type: 'text', required: true }, { id: 'right', label: '右', type: 'text', required: true }], outputs: [{ id: 'out', label: '汇总', type: 'object' }] } },
    { op: 'connect', sourceNode: 'a', sourcePort: 'out', targetNode: 'merge', targetPort: 'left' },
    { op: 'connect', sourceNode: 'b', sourcePort: 'out', targetNode: 'merge', targetPort: 'right' },
  ]);
  assert.equal(result.document.edges.length, 2); assert.equal(getPorts(result.document.nodes[2]).inputs.length, 2);
});

test('transport forbids wholesale replacement, nested documents, settings, scheduling, and arbitrary actions', () => {
  for (const operation of [
    { op: 'replace-document', document: blank() }, { op: 'run' }, { op: 'approve' }, { op: 'set-mode', mode: 'learn' },
    { op: 'add-node', ref: 'test', type: 'subflow', config: { document: blank() } },
    { op: 'add-node', ref: 'test', type: 'input', config: { trigger: 'schedule' } },
    { op: 'set-title', title: '名称', id: 'different' },
  ]) assert.throws(() => applyWorkflowOperations(blank(), [operation]), /不允许|不支持|不能|定时/);
});

test('strict JSON rejects getters, prototype pollution, symbols, cycles, and reference collisions without evaluation', () => {
  let invoked = 0; const accessor = { op: 'set-title', get title() { invoked++; return '坏'; } };
  assert.throws(() => applyWorkflowOperations(blank(), [accessor]), /访问器/); assert.equal(invoked, 0);
  assert.throws(() => applyWorkflowOperations(blank(), JSON.parse('[{"op":"set-title","title":"坏","__proto__":{}}]')), /不安全/);
  assert.throws(() => applyWorkflowOperations(blank(), [{ op: 'add-node', ref: 'constructor', type: 'input' }]), /无效/);
  const cycle = []; cycle.push(cycle); assert.throws(() => applyWorkflowOperations(blank(), cycle), /循环引用/);
  const symbol = { op: 'set-title', title: '新', [Symbol()]: '坏' }; assert.throws(() => applyWorkflowOperations(blank(), [symbol]), /Symbol/);
  assert.throws(() => applyWorkflowOperations(blank(), [{ op: 'add-node', ref: 'same', type: 'input' }, { op: 'add-node', ref: 'same', type: 'input' }]), /重复/);
  assert.throws(() => applyWorkflowOperations(blank(), Array.from({ length: 65 }, () => ({ op: 'set-title', title: '多' }))), /最多 64/);
});

test('cycles, duplicate inputs, nonexistent removals and identity patches cannot bypass editor validation', () => {
  const created = applyWorkflowOperations(blank(), trimFlow());
  assert.throws(() => applyWorkflowOperations(created.document, [{ op: 'remove-node', nodeId: 'missing' }]), /不存在/);
  assert.throws(() => applyWorkflowOperations(created.document, [{ op: 'remove-edge', edgeId: 'missing' }]), /不存在/);
  assert.throws(() => applyWorkflowOperations(created.document, [{ op: 'update-node', nodeId: created.document.nodes[0].id, id: 'other' }]), /不允许/);
  const a = createNode('transform', { x: 0, y: 0 }, { id: 'a' }), b = createNode('transform', { x: 400, y: 0 }, { id: 'b' });
  const document = connectNodes({ ...blank(), nodes: [a, b] }, { sourceNode: 'a', sourcePort: 'out', targetNode: 'b', targetPort: 'in' });
  assert.throws(() => applyWorkflowOperations(document, [{ op: 'connect', sourceNode: 'b', sourcePort: 'out', targetNode: 'a', targetPort: 'in' }]), /形成环/);
});

test('fingerprint ignores object key order and camera movement but detects logical graph and mode changes', () => {
  const document = applyWorkflowOperations(blank(), trimFlow()).document, fingerprint = documentFingerprint(document);
  assert.equal(documentFingerprint({ ...document, viewport: { x: 500, y: -10, zoom: 2 } }), fingerprint);
  assert.equal(documentFingerprint(Object.fromEntries(Object.entries(document).reverse())), fingerprint);
  assert.notEqual(documentFingerprint({ ...document, title: '改变' }), fingerprint);
  assert.notEqual(documentFingerprint({ ...document, mode: 'learn' }), fingerprint);
  const changed = structuredClone(document); changed.nodes[0].config.required = false; assert.notEqual(documentFingerprint(changed), fingerprint);
});
