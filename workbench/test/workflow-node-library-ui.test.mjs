import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowNodeLibraryUI, validationRuleFromFields, componentBoundaryDescription } from '../public/workflow-node-library-ui.js';
import { WorkflowEditor } from '../public/workflow-editor.js';
import { WorkflowLibraryClient } from '../public/workflow-library-client.js';
import { WorkflowRuntimeUI, runtimeRunCountLabel } from '../public/workflow-runtime-ui.js';
import { WorkflowStudioUI, subflowRunIds, assertChildRunBinding } from '../public/workflow-studio-ui.js';
import { NODE_TYPES, createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';
import { builtinNodePresets, presetDefinitionFromNode } from '../shared/workflow/workflow-presets.mjs';
import { WORKFLOW_TOOLS } from '../shared/workflow/workflow-tools.mjs';
import { extractSelection } from '../shared/workflow/workflow-components.mjs';

function library() { const ui = Object.create(WorkflowNodeLibraryUI.prototype); ui.tab = 'foundation'; ui.records = new Map(builtinNodePresets().map(item => [item.id, item])); ui.nestedStack = []; ui.editor = { doc: createDocument({ schemaVersion: 2 }) }; return ui; }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const immediate = () => new Promise(done => setImmediate(done));
function globalValue(t, name, value) { const descriptor = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]); }

function nestedHarness(t) {
  const values = new Map(), writes = []; globalValue(t, 'localStorage', { getItem: key => values.get(key) ?? null, setItem(key, value) { values.set(key, value); writes.push([key, value]); } }); globalValue(t, 'requestAnimationFrame', callback => callback());
  const fixture = componentFixture(), editor = Object.create(WorkflowEditor.prototype), ui = library(), box = { hidden: true };
  Object.assign(editor, { doc: fixture.document, libraryLifecycle: 'active', history: [], future: [], selection: new Set([fixture.node.id]), selectedEdge: null, propertyDrafts: new Map(), nodeElements: new Map(), edgeElements: new Map(), offsets: new Map(), runStates: {}, settings: {}, storageKey: 'workbench.workflow-document.v1:' + fixture.document.id, storageValue: null, root: { querySelector: () => box, querySelectorAll: () => [] }, canvas: { classList: { remove() {} } }, contextMenu: { hidden: true }, studio: { view: 'edit', setView() {} }, cancelGesture() {}, cancelConnection() {}, renderGraph() {}, renderProperties() {}, renderLibrary() {}, renderHeader() {}, requestGeometry() {}, fit() {}, toast(value) { this.lastToast = value; } }); ui.editor = editor; editor.nodeLibrary = ui; ui.paintNested = () => {}; return { fixture, editor, ui, values, writes };
}

test('root lifecycle events during nested editing cancel the local session without ever saving the child', async t => {
  const { fixture, editor, ui, writes, values } = nestedHarness(t), calls = [], cacheKey = 'workbench.workflow-document.v1:' + fixture.document.id; values.set(cacheKey, 'cached-root-draft'); const client = new WorkflowLibraryClient(editor, { api: async (path, options) => { calls.push([path, options]); throw new Error('unexpected request'); } }); client.currentId = fixture.document.id; client.adopt({ id: fixture.document.id, revision: 1, lifecycle: 'active', document: fixture.document });
  ui.openNested(fixture.node.id); const childId = editor.doc.id; editor.doc.title = 'local nested edit'; await client.handleLifecycle({ id: fixture.document.id, revision: 2, lifecycle: 'archived' });
  assert.equal(ui.nested, undefined); assert.notEqual(editor.doc.id, fixture.document.id); assert.equal(editor.documentLoaded, false); assert.deepEqual(editor.doc.nodes, []); assert.equal(editor.libraryReadOnly, true); assert.equal(client.currentId, null); assert.equal(client.slot(fixture.document.id).lifecycle, 'trashed'); assert.equal(client.slots.has(childId), false); assert.equal(calls.length, 0); assert.ok(writes.every(([key]) => !key.includes(childId))); assert.equal(values.get(cacheKey), 'cached-root-draft'); assert.equal(editor.libraryStatus, '');
});

test('pending root saves keep their acknowledgement while nested canvas and child autosaves stay isolated', async t => {
  const { fixture, editor, ui, writes } = nestedHarness(t), gate = deferred(), posts = []; const client = new WorkflowLibraryClient(editor, { api: async (_path, options) => { posts.push(options.body); await gate.promise; return { workflow: { id: fixture.document.id, revision: 2, lifecycle: 'active', document: options.body.document } }; } }); client.currentId = fixture.document.id; client.adopt({ id: fixture.document.id, revision: 1, lifecycle: 'active', document: fixture.document });
  editor.doc = { ...editor.doc, title: 'saved root title' }; editor.persist(); await immediate(); ui.openNested(fixture.node.id); const childId = editor.doc.id; editor.doc.title = 'unsaved child title'; editor.persist(); client.queue(editor.doc); assert.equal(editor.libraryStatus, '正在同步到看板…'); gate.resolve(); await client.flush();
  assert.equal(editor.doc.id, childId); assert.equal(editor.doc.title, 'unsaved child title'); assert.equal(editor.libraryStatus, '已保存 · 工作流看板'); assert.equal(client.slot(fixture.document.id).revision, 2); assert.equal(posts.length, 1); assert.equal(posts[0].document.id, fixture.document.id); assert.equal(client.slots.has(childId), false); assert.ok(writes.every(([key]) => !key.includes(childId)));
  client.leave(); assert.equal(editor.doc.id, fixture.document.id); assert.equal(editor.doc.title, 'saved root title'); assert.equal(ui.nested, undefined);
});

