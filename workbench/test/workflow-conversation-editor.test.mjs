import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEditor } from '../public/workflow-editor.js';
import { createDocument } from '../shared/workflow/workflow-model.mjs';
import { documentFingerprint } from '../shared/workflow/workflow-conversation-commands.mjs';

function editor() {
  const item = Object.create(WorkflowEditor.prototype);
  Object.assign(item, { doc: createDocument({ schemaVersion: 2 }), libraryLifecycle: 'active', nodeLibrary: {},
    propertyDrafts: new Map(), history: [], future: [], selection: new Set(), selectedEdge: null,
    cancelGesture() {}, cancelConnection() {}, renderGraph() {}, renderProperties() {}, renderHeader() {}, scheduleSave() {}, fit() {} });
  return item;
}
const operations = [
  { op: 'add-node', ref: 'input', type: 'input', title: '输入', config: { outputType: 'text' } },
  { op: 'add-node', ref: 'output', type: 'output', title: '结果' },
  { op: 'connect', sourceNode: 'input', sourcePort: 'out', targetNode: 'output', targetPort: 'in' },
];

test('conversation editor operations create one undo entry with durable deterministic IDs', () => {
  const item = editor(), before = structuredClone(item.doc), fingerprint = documentFingerprint(before);
  const result = item.applyConversationOperations(operations, { fingerprint, turnId: 'turn-123' });
  assert.deepEqual(item.history, [{ document: before, label: '应用对话中的流程修改' }]);
  assert.equal(item.doc.nodes[0].id, 'node-turn-123-1'); assert.equal(item.doc.nodes[1].id, 'node-turn-123-2');
  assert.equal(item.doc.edges[0].id, 'edge-turn-123-3'); assert.equal(result.fingerprint, documentFingerprint(item.doc));
  assert.throws(() => item.applyConversationOperations(operations, { fingerprint, turnId: 'turn-123' }), /画布已变化/);
  assert.equal(item.history.length, 1);
});

test('a failed batch, pending property draft, nested edit and readonly lifecycle preserve the current canvas', () => {
  const item = editor(), before = structuredClone(item.doc);
  assert.throws(() => item.applyConversationOperations([...operations, { op: 'remove-node', nodeId: 'missing' }]), /不存在/);
  assert.deepEqual(item.doc, before); assert.equal(item.history.length, 0);
  item.propertyDrafts.set('node-a', {}); assert.throws(() => item.applyConversationOperations(operations), /属性与名称/); item.propertyDrafts.clear();
  item.nodeLibrary.nested = {}; assert.throws(() => item.applyConversationOperations(operations), /组合内部/); item.nodeLibrary.nested = null;
  item.libraryLifecycle = 'archived'; assert.throws(() => item.applyConversationOperations(operations), /只读/);
  assert.deepEqual(item.doc, before); assert.equal(item.history.length, 0);
});
