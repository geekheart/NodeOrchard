import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';
import { WORKFLOW_TOOLS } from '../shared/workflow/workflow-tools.mjs';
import { planWorkflow } from '../shared/workflow/workflow-plan.mjs';

const meta = WORKFLOW_TOOLS.find(tool => tool.id === 'hdk.guide.author-input');
const node = (type, id, config = {}, ports) => createNode(type, { x: 0, y: 0 }, {
  id, config: { inputType: 'object', outputType: 'object', ...config }, ...(ports ? { ports } : {}),
});
const code = (id, reviewImages = false) => node('tool', id, {
  executionMode: 'code', language: 'javascript', code: 'return input;', reviewImages,
});
function graph(separate = true, bypass = false) {
  const nodes = [createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: 'object' } }),
    code('facts'), code('annotations', true), node('human', 'annotationReview'),
    node('tool', 'author', { executionMode: 'tool', toolName: meta.id }, meta.ports),
    createNode('output', { x: 0, y: 0 }, { id: 'output' })];
  const edges = [['input', 'facts'], ['facts', 'annotations'], ['annotations', 'annotationReview'],
    ['facts', 'author', 'facts'], ['annotationReview', 'author', 'images'], ['author', 'output']];
  if (separate) {
    nodes.push(code('diagram', true), node('human', 'diagramReview'));
    edges.push(['facts', 'diagram'], ['diagram', 'diagramReview'],
      [bypass ? 'diagram' : 'diagramReview', 'author', 'diagram']);
  }
  let doc = { ...createDocument({ schemaVersion: 2 }), nodes };
  for (const [sourceNode, targetNode, targetPort = 'in'] of edges) {
    doc = connectNodes(doc, { sourceNode, sourcePort: 'out', targetNode, targetPort });
  }
  return doc;
}

test('guide preparation still admits legacy combined image review without a separate diagram input', () => {
  assert.doesNotThrow(() => planWorkflow(graph(false)));
});

test('guide annotations and bilingual diagrams reach separate human gates before the same author input', () => {
  const plan = planWorkflow(graph());
  const incoming = plan.incoming.get('author');
  assert.deepEqual(incoming.filter(edge => edge.targetPort !== 'facts').map(edge => edge.sourceNode).sort(),
    ['annotationReview', 'diagramReview']);
  assert.equal(plan.incoming.get('annotationReview')[0].sourceNode, 'annotations');
  assert.equal(plan.incoming.get('diagramReview')[0].sourceNode, 'diagram');
});

test('the optional diagram input cannot be used to bypass its own image review', () => {
  assert.throws(() => planWorkflow(graph(true, true)), /人工审核/);
});