test('runtime and studio bypasses reject child run, input preflight and historical root overlays', async () => {
  const root = createDocument({ schemaVersion: 2 }), child = createDocument({ schemaVersion: 2 }), runtime = Object.create(WorkflowRuntimeUI.prototype); let requests = 0, notice = '', badges;
  runtime.editor = { doc: child, nodeLibrary: { nested: {}, rootDocument: root }, setRunStates(value) { badges = value; }, root: { querySelector: () => null } }; runtime.api = async () => { requests++; }; runtime.showNotice = value => { notice = value; }; assert.equal(runtime.currentDocument(), root); await runtime.start(); assert.match(notice, /内部修改/); runtime.syncDraftState(); assert.deepEqual(badges, {}); assert.equal(requests, 0);
  const studio = Object.create(WorkflowStudioUI.prototype); studio.editor = { doc: child, nodeLibrary: { nested: {} }, toast(value) { notice = value; }, properties: { querySelector: () => null } }; studio.api = runtime.api; studio.view = 'edit'; studio.setView('run'); assert.equal(studio.view, 'edit'); assert.equal((await studio.preflight()).ok, false); assert.equal(requests, 0); assert.doesNotThrow(() => studio.renderInspectorData('old-root-node'));
});

class FormElement {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = new Map(); this.dataset = {}; this.attributes = {}; this.style = { setProperty() {} }; this.classList = { add() {}, remove() {} }; this.elements = {}; this.value = ''; }
  append(...items) { this.children.push(...items); for (const item of items) item.parent = this; }
  replaceChildren(...items) { for (const item of this.children) item.parent = null; this.children = []; this.append(...items); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setAttribute(key, value) { this.attributes[key] = value; }
  querySelector(selector) { for (const item of this.children) { if (item.tag === selector) return item; const child = item.querySelector?.(selector); if (child) return child; } return null; }
  dispatchEvent(event) { this.listeners.get(event.type)?.(event); if (event.bubbles) this.parent?.dispatchEvent(event); return true; }
  focus() {}
  contains(item) { return this.children.some(child => child === item || child.contains?.(item)); }
  close() { this.open = false; this.closes = (this.closes || 0) + 1; }
  showModal() { this.open = true; }
}
function presetHarness(t) {
  globalValue(t, 'document', { createElement: tag => new FormElement(tag) }); const ui = library(), editor = Object.create(WorkflowEditor.prototype), node = createNode('transform', { x: 0, y: 0 }, { id: 'configured-node' }), doc = createDocument({ schemaVersion: 2 }); doc.nodes = [node];
  Object.assign(editor, { doc, libraryLifecycle: 'active', dialog: new FormElement('dialog'), propertyDrafts: new Map(), field(parent, _label, name, value) { const input = new FormElement('input'); input.value = value; parent.elements[name] = input; parent.append(input); return input; }, toast() {}, commit(next) { this.doc = next; this.commits = (this.commits || 0) + 1; } }); ui.editor = editor; ui.flushNodeDrafts = () => editor.doc; ui.render = () => {}; return { ui, editor, node };
}

const allElements = parent => [parent, ...parent.children.flatMap(allElements)];
const visibleText = parent => allElements(parent).map(item => item.textContent || '').join('\n');

test('deriving a foundation node previews its explicit parent and pins the saved parent without editing it', async t => {
  const { ui, editor, node } = presetHarness(t); let request;
  ui.api = async (_path, options) => { request = options.body; return { preset: { id: 'preset-distinct', title: '标题清理', description: '', kind: 'preset', baseType: node.type, source: 'user', version: 1, revision: 1, parent: options.body.definition.parent, definition: options.body.definition } }; };
  ui.openSavePreset(node.id);
  assert.match(editor.dialog.attributes['aria-label'], /派生/);
  assert.match(visibleText(editor.dialog), /派生自/); assert.match(visibleText(editor.dialog), /数据整理.*基础节点/);
  const form = editor.dialog.children.find(item => item.tag === 'form'); form.elements.presetTitle.value = '标题清理'; await form.listeners.get('submit')({ preventDefault() {} });
  assert.equal(request.definition.parent.kind, 'foundation'); assert.equal(request.definition.parent.baseType, 'transform');
  assert.deepEqual(editor.doc.nodes[0].origin.parent, request.definition.parent); assert.equal(editor.doc.nodes[0].origin.id, 'preset-distinct');
});

test('a further derivation names the selected derived node as its direct parent rather than its foundation', async t => {
  const { ui, editor, node } = presetHarness(t), parent = { kind: 'preset', id: 'preset-title-cleaner', version: 3, title: '标题清理', baseType: 'transform' };
  node.origin = { ...parent, parent: { kind: 'foundation', baseType: 'transform', title: '数据整理' } };
  let definition; ui.api = async (_path, options) => { definition = options.body.definition; return { preset: { id: 'preset-child', title: definition.title, kind: 'preset', baseType: 'transform', source: 'user', version: 1, revision: 1, parent: definition.parent, definition } }; };
  ui.openSavePreset(node.id); assert.match(visibleText(editor.dialog), /派生自\n标题清理 · v3/);
  const form = editor.dialog.children.find(item => item.tag === 'form'); await form.listeners.get('submit')({ preventDefault() {} });
  assert.deepEqual(definition.parent, parent); assert.deepEqual(editor.doc.nodes[0].origin.parent, parent); assert.equal(editor.doc.nodes[0].origin.id, 'preset-child');
});

