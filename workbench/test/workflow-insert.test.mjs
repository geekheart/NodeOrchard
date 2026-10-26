import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEditor } from '../public/workflow-editor.js';
import { createDocument, createNode, connectNodes, validateDocument } from '../shared/workflow/workflow-model.mjs';
import { WORKFLOW_TOOLS } from '../shared/workflow/workflow-tools.mjs';

function editor() {
  const instance = Object.create(WorkflowEditor.prototype);
  instance.doc = createDocument();
  const input = createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: 'object' } });
  const skill = createNode('skill', { x: 320, y: 0 }, { id: 'first', config: {
    inputType: 'object', outputType: 'object', skillRef: 'chosen-skill', version: 'keep-this-reference',
  } });
  const output = createNode('output', { x: 640, y: 0 }, { id: 'output' });
  instance.doc.nodes = [input, skill, output];
  instance.doc = connectNodes(instance.doc, { sourceNode: input.id, sourcePort: 'out', targetNode: skill.id, targetPort: 'in' });
  instance.doc = connectNodes(instance.doc, { sourceNode: skill.id, sourcePort: 'out', targetNode: output.id, targetPort: 'in' });
  Object.assign(instance, { propertyDrafts: new Map(), selection: new Set(['first']), history: [], future: [], settings: { snap: true } });
  instance.renderGraph = instance.renderProperties = instance.scheduleSave = instance.toast = () => {};
  instance.selectNode = id => { instance.selection = new Set([id]); };
  return instance;
}

test('inserting a Skill atomically rewires the selected step and retains existing configuration', () => {
  const instance = editor(), before = structuredClone(instance.doc);
  const added = instance.insertSkillAfterSelected();
  assert.doesNotThrow(() => validateDocument(instance.doc));
  assert.equal(instance.history.length, 1);
  assert.deepEqual(instance.history[0].document, before);
  assert.equal(added.config.inputType, 'object');
  assert.equal(added.config.outputType, 'object');
  assert.equal(added.config.skillRef, '');
  assert.equal(instance.doc.nodes.find(node => node.id === 'first').config.skillRef, 'chosen-skill');
  assert.deepEqual(instance.doc.edges.map(edge => [edge.sourceNode, edge.targetNode]), [['input', 'first'], ['first', added.id], [added.id, 'output']]);
  assert.equal(instance.doc.nodes.find(node => node.id === 'output').x, 960);
  assert.deepEqual([...instance.selection], [added.id]);
  assert.deepEqual(before.nodes.find(node => node.id === 'first').config, instance.doc.nodes.find(node => node.id === 'first').config);
});

test('with Output selected, inserting falls back to its predecessor and preserves the other connections', () => {
  const instance = editor();
  instance.selection = new Set(['output']);
  const added = instance.insertSkillAfterSelected();
  assert(instance.doc.edges.some(edge => edge.sourceNode === 'first' && edge.targetNode === added.id));
  assert(instance.doc.edges.some(edge => edge.sourceNode === added.id && edge.targetNode === 'output'));
});

test('an ambiguous branch is rejected without replacing graph data or adding undo entries', () => {
  const instance = editor();
  const other = createNode('output', { x: 640, y: 320 }, { id: 'other' });
  instance.doc.nodes.push(other);
  instance.doc = connectNodes(instance.doc, { sourceNode: 'first', sourcePort: 'out', targetNode: 'other', targetPort: 'in' });
  const before = structuredClone(instance.doc);
  assert.throws(() => instance.insertSkillAfterSelected(), /分支/);
  assert.deepEqual(instance.doc, before);
  assert.equal(instance.history.length, 0);
});

test('inserting code defaults to a typed identity body and is fully undoable', () => {
  const instance = editor(), before = structuredClone(instance.doc), added = instance.insertToolAfterSelected();
  assert.equal(added.type, 'tool'); assert.equal(added.config.executionMode, 'code'); assert.equal(added.config.code, 'return input');
  assert.equal(added.config.inputType, 'object'); assert.equal(added.config.outputType, 'object');
  assert.deepEqual(instance.doc.nodes.find(node => node.id === 'first').config, before.nodes.find(node => node.id === 'first').config);
  assert(instance.doc.edges.some(edge => edge.sourceNode === 'first' && edge.targetNode === added.id));
  assert(instance.doc.edges.some(edge => edge.sourceNode === added.id && edge.targetNode === 'output'));
  instance.undo(); assert.deepEqual(instance.doc, before);
});

