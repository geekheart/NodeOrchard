import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';
import { planWorkflow, learningBranch } from '../shared/workflow/workflow-plan.mjs';

const version = `sha256:${'a'.repeat(64)}`;
function chain(count = 3) {
  let doc = createDocument();
  doc.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: 'text' } }),
    ...Array.from({ length: count }, (_, index) => createNode('skill', { x: index * 250, y: 0 }, {
      id: `skill-${index}`, config: { inputType: 'text', outputType: 'text', skillRef: `skill-${index}`, version },
    })), createNode('output', { x: 1000, y: 0 }, { id: 'output' })];
  for (let index = 0; index < doc.nodes.length - 1; index++) {
    doc = connectNodes(doc, { sourceNode: doc.nodes[index].id, sourcePort: 'out', targetNode: doc.nodes[index + 1].id, targetPort: 'in' });
  }
  return doc;
}

function operations(nodes) {
  let doc = createDocument();
  doc.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: 'text' } }),
    ...nodes, createNode('output', { x: 1400, y: 0 }, { id: 'output' })];
  for (let index = 1; index < doc.nodes.length; index++) doc = connectNodes(doc, {
    sourceNode: doc.nodes[index - 1].id, sourcePort: 'out', targetNode: doc.nodes[index].id, targetPort: 'in',
  });
  return doc;
}
const codeNode = (id, config = {}) => createNode('tool', { x: 400, y: 0 }, { id,
  config: { executionMode: 'code', inputType: 'text', outputType: 'object', code: 'return { text: input };', ...config } });

test('mixed plans order all abilities while skillNodes contains only actual Skills', () => {
  const doc = operations([
    createNode('skill', { x: 200, y: 0 }, { id: 'first-skill', config: { inputType: 'text', outputType: 'text', skillRef: 'first', version } }),
    codeNode('code'),
    createNode('tool', { x: 650, y: 0 }, { id: 'keys', config: { executionMode: 'tool', toolName: 'json.keys', inputType: 'object', outputType: 'array' } }),
    createNode('skill', { x: 900, y: 0 }, { id: 'last-skill', config: { inputType: 'array', outputType: 'text', skillRef: 'last', version } }),
  ]);
  doc.nodes.reverse(); doc.edges.reverse();
  const plan = planWorkflow(doc);
  assert.deepEqual(plan.operationNodes.map(node => node.id), ['first-skill', 'code', 'keys', 'last-skill']);
  assert.deepEqual(plan.skillNodes.map(node => node.id), ['first-skill', 'last-skill']);
  assert.deepEqual(plan.nodeOrder, ['input', 'first-skill', 'code', 'keys', 'last-skill', 'output']);
});

test('code-only and builtin-tool-only chains do not require a Skill reference', () => {
  const codePlan = planWorkflow(operations([codeNode('python', { language: 'python', code: 'return {"text": input}' })]));
  assert.deepEqual(codePlan.skillNodes, []);
  assert.equal(codePlan.operationNodes[0].config.language, 'python');
  const builtIn = createNode('tool', { x: 200, y: 0 }, { id: 'trim', config: {
    executionMode: 'tool', toolName: 'text.trim', inputType: 'text', outputType: 'text', code: 'throw new Error("inactive");',
  } });
  assert.equal(planWorkflow(operations([builtIn])).operationNodes[0].config.toolName, 'text.trim');
});

test('tool plans reject unknown tools, empty active code, unsupported types and retry', () => {
  const invalid = [
    { code: ' ' }, { failurePolicy: 'retry' }, { outputType: 'fileRef' },
    { executionMode: 'tool', toolName: 'terminal', inputType: 'text', outputType: 'text' },
    { executionMode: 'tool', toolName: 'text.trim', inputType: 'text', outputType: 'object' },
  ];
  for (const config of invalid) assert.throws(() => planWorkflow(operations([codeNode('invalid', config)])));
});

