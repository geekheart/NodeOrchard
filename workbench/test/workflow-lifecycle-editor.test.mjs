import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowLibraryClient } from '../public/workflow-library-client.js';
import { WorkflowEditor } from '../public/workflow-editor.js';
import { createDocument, createNode, validateDocument } from '../shared/workflow/workflow-model.mjs';

const PREFIX = 'workbench.workflow-document.v1:', ACK = 'workbench.workflow-library-ack.v1';
const copy = value => structuredClone(value), immediate = () => new Promise(resolve => setImmediate(resolve));
const fail = status => Object.assign(new Error(status === 410 ? '已永久删除' : '已移入回收站或文档已变化'), { httpStatus: status });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function globalValue(t, name, value) {
  const before = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => before ? Object.defineProperty(globalThis, name, before) : delete globalThis[name]);
}
function storage(t, entries = []) {
  const values = new Map(entries), writes = [];
  globalValue(t, 'localStorage', { getItem: key => values.get(key) ?? null, setItem: (key, value) => { writes.push(key); values.set(key, String(value)); }, removeItem: key => { writes.push(key); values.delete(key); } });
  return { values, writes };
}
function doc(id = 'flow-A', title = '流程 A') {
  const document = { ...createDocument({ title, schemaVersion: 2 }), id };
  document.nodes = [createNode('input', { x: 20, y: 30 }, { id: 'input' })];
  return document;
}
function record(document, lifecycle = 'active', revision = 1) { return { id: document.id, document: copy(document), lifecycle, revision, origin: 'saved' }; }
function editor(document = doc(), { cached = false } = {}) {
  const instance = Object.create(WorkflowEditor.prototype), notices = { hidden: true }, box = { hidden: true };
  Object.assign(instance, { doc: copy(document), libraryLifecycle: 'active', selection: new Set(), selectedEdge: null, history: [], future: [], propertyDrafts: new Map(),
    nodeElements: new Map(), edgeElements: new Map(), offsets: new Map(), settings: { snap: true }, active: true, gesture: null, pendingConnection: null,
    storageKey: PREFIX + document.id, storageValue: cached ? localStorage.getItem(PREFIX + document.id) : null, storageConflict: false, corruptDraft: null,
    root: { querySelector: key => key === '.wf-lifecycle-notice' ? notices : box, querySelectorAll: () => [], contains: () => true },
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }), classList: { remove() {}, add() {}, toggle() {} }, hasPointerCapture: () => false },
    contextMenu: { hidden: true }, dialog: { open: false }, world: { style: {} },
    renderGraph() {}, renderProperties() {}, renderHeader() {}, renderRecovery() {}, requestGeometry() {}, applyViewport() {}, cancelConnection() { this.pendingConnection = null; },
    toast(message) { this.lastToast = message; }, notices,
  });
  return instance;
}
function assertUnloaded(instance, client, previousId) {
  assert.equal(instance.documentLoaded, false); assert.equal(instance.active, false); assert.equal(client.currentId, null);
  assert.notEqual(instance.doc.id, previousId); assert.deepEqual(instance.doc.nodes, []); assert.equal(instance.libraryReadOnly, true);
}
function remote(records = []) {
  const state = { records: new Map(records.map(value => [value.id, copy(value)])), deleted: new Set(), gets: [], posts: [] };
  state.api = async (path, options = {}) => {
    if (options.method !== 'POST') {
      const id = decodeURIComponent(path.split('/').at(-1)); state.gets.push(id);
      const value = copy(state.records.get(id)); await state.beforeGet?.(id);
      if (state.deleted.has(id)) throw fail(410);
      if (!value) throw fail(404);
      return { workflow: value };
    }
    const { document, expectedRevision } = copy(options.body); state.posts.push(copy(options.body));
    if (state.deleted.has(document.id)) throw fail(410);
    const previous = state.records.get(document.id);
    if (previous && (previous.lifecycle !== 'active' || previous.revision !== expectedRevision)) throw fail(409);
    const saved = record(validateDocument(document), 'active', (previous?.revision || 0) + 1); state.records.set(saved.id, saved);
    await state.afterSave?.(saved);
    return { workflow: copy(saved) };
  };
  return state;
}

