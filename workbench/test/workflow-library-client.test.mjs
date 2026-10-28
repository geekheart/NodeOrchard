import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowLibraryClient } from '../public/workflow-library-client.js';
import { WorkflowEditor } from '../public/workflow-editor.js';
import { createDocument, createNode, validateDocument } from '../shared/workflow/workflow-model.mjs';

const ACK_KEY = 'workbench.workflow-library-ack.v1';
const LEGACY_KEY = 'workbench.workflow-editor.v1';
const DRAFT_PREFIX = 'workbench.workflow-document.v1:';
const copy = value => structuredClone(value);
const immediate = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const failure = (message, httpStatus) => Object.assign(new Error(message), { httpStatus });
function document(id = 'local-flow', title = '本地草稿') { return { ...createDocument({ title }), id }; }
function record(document, revision = 1, origin = 'saved') {
  return { id: document.id, document: copy(document), revision, origin, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: `2026-01-01T00:00:${String(revision).padStart(2, '0')}.000Z` };
}
function fittedPersistence(editor) {
  Object.assign(editor, { settings: { libraryClosed: true, propertiesClosed: true }, canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }) },
    measurePorts() {}, nodeSize: () => ({ width: 224, height: 125 }), panelSettings() { return this.settings; },
    fitGeometry: WorkflowEditor.prototype.fitGeometry, persistenceDocument: WorkflowEditor.prototype.persistenceDocument });
}

function storage(t, entries = []) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), values = new Map(entries);
  const value = { getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, item) => values.set(key, String(item)), removeItem: key => values.delete(key), clear: () => values.clear() };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value });
  t.after(() => previous ? Object.defineProperty(globalThis, 'localStorage', previous) : delete globalThis.localStorage);
  return values;
}

class FakeEditor {
  constructor(document, { legacy = false, corruptDraft = null } = {}) {
    this.doc = copy(document); this.storageKey = LEGACY_KEY; this.corruptDraft = corruptDraft;
    this.storageValue = legacy ? JSON.stringify({ version: 1, document }) : null;
    if (legacy) localStorage.setItem(LEGACY_KEY, this.storageValue);
    this.history = []; this.future = []; this.propertyDrafts = new Map(); this.selection = new Set(); this.selectedEdge = null;
    this.headers = []; this.uses = []; this.toasts = []; this.cancelledGestures = 0; this.cancelledConnections = 0;
  }
  renderHeader() { this.headers.push({ id: this.doc.id, status: this.libraryStatus, error: this.libraryError }); }
  cancelGesture() { this.cancelledGestures++; }
  cancelConnection() { this.cancelledConnections++; }
  captureDocumentState() { return copy({ history: this.history, future: this.future, propertyDrafts: [...this.propertyDrafts], selection: [...this.selection], selectedEdge: this.selectedEdge,
    unsaved: this.unsaved === true, titleDraft: this.titleDraft || null }); }
  persist() {
    this.storageValue = JSON.stringify({ version: 1, document: this.doc }); localStorage.setItem(this.storageKey, this.storageValue); this.unsaved = false;
    this.onPersist?.(copy(this.doc)); return true;
  }
  cacheDraft() {
    const previous = JSON.parse(localStorage.getItem(this.storageKey) || 'null');
    this.storageValue = JSON.stringify({ version: 1, document: this.doc, dirty: Boolean(this.unsaved || this.titleDraft), titleDraft: this.titleDraft || null,
      ...(previous?.publicationPending ? { publicationPending: true, publicationFingerprint: previous.publicationFingerprint } : {}) });
    localStorage.setItem(this.storageKey, this.storageValue); return true;
  }
  useDocument(value, state, { persist = true } = {}) {
    this.doc = validateDocument(copy(value)); this.storageKey = DRAFT_PREFIX + value.id;
    this.history = copy(state?.history || []); this.future = copy(state?.future || []);
    this.propertyDrafts = new Map(copy(state?.propertyDrafts || [])); this.selection = new Set(state?.selection || []); this.selectedEdge = state?.selectedEdge || null;
    this.unsaved = state?.unsaved === true; this.titleDraft = state?.titleDraft || null;
    this.uses.push({ id: value.id, state: copy(state) }); if (persist) this.cacheDraft(); this.renderHeader();
  }
  toast(message) { this.toasts.push(message); }
}

function reloadedEditor(id) {
  const key = DRAFT_PREFIX + id, raw = localStorage.getItem(key);
  const editor = new FakeEditor(validateDocument(JSON.parse(raw).document));
  editor.storageKey = key; editor.storageValue = raw;
  return editor;
}

function backend(initial = []) {
  const f = { records: new Map(initial.map(item => [item.id, copy(item)])), calls: [], activeSaves: 0, maxActiveSaves: 0 };
  f.api = async (path, options = {}) => {
    const call = { path, options: copy(options) }; f.calls.push(call);
    if (options.method !== 'POST') {
      assert.match(path, /^\/api\/workflow-library\/[^/]+$/);
      const id = decodeURIComponent(path.slice('/api/workflow-library/'.length)), result = copy(f.records.get(id));
      await f.beforeGet?.(id);
      if (!result) throw failure('工作流文档不存在。', 404);
      return { workflow: result };
    }
    assert.equal(path, '/api/workflow-library', 'client may save drafts but must never call execution, schedule or model endpoints');
    f.activeSaves++; f.maxActiveSaves = Math.max(f.maxActiveSaves, f.activeSaves);
    try {
      const body = options.body; await f.beforeSave?.(copy(body));
      const clean = validateDocument(body.document), previous = f.records.get(clean.id);
      let saved;
      if (previous?.origin === 'saved' && JSON.stringify(previous.document) === JSON.stringify(clean)) saved = previous;
      else {
        if (previous ? body.expectedRevision !== previous.revision : body.expectedRevision !== undefined && body.expectedRevision !== 0) throw failure('工作流文档已变化。', 409);
        saved = record(clean, (previous?.revision || 0) + 1); if (previous) saved.createdAt = previous.createdAt;
        f.records.set(clean.id, copy(saved));
      }
      await f.afterSave?.(copy(saved), copy(body)); return { workflow: copy(saved) };
    } finally { f.activeSaves--; }
  };
  f.posts = () => f.calls.filter(call => call.options.method === 'POST');
  return f;
}