test('either operation type can be inserted after an existing code node or before Output', () => {
  const instance = editor(), code = instance.insertToolAfterSelected();
  const skill = instance.insertSkillAfterSelected();
  assert(instance.doc.edges.some(edge => edge.sourceNode === code.id && edge.targetNode === skill.id));
  instance.selection = new Set(['output']); const last = instance.insertToolAfterSelected();
  assert(instance.doc.edges.some(edge => edge.sourceNode === skill.id && edge.targetNode === last.id));
  assert(instance.doc.edges.some(edge => edge.sourceNode === last.id && edge.targetNode === 'output'));
  assert.doesNotThrow(() => validateDocument(instance.doc));
});

test('built-in tool form uses registered port types and preserves hidden code without changing mode', () => {
  const instance = editor(), tool = createNode('tool', { x: 0, y: 0 }, { config: { inputType: 'object', outputType: 'object', code: 'throw new Error("must stay hidden")' } });
  const registered = WORKFLOW_TOOLS.find(item => item.id === 'text.trim');
  const fields = [
    { name: 'executionMode', value: 'tool' }, { name: 'toolName', value: registered.id },
    { name: 'language', value: 'javascript' }, { name: 'code', value: tool.config.code },
    { name: 'inputType', value: 'object', disabled: true }, { name: 'outputType', value: 'object', disabled: true },
  ];
  const form = { querySelectorAll: () => fields, elements: { title: { value: '选择工具' } } };
  const selected = instance.readForm(form, tool);
  assert.equal(selected.config.executionMode, 'tool'); assert.equal(selected.config.inputType, registered.inputType); assert.equal(selected.config.outputType, registered.outputType);
  assert.equal(selected.config.code, tool.config.code, 'hidden body remains a draft; explicit tool mode is preserved');
  fields[0].value = 'code'; fields[4].disabled = fields[5].disabled = false;
  const code = instance.readForm(form, tool); assert.equal(code.config.executionMode, 'code'); assert.equal(code.config.inputType, 'object');
});

test('mode changes hide the inactive fields, restore code port choices and never discard its body', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  class Element { constructor() { this.children = []; } append(...items) { this.children.push(...items); } }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new Element() } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else delete globalThis.document; });
  const instance = editor(), fields = new Map();
  const form = new Element(); form.querySelectorAll = () => ['inputType', 'outputType'].map(name => fields.get(name));
  instance.field = (parent, _label, name, value) => { const field = { name, value, listeners: {}, addEventListener(event, handler) { this.listeners[event] = handler; } }; fields.set(name, field); parent.append(field); return field; };
  fields.set('inputType', { name: 'inputType', value: 'object' }); fields.set('outputType', { name: 'outputType', value: 'array' });
  const control = instance.renderToolFields(form, { executionMode: 'code', toolName: 'text.trim', language: 'javascript', code: 'return input', inputType: 'object', outputType: 'array' }); control.refresh();
  fields.get('executionMode').value = 'tool'; fields.get('executionMode').listeners.input();
  const codeSection = form.children.find(item => item.className === 'wf-code-mode-fields'), toolSection = form.children.find(item => item.className === 'wf-tool-mode-fields');
  assert.equal(codeSection.hidden, true); assert.equal(toolSection.hidden, false); assert.equal(fields.get('inputType').value, 'text'); assert.equal(fields.get('inputType').disabled, true);
  fields.get('executionMode').value = 'code'; fields.get('executionMode').listeners.input();
  assert.equal(codeSection.hidden, false); assert.equal(toolSection.hidden, true); assert.equal(fields.get('inputType').value, 'object'); assert.equal(fields.get('outputType').value, 'array');
  assert.equal(fields.get('code').value, 'return input'); assert.equal(fields.get('inputType').disabled, false);
});
