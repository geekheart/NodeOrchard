import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NODE_TYPES, NODE_GROUPS, createDocument, createNode, getPorts, validateConnection,
  connectNodes, updateNode, removeNodes, removeEdge, validateDocument, serializeDocument, nodeConfigurationContract, foundationNodeParent,
} from '../shared/workflow/workflow-model.mjs';

const node = (type, id, config = {}) => createNode(type, { x: 20, y: 40 }, { id, config });
const graph = (...nodes) => ({ ...createDocument(), nodes });
const wire = (sourceNode, targetNode, sourcePort = 'out', targetPort = 'in') => ({ sourceNode, sourcePort, targetNode, targetPort });
const frozenCopy = value => JSON.parse(JSON.stringify(value));

test('renaming learning improvement preserves the frozen foundation label in historical derived origins', () => {
  const origin = { kind: 'preset', id: 'preset-legacy-improvement', version: 1, title: '旧改进节点', baseType: 'improvement',
    parent: { kind: 'foundation', baseType: 'improvement', title: 'Skill 改进' } };
  const document = { ...createDocument({ schemaVersion: 2 }), nodes: [createNode('improvement', {}, { id: 'improve', title: 'Skill 改进', origin })] };
  const restored = validateDocument(JSON.parse(serializeDocument(document)));
  assert.deepEqual(restored.nodes[0].origin, origin); assert.equal(restored.nodes[0].title, 'Skill 改进');
  assert.deepEqual(foundationNodeParent('improvement'), { kind: 'foundation', baseType: 'improvement', title: '学习改进' });
  assert.throws(() => createNode('improvement', {}, { origin: { ...origin, parent: { ...origin.parent, title: '伪造来源' } } }), /基础父级名称/);
});

test('legacy human revision limits round-trip without being advertised as current configuration', () => {
  const human = createNode('human', {}, { id: 'review' }), contract = nodeConfigurationContract('human');
  assert.equal(Object.hasOwn(human.config, 'maxRevisions'), false);
  assert.equal(Object.hasOwn(contract.defaults, 'maxRevisions'), false);
  assert.equal(contract.allowedConfigKeys.includes('maxRevisions'), false);
  for (const maximum of [1, 3, 12]) {
    const legacy = createDocument({ schemaVersion: 2 });
    legacy.nodes = [createNode('human', {}, { id: 'legacy-review', config: { maxRevisions: maximum } })];
    assert.equal(validateDocument(legacy).nodes[0].config.maxRevisions, maximum);
    assert.deepEqual(validateDocument(legacy), legacy, 'Compatibility must preserve the frozen document instead of rewriting it.');
  }
});

test('fourteen node types use five stable groups, icons, defaults, and named ports', () => {
  assert.equal(NODE_TYPES.length, 14);
  assert.deepEqual(NODE_GROUPS.map(group => group.id), ['io', 'capability', 'data', 'control', 'human']);
  assert.deepEqual(NODE_TYPES.filter(type => type.category === 'capability').map(type => type.type), ['skill', 'tool', 'subflow']);
  assert.equal(NODE_TYPES.find(type => type.type === 'foreach').icon, 'list');
  assert.deepEqual(getPorts(node('input', 'input')), { inputs: [], outputs: [{ id: 'out', label: '输出', type: 'fileRef' }] });
  assert.deepEqual(getPorts(node('skill', 'skill')).inputs, [{ id: 'in', label: '输入', type: 'fileRef' }]);
  assert.equal(getPorts(node('skill', 'skill')).outputs[0].type, 'object');
  assert.deepEqual(getPorts(node('condition', 'branch')).outputs.map(port => port.id), ['yes', 'no']);
  assert.deepEqual(getPorts(node('foreach', 'each')).inputs.map(port => port.type), ['array']);
  assert.deepEqual(getPorts(node('foreach', 'each')).outputs.map(port => port.type), ['array']);
  assert.deepEqual(getPorts(node('output', 'output')), { inputs: [{ id: 'in', label: '输入', type: 'any' }],
    outputs: [{ id: 'learning', label: '学习产物', type: 'any' }] });
  const a = createDocument();
  const b = createDocument({ title: '文档校验' });
  assert.notEqual(a.id, b.id);
  assert.equal(a.mode, 'execute');
  assert.deepEqual(validateDocument(a), a);
});