test('queued edits save serially with the acknowledged revision and coalesce to the latest immutable draft', async t => {
  storage(t); const editor = new FakeEditor(document()), remote = backend(), gate = deferred(), saved = [], changed = [];
  const client = new WorkflowLibraryClient(editor, { api: remote.api, onSaved: value => saved.push(value), onDocumentChange: id => changed.push(id) });
  remote.afterSave = async (_record, body) => { if (body.expectedRevision === 0) await gate.promise; };
  t.after(() => gate.resolve());
  editor.doc.title = 'first'; editor.persist(); await immediate();
  assert.equal(remote.posts().length, 1); assert.equal(remote.posts()[0].options.body.expectedRevision, 0);
  editor.doc.title = 'second'; editor.persist(); editor.doc.title = 'latest'; editor.persist(); editor.doc.title = 'not persisted yet';
  await immediate(); assert.equal(remote.posts().length, 1);
  gate.resolve(); await client.flush(editor.doc.id);
  assert.deepEqual(remote.posts().map(call => [call.options.body.document.title, call.options.body.expectedRevision]), [['first', 0], ['latest', 1]]);
  assert.equal(remote.maxActiveSaves, 1); assert.equal(remote.records.get(editor.doc.id).document.title, 'latest');
  assert.equal(client.slot(editor.doc.id).revision, 2); assert.equal(client.slot(editor.doc.id).queued, null);
  assert.deepEqual(saved.map(value => value.revision), [1, 2]); assert(changed.every(id => id === editor.doc.id));
});

test('a draft arriving between the final acknowledgement and pending cleanup continues saving without another click', async t => {
  storage(t); const editor = new FakeEditor(document()), remote = backend();
  const client = new WorkflowLibraryClient(editor, { api: remote.api, onSaved: saved => {
    if (saved.revision === 1) queueMicrotask(() => { editor.doc.title = 'tail edit'; editor.persist(); });
  } });
  editor.persist(); await client.flush(); await immediate();
  assert.deepEqual(remote.posts().map(call => [call.options.body.document.title, call.options.body.expectedRevision]), [['本地草稿', 0], ['tail edit', 1]]);
  assert.equal(remote.maxActiveSaves, 1); assert.equal(client.slot(editor.doc.id).queued, null); assert.equal(client.slot(editor.doc.id).pending, null); assert.equal(editor.libraryStatus, '已保存 · 工作流看板');
});

test('failure of the tail continuation preserves its draft and does not automatically retry', async t => {
  storage(t); const editor = new FakeEditor(document()), remote = backend();
  const client = new WorkflowLibraryClient(editor, { api: remote.api, onSaved: saved => {
    if (saved.revision === 1) queueMicrotask(() => { editor.doc.title = 'tail edit'; editor.persist(); });
  } });
  remote.beforeSave = body => { if (body.expectedRevision === 1) throw failure('tail offline', 503); };
  editor.persist(); await assert.rejects(client.flush(), /tail offline/); await immediate(); await immediate();
  assert.equal(remote.posts().length, 2); assert.equal(client.slot(editor.doc.id).pending, null); assert.equal(client.slot(editor.doc.id).queued.title, 'tail edit'); assert.match(editor.libraryStatus, /本地保留/);
  editor.persist(); await immediate(); assert.equal(remote.posts().length, 2, 'a failed continuation waits for an explicit retry');
});

test('startup acknowledgement clears an identical draft queued before writes were ready', async t => {
  storage(t); const flow = document(), editor = new FakeEditor(flow, { legacy: true }), remote = backend([record(flow, 51)]), client = new WorkflowLibraryClient(editor, { api: remote.api });
  remote.beforeSave = () => { throw failure('工作台尚未就绪，请刷新后重试。', 403); };
  editor.persist(); await assert.rejects(client.flush(), /尚未就绪/); assert.equal(client.slot(flow.id).revision, 0); assert.ok(client.slot(flow.id).queued); assert.match(editor.libraryStatus, /本地保留/);
  await client.initialize();
  assert.equal(client.slot(flow.id).revision, 51); assert.equal(client.slot(flow.id).queued, null); assert.equal(client.slot(flow.id).pending, null); assert.equal(client.slot(flow.id).error, ''); assert.equal(editor.libraryStatus, '已保存 · 工作流看板'); assert.equal(remote.posts().length, 1, 'the exact acknowledgement needs no replacement write');
});

test('a startup acknowledgement never clears a different failed local draft or silently writes over the server', async t => {
  storage(t); const flow = document(), editor = new FakeEditor(flow), remote = backend([record(flow, 51)]), client = new WorkflowLibraryClient(editor, { api: remote.api });
  remote.beforeSave = () => { throw failure('工作台尚未就绪，请刷新后重试。', 403); };
  editor.doc.title = '尚未确认的不同本地稿'; editor.persist(); await assert.rejects(client.flush(), /尚未就绪/); const queued = structuredClone(client.slot(flow.id).queued);
  client.adopt(record(flow, 51)); client.status(); await immediate();
  assert.deepEqual(client.slot(flow.id).queued, queued); assert.equal(client.slot(flow.id).revision, 51); assert.equal(client.slot(flow.id).pending, null); assert.equal(editor.doc.title, queued.title); assert.equal(remote.records.get(flow.id).document.title, flow.title); assert.equal(remote.posts().length, 1, 'adopting another document is not permission to overwrite it');
});

