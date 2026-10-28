import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowExamplesUI } from '../public/workflow-examples-ui.js';
import { WorkflowEditor } from '../public/workflow-editor.js';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.open = true; this.classList = { toggle() {} }; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  addEventListener(type, action) { this.listeners[type] = action; }
  setAttribute(key, value) { this.attributes[key] = value; }
  close() { this.open = false; this.listeners.close?.(); }
}
const all = node => [node, ...node.children.flatMap(all)];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const catalog = [ { id: 'local-data', title: '本地数据', kind: 'execute', requiresModel: false }, { id: 'learning-text', title: '单样例学习', kind: 'learn', requiresModel: true } ];
function learningDocument(id) {
  let doc = createDocument({ schemaVersion: 2, title: '学习示例' }); doc.id = id; doc.mode = 'learn';
  doc.nodes = [createNode('input', {x: 0, y: 0}, {id: 'input', config: {outputType: 'text'}}), createNode('skill', {x: 320, y: 0}, {id: 'skill', config: {inputType: 'text', outputType: 'text'}}), createNode('output', {x: 640, y: 0}, {id: 'output'}), createNode('evaluation', {x: 640, y: 260}, {id: 'evaluation'}), createNode('improvement', {x: 960, y: 260}, {id: 'improvement', config: {targetSkillNodeIds: ['skill']}})];
  for (const [sourceNode, sourcePort, targetNode] of [['input', 'out', 'skill'], ['skill', 'out', 'output'], ['output', 'learning', 'evaluation'], ['evaluation', 'out', 'improvement']]) doc = connectNodes(doc, {sourceNode, sourcePort, targetNode, targetPort: 'in'});
  return doc;
}
function fixture(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'), animation = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: tag => new Element(tag) } });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: action => action() });
  t.after(() => { for (const [key, value] of [['document', previous], ['requestAnimationFrame', animation]]) value ? Object.defineProperty(globalThis, key, value) : delete globalThis[key]; });
  const events = [], calls = [], editor = { doc: createDocument({schemaVersion: 2}), active: true, documentLoaded: true, propertyDrafts: new Map(), settings: {},
    openDialog() { this.dialog = new Element('dialog'); return this.dialog; }, toast: (message, error) => events.push(['toast', message, error]),
    commit(document) { events.push(['commit', document.id]); this.doc = document; }, applySettings() {}, fit: () => events.push(['fit']),
    runtime: { syncWorkflow: async () => events.push(['runtime-sync']), learning: { workflowId: null, syncWorkflow: async () => events.push(['learning-sync']), setConfig: async (value, options) => events.push(['config', value, options]), syncMode() {} } },
  };
  let generation = 1;
  const config = { comparison: 'exact', trainableNodeIds: ['skill'], trainingCases: [{input: 'A', expected: 'a'}], validationCases: [{input: 'B', expected: 'b'}] };
  const result = { example: catalog[1], document: learningDocument(editor.doc.id), learningConfig: config, ready: true, requirements: [] };
  const api = async (path, options) => { calls.push({path, options}); return options ? result : { examples: catalog }; };
  const ui = new WorkflowExamplesUI(editor, { api, getGeneration: () => generation });
  return { ui, editor, events, calls, result, config, nextGeneration: () => generation++ };
}
function layoutOnCommit(editor) {
  const commit = editor.commit.bind(editor);
  editor.commit = (...args) => {
    const result = commit(...args); editor.doc = structuredClone(editor.doc);
    for (const [index, node] of editor.doc.nodes.entries()) { node.x = 120 + index * 280; node.y = index % 2 ? 240 : 80; }
    editor.doc.viewport = { x: 24, y: 60, zoom: 0.8 }; return result;
  };
}