test('learning nodes keep observation and modification targets explicit without storing expected answers', () => {
  const evaluation = node('evaluation', 'compare');
  const improvement = node('improvement', 'improve');
  assert.deepEqual(evaluation.config, { comparison: 'exact', valuePath: '' });
  assert.deepEqual(improvement.config, { scope: 'skills', targetSkillNodeIds: [] });
  assert.deepEqual(getPorts(evaluation), { inputs: [{ id: 'in', label: '实际产物', type: 'any' }],
    outputs: [{ id: 'out', label: '对比结果', type: 'object' }] });
  assert.deepEqual(getPorts(improvement), { inputs: [{ id: 'in', label: '对比结果', type: 'object' }], outputs: [] });
  const ids = ['skill-a'];
  const configured = node('improvement', 'configured', { targetSkillNodeIds: ids });
  ids.push('skill-b');
  assert.deepEqual(configured.config.targetSkillNodeIds, ['skill-a']);
  improvement.config.targetSkillNodeIds.push('skill-c');
  assert.deepEqual(node('improvement', 'fresh').config.targetSkillNodeIds, []);
  const updated = updateNode(graph(evaluation, configured), 'compare', { config: { comparison: 'model', valuePath: 'files.manifest' } });
  assert.deepEqual(updated.nodes[0].config, { comparison: 'model', valuePath: 'files.manifest' });
  for (const config of [{ scope: 'all' }, { targetSkillNodeIds: 'skill-a' }, { targetSkillNodeIds: ['../file'] }, { targetNodeIds: 'worker' }, { targetNodeIds: ['worker', 'worker'] },
    { targetSkillNodeIds: ['skill-a', 'skill-a'] }, { targetSkillNodeIds: Array.from({ length: 201 }, (_, i) => `skill-${i}`) }]) {
    assert.throws(() => node('improvement', 'bad', config));
  }
  for (const config of [{ comparison: 'none' }, { valuePath: 2 }, { knownAnswer: 'secret' }, { reference: 'secret' }]) {
    assert.throws(() => node('evaluation', 'bad', config));
  }
});

test('learning wires can observe a business ability or final output but cannot carry business control flow', () => {
  const initial = graph(node('input', 'input', { outputType: 'object' }), node('skill', 'skill', { inputType: 'object' }),
    node('output', 'output'), node('evaluation', 'compare'), node('improvement', 'improve'));
  let linked = connectNodes(connectNodes(initial, wire('input', 'skill')), wire('skill', 'output'));
  linked = connectNodes(linked, wire('skill', 'compare'));
  linked = connectNodes(linked, wire('compare', 'improve'));
  assert.equal(linked.edges.length, 4, 'the ability output is shared by the business and learning paths');
  const fromFinal = connectNodes(initial, wire('output', 'compare', 'learning'));
  assert.equal(fromFinal.edges[0].sourcePort, 'learning');
  for (const connection of [wire('input', 'compare'), wire('skill', 'improve'), wire('compare', 'output'),
    wire('output', 'skill', 'learning'), wire('compare', 'skill'), wire('improve', 'compare')]) {
    assert.equal(validateConnection(initial, connection).ok, false);
  }
  assert.equal(validateDocument(graph(node('evaluation', 'draft'))).nodes.length, 1, 'incomplete drafts remain editable');
});

test('tool drafts have an explicit execution mode and upgrade legacy names without running code', () => {
  assert.equal(node('tool', 'code').config.executionMode, 'code');
  assert.equal(node('tool', 'named', { toolName: 'json.keys' }).config.executionMode, 'tool');
  const explicit = node('tool', 'explicit', { executionMode: 'code', toolName: 'json.keys', code: 'return input;' });
  assert.equal(explicit.config.executionMode, 'code');
  const roundTrip = validateDocument(graph(explicit));
  assert.equal(roundTrip.nodes[0].config.toolName, 'json.keys');
  assert.equal(roundTrip.nodes[0].config.code, 'return input;');
  assert.throws(() => node('tool', 'invalid', { executionMode: 'auto' }), /执行方式/);
  assert.throws(() => node('tool', 'invalid', { toolName: 42 }), /字符串/);
  assert.throws(() => node('skill', 'invalid', { executionMode: 'tool' }), /未知字段/);
});

