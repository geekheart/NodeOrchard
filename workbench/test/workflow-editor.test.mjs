import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEditor } from '../public/workflow-editor.js';
import { WorkflowStudioUI } from '../public/workflow-studio-ui.js';
import { createDocument, createNode, connectNodes, validateDocument, serializeDocument, updateNode } from '../shared/workflow/workflow-model.mjs';
import { workflowInputDefault, workflowInputValue } from '../shared/workflow/workflow-inputs.mjs';
import { WORKFLOW_TOOLS } from '../shared/workflow/workflow-tools.mjs';
import { planWorkflow } from '../shared/workflow/workflow-plan.mjs';

const STORAGE_KEY = 'workbench.workflow-editor.v1';
const MAX_BYTES = 2 * 1024 * 1024;

test('workflow file actions use the package module and an empty editor can open import without resurrecting a draft', () => {
  const instance=editor(), calls=[]; instance.packages={exportCurrent:()=>calls.push('export'),openImportDialog:()=>calls.push('import'),openFolder:()=>calls.push('folder')};
  instance.exportDocument(); instance.openImport(); assert.deepEqual(calls,['export','import']);
  instance.documentLoaded=false; const target={closest:()=>({dataset:{action:'import'}})}; instance.onClick({target});
  assert.deepEqual(calls,['export','import','import']);
  delete instance.packages; let downloaded=false; instance.download=()=>{downloaded=true;}; assert.equal(instance.exportDocument(),false); assert.equal(downloaded,false);
});

class FakeElement {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.listeners = new Map(); this.dataset = {}; this.attributes = {}; this.style = { setProperty(name, value) { this[name] = value; } };
    this.classList = { add() {}, remove() {}, toggle() {}, contains: value => (this.className || '').split(' ').includes(value) };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelector(selector) { return this.children.find(child => child.tag === selector) || this.children.map(child => child.querySelector?.(selector)).find(Boolean) || null; }
  get childElementCount() { return this.children.length; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  setPointerCapture(id) { this.capturedPointer = id; }
  remove() { this.removed = true; }
  matches(selector) { return selector.split(',').some(part => part.trim().startsWith('.') ? this.classList.contains(part.trim().slice(1)) : part.trim() === this.tag); }
  closest(selector) { return this.matches(selector) ? this : null; }
}

function globalValue(t, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  });
}

function storage(t, initial = null) {
  let raw = initial;
  globalValue(t, 'localStorage', {
    getItem(key) { assert.equal(key, STORAGE_KEY); return raw; },
    setItem(key, value) { assert.equal(key, STORAGE_KEY); raw = value; },
  });
  return () => raw;
}

function documentWith(type = 'input', position = { x: 0, y: 0 }) {
  const doc = createDocument();
  doc.nodes.push(createNode(type, position, { id: 'node-a' }));
  return doc;
}

function editor(doc = documentWith()) {
  const instance = Object.create(WorkflowEditor.prototype);
  const selectionBox = { hidden: true };
  Object.assign(instance, {
    doc, active: true, history: [], future: [], selection: new Set(), selectedEdge: null,
    propertyDrafts: new Map(), nodeElements: new Map(), edgeElements: new Map(), offsets: new Map(),
    settings: { snap: true, propertiesClosed: true }, gesture: null, pendingConnection: null,
    storageValue: null, storageConflict: false, corruptDraft: null, unsaved: true,
    canvas: {
      getBoundingClientRect: () => ({ left: 137, top: 59, width: 1200, height: 800 }),
      classList: { remove() {}, add() {} }, hasPointerCapture: () => false,
    },
    root: { querySelector: () => selectionBox, contains: target => target.insideEditor !== false }, contextMenu: { hidden: false },
    dialog: { open: false, close() { this.open = false; } },
    renderGraph() {}, renderProperties() {}, renderHeader() {}, renderRecovery() {},
    applyViewport() {}, measurePorts() {}, scheduleSave() {}, toast() {}, clearPulses() {},
    cancelConnection() { this.pendingConnection = null; },
  });
  return instance;
}

function titleField(instance) { instance.titleInput = new FakeElement('input'); instance.titleInput.value = instance.doc.title; instance.bindTitleInput(); return instance.titleInput; }

test('unloading a workflow clears its active pointer and editing state while preserving every saved draft', t => {
  const original = documentWith(), key = 'workbench.workflow-document.v1:' + original.id;
  const raw = JSON.stringify({ version: 1, document: original }), legacy = '{preserve legacy draft';
  const values = new Map([['workbench.workflow-active.v1', original.id], [key, raw], [STORAGE_KEY, legacy]]), writes = [];
  globalValue(t, 'localStorage', {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { writes.push(key); values.set(key, String(value)); },
    removeItem: key => { writes.push(key); values.delete(key); },
  });
  const instance = editor(original), classes = new Set(), empty = { hidden: true }, box = { hidden: false };
  instance.root.classList = { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } };
  instance.root.querySelector = selector => selector === '.wf-unloaded' ? empty : box;
  instance.history.push({ document: original, label: 'old edit' }); instance.future.push({ document: original });
  instance.selection.add('node-a'); instance.selectedEdge = 'old-edge'; instance.propertyDrafts.set('node-a', { title: 'unfinished' });
  instance.validationDraftErrors = new Map([['node-a', 'invalid']]); instance.runStates = { 'node-a': { status: 'complete' } };
  instance.storageKey = key; instance.storageValue = raw; instance.titleDraft = { documentId: original.id, value: 'unfinished name' };
  instance.dialog.open = true; instance.pendingConnection = { node: 'node-a' }; let nestedCancelled = false;
  instance.nodeLibrary = { cancelNested(all) { nestedCancelled = all; } };
  instance.unloadDocument();
  assert.equal(instance.documentLoaded, false); assert.equal(instance.active, false); assert.equal(empty.hidden, false); assert.ok(classes.has('document-unloaded'));
  assert.equal(values.has('workbench.workflow-active.v1'), false); assert.equal(values.get(key), raw); assert.equal(values.get(STORAGE_KEY), legacy);
  assert.deepEqual(writes, ['workbench.workflow-active.v1']); assert.notEqual(instance.doc.id, original.id); assert.deepEqual(instance.doc.nodes, []);
  assert.equal(nestedCancelled, true); assert.equal(instance.pendingConnection, null); assert.equal(instance.dialog.open, false); assert.equal(instance.contextMenu.hidden, true);
  assert.equal(instance.selection.size, 0); assert.equal(instance.selectedEdge, null); assert.equal(instance.propertyDrafts.size, 0); assert.equal(instance.validationDraftErrors.size, 0);
  assert.equal(instance.history.length, 0); assert.equal(instance.future.length, 0); assert.deepEqual(instance.runStates, {}); assert.equal(instance.titleDraft, null); assert.equal(instance.unsaved, false);
});

test('an unloaded editor only delegates create and board actions until a workflow is explicitly opened', t => {
  const values = new Map(), writes = [], original = documentWith(), instance = editor(original), empty = { hidden: true };
  globalValue(t, 'localStorage', {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { writes.push(key); values.set(key, String(value)); },
    removeItem: key => values.delete(key),
  });
  instance.root.querySelector = selector => selector === '.wf-unloaded' ? empty : { hidden: false };
  instance.requestGeometry = () => {}; let persisted = 0, created = 0, returned = 0, runs = 0;
  instance.onPersist = () => persisted++; instance.onCreateWorkflow = () => created++; instance.onReturnToBoard = () => returned++;
  instance.runtime = { start: () => runs++ }; instance.unloadDocument(); const placeholder = structuredClone(instance.doc);
  instance.activate(); instance.persist(); instance.commit(original, 'late edit'); WorkflowEditor.prototype.scheduleSave.call(instance);
  assert.equal(instance.active, false); assert.equal(instance.unsaved, false); assert.deepEqual(instance.doc, placeholder);
  assert.equal(persisted, 0); assert.deepEqual(writes, []); assert.throws(() => instance.prepareRun(), /未加载工作流/);
  for (const action of ['run', 'new', 'board']) { const button = new FakeElement('button'); button.dataset.action = action; instance.onClick({ target: button }); }
  assert.equal(created, 1); assert.equal(returned, 1); assert.equal(runs, 0); assert.deepEqual(instance.doc, placeholder);
  instance.useDocument(original, undefined, { persist: false }); instance.activate();
  assert.equal(instance.documentLoaded, true); assert.equal(empty.hidden, true); assert.equal(instance.active, true); assert.equal(instance.doc.id, original.id);
  assert.deepEqual(writes, ['workbench.workflow-active.v1']); assert.equal(values.get('workbench.workflow-active.v1'), original.id);
  assert.equal(persisted, 0); assert.equal(values.has('workbench.workflow-document.v1:' + placeholder.id), false);
});