test('publishing a new derived version retains its parent and remains distinct from creating a child', async t => {
  const { ui, editor, node } = presetHarness(t), parent = { kind: 'preset', id: 'preset-parent', version: 2, title: '英文标题', baseType: 'transform' };
  node.origin = { kind: 'preset', id: 'preset-current', version: 1, title: '小写标题', baseType: 'transform', parent };
  ui.records.set('preset-current', { id: 'preset-current', title: '小写标题', source: 'user', revision: 1, version: 1, kind: 'preset', baseType: 'transform', parent });
  let path, request; ui.api = async (url, options) => { path = url; request = options.body; return { preset: { ...ui.records.get('preset-current'), version: 2, revision: 2, definition: request.definition } }; };
  ui.openSavePreset(node.id, true); assert.match(visibleText(editor.dialog), /派生自\n英文标题 · v2/);
  const form = editor.dialog.children.find(item => item.tag === 'form'); await form.listeners.get('submit')({ preventDefault() {} });
  assert.equal(path, '/api/workflow-node-presets/preset-current'); assert.equal(request.expectedRevision, 1); assert.deepEqual(request.definition.parent, parent);
  assert.equal(editor.doc.nodes[0].origin.id, 'preset-current'); assert.equal(editor.doc.nodes[0].origin.version, 2); assert.deepEqual(editor.doc.nodes[0].origin.parent, parent);
});

test('derived library entries and instance properties show direct parents while legacy entries stay explicit about missing history', t => {
  globalValue(t, 'document', { createElement: tag => new FormElement(tag), createElementNS: (_ns, tag) => new FormElement(tag) });
  const ui = library(), parent = { kind: 'preset', id: 'preset-parent', version: 2, title: '英文标题', baseType: 'transform' }, definition = presetDefinitionFromNode(createNode('transform'));
  ui.records = new Map([['preset-child', { id: 'preset-child', title: '小写标题', source: 'user', kind: 'preset', baseType: 'transform', version: 1, parent, definition }], ['preset-legacy', { id: 'preset-legacy', title: '旧标题处理', source: 'user', kind: 'preset', baseType: 'transform', version: 1, definition: { ...definition, parent: undefined } }]]);
  ui.tab = 'preset'; ui.tabs = new FormElement('div'); const items = new FormElement('div'), search = new FormElement('input'); Object.assign(ui.editor, { root: { querySelector: selector => selector === '.wf-library-items' ? items : search }, studio: { executable: () => true }, properties: new FormElement('div') });
  ui.render(); assert.match(visibleText(items), /我的派生节点/); assert.match(visibleText(items), /派生自：英文标题 · v2/); assert.match(visibleText(items), /派生自：未记录/); assert.doesNotMatch(visibleText(items), /预设/);
  const node = createNode('transform', undefined, { origin: { kind: 'preset', id: 'preset-child', version: 1, title: '小写标题', baseType: 'transform', parent } }); ui.renderInspector([node]); assert.match(visibleText(ui.editor.properties), /派生自\n英文标题 · v2/); assert.match(visibleText(ui.editor.properties), /派生为特色节点/); assert.match(visibleText(ui.editor.properties), /发布新版本/);
  ui.editor.properties.replaceChildren(); delete node.origin.parent; ui.renderInspector([node]); assert.match(visibleText(ui.editor.properties), /派生自\n未记录/);
});

test('context search keeps derived candidate names readable and shows their parent before insertion', t => {
  globalValue(t, 'document', { createElement: tag => new FormElement(tag) });
  const ui = library(), parent = { kind: 'preset', id: 'preset-parent', version: 2, title: '简洁摘要', baseType: 'transform' }, definition = presetDefinitionFromNode(createNode('transform'), { title: '周报摘要', parent });
  ui.records = new Map([['preset-weekly', { id: 'preset-weekly', title: '周报摘要', kind: 'preset', baseType: 'transform', version: 1, source: 'user', parent, definition }]]);
  Object.assign(ui.editor, { contextMenu: new FormElement('div'), canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) }, worldPoint: (x, y) => ({ x, y }), cancelConnection() {}, studio: { executable: () => true }, commit(next) { this.doc = next; }, selectNode() {}, toast(message) { assert.fail(message); } });
  ui.openSearch(100, 100);
  const list = ui.editor.contextMenu.children.find(item => item.className === 'wf-context-items'), candidate = list.children.find(item => visibleText(item).includes('周报摘要 · v1'));
  assert.ok(candidate); assert.match(visibleText(candidate), /派生自：简洁摘要 · v2/);
  const foundation = list.children.find(item => visibleText(item).includes('数据整理 · 基础')); assert.ok(foundation); assert.doesNotMatch(visibleText(foundation), /派生自/);
  candidate.listeners.get('click')(); assert.equal(ui.editor.doc.nodes[0].origin.id, 'preset-weekly'); assert.deepEqual(ui.editor.doc.nodes[0].origin.parent, parent);
});

