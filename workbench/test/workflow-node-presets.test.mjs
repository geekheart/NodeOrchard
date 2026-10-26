import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { builtinNodePresets, instantiatePreset, presetDefinitionFromNode, validatePresetDefinition } from '../shared/workflow/workflow-presets.mjs';
import { createDocument, createNode, connectNodes, validateDocument } from '../shared/workflow/workflow-model.mjs';
import { WORKFLOW_TOOLS } from '../shared/workflow/workflow-tools.mjs';
import { WorkflowNodePresets } from '../src/workflows/workflow-node-presets.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const definition = () => presetDefinitionFromNode(createNode('tool', { x: 12, y: 24 }, {
  title: '去除空白', config: { executionMode: 'tool', toolName: 'text.trim', inputType: 'text', outputType: 'text', timeoutSeconds: 90 },
}));
function setup(t, file = ':memory:') {
  const db = new DatabaseSync(file); const events = [];
  const app = { store: { db }, publish: (...event) => events.push(copy(event)) };
  t.after(() => db.close());
  return { db, events, app, store: new WorkflowNodePresets(app) };
}

function component() {
  let document = createDocument({ title: '标注并审核', schemaVersion: 2 });
  document.settings.outputDirectory = '/private/old-delivery';
  document.nodes = [
    createNode('input', { x: 0, y: 0 }, { id: 'in', config: { outputType: 'object', sourceKind: 'file', path: '/private/input.epro2' } }),
    createNode('skill', { x: 200, y: 0 }, { id: 'skill', config: { skillRef: 'small-pinout', version: 'sha256-1234', inputType: 'object', outputType: 'object' } }),
    createNode('human', { x: 400, y: 0 }, { id: 'review', config: { reviewTargetNodeId: 'skill' } }),
    createNode('output', { x: 600, y: 0 }, { id: 'out' }),
    createNode('evaluation', { x: 600, y: 250 }, { id: 'compare' }),
    createNode('improvement', { x: 800, y: 250 }, { id: 'improve', config: { targetSkillNodeIds: ['skill'] } }),
  ];
  for (const edge of [
    ['in', 'out', 'skill', 'in'], ['skill', 'out', 'review', 'in'], ['review', 'out', 'out', 'in'],
    ['out', 'learning', 'compare', 'in'], ['compare', 'out', 'improve', 'in'],
  ]) document = connectNodes(document, { sourceNode: edge[0], sourcePort: edge[1], targetNode: edge[2], targetPort: edge[3] });
  return createNode('subflow', { x: 0, y: 0 }, { title: '生成并审核标注', config: { document, workflowRef: document.id } });
}

test('every builtin tool is a metadata-driven primitive preset with unchanged ports and execution defaults', () => {
  const records = builtinNodePresets();
  assert.equal(records.length, WORKFLOW_TOOLS.length);
  assert.equal(new Set(records.map(row => row.id)).size, records.length);
  for (const metadata of WORKFLOW_TOOLS) {
    const row = records.find(item => item.toolName === metadata.id);
    assert.equal(row.source, 'builtin'); assert.equal(row.baseType, 'tool'); assert.equal(row.version, 1);
    const node = instantiatePreset(row, { x: 400, y: 300 });
    assert.equal(node.config.toolName, metadata.id);
    assert.equal(node.config.executionMode, 'tool');
    assert.equal(node.config.inputType, metadata.inputType);
    assert.equal(node.config.outputType, metadata.outputType);
    assert.equal(node.config.reviewImages, metadata.reviewRequired === true || metadata.defaultConfig?.reviewImages === true);
    for (const [key, value] of Object.entries(metadata.defaultConfig || {})) assert.deepEqual(node.config[key], value);
    if (metadata.ports) assert.deepEqual(node.ports, metadata.ports);
    assert.deepEqual(node.origin, { id: row.id, version: 1, title: row.title, baseType: 'tool', kind: 'preset' });
  }
  records[0].definition.node.config.toolName = 'changed';
  assert.equal(builtinNodePresets()[0].definition.node.config.toolName, WORKFLOW_TOOLS[0].id);
});