test('collapsing the canvas hides editing panels and restoring it keeps the saved layout', t => {
  globalValue(t, 'innerWidth', 1400); globalValue(t, 'requestAnimationFrame', callback => callback());
  globalValue(t, 'document', { createElementNS: (_namespace, tag) => new FakeElement(tag) });
  const instance = editor(), classes = new Set(), toggle = new FakeElement('button'), preference = { snap: true, reduceMotion: false, canvasClosed: false, libraryClosed: false, propertiesClosed: false };
  instance.settings = { ...preference }; instance.root.classList = { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } };
  instance.root.querySelectorAll = selector => selector === '[data-action="toggle-canvas"]' ? [toggle] : [];
  instance.requestGeometry = () => {}; instance.onCanvasResize = () => {}; instance.cancelGesture = () => {}; instance.renderSelection = () => {};
  instance.setCanvasClosed(true); assert.equal(toggle.attributes['aria-label'], '显示画布');
  assert.equal(toggle.querySelector('svg').dataset.workflowIcon, 'canvas-off'); assert.equal(toggle.dataset.tooltip, '显示画布');
  for (const name of ['canvas-closed', 'library-closed', 'properties-closed']) assert.ok(classes.has(name));
  assert.deepEqual(instance.settings, { ...preference, canvasClosed: true });
  instance.selectNode('node-a'); assert.equal(instance.settings.propertiesClosed, false);
  instance.setCanvasClosed(false); assert.equal(toggle.attributes['aria-label'], '隐藏画布');
  assert.equal(toggle.querySelector('svg').dataset.workflowIcon, 'canvas'); assert.equal(toggle.dataset.tooltip, '隐藏画布');
  assert.equal(classes.has('canvas-closed'), false); assert.equal(classes.has('library-closed'), false); assert.equal(classes.has('properties-closed'), false);
  assert.deepEqual(instance.settings, preference);
});

test('run-view panel choices do not overwrite editing preferences or hidden-canvas restoration', t => {
  globalValue(t, 'innerWidth', 1400);
  const instance = editor(); instance.settings = { libraryClosed: false, propertiesClosed: false, canvasClosed: false }; instance.studio = { view: 'run' };
  instance.root.classList = { toggle() {} }; instance.root.querySelectorAll = () => []; instance.requestGeometry = () => {};
  instance.applySettings(); assert.deepEqual(instance.panelSettings(), { libraryClosed: true, propertiesClosed: true });
  instance.setPanelClosed('library', false); assert.equal(instance.panelSettings().libraryClosed, false);
  assert.deepEqual(instance.settings, { libraryClosed: false, propertiesClosed: false, canvasClosed: false });
  instance.studio.view = 'edit'; assert.equal(instance.panelSettings(), instance.settings);
  instance.studio.view = 'run'; assert.equal(instance.panelSettings().libraryClosed, false, 'explicitly opened run inputs remain open on return');
});

test('fixed input property edits parse JSON values and clearing them removes the legacy fallback', () => {
  const doc = createDocument({ schemaVersion: 2 }), node = createNode('input', {}, { config: { outputType: 'object', value: '旧版固定输入' } });
  doc.nodes = [node]; const instance = editor(doc);
  const field = { name: 'defaultValue', value: '{"query":"AI","limit":20}', type: 'textarea' }, form = { elements: { title: { value: node.title }, defaultValue: field }, querySelectorAll: () => [field] };
  const patch = instance.readForm(form, node); assert.deepEqual(patch.config.defaultValue, { query: 'AI', limit: 20 }); assert.equal(Object.hasOwn(patch.config, 'value'), false);
  const updated = updateNode(doc, node.id, patch);
  field.value = ''; const clearing = instance.readForm(form, updated.nodes[0]), cleared = updateNode(updated, node.id, clearing);
  assert.equal(cleared.nodes[0].config.defaultValue, ''); assert.equal(cleared.nodes[0].config.value, null);
  assert.equal(workflowInputDefault(cleared.nodes[0]), undefined);
  assert.equal(workflowInputValue(cleared, undefined, cleared.nodes[0]), undefined);
  field.value = '{'; assert.throws(() => instance.readForm(form, node), /默认输入必须是合法的 JSON/);
});

test('clearing a version-one fixed input remains a valid variable-input configuration', () => {
  const doc = documentWith(); doc.nodes[0].config.defaultValue = '原来的固定任务';
  const instance = editor(doc), field = { name: 'defaultValue', value: '  ', type: 'textarea' };
  const form = { elements: { title: { value: doc.nodes[0].title }, defaultValue: field }, querySelectorAll: () => [field] };
  const cleared = updateNode(doc, doc.nodes[0].id, instance.readForm(form, doc.nodes[0]));
  assert.equal(workflowInputDefault(cleared.nodes[0]), undefined);
  assert.equal(Object.hasOwn(cleared.nodes[0].config, 'value'), false);
});

test('real input properties show legacy fixed instructions and keep them when applying unrelated edits', t => {
  globalValue(t, 'document', { createElement: tag => new FakeElement(tag), createElementNS: (_namespace, tag) => new FakeElement(tag), createTextNode: text => ({ textContent: text }) });
  globalValue(t, 'Option', function (label, value) { this.textContent = label; this.value = value; });
  const doc = createDocument({ schemaVersion: 2 }); doc.nodes = [createNode('input', {}, { id: 'requirements', config: { outputType: 'text', value: '导出今日 GitHub 热榜到 Excel' } })];
  const instance = editor(doc); instance.selection = new Set(['requirements']); instance.properties = new FakeElement('aside');
  WorkflowEditor.prototype.renderProperties.call(instance);
  const descendants = item => [item, ...(item.children || []).flatMap(descendants)], form = instance.properties.children.find(item => item.className === 'wf-property-form'), fields = descendants(form).filter(item => item.name);
  const fixed = fields.find(item => item.name === 'defaultValue'); assert.ok(fixed); assert.equal(fixed.value, doc.nodes[0].config.value);
  form.elements = Object.fromEntries(fields.map(item => [item.name, item])); form.querySelectorAll = () => fields;
  form.elements.title.value = '已改名的固定任务'; const patch = instance.readForm(form, doc.nodes[0]);
  assert.equal(patch.title, '已改名的固定任务'); assert.equal(patch.config.defaultValue, doc.nodes[0].config.value); assert.equal(Object.hasOwn(patch.config, 'value'), false);
});

test('title input survives an asynchronous header render and an immediate add-node click without per-character undo entries', t => {
  globalValue(t, 'document', { activeElement: null });
  const instance = editor(), input = titleField(instance), displays = new Map(); instance.root.querySelector = selector => { if (!displays.has(selector)) displays.set(selector, { dataset: {} }); return displays.get(selector); }; instance.root.querySelectorAll = () => []; instance.selectNode = () => {};
  for (const value of ['中英文', '中英文使用指南', '中英文使用指南 · 并行审核版']) { input.value = value; input.listeners.get('input')(); }
  assert.equal(instance.history.length, 0); assert.notEqual(instance.doc.title, input.value);
  WorkflowEditor.prototype.renderHeader.call(instance); assert.equal(input.value, '中英文使用指南 · 并行审核版', 'a rerender before change or blur must retain the input draft');
  const target = { dataset: { action: 'add-input' }, classList: { contains: () => false }, closest: selector => selector === 'button' ? target : null };
  instance.onClick({ target }); assert.equal(instance.doc.title, '中英文使用指南 · 并行审核版'); assert.equal(instance.doc.nodes.length, 2); assert.equal(instance.history.filter(entry => entry.label === '修改流程名称').length, 1);
  input.listeners.get('change')(); input.listeners.get('blur')(); assert.equal(instance.history.filter(entry => entry.label === '修改流程名称').length, 1, 'late native change and blur cannot commit a second rename');
});

