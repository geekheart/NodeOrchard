import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WorkflowLibraryClient } from '../public/workflow-library-client.js';
import { createDocument, validateDocument } from '../shared/workflow/workflow-model.mjs';

const copy = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const failed = (message, httpStatus) => Object.assign(new Error(message), { httpStatus });
const draftKey = id => 'workbench.workflow-document.v1:' + id;
const document = (id, title = id) => ({ ...createDocument({ title }), id });
const record = (document, revision = 1, lifecycle = 'active') => ({ id: document.id, document: copy(document), revision, lifecycle, origin: 'saved' });

function storage(t, entries = []) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), values = new Map(entries);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
  } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'localStorage', previous) : delete globalThis.localStorage);
  return values;
}

class Editor {
  constructor(value) { this.doc = copy(value); this.uses = []; this.toasts = []; this.propertyDrafts = new Map(); this.history = []; this.active = false; }
  renderHeader() {}
  cancelGesture() {}
  cancelConnection() {}
  setLibraryLifecycle(value) { this.libraryLifecycle = value; this.libraryReadOnly = value !== 'active'; }
  captureDocumentState() { return { propertyDrafts: [...this.propertyDrafts], history: copy(this.history) }; }
  persist() { localStorage.setItem(draftKey(this.doc.id), JSON.stringify({ version: 1, document: this.doc })); this.onPersist?.(copy(this.doc)); return true; }
  useDocument(value, state, { persist = true } = {}) {
    this.doc = validateDocument(copy(value)); this.propertyDrafts = new Map(state?.propertyDrafts || []); this.history = copy(state?.history || []);
    this.uses.push(this.doc.id); if (persist) this.persist();
  }
  toast(message) { this.toasts.push(message); }
}

test('a target lifecycle event during GET retries in the same navigation generation and opens its latest definition', async t => {
  storage(t); const target = document('target'), oldCanvas = document('previous'), editor = new Editor(oldCanvas), gate = deferred();
  t.after(() => gate.resolve()); let gets = 0;
  const client = new WorkflowLibraryClient(editor, { api: async (_path, options = {}) => {
    assert.notEqual(options.method, 'POST');
    return ++gets === 1 ? gate.promise : { workflow: record({ ...target, title: 'Latest target' }, 2) };
  } });
  const opening = client.open(target.id); await tick();
  await client.handleLifecycle({ id: target.id, lifecycle: 'active', revision: 2 });
  gate.resolve({ workflow: record(target) });
  assert.equal(await opening, true); assert.equal(gets, 2); assert.equal(client.generation, 1);
  assert.equal(editor.doc.title, 'Latest target'); assert.equal(editor.libraryReadOnly, false); assert.equal(client.openRequest, null);
});

test('three consecutive lifecycle races end with an actionable error and preserve the previous canvas and its drafts', async t => {
  const values = storage(t), target = document('changing'), previous = document('previous'), editor = new Editor(previous);
  editor.propertyDrafts.set('node', { title: 'Unapplied property' }); editor.history.push({ label: 'Keep undo' });
  const raw = JSON.stringify({ version: 1, document: previous }); values.set(draftKey(previous.id), raw);
  let gets = 0, client;
  client = new WorkflowLibraryClient(editor, { api: async (_path, options = {}) => {
    assert.notEqual(options.method, 'POST'); const revision = ++gets;
    await client.handleLifecycle({ id: target.id, lifecycle: 'active', revision: revision + 1 });
    return { workflow: record(target, revision) };
  } });
  await assert.rejects(client.open(target.id), /持续变化.*重试.*本地草稿已保留/);
  assert.equal(gets, 3); assert.deepEqual(editor.doc, previous); assert.equal(editor.uses.length, 0);
  assert.equal(editor.propertyDrafts.get('node').title, 'Unapplied property'); assert.equal(editor.history[0].label, 'Keep undo');
  assert.equal(values.get(draftKey(previous.id)), raw); assert.equal(client.openRequest, null);
});

test('an obsolete target response cannot retry over a newer navigation or replace its property drafts', async t => {
  storage(t); const a = document('navigation-A'), b = document('navigation-B'), editor = new Editor(document('previous')), gate = deferred();
  t.after(() => gate.resolve()); const reads = [];
  const client = new WorkflowLibraryClient(editor, { api: async path => {
    const id = decodeURIComponent(path.split('/').at(-1)); reads.push(id);
    return id === a.id ? gate.promise : { workflow: record(b) };
  } });
  const old = client.open(a.id); await tick();
  await client.handleLifecycle({ id: a.id, lifecycle: 'active', revision: 2 });
  assert.equal(await client.open(b.id), true); editor.propertyDrafts.set('B-node', { title: 'Keep typing' });
  gate.resolve({ workflow: record(a) }); assert.equal(await old, false);
  assert.deepEqual(reads, [a.id, b.id]); assert.equal(editor.doc.id, b.id); assert.equal(client.currentId, b.id);
  assert.equal(editor.propertyDrafts.get('B-node').title, 'Keep typing'); assert.equal(client.openRequest, null);
});

