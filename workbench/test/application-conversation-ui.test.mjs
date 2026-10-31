import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationConversationUI } from '../public/application-conversation-ui.js';

const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (id, revision = 1, { title = id, turns = [], ...metadata } = {}) => ({ conversation: { workflowId: id, title, revision, turns, ...metadata }, pending: [] });

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.value = ''; this.textContent = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  querySelector(selector) { return this.children.find(child => child.tagName === selector) || this.children.map(child => child.querySelector?.(selector)).find(Boolean) || null; }
}

// Render-neutral harness retains the real constructor, API mapper, scope
// switching, load/send/accept logic, and proposal callbacks. It avoids timers
// and layout, which belong to the browser acceptance run.
class Harness extends ApplicationConversationUI {
  mount() {
    this.panel = new Element('aside'); this.panel.append(new Element('h2')); this.input = new Element('textarea'); this.runButton = new Element('button');
    this.messages = new Element('div'); this.messages.scrollTop = 0; this.messages.scrollHeight = 10;
    this.sendButton = new Element('button'); this.openButton = new Element('button'); this.renderCount = 0; this.noticeCount = 0;
  }
  render() { this.renderCount++; if (this.workflowId) { this.lastRenderedId = this.workflowId; this.input.value = this.state().draft; } }
  renderContext() { this.contextTitle = this.editor.doc.title; }
  renderNotice() { this.noticeCount++; }
  toggle(value) { this.open = value; }
  schedulePoll() {}
}

function fixture(t, api, conversationId = 'supervisor-a', options = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'), storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: tag => new Element(tag) } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {} } });
  t.after(() => { previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document; storage ? Object.defineProperty(globalThis, 'localStorage', storage) : delete globalThis.localStorage; });
  return new Harness(new Element('div'), { api, conversationId, ...options });
}

test('constructing a specific supervisor topic reads that case without first loading legacy history', async t => {
  const calls = [], ui = fixture(t, async (path, options) => { calls.push({ path, options }); return snapshot('supervisor-a'); });
  await flush();
  assert.equal(ui.workflowId, 'supervisor-a'); assert.equal(ui.editor.doc.id, 'supervisor-a');
  assert.deepEqual(calls, [{ path: '/api/app-assistant/conversations/supervisor-a', options: undefined }]);
  assert.equal(ui.states.has('global-application'), false); assert.equal(ui.runButton.hidden, true);
});

test('switching topics keeps composer drafts, pending issues and request identities separate', async t => {
  const ui = fixture(t, async path => snapshot(path.split('/').at(-1)));
  await flush(); ui.state().draft = 'A 尚未发送的输入'; ui.state().retry = { clientMessageId: 'message-a' }; ui.state().pending = [{ id: 'issue-a' }];
  await ui.selectConversation('supervisor-b');
  assert.equal(ui.input.value, ''); assert.equal(ui.state().retry, null); assert.deepEqual(ui.state().pending, []);
  ui.state().draft = 'B 的独立输入'; await ui.selectConversation('supervisor-a');
  assert.equal(ui.input.value, 'A 尚未发送的输入'); assert.equal(ui.state().retry.clientMessageId, 'message-a'); assert.deepEqual(ui.state().pending, [{ id: 'issue-a' }]);
  assert.equal(ui.editor.doc.title, 'supervisor-a');
  await ui.selectConversation('supervisor-b'); assert.equal(ui.input.value, 'B 的独立输入');
});

test('a late GET for an old topic updates its own saved state without replacing the selected topic or title', async t => {
  const old = deferred(), ui = fixture(t, async path => path.endsWith('supervisor-a') ? old.promise : snapshot('supervisor-b', 2, { title: 'B 的新主题', turns: [{ id: 'b' }] }));
  await ui.selectConversation('supervisor-b'); await flush(); ui.state().draft = 'B 新草稿'; const renders = ui.renderCount;
  old.resolve(snapshot('supervisor-a', 10, { title: 'A 迟到标题', turns: [{ id: 'a' }] })); await flush();
  assert.equal(ui.workflowId, 'supervisor-b'); assert.equal(ui.editor.doc.title, 'B 的新主题'); assert.equal(ui.state().draft, 'B 新草稿');
  assert.equal(ui.state().conversation.turns[0].id, 'b'); assert.equal(ui.state('supervisor-a').conversation.turns[0].id, 'a'); assert.equal(ui.renderCount, renders);
});