test('explicit save flushes an input-only title draft before persisting and Enter plus blur commits only once', t => {
  const raw = storage(t), instance = editor(), input = titleField(instance); input.value = '快速填写后保存'; input.listeners.get('input')(); instance.saveDraft();
  assert.equal(JSON.parse(raw()).document.title, '快速填写后保存'); assert.equal(instance.doc.title, '快速填写后保存'); assert.equal(instance.titleDraft, null);
  input.value = '按 Enter 保存名称'; input.listeners.get('input')(); let prevented = 0, stopped = 0;
  input.listeners.get('keydown')({ key: 'Enter', preventDefault() { prevented++; }, stopPropagation() { stopped++; } }); input.listeners.get('blur')();
  assert.equal(instance.doc.title, '按 Enter 保存名称'); assert.equal(instance.history.filter(entry => entry.label === '修改流程名称').length, 2); assert.equal(prevented, 1); assert.equal(stopped, 1);
});

test('a title draft is cleared when opening another workflow and title blur does not cancel a fresh library drag', t => {
  globalValue(t, 'localStorage', { getItem: () => null, setItem() {} }); const instance = editor(), input = titleField(instance);
  input.value = '第一条流程尚未提交的名称'; input.listeners.get('input')(); instance.requestGeometry = () => {}; const next = createDocument({ title: '另一条流程' }); instance.useDocument(next);
  assert.equal(instance.titleDraft, null); assert.equal(instance.doc.title, '另一条流程'); input.listeners.get('blur')(); assert.equal(instance.doc.title, '另一条流程');
  input.value = '拖拽前更名'; input.listeners.get('input')(); instance.gesture = { kind: 'library', type: 'tool' }; input.listeners.get('blur')(); assert.equal(instance.doc.title, '拖拽前更名'); assert.equal(instance.gesture.kind, 'library');
});

function capabilityLibrary(t) {
  globalValue(t, 'document', { createElement: tag => new FakeElement(tag), createElementNS: (_namespace, tag) => new FakeElement(tag) });
  const doc = createDocument({ schemaVersion: 2 }), instance = editor(doc), search = { value: '' }, items = new FakeElement('div'), selection = { hidden: true }, attached = [];
  Object.assign(instance.root, { append: item => attached.push(item), querySelector: selector => selector === '.wf-search' ? search : selector === '.wf-library-items' ? items : selection }); instance.selectNode = () => {}; instance.contextMenu.hidden = true;
  return { instance, search, items, attached, buttons: () => items.children.flatMap(section => section.children.filter(child => child.tag === 'button')) };
}

test('built-in tool derivations reuse search and native keyboard click while creating one complete registered tool', t => {
  globalValue(t, 'Element', FakeElement); const { instance, search, items, buttons } = capabilityLibrary(t); instance.renderLibrary();
  assert.deepEqual(items.children.filter(section => section.children[0]?.textContent === '内置派生节点').map(section => section.children[0].textContent), ['内置派生节点']); assert.ok(buttons().some(item => item.dataset.type === 'tool' && !item.dataset.toolName), 'the generic code/tool entry remains available');
  search.value = 'OpenInterfaceMark'; instance.renderLibrary(); const entries = buttons(); assert.equal(entries.length, 4); assert.ok(entries.every(item => item.dataset.toolName.startsWith('hdk.guide.annotate-')));
  const selected = entries[0], metadata = WORKFLOW_TOOLS.find(tool => tool.id === selected.dataset.toolName); let prevented = false; instance.onKeyDown({ key: 'Enter', target: selected, preventDefault() { prevented = true; } }); assert.equal(prevented, false, 'Enter keeps the native button click'); instance.onClick({ target: selected, detail: 0 });
  assert.equal(instance.doc.nodes.length, 1); assert.equal(instance.doc.edges.length, 0); const node = instance.doc.nodes[0]; assert.equal(node.title, metadata.label); assert.equal(node.config.executionMode, 'tool'); assert.equal(node.config.toolName, metadata.id); assert.deepEqual(node.ports, metadata.ports); assert.equal(node.config.resource, metadata.resource); assert.equal(node.config.timeoutSeconds, metadata.defaultConfig.timeoutSeconds); assert.equal(node.config.reviewImages, true); assert.equal(metadata.reviewRequired, true);
  instance.renderLibrary(); assert.equal(search.value, 'OpenInterfaceMark'); assert.equal(buttons().length, 4, 'creating a node must not reset the search');
});

test('professional pointer dragging follows the existing preview/drop path and preserves all metadata ports and resource settings', t => {
  const { instance, search, attached, buttons } = capabilityLibrary(t); search.value = 'hdk.full.sop'; instance.renderLibrary(); const selected = buttons().find(item => item.dataset.toolName === 'hdk.full.sop'), metadata = WORKFLOW_TOOLS.find(tool => tool.id === 'hdk.full.sop'), original = structuredClone(metadata);
  instance.canvas.classList.toggle = () => {};
  instance.canvas.getBoundingClientRect = () => ({ left: 137, top: 59, right: 1337, bottom: 859, width: 1200, height: 800 });
  instance.onPointerDown({ target: selected, button: 0, pointerId: 7, clientX: 60, clientY: 200 }); assert.equal(instance.gesture.toolName, metadata.id); assert.equal(selected.capturedPointer, 7);
  instance.onPointerMove({ target: selected, pointerId: 7, clientX: 600, clientY: 400 }); assert.equal(attached[0].textContent, metadata.label); instance.onPointerUp({ pointerId: 7, clientX: 600, clientY: 400 });
  assert.equal(instance.doc.nodes.length, 1); assert.equal(instance.doc.edges.length, 0); const node = instance.doc.nodes[0]; assert.equal(node.title, metadata.label); assert.equal(node.config.toolName, metadata.id); assert.deepEqual(node.ports, metadata.ports); assert.equal(node.config.resource, 'default'); assert.equal(node.config.reviewImages, true); assert.equal(node.config.timeoutSeconds, 600); assert.deepEqual(metadata, original); assert.equal(search.value, 'hdk.full.sop'); assert.equal(instance.gesture, null); assert.equal(attached[0].removed, true);
});

test('direct professional creation still validates registration, schema and mandatory downstream human approval', () => {
  const instance = editor(createDocument({ schemaVersion: 2 })); instance.selectNode = () => {}; let message = ''; instance.toast = text => { message = text; };
  instance.addNode('tool', { x: 0, y: 0 }, { toolName: 'hdk.full.not-registered' }); assert.equal(instance.doc.nodes.length, 0); assert.match(message, /已注册/);
  instance.doc = createDocument(); instance.addNode('tool', { x: 0, y: 0 }, { toolName: 'hdk.guide.drawio' }); assert.equal(instance.doc.nodes.length, 0); assert.match(message, /升级/);
  instance.doc = createDocument({ schemaVersion: 2 }); instance.addNode('tool', { x: 300, y: 0 }, { toolName: 'hdk.guide.drawio' }); const tool = instance.doc.nodes[0]; tool.config.reviewImages = false;
  let doc = { ...instance.doc, nodes: [createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: 'object' } }), tool, createNode('output', { x: 600, y: 0 }, { id: 'output' })] };
  doc = connectNodes(doc, { sourceNode: 'input', sourcePort: 'out', targetNode: tool.id, targetPort: 'facts' }); doc = connectNodes(doc, { sourceNode: tool.id, sourcePort: 'out', targetNode: 'output', targetPort: 'in' }); assert.throws(() => planWorkflow(doc), /人工审核/); assert.doesNotThrow(() => validateDocument(doc));
});

function learningPortFixture() {
  const instance = editor(createDocument({ schemaVersion: 2 })); instance.selectNode = () => {}; instance.addNode('tool', { x: 1600, y: 0 }, { toolName: 'hdk.full.verify' }); const producer = instance.doc.nodes[0];
  instance.doc.nodes.push(createNode('evaluation', { x: 0, y: 1000 }, { id: 'evaluation' }), createNode('improvement', { x: 320, y: 1000 }, { id: 'improvement' })); instance.doc = connectNodes(instance.doc, { sourceNode: 'evaluation', sourcePort: 'out', targetNode: 'improvement', targetPort: 'in' }); instance.doc.mode = 'learn';
  const socket = (node, port, direction) => { const button = new FakeElement('button'); button.className = 'wf-port'; button.dataset = { node, port, direction }; return button; }, source = socket(producer.id, 'out', 'output'), target = socket('evaluation', 'in', 'input');
  Object.assign(instance.canvas, { contains: () => true, focus() {}, setPointerCapture() {} }); instance.contextMenu.hidden = true; instance.refreshPortHints = () => {}; instance.drawPendingConnection = () => {}; instance.playConnectionPulse = () => {};
  return { instance, source, target, producer, down: (button, id = 1, x = 200, y = 100) => instance.onPointerDown({ target: button, pointerId: id, button: 0, clientX: x, clientY: y, preventDefault() {} }), up: (id = 1, x = 200, y = 100) => instance.onPointerUp({ pointerId: id, clientX: x, clientY: y }) };
}