test('failed saves keep the latest local queue and pause automatic requests until an explicit flush', async t => {
  const values = storage(t), editor = new FakeEditor(document()), remote = backend();
  const client = new WorkflowLibraryClient(editor, { api: remote.api }); let fail = true;
  remote.beforeSave = () => { if (fail) throw failure('保存冲突，请保留本地副本。', 409); };
  editor.doc.title = 'unsaved first'; editor.persist();
  await assert.rejects(client.flush(), /保存冲突/); await immediate();
  assert.equal(remote.posts().length, 1); assert.equal(client.slot(editor.doc.id).queued.title, 'unsaved first');
  assert.match(editor.libraryError, /保存冲突/); assert.match(editor.libraryStatus, /本地保留/);
  editor.doc.title = 'latest after failure'; editor.persist(); await immediate(); await immediate();
  assert.equal(remote.posts().length, 1, 'automatic persistence updates the queue without retrying a failed server request');
  assert.equal(client.slot(editor.doc.id).queued.title, 'latest after failure');
  assert.equal(JSON.parse(values.get(editor.storageKey)).document.title, 'latest after failure');
  fail = false; await client.flush();
  assert.equal(remote.posts().length, 2); assert.equal(remote.records.get(editor.doc.id).document.title, 'latest after failure'); assert.equal(editor.libraryError, '');
});

test('an edit queued while an earlier request fails remains recoverable instead of reverting to that older request', async t => {
  storage(t); const editor = new FakeEditor(document()), remote = backend(), gate = deferred();
  const client = new WorkflowLibraryClient(editor, { api: remote.api });
  remote.beforeSave = () => gate.promise; t.after(() => gate.resolve());
  editor.doc.title = 'in flight'; editor.persist(); await immediate();
  editor.doc.title = 'newer local'; editor.persist(); const pending = client.flush();
  gate.reject(failure('offline', 503)); await assert.rejects(pending, /offline/);
  assert.equal(client.slot(editor.doc.id).queued.title, 'newer local'); assert.equal(editor.doc.title, 'newer local'); assert.equal(remote.posts().length, 1);
});

test('a conflicted A draft does not block saving B and reopens with its queued canvas and unapplied properties intact', async t => {
  const values = storage(t), a = document('conflict-A'), b = document('independent-B');
  a.nodes = [createNode('tool', { x: 10, y: 20 }, { id: 'A-node' })];
  const editor = new FakeEditor(document('placeholder')), remote = backend([record(a), record(b)]);
  const client = new WorkflowLibraryClient(editor, { api: remote.api }); await client.open(a.id);
  const serverA = record({ ...a, title: 'A changed by another window' }, 2); remote.records.set(a.id, copy(serverA));
  editor.doc.title = 'A queued local canvas'; editor.propertyDrafts.set('A-node', { title: 'A unapplied local property' });
  editor.history.push({ label: 'A local undo', document: copy(a) }); editor.selection.add('A-node');
  const localA = copy(editor.doc), stateA = editor.captureDocumentState(); editor.persist();
  await assert.rejects(client.flush(), /已变化/);
  assert.deepEqual(client.slot(a.id).queued, localA); assert.match(client.slot(a.id).error, /已变化/);
  assert.equal(await client.open(b.id), true); assert.equal(editor.doc.id, b.id); assert.equal(editor.propertyDrafts.size, 0);
  editor.doc.title = 'B saves independently'; editor.persist(); await client.flush();
  assert.equal(remote.records.get(b.id).document.title, 'B saves independently'); assert.equal(remote.records.get(b.id).revision, 2);
  const attemptedA = remote.posts().filter(call => call.options.body.document.id === a.id).length;
  assert.equal(await client.open(a.id), true);
  assert.deepEqual(editor.doc, localA); assert.deepEqual(editor.captureDocumentState(), { ...stateA, unsaved: true });
  assert.deepEqual(client.slot(a.id).queued, localA); assert.match(client.slot(a.id).error, /已变化/); assert.match(editor.libraryStatus, /本地保留/);
  assert.equal(client.slot(a.id).revision, 1); assert.equal(JSON.parse(values.get(ACK_KEY))[a.id], 1);
  assert.deepEqual(remote.records.get(a.id), serverA);
  assert.equal(remote.posts().filter(call => call.options.body.document.id === a.id).length, attemptedA, 'returning to a conflicted draft must not retry or overwrite it');
});