test('a stale 410 cannot overwrite a newer restore event or resurrect its old cached draft', async t => {
  const target = document('restored'), cached = { ...target, title: 'Unconfirmed old draft' }, raw = JSON.stringify({ version: 1, document: cached });
  const values = storage(t, [[draftKey(target.id), raw]]), editor = new Editor(document('previous')), gate = deferred();
  t.after(() => gate.resolve()); let gets = 0;
  const latest = { ...target, title: 'Restored authority' };
  const client = new WorkflowLibraryClient(editor, { api: async (_path, options = {}) => {
    assert.notEqual(options.method, 'POST'); return ++gets === 1 ? gate.promise : { workflow: record(latest, 5) };
  } });
  const opening = client.open(target.id); await tick();
  await client.handleLifecycle({ id: target.id, lifecycle: 'active', revision: 5 });
  gate.reject(failed('Gone at the time of the old read', 410));
  assert.equal(await opening, true); assert.equal(gets, 2); assert.equal(editor.doc.title, latest.title);
  assert.equal(client.slot(target.id).lifecycle, 'active'); assert.equal(client.slot(target.id).revision, 5);
  assert.equal(editor.libraryReadOnly, false); assert.equal(values.get(draftKey(target.id)), raw);
});

test('a stale 404 retries before parsing a corrupt cache when a fresh lifecycle revision is available', async t => {
  const target = document('restored-with-corrupt-cache'), raw = '{keep this unreadable original';
  const values = storage(t, [[draftKey(target.id), raw]]), editor = new Editor(document('previous')), gate = deferred();
  t.after(() => gate.resolve()); let gets = 0;
  const client = new WorkflowLibraryClient(editor, { api: async () => ++gets === 1 ? gate.promise : { workflow: record(target, 5) } });
  const opening = client.open(target.id); await tick();
  await client.handleLifecycle({ id: target.id, lifecycle: 'active', revision: 5 }); gate.reject(failed('Old missing result', 404));
  assert.equal(await opening, true); assert.equal(gets, 2); assert.equal(editor.doc.id, target.id); assert.equal(values.get(draftKey(target.id)), raw);
});

test('a lifecycle event during draft reconciliation refetches authority without creating repeated recovery copies', async t => {
  const target = document('reconcile-race', 'Server version'), cached = { ...target, title: 'Unacknowledged local draft' };
  storage(t, [[draftKey(target.id), JSON.stringify({ version: 1, document: cached })]]);
  const editor = new Editor(document('previous')), save = deferred(), entered = deferred(), posts = []; let gets = 0;
  t.after(() => save.resolve());
  const client = new WorkflowLibraryClient(editor, { api: async (_path, options = {}) => {
    if (options.method === 'POST') { posts.push(copy(options.body.document)); entered.resolve(); await save.promise; return { workflow: record(options.body.document) }; }
    return { workflow: record({ ...target, ...(gets++ ? { title: 'Latest restored version' } : {}) }, gets === 1 ? 1 : 2) };
  } });
  const opening = client.open(target.id); await entered.promise;
  await client.handleLifecycle({ id: target.id, lifecycle: 'active', revision: 2 }); save.resolve();
  assert.equal(await opening, true); assert.equal(gets, 2); assert.equal(editor.doc.title, 'Latest restored version');
  assert.equal(posts.length, 1); assert.notEqual(posts[0].id, target.id); assert.equal(posts[0].title, cached.title + '（本地恢复）');
  assert.equal(client.slot(target.id).revision, 2); assert.equal(editor.libraryReadOnly, false);
});

// Execute the application's actual controller and loading renderer with isolated
// dependencies. Importing app.js would otherwise bootstrap the browser application.
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
function declaration(name, next) {
  const start = appSource.indexOf(name), end = appSource.indexOf(next, start);
  assert(start >= 0 && end > start, 'application function boundaries must remain explicit');
  return appSource.slice(start, end);
}
const controllerSource = declaration('async function loadRouteData() {', '\nasync function synchronize()');
const loadingSource = declaration('function workflowLoading(', '\nfunction renderPage()');
const documentChangeSource = declaration('    onDocumentChange(', '\n    },');
const renderPageSource = declaration('function renderPage() {', '\nfunction factList(');