test('mouse clicks connect verify.out to evaluation.in once on release without rebuilding the target during pointerdown', () => {
  const { instance, source, target, producer, down, up } = learningPortFixture(), messages = []; instance.toast = text => messages.push(text);
  down(source); up(); instance.onClick({ target: source, detail: 1 }); assert.equal(instance.doc.edges.length, 1); assert.deepEqual(instance.pendingConnection, { node: producer.id, port: 'out', direction: 'output' });
  down(target); assert.equal(instance.doc.edges.length, 1, 'the target DOM must remain in place until pointerup'); up(); instance.onClick({ target, detail: 1 }); instance.onClick({ target, detail: 0 });
  assert.equal(instance.doc.edges.length, 2); assert.deepEqual(instance.doc.edges.at(-1), { id: instance.doc.edges.at(-1).id, sourceNode: producer.id, sourcePort: 'out', targetNode: 'evaluation', targetPort: 'in' }); assert.equal(instance.pendingConnection, null); assert.equal(messages.filter(text => text === '连线已添加。').length, 1); assert.equal(messages.some(text => text.includes('学习连线只允许')), false);
});

test('dragging a learning edge uses the current drag origin rather than a previously armed port', t => {
  const { instance, source, target, producer, down, up } = learningPortFixture(); globalValue(t, 'document', { elementFromPoint: () => target }); instance.pendingConnection = { node: 'improvement', port: 'in', direction: 'input' };
  down(source); assert.equal(instance.doc.edges.length, 1, 'a new drag must not connect to the old pending improvement port'); instance.onPointerMove({ pointerId: 1, clientX: 500, clientY: 300, target }); up(1, 500, 300); instance.onClick({ target, detail: 1 });
  assert.equal(instance.doc.edges.length, 2); assert.equal(instance.doc.edges.at(-1).sourceNode, producer.id); assert.equal(instance.doc.edges.at(-1).targetNode, 'evaluation'); assert.equal(instance.pendingConnection, null);
});

test('learning property forms expose the connected comparison source and explicit main-chain-only targets', t => {
  globalValue(t, 'document', { createElement: tag => new FakeElement(tag) });
  globalValue(t, 'Option', function (title, value) { return { textContent: title, value }; });
  let doc = createDocument();
  doc.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'input' }), createNode('skill', { x: 300, y: 0 }, { id: 'main-skill', title: '导出节点', config: { skillRef: 'exporter' } }), createNode('output', { x: 600, y: 0 }, { id: 'output' }), createNode('skill', { x: 300, y: 400 }, { id: 'disconnected' }), createNode('evaluation', { x: 600, y: 300 }, { id: 'evaluation', config: { comparison: 'model', valuePath: 'acceptance.summary' } })];
  doc = connectNodes(doc, { sourceNode: 'input', sourcePort: 'out', targetNode: 'main-skill', targetPort: 'in' });
  doc = connectNodes(doc, { sourceNode: 'main-skill', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
  doc = connectNodes(doc, { sourceNode: 'output', sourcePort: 'learning', targetNode: 'evaluation', targetPort: 'in' });
  const instance = editor(doc); instance.runtime = { skills: { skills: [{ name: 'exporter', displayName: '导出与命名' }] } };
  const evaluationForm = new FakeElement('form'); instance.renderEvaluationFields(evaluationForm, doc.nodes[4], doc.nodes[4].config);
  assert.equal(evaluationForm.children[0].children[0].textContent, '由连线指定的对比产物');
  assert.match(evaluationForm.children[0].children[1].textContent, /输出.*学习产物/);
  assert.equal(evaluationForm.children[1].children[1].name, 'valuePath'); assert.equal(evaluationForm.children[1].children[1].value, 'acceptance.summary');
  assert.equal(evaluationForm.children[2].children[1].name, 'comparison'); assert.equal(evaluationForm.children[2].children[1].value, 'model');
  const improvementForm = new FakeElement('form'); instance.renderImprovementFields(improvementForm, { scope: 'skills', targetSkillNodeIds: [] });
  const rows = improvementForm.children[1].children.filter(child => child.children?.some(item => item.name === 'targetSkillNodeIds'));
  assert.equal(rows.length, 1); assert.equal(rows[0].children[1].value, 'main-skill'); assert.equal(rows[0].children[1].checked, false);
  assert.match(rows[0].children[0].textContent, /导出节点.*导出与命名/);
});

test('switching a selected merge from run to edit restores its real property form and preserves drafts', t => {
  globalValue(t, 'document', { createElement: tag => new FakeElement(tag), createElementNS: (_namespace, tag) => new FakeElement(tag), createTextNode: text => ({ textContent: text }) });
  globalValue(t, 'Option', function (label, value) { this.textContent = label; this.value = value; });
  const doc = createDocument({ schemaVersion: 2 }); doc.nodes = [createNode('merge', { x: 0, y: 0 }, { id: 'merge', title: '汇总' })];
  const instance = editor(doc), studio = Object.create(WorkflowStudioUI.prototype), before = structuredClone(doc);
  instance.root.dataset = {}; instance.properties = new FakeElement('aside'); instance.selection = new Set(['merge']);
  instance.propertyDrafts.set('merge', { title: '未应用的汇总名称', config: structuredClone(doc.nodes[0].config) });
  instance.renderProperties = WorkflowEditor.prototype.renderProperties;
  Object.assign(studio, { editor: instance, view: 'run', viewSwitch: { children: [new FakeElement('button'), new FakeElement('button')] }, runSurface: {}, setTab() {}, renderRuntime() {}, renderProperties() {},
    renderInspectorData() { instance.properties.append(new FakeElement('runtime-inspector')); } });
  instance.studio = studio; instance.applySettings = () => {};
  instance.renderProperties(); assert.equal(instance.properties.children.some(child => child.className === 'wf-property-form'), false);
  studio.setView('edit');
  const form = instance.properties.children.find(child => child.className === 'wf-property-form');
  assert.ok(form, 'editing must expose the form immediately, without a mode toggle or node reselection');
  assert.equal(form.dataset.node, 'merge'); assert.equal(form.children[0].children[1].value, '未应用的汇总名称');
  assert.equal(studio.viewSwitch.children[0].attributes['aria-pressed'], 'true');
  studio.setView('edit'); assert.equal(instance.properties.children.find(child => child.className === 'wf-property-form'), form, 'same-view synchronization must preserve the focused form');
  studio.setView('run'); assert.equal(instance.properties.children.some(child => child.className === 'wf-property-form'), false);
  assert.equal(instance.properties.children.at(-1).tag, 'runtime-inspector');
  assert.equal(instance.propertyDrafts.get('merge').title, '未应用的汇总名称'); assert.deepEqual(instance.doc, before);
});

test('improvement form reads checked node IDs as an array and never converts a checkbox into a broad boolean target', () => {
  const node = createNode('improvement', { x: 0, y: 0 }, { config: { targetSkillNodeIds: ['old-target'] } });
  const fields = [{ name: 'scope', value: 'skills', disabled: true }, { name: 'targetSkillNodeIds', value: 'skill-a', checked: false, type: 'checkbox' }, { name: 'targetSkillNodeIds', value: 'skill-b', checked: true, type: 'checkbox' }];
  const form = { elements: { title: { value: '  仅改进 B  ' } }, querySelectorAll: selector => selector === 'input[name="targetSkillNodeIds"]' ? fields.filter(field => field.name === 'targetSkillNodeIds') : fields };
  const value = WorkflowEditor.prototype.readForm(form, node);
  assert.deepEqual(value.config.targetSkillNodeIds, ['skill-b']); assert.equal(value.config.scope, 'skills'); assert.equal(value.title, '仅改进 B');
  fields[2].checked = false; assert.deepEqual(WorkflowEditor.prototype.readForm(form, node).config.targetSkillNodeIds, []);
  assert.deepEqual(node.config.targetSkillNodeIds, ['old-target']);
});