test('the catalog groups execution and learning examples and loads a five-node learning draft into the same workflow without starting it', async t => {
  const f = fixture(t), id = f.editor.doc.id; assert.equal(await f.ui.open(), true);
  assert(all(f.editor.dialog).some(node => node.textContent === '执行示例')); assert(all(f.editor.dialog).some(node => node.textContent === '学习示例'));
  await all(f.editor.dialog).find(node => node.tagName === 'button' && node.textContent === '单样例学习').listeners.click();
  assert.deepEqual(f.calls[1], { path: '/api/workflow-examples/learning-text/prepare', options: {method: 'POST', body: {workflowId: id}} });
  assert.equal(f.editor.doc.id, id); assert.equal(f.editor.doc.nodes.length, 5); assert.equal(f.editor.doc.mode, 'learn');
  assert.deepEqual(f.events.slice(0, 4).map(row => row[0]), ['commit', 'runtime-sync', 'learning-sync', 'config']);
  assert.deepEqual(f.events.find(row => row[0] === 'config').slice(1), [f.config, {expand: true}]); assert.equal(f.editor.dialog.open, false);
  assert(f.events.some(row => row[0] === 'fit')); assert(!f.calls.some(row => /workflow-runs|workflow-learning/.test(row.path)));
});

test('the committed example is fitted after the dialog closes while a subsequent navigation cancels that fit', async t => {
  const f = fixture(t), frames = []; Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: action => frames.push(action) });
  await f.ui.open(); await f.ui.prepare('learning-text'); assert.equal(f.editor.dialog.open, false);
  frames[0](); assert(f.events.some(row => row[0] === 'fit'));
  f.events.length = 0; f.nextGeneration(); frames[0](); assert(!f.events.some(row => row[0] === 'fit'));
});

test('the laid-out committed example anchors complete learning configuration without changing the prepared template', async t => {
  const f = fixture(t), template = structuredClone(f.result.document); layoutOnCommit(f.editor);
  await f.ui.open(); assert.equal(await f.ui.prepare('learning-text'), true);
  assert.notDeepEqual(f.editor.doc.nodes.map(({ x, y }) => [x, y]), template.nodes.map(({ x, y }) => [x, y]));
  assert.deepEqual(f.result.document, template); assert.deepEqual(f.ui.session.prepared.document, f.editor.doc);
  assert.notEqual(f.ui.session.prepared.document, f.editor.doc);
  assert.deepEqual(f.events.find(row => row[0] === 'config').slice(1), [f.config, { expand: true }]);
  assert(f.events.some(row => row[0] === 'fit')); assert.equal(f.editor.dialog.open, false);
});

test('a failed learning configuration recovers against the committed layout without preparing or committing again', async t => {
  const f = fixture(t); layoutOnCommit(f.editor); let configured = 0;
  f.editor.runtime.learning.setConfig = async (value, options) => {
    assert.deepEqual(value, f.config); assert.deepEqual(options, { expand: true });
    if (++configured === 1) throw Error('配置暂时失败');
  };
  await f.ui.open(); assert.equal(await f.ui.prepare('learning-text'), false);
  const committed = structuredClone(f.editor.doc), calls = f.calls.length;
  assert.deepEqual(f.ui.session.prepared.document, committed);
  assert.equal(await f.ui.prepare('learning-text'), true); assert.deepEqual(f.editor.doc, committed);
  assert.equal(configured, 2); assert.equal(f.calls.length, calls); assert.equal(f.events.filter(row => row[0] === 'commit').length, 1);
});

for (const [name, mutate] of [
  ['node configuration', document => { document.nodes[0].config.defaultValue = '用户新输入'; }],
  ['node position', document => { document.nodes[0].x += 16; }],
]) test(`waiting for runtime sync cannot apply example configuration after the committed ${name} changes`, async t => {
  const f = fixture(t), gate = deferred(), entered = deferred(); layoutOnCommit(f.editor);
  f.editor.runtime.syncWorkflow = async () => { entered.resolve(); await gate.promise; };
  await f.ui.open(); const preparing = f.ui.prepare('learning-text'); await entered.promise;
  mutate(f.editor.doc); const changed = structuredClone(f.editor.doc); gate.resolve();
  assert.equal(await preparing, false); assert.deepEqual(f.editor.doc, changed);
  assert(!f.events.some(row => ['config', 'fit'].includes(row[0])));
});