test('a cache refusal retains committed A edits across switching B and defers a conflicting recovery until explicit save', async t => {
  const values = storage(t), a = document('persist-refused-A'), b = document('persist-refused-B');
  a.nodes = [createNode('tool', { x: 10, y: 20 }, { id: 'refused-A-node' })];
  const editor = new FakeEditor(document('placeholder')), remote = backend([record(a), record(b)]);
  const client = new WorkflowLibraryClient(editor, { api: remote.api }); await client.open(a.id);
  const cachedA = values.get(DRAFT_PREFIX + a.id), serverA = record({ ...a, title: 'A newer remote version' }, 2);
  remote.records.set(a.id, copy(serverA));
  editor.doc.title = 'A committed in memory only'; editor.doc.nodes[0].title = 'A committed node edit';
  editor.propertyDrafts.set('refused-A-node', { title: 'A unapplied property' }); editor.history.push({ label: 'A undo', document: copy(a) });
  editor.unsaved = true;
  const localA = copy(editor.doc), stateA = editor.captureDocumentState(), notifications = [];
  const notify = editor.onPersist; editor.onPersist = value => { notifications.push(value.id); notify(value); };
  editor.cacheDraft = function () {
    if (this.doc.id === a.id) return false;
    return FakeEditor.prototype.cacheDraft.call(this);
  };
  assert.equal(client.slot(a.id).queued, null, 'the committed in-memory edit has never reached the normal persistence callback');
  assert.equal(await client.open(b.id), true); assert.equal(editor.doc.id, b.id);
  assert.deepEqual(client.slot(a.id).draft, localA); assert.equal(client.slot(a.id).queued, null); assert.match(client.slot(a.id).error, /本地缓存/);
  assert.equal(values.get(DRAFT_PREFIX + a.id), cachedA, 'refused persistence does not pretend the browser cache contains the new edit');
  assert.deepEqual(remote.records.get(a.id), serverA);
  assert.equal(remote.posts().length, 0);
  assert.equal(await client.open(a.id), true);
  assert.notEqual(editor.doc.id, a.id); assert.deepEqual(editor.doc.nodes, localA.nodes); assert.deepEqual(editor.captureDocumentState(), stateA);
  assert.deepEqual(client.slot(editor.doc.id).draft, editor.doc); assert.match(editor.libraryStatus, /尚未保存/);
  assert.deepEqual(remote.records.get(a.id), serverA); assert.equal(remote.posts().length, 0);
  assert.equal(notifications.filter(id => id === a.id).length, 0, 'recovering the in-memory draft must work even though editor.persist never invokes onPersist for A');
});

test('initial history-derived assets are explicitly claimed with the current CAS revision and migrated to scoped local storage', async t => {
  const values = storage(t), local = document('legacy-history', 'local edited version'), editor = new FakeEditor(local, { legacy: true });
  const originalLocal = values.get(LEGACY_KEY), remote = backend([record(document(local.id, 'older runtime snapshot'), 4, 'history')]);
  const client = new WorkflowLibraryClient(editor, { api: remote.api }); await client.initialize();
  assert.equal(remote.posts().length, 1); assert.equal(remote.posts()[0].options.body.expectedRevision, 4);
  assert.deepEqual(remote.records.get(local.id).document, local); assert.equal(remote.records.get(local.id).revision, 5); assert.equal(remote.records.get(local.id).origin, 'saved');
  assert.equal(client.currentId, local.id); assert.equal(editor.storageKey, DRAFT_PREFIX + local.id);
  assert.equal(values.get(LEGACY_KEY), originalLocal); assert.deepEqual(JSON.parse(values.get(editor.storageKey)).document, local);
  assert.equal(remote.posts().length, 1, 'scoped useDocument persistence cannot enqueue a second migration');
});

test('different saved assets retain their server version and recover an unacknowledged local draft under a new identity', async t => {
  const values = storage(t, [[ACK_KEY, JSON.stringify({ 'legacy-saved': 2 })]]), local = document('legacy-saved', 'local pending text');
  local.nodes = [createNode('tool', { x: 20, y: 40 }, { id: 'keep-code', config: { code: 'return "local body";' } })];
  const editor = new FakeEditor(local, { legacy: true }), originalLocal = values.get(LEGACY_KEY), original = record(document(local.id, 'server newer'), 3);
  const remote = backend([original]), client = new WorkflowLibraryClient(editor, { api: remote.api }); await client.initialize();
  assert.deepEqual(remote.records.get(local.id), original); assert.equal(remote.posts().length, 1);
  const recovered = remote.posts()[0].options.body.document;
  assert.notEqual(recovered.id, local.id); assert.match(recovered.title, /本地恢复/); assert.deepEqual(recovered.nodes, local.nodes);
  assert.equal(remote.posts()[0].options.body.expectedRevision, 0); assert.equal(client.currentId, recovered.id); assert.equal(editor.doc.id, recovered.id);
  assert.equal(values.get(LEGACY_KEY), originalLocal); assert.equal(editor.storageKey, DRAFT_PREFIX + recovered.id); assert.match(editor.toasts.join('\n'), /恢复副本/);
});

test('the acknowledgement captured before adoption permits a known local edit but a newly read revision cannot grant that permission', async t => {
  storage(t, [[ACK_KEY, JSON.stringify({ 'known-edit': 7 })]]);
  const local = document('known-edit', 'known offline edit'), editor = new FakeEditor(local, { legacy: true });
  const remote = backend([record(document(local.id, 'last acknowledged server version'), 7)]);
  const client = new WorkflowLibraryClient(editor, { api: remote.api }); await client.initialize();
  assert.equal(remote.posts().length, 1); assert.equal(remote.posts()[0].options.body.document.id, local.id); assert.equal(remote.posts()[0].options.body.expectedRevision, 7);
  assert.equal(remote.records.get(local.id).revision, 8); assert.equal(remote.records.size, 1); assert.equal(editor.doc.title, local.title);
  assert.equal(editor.storageKey, DRAFT_PREFIX + local.id);
});