test('duplicating a connected review branch remaps its internal targets across repeated pastes and preserves only legal external Skills', () => {
  let doc = createDocument({ schemaVersion: 2 }); doc.nodes = [
    createNode('input', { x: 0, y: 0 }, { id: 'input' }), createNode('skill', { x: 300, y: 0 }, { id: 'plan', title: '规划' }), createNode('tool', { x: 600, y: 0 }, { id: 'render', title: '绘图' }),
    createNode('human', { x: 900, y: 0 }, { id: 'gate', title: '审核', config: { reviewTargetNodeId: 'plan' } }), createNode('skill', { x: 300, y: 400 }, { id: 'external', title: '其它主链 Skill' }), createNode('skill', { x: 0, y: 800 }, { id: 'disconnected' }),
    createNode('improvement', { x: 1200, y: 0 }, { id: 'improve', title: '改进', config: { targetSkillNodeIds: ['plan', 'external', 'disconnected', 'missing'] } }),
  ];
  for (const [sourceNode, targetNode] of [['input', 'plan'], ['plan', 'render'], ['render', 'gate'], ['input', 'external']]) doc = connectNodes(doc, { sourceNode, sourcePort: 'out', targetNode, targetPort: 'in' });
  const before = structuredClone(doc), instance = editor(doc), messages = []; instance.toast = message => messages.push(message); instance.selection = new Set(['plan', 'render', 'gate', 'improve']); assert.equal(instance.copySelection(), true);
  for (let i = 0; i < 2; i++) {
    instance.pasteSelection(); const copies = instance.doc.nodes.filter(node => instance.selection.has(node.id)), plan = copies.find(node => node.type === 'skill'), gate = copies.find(node => node.type === 'human'), improve = copies.find(node => node.type === 'improvement');
    assert.equal(gate.config.reviewTargetNodeId, plan.id); assert.deepEqual(improve.config.targetSkillNodeIds, [plan.id, 'external']); assert.notEqual(plan.id, 'plan');
  }
  assert.match(messages[0], /2 个.*外部.*已清空/); assert.equal(messages.length, 1, 'already-cleared external references do not return on subsequent pastes'); assert.deepEqual(doc, before); assert.equal(instance.doc.nodes.find(node => node.id === 'gate').config.reviewTargetNodeId, 'plan');
});

test('duplicating only an approval gate clears its now-unconnected external retry target and explains the change', () => {
  let doc = createDocument({ schemaVersion: 2 }); doc.nodes = [createNode('tool', { x: 0, y: 0 }, { id: 'producer' }), createNode('human', { x: 300, y: 0 }, { id: 'gate', config: { reviewTargetNodeId: 'producer' } })]; doc = connectNodes(doc, { sourceNode: 'producer', sourcePort: 'out', targetNode: 'gate', targetPort: 'in' });
  const instance = editor(doc); let message = ''; instance.toast = value => { message = value; }; instance.selection = new Set(['gate']); instance.copySelection(); instance.pasteSelection();
  assert.equal(instance.doc.nodes.find(node => instance.selection.has(node.id)).config.reviewTargetNodeId, ''); assert.equal(instance.doc.nodes.find(node => node.id === 'gate').config.reviewTargetNodeId, 'producer'); assert.match(message, /1 个.*外部审核.*已清空/);
});

test('autosave writes committed node and pan snapshots, and cancellation matches durable state', t => {
  const raw = storage(t);
  for (const kind of ['nodes', 'pan']) {
    const instance = editor();
    instance.storageValue = raw();
    const before = structuredClone(instance.doc);
    instance.gesture = kind === 'nodes'
      ? { kind, before, dragged: true }
      : { kind, viewport: structuredClone(before.viewport), dragged: true };
    if (kind === 'nodes') instance.doc.nodes[0].x = 432;
    else instance.doc.viewport = { x: 520, y: -240, zoom: 1 };

    assert.equal(instance.persist(), true, 'the pending autosave may finish during a gesture');
    assert.deepEqual(JSON.parse(raw()).document, before, 'preview movement must not become durable');
    instance.cancelGesture();
    assert.equal(instance.gesture, null);
    assert.deepEqual(instance.doc, JSON.parse(raw()).document, 'Escape/blur cancellation agrees with storage');
  }
});

test('releasing a node drag creates one undo entry and undo/redo preserve the current viewport', () => {
  const instance = editor();
  const before = structuredClone(instance.doc);
  instance.doc.nodes[0].x = 64;
  instance.gesture = { kind: 'nodes', pointerId: 7, before, dragged: true };
  instance.onPointerUp({ pointerId: 7 });
  assert.equal(instance.history.length, 1);
  assert.equal(instance.doc.nodes[0].x, 64);
  instance.doc.viewport = { x: 100, y: 80, zoom: 1.5 };
  instance.undo();
  assert.equal(instance.doc.nodes[0].x, 0);
  assert.deepEqual(instance.doc.viewport, { x: 100, y: 80, zoom: 1.5 });
  instance.undo(true);
  assert.equal(instance.doc.nodes[0].x, 64);
  assert.deepEqual(instance.doc.viewport, { x: 100, y: 80, zoom: 1.5 });
});

test('fit and automatic visibility keep boundary-coordinate documents valid', t => {
  globalValue(t, 'innerWidth', 1440);
  for (const coordinate of [-100000, 100000]) {
    const instance = editor(documentWith('input', { x: coordinate, y: coordinate }));
    instance.fit();
    assert.doesNotThrow(() => validateDocument(instance.doc));
    assert.ok(Math.abs(instance.doc.viewport.x) <= 100000);
    assert.ok(Math.abs(instance.doc.viewport.y) <= 100000);
    instance.doc.viewport = { x: 0, y: 0, zoom: 2 };
    instance.ensureVisible('node-a');
    assert.doesNotThrow(() => validateDocument(instance.doc));
    assert.ok(Math.abs(instance.doc.viewport.x) <= 100000);
    assert.ok(Math.abs(instance.doc.viewport.y) <= 100000);
  }
});

test('fit includes 25 business nodes and bottom learning nodes in the current short canvas without moving graph data', () => {
  const doc = createDocument({ schemaVersion: 2 }); doc.nodes = Array.from({ length: 25 }, (_, index) => createNode('tool', { x: (index % 5) * 340, y: Math.floor(index / 5) * 250 }, { id: `task-${index}` })); doc.nodes.push(createNode('evaluation', { x: 600, y: 1450 }, { id: 'evaluation' }), createNode('improvement', { x: 940, y: 1450 }, { id: 'improvement' }));
  const instance = editor(doc), graph = structuredClone({ nodes: doc.nodes, edges: doc.edges }), messages = []; let height = 280; instance.toast = message => messages.push(message); instance.canvas.getBoundingClientRect = () => ({ left: 137, top: 59, width: 1000, height });
  for (const node of doc.nodes) instance.offsets.set(`${node.id}:size`, { width: 270, height: node.type === 'tool' ? 210 : 180 });
  for (height of [280, 180]) {
    instance.fit(); const view = instance.doc.viewport; assert.ok(view.zoom >= .1 && view.zoom < .25);
    for (const node of instance.doc.nodes) { const size = instance.nodeSize(node.id); assert.ok(node.x * view.zoom + view.x >= -.01, node.id); assert.ok(node.y * view.zoom + view.y >= -.01, node.id); assert.ok((node.x + size.width) * view.zoom + view.x <= 1000.01, node.id); assert.ok((node.y + size.height) * view.zoom + view.y <= height + .01, node.id); }
  }
  assert.deepEqual({ nodes: instance.doc.nodes, edges: instance.doc.edges }, graph); assert.equal(messages.length, 0); assert.doesNotThrow(() => validateDocument(instance.doc));
});

test('fit reports an oversized graph at minimum zoom and manual zoom can reach ten percent', () => {
  const doc = createDocument({ schemaVersion: 2 }); doc.nodes = [createNode('tool', { x: 0, y: 0 }, { id: 'first' }), createNode('evaluation', { x: 8000, y: 10000 }, { id: 'last' })]; const instance = editor(doc); let message = ''; instance.toast = value => { message = value; }; instance.canvas.getBoundingClientRect = () => ({ left: 137, top: 59, width: 1000, height: 180 }); const nodes = structuredClone(doc.nodes);
  instance.fit(); assert.equal(instance.doc.viewport.zoom, .1); assert.match(message, /仍有节点超出画布.*平移.*收起底部面板/); assert.deepEqual(instance.doc.nodes, nodes);
  instance.zoomAt(.01); assert.equal(instance.doc.viewport.zoom, .1); assert.doesNotThrow(() => validateDocument(instance.doc));
});