test('a preset dialog opened before archive cannot publish after lifecycle becomes read-only', async t => {
  const { ui, editor, node } = presetHarness(t); let requests = 0; ui.api = async () => { requests++; }; ui.openSavePreset(node.id); const form = editor.dialog.children.find(item => item.tag === 'form'); editor.libraryLifecycle = 'archived'; await form.listeners.get('submit')({ preventDefault() {} }); assert.equal(requests, 0); assert.equal(editor.commits, undefined); assert.match(form.children.find(item => item.tag === 'p' && item.className === 'wf-field-feedback').textContent, /只读/);
});

test('a late preset response cannot pin copied node IDs into another workflow or close a replacement dialog', async t => {
  const { ui, editor, node } = presetHarness(t), gate = deferred(); ui.api = async () => gate.promise; ui.openSavePreset(node.id); const form = editor.dialog.children.find(item => item.tag === 'form'), request = form.listeners.get('submit')({ preventDefault() {} });
  editor.doc = { ...structuredClone(editor.doc), id: 'another-flow' }; editor.dialog.replaceChildren(new FormElement('unrelated-dialog-content')); const definition = presetDefinitionFromNode(node); gate.resolve({ preset: { id: 'preset-saved', title: node.title, description: '', kind: 'preset', baseType: node.type, source: 'user', version: 1, revision: 1, definition } }); await request;
  assert.equal(editor.doc.id, 'another-flow'); assert.equal(editor.doc.nodes[0].origin, undefined); assert.equal(editor.commits, undefined); assert.equal(editor.dialog.open, true); assert.equal(editor.dialog.closes, undefined); assert.equal(ui.records.has('preset-saved'), true);
});

test('visual validation fields preserve required, nonempty and typed checks without authoring JSON', () => {
  assert.deepEqual(validationRuleFromFields({ valuePath: ' source.file ', check: 'required', message: ' 请补齐文件 ' }), { valuePath: 'source.file', check: 'required', message: '请补齐文件' });
  assert.deepEqual(validationRuleFromFields({ valuePath: 'items', check: 'nonempty' }), { valuePath: 'items', check: 'nonempty' });
  assert.deepEqual(validationRuleFromFields({ valuePath: '', check: 'type', expectedType: 'array' }), { valuePath: '', check: 'type', expectedType: 'array' });
});

test('visual equality inputs distinguish literal text, zero, false, null and JSON structures', () => {
  const rule = (valueType, expected) => validationRuleFromFields({ valuePath: 'value', check: 'equals', valueType, expected });
  assert.equal(rule('text', 'false').expected, 'false'); assert.equal(rule('number', '0').expected, 0); assert.equal(rule('boolean', 'false').expected, false); assert.equal(rule('null', '').expected, null); assert.deepEqual(rule('json', '{"count":0,"enabled":false}').expected, { count: 0, enabled: false });
  assert.throws(() => rule('number', ''), /数字无效/); assert.throws(() => rule('number', 'Infinity'), /数字无效/); assert.throws(() => rule('boolean', 'yes'), /true 或 false/); assert.throws(() => rule('json', '{'), /有效 JSON/);
  assert.throws(() => validationRuleFromFields({ valuePath: '__proto__.path', check: 'required' }), /字段路径无效/);
});

test('rule-builder controls synchronize JSON, retain invalid numeric drafts and remove the requested rule', t => {
  globalValue(t, 'document', { createElement: tag => new FormElement(tag) }); const ui = library(), node = createNode('validation', { x: 0, y: 0 }, { id: 'validation' }), form = new FormElement('form'); ui.editor.doc.nodes = [node]; ui.editor.field = (parent, _label, name, value) => { const input = new FormElement('textarea'); input.name = name; input.value = value; parent.append(input); return input; }; ui.editor.toast = value => assert.fail(value); let changes = 0; form.addEventListener('input', () => { changes++; }); ui.renderValidationFields(form, node, node.config);
  const all = parent => [parent, ...parent.children.flatMap(all)], named = name => all(form).find(item => item.attributes['aria-label'] === name), textarea = all(form).find(item => item.name === 'validationRules');
  const path = named('规则 1 字段路径'), check = named('规则 1 检查方式'); path.value = 'count'; check.value = 'type'; check.dispatchEvent(new Event('change', { bubbles: true })); const type = named('规则 1 要求类型'); type.value = 'number'; type.dispatchEvent(new Event('change', { bubbles: true })); assert.deepEqual(JSON.parse(textarea.value), [{ valuePath: 'count', check: 'type', expectedType: 'number' }]); assert.ok(changes > 0);
  check.value = 'equals'; check.dispatchEvent(new Event('change', { bubbles: true })); const valueType = named('规则 1 期望值类型'), expected = named('规则 1 期望值'); valueType.value = 'number'; expected.value = 'not a number'; expected.dispatchEvent(new Event('input', { bubbles: true })); assert.match(ui.validationBuilderErrors.get(node.id), /数字无效/); assert.deepEqual(JSON.parse(textarea.value), [{ valuePath: 'count', check: 'equals', expected: '' }], 'invalid numeric input must not replace the last accepted rule'); expected.value = '0'; expected.dispatchEvent(new Event('input', { bubbles: true })); assert.equal(ui.validationBuilderErrors.has(node.id), false); assert.equal(JSON.parse(textarea.value)[0].expected, 0);
  all(form).find(item => item.tag === 'button' && item.textContent === '添加校验规则').listeners.get('click')(); assert.equal(JSON.parse(textarea.value).length, 2); const remove = all(form).filter(item => item.tag === 'button' && item.textContent === '移除')[1]; remove.listeners.get('click')(); assert.equal(JSON.parse(textarea.value).length, 1); assert.equal(JSON.parse(textarea.value)[0].expected, 0);
});