test('opening an archived or trashed workflow leaves no workflow loaded and preserves its draft', async t => {
  const { values } = storage(t);
  for (const lifecycle of ['archived', 'trashed']) {
    const inactive = doc('blocked-' + lifecycle), active = doc('available-' + lifecycle);
    const raw = JSON.stringify({ version: 1, document: inactive }); values.set(PREFIX + inactive.id, raw);
    const instance = editor(doc('placeholder')), api = remote([record(inactive, lifecycle, 2), record(active)]);
    const client = new WorkflowLibraryClient(instance, { api: api.api });
    assert.equal(await client.open(inactive.id), false);
    assert.equal(client.currentId, null);
    assert.notEqual(instance.doc?.id, inactive.id);
    assert.equal(values.get(PREFIX + inactive.id), raw);
    assert.equal(api.posts.length, 0);
    assert.deepEqual(api.gets, [inactive.id], 'opening an inactive workflow never selects another workflow');
  }
});

test('archiving the loaded workflow unloads it and a later restore event does not reopen it', async t => {
  const { values } = storage(t), original = doc('unload-current'), instance = editor(doc('placeholder'));
  const api = remote([record(original)]), client = new WorkflowLibraryClient(instance, { api: api.api });
  await client.open(original.id); const raw = values.get(PREFIX + original.id);
  await client.handleLifecycle({ id: original.id, lifecycle: 'archived', revision: 2 });
  assert.equal(client.currentId, null);
  assert.notEqual(instance.doc?.id, original.id);
  assert.equal(values.get(PREFIX + original.id), raw);
  api.records.set(original.id, record(original, 'active', 3));
  await client.handleLifecycle({ id: original.id, lifecycle: 'active', revision: 3 });
  assert.equal(client.currentId, null);
  assert.notEqual(instance.doc?.id, original.id);
  assert.equal(api.gets.length, 1, 'restoring in the library does not automatically load the editor');
  assert.equal(api.posts.length, 0);
});

test('rendering the empty route can repeat unload without recursive notifications or placeholder saves', async t => {
  storage(t); const original = doc('repeat-unload'), instance = editor(doc('placeholder'));
  const api = remote([record(original)]), changes = [];
  const client = new WorkflowLibraryClient(instance, { api: api.api, onDocumentChange: id => {
    changes.push(id); if (id === null) client.unload();
  } });
  await client.open(original.id); changes.length = 0;
  client.unload(); const placeholder = instance.doc.id;
  client.unload(); await client.flush();
  assert.deepEqual(changes, [null]); assert.equal(client.currentId, null);
  assert.equal(instance.documentLoaded, false); assert.equal(instance.doc.id, placeholder);
  assert.equal(api.posts.length, 0);
});

test('archived or trashed initial caches remain untouched and never flush, recover-copy, or block another workflow', async t => {
  const { values } = storage(t);
  for (const lifecycle of ['archived', 'trashed']) {
    const local = doc('cached-' + lifecycle, '真正未同步的本地修改'), server = doc(local.id, '服务端正式定义');
    const raw = JSON.stringify({ version: 1, document: local }); values.set(PREFIX + local.id, raw);
    const instance = editor(local, { cached: true }), api = remote([record(server, lifecycle, 8)]);
    const client = new WorkflowLibraryClient(instance, { api: api.api }); client.slot(local.id).queued = local;
    await client.initialize();
    assertUnloaded(instance, client, local.id);
    assert.equal(client.slot(local.id).lifecycle, 'trashed'); assert.equal(client.slot(local.id).queued, null); assert.equal(client.slot(local.id).revision, 8); assert.equal(api.posts.length, 0);
    assert.equal(values.get(PREFIX + local.id), raw); assert.equal(instance.lastToast, undefined);
    client.queue(local); await client.flush(local.id); client.leave(); assert.equal(api.posts.length, 0); assert.equal(values.get(PREFIX + local.id), raw);
    const next = await client.create(); assert.notEqual(next, local.id); assert.equal(api.posts.length, 1);
  }
});

test('410 during initial migration unloads the deleted workflow and preserves its draft while normal board creation still works', async t => {
  const local = doc('purged-in-cache'), raw = JSON.stringify({ version: 1, document: local });
  const { values } = storage(t, [[PREFIX + local.id, raw]]), instance = editor(local, { cached: true }), api = remote(); api.deleted.add(local.id);
  const client = new WorkflowLibraryClient(instance, { api: api.api }); await client.initialize();
  assertUnloaded(instance, client, local.id); assert.equal(client.slot(local.id).lifecycle, 'deleted'); assert.equal(api.posts.length, 0);
  assert.equal(values.get(PREFIX + local.id), raw);
  const id = await client.create(); assert.equal(await client.open(id), true); assert.equal(instance.libraryLifecycle, 'active');
  assert.equal(api.posts.length, 1); assert.notEqual(api.posts[0].document.id, local.id);
});