test('linear plans follow edge topology rather than node or edge array order', () => {
  const doc = chain();
  doc.nodes.reverse(); doc.edges.reverse();
  const planned = planWorkflow(doc);
  assert.deepEqual(planned.nodeOrder, ['input', 'skill-0', 'skill-1', 'skill-2', 'output']);
  assert.deepEqual(planned.skillNodes.map(node => node.id), ['skill-0', 'skill-1', 'skill-2']);
  assert.equal(planned.inputNode.id, 'input');
  assert.equal(planned.outputNode.id, 'output');
  planned.document.title = 'independent';
  assert.notEqual(doc.title, 'independent');
});

test('the original single-Skill chain remains valid', () => {
  assert.deepEqual(planWorkflow(chain(1)).nodeOrder, ['input', 'skill-0', 'output']);
  assert.equal(planWorkflow(chain(1)).learningBranch, null);
  assert.equal(learningBranch(chain(1)), null);
});

function withLearning(document, sourceNode = 'output', sourcePort = sourceNode === 'output' ? 'learning' : 'out') {
  let doc = { ...document, nodes: [...document.nodes,
    createNode('evaluation', { x: 1200, y: 200 }, { id: 'compare', config: { comparison: 'model', valuePath: 'manifest' } }),
    createNode('improvement', { x: 1500, y: 200 }, { id: 'improve', config: { targetSkillNodeIds: ['skill-0'] } }),
  ] };
  doc = connectNodes(doc, { sourceNode, sourcePort, targetNode: 'compare', targetPort: 'in' });
  return connectNodes(doc, { sourceNode: 'compare', sourcePort: 'out', targetNode: 'improve', targetPort: 'in' });
}

test('execution ignores a complete learning branch while preserving it in the saved snapshot', () => {
  const doc = withLearning(chain(2));
  doc.nodes.reverse(); doc.edges.reverse();
  const before = JSON.stringify(doc);
  const plan = planWorkflow(doc);
  assert.deepEqual(plan.nodeOrder, ['input', 'skill-0', 'skill-1', 'output']);
  assert.deepEqual(plan.operationNodes.map(node => node.id), ['skill-0', 'skill-1']);
  assert.equal(plan.document.nodes.length, 6);
  assert.equal(plan.document.edges.length, 5);
  assert.deepEqual(plan.learningBranch.nodeOrder, ['compare', 'improve']);
  assert.equal(plan.learningBranch.sourceNodeId, 'output');
  assert.equal(plan.learningBranch.sourcePort, 'learning');
  assert.deepEqual(plan.learningBranch.improvementNode.config.targetSkillNodeIds, ['skill-0']);
  assert.equal(JSON.stringify(doc), before, 'planning does not erase the learning path from the document');
  assert.equal(learningBranch({ ...doc, mode: 'learn' }).evaluationNode.config.valuePath, 'manifest');
  assert.throws(() => planWorkflow({ ...doc, mode: 'learn' }), /学习面板/);
});

test('learning can observe an intermediate Skill or code result without changing the business node order', () => {
  const skillPlan = planWorkflow(withLearning(chain(2), 'skill-0'));
  assert.equal(skillPlan.learningBranch.sourceNodeId, 'skill-0');
  assert.equal(skillPlan.learningBranch.sourcePort, 'out');
  assert.deepEqual(skillPlan.nodeOrder, ['input', 'skill-0', 'skill-1', 'output']);
  const doc = operations([codeNode('code', { outputType: 'text', code: 'return input;' })]);
  const plan = planWorkflow(withLearning(doc, 'code'));
  assert.deepEqual(plan.nodeOrder, ['input', 'code', 'output']);
  assert.equal(plan.learningBranch.sourceNodeId, 'code');
});