test('late SSE is addressed to the original topic and unknown topic events cannot change the current view', async t => {
  const ui = fixture(t, async path => snapshot(path.split('/').at(-1)));
  await flush(); await ui.selectConversation('supervisor-b'); await flush(); const renders = ui.renderCount;
  ui.onEvent({ type: 'application.conversation', payload: snapshot('supervisor-a', 5, { title: 'A 事件', turns: [{ id: 'a' }] }) });
  ui.onEvent({ type: 'application.conversation', payload: snapshot('supervisor-unknown', 99, { title: '未知事件' }) });
  assert.equal(ui.workflowId, 'supervisor-b'); assert.equal(ui.editor.doc.title, 'supervisor-b'); assert.equal(ui.renderCount, renders);
  assert.equal(ui.state('supervisor-a').conversation.turns[0].id, 'a'); assert.equal(ui.states.has('supervisor-unknown'), false);
  ui.onEvent({ type: 'application.conversation', payload: snapshot('supervisor-b', 2, { title: 'B 事件', turns: [{ id: 'b' }] }) });
  assert.equal(ui.editor.doc.title, 'B 事件'); assert.equal(ui.state().conversation.turns[0].id, 'b');
});

test('a proposal action captures its original case path even if another case is selected before clicking', async t => {
  const calls = [], ui = fixture(t, async (path, options) => { calls.push({ path, options }); return snapshot(path.includes('/turns/') ? 'supervisor-a' : path.split('/').at(-1), 2); });
  await flush(); const turn = { id: 'turn-a', status: 'proposed', assistant: { operations: [{ op: 'remove-node', nodeId: 'old' }], targetWorkflowId: 'workflow-a' } };
  const view = ui.proposalView(turn), apply = view.children.find(item => item.tagName === 'button');
  await ui.selectConversation('supervisor-b'); await flush(); ui.state().draft = 'B 留下的输入'; await apply.listeners.click();
  const post = calls.find(call => call.options?.method === 'POST');
  assert.deepEqual(post, { path: '/api/app-assistant/conversations/supervisor-a/turns/turn-a/action', options: { method: 'POST', body: { action: 'mark-applied' } } });
  assert.equal(ui.workflowId, 'supervisor-b'); assert.equal(ui.state().draft, 'B 留下的输入'); assert.equal(ui.state('supervisor-a').conversation.revision, 2);
});

test('an old proposal failure reports only on its original case and does not overwrite another case notice', async t => {
  const ui = fixture(t, async (path, options) => { if (options) throw Error('旧提案已过期'); return snapshot(path.split('/').at(-1)); });
  await flush(); const view = ui.proposalView({ id: 'turn-a', status: 'proposed', assistant: { operations: [{ op: 'remove-node', nodeId: 'old' }] } });
  await ui.selectConversation('supervisor-b'); await flush(); ui.state().error = 'B 现有状态'; const notices = ui.noticeCount;
  await view.children.find(item => item.tagName === 'button').listeners.click();
  assert.equal(ui.state().error, 'B 现有状态'); assert.equal(ui.state('supervisor-a').error, '旧提案已过期'); assert.equal(ui.noticeCount, notices);
});

test('a late send response clears only the original topic draft and preserves the newer topic input', async t => {
  const response = deferred(), calls = [], ui = fixture(t, async (path, options) => { calls.push({ path, options }); return options ? response.promise : snapshot(path.split('/').at(-1)); });
  await flush(); ui.state().draft = '诊断 A'; const sending = ui.send(); await ui.selectConversation('supervisor-b'); await flush(); ui.state().draft = '诊断 B';
  response.resolve(snapshot('supervisor-a', 2, { turns: [{ id: 'a-response', status: 'complete' }] })); await sending;
  assert.equal(calls.find(call => call.options)?.path, '/api/app-assistant/conversations/supervisor-a/messages');
  assert.equal(ui.state().draft, '诊断 B'); assert.equal(ui.state('supervisor-a').draft, ''); assert.equal(ui.state().conversation.turns.length, 0);
});