test('simple v2 workflows expose editable preparation input, sync runtime and restore each workflow draft', t => {
  globalValue(t, 'document', { createElement: tag => new FormElement(tag) }); const values = new Map(); globalValue(t, 'localStorage', { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  const doc = createDocument({ schemaVersion: 2 }); doc.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'simple-input', config: { outputType: 'text' } })]; values.set('workbench.workflow-raw-input.v2:' + doc.id, 'restored text');
  const studio = Object.create(WorkflowStudioUI.prototype); Object.assign(studio, { editor: { doc }, runtime: { input: new FormElement('textarea') }, inputs: new FormElement('div'), inputNotice: new FormElement('p'), values: {}, invalidatePreflight() { this.invalidated = (this.invalidated || 0) + 1; } }); studio.renderInputs(); assert.equal(studio.rawPreparationInput.value, 'restored text'); assert.equal(studio.runtime.input.value, 'restored text');
  studio.rawPreparationInput.value = 'next input'; studio.rawPreparationInput.listeners.get('input')(); assert.equal(studio.runtime.input.value, 'next input'); assert.equal(values.get('workbench.workflow-raw-input.v2:' + doc.id), 'next input'); assert.equal(studio.invalidated, 1);
  studio.editor.doc = { ...structuredClone(doc), id: 'another-flow' }; studio.renderInputs(); assert.equal(studio.rawPreparationInput.value, ''); assert.equal(studio.runtime.input.value, ''); studio.editor.doc = doc; studio.renderInputs(); assert.equal(studio.rawPreparationInput.value, 'next input');
  studio.editor.doc = { ...structuredClone(doc), nodes: [createNode('input', { x: 0, y: 0 }, { id: 'structured-input', config: { outputType: 'object', fields: [{ key: 'path', label: '文件', kind: 'file', required: true }] } })] }; studio.renderInputs(); assert.equal(studio.rawPreparationInput, null);
});

test('DAG run summary counts composed and validation nodes instead of reporting zero abilities', () => {
  const run = { schemaVersion: 2, document: { schemaVersion: 2, nodes: [{ id: 'input', type: 'input' }, { id: 'component', type: 'subflow' }, { id: 'validation', type: 'validation' }, { id: 'output', type: 'output' }, { id: 'learning', type: 'evaluation' }] }, nodes: { input: { status: 'complete' }, component: { status: 'complete' }, validation: { status: 'complete' }, output: { status: 'complete' }, learning: { status: 'skipped' } } };
  assert.equal(runtimeRunCountLabel(run), '4 / 4 个业务节点完成'); assert.equal(runtimeRunCountLabel(run, { summary: true }), '4 / 4 个业务节点'); run.nodes.validation.status = 'skipped'; assert.equal(runtimeRunCountLabel(run), '3 / 4 个业务节点完成 · 1 个跳过'); assert.equal(runtimeRunCountLabel({ document: { nodes: [{ type: 'skill' }, { type: 'tool' }] } }), '2 项能力');
});

test('component boundary descriptions use node and port names without exposing technical identifiers', () => {
  const doc = createDocument({ schemaVersion: 2 }); doc.nodes = [createNode('transform', { x: 0, y: 0 }, { id: 'node-technical-uuid', title: '清理文本' })];
  const input = componentBoundaryDescription(doc, { type: 'text', targets: [{ nodeId: 'node-technical-uuid', portId: 'in' }] }, 'inputs'), output = componentBoundaryDescription(doc, { type: 'text', sourceNode: 'node-technical-uuid', sourcePort: 'out' }, 'outputs'); assert.match(input, /清理文本/); assert.match(output, /清理文本/); assert.doesNotMatch(input + output, /node-technical-uuid|undefined/);
});

function childHistoryFixture() {
  const childDoc = { id: 'internal-workflow', title: '清理并校验', schemaVersion: 2, nodes: [{ id: 'normalize', type: 'transform', title: '清理文本' }, { id: 'check', type: 'validation', title: '检查格式' }], edges: [] }, state = { status: 'complete', attempt: 2, subflowProgress: { childRunIds: ['child-run'], childRunId: null } };
  const parent = { id: 'parent-run', document: { id: 'root-workflow', nodes: [{ id: 'component', type: 'subflow', title: '整理资料', config: { document: childDoc } }] }, nodes: { component: state } }, child = { id: 'child-run', parentRunId: parent.id, workflowId: childDoc.id, document: childDoc, status: 'complete', input: ' input ', output: false, nodeOrder: ['normalize', 'check'], nodes: { normalize: { status: 'complete', input: ' input ', output: 'input' }, check: { status: 'complete', input: 0, output: false } } }; return { parent, child, state };
}