for (const inPlace of [false, true]) test(`commit-time business changes ${inPlace ? 'to the input' : 'to a cloned document'} are rejected before runtime synchronization or learning configuration`, async t => {
  const f = fixture(t); layoutOnCommit(f.editor); const commit = f.editor.commit;
  f.editor.commit = (document, ...args) => {
    if (inPlace) document.nodes[0].config.defaultValue = '意外业务改动';
    const result = commit(document, ...args);
    if (!inPlace) f.editor.doc.nodes[0].config.defaultValue = '意外业务改动';
    return result;
  };
  await f.ui.open(); assert.equal(await f.ui.prepare('learning-text'), false);
  assert(!f.events.some(row => ['runtime-sync', 'learning-sync', 'config', 'fit'].includes(row[0])));
});

test('the existing example action delegates to the catalog instead of replacing the workflow with a fabricated Skill draft', () => {
  let opened = 0, committed = 0;
  const editor = Object.create(WorkflowEditor.prototype); Object.assign(editor, { doc: createDocument({schemaVersion: 2}), examples: {open: () => { opened++; return true; }}, commit: () => committed++, toast() {} });
  const id = editor.doc.id; assert.equal(editor.loadExample(), true); assert.equal(opened, 1); assert.equal(committed, 0); assert.equal(editor.doc.id, id);
});

for (const [name, mutate] of [
  ['another navigation to the same workflow', f => f.nextGeneration()],
  ['a changed workflow title', f => { f.editor.doc.title = '用户的新名称'; }],
  ['new nodes', f => { f.editor.doc.nodes.push(createNode('input', {x: 0, y: 0})); }],
  ['a title draft', f => { f.editor.titleDraft = {documentId: f.editor.doc.id, value: '尚未应用'}; }],
  ['property drafts', f => f.editor.propertyDrafts.set('pending', {title: '未应用'})],
  ['a newly read-only workflow', f => { f.editor.libraryReadOnly = true; }],
  ['a nested editor', f => { f.editor.nodeLibrary = {nested: {}}; }],
  ['a hidden editor', f => { f.editor.active = false; }],
  ['an unloaded editor', f => { f.editor.documentLoaded = false; }],
  ['a cancelled dialog', f => f.editor.dialog.close()],
]) test(`a pending example cannot overwrite ${name}`, async t => {
  const f = fixture(t), gate = deferred(); f.ui.api = async (_path, options) => options ? gate.promise : {examples: catalog};
  await f.ui.open(); const preparing = f.ui.prepare('learning-text'); mutate(f); gate.resolve(f.result);
  assert.equal(await preparing, false); assert(!f.events.some(row => row[0] === 'commit'));
});

test('learning form edits made while preparing an example remain untouched', async t => {
  const f = fixture(t), gate = deferred(); let form = 'before'; f.editor.runtime.learning.saveForm = () => ({text: form});
  f.ui.api = async (_path, options) => options ? gate.promise : {examples: catalog};
  await f.ui.open(); const preparing = f.ui.prepare('learning-text'); form = '用户新填的答案'; gate.resolve(f.result);
  assert.equal(await preparing, false); assert.equal(form, '用户新填的答案'); assert(!f.events.some(row => ['commit', 'config'].includes(row[0])));
});

test('missing dependencies keep an inspectable draft and report requirements without claiming that it can run', async t => {
  const f = fixture(t); f.result.ready = false; f.result.requirements = ['请先连接 Hermes。', '未找到 Skill：humanizer。'];
  await f.ui.open(); assert.equal(await f.ui.prepare('learning-text'), true);
  assert.equal(f.editor.doc.nodes.length, 5); const toast = f.events.findLast(row => row[0] === 'toast');
  assert.match(toast[1], /请先连接 Hermes/); assert.match(toast[1], /未找到 Skill/); assert.equal(toast[2], true);
});