test('opening the same id rechecks authority before any save and unloads newly archived or trashed definitions', async t => {
  const { values } = storage(t), original = doc(), instance = editor(doc('placeholder')), api = remote([record(original)]);
  const client = new WorkflowLibraryClient(instance, { api: api.api }); await client.open(original.id);
  const raw = values.get(PREFIX + original.id); instance.doc.title = '尚未保存的内存标题';
  api.records.set(original.id, record(original, 'archived', 2));
  assert.equal(await client.open(original.id), false); assert.equal(api.gets.length, 2); assertUnloaded(instance, client, original.id); assert.equal(api.posts.length, 0);
  assert.equal(values.get(PREFIX + original.id), raw);
  api.records.set(original.id, record(original, 'trashed', 3)); await client.open(original.id);
  assertUnloaded(instance, client, original.id); assert.equal(client.slot(original.id).revision, 3); assert.equal(api.posts.length, 0);
});

test('a lifecycle event fences a late active save response, clears its tail, and never reloads the unloaded canvas', async t => {
  const { values } = storage(t), original = doc(), instance = editor(doc('placeholder')), api = remote([record(original)]), gate = deferred(), saved = [];
  t.after(() => gate.resolve()); const client = new WorkflowLibraryClient(instance, { api: api.api, onSaved: value => saved.push(value) }); await client.open(original.id);
  api.afterSave = () => gate.promise; instance.doc.title = '已发出的修改'; instance.persist(); await immediate();
  instance.doc.title = '尚未发出的尾部修改'; instance.persist(); const raw = values.get(PREFIX + original.id);
  const pending = client.flush(); await client.handleLifecycle({ workflow: { id: original.id, lifecycle: 'archived', revision: 3 } });
  assertUnloaded(instance, client, original.id); assert.equal(client.slot(original.id).queued, null);
  gate.resolve(); await pending;
  assert.equal(api.posts.length, 1); assert.equal(saved.length, 0); assert.equal(client.slot(original.id).revision, 3); assert.equal(client.slot(original.id).lifecycle, 'trashed');
  assertUnloaded(instance, client, original.id); assert.equal(client.slot(original.id).error, ''); assert.equal(values.get(PREFIX + original.id), raw);
});

test('archiving the target of a pending open unloads immediately and its late active GET cannot reload the editor', async t => {
  const a = doc('pending-previous'), b = doc('pending-target'), raw = JSON.stringify({ version: 1, document: { ...b, title: '保留的目标草稿' } });
  const { values } = storage(t, [[PREFIX + b.id, raw]]), instance = editor(doc('placeholder')), api = remote([record(a), record(b)]), gate = deferred();
  t.after(() => gate.resolve()); const client = new WorkflowLibraryClient(instance, { api: api.api }); await client.open(a.id);
  api.beforeGet = id => id === b.id ? gate.promise : undefined;
  const opening = client.open(b.id); await immediate(); assert.equal(client.openRequest.id, b.id); const postsBeforeArchive = api.posts.length;
  await client.handleLifecycle({ id: b.id, lifecycle: 'archived', revision: 2 });
  assertUnloaded(instance, client, b.id); assert.equal(client.openRequest, null); assert.equal(client.slot(b.id).lifecycle, 'trashed');
  gate.resolve(); assert.equal(await opening, false); assertUnloaded(instance, client, b.id);
  assert.deepEqual(api.gets, [a.id, b.id]); assert.equal(api.posts.length, postsBeforeArchive); assert.ok(api.posts.every(item => item.document.id === a.id)); assert.equal(values.get(PREFIX + b.id), raw);
  assert.equal(values.has('workbench.workflow-active.v1'), false);
});