test('child history binding requires this parent, node attempt index and embedded workflow snapshot', () => {
  const { parent, child, state } = childHistoryFixture(); assert.deepEqual(subflowRunIds({ subflowProgress: { childRunIds: ['child-run', 'child-run'] }, review: { childRunId: 'review-child' } }), ['child-run', 'review-child']); assert.equal(assertChildRunBinding(parent, 'component', state, child), child);
  assert.throws(() => assertChildRunBinding(parent, 'component', state, { ...child, parentRunId: 'other-parent' }), /不匹配/); assert.throws(() => assertChildRunBinding(parent, 'component', { ...state, subflowProgress: { childRunIds: ['earlier-attempt'] } }, child), /不匹配/); assert.throws(() => assertChildRunBinding(parent, 'component', state, { ...child, workflowId: 'other-workflow' }), /不匹配/);
});

test('viewing completed child runs renders internal states and falsey I/O read-only without changing canvas or running anything', async t => {
  globalValue(t, 'document', { createElement: tag => new FormElement(tag) }); const { parent, child, state } = childHistoryFixture(), studio = Object.create(WorkflowStudioUI.prototype), calls = [];
  studio.editor = { doc: parent.document }; studio.runtime = { currentRunId: parent.id }; studio.api = async (path, options) => { calls.push([path, options]); return { run: child }; };
  const section = studio.subflowHistory(parent, 'component', state), slot = section.children[1], open = slot.children[0]; assert.equal(open.textContent, '查看子流程运行'); await open.listeners.get('click')();
  const flatten = node => [node, ...node.children.flatMap(flatten)], contents = flatten(section), text = contents.map(item => item.textContent || '').join('\n'); assert.match(text, /清理文本 · 已完成/); assert.match(text, /检查格式 · 已完成/); assert.ok(contents.some(item => item.tag === 'pre' && item.textContent === '0')); assert.ok(contents.some(item => item.tag === 'pre' && item.textContent === 'false')); assert.doesNotMatch(text, /重跑|通过并继续|要求修改/); assert.equal(studio.editor.doc, parent.document); assert.equal(studio.runtime.currentRunId, parent.id); assert.deepEqual(calls, [['/api/workflow-runs/child-run', undefined]]);
});

test('child history loader rejects a different parent response without exposing its internal output', async t => {
  globalValue(t, 'document', { createElement: tag => new FormElement(tag) }); const { parent, child, state } = childHistoryFixture(), studio = Object.create(WorkflowStudioUI.prototype); studio.api = async () => ({ run: { ...child, parentRunId: 'wrong-parent', output: 'unrelated-output' } }); const section = studio.subflowHistory(parent, 'component', state), slot = section.children[1]; await slot.children[0].listeners.get('click')(); const error = slot.children[1].children[0]; assert.match(error.textContent, /不匹配/); assert.doesNotMatch(error.textContent, /unrelated-output/); assert.equal(studio.subflowInspectionRuns.size, 0);
});

test('library presents all fourteen foundation behaviors separately from built-in configured tool presets', () => {
  const ui = library(); assert.equal(ui.entries().length, 14); assert.deepEqual(new Set(ui.entries().map(item => item.type)), new Set(NODE_TYPES.map(item => item.type))); assert.ok(ui.entries().every(item => item.foundation));
  ui.tab = 'preset'; const entries = ui.entries(); assert.equal(entries.length, WORKFLOW_TOOLS.length); assert.ok(entries.every(item => item.type === 'tool' && !item.foundation && item.group === 'builtin')); assert.equal(new Set(entries.map(item => item.key)).size, entries.length);
  ui.tab = 'component'; assert.deepEqual(ui.entries(), []);
});

test('unified candidates search base types, configured descriptions and exact registered tool names without domain menus', () => {
  const ui = library(); const entries = ui.entries({ all: true, query: 'text.uppercase' }); assert.equal(entries.length, 1); assert.equal(entries[0].record.definition.node.config.toolName, 'text.uppercase');
  assert.equal(ui.entries({ all: true, query: 'validation' })[0].type, 'validation'); ui.tab = 'foundation'; assert.deepEqual(ui.entries({ query: 'text.uppercase' }), []); assert.equal(ui.entries({ all: true }).length, NODE_TYPES.length + WORKFLOW_TOOLS.length);
});

test('creating preset candidates makes fresh pinned instances and never mutates their shared definitions', () => {
  const ui = library(), entry = ui.entries({ all: true }).find(item => item.record?.toolName === 'text.trim'), before = structuredClone(entry.record);
  const first = ui.createEntry(entry, { x: 1, y: 2 }), second = ui.createEntry(entry, { x: 3, y: 4 }); assert.notEqual(first.id, second.id); assert.equal(first.origin.id, entry.key); assert.equal(first.origin.version, 1); assert.deepEqual(first.ports, entry.record.definition.node.ports); assert.equal(first.config.reviewImages, false); assert.deepEqual(entry.record, before);
});

test('foundation output is explicitly final while validation has executable passthrough rules', () => {
  const ui = library(); const output = ui.createEntry(ui.entries().find(item => item.type === 'output'), { x: 0, y: 0 }), validation = ui.createEntry(ui.entries().find(item => item.type === 'validation'), { x: 0, y: 0 }); assert.equal(output.config.stage, 'final'); assert.deepEqual(validation.config.rules, [{ valuePath: '', check: 'required' }]); assert.equal(validation.type, 'validation');
});