test('legacy history keeps its explicit case identity and invalid case ids cannot trigger any request', async t => {
  const calls = [], ui = fixture(t, async path => { calls.push(path); return snapshot(path.split('/').at(-1)); }, 'global-application');
  await flush(); assert.deepEqual(calls, ['/api/app-assistant/conversations/global-application']);
  for (const id of ['../other', '', 'id?query=1', 'id/turns', null]) await assert.rejects(ui.selectConversation(id), /编号无效/);
  assert.equal(calls.length, 1); assert.equal(ui.workflowId, 'global-application');
});


test('archived and source-bound read-only supervisor metadata locks sends and proposal application', async t => {
  const calls = [], ui = fixture(t, async (path, options) => { calls.push({ path, options }); return snapshot('supervisor-a', 1, { lifecycle: 'archived', lifecycleRevision: 1 }); });
  await flush(); assert.equal(ui.editor.libraryReadOnly, true); ui.state().draft = '不能在旧会话写入'; await ui.send();
  const view = ui.proposalView({ id: 'old-proposal', status: 'proposed', assistant: { operations: [{ op: 'remove-node', nodeId: 'node' }] } });
  assert.equal(view.children.find(item => item.tagName === 'button').disabled, true); assert.equal(calls.some(call => call.options), false);
  ui.accept(snapshot('supervisor-a', 1, { lifecycle: 'active', lifecycleRevision: 2, readOnly: true })); assert.equal(ui.editor.libraryReadOnly, true);
  await ui.send(); assert.equal(calls.some(call => call.options), false);
  ui.accept(snapshot('supervisor-a', 1, { lifecycle: 'active', lifecycleRevision: 3, readOnly: false })); assert.equal(ui.editor.libraryReadOnly, false);
});

test('an older lifecycle snapshot cannot revive an archived topic or overwrite its title and draft', async t => {
  const ui = fixture(t, async () => snapshot('supervisor-a', 1)); await flush(); ui.state().draft = '保留的草稿';
  ui.accept(snapshot('supervisor-a', 1, { title: '归档记录', lifecycle: 'archived', lifecycleRevision: 4 }));
  const accepted = ui.accept(snapshot('supervisor-a', 9999, { title: '迟到的旧标题', lifecycle: 'active', lifecycleRevision: 3 }));
  assert.equal(accepted, false); assert.equal(ui.editor.libraryReadOnly, true); assert.equal(ui.editor.doc.title, '归档记录'); assert.equal(ui.state().draft, '保留的草稿');
});

test('cached topic switches restore each topic read-only state without leaking the previous lock', async t => {
  const ui = fixture(t, async path => snapshot(path.split('/').at(-1), 1, { lifecycle: path.endsWith('supervisor-a') ? 'archived' : 'active', lifecycleRevision: 1 }));
  await flush(); assert.equal(ui.editor.libraryReadOnly, true);
  await ui.selectConversation('supervisor-b'); assert.equal(ui.editor.libraryReadOnly, false);
  await ui.selectConversation('supervisor-a'); assert.equal(ui.editor.libraryReadOnly, true, 'cached archived topic must remain locked');
  await ui.selectConversation('supervisor-b'); assert.equal(ui.editor.libraryReadOnly, false, 'cached active topic must unlock');
});

test('lifecycle events only refresh current topic metadata through GET without writing messages or settings', async t => {
  const calls = []; let archived = false;
  const ui = fixture(t, async (path, options) => { calls.push({ path, options }); return snapshot('supervisor-a', 1, { lifecycle: archived ? 'archived' : 'active', lifecycleRevision: archived ? 1 : 0 }); });
  await flush(); archived = true; ui.onEvent({ type: 'application.conversations.updated', payload: { conversationId: 'supervisor-a' } }); await flush();
  assert.equal(calls.length, 2); assert(calls.every(call => call.path === '/api/app-assistant/conversations/supervisor-a' && call.options === undefined)); assert.equal(ui.editor.libraryReadOnly, true);
  ui.onEvent({ type: 'application.conversations.updated', payload: { conversationId: 'supervisor-foreign' } }); await flush(); assert.equal(calls.length, 2);
});