test('archiving the previous A while B is opening updates A without canceling or stealing the newer navigation', async t => {
  const { values } = storage(t), a = doc('archive-previous-A'), b = doc('opening-next-B'), instance = editor(doc('placeholder'));
  const api = remote([record(a), record(b)]), gate = deferred(); t.after(() => gate.resolve());
  const client = new WorkflowLibraryClient(instance, { api: api.api }); await client.open(a.id);
  api.beforeGet = id => id === b.id ? gate.promise : undefined;
  const opening = client.open(b.id); await immediate(); const postsBeforeArchive = api.posts.length, raw = values.get(PREFIX + a.id);
  await client.handleLifecycle({ id: a.id, lifecycle: 'archived', revision: 2 });
  assert.equal(client.openRequest.id, b.id); assert.equal(client.slot(a.id).lifecycle, 'trashed'); assert.equal(client.slot(a.id).queued, null);
  assert.equal(instance.documentLoaded, false, 'A is unloaded while the newer B response is still pending');
  assert.equal(client.currentId, null); assert.notEqual(instance.doc.id, a.id);
  assert.equal(values.has('workbench.workflow-active.v1'), false);
  gate.resolve(); assert.equal(await opening, true);
  assert.equal(instance.documentLoaded, true); assert.equal(instance.doc.id, b.id); assert.equal(client.currentId, b.id); assert.equal(instance.libraryReadOnly, false);
  assert.deepEqual(api.gets, [a.id, b.id]); assert.equal(api.posts.length, postsBeforeArchive); assert.ok(api.posts.every(item => item.document.id === a.id)); assert.equal(values.get(PREFIX + a.id), raw);
  assert.equal(values.get('workbench.workflow-active.v1'), b.id);
});

test('an archived initial cache cannot cancel an explicit active B open waiting for initialization', async t => {
  const local = doc('initial-inactive-A', '不同的本地缓存'), server = doc(local.id, '服务端已归档定义'), b = doc('explicit-active-B');
  const raw = JSON.stringify({ version: 1, document: local }), { values } = storage(t, [[PREFIX + local.id, raw], ['workbench.workflow-active.v1', local.id]]);
  const instance = editor(local, { cached: true }), api = remote([record(server, 'archived', 8), record(b)]), gate = deferred();
  t.after(() => gate.resolve()); api.beforeGet = id => id === local.id ? gate.promise : undefined;
  const client = new WorkflowLibraryClient(instance, { api: api.api }), opening = client.open(b.id); await immediate();
  assert.equal(client.openRequest.id, b.id); assert.deepEqual(api.gets, [local.id]);
  gate.resolve(); assert.equal(await opening, true);
  assert.equal(instance.documentLoaded, true); assert.equal(instance.doc.id, b.id); assert.equal(client.currentId, b.id); assert.equal(instance.libraryReadOnly, false);
  assert.equal(client.slot(local.id).lifecycle, 'trashed'); assert.equal(client.slot(local.id).revision, 8); assert.equal(client.slot(local.id).queued, null);
  assert.deepEqual(api.gets, [local.id, b.id]); assert.equal(api.posts.length, 0); assert.equal(api.records.size, 2); assert.equal(values.get(PREFIX + local.id), raw);
  assert.equal(values.get('workbench.workflow-active.v1'), b.id);
});

test('unloading while an explicit B open waits for active A initialization fences the late initial read without reloading A', async t => {
  const a = doc('initial-active-A'), b = doc('cancelled-explicit-B'), raw = JSON.stringify({ version: 1, document: a });
  const { values } = storage(t, [[PREFIX + a.id, raw], ['workbench.workflow-active.v1', a.id]]), instance = editor(a, { cached: true });
  const api = remote([record(a), record(b)]), gate = deferred(); t.after(() => gate.resolve()); api.beforeGet = id => id === a.id ? gate.promise : undefined;
  const client = new WorkflowLibraryClient(instance, { api: api.api }), opening = client.open(b.id); await immediate();
  assert.deepEqual(api.gets, [a.id]); assert.equal(client.openRequest.id, b.id);
  client.unload(); assertUnloaded(instance, client, a.id); assert.equal(values.has('workbench.workflow-active.v1'), false);
  gate.resolve(); assert.equal(await opening, false);
  assertUnloaded(instance, client, a.id); assert.deepEqual(api.gets, [a.id]); assert.equal(api.posts.length, 0);
  assert.equal(values.get(PREFIX + a.id), raw); assert.equal(values.has('workbench.workflow-active.v1'), false); assert.equal(instance.lastToast, undefined);
});