test('adding a configured preset is guarded by lifecycle and schema before canvas mutation', () => {
  const ui = library(), id = [...ui.records.keys()][0]; let commits = 0, message = ''; Object.assign(ui.editor, { libraryReadOnly: true, commit() { commits++; }, toast(value) { message = value; } }); ui.addPreset(id); assert.equal(commits, 0);
  ui.editor.libraryReadOnly = false; ui.editor.flushTitleDraft = () => true; ui.editor.doc = createDocument(); ui.addPreset(id); assert.match(message, /升级/); assert.equal(commits, 0);
});

test('the legacy tool-add entry also records its built-in derivation and foundation parent', () => {
  const editor = Object.create(WorkflowEditor.prototype), record = builtinNodePresets().find(item => item.toolName === 'text.trim');
  Object.assign(editor, { doc: createDocument({ schemaVersion: 2 }), nodeElements: new Map(), canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) }, flushTitleDraft: () => true, worldPoint: (x, y) => ({ x, y }), snapPosition: point => point, commit(next) { this.doc = next; }, selectNode() {}, toast(value, failed) { if (failed) assert.fail(value); } });
  const node = editor.addNode('tool', { x: 100, y: 100 }, { toolName: record.toolName });
  assert.equal(node.origin.id, record.id); assert.equal(node.origin.parent.kind, 'foundation'); assert.equal(node.origin.parent.baseType, 'tool');
});

test('local nested edits cannot autosave or admit a child document as a root run', () => {
  const editor = Object.create(WorkflowEditor.prototype); let persisted = 0, rendered = 0; Object.assign(editor, { nodeLibrary: { nested: {} }, onPersist() { persisted++; }, renderHeader() { rendered++; }, libraryLifecycle: 'active' });
  editor.scheduleSave(); assert.equal(editor.unsaved, true); assert.equal(rendered, 1); assert.equal(editor.saveTimer, undefined); assert.equal(editor.persist(), true); assert.equal(persisted, 0); assert.throws(() => editor.prepareRun(), /先应用或取消/);
});

test('invalid validation JSON blocks save/run instead of executing an older accepted rule silently', () => {
  const editor = Object.create(WorkflowEditor.prototype); let message = ''; Object.assign(editor, { validationDraftErrors: new Map([['validation', { raw: '[', message: 'JSON' }]]), toast(value) { message = value; } }); assert.throws(() => editor.prepareRun(), /无效的 JSON/); editor.saveDraft(); assert.match(message, /无效的 JSON/);
});

function componentFixture() {
  let doc = createDocument({ schemaVersion: 2 }); doc.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'source', config: { outputType: 'object' } }), createNode('transform', { x: 320, y: 0 }, { id: 'first', config: { inputType: 'object', outputType: 'object', code: 'return input' } }), createNode('transform', { x: 640, y: 0 }, { id: 'second', config: { inputType: 'object', outputType: 'object', code: 'return input' } }), createNode('output', { x: 960, y: 0 }, { id: 'result' })];
  for (const [sourceNode, targetNode] of [['source', 'first'], ['first', 'second'], ['second', 'result']]) doc = connectNodes(doc, { sourceNode, sourcePort: 'out', targetNode, targetPort: 'in' });
  return extractSelection(doc, ['first', 'second'], { title: '两步整理' });
}

test('nested cancellation restores root history, selection, storage identity and drafts without persisting', t => {
  const previous = globalThis.requestAnimationFrame; globalThis.requestAnimationFrame = callback => callback(); t.after(() => { if (previous) globalThis.requestAnimationFrame = previous; else delete globalThis.requestAnimationFrame; });
  const ui = library(), fixture = componentFixture(), parent = fixture.document; let commits = 0;
  Object.assign(ui.editor, { doc: parent, history: [{ label: 'before', document: parent }], future: [], selection: new Set([fixture.node.id]), propertyDrafts: new Map(), runStates: { source: { status: 'complete' } }, unsaved: true, storageKey: 'parent-key', storageValue: 'parent-value', flushTitleDraft: () => true, cancelGesture() {}, cancelConnection() {}, captureDocumentState: WorkflowEditor.prototype.captureDocumentState, studio: { view: 'edit', setView() {} }, fit() {}, commit() { commits++; }, toast(message) { assert.fail(message); } }); ui.paintNested = () => {};
  ui.openNested(fixture.node.id); assert.ok(ui.nested); assert.equal(ui.rootDocument, parent); assert.notEqual(ui.editor.doc.id, parent.id); assert.equal(ui.editor.propertyDrafts.size, 0); ui.editor.doc.title = 'discarded'; ui.cancelNestedForExternalChange(); assert.equal(ui.nested, undefined); assert.equal(ui.editor.doc, parent); assert.equal(ui.editor.storageKey, 'parent-key'); assert.deepEqual([...ui.editor.selection], [fixture.node.id]); assert.equal(ui.editor.history[0].label, 'before'); assert.equal(commits, 0);
});

