import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowVersioningUI, assertWorkflowVersionSource } from '../public/workflow-versioning-ui.js';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const clone = value => structuredClone(value);
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.listeners = new Map(); this.dataset = {}; this.value = ''; this.open = false; this.disabled = false; this.className = ''; this.classList = { toggle() {} }; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get('close')?.({}); }
  focus() {}
}
function sourceDocument(id = 'workflow-original') {
  let document = { ...createDocument({ schemaVersion: 2, title: '资料清单' }), id,
    nodes: [createNode('input', { x: 0, y: 0 }, { id: 'source', config: { outputType: 'object', fields: [{ key: 'name', label: '资料名称', kind: 'text', required: true }] } }),
      createNode('tool', { x: 340, y: 0 }, { id: 'keys', config: { executionMode: 'tool', toolName: 'json.keys', inputType: 'object', outputType: 'array' } }),
      createNode('human', { x: 680, y: 0 }, { id: 'review', config: { inputType: 'array', outputType: 'array', reviewTargetNodeId: 'keys', prompt: '审核资料清单。' } }),
      createNode('output', { x: 1020, y: 0 }, { id: 'delivery' })], edges: [] };
  for (const [sourceNode, targetNode] of [['source', 'keys'], ['keys', 'review'], ['review', 'delivery']]) document = connectNodes(document, { sourceNode, sourcePort: 'out', targetNode, targetPort: 'in' });
  return document;
}
const recordFor = (document, revision = 7) => ({ id: document.id, document: clone(document), revision, lifecycle: 'active', origin: 'saved' });
function harness(t) {
  const previous = globalThis.document; globalThis.document = { createElement: tag => new Element(tag) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const document = sourceDocument(), header = new Element('header'), root = new Element('div'), messages = [], created = [], requests = [];
  root.querySelector = selector => { assert.equal(selector, '.wf-header-actions'); return header; };
  const editor = { doc: document, root, libraryLifecycle: 'active', libraryReadOnly: false,
    nodeLibrary: {}, propertyDrafts: new Map(), validationDraftErrors: new Map(), toast: (...args) => messages.push(args) };
  const ui = new WorkflowVersioningUI(editor, { api: async (path, options) => {
    requests.push([path, clone(options)]);
    if (options?.method === 'POST') return { workflow: recordFor(options.body.document, 1) };
    assert.equal(path, `/api/workflow-library/${document.id}`); return { workflow: recordFor(document) };
  }, onCreated: async (record, options) => created.push({ record: clone(record), options: clone(options) }) });
  return { ui, editor, document, header, messages, created, requests };
}
const posts = requests => requests.filter(([, options]) => options?.method === 'POST');

test('toolbar opens a saved-source preview with opt-in actions and a separate new workflow identity', async t => {
  const { ui, document, header, requests } = harness(t), before = clone(document);
  assert.equal(header.children[0].textContent, '另存为新版'); assert.equal(ui.dialog.attributes['aria-label'], '另存为新版工作流');
  assert.equal(await ui.open(), true); const preview = ui.session.preview;
  assert.notEqual(preview.document.id, document.id); assert.equal(preview.report.toolPresets, 1); assert.equal(preview.report.validationNodes, 1); assert.equal(preview.report.stageOutputs, 1);
  assert.ok(Object.values(ui.options).every(input => input.checked)); assert.equal(ui.submitButton.textContent, '创建新版');
  assert.equal(posts(requests).length, 0); assert.deepEqual(document, before);
});

test('title and option previews keep one workflow ID while all disabled upgrades give an ordinary copy', async t => {
  const { ui, document } = harness(t); await ui.open(); const id = ui.session.preview.document.id;
  ui.titleInput.value = '普通副本'; ui.titleInput.listeners.get('input')();
  for (const input of Object.values(ui.options)) { input.checked = false; input.listeners.get('change')(); }
  const { document: preview, report } = ui.session.preview;
  assert.equal(preview.id, id); assert.equal(preview.title, '普通副本'); assert.equal(preview.nodes.length, document.nodes.length); assert.equal(preview.edges.length, document.edges.length);
  assert.equal(report.toolPresets, 0); assert.equal(report.validationNodes, 0); assert.equal(report.stageOutputs, 0);
});

test('creation checks the source revision twice, saves only the new document, and supplies input remapping to the caller', async t => {
  const { ui, document, editor, created, requests } = harness(t), before = clone(document); await ui.open(); const preview = clone(ui.session.preview);
  assert.equal(await ui.submit(), true);
  const writes = posts(requests); assert.equal(writes.length, 1); assert.equal(writes[0][0], '/api/workflow-library'); assert.equal(writes[0][1].body.expectedRevision, 0);
  assert.deepEqual(writes[0][1].body.document, preview.document); assert.equal(requests.filter(([, options]) => !options).length, 2);
  assert.equal(created.length, 1); assert.deepEqual(created[0].options, { report: preview.report, copyInputs: true, sourceId: document.id, sourceRevision: 7 });
  assert.deepEqual(editor.doc, before); assert.equal(ui.dialog.open, false); assert.equal(ui.session.finished, true);
});

test('new version callback may navigate without a pending-dialog close handler reopening the finished dialog', async t => {
  const { ui, editor } = harness(t); await ui.open();
  ui.onCreated = record => { editor.doc = record.document; ui.syncHeader(); };
  await ui.submit(); assert.equal(editor.doc.id, ui.session.candidate.id); assert.equal(ui.dialog.open, false); assert.equal(ui.session.finished, true);
});

test('unapplied properties, invalid validation, title drafts, conflicts, read-only and nested documents never issue a read or save', async t => {
  const { ui, editor, requests } = harness(t);
  const cases = [
    ['propertyDrafts', new Map([['keys', { title: 'draft' }]])], ['validationDraftErrors', new Map([['check', { message: 'invalid' }]])],
    ['titleDraft', { documentId: editor.doc.id, value: 'draft' }], ['storageConflict', true], ['corruptDraft', 'invalid json'],
    ['libraryError', 'conflict'], ['saveError', 'failed'], ['libraryLifecycle', 'archived'], ['libraryReadOnly', true], ['nodeLibrary', { nested: {} }],
  ];
  for (const [key, value] of cases) { const previous = editor[key]; editor[key] = value; assert.throws(() => assertWorkflowVersionSource(editor)); assert.equal(await ui.open(), false); editor[key] = previous; }
  const schema = editor.doc.schemaVersion; editor.doc.schemaVersion = 1; assert.equal(await ui.open(), false); editor.doc.schemaVersion = schema;
  assert.equal(requests.length, 0);
});

test('unsaved canvas content is rejected instead of copying an older persisted source', async t => {
  const { ui, editor, document, requests } = harness(t), saved = recordFor(document); editor.doc = clone(document); editor.doc.title = '本地尚未同步';
  ui.api = async (path, options) => { requests.push([path, options]); return { workflow: saved }; };
  assert.equal(await ui.open(), false); assert.equal(ui.session.preview, undefined); assert.match(ui.session.message, /先保存原版/); assert.equal(posts(requests).length, 0);
});

test('a late source GET cannot preview or create on a workflow opened while loading', async t => {
  const { ui, editor, document } = harness(t), gate = deferred(); let writes = 0;
  ui.api = async (_path, options) => { if (options?.method === 'POST') writes++; return gate.promise; };
  const opening = ui.open(); editor.doc = sourceDocument('workflow-second'); ui.syncHeader(); gate.resolve({ workflow: recordFor(document) }); await opening;
  assert.equal(ui.session.preview, undefined); assert.match(ui.session.message, /已变化/); await ui.submit(); assert.equal(writes, 0);
});

test('a source revision change after preview prevents creation even when the logical graph stayed equal', async t => {
  const { ui, document } = harness(t); await ui.open(); let writes = 0;
  ui.api = async (_path, options) => { if (options?.method === 'POST') { writes++; return {}; } return { workflow: recordFor(document, 8) }; };
  assert.equal(await ui.submit(), false); assert.equal(writes, 0); assert.match(ui.session.message, /版本已更新/); assert.equal(ui.session.stale, true);
});

test('new local drafts appearing during the revision read stop the pending POST', async t => {
  const { ui, editor, document } = harness(t); await ui.open(); const gate = deferred(); let writes = 0;
  ui.api = async (_path, options) => { if (options?.method === 'POST') writes++; return gate.promise; };
  const saving = ui.submit(); editor.propertyDrafts.set('keys', { title: '后来修改' }); gate.resolve({ workflow: recordFor(document) }); await saving;
  assert.equal(writes, 0); assert.match(ui.session.message, /已变化/);
});

test('duplicate submit and Escape while the POST is pending cannot create duplicate copies', async t => {
  const { ui, document, created } = harness(t); await ui.open(); const gate = deferred(); let writes = 0;
  ui.api = async (_path, options) => { if (!options) return { workflow: recordFor(document) }; writes++; return gate.promise; };
  const first = ui.submit(); await new Promise(done => setImmediate(done)); assert.equal(ui.session.busy, true);
  assert.equal(await ui.submit(), false); assert.equal(ui.close(), false); let prevented = false; ui.dialog.listeners.get('cancel')({ preventDefault() { prevented = true; } }); assert.equal(prevented, true); assert.equal(ui.dialog.open, true);
  gate.resolve({ workflow: recordFor(ui.session.candidate, 1) }); await first; assert.equal(writes, 1); assert.equal(created.length, 1);
});

test('a late successful POST stays in the board without navigating a different current workflow', async t => {
  const { ui, editor, document, created, messages } = harness(t); await ui.open(); const gate = deferred();
  ui.api = async (_path, options) => options ? gate.promise : { workflow: recordFor(document) };
  const saving = ui.submit(); await new Promise(done => setImmediate(done)); editor.doc = sourceDocument('workflow-second'); ui.syncHeader();
  gate.resolve({ workflow: recordFor(ui.session.candidate, 1) }); await saving;
  assert.equal(created.length, 0); assert.equal(editor.doc.id, 'workflow-second'); assert.ok(ui.session.created); assert.match(messages.at(-1)[0], /当前画布保留/);
});

test('switching away and back during a save retains the scope-generation guard', async t => {
  const { ui, editor, document, created } = harness(t); await ui.open(); const gate = deferred();
  ui.api = async (_path, options) => options ? gate.promise : { workflow: recordFor(document) };
  const saving = ui.submit(); await new Promise(done => setImmediate(done)); editor.doc = sourceDocument('workflow-second'); ui.syncHeader(); editor.doc = document; ui.syncHeader();
  gate.resolve({ workflow: recordFor(ui.session.candidate, 1) }); await saving; assert.equal(created.length, 0); assert.ok(ui.session.created);
});

test('returning to the board during a save does not reopen the workflow on a late acknowledgement', async t => {
  const { ui, editor, document, created } = harness(t); editor.active = true; await ui.open(); const gate = deferred();
  ui.api = async (_path, options) => options ? gate.promise : { workflow: recordFor(document) };
  const saving = ui.submit(); await new Promise(done => setImmediate(done)); editor.active = false;
  gate.resolve({ workflow: recordFor(ui.session.candidate, 1) }); await saving; assert.equal(created.length, 0); assert.ok(ui.session.created);
});

test('lost acknowledgement is recovered by an explicit GET of the same candidate, including after closing and reopening', async t => {
  const { ui, document, created, editor } = harness(t); await ui.open(); const requests = []; let saved;
  ui.api = async (path, options) => { requests.push([path, clone(options)]); if (options) { saved = clone(options.body.document); throw new Error('连接中断'); } return { workflow: recordFor(path.endsWith(document.id) ? document : saved, path.endsWith(document.id) ? 7 : 1) }; };
  assert.equal(await ui.submit(), false); assert.equal(created.length, 0); const id = ui.session.candidate.id; assert.equal(ui.submitButton.textContent, '确认保存结果'); assert.equal(ui.titleInput.disabled, true);
  ui.close(); await ui.open(); assert.equal(ui.session.candidate.id, id); await ui.submit();
  assert.equal(posts(requests).length, 1); assert.equal(requests.at(-1)[0], `/api/workflow-library/${id}`); assert.equal(created.length, 1); assert.equal(editor.doc.id, document.id);
});

test('an absent candidate enables a separate retry which reuses the exact frozen POST body', async t => {
  const { ui, document, created } = harness(t); await ui.open(); const requests = []; let attempts = 0;
  ui.api = async (path, options) => {
    requests.push([path, clone(options)]);
    if (options) { attempts++; if (attempts === 1) throw new Error('网络中断'); return { workflow: recordFor(options.body.document, 1) }; }
    if (path.endsWith(document.id)) return { workflow: recordFor(document) };
    throw Object.assign(new Error('not found'), { httpStatus: 404 });
  };
  await ui.submit(); const candidate = clone(ui.session.candidate); await ui.submit(); assert.equal(ui.session.retryAllowed, true); assert.equal(attempts, 1); assert.equal(ui.submitButton.textContent, '重试创建同一新版');
  await ui.submit(); assert.equal(attempts, 2); assert.equal(created.length, 1); assert.deepEqual(posts(requests)[0][1], posts(requests)[1][1]); assert.deepEqual(ui.session.candidate, candidate);
});

test('mismatching save responses never open unrelated workflow records', async t => {
  const { ui, document, created } = harness(t); await ui.open();
  ui.api = async (_path, options) => ({ workflow: recordFor(options ? sourceDocument('workflow-unrelated') : document, options ? 1 : 7) });
  await ui.submit(); assert.equal(created.length, 0); assert.equal(ui.submitButton.textContent, '确认保存结果'); assert.match(ui.session.message, /不匹配/);
});

test('a callback navigation failure retries opening the created record without issuing another save', async t => {
  const { ui, requests } = harness(t); await ui.open(); let calls = 0;
  ui.onCreated = async () => { calls++; if (calls === 1) throw new Error('导航失败'); };
  await ui.submit(); assert.equal(ui.submitButton.textContent, '打开已创建新版'); assert.match(ui.session.message, /不会重复创建/);
  await ui.submit(); assert.equal(calls, 2); assert.equal(posts(requests).length, 1); assert.equal(ui.session.finished, true); assert.equal(ui.dialog.open, false);
});