test('late persistence callbacks and flushes after unloading cannot save a placeholder or revive the old workflow', async t => {
  const { values, writes } = storage(t), original = doc('late-persist-unloaded'), instance = editor(doc('placeholder')), api = remote([record(original)]);
  const client = new WorkflowLibraryClient(instance, { api: api.api }); await client.open(original.id); const raw = values.get(PREFIX + original.id);
  await client.handleLifecycle({ id: original.id, lifecycle: 'archived', revision: 2 }); const placeholder = copy(instance.doc), writeCount = writes.length;
  instance.onPersist({ ...original, title: '迟到的已归档写入' }); instance.onPersist(placeholder); instance.persist();
  await client.flush(original.id); await client.flush();
  assertUnloaded(instance, client, original.id); assert.deepEqual(instance.doc, placeholder); assert.equal(client.slot(original.id).queued, null);
  assert.equal(api.posts.length, 0); assert.equal(api.records.size, 1); assert.equal(values.get(PREFIX + original.id), raw); assert.equal(writes.length, writeCount);
  assert.equal(values.has(PREFIX + placeholder.id), false); assert.equal(values.has('workbench.workflow-active.v1'), false);
});

test('late A restore events update their slot without stealing a newer B navigation from the inactive A canvas', async t => {
  storage(t); const a = doc('navigation-A'), b = doc('navigation-B'), instance = editor(doc('placeholder'));
  const api = remote([record(a), record(b)]), client = new WorkflowLibraryClient(instance, { api: api.api });
  await client.open(a.id);
  const pendingA = deferred(), pendingB = deferred(); t.after(() => { pendingA.resolve(); pendingB.resolve(); });
  api.beforeGet = id => id === a.id ? pendingA.promise : pendingB.promise;
  const openingA = client.open(a.id); await immediate();
  client.leave(); instance.active = false;
  const openingB = client.open(b.id); await immediate();
  const restoreRevision = client.slot(a.id).revision + 1;
  api.records.set(a.id, record({ ...a, title: 'A restored remotely' }, 'active', restoreRevision));
  assert.equal(await client.handleLifecycle({ id: a.id, lifecycle: 'active', revision: restoreRevision }), true);
  assert.equal(client.slot(a.id).revision, restoreRevision); assert.equal(client.slot(a.id).refreshRequired, true);
  assert.equal(api.gets.filter(id => id === a.id).length, 2, 'the lifecycle event cannot start a third A fetch');
  pendingA.resolve(); assert.equal(await openingA, false);
  pendingB.resolve(); assert.equal(await openingB, true);
  assert.equal(instance.doc.id, b.id); assert.equal(client.currentId, b.id);
  assert.equal(instance.libraryReadOnly, false); assert.equal(client.slot(a.id).lifecycle, 'active');
});

test('restore events only update their slot and each restored workflow is loaded by a later explicit open', async t => {
  storage(t); const a = doc('visible-restore-A'), instance = editor(doc('placeholder'));
  const api = remote([record(a, 'trashed', 2)]), client = new WorkflowLibraryClient(instance, { api: api.api });
  await client.open(a.id); client.leave(); instance.active = false;
  api.records.set(a.id, record({ ...a, title: 'Restored while on board' }, 'active', 3));
  await client.handleLifecycle({ id: a.id, lifecycle: 'active', revision: 3 });
  assert.equal(api.gets.length, 1); assert.equal(client.slot(a.id).revision, 3);
  assert.equal(client.slot(a.id).refreshRequired, true); assertUnloaded(instance, client, a.id);
  assert.equal(await client.open(a.id), true);
  assert.equal(instance.doc.title, 'Restored while on board'); assert.equal(instance.libraryReadOnly, false);
  await client.handleLifecycle({ id: a.id, lifecycle: 'archived', revision: 4 });
  assertUnloaded(instance, client, a.id);
  api.records.set(a.id, record({ ...a, title: 'Restored in current canvas' }, 'active', 5));
  await client.handleLifecycle({ id: a.id, lifecycle: 'active', revision: 5 });
  assert.equal(api.gets.length, 2); assertUnloaded(instance, client, a.id);
  assert.equal(await client.open(a.id), true); assert.equal(api.gets.length, 3); assert.equal(instance.doc.title, 'Restored in current canvas');
  assert.equal(instance.libraryReadOnly, false); assert.equal(client.slot(a.id).refreshRequired, false);
});