test('incomplete or multiple learning branches cannot be hidden by execute mode', () => {
  const original = withLearning(chain(1));
  for (const target of ['compare', 'improve']) {
    const incomplete = { ...original, edges: original.edges.filter(edge => edge.targetNode !== target) };
    assert.throws(() => planWorkflow(incomplete), /学习支路/);
  }
  for (const type of ['evaluation', 'improvement']) {
    const draft = chain(1); draft.nodes.push(createNode(type, {}, { id: 'draft' }));
    assert.throws(() => planWorkflow(draft), /学习支路/);
  }
  const duplicate = withLearning(chain(1));
  duplicate.nodes.push(createNode('evaluation', {}, { id: 'compare-second' }));
  assert.throws(() => planWorkflow(duplicate), /唯一/);
});

test('a learning branch cannot conceal disconnected abilities, unsupported nodes or malformed business branches', () => {
  const disconnected = chain(1);
  disconnected.nodes.push(createNode('skill', {}, { id: 'isolated', config: { inputType: 'text', outputType: 'text', skillRef: 'isolated', version } }));
  assert.throws(() => planWorkflow(withLearning(disconnected, 'isolated')), /线性链|连通|悬空/);
  const unsupported = withLearning(chain(1));
  unsupported.nodes.push(createNode('transform', {}, { id: 'unimplemented' }));
  assert.throws(() => planWorkflow(unsupported), /不支持其它节点/);
  const extraOutput = withLearning(chain(1));
  extraOutput.nodes.push(createNode('output', {}, { id: 'extra-output' }));
  const businessBranch = connectNodes(extraOutput, { sourceNode: 'skill-0', sourcePort: 'out', targetNode: 'extra-output', targetPort: 'in' });
  assert.throws(() => planWorkflow(businessBranch), /一个输出/);
  const wrongRole = withLearning(chain(1));
  wrongRole.edges.find(edge => edge.targetNode === 'compare').sourcePort = 'out';
  assert.throws(() => planWorkflow(wrongRole), /端口/);
});

test('scheduled input configuration shares the execution plan and remains unchanged', () => {
  const document = chain(1);
  Object.assign(document.nodes[0].config, { trigger: 'schedule', schedule: '23:30', timezone: 'Asia/Shanghai' });
  const planned = planWorkflow(document);
  assert.deepEqual(planned.nodeOrder, ['input', 'skill-0', 'output']);
  assert.equal(planned.inputNode.config.trigger, 'schedule');
  assert.equal(planned.inputNode.config.schedule, '23:30');
  assert.equal(planned.inputNode.config.timezone, 'Asia/Shanghai');
});

test('plans reject unsupported modes, policies and missing or unpinned capabilities', () => {
  const mutations = [
    doc => { doc.mode = 'learn'; },
    doc => { doc.nodes[0].config.trigger = 'cron'; },
    doc => { doc.nodes[2].config.failurePolicy = 'retry'; },
    doc => { doc.nodes[2].config.skillRef = ''; },
    doc => { doc.nodes[2].config.version = 'latest'; },
    doc => { doc.nodes[1].config.inputType = 'fileRef'; doc.nodes[0].config.outputType = 'fileRef'; },
  ];
  for (const mutate of mutations) {
    const doc = chain(); mutate(doc);
    assert.throws(() => planWorkflow(doc));
  }
});

test('plans reject branches, missing links, disconnected nodes and extra input/output nodes', () => {
  const missing = chain(); missing.edges.pop();
  assert.throws(() => planWorkflow(missing));
  const branch = chain(); branch.edges[2].sourceNode = 'input';
  assert.throws(() => planWorkflow(branch));
  const extra = chain(); extra.nodes.push(createNode('skill', { x: 0, y: 0 }, { config: { skillRef: 'extra', version } }));
  assert.throws(() => planWorkflow(extra));
  for (const type of ['input', 'output', 'transform']) {
    const doc = chain(); doc.nodes.push(createNode(type));
    assert.throws(() => planWorkflow(doc));
  }
  const cycle = chain(); cycle.edges[2].targetNode = 'skill-0';
  assert.throws(() => planWorkflow(cycle));
});