test('after reloading B, a divergent scoped A draft is recovered separately and never overwrites the newer server A', async t => {
  const localA = document('reload-conflict-A', 'A local unsynced edits'), b = document('reload-conflict-B', 'B restored after reload');
  localA.nodes = [createNode('tool', { x: 30, y: 50 }, { id: 'A-local-code', config: { code: 'return { preserve: true };' } })];
  const serverA = record(document(localA.id, 'A server version two'), 2), serverB = record(b);
  const values = storage(t, [
    [ACK_KEY, JSON.stringify({ [localA.id]: 1, [b.id]: 1 })],
    [DRAFT_PREFIX + localA.id, JSON.stringify({ version: 1, document: localA })],
    [DRAFT_PREFIX + b.id, JSON.stringify({ version: 1, document: b })],
  ]);
  const editor = reloadedEditor(b.id), remote = backend([serverA, serverB]), client = new WorkflowLibraryClient(editor, { api: remote.api });
  await client.initialize(); assert.equal(editor.doc.id, b.id); assert.equal(remote.posts().length, 0);
  assert.equal(await client.open(localA.id), true);
  const recoveredId = client.currentId;
  assert.notEqual(recoveredId, localA.id); assert.equal(editor.doc.id, recoveredId); assert.match(editor.doc.title, /本地恢复/);
  assert.deepEqual(editor.doc.nodes, localA.nodes); assert.deepEqual(remote.records.get(localA.id), serverA);
  assert.equal(remote.posts().length, 1); assert.equal(remote.posts()[0].options.body.document.id, recoveredId);
  assert.equal(remote.posts()[0].options.body.expectedRevision, 0); assert.equal(remote.records.size, 3);
  assert.deepEqual(JSON.parse(values.get(DRAFT_PREFIX + localA.id)).document, serverA.document, 'the original cache is normalized only after the recovery copy is durably saved');
  assert.deepEqual(JSON.parse(values.get(DRAFT_PREFIX + recoveredId)).document, editor.doc);
  await client.open(b.id); await client.open(localA.id);
  assert.equal(client.currentId, localA.id); assert.deepEqual(editor.doc, serverA.document);
  assert.equal(remote.posts().length, 1, 'opening the original A again cannot create duplicate recovery copies');
  assert.deepEqual(remote.records.get(recoveredId).document.nodes, localA.nodes); assert.deepEqual(remote.records.get(localA.id), serverA);
});

test('after reloading B, an offline A edit with its original matching acknowledgement saves back to A', async t => {
  const localA = document('reload-known-A', 'A offline edit'), b = document('reload-known-B');
  localA.nodes = [createNode('tool', { x: 15, y: 20 }, { id: 'known-local-node' })];
  const values = storage(t, [
    [ACK_KEY, JSON.stringify({ [localA.id]: 7, [b.id]: 1 })],
    [DRAFT_PREFIX + localA.id, JSON.stringify({ version: 1, document: localA })],
    [DRAFT_PREFIX + b.id, JSON.stringify({ version: 1, document: b })],
  ]);
  const editor = reloadedEditor(b.id), remote = backend([record(document(localA.id, 'A acknowledged server version'), 7), record(b)]);
  const client = new WorkflowLibraryClient(editor, { api: remote.api }); await client.initialize(); await client.open(localA.id);
  assert.equal(client.currentId, localA.id); assert.deepEqual(editor.doc, localA); assert.equal(remote.records.size, 2);
  assert.deepEqual(remote.posts().map(call => [call.options.body.document.id, call.options.body.expectedRevision]), [[localA.id, 7]]);
  assert.deepEqual(remote.records.get(localA.id).document, localA); assert.equal(remote.records.get(localA.id).revision, 8);
  assert.deepEqual(JSON.parse(values.get(DRAFT_PREFIX + localA.id)).document, localA); assert.equal(JSON.parse(values.get(ACK_KEY))[localA.id], 8);
});

test('after reloading B, a stale A acknowledgement with only local viewport changes does not fork the document', async t => {
  const a = document('reload-viewport-A', 'same A content'), b = document('reload-viewport-B'), localA = { ...a, viewport: { x: 210, y: -95, zoom: 1.6 } };
  storage(t, [
    [ACK_KEY, JSON.stringify({ [a.id]: 1, [b.id]: 1 })],
    [DRAFT_PREFIX + a.id, JSON.stringify({ version: 1, document: localA })],
    [DRAFT_PREFIX + b.id, JSON.stringify({ version: 1, document: b })],
  ]);
  const editor = reloadedEditor(b.id), remote = backend([record(a, 2), record(b)]), client = new WorkflowLibraryClient(editor, { api: remote.api });
  await client.initialize(); await client.open(a.id);
  assert.equal(client.currentId, a.id); assert.deepEqual(editor.doc, localA); assert.equal(remote.records.size, 2);
  assert.equal(remote.posts().length, 0, 'a viewport-only legacy draft does not write or claim a new server revision');
  assert.deepEqual(remote.records.get(a.id).document, a); assert.equal(editor.toasts.length, 0);
});

test('view-only queue, leave and same-workflow reopen neither persist nor POST and reopening requests a visible fit', async t => {
  storage(t); const doc = document('view-only'); doc.nodes = [createNode('tool', { x: 30, y: 45 }, { id: 'view-node' })];
  const editor = new FakeEditor(document('placeholder')), remote = backend([record(doc)]); fittedPersistence(editor);
  const client = new WorkflowLibraryClient(editor, { api: remote.api }); await client.open(doc.id);
  let persists = 0, fits = 0; editor.unsaved = false; editor.persist = () => { persists++; return true; }; editor.requestDocumentFit = () => { fits++; };
  editor.doc.viewport = { x: 950, y: -240, zoom: .3 }; const live = copy(editor.doc.viewport);
  client.queue(editor.doc); await client.flush(); client.leave(); assert.equal(persists, 0); assert.equal(remote.posts().length, 0);
  await client.open(doc.id); assert.equal(fits, 1); assert.equal(remote.records.get(doc.id).revision, 1); assert.deepEqual(editor.doc.viewport, live);
  assert.deepEqual(remote.records.get(doc.id).document.nodes, doc.nodes);
});