test('explicitly opening a restored workflow stays unloaded until fresh content arrives, preserves the unsynced cache, then saves with the current revision', async t => {
  const original = doc(), local = doc(original.id, '必须保留的旧本地编辑'), raw = JSON.stringify({ version: 1, document: local });
  const { values } = storage(t, [[PREFIX + local.id, raw], [ACK, JSON.stringify({ [local.id]: 1 })]]);
  const instance = editor(local, { cached: true }), api = remote([record(original, 'trashed', 2)]), gate = deferred();
  t.after(() => gate.resolve()); const client = new WorkflowLibraryClient(instance, { api: api.api }); await client.initialize();
  const latest = doc(local.id, '恢复后的权威定义'); api.records.set(local.id, record(latest, 'active', 5)); api.beforeGet = () => gate.promise;
  await client.handleLifecycle({ id: local.id, lifecycle: 'active', revision: 5 });
  assert.equal(api.gets.length, 1, 'a restore event does not fetch or reload the archived workflow'); assertUnloaded(instance, client, local.id);
  const restoring = client.open(local.id); await immediate();
  assertUnloaded(instance, client, local.id); client.queue(local); assert.equal(client.slot(local.id).queued, null); assert.equal(api.posts.length, 0);
  gate.resolve(); assert.equal(await restoring, true); assert.equal(instance.libraryLifecycle, 'active'); assert.deepEqual(instance.doc, latest);
  assert.equal(client.slot(local.id).revision, 5); assert.equal(values.get(PREFIX + local.id), raw); assert.equal(api.posts.length, 0);
  instance.doc.title = '恢复后新的编辑'; instance.persist(); await client.flush();
  assert.equal(api.posts.length, 1); assert.equal(api.posts[0].expectedRevision, 5); assert.equal(api.posts[0].document.title, '恢复后新的编辑');
});

test('a stale active GET after a restore event cannot load the editor or resurrect a cached draft', async t => {
  const original = doc(), local = doc(original.id, '保留的不同本地稿'), raw = JSON.stringify({ version: 1, document: local });
  const { values } = storage(t, [[PREFIX + original.id, raw]]), instance = editor(doc('placeholder')), api = remote([record(original, 'trashed', 2)]);
  const client = new WorkflowLibraryClient(instance, { api: api.api }); await client.open(original.id);
  api.records.set(original.id, record(original, 'active', 3));
  assert.equal(await client.handleLifecycle({ id: original.id, lifecycle: 'active', revision: 5 }), true);
  assert.equal(api.gets.length, 1); assertUnloaded(instance, client, original.id);
  await assert.rejects(client.open(original.id), /尚未读到工作流最新版本/);
  assertUnloaded(instance, client, original.id); assert.equal(client.slot(original.id).revision, 5); assert.equal(api.posts.length, 0);
  assert.equal(values.get(PREFIX + original.id), raw);
  api.records.set(original.id, record(original, 'active', 5)); await client.open(original.id);
  assert.equal(instance.libraryLifecycle, 'active'); assert.equal(api.posts.length, 0);
});

test('a newer trash event fences an explicitly opened restore read and preserves the inactive local draft', async t => {
  const original = doc(), local = doc(original.id, '待保留的本地编辑'), raw = JSON.stringify({ version: 1, document: local });
  const { values } = storage(t, [[PREFIX + local.id, raw]]), instance = editor(local, { cached: true }), api = remote([record(original, 'trashed', 2)]), gate = deferred();
  t.after(() => gate.resolve()); const client = new WorkflowLibraryClient(instance, { api: api.api }); await client.initialize();
  api.records.set(local.id, record({ ...original, title: '恢复版本' }, 'active', 3));
  let first = true; api.beforeGet = () => { if (first) { first = false; return gate.promise; } };
  await client.handleLifecycle({ id: local.id, lifecycle: 'active', revision: 3 });
  const restoring = client.open(local.id); await immediate();
  assertUnloaded(instance, client, local.id); assert.equal(client.slot(local.id).refreshRequired, true);
  api.records.set(local.id, record(original, 'trashed', 4)); await client.handleLifecycle({ id: local.id, lifecycle: 'trashed', revision: 4 });
  gate.resolve(); assert.equal(await restoring, false);
  assertUnloaded(instance, client, local.id); assert.equal(client.slot(local.id).revision, 4);
  client.queue(local); await client.flush(local.id); assert.equal(api.posts.length, 0); assert.equal(values.get(PREFIX + local.id), raw);
});