test('typed connections reject incompatible, reversed, missing, self and duplicate edges', () => {
  const initial = graph(node('input', 'input'), node('skill', 'skill'), node('transform', 'transform'), node('output', 'output'));
  assert.deepEqual(validateConnection(initial, wire('input', 'skill')), { ok: true });
  assert.match(validateConnection(initial, wire('input', 'transform')).message, /不兼容/);
  assert.match(validateConnection(initial, wire('output', 'input')).message, /方向|端口/);
  assert.match(validateConnection(initial, wire('input', 'missing')).message, /不存在/);
  assert.match(validateConnection(initial, wire('skill', 'skill')).message, /自身/);
  assert.match(validateConnection(initial, wire('input', 'skill', 'in', 'out')).message, /方向|端口/);
  const connected = connectNodes(initial, wire('input', 'skill'));
  assert.equal(initial.edges.length, 0);
  assert.match(validateConnection(connected, wire('input', 'skill')).message, /已存在/);
  assert.throws(() => connectNodes(connected, wire('input', 'skill')), /已存在/);
  const output = connectNodes(initial, wire('input', 'output'));
  assert.equal(output.edges.length, 1, 'any target accepts fileRef');
  const anySource = graph(node('transform', 'a', { outputType: 'any' }), node('skill', 'b'));
  assert.equal(connectNodes(anySource, wire('a', 'b')).edges.length, 1);
});

test('an occupied input requires explicit replacement and never silently loses a wire', () => {
  const initial = graph(node('input', 'a'), node('input', 'b'), node('skill', 'skill'));
  const connected = connectNodes(initial, wire('a', 'skill'));
  const before = frozenCopy(connected);
  assert.match(validateConnection(connected, wire('b', 'skill')).message, /已有连线/);
  assert.throws(() => connectNodes(connected, wire('b', 'skill')), /已有连线/);
  assert.deepEqual(connected, before);
  const replaced = connectNodes(removeEdge(connected, connected.edges[0].id), wire('b', 'skill'));
  assert.equal(replaced.edges.length, 1);
  assert.equal(replaced.edges[0].sourceNode, 'b');
  assert.equal(connected.edges[0].sourceNode, 'a');
});

test('condition branches can target separate downstream nodes and dataflow cycles are rejected', () => {
  const initial = graph(node('condition', 'condition'), node('transform', 'yes'), node('transform', 'no'));
  const yes = connectNodes(initial, wire('condition', 'yes', 'yes'));
  const both = connectNodes(yes, wire('condition', 'no', 'no'));
  assert.equal(both.edges.length, 2);
  assert.match(validateConnection(both, wire('yes', 'condition')).message, /形成环/);
  assert.throws(() => connectNodes(both, wire('no', 'condition')), /形成环/);
  const cycle = { ...both, edges: [...both.edges, { id: 'return-edge', ...wire('yes', 'condition') }] };
  assert.throws(() => validateDocument(cycle), /形成环/);
  const indirect = graph(node('transform', 'a'), node('transform', 'b'), node('transform', 'c'));
  const chain = connectNodes(connectNodes(indirect, wire('a', 'b')), wire('b', 'c'));
  assert.throws(() => connectNodes(chain, wire('c', 'a')), /形成环/);
});

test('config updates merge atomically and refuse to break retained edge types', () => {
  const initial = graph(node('input', 'input'), node('skill', 'skill'), node('output', 'output'));
  const connected = connectNodes(connectNodes(initial, wire('input', 'skill')), wire('skill', 'output'));
  const before = frozenCopy(connected);
  assert.throws(() => updateNode(connected, 'skill', { title: '不能落地', config: { inputType: 'text' } }), /不兼容/);
  assert.deepEqual(connected, before);
  const updated = updateNode(connected, 'skill', { title: '分析文件', x: -20, config: { skillRef: 'skills/analyze', version: 'v1' } });
  assert.equal(updated.nodes[1].config.inputType, 'fileRef');
  assert.equal(updated.nodes[1].config.skillRef, 'skills/analyze');
  assert.equal(updated.nodes[1].title, '分析文件');
  assert.equal(updated.nodes[1].x, -20);
  assert.notEqual(updated.nodes[0], connected.nodes[0], 'returned document owns clean node copies');
  assert.throws(() => updateNode(connected, 'missing', {}), /不存在/);
  assert.throws(() => updateNode(connected, 'skill', { type: 'tool' }), /未知字段/);
  assert.throws(() => updateNode(connected, 'skill', { x: undefined }), /坐标/);
  assert.deepEqual(connected, before);
});

