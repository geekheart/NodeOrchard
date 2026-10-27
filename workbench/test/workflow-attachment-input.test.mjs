import test from 'node:test';
import assert from 'node:assert/strict';
import { bindAttachmentInput, attachmentInputChoices } from '../public/workflow-attachment-input.js';
import { createDocument, createNode } from '../shared/workflow/workflow-model.mjs';
import { withWorkflowInputDefaults } from '../shared/workflow/workflow-inputs.mjs';

function fixture() {
  const document = createDocument({ schemaVersion: 2 });
  const attachment = { id: 'attachment-one', workflowId: document.id, name: '素材.png', path: '/private/tmp/workspace/workflows/' + document.id + '/inputs/attachments/one.png', mimeType: 'image/png' };
  return { document, attachment };
}
test('using a saved image as a new input keeps its path and produces a runnable default without starting anything', () => {
  const { document, attachment } = fixture();
  const next = bindAttachmentInput(document, attachment);
  assert.equal(document.nodes.length, 0); assert.equal(next.id, document.id); assert.equal(next.nodes.length, 1);
  assert.equal(next.nodes[0].type, 'input'); assert.equal(next.nodes[0].config.fields[0].kind, 'image');
  assert.deepEqual(withWorkflowInputDefaults(next, undefined), { file: attachment.path });
});
test('binding an existing field keeps its other defaults, nodes and connections', () => {
  const { document, attachment } = fixture();
  document.nodes = [createNode('input', {}, { id: 'input', config: { outputType: 'object', fields: [
    { key: 'source', label: '图像', kind: 'file' }, { key: 'note', label: '要求', kind: 'text' }], defaultValue: { source: '/private/tmp/old.png', note: '保留原要求' } } })];
  assert.equal(attachmentInputChoices(document, attachment)[0].value, 'input:source');
  const next = bindAttachmentInput(document, attachment, 'input:source');
  assert.equal(next.nodes.length, 1); assert.deepEqual(next.nodes[0].config.defaultValue, { source: attachment.path, note: '保留原要求' });
  assert.deepEqual(next.edges, document.edges); assert.equal(document.nodes[0].config.defaultValue.source, '/private/tmp/old.png');
});
test('a file cannot replace an image-only or mismatched extension field, or cross workflow boundaries', () => {
  const { document, attachment } = fixture();
  document.nodes = [createNode('input', {}, { id: 'input', config: { fields: [{ key: 'image', label: '图片', kind: 'image', extensions: ['.jpg'] }] } })];
  assert.deepEqual(attachmentInputChoices(document, attachment), []);
  assert.throws(() => bindAttachmentInput(document, attachment, 'input:image'), /不接受/);
  assert.throws(() => bindAttachmentInput(document, { ...attachment, workflowId: 'workflow-other' }), /当前工作流/);
  assert.deepEqual(attachmentInputChoices(document, { ...attachment, name: 'notes.txt', path: '/private/tmp/notes.jpg', mimeType: 'text/plain' }), []);
});
