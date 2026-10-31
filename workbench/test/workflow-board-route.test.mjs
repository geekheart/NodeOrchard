import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise the real route controller without bootstrapping app.js or a browser.
// Pending editor drafts are represented by isolated stubs, never localStorage.
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function loadRouteData() {');
const end = source.indexOf('\nasync function synchronize()', start);
assert(start >= 0 && end > start, 'application route controller boundaries must remain explicit');
const controllerSource = source.slice(start, end);

function controller(route, { currentId = 'previous-workflow', documentLoaded = true } = {}) {
  const calls = [], writes = [], editorReads = [], libraryReads = [];
  const state = { route }, client = {
    currentId,
    async initialize() { calls.push('library:initialize'); writes.push('recover-pending-local-draft'); },
    async flushPending() { calls.push('library:flush'); writes.push('save-pending-local-draft'); },
    async open(id) { calls.push(`library:open:${id}`); this.currentId = id; return true; },
    unload() { calls.push('library:unload'); this.currentId = null; },
  };
  const editor = {
    documentLoaded, libraryReadOnly: false, activate() { calls.push('editor:activate'); },
    runtime: { async activate() { calls.push('runtime:activate'); } },
  };
  const dependencies = {
    state,
    ensureWorkflowBoard() { calls.push('board:ensure'); },
    workflowBoard: { async load() { calls.push('board:load'); } },
    ensureWorkflowEditor() { calls.push('editor:ensure'); },
    workflowEditor: new Proxy(editor, { get(target, property) { editorReads.push(property); return target[property]; } }),
    workflowLibraryClient: new Proxy(client, { get(target, property) { libraryReads.push(property); return target[property]; } }),
    workflowLoading(message) { calls.push(message || 'editor:clear-loading'); },
    renderShell() { calls.push('shell:render'); },
    notify(message) { calls.push(`notify:${message}`); },
    navigate(hash) { calls.push(`navigate:${hash}`); },
    history: { replaceState(_state, _title, hash) { calls.push(`history:${hash}`); } },
    readRoute() { return state.route; }, pendingAttachmentInput: null,
  };
  const load = new Function(...Object.keys(dependencies), `let routeLoad = 0;\n${controllerSource}\nreturn loadRouteData;`)(...Object.values(dependencies));
  return { load, calls, writes, editorReads, libraryReads, state };
}

test('opening the board only reads its library and never initializes or flushes a selected editor draft', async () => {
  const ui = controller({ page: 'board' }); await ui.load();
  assert.deepEqual(ui.calls, ['board:ensure', 'board:load']);
  assert.deepEqual(ui.writes, []); assert.deepEqual(ui.editorReads, []); assert.deepEqual(ui.libraryReads, []);
});

test('refreshing the board with no loaded editor still loads the board without recovering local drafts', async () => {
  const ui = controller({ page: 'board' }, { currentId: null, documentLoaded: false });
  await ui.load(); await ui.load();
  assert.deepEqual(ui.calls, ['board:ensure', 'board:load', 'board:ensure', 'board:load']);
  assert.deepEqual(ui.writes, []); assert.deepEqual(ui.editorReads, []); assert.deepEqual(ui.libraryReads, []);
});

test('explicitly opening an editor workflow retains initialization, selection validation and runtime activation', async () => {
  const ui = controller({ page: 'workflows', id: 'requested-workflow' }); await ui.load();
  assert.deepEqual(ui.calls, ['editor:ensure', 'library:initialize', 'library:open:requested-workflow',
    'editor:clear-loading', 'editor:activate', 'runtime:activate', 'shell:render']);
  assert.deepEqual(ui.writes, ['recover-pending-local-draft']);
  assert(!ui.calls.some(value => value.startsWith('board:')));
});