test('lifecycle during initial read fences its obsolete result, and duplicate active events preserve later editing', async t => {
  const original = doc(), raw = JSON.stringify({ version: 1, document: original });
  const { values } = storage(t, [[PREFIX + original.id, raw]]);
  const instance = editor(original, { cached: true }), api = remote([record(original)]), gate = deferred(); t.after(() => gate.resolve());
  let first = true; api.beforeGet = () => { if (first) { first = false; return gate.promise; } };
  const client = new WorkflowLibraryClient(instance, { api: api.api }), initializing = client.initialize(); await immediate();
  await client.handleLifecycle({ id: original.id, lifecycle: 'archived', revision: 2 }); gate.resolve(); await initializing;
  assertUnloaded(instance, client, original.id); assert.equal(api.posts.length, 0); assert.equal(client.slot(original.id).revision, 2); assert.equal(values.get(PREFIX + original.id), raw);
  api.records.set(original.id, record(original, 'active', 3)); await client.handleLifecycle({ id: original.id, lifecycle: 'active', revision: 3 });
  assertUnloaded(instance, client, original.id); assert.equal(api.gets.length, 1);
  assert.equal(await client.open(original.id), true); assert.equal(instance.libraryLifecycle, 'active');
  const getCount = api.gets.length; client.slot(original.id).queued = { ...original, title: '事件之后的真实编辑' };
  await client.handleLifecycle({ id: original.id, lifecycle: 'active', revision: 3 });
  assert.equal(client.slot(original.id).queued.title, '事件之后的真实编辑'); assert.equal(api.gets.length, getCount);
});

test('a stale 410 from initial cache migration cannot replace a newer active restore revision with deleted state', async t => {
  const local = doc('initial-restore-stale-410', '必须保留的初始本地稿'), raw = JSON.stringify({ version: 1, document: local });
  const { values } = storage(t, [[PREFIX + local.id, raw]]), instance = editor(local, { cached: true }), api = remote(), gate = deferred(), uses = [];
  instance.active = false; instance.useDocument = (...args) => { uses.push(args[0].id); return WorkflowEditor.prototype.useDocument.apply(instance, args); };
  t.after(() => gate.resolve()); api.deleted.add(local.id); api.beforeGet = () => gate.promise;
  const client = new WorkflowLibraryClient(instance, { api: api.api }), initializing = client.initialize(); await immediate();
  await client.handleLifecycle({ id: local.id, lifecycle: 'active', revision: 5 });
  assert.equal(client.slot(local.id).revision, 5); assert.equal(client.slot(local.id).lifecycle, 'active');
  gate.resolve(); await initializing;
  assert.equal(client.slot(local.id).revision, 5); assert.equal(client.slot(local.id).lifecycle, 'active');
  assert.equal(client.slot(local.id).refreshRequired, true); assert.equal(client.slot(local.id).queued, null);
  assert.deepEqual(uses, []); assert.deepEqual(api.gets, [local.id]); assert.equal(api.posts.length, 0); assert.equal(api.records.size, 0);
  assert.equal(values.get(PREFIX + local.id), raw); assert.equal(instance.lastToast, undefined);
});

test('inactive opening does not parse or replace a corrupt browser draft, and non-current lifecycle events cannot alter the canvas', async t => {
  const original = doc(), other = doc('flow-B'), raw = '{original unreadable data';
  const { values } = storage(t, [[PREFIX + original.id, raw]]), instance = editor(doc('placeholder')), api = remote([record(original, 'trashed', 2), record(other)]);
  const client = new WorkflowLibraryClient(instance, { api: api.api }); await client.open(original.id);
  assertUnloaded(instance, client, original.id); assert.equal(values.get(PREFIX + original.id), raw);
  await client.open(other.id); await client.handleLifecycle({ deleted: true, id: original.id, lifecycle: 'deleted' });
  assert.equal(instance.doc.id, other.id); assert.equal(instance.libraryLifecycle, 'active'); assert.equal(client.slot(original.id).lifecycle, 'deleted'); assert.equal(api.posts.length, 0);
});