test('deleting a node cleans its incoming and outgoing edges without changing the original', () => {
  const initial = graph(node('input', 'input'), node('skill', 'skill'), node('output', 'output'));
  const connected = connectNodes(connectNodes(initial, wire('input', 'skill')), wire('skill', 'output'));
  const deleted = removeNodes(connected, ['skill']);
  assert.deepEqual(deleted.nodes.map(item => item.id), ['input', 'output']);
  assert.equal(deleted.edges.length, 0);
  assert.equal(connected.edges.length, 2);
  assert.deepEqual(removeNodes(connected, ['does-not-exist']), connected);
  assert.equal(removeEdge(connected, connected.edges[0].id).edges.length, 1);
});

test('loop containers are bounded and foreach uses array input and output', () => {
  for (const type of ['loop', 'foreach']) {
    for (const maxIterations of [0, -1, 1.5, 1001, Infinity, '10']) {
      assert.throws(() => createNode(type, {}, { config: { maxIterations } }), /迭代次数/);
    }
    assert.equal(createNode(type, {}, { config: { maxIterations: 1 } }).config.maxIterations, 1);
    assert.equal(createNode(type, {}, { config: { maxIterations: 1000 } }).config.maxIterations, 1000);
  }
  assert.throws(() => node('foreach', 'each', { inputType: 'object' }), /固定为 array/);
  assert.throws(() => node('foreach', 'each', { outputType: 'object' }), /固定为 array/);
  assert.throws(() => node('output', 'out', { inputType: 'text' }), /固定为 any/);
  const loop = node('loop', 'repeat');
  const updated = updateNode(graph(loop), 'repeat', { config: { maxIterations: 5, expression: 'result.ok' } });
  assert.equal(updated.nodes[0].config.maxIterations, 5);
  assert.equal(loop.config.maxIterations, 10);
});

test('import validation is atomic, bounded, and rejects prototype, accessors and unknown config', () => {
  const valid = connectNodes(graph(node('input', 'input'), node('skill', 'skill')), wire('input', 'skill'));
  const before = frozenCopy(valid);
  const invalid = [
    { ...valid, schemaVersion: 3 },
    { ...valid, mode: 'run' },
    { ...valid, title: 'a'.repeat(121) },
    { ...valid, nodes: [...valid.nodes, { ...valid.nodes[0] }] },
    { ...valid, nodes: [{ ...valid.nodes[0], type: 'unknown' }] },
    { ...valid, nodes: [{ ...valid.nodes[0], x: NaN }] },
    { ...valid, nodes: [{ ...valid.nodes[0], y: 100001 }] },
    { ...valid, nodes: [{ ...valid.nodes[0], id: '../escape' }] },
    { ...valid, nodes: [{ ...valid.nodes[0], id: 'constructor' }] },
    { ...valid, nodes: [{ ...valid.nodes[0], config: null }] },
    { ...valid, edges: [{ ...valid.edges[0], targetNode: 'missing' }] },
    { ...valid, edges: [...valid.edges, { ...valid.edges[0], id: 'other' }] },
    { ...valid, viewport: { x: 0, y: 0, zoom: 0 } },
    { ...valid, nodes: Array.from({ length: 201 }, (_, i) => node('input', `node-${i}`)) },
    { ...valid, edges: Array.from({ length: 1001 }, () => valid.edges[0]) },
    { ...valid, nodes: [{ ...valid.nodes[0], config: { outputType: 'fileRef', unexpected: true } }] },
    { ...valid, nodes: [{ ...valid.nodes[0], config: JSON.parse('{"__proto__":{"polluted":true}}') }] },
    { ...valid, nodes: [{ ...valid.nodes[0], config: { constructor: 'forbidden' } }] },
    { ...valid, nodes: [{ ...valid.nodes[0], config: { outputType: 'string' } }] },
    { ...valid, nodes: [{ ...valid.nodes[0], config: { ...valid.nodes[0].config, fieldName: '\0' } }] },
    Object.assign(Object.create({ inherited: true }), valid),
    { ...valid, extra: true },
  ];
  for (const bad of invalid) assert.throws(() => validateDocument(bad));
  let read = false;
  const config = Object.defineProperty({}, 'outputType', { enumerable: true, get() { read = true; return 'fileRef'; } });
  assert.throws(() => validateDocument({ ...valid, nodes: [{ ...valid.nodes[0], config }] }), /访问器/);
  assert.equal(read, false, 'import never invokes accessors');
  assert.equal({}.polluted, undefined);
  assert.deepEqual(valid, before);
  assert.throws(() => createNode('input', { x: null }), /坐标/);
  assert.throws(() => createNode('input', {}, { config: null }), /普通对象/);
  assert.throws(() => createDocument({ title: null }), /字符串/);
});