test('applying nested edits commits only the new fixed snapshot and retains parent identity and preset pin', async t => {
  const previous = globalThis.requestAnimationFrame; globalThis.requestAnimationFrame = callback => callback(); t.after(() => { if (previous) globalThis.requestAnimationFrame = previous; else delete globalThis.requestAnimationFrame; });
  const ui = library(), fixture = componentFixture(), parent = fixture.document; let committed; const original = structuredClone(parent);
  Object.assign(ui.editor, { doc: parent, history: [], future: [], selection: new Set([fixture.node.id]), propertyDrafts: new Map(), runStates: {}, storageKey: 'root', storageValue: 'value', flushTitleDraft: () => true, cancelGesture() {}, cancelConnection() {}, captureDocumentState: WorkflowEditor.prototype.captureDocumentState, studio: { view: 'edit', setView() {} }, fit() {}, commit(next) { committed = next; this.doc = next; }, toast() {} }); ui.paintNested = () => {};
  ui.openNested(fixture.node.id); const internal = ui.editor.doc.nodes.find(node => node.id === 'first'); internal.title = '修改后的第一步'; await ui.applyNested(); assert.equal(ui.nested, undefined); assert.equal(committed.id, original.id); assert.equal(committed.nodes.find(node => node.id === fixture.node.id).config.document.nodes.find(node => node.id === 'first').title, '修改后的第一步'); assert.deepEqual(parent, original, 'the previous parent snapshot is immutable'); assert.deepEqual(committed.edges, original.edges);
});

test('applying a nested camera-only change preserves the parent snapshot without committing or saving content', async t => {
  const { fixture, editor, ui } = nestedHarness(t);
  fixture.document.nodes.find(node => node.id === fixture.node.id).config.document.viewport = { x: 9000, y: -6000, zoom: .3 };
  const before = structuredClone(fixture.document); let commits = 0, saves = 0;
  editor.commit = () => { commits++; }; editor.scheduleSave = () => { saves++; };
  ui.openNested(fixture.node.id); editor.doc.viewport = { x: -420, y: 390, zoom: 1.6 };
  await ui.applyNested();
  assert.equal(ui.nested, undefined); assert.equal(commits, 0); assert.equal(saves, 0);
  assert.deepEqual(editor.doc, before); assert.deepEqual(fixture.document, before);
});

test('nested editing pauses the parent automatic save and returning keeps its original elapsed deadline', t => {
  let now = 0, sequence = 0; const tasks = new Map(), published = [];
  const { fixture, editor, ui } = nestedHarness(t);
  globalValue(t, 'setTimeout', (callback, delay) => { const id = ++sequence; tasks.set(id, { callback, at: now + delay }); return id; });
  globalValue(t, 'clearTimeout', id => tasks.delete(id)); t.mock.method(Date, 'now', () => now);
  editor.onPersist = document => published.push(document.id); editor.scheduleSave();
  now = 300_000; ui.openNested(fixture.node.id); editor.doc.nodes[0].title = '仅内部草稿'; editor.scheduleSave();
  now = 900_000; assert.equal(tasks.size, 0, 'neither the suspended parent nor child starts a remote save'); assert.deepEqual(published, []);
  ui.cancelNested(); assert.equal(tasks.size, 1);
  const [id, task] = [...tasks][0]; assert.equal(task.at, now, 'an elapsed parent deadline resumes immediately'); tasks.delete(id); task.callback();
  assert.deepEqual(published, [fixture.document.id]); assert.equal(editor.unsaved, false);
});

test('applying real nested node movement preserves its position and saves only the child fitted viewport', async t => {
  const { fixture, editor, ui } = nestedHarness(t), parent = structuredClone(fixture.document); let committed;
  editor.commit = next => { committed = next; editor.doc = next; };
  ui.openNested(fixture.node.id);
  const moved = editor.doc.nodes.find(node => node.id === 'first'); moved.x += 240; moved.y += 80;
  editor.doc.viewport = { x: 7000, y: -4000, zoom: .3 };
  const actual = structuredClone(moved), fitted = editor.persistenceDocument();
  await ui.applyNested();
  const child = committed.nodes.find(node => node.id === fixture.node.id).config.document;
  assert.deepEqual(child.nodes.find(node => node.id === 'first'), actual); assert.deepEqual(child.viewport, fitted.viewport);
  assert.deepEqual(committed.viewport, parent.viewport); assert.deepEqual(parent, fixture.document);
});

test('invalid boundary edits stay in the nested editor and never replace the parent', async t => {
  const previous = globalThis.requestAnimationFrame; globalThis.requestAnimationFrame = callback => callback(); t.after(() => { if (previous) globalThis.requestAnimationFrame = previous; else delete globalThis.requestAnimationFrame; });
  const ui = library(), fixture = componentFixture(), parent = fixture.document; let message = '', commits = 0;
  Object.assign(ui.editor, { doc: parent, history: [], future: [], selection: new Set([fixture.node.id]), propertyDrafts: new Map(), runStates: {}, flushTitleDraft: () => true, cancelGesture() {}, cancelConnection() {}, captureDocumentState: WorkflowEditor.prototype.captureDocumentState, studio: { view: 'edit', setView() {} }, fit() {}, commit() { commits++; }, toast(value) { message = value; } }); ui.paintNested = () => {};
  ui.openNested(fixture.node.id); const boundary = ui.editor.doc.nodes.find(node => node.type === 'input'); assert.equal(ui.isBoundaryNode(boundary.id), true); boundary.config.fieldName = 'changed'; await ui.applyNested(); assert.ok(ui.nested); assert.equal(commits, 0); assert.equal(ui.rootDocument, parent); assert.match(message, /边界输入输出保持固定/);
});