test('rendering an editor route without an id reveals its empty canvas when the selection is unavailable', () => {
  for (const selection of [{ currentId: null }, { currentId: 'previous', documentLoaded: false }, { currentId: 'previous', libraryReadOnly: true }]) {
  const calls = [], dependencies = {
    document: { querySelectorAll: () => [] }, state: { route: { page: 'workflows', id: '' } }, ensureWorkflowEditor() {},
    workflowLibraryClient: { currentId: selection.currentId, unload: () => calls.push('unload') },
    workflowEditor: { ...selection, activate: () => calls.push('activate'), deactivate: () => calls.push('deactivate'), runtime: { activate: () => calls.push('runtime'), deactivate: () => calls.push('runtime-deactivate') } },
    workflowLoading: message => calls.push(message || 'clear-loading'), workflowBoard: null, conversationHub: null,
  };
  new Function(...Object.keys(dependencies), renderPageSource + '\nrenderPage();')(...Object.values(dependencies));
  assert.deepEqual(calls, ['unload', 'clear-loading', 'activate']);
  }
});

test('rendering an editor route without an id retains an active selection while its explicit route is revalidated', () => {
  const calls = [], dependencies = {
    document: { querySelectorAll: () => [] }, state: { route: { page: 'workflows', id: '' } }, ensureWorkflowEditor() {},
    workflowLibraryClient: { currentId: 'previous', unload: () => calls.push('unload') },
    workflowEditor: { documentLoaded: true, libraryReadOnly: false, activate: () => calls.push('activate'), deactivate: () => calls.push('deactivate'), runtime: { activate: () => calls.push('runtime'), deactivate: () => calls.push('runtime-deactivate') } },
    workflowLoading: message => calls.push(message || 'clear-loading'), workflowBoard: null, conversationHub: null,
  };
  new Function(...Object.keys(dependencies), renderPageSource + '\nrenderPage();')(...Object.values(dependencies));
  assert.deepEqual(calls, ['deactivate', 'runtime-deactivate', '正在打开工作流…']);
});

function lifecycleView(page = 'workflows', id = 'archived') {
  const state = { route: { page, id: page === 'workflows' ? id : undefined } }, calls = { runtime: 0, conversation: 0, activate: 0, clearLoading: 0, render: 0 };
  const location = { hash: page === 'workflows' ? `#/workflows/${id}` : '#/settings' };
  const dependencies = {
    state, workflowEditor: { active: page === 'workflows', doc: { id: 'unloaded-placeholder' },
      runtime: { unloadDocument: () => calls.runtime++ }, conversation: { unloadDocument: () => calls.conversation++ }, activate: () => calls.activate++ },
    history: { replaceState(_state, _title, hash) { location.hash = hash; } },
    readRoute: () => ({ page: 'workflows', id: '' }), workflowLoading: () => calls.clearLoading++, renderShell: () => calls.render++,
  };
  const callbacks = new Function(...Object.keys(dependencies), `let routeLoad = 7; return { changed: ({${documentChangeSource}}}).onDocumentChange, loadGeneration: () => routeLoad };`)(...Object.values(dependencies));
  return { ...callbacks, state, location, calls };
}

test('current workflow unloading immediately detaches runtime and conversation and clears the editor route', () => {
  const ui = lifecycleView(); ui.changed(null);
  assert.equal(ui.location.hash, '#/workflows'); assert.equal(ui.state.route.id, '');
  assert.deepEqual(ui.calls, { runtime: 1, conversation: 1, activate: 1, clearLoading: 1, render: 1 });
});

test('workflow unloading while another page is open detaches UI bindings without navigating', () => {
  const ui = lifecycleView('settings'); ui.changed(null);
  assert.equal(ui.location.hash, '#/settings'); assert.equal(ui.state.route.page, 'settings');
  assert.deepEqual(ui.calls, { runtime: 1, conversation: 1, activate: 0, clearLoading: 0, render: 0 });
});

test('unloading a previous workflow during navigation detaches bindings and preserves the new route and load generation', () => {
  const ui = lifecycleView('workflows', 'new-target'); ui.changed(null, { preserveNavigation: true });
  assert.equal(ui.location.hash, '#/workflows/new-target'); assert.equal(ui.state.route.id, 'new-target'); assert.equal(ui.loadGeneration(), 7);
  assert.deepEqual(ui.calls, { runtime: 1, conversation: 1, activate: 0, clearLoading: 0, render: 0 });
});
function controller(client, route = { page: 'workflows', id: 'target' }, editorState = {}) {
  const nodes = new Map(), state = { route };
  const root = { inert: true, classes: new Set(), classList: { toggle(name, value) { if (value) root.classes.add(name); else root.classes.delete(name); } } };
  const status = { hidden: false, children: [], replaceChildren() { this.children = []; }, append(...children) { this.children.push(...children); } };
  nodes.set('workflow-root', root); nodes.set('workflow-load-status', status);
  const calls = { activate: 0, runtime: 0, render: 0 }, editor = { ...editorState, activate: () => calls.activate++, runtime: { activate: async () => calls.runtime++ } };
  const location = { hash: route.id ? `#/workflows/${route.id}` : '#/workflows' };
  const dependencies = {
    state, workflowLibraryClient: client, workflowEditor: editor, ensureWorkflowEditor() {},
    renderShell: () => calls.render++, $: id => nodes.get(id),
    element: (tag, className, textContent) => ({ tag, className, textContent }),
    button: (textContent, onclick) => ({ tag: 'button', textContent, onclick }),
    link: (href, textContent, className) => ({ tag: 'a', href, textContent, className }),
    history: { replaceState(_state, _title, hash) { location.hash = hash; } },
    readRoute: () => ({ page: 'workflows', id: decodeURIComponent(location.hash.split('/')[2] || '') }),
    navigate: hash => { location.hash = hash; },
  };
  const load = new Function(...Object.keys(dependencies), 'let routeLoad = 0;\n' + loadingSource + '\n' + controllerSource + '\nreturn loadRouteData;')(...Object.values(dependencies));
  return { load, state, root, status, calls, location };
}