test('serialization round trips all types and returns independent sanitized data', () => {
  const doc = graph(...NODE_TYPES.map((item, index) => node(item.type, `type-${index}`)));
  doc.mode = 'learn';
  doc.viewport = { x: -50.5, y: 25.25, zoom: 1.25 };
  doc.nodes.find(item => item.type === 'tool').config.code = 'const text = "<script> & 中文";\nreturn text;';
  const serialized = serializeDocument(doc);
  const imported = validateDocument(JSON.parse(serialized));
  assert.deepEqual(imported, doc);
  assert.equal(imported.mode, 'learn');
  imported.nodes[0].title = '独立副本';
  assert.notEqual(imported.nodes[0].title, doc.nodes[0].title);
  assert.throws(() => node('tool', 'code', { language: 'shell' }), /代码语言/);
  assert.throws(() => node('transform', 'large', { code: 'x'.repeat(100001) }), /最多 100000/);
});

test('trigger and capability policy settings save without execution and reject invalid values atomically', () => {
  const input = node('input', 'trigger');
  assert.equal(input.config.trigger, 'manual');
  assert.equal(input.config.schedule, '09:00');
  assert.equal(input.config.timezone, 'Asia/Shanghai');
  const scheduled = updateNode(graph(input), 'trigger', {
    config: { trigger: 'schedule', schedule: '23:59', timezone: 'Custom/Zone' },
  });
  assert.equal(validateDocument(JSON.parse(serializeDocument(scheduled))).nodes[0].config.schedule, '23:59');
  for (const config of [
    { trigger: 'cron' }, { schedule: '24:00' }, { schedule: '09:60' }, { schedule: '9:00' },
    { schedule: '09:00\n' }, { timezone: ' ' }, { timezone: 'a'.repeat(129) },
  ]) assert.throws(() => updateNode(graph(input), 'trigger', { config }));
  assert.equal(input.config.trigger, 'manual');
  for (const type of ['skill', 'tool', 'subflow']) {
    const capability = node(type, type);
    const initial = graph(capability);
    const before = frozenCopy(initial);
    assert.equal(capability.config.timeoutSeconds, 120);
    assert.equal(capability.config.failurePolicy, 'stop');
    const changed = updateNode(initial, type, { config: { timeoutSeconds: 86400, failurePolicy: 'retry' } });
    assert.equal(changed.nodes[0].config.failurePolicy, 'retry');
    assert.equal(validateDocument(JSON.parse(serializeDocument(changed))).nodes[0].config.timeoutSeconds, 86400);
    for (const config of [
      { timeoutSeconds: 0 }, { timeoutSeconds: 86401 }, { timeoutSeconds: 1.5 },
      { timeoutSeconds: '120' }, { failurePolicy: 'ignore' },
    ]) assert.throws(() => updateNode(initial, type, { title: '不应保存', config }));
    assert.deepEqual(initial, before);
  }
});