test('node visibility uses the actual property overlap and ignores an adjacent desktop panel', t => {
  globalValue(t, 'innerWidth', 1440);
  const instance = editor(); instance.settings.propertiesClosed = false;
  instance.canvas.getBoundingClientRect = () => ({ left: 100, top: 80, width: 600, height: 400 });
  let panel = { left: 520, right: 700, top: 80, bottom: 480, width: 180, height: 400 };
  instance.properties = { getBoundingClientRect: () => panel };
  instance.doc.viewport = { x: 350, y: 90, zoom: 1 };
  const nodes = structuredClone(instance.doc.nodes);
  instance.ensureVisible('node-a');
  assert.equal(instance.doc.viewport.x, 182, 'node right edge keeps a 14px gap before the actual 180px overlay');
  panel = { left: 700, right: 976, top: 80, bottom: 480, width: 276, height: 400 };
  instance.doc.viewport.x = 380; instance.ensureVisible('node-a');
  assert.equal(instance.doc.viewport.x, 346, 'an adjacent panel does not reserve a second area inside the canvas');
  assert.deepEqual(instance.doc.nodes, nodes); assert.equal(instance.doc.viewport.zoom, 1);
});

test('a nearly full-width drawer preserves the horizontal camera instead of hiding its selected node', () => {
  const instance = editor(); instance.settings.propertiesClosed = false;
  instance.canvas.getBoundingClientRect = () => ({ left: 64, top: 130, width: 311, height: 400 });
  instance.properties = { getBoundingClientRect: () => ({ left: 107, right: 375, top: 130, bottom: 530, width: 268, height: 400 }) };
  instance.doc.viewport = { x: 85, y: 90, zoom: 1 };
  instance.ensureVisible('node-a');
  assert.deepEqual(instance.doc.viewport, { x: 85, y: 90, zoom: 1 });
  assert.ok(instance.doc.viewport.x + instance.nodeSize('node-a').width <= 311, 'closing the drawer reveals the node at the original camera position');
});

test('short canvases keep the node top visible and hidden canvas measurements never change the camera', () => {
  const instance = editor(); let height = 180;
  instance.canvas.getBoundingClientRect = () => ({ left: 64, top: 130, width: 311, height });
  const nodes = structuredClone(instance.doc.nodes);
  for (const [canvasHeight, expectedTop] of [[180, 55], [100, 0]]) {
    height = canvasHeight; instance.doc.viewport = { x: 25, y: 90, zoom: 1 };
    instance.ensureVisible('node-a'); assert.equal(instance.doc.viewport.y, expectedTop);
    assert.ok(instance.doc.viewport.y >= 0, 'an unavailable bottom margin cannot move the node above the canvas');
  }
  const before = structuredClone(instance.doc.viewport);
  height = 0; instance.ensureVisible('node-a'); assert.deepEqual(instance.doc.viewport, before);
  assert.deepEqual(instance.doc.nodes, nodes);
});

test('runtime inspection never pans or resizes the obscured edit canvas', () => {
  const instance = editor(documentWith('input', { x: 2500, y: 2000 })); instance.studio = { view: 'run' }; instance.canvasSize = { width: 900, height: 600 }; instance.doc.viewport = { x: 120, y: 90, zoom: .8 }; const before = structuredClone(instance.doc.viewport), size = structuredClone(instance.canvasSize); let applied = 0; instance.applyViewport = () => { applied++; };
  instance.ensureVisible('node-a'); instance.onCanvasResize(); assert.deepEqual(instance.doc.viewport, before); assert.deepEqual(instance.canvasSize, size); assert.equal(applied, 0);
  instance.studio.view = 'edit'; instance.canvas.offsetParent = null; instance.ensureVisible('node-a'); instance.onCanvasResize(); assert.deepEqual(instance.doc.viewport, before); assert.deepEqual(instance.canvasSize, size); assert.equal(applied, 0);
});

test('returning to the canvas fits only an unusable offscreen camera and preserves a usable manual view', () => {
  const instance = editor(), originalFit = instance.fit; instance.studio = { view: 'edit' }; instance.requestGeometry = () => {}; instance.doc.viewport = { x: 100, y: 90, zoom: .8 }; const valid = structuredClone(instance.doc.viewport); let fits = 0; instance.fit = function () { fits++; return originalFit.call(this); };
  assert.equal(instance.recoverCanvasViewport(), false); assert.deepEqual(instance.doc.viewport, valid); assert.equal(fits, 0);
  instance.doc.viewport = { x: -5000, y: -5000, zoom: .8 }; assert.equal(instance.recoverCanvasViewport(), true); assert.equal(fits, 1); assert.ok(instance.doc.viewport.x >= 0); assert.ok(instance.doc.viewport.y >= 0);
  instance.doc.viewport = { x: 30, y: -120, zoom: 1 }; assert.equal(instance.recoverCanvasViewport(), true, 'a tiny clipped bottom edge is not a usable canvas'); assert.equal(fits, 2);
});

test('zoom keeps the world point under the pointer fixed with an offset canvas', () => {
  const instance = editor();
  instance.doc.viewport = { x: 48, y: 90, zoom: 0.5 };
  const client = { x: 500, y: 400 };
  const before = instance.worldPoint(client.x, client.y);
  instance.zoomAt(1.5, client.x, client.y);
  const after = instance.worldPoint(client.x, client.y);
  assert.ok(Math.abs(after.x - before.x) < 1e-9);
  assert.ok(Math.abs(after.y - before.y) < 1e-9);
});

test('Save works from a text field while its Undo remains native and gesture shortcuts stay paused', t => {
  globalValue(t, 'Element', FakeElement);
  const instance = editor();
  let saved = 0, undone = 0, prevented = 0;
  instance.saveDraft = () => { saved += 1; };
  instance.undo = () => { undone += 1; };
  const event = key => ({ key, ctrlKey: true, metaKey: false, target: new FakeElement('textarea'), preventDefault() { prevented += 1; } });
  instance.onKeyDown(event('s'));
  assert.equal(saved, 1);
  assert.equal(prevented, 1, 'native Save Page is prevented');
  instance.onKeyDown(event('z'));
  assert.equal(undone, 0);
  assert.equal(prevented, 1, 'text editing keeps the browser Undo');
  instance.gesture = { kind: 'nodes' };
  instance.onKeyDown(event('s'));
  assert.equal(saved, 1);
});

test('global navigation focus leaves native keys alone and cannot edit selected workflow nodes', () => {
  const instance = editor();
  instance.selection.add('node-a');
  const before = structuredClone(instance.doc);
  const target = new FakeElement('button'); target.insideEditor = false;
  instance.saveDraft = () => assert.fail('navigation must not save the editor');
  for (const key of [' ', 'Delete', 'Backspace', 'ArrowRight', 's', 'Escape']) {
    instance.onKeyDown({ key, code: key === ' ' ? 'Space' : key, ctrlKey: key === 's', target,
      preventDefault() { assert.fail(`navigation key ${key} must keep its native behavior`); } });
  }
  assert.deepEqual(instance.doc, before);
  assert.equal(instance.space, undefined);
});