test('an invalid or failed preparation preserves the empty document and can be retried without a second workflow identity', async t => {
  const f = fixture(t), before = structuredClone(f.editor.doc); await f.ui.open();
  const wrong = structuredClone(f.result); wrong.document.id = 'other-workflow'; f.ui.api = async () => wrong;
  assert.equal(await f.ui.prepare('learning-text'), false); assert.deepEqual(f.editor.doc, before);
  f.ui.api = async () => { throw Error('暂时离线'); }; assert.equal(await f.ui.prepare('learning-text'), false); assert.deepEqual(f.editor.doc, before);
  f.ui.api = async () => f.result; assert.equal(await f.ui.prepare('learning-text'), true); assert.equal(f.editor.doc.id, before.id);
});

test('a committed learning example retries failed configuration without preparing or committing it again', async t => {
  const f = fixture(t); let configured = 0;
  f.editor.runtime.learning.setConfig = async () => { if (++configured === 1) throw Error('配置暂时失败'); };
  await f.ui.open(); assert.equal(await f.ui.prepare('learning-text'), false);
  assert.equal(f.editor.doc.nodes.length, 5); assert.match(f.ui.session.message, /已载入.*配置未完成/);
  const calls = f.calls.length; assert.equal(await f.ui.prepare('learning-text'), true);
  assert.equal(f.calls.length, calls); assert.equal(f.events.filter(row => row[0] === 'commit').length, 1);
  assert.equal(configured, 2); assert.equal(f.editor.dialog.open, false);
});

for (const [name, mutate] of [
  ['workflow navigation', f => f.nextGeneration()],
  ['committed node changes', f => { f.editor.doc.nodes[0].title = '用户修改'; }],
  ['committed layout changes', f => { f.editor.doc.nodes[0].x += 16; }],
  ['unapplied properties', f => f.editor.propertyDrafts.set('input', { title: '用户属性草稿' })],
  ['unapplied title', f => { f.editor.titleDraft = { documentId: f.editor.doc.id, value: '新名称' }; }],
  ['learning form changes', f => { f.form = '用户新规则'; }],
]) test(`retrying partial example configuration cannot overwrite ${name}`, async t => {
  const f = fixture(t); let configured = 0; f.form = '原规则';
  f.editor.runtime.learning.saveForm = () => ({ text: f.form });
  f.editor.runtime.learning.setConfig = async () => { configured++; throw Error('首次配置失败'); };
  await f.ui.open(); assert.equal(await f.ui.prepare('learning-text'), false); const calls = f.calls.length;
  mutate(f); assert.equal(await f.ui.prepare('learning-text'), false);
  assert.equal(configured, 1); assert.equal(f.calls.length, calls); assert.equal(f.events.filter(row => row[0] === 'commit').length, 1);
});

test('unloaded, nonempty, read-only and uncommitted editors cannot fetch or load the catalog', async t => {
  const f = fixture(t);
  for (const key of ['libraryReadOnly', 'titleDraft', 'storageConflict']) { f.editor[key] = true; assert.equal(await f.ui.open(), false); delete f.editor[key]; }
  f.editor.documentLoaded = false; assert.equal(await f.ui.open(), false); f.editor.documentLoaded = true;
  f.editor.doc.nodes.push(createNode('input', {x: 0, y: 0})); assert.equal(await f.ui.open(), false); assert.equal(f.calls.length, 0);
});

test('repeated selection while preparation is in flight sends one request', async t => {
  const f = fixture(t), gate = deferred(); let preparations = 0;
  f.ui.api = async (_path, options) => { if (!options) return {examples: catalog}; preparations++; return gate.promise; };
  await f.ui.open(); const first = f.ui.prepare('learning-text'); assert.equal(await f.ui.prepare('learning-text'), false);
  assert.equal(preparations, 1); gate.resolve(f.result); assert.equal(await first, true);
});