test('real node movement queues a fitted copy while retaining the live camera and exact node positions', async t => {
  storage(t); const doc = document('position-save'); doc.nodes = [createNode('tool', { x: 30, y: 45 }, { id: 'position-node' })];
  const editor = new FakeEditor(document('placeholder')), remote = backend([record(doc)]); fittedPersistence(editor);
  const client = new WorkflowLibraryClient(editor, { api: remote.api }); await client.open(doc.id);
  editor.doc.viewport = { x: -1200, y: 720, zoom: .2 }; editor.doc.nodes[0].x = 330;
  const live = copy(editor.doc), projected = editor.persistenceDocument(); client.queue(editor.doc); await client.flush();
  assert.equal(remote.posts().length, 1); assert.deepEqual(remote.posts()[0].options.body.document, projected); assert.equal(remote.posts()[0].options.body.document.nodes[0].x, 330);
  assert.deepEqual(editor.doc, live); assert.notDeepEqual(projected.viewport, live.viewport);
});

test('navigation caches dirty and title drafts without submitting a save, including cache failures', async t => {
  storage(t); const doc = document('refused-view'); doc.nodes = [createNode('tool', { x: 80, y: 60 }, { id: 'fallback-node' })];
  const editor = new FakeEditor(document('placeholder')), remote = backend([record(doc)]); fittedPersistence(editor);
  const client = new WorkflowLibraryClient(editor, { api: remote.api }); await client.open(doc.id);
  let persists = 0; editor.unsaved = false; editor.titleDraft = { documentId: doc.id, value: '待提交标题' }; editor.persist = () => { persists++; return true; };
  client.rememberCurrent(); assert.equal(persists, 0, 'a title draft is cached without an implicit save');
  assert.equal(JSON.parse(localStorage.getItem(DRAFT_PREFIX + doc.id)).titleDraft.value, '待提交标题');
  editor.titleDraft = null; editor.unsaved = true; editor.doc.nodes[0].x = 480; editor.doc.viewport = { x: 900, y: 700, zoom: .2 }; editor.cacheDraft = () => false;
  const projected = editor.persistenceDocument(), live = copy(editor.doc); client.rememberCurrent();
  assert.deepEqual(client.slot(doc.id).draft, projected); assert.equal(client.slot(doc.id).queued, null); assert.deepEqual(editor.doc, live); assert.equal(remote.posts().length, 0);
});

test('opening a non-current unreadable scoped draft preserves the original cache and the current canvas', async t => {
  const a = document('reload-corrupt-A'), b = document('reload-corrupt-B'), originalA = record(a, 2);
  const values = storage(t, [
    [ACK_KEY, JSON.stringify({ [a.id]: 1, [b.id]: 1 })],
    [DRAFT_PREFIX + b.id, JSON.stringify({ version: 1, document: b })],
  ]);
  for (const raw of ['{"version":1,"document":', JSON.stringify({ version: 1, document: { ...a, mode: 'invalid-mode' } })]) {
    values.set(DRAFT_PREFIX + a.id, raw);
    const editor = reloadedEditor(b.id), remote = backend([originalA, record(b)]), client = new WorkflowLibraryClient(editor, { api: remote.api });
    await client.initialize(); await assert.rejects(client.open(a.id), /本地草稿.*读取/);
    assert.equal(values.get(DRAFT_PREFIX + a.id), raw); assert.deepEqual(editor.doc, b); assert.equal(client.currentId, b.id);
    assert.deepEqual(remote.records.get(a.id), originalA); assert.equal(remote.posts().length, 0);
  }
});

test('late A open responses or a leave action cannot replace the newer B canvas or its unsaved property editor state', async t => {
  storage(t); const initial = document('placeholder'), editor = new FakeEditor(initial), a = document('flow-A'), b = document('flow-B');
  const remote = backend([record(a, 4), record(b, 2)]), gate = deferred(), client = new WorkflowLibraryClient(editor, { api: remote.api });
  remote.beforeGet = id => id === a.id ? gate.promise : undefined; t.after(() => gate.resolve());
  const openingA = client.open(a.id); await immediate();
  assert.equal(await client.open(b.id), true); editor.propertyDrafts.set('local-node', { title: 'keep typing' }); editor.history.push({ label: 'B undo', document: copy(b) });
  gate.resolve(); assert.equal(await openingA, false);
  assert.equal(editor.doc.id, b.id); assert.equal(client.currentId, b.id); assert.equal(editor.propertyDrafts.get('local-node').title, 'keep typing'); assert.equal(editor.history[0].label, 'B undo');
  assert.deepEqual(editor.uses.map(value => value.id), [b.id]); assert.equal(remote.posts().length, 0);
  const later = deferred(); remote.beforeGet = id => id === a.id ? later.promise : undefined; t.after(() => later.resolve());
  const reopeningA = client.open(a.id); await immediate(); client.leave(); later.resolve();
  assert.equal(await reopeningA, false); assert.equal(editor.doc.id, b.id); assert.equal(client.currentId, b.id); assert.equal(editor.propertyDrafts.get('local-node').title, 'keep typing');
});