test('editor buttons, links, summaries and ports keep native activation and navigation keys', t => {
  globalValue(t, 'Element', FakeElement);
  const instance = editor(); instance.selection.add('node-a');
  const before = structuredClone(instance.doc);
  instance.deleteSelection = () => assert.fail('native controls must not delete a workflow node');
  instance.commit = () => assert.fail('native controls must not move a workflow node');
  for (const tag of ['button', 'a', 'summary']) {
    const target = new FakeElement(tag);
    for (const key of [' ', 'Enter', 'Delete', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      instance.onKeyDown({ key, code: key === ' ' ? 'Space' : key, target,
        preventDefault() { assert.fail(`${tag} key ${key} must retain native behavior`); } });
    }
  }
  const button = new FakeElement('button'), icon = new FakeElement('svg');
  icon.closest = selector => selector.split(',').some(part => part.trim() === 'button') ? button : null;
  instance.onKeyDown({ key: ' ', code: 'Space', target: icon, preventDefault() { assert.fail('button icon focus must retain native activation'); } });
  assert.equal(instance.space, undefined); assert.deepEqual(instance.doc, before);
});

test('editor controls retain Save and history shortcuts while canvas editing keys remain active', t => {
  globalValue(t, 'Element', FakeElement);
  const instance = editor(); let saved = 0, deleted = 0, prevented = 0; const undone = [];
  instance.saveDraft = () => { saved++; }; instance.undo = redo => undone.push(Boolean(redo)); instance.deleteSelection = () => { deleted++; };
  const event = (key, target, options = {}) => ({ key, code: key === ' ' ? 'Space' : key, target, ...options, preventDefault() { prevented++; } });
  const control = new FakeElement('button');
  instance.onKeyDown(event('s', control, { ctrlKey: true }));
  instance.onKeyDown(event('z', control, { metaKey: true }));
  instance.onKeyDown(event('z', control, { ctrlKey: true, shiftKey: true }));
  instance.onKeyDown(event('y', control, { ctrlKey: true }));
  assert.equal(saved, 1); assert.deepEqual(undone, [false, true, true]); assert.equal(prevented, 4);
  const canvas = new FakeElement(); instance.onKeyDown(event(' ', canvas)); instance.onKeyDown(event('Delete', canvas));
  assert.equal(instance.space, true); assert.equal(deleted, 1); assert.equal(prevented, 6);
});

test('rebound editor shortcuts replace old keys and preserve native text editing', t => {
  globalValue(t, 'Element', FakeElement);
  const instance = editor(), shortcuts = { 'workflow.save': ['Alt+S'], 'workflow.undo': ['Alt+U'],
    'workflow.redo': ['Alt+R'], 'canvas.delete': ['Alt+Delete'] };
  instance.getShortcuts = () => shortcuts;
  let saved = 0, removed = 0; const history = [];
  instance.saveDraft = () => saved++; instance.undo = redo => history.push(Boolean(redo)); instance.deleteSelection = () => removed++;
  const event = (key, target, modifiers = {}) => ({ key, target, ...modifiers, preventDefault() {} });
  const text = new FakeElement('textarea'), canvas = new FakeElement();
  instance.onKeyDown(event('s', text, { ctrlKey: true })); assert.equal(saved, 0);
  instance.onKeyDown(event('s', text, { altKey: true })); assert.equal(saved, 1);
  instance.onKeyDown(event('u', text, { altKey: true })); assert.deepEqual(history, []);
  instance.onKeyDown(event('u', canvas, { altKey: true })); instance.onKeyDown(event('r', canvas, { altKey: true })); assert.deepEqual(history, [false, true]);
  instance.onKeyDown(event('Delete', canvas)); assert.equal(removed, 0);
  instance.onKeyDown(event('Delete', canvas, { altKey: true })); assert.equal(removed, 1);
  instance.onKeyDown(event('s', text, { altKey: true, shiftKey: true })); assert.equal(saved, 1, 'additional modifiers cannot trigger a rebound action');
});

test('canvas commands share existing actions and are isolated from closed views, chat, controls and composition', t => {
  globalValue(t, 'Element', FakeElement); globalValue(t, 'innerWidth', 1200);
  const instance = editor(), calls = []; const canvas = new FakeElement();
  instance.fit = () => calls.push('fit'); instance.openHelp = () => calls.push('help'); instance.applySettings = () => calls.push('panels');
  const event = (key, target = canvas, other = {}) => ({ key, target, preventDefault() {}, ...other });
  instance.onKeyDown(event('f')); instance.onKeyDown(event('l')); instance.onKeyDown(event('p')); instance.onKeyDown(event('?', canvas, { shiftKey: true, code: 'Slash' }));
  assert.deepEqual(calls, ['fit', 'panels', 'panels', 'help']);
  assert.equal(instance.settings.libraryClosed, true); assert.equal(instance.settings.propertiesClosed, false);
  calls.length = 0;
  instance.onKeyDown(event('f', new FakeElement('textarea'))); instance.onKeyDown(event('f', new FakeElement('button')));
  const chat = new FakeElement(); chat.closest = selector => selector.includes('.wf-conversation') ? chat : null;
  instance.onKeyDown(event('f', chat));
  for (const state of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { defaultPrevented: true }]) instance.onKeyDown(event('f', canvas, state));
  instance.settings.canvasClosed = true; instance.onKeyDown(event('f')); instance.settings.canvasClosed = false;
  instance.documentLoaded = false; instance.onKeyDown(event('f')); instance.documentLoaded = true;
  instance.dialog.open = true; instance.onKeyDown(event('f')); instance.dialog.open = false;
  assert.deepEqual(calls, []);
});

test('read-only workflows reject mutation through configured shortcut keys', t => {
  globalValue(t, 'Element', FakeElement); const instance = editor(); instance.libraryLifecycle = 'trashed';
  instance.getShortcuts = () => ({ 'workflow.save': ['Alt+S'], 'workflow.undo': ['Alt+U'], 'workflow.redo': ['Alt+R'],
    'canvas.delete': ['Alt+Delete'], 'canvas.duplicate': ['Alt+D'], 'canvas.paste': ['Alt+V'] });
  for (const method of ['saveDraft', 'undo', 'deleteSelection', 'pasteSelection', 'copySelection']) instance[method] = () => assert.fail('readonly shortcuts cannot mutate a workflow');
  let prevented = 0;
  for (const key of ['s', 'u', 'r', 'Delete', 'd', 'v', 'ArrowRight']) instance.onKeyDown({ key, altKey: key !== 'ArrowRight', target: new FakeElement(), preventDefault() { prevented++; } });
  assert.equal(prevented, 7);
});

test('toolbar shortcut hints update and clear with saved bindings without accumulating old labels', () => {
  const instance = editor(), save = new FakeElement('button'), undo = new FakeElement('button');
  for (const [button, label] of [[save, '保存工作流'], [undo, '撤销']]) {
    button.className = 'wf-toolbar-button'; button.setAttribute('aria-label', label); button.title = label;
    button.getAttribute = name => button.attributes[name];
  }
  instance.root.querySelectorAll = selector => selector === '[data-action="save"]' ? [save] : selector === '[data-action="undo"]' ? [undo] : [];
  const bindings = { 'workflow.save': ['Alt+S'], 'workflow.undo': ['Alt+U'] }; instance.getShortcuts = () => bindings;
  instance.updateShortcutHints(); instance.updateShortcutHints();
  assert.equal(save.title, '保存工作流 · Alt + S'); assert.equal(save.attributes['aria-label'], save.title); assert.equal(save.dataset.tooltip, save.title);
  bindings['workflow.save'] = ['Alt+Shift+S']; bindings['workflow.undo'] = [];
  instance.updateShortcutHints(); instance.updateShortcutHints();
  assert.equal(save.title, '保存工作流 · Alt + Shift + S'); assert.equal(save.dataset.tooltip, save.title);
  assert.equal(undo.title, '撤销'); assert.equal(undo.attributes['aria-label'], '撤销'); assert.equal(undo.dataset.tooltip, '撤销');
});

test('shortcut help reads current configuration instead of advertising retired default combinations', t => {
  globalValue(t, 'document', { createElement: tag => new FakeElement(tag) });
  const instance = editor(), dialog = new FakeElement('dialog');
  instance.openDialog = () => dialog;
  instance.getShortcuts = () => ({ 'workflow.save': ['Alt+S'], 'workflow.undo': [], 'canvas.fit': ['Alt+F'] });
  instance.openHelp();
  const text = node => [node.textContent || '', ...(node.children || []).map(text)].join('\n');
  const output = text(dialog);
  assert.match(output, /保存工作流：Alt \+ S/); assert.match(output, /撤销：未设置/); assert.match(output, /适应画布：Alt \+ F/);
  assert.equal(output.includes('⌘/Ctrl + S'), false); assert.equal(output.includes('⌘/Ctrl + Z'), false);
});

test('UTF-8 size limits reject a large draft before changing document, history or stored data', t => {
  const instance = editor();
  const initial = JSON.stringify({ version: 1, document: instance.doc, ui: {} });
  const raw = storage(t, initial);
  instance.storageValue = initial;
  instance.selection.add('node-a');
  instance.propertyDrafts.set('node-a', { title: '待应用' });
  instance.future.push({ document: structuredClone(instance.doc), label: '既有重做' });
  const before = structuredClone(instance.doc), future = structuredClone(instance.future);
  const large = createDocument();
  large.nodes = Array.from({ length: 10 }, (_, i) => createNode('tool', { x: i * 16, y: 0 }, { config: { code: '中'.repeat(80000) } }));
  assert.ok(JSON.stringify(large).length < MAX_BYTES, 'character count alone would accept this draft');
  assert.ok(new Blob([serializeDocument(large)]).size > MAX_BYTES);
  assert.throws(() => instance.commit(large, '超大导入'), /2 MB/);
  assert.deepEqual(instance.doc, before);
  assert.deepEqual(instance.history, []);
  assert.deepEqual(instance.future, future);
  assert.deepEqual([...instance.selection], ['node-a']);
  assert.equal(instance.propertyDrafts.get('node-a').title, '待应用');
  instance.doc = large;
  assert.equal(instance.persist(), false);
  assert.equal(raw(), initial, 'a rejected save cannot overwrite the last valid stored draft');
  assert.equal(instance.unsaved, true);
});