test('an archival event during a pending GET schedules a fresh read after the old active snapshot returns', async t => {
  const first = deferred(), calls = [], ui = fixture(t, async (path, options) => { calls.push({ path, options }); return calls.length === 1 ? first.promise : snapshot('supervisor-a', 1, { lifecycle: 'archived', lifecycleRevision: 1 }); });
  ui.onEvent({ type: 'application.conversations.updated', payload: { conversationId: 'supervisor-a', lifecycle: 'archived', lifecycleRevision: 1 } });
  first.resolve(snapshot('supervisor-a', 1, { lifecycle: 'active', lifecycleRevision: 0 })); await flush(); await flush();
  assert.equal(calls.length, 2); assert.equal(ui.state().conversation.lifecycle, 'archived'); assert.equal(ui.editor.libraryReadOnly, true);
});

test('the new-conversation button invokes the owning page callback with the currently selected topic', async t => {
  const opened = [], ui = fixture(t, async path => snapshot(path.split('/').at(-1)), 'supervisor-a', { onNewConversation: id => opened.push(id) });
  await flush(); assert.equal(ui.newConversationButton.textContent, '新会话'); ui.newConversationButton.listeners.click();
  await ui.selectConversation('supervisor-b'); ui.newConversationButton.listeners.click();
  ui.newConversationButton.disabled = true; ui.newConversationButton.listeners.click(); assert.deepEqual(opened, ['supervisor-a', 'supervisor-b']);
});

test('an archived cached topic is already locked when selected before its forced verification GET resolves', async t => {
  const pending = deferred(), calls = []; let firstA = true;
  const ui = fixture(t, async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith('supervisor-a')) { if (firstA) { firstA = false; return snapshot('supervisor-a', 1, { lifecycle: 'active', lifecycleRevision: 0 }); } return pending.promise; }
    return snapshot('supervisor-b', 1, { lifecycle: 'active', lifecycleRevision: 0 });
  });
  await flush(); await ui.selectConversation('supervisor-b');
  ui.onEvent({ type: 'application.conversations.updated', payload: { conversationId: 'supervisor-a', lifecycle: 'archived', lifecycleRevision: 1, readOnly: false } });
  assert.equal(ui.workflowId, 'supervisor-b'); assert.equal(ui.editor.libraryReadOnly, false); assert.equal(ui.state('supervisor-a').conversation.lifecycle, 'archived');
  const switching = ui.selectConversation('supervisor-a');
  assert.equal(ui.editor.libraryReadOnly, true); assert.equal(ui.state().conversation.lifecycleRevision, 1);
  ui.state().draft = '归档后不能发送'; await ui.send(); assert.equal(calls.some(call => call.options), false);
  pending.resolve(snapshot('supervisor-a', 1, { lifecycle: 'archived', lifecycleRevision: 1 })); await switching;
  assert.equal(ui.editor.libraryReadOnly, true); assert.equal(calls.filter(call => call.path.endsWith('supervisor-a')).length, 2);
});

test('an older archive SSE cannot overwrite the restored lifecycle revision or relock its composer', async t => {
  const calls = [], ui = fixture(t, async (path, options) => { calls.push({ path, options }); return snapshot('supervisor-a', 1, { lifecycle: 'active', lifecycleRevision: 0 }); });
  await flush(); ui.accept(snapshot('supervisor-a', 1, { title: '已恢复的主题', lifecycle: 'active', lifecycleRevision: 4, readOnly: false })); ui.state().draft = '恢复后的草稿';
  ui.onEvent({ type: 'application.conversations.updated', payload: { conversationId: 'supervisor-a', lifecycle: 'archived', lifecycleRevision: 3, readOnly: false } }); await flush();
  assert.equal(ui.state().conversation.lifecycle, 'active'); assert.equal(ui.state().conversation.lifecycleRevision, 4); assert.equal(ui.editor.libraryReadOnly, false);
  assert.equal(ui.editor.doc.title, '已恢复的主题'); assert.equal(ui.state().draft, '恢复后的草稿'); assert.equal(calls.length, 1, 'old events do not trigger redundant GETs');
});