test('an obsolete A request cannot regress the acknowledgement after A is reopened and saved through a newer request', async t => {
  const values = storage(t), a = document('reopen-A'), b = document('reopen-B'), gate = deferred();
  const editor = new FakeEditor(document('placeholder')), remote = backend([record(a), record(b)]);
  const client = new WorkflowLibraryClient(editor, { api: remote.api }); let readsA = 0;
  remote.beforeGet = id => id === a.id && ++readsA === 1 ? gate.promise : undefined; t.after(() => gate.resolve());
  const oldA = client.open(a.id); await immediate(); await client.open(b.id);
  remote.records.set(a.id, record({ ...a, title: 'server version two' }, 2));
  await client.open(a.id); editor.doc.title = 'saved version three'; editor.persist(); await client.flush();
  assert.equal(client.slot(a.id).revision, 3); gate.resolve(); assert.equal(await oldA, false);
  assert.equal(editor.doc.title, 'saved version three'); assert.equal(client.slot(a.id).revision, 3);
  assert.equal(JSON.parse(values.get(ACK_KEY))[a.id], 3);
  editor.doc.title = 'next version four'; editor.persist(); await client.flush();
  assert.equal(remote.posts().at(-1).options.body.expectedRevision, 3); assert.equal(remote.records.get(a.id).revision, 4);
});

test('switching documents restores each document property drafts, undo redo history and selection independently', async t => {
  storage(t); const a = document('state-A'), b = document('state-B'); a.nodes = [createNode('tool', { x: 0, y: 0 }, { id: 'node-A' })];
  b.nodes = [createNode('tool', { x: 0, y: 0 }, { id: 'node-B' })];
  const editor = new FakeEditor(document('placeholder')), remote = backend([record(a), record(b)]), client = new WorkflowLibraryClient(editor, { api: remote.api });
  await client.open(a.id); editor.doc.title = 'A committed edit'; editor.unsaved = true; editor.propertyDrafts.set('node-A', { title: 'A unapplied property' });
  editor.history.push({ label: 'A undo', document: copy(a) }); editor.future.push({ label: 'A redo', document: copy(a) }); editor.selection.add('node-A'); editor.selectedEdge = 'edge-A';
  const stateA = editor.captureDocumentState(); await client.open(b.id);
  assert.equal(editor.doc.id, b.id); assert.equal(editor.propertyDrafts.size, 0); assert.equal(editor.history.length, 0);
  editor.propertyDrafts.set('node-B', { title: 'B unapplied property' }); editor.history.push({ label: 'B undo', document: copy(b) }); editor.selection.add('node-B');
  const stateB = editor.captureDocumentState(); await client.open(a.id);
  assert.equal(editor.doc.title, 'A committed edit'); assert.deepEqual(editor.captureDocumentState(), stateA);
  assert.equal(remote.records.get(a.id).document.nodes[0].title, a.nodes[0].title, 'unapplied property editors are not silently committed');
  await client.open(b.id); assert.deepEqual(editor.captureDocumentState(), stateB);
  assert(editor.cancelledGestures >= 3); assert(editor.cancelledConnections >= 3);
});

test('creating an empty workflow only saves its draft and does not execute, schedule, learn or replace the current canvas', async t => {
  storage(t); const initial = document('current-placeholder'), editor = new FakeEditor(initial), remote = backend();
  const client = new WorkflowLibraryClient(editor, { api: remote.api }); const id = await client.create();
  assert.notEqual(id, initial.id); assert.equal(editor.doc.id, initial.id); assert.equal(editor.uses.length, 0);
  const created = remote.records.get(id); assert.equal(created.document.mode, 'execute'); assert.deepEqual(created.document.nodes, []); assert.deepEqual(created.document.edges, []);
  assert.equal(created.document.title, '新工作流'); assert.equal(remote.calls.length, 1); assert.equal(remote.posts().length, 1);
  assert.equal(await client.open(id), true); assert.equal(editor.doc.id, id);
  assert(remote.calls.every(call => call.path.startsWith('/api/workflow-library')));
});

test('disabled autosave keeps edits local across navigation and reload until an explicit save', async t => {
  storage(t); const a = document('disabled-A'), b = document('disabled-B');
  a.nodes = [createNode('tool', { x: 10, y: 20 }, { id: 'disabled-node' })];
  const editor = new FakeEditor(document('placeholder')), remote = backend([record(a), record(b)]);
  editor.autosavePolicy = { enabled: false };
  const client = new WorkflowLibraryClient(editor, { api: remote.api }); await client.open(a.id);
  editor.doc.nodes[0].x = 410; editor.unsaved = true; client.leave();
  assert.equal(remote.posts().length, 0); assert.equal(JSON.parse(localStorage.getItem(DRAFT_PREFIX + a.id)).dirty, true);
  await client.open(b.id); await client.open(a.id);
  assert.equal(editor.doc.nodes[0].x, 410); assert.equal(editor.unsaved, true); assert.equal(remote.posts().length, 0);
  const restored = reloadedEditor(a.id); restored.autosavePolicy = { enabled: false };
  const reloaded = new WorkflowLibraryClient(restored, { api: remote.api }); await reloaded.initialize();
  assert.equal(restored.doc.nodes[0].x, 410); assert.equal(restored.unsaved, true); assert.equal(remote.posts().length, 0);
  restored.persist(); await reloaded.flush();
  assert.equal(remote.posts().length, 1); assert.equal(remote.records.get(a.id).revision, 2); assert.equal(remote.records.get(a.id).document.nodes[0].x, 410);
});