test('user preset versions persist through store restart and older versions remain immutable', t => {
  const folder = mkdtempSync(join(tmpdir(), 'node-presets-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'presets.sqlite');
  const { app, store, events } = setup(t, file);
  const first = store.create({ definition: definition(), expectedRevision: 0 });
  const instance = instantiatePreset(first, { x: 50, y: 60 });
  const nextDefinition = copy(first.definition);
  nextDefinition.title = '新名称'; nextDefinition.node.config.timeoutSeconds = 300;
  const second = store.update(first.id, { definition: nextDefinition, expectedRevision: 1 });
  assert.equal(second.version, 2); assert.equal(second.revision, 2);
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(instance.config.timeoutSeconds, 90); assert.equal(instance.origin.version, 1);
  assert.equal(instance.title, '去除空白');
  const older = store.get(first.id, { version: 1 });
  assert.deepEqual(older.definition, first.definition); assert.equal(older.version, 1); assert.equal(older.revision, 2);
  const reopened = new WorkflowNodePresets(app);
  assert.deepEqual(reopened.get(first.id), second);
  const listed = reopened.list().find(row => row.id === first.id);
  assert.equal(listed.title, '新名称'); assert.equal(listed.source, 'user');
  assert.equal(Object.hasOwn(listed, 'definition'), false); assert.equal(events.length, 2);
  second.definition.node.config.timeoutSeconds = 999;
  assert.equal(store.get(first.id).definition.node.config.timeoutSeconds, 300);
});

test('update is explicit compare-and-swap, identical current updates do not add versions or events', t => {
  const { store, db, events } = setup(t);
  const first = store.create({ definition: definition() });
  assert.deepEqual(store.update(first.id, { definition: first.definition, expectedRevision: 1 }), first);
  assert.equal(events.length, 1);
  const changed = { ...first.definition, title: '第二版' };
  const second = store.update(first.id, { definition: changed, expectedRevision: 1 });
  for (const expectedRevision of [undefined, 0, -1, 1.5, '2']) assert.throws(() => store.update(first.id, { definition: changed, expectedRevision }), { httpStatus: 400 });
  for (const expectedRevision of [1, 3]) assert.throws(() => store.update(first.id, { definition: changed, expectedRevision }), { httpStatus: 409 });
  assert.deepEqual(store.get(first.id), second);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workflow_node_preset_versions').get().count, 2);
  assert.equal(events.length, 2);
  assert.throws(() => store.update('preset-missing', { definition: changed, expectedRevision: 1 }), { httpStatus: 404 });
});

test('builtin presets are available without database writes and cannot be overwritten', t => {
  const { db, store, events } = setup(t);
  const builtin = builtinNodePresets()[0];
  assert.deepEqual(store.get(builtin.id), builtin);
  assert.deepEqual(store.get(builtin.id, { version: 1 }), builtin);
  assert.throws(() => store.get(builtin.id, { version: 2 }), { httpStatus: 404 });
  assert.throws(() => store.update(builtin.id, { definition: definition(), expectedRevision: 1 }), { httpStatus: 409 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workflow_node_presets').get().count, 0);
  assert.equal(events.length, 0);
});

test('saving defaults removes explicit local paths, keeps relative names, code and pinned Skill settings', () => {
  const input = createNode('input', { x: 12, y: 30 }, { config: { sourceKind: 'file', path: '/fixtures/private/input.epro2', value: 'C:\\private\\input.epro2' } });
  const safe = presetDefinitionFromNode(input);
  assert.equal(safe.node.x, 0); assert.equal(safe.node.y, 0);
  assert.equal(safe.node.config.path, ''); assert.equal(safe.node.config.value, null);
  assert.equal(input.config.path, '/fixtures/private/input.epro2');
  const explicit = presetDefinitionFromNode(input, { includePaths: true });
  assert.equal(explicit.node.config.path, input.config.path);
  const relative = presetDefinitionFromNode({ ...input, config: { ...input.config, path: 'board/input.epro2', value: 'example' } });
  assert.equal(relative.node.config.path, 'board/input.epro2');
  const skill = createNode('skill', { x: 0, y: 0 }, { config: { skillRef: 'one-function', version: 'hash-pinned', timeoutSeconds: 999 } });
  assert.deepEqual(presetDefinitionFromNode(skill).node.config, skill.config);
  const tool = createNode('tool', { x: 0, y: 0 }, { config: { code: "return '/fixtures/required-by-code';", language: 'javascript' } });
  assert.equal(presetDefinitionFromNode(tool).node.config.code, tool.config.code);
  const human = createNode('human', { x: 0, y: 0 }, { config: { reviewTargetNodeId: 'external-tool' } });
  assert.equal(presetDefinitionFromNode(human).node.config.reviewTargetNodeId, '');
});

test('component instances isolate nested documents, edge IDs, review targets, learning targets and filesystem defaults', () => {
  const original = component();
  const definition = presetDefinitionFromNode(original);
  assert.equal(definition.kind, 'component');
  assert.equal(definition.node.config.document.settings.outputDirectory, '');
  assert.equal(definition.node.config.document.nodes[0].config.path, '');
  const record = { id: 'preset-component', version: 4, definition };
  const first = instantiatePreset(record, { x: 100, y: 200 });
  const second = instantiatePreset(record, { x: 400, y: 200 });
  const one = first.config.document; const two = second.config.document;
  assert.notEqual(first.id, second.id); assert.notEqual(one.id, two.id);
  assert.equal(first.config.workflowRef, '');
  assert.equal(one.nodes.find(node => node.type === 'human').config.reviewTargetNodeId, one.nodes.find(node => node.type === 'skill').id);
  assert.deepEqual(one.nodes.find(node => node.type === 'improvement').config.targetSkillNodeIds, [one.nodes.find(node => node.type === 'skill').id]);
  assert.equal(one.nodes.find(node => node.type === 'skill').config.version, 'sha256-1234');
  assert.ok(one.nodes.every(node => !two.nodes.some(other => node.id === other.id)));
  assert.ok(one.edges.every(edge => !two.edges.some(other => edge.id === other.id)));
  assert.deepEqual(validateDocument(one), one);
  one.nodes[1].config.skillRef = 'mutated';
  assert.equal(two.nodes[1].config.skillRef, 'small-pinout');
  assert.equal(record.definition.node.config.document.nodes[1].config.skillRef, 'small-pinout');
  assert.equal(original.config.document.settings.outputDirectory, '/private/old-delivery');
});

test('multiple component output projections follow freshly cloned internal output IDs and preserve public ports', () => {
  const inner = component();
  inner.config.document.nodes.push(createNode('output', { x: 600, y: 400 }, { id: 'out-second' }));
  inner.ports = { inputs: [{ id: 'arg-1', label: '资料', type: 'object', required: true }], outputs: [
    { id: 'result-1', label: '主成果', type: 'object', valuePath: 'out' },
    { id: 'result-2', label: '附件', type: 'object', valuePath: 'out-second.attachments' },
  ] };
  const outerDocument = createDocument({ title: '双层组合', schemaVersion: 2 });
  outerDocument.nodes = [inner, createNode('output', { x: 400, y: 0 }, { id: 'outer-output' })];
  const outer = createNode('subflow', { x: 0, y: 0 }, { title: '双层组合', config: { document: outerDocument }, ports: {
    inputs: [], outputs: [{ id: 'result', label: '外层产物', type: 'any', valuePath: 'outer-output' }],
  } });
  const instance = instantiatePreset({ id: 'preset-nested', version: 1, definition: presetDefinitionFromNode(outer) });
  const clonedInner = instance.config.document.nodes.find(node => node.type === 'subflow');
  const originalInnerOutputs = inner.config.document.nodes.filter(node => node.type === 'output');
  const clonedInnerOutputs = clonedInner.config.document.nodes.filter(node => node.type === 'output');
  assert.equal(clonedInner.ports.outputs[0].valuePath, clonedInnerOutputs[0].id);
  assert.equal(clonedInner.ports.outputs[1].valuePath, clonedInnerOutputs[1].id + '.attachments');
  assert.equal(instance.ports.outputs[0].valuePath, instance.config.document.nodes.find(node => node.type === 'output').id);
  assert.deepEqual(clonedInner.ports.outputs.map(row => row.id), ['result-1', 'result-2']);
  assert.deepEqual(clonedInner.ports.inputs, inner.ports.inputs);
  assert.notEqual(clonedInnerOutputs[0].id, originalInnerOutputs[0].id);
  assert.deepEqual(inner.ports.outputs.map(row => row.valuePath), ['out', 'out-second.attachments']);
});

test('preset structure, prototypes, accessors, cycles and versions fail before persistence', t => {
  const { store, db, events } = setup(t); const valid = definition();
  for (const value of [null, [], {}, { ...valid, other: true }, { ...valid, title: '' }, { ...valid, kind: 'unsupported' },
    { ...valid, kind: 'component' }, { ...valid, node: { ...valid.node, type: 'unknown' } }]) assert.throws(() => store.create({ definition: value }), { httpStatus: 400 });
  for (const expectedRevision of [null, 1, -1, '0', 0.5]) assert.throws(() => store.create({ definition: valid, expectedRevision }), { httpStatus: 400 });
  let reads = 0;
  assert.throws(() => store.create({ get definition() { reads++; return valid; } }), { httpStatus: 400 });
  assert.throws(() => store.create({ definition: { ...valid, get description() { reads++; return ''; } } }), { httpStatus: 400 });
  assert.equal(reads, 0);
  const cyclic = { ...valid }; cyclic.node = cyclic;
  assert.throws(() => validatePresetDefinition(cyclic), /循环引用/);
  assert.throws(() => validatePresetDefinition(Object.assign(Object.create({ bad: true }), valid)), /普通对象/);
  assert.throws(() => store.create({ definition: valid, [Symbol('field')]: true }), { httpStatus: 400 });
  for (const key of ['../escape', '__proto__', '', 'constructor']) assert.throws(() => store.get(key), { httpStatus: 400 });
  for (const version of [null, 0, -1, '1', 1.5]) assert.throws(() => store.get('preset-unknown', { version }), { httpStatus: 400 });
  for (const version of [undefined, 0, '1', -1]) assert.throws(() => instantiatePreset({ id: 'preset-test', version, definition: valid }), /版本/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workflow_node_presets').get().count, 0);
  assert.equal(events.length, 0);
});

test('UTF-8 size and nested depth are bounded before model recursion', t => {
  const { store } = setup(t);
  const node = component();
  node.config.document.nodes = Array.from({ length: 8 }, (_, index) => createNode('tool', { x: index * 100, y: 0 }, { id: 'large-' + index,
    config: { code: '中'.repeat(100000) } }));
  node.config.document.edges = [];
  assert.throws(() => store.create({ definition: { title: '大预设', kind: 'component', node } }), { httpStatus: 413 });
  const nested = {}; let cursor = nested;
  for (let index = 0; index < 45; index++) { cursor.value = {}; cursor = cursor.value; }
  assert.throws(() => validatePresetDefinition(nested), /嵌套过深/);
});