test('import parse or commit failure preserves selection, pending properties and history', t => {
  globalValue(t, 'document', { createElement: tag => new FakeElement(tag) });
  for (const failure of ['parse', 'commit']) {
    const instance = editor();
    instance.selection.add('node-a');
    instance.propertyDrafts.set('node-a', { title: '还没应用的标题' });
    instance.history.push({ document: createDocument(), label: '上一步' });
    const before = structuredClone(instance.doc), history = structuredClone(instance.history);
    const dialog = new FakeElement('dialog');
    dialog.close = () => { assert.fail('failed import must stay open'); };
    instance.openDialog = () => dialog;
    instance.commit = () => { throw new Error('提交容量限制'); };
    instance.openImport(failure === 'parse' ? '{ invalid' : serializeDocument(createDocument()));
    const feedback = dialog.children[1], submit = dialog.children[2].children[2];
    submit.listeners.get('click')();
    assert.match(feedback.textContent, /导入失败/);
    assert.deepEqual(instance.doc, before);
    assert.deepEqual(instance.history, history);
    assert.deepEqual([...instance.selection], ['node-a']);
    assert.equal(instance.propertyDrafts.get('node-a').title, '还没应用的标题');
  }
});

test('route deactivation cancels preview movement, connection and modal without discarding property drafts', () => {
  const instance = editor();
  const before = structuredClone(instance.doc);
  instance.doc.nodes[0].x = 160;
  instance.gesture = { kind: 'nodes', before, dragged: true };
  instance.pendingConnection = { node: 'node-a', port: 'out', direction: 'output' };
  instance.propertyDrafts.set('node-a', { title: '尚未应用' });
  instance.dialog.open = true;
  let pulsesCleared = 0;
  instance.clearPulses = () => { pulsesCleared += 1; };
  instance.deactivate();
  assert.equal(instance.active, false);
  assert.deepEqual(instance.doc, before);
  assert.equal(instance.gesture, null);
  assert.equal(instance.pendingConnection, null);
  assert.equal(instance.contextMenu.hidden, true);
  assert.equal(instance.dialog.open, false);
  assert.equal(pulsesCleared, 1);
  assert.equal(instance.propertyDrafts.get('node-a').title, '尚未应用');
});

test('canvas panel resize preserves the centre world point, user zoom and diagram positions', () => {
  const instance = editor(), nodes = structuredClone(instance.doc.nodes); let width = 1200, height = 700, saved = 0;
  instance.canvas.getBoundingClientRect = () => ({ width, height }); instance.doc.viewport = { x: 137, y: 221, zoom: .75 }; instance.requestGeometry = () => {}; instance.scheduleSave = () => { saved++; };
  const centre = () => ({ x: (width / 2 - instance.doc.viewport.x) / instance.doc.viewport.zoom, y: (height / 2 - instance.doc.viewport.y) / instance.doc.viewport.zoom });
  const before = structuredClone(instance.doc.viewport), anchor = centre(); instance.onCanvasResize(); assert.deepEqual(instance.doc.viewport, before, 'first measurement only records the canvas size');
  width = 920; height = 280; instance.onCanvasResize(); assert.deepEqual(centre(), anchor); assert.equal(instance.doc.viewport.zoom, .75); assert.deepEqual(instance.doc.nodes, nodes); assert.equal(instance.history.length, 0);
  width = 1200; height = 700; instance.onCanvasResize(); assert.deepEqual(instance.doc.viewport, before); assert.equal(saved, 2);
  instance.onCanvasResize(); assert.equal(saved, 2, 'unchanged dimensions do not create repeated saves');
});

test('hidden canvas measurements are ignored and gesture camera baselines survive a resize', () => {
  for (const kind of ['pan', 'nodes']) {
    const instance = editor(); let width = 1000, height = 600; instance.canvas.getBoundingClientRect = () => ({ width, height }); instance.requestGeometry = () => {}; instance.doc.viewport = { x: 120, y: 80, zoom: 1.2 };
    instance.onCanvasResize(); const before = structuredClone(instance.doc);
    width = 0; height = 0; instance.onCanvasResize(); assert.deepEqual(instance.doc, before); assert.deepEqual(instance.canvasSize, { width: 1000, height: 600 });
    instance.gesture = kind === 'pan' ? { kind, viewport: structuredClone(before.viewport) } : { kind, before: structuredClone(before) };
    width = 800; height = 300; instance.onCanvasResize(); const baseline = kind === 'pan' ? instance.gesture.viewport : instance.gesture.before.viewport;
    assert.deepEqual(baseline, instance.doc.viewport); assert.equal(baseline.x, 20); assert.equal(baseline.y, -70); assert.equal(baseline.zoom, 1.2);
    instance.cancelGesture(); assert.deepEqual(instance.doc.viewport, baseline); assert.deepEqual(instance.doc.nodes, before.nodes);
  }
});

test('explicit fit at the new canvas size is not shifted again by a queued resize observation', () => {
  const instance = editor(); let width = 1000, height = 600; instance.canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width, height }); instance.requestGeometry = () => {};
  instance.onCanvasResize(); height = 280; instance.fit(); const fitted = structuredClone(instance.doc.viewport); instance.onCanvasResize(); assert.deepEqual(instance.doc.viewport, fitted);
});

test('persisted canvas dimensions compensate the first restored layout and later panel expansion', t => {
  const raw = storage(t), original = editor(); original.doc.viewport = { x: 776, y: 130, zoom: 1.25 }; original.canvasSize = { width: 1420, height: 568.875 }; const before = structuredClone(original.doc);
  assert.equal(original.persist(), true); const record = JSON.parse(raw()); assert.deepEqual(record.ui.canvasSize, original.canvasSize); assert.equal(Object.hasOwn(record.document, 'canvasSize'), false, 'viewport size is local UI metadata rather than graph schema');
  const restored = editor(); restored.restore(); assert.deepEqual(restored.canvasSize, original.canvasSize); assert.deepEqual(restored.doc, before);
  let width = 1420, height = 0; restored.canvas.getBoundingClientRect = () => ({ width, height }); restored.requestGeometry = () => {};
  const anchor = { x: (original.canvasSize.width / 2 - before.viewport.x) / before.viewport.zoom, y: (original.canvasSize.height / 2 - before.viewport.y) / before.viewport.zoom };
  restored.onCanvasResize(); assert.deepEqual(restored.canvasSize, original.canvasSize, 'hidden initial page retains the saved size');
  width = 1280; height = 1080; restored.onCanvasResize(); assert.equal((width / 2 - restored.doc.viewport.x) / restored.doc.viewport.zoom, anchor.x); assert.equal((height / 2 - restored.doc.viewport.y) / restored.doc.viewport.zoom, anchor.y);
  width = 1420; height = 568.875; restored.onCanvasResize(); assert.deepEqual(restored.doc.viewport, before.viewport); assert.deepEqual(restored.doc.nodes, before.nodes); assert.equal(restored.history.length, 0);
});

test('legacy or invalid saved canvas sizes leave the first nonzero restored viewport unchanged', t => {
  const raw = storage(t), before = documentWith(); before.viewport = { x: 250, y: 135, zoom: .8 };
  for (const canvasSize of [undefined, null, { width: 0, height: 500 }, { width: '1000', height: 500 }]) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, document: before, ui: { canvasSize } }));
    const restored = editor(); restored.restore(); restored.canvas.getBoundingClientRect = () => ({ width: 1200, height: 1080 }); restored.requestGeometry = () => {}; restored.onCanvasResize();
    assert.deepEqual(restored.doc.viewport, before.viewport); assert.deepEqual(restored.canvasSize, { width: 1200, height: 1080 }); assert.equal(restored.corruptDraft, null); assert.ok(raw());
  }
});