test('a concurrent same-workflow reopen defers recovery and preserves an uncached title draft under its new identity', async t => {
  storage(t); const a = document('uncached-A'), editor = new FakeEditor(document('placeholder')), remote = backend([record(a)]);
  const client = new WorkflowLibraryClient(editor, { api: remote.api }); await client.open(a.id);
  editor.doc.title = '尚未到周期的改动'; editor.unsaved = true;
  editor.titleDraft = { documentId: a.id, value: '尚未提交的名称' };
  const newer = record({ ...a, title: '另一窗口的新版本' }, 2); remote.records.set(a.id, newer);
  await client.open(a.id);
  assert.notEqual(editor.doc.id, a.id); assert.equal(remote.posts().length, 0); assert.deepEqual(remote.records.get(a.id), newer);
  const recoveryId = editor.doc.id, cached = JSON.parse(localStorage.getItem(DRAFT_PREFIX + recoveryId));
  assert.equal(cached.dirty, true); assert.deepEqual(cached.titleDraft, { documentId: recoveryId, value: '尚未提交的名称' });
  assert.deepEqual(editor.titleDraft, cached.titleDraft); assert.equal(editor.unsaved, true);
  const restored = reloadedEditor(recoveryId); restored.autosavePolicy = { enabled: false };
  await new WorkflowLibraryClient(restored, { api: remote.api }).initialize();
  assert.deepEqual(restored.titleDraft, cached.titleDraft); assert.equal(remote.posts().length, 0);
});

test('disabled autosave defers an unmarked legacy draft and navigation does not retry a failed explicit save', async t => {
  const a = document('disabled-legacy'), local = { ...a, title: '旧版未同步草稿' };
  storage(t, [[DRAFT_PREFIX + a.id, JSON.stringify({ version: 1, document: local })], [ACK_KEY, JSON.stringify({ [a.id]: 1 })]]);
  const editor = reloadedEditor(a.id), b = document('after-failure'), remote = backend([record(a), record(b)]); editor.autosavePolicy = { enabled: false };
  const client = new WorkflowLibraryClient(editor, { api: remote.api }); await client.initialize();
  assert.equal(remote.posts().length, 0); assert.equal(editor.doc.title, local.title); assert.equal(editor.unsaved, true);
  remote.beforeSave = () => { throw failure('暂时离线', 503); };
  editor.persist(); await assert.rejects(client.flush(), /暂时离线/); const count = remote.posts().length;
  await client.open(b.id); await client.flushPending(a.id);
  assert.equal(remote.posts().length, count); assert.equal(remote.records.get(a.id).revision, 1);
});

test('a failed earlier save never replaces a newer cached draft on reopen, and a confirmed receipt needs no replay', async t => {
  storage(t); const a = document('failed-earlier'), b = document('failed-next'), editor = new FakeEditor(document('placeholder'));
  const remote = backend([record(a), record(b)]), client = new WorkflowLibraryClient(editor, { api: remote.api }); await client.open(a.id);
  remote.beforeSave = () => { throw failure('响应未确认', 503); };
  editor.doc.title = '旧的保存请求'; editor.persist(); await assert.rejects(client.flush(), /未确认/);
  const requested = copy(client.slot(a.id).queued);
  editor.doc.title = '较新的未保存草稿'; editor.unsaved = true;
  await client.open(a.id); assert.equal(editor.doc.title, '较新的未保存草稿'); assert.equal(editor.unsaved, true);
  await client.open(b.id); await client.open(a.id);
  assert.equal(editor.doc.title, '较新的未保存草稿'); assert.equal(editor.unsaved, true);
  assert.equal(client.slot(a.id).queued.title, requested.title); assert.equal(remote.posts().length, 1);
  // A later read can confirm the old request succeeded without issuing it again.
  remote.records.set(a.id, record(requested, 2)); await client.open(a.id);
  assert.equal(editor.doc.title, '较新的未保存草稿'); assert.equal(client.slot(a.id).queued, null);
  assert.equal(client.currentId, a.id);
  assert.equal(client.slot(a.id).revision, 2); assert.equal(remote.posts().length, 1);
});

test('refreshing an unconfirmed save only reads its receipt and never resubmits it with autosave enabled', async t => {
  storage(t); const original = document('unconfirmed-refresh'), editor = new FakeEditor(document('placeholder'));
  editor.autosavePolicy = { enabled: true };
  const remote = backend([record(original)]), client = new WorkflowLibraryClient(editor, { api: remote.api }); await client.open(original.id);
  remote.beforeSave = () => { throw failure('网络中断，结果未确认', 503); };
  editor.doc.title = '待确认的保存'; editor.persist(); await assert.rejects(client.flush(), /未确认/);
  const requested = copy(client.slot(original.id).queued);
  assert.equal(JSON.parse(localStorage.getItem(DRAFT_PREFIX + original.id)).publicationPending, true);
  const restored = reloadedEditor(original.id); restored.autosavePolicy = { enabled: true };
  const reloaded = new WorkflowLibraryClient(restored, { api: remote.api }); await reloaded.initialize();
  assert.equal(remote.posts().length, 1); assert.equal(restored.doc.title, requested.title); assert.match(reloaded.slot(original.id).error, /尚未确认/);
  // A read confirms a lost successful response without creating another write.
  remote.records.set(original.id, record(requested, 2)); await reloaded.open(original.id);
  assert.equal(remote.posts().length, 1); assert.equal(reloaded.slot(original.id).revision, 2);
  assert.notEqual(JSON.parse(localStorage.getItem(DRAFT_PREFIX + original.id)).publicationPending, true);
  assert.equal(restored.unsaved, false);
});

test('a corrupt local draft is retained and never uploaded as a valid migration', async t => {
  const values = storage(t), editor = new FakeEditor(document('fallback'), { legacy: true, corruptDraft: '{unreadable original' });
  const original = values.get(LEGACY_KEY), remote = backend(), client = new WorkflowLibraryClient(editor, { api: remote.api });
  await client.initialize(); assert.equal(remote.calls.length, 0); assert.equal(values.get(LEGACY_KEY), original); assert.equal(editor.corruptDraft, '{unreadable original');
});