test('read-only core rejects graph mutation and run preparation while camera, export and history remain available without persistence', t => {
  const original = doc(), raw = JSON.stringify({ version: 1, document: original }), { values, writes } = storage(t, [[PREFIX + original.id, raw]]);
  const instance = editor(original, { cached: true }); instance.history = [{ document: doc('old-id'), label: '旧历史' }]; instance.selection.add('input');
  let callbacks = 0, exports = 0; instance.onPersist = () => callbacks++; instance.download = () => exports++;
  instance.setLibraryLifecycle('trashed'); const before = copy(instance.doc), history = copy(instance.history);
  instance.commit({ ...instance.doc, title: '禁止更名' }, '更名'); instance.undo(); instance.undo(true); instance.deleteSelection(); instance.addNode('tool');
  instance.clipboard = { nodes: [createNode('tool', { x: 0, y: 0 })], edges: [] }; instance.pasteSelection(); instance.createMinimalFlow(); instance.loadExample();
  instance.activatePort({ node: 'input', port: 'out', direction: 'output' }); instance.openImport('{}'); instance.openNewDialog(); instance.saveDraft();
  assert.throws(() => instance.prepareRun(), /只读/); assert.throws(() => instance.applyLearningDocument(original), /只读/);
  assert.deepEqual(instance.doc, before); assert.deepEqual(instance.history, history); assert.equal(instance.pendingConnection, null);
  instance.zoomAt(1.2, 300, 200); assert.equal(instance.doc.viewport.zoom, 1.2); instance.exportDocument(); assert.equal(exports, 1);
  assert.equal(instance.persist(), true); instance.scheduleSave(); assert.equal(instance.unsaved, false); assert.equal(callbacks, 0);
  assert.equal(writes.length, 0); assert.equal(values.get(PREFIX + original.id), raw);
});

test('read-only controls are individually disabled and the history inspector and export are never inert', t => {
  storage(t); const instance = editor(), editable = [{ disabled: false }, { disabled: false }], exportButton = { disabled: false }, historyButton = { disabled: false };
  instance.root.querySelectorAll = selector => selector.includes('.wf-document-title') ? editable : [];
  instance.setLibraryLifecycle('trashed'); instance.applyLibraryReadOnly();
  assert.ok(editable.every(item => item.disabled)); assert.equal(exportButton.disabled, false); assert.equal(historyButton.disabled, false);
  assert.equal(instance.root.inert, undefined); assert.equal(instance.notices.hidden, false); assert.match(instance.notices.textContent, /回收站.*只读/);
  instance.setLibraryLifecycle('active'); instance.applyLibraryReadOnly(); assert.ok(editable.every(item => !item.disabled)); assert.equal(instance.notices.hidden, true);
});

test('read-only keyboard edits and node dragging cannot change the graph, while background panning and inspector navigation still work', t => {
  const { writes } = storage(t), instance = editor(), before = copy(instance.doc);
  class Target { constructor(kind = 'canvas') { this.kind = kind; this.dataset = { id: 'input' }; }
    closest(selector) {
      if (selector === '.wf-node' && this.kind === 'node') return this;
      if (selector.includes('.wf-runtime') && this.kind === 'inspector') return this;
      return null;
    }
  }
  globalValue(t, 'Element', Target); instance.setLibraryLifecycle('trashed'); instance.selection.add('input');
  let prevented = 0;
  for (const event of [{ key: 'Delete' }, { key: 'ArrowRight' }, { key: 's', ctrlKey: true }, { key: 'z', metaKey: true }, { key: 'v', metaKey: true }]) {
    instance.onKeyDown({ ...event, target: new Target(), preventDefault() { prevented++; } });
  }
  assert.equal(prevented, 5); assert.deepEqual(instance.doc, before);
  instance.onKeyDown({ key: 'ArrowRight', target: new Target('inspector'), preventDefault() { throw new Error('history navigation must stay native'); } });
  Object.assign(instance.canvas, { contains: () => true, focus() {}, setPointerCapture() {} });
  instance.selectNode = id => instance.selection.add(id);
  instance.onPointerDown({ target: new Target('node'), button: 0, pointerId: 1, clientX: 30, clientY: 40, preventDefault() {} });
  assert.equal(instance.gesture, null); assert.deepEqual(instance.doc.nodes, before.nodes);
  instance.onPointerDown({ target: new Target(), button: 0, pointerId: 2, clientX: 10, clientY: 10, preventDefault() {} });
  assert.equal(instance.gesture.kind, 'pan');
  instance.onPointerMove({ pointerId: 2, clientX: 110, clientY: 50 }); instance.onPointerUp({ pointerId: 2, clientX: 110, clientY: 50 });
  assert.deepEqual(instance.doc.nodes, before.nodes); assert.notDeepEqual(instance.doc.viewport, before.viewport); assert.equal(writes.length, 0);
});