test('the editor route without an id stays empty when its selection was cleared or is unavailable', async () => {
  for (const selection of [{ currentId: null }, { currentId: 'previous', documentLoaded: false }, { currentId: 'previous', libraryReadOnly: true }]) {
  let unloads = 0, opens = 0;
  const client = { currentId: selection.currentId, initialize: async () => {}, unload() { unloads++; this.currentId = null; }, open: async () => { opens++; return true; } };
  const ui = controller(client, { page: 'workflows', id: '' }, selection); await ui.load();
  assert.equal(unloads, 1); assert.equal(opens, 0); assert.equal(client.currentId, null);
  assert.equal(ui.location.hash, '#/workflows'); assert.equal(ui.status.hidden, true); assert.equal(ui.root.inert, false);
  assert.equal(ui.calls.activate, 1); assert.equal(ui.calls.runtime, 0);
  }
});

test('the editor route without an id resumes its loaded active selection through an explicit revalidated route', async () => {
  let unloads = 0; const opened = [];
  const client = { currentId: 'previous', initialize: async () => {}, unload() { unloads++; this.currentId = null; }, open: async id => { opened.push(id); return true; } };
  const ui = controller(client, { page: 'workflows', id: '' }, { documentLoaded: true, libraryReadOnly: false }); await ui.load();
  assert.equal(ui.location.hash, '#/workflows/previous'); assert.equal(unloads, 0); assert.deepEqual(opened, []);
  ui.state.route = { page: 'workflows', id: 'previous' }; await ui.load();
  assert.deepEqual(opened, ['previous']); assert.equal(ui.calls.activate, 1); assert.equal(ui.calls.runtime, 1);
});

test('an inactive direct link clears its route and shows the empty editor without a retry error', async () => {
  const client = { currentId: null, initialize: async () => {}, open: async () => false };
  const ui = controller(client); await ui.load();
  assert.equal(ui.location.hash, '#/workflows'); assert.equal(ui.state.route.id, '');
  assert.equal(ui.status.hidden, true); assert.equal(ui.status.children.length, 0); assert.equal(ui.root.inert, false);
  assert.equal(ui.calls.activate, 1); assert.equal(ui.calls.runtime, 0);
});

test('the actual route controller turns a current false open into a retryable error and the retry clears its loading overlay', async () => {
  let opened = false;
  const client = { currentId: 'target', initialize: async () => {}, open: async () => opened };
  const ui = controller(client); await ui.load();
  assert.equal(ui.status.hidden, false); assert.match(ui.status.children[0].textContent, /状态变化中断.*重试.*草稿已保留/);
  assert(!ui.status.children[0].textContent.includes('正在打开')); assert.equal(ui.calls.activate, 0);
  const retry = ui.status.children.find(item => item.tag === 'button'); assert.equal(retry.textContent, '重试');
  assert.equal(ui.status.children.find(item => item.tag === 'a').href, '#/board');
  opened = true; retry.onclick(); await tick();
  assert.equal(ui.status.hidden, true); assert.equal(ui.status.children.length, 0); assert.equal(ui.root.inert, false);
  assert.equal(ui.root.classes.has('workflow-loading'), false); assert.deepEqual(ui.calls, { activate: 1, runtime: 1, render: 1 });
});

test('the actual route controller ignores an obsolete false open after a newer workflow succeeds', async () => {
  const gate = deferred(); const client = { currentId: 'newer', initialize: async () => {}, open: async id => id === 'target' ? gate.promise : true };
  const ui = controller(client), first = ui.load(); await tick();
  ui.state.route = { page: 'workflows', id: 'newer' }; await ui.load();
  gate.resolve(false); await first;
  assert.equal(ui.status.hidden, true); assert.equal(ui.status.children.length, 0); assert.equal(ui.root.inert, false);
  assert.deepEqual(ui.calls, { activate: 1, runtime: 1, render: 1 });
});
