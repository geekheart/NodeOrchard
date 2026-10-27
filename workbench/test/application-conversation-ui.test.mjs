import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationConversationUI } from '../public/application-conversation-ui.js';

const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (id, revision = 1, { title = id, turns = [] } = {}) => ({ conversation: { workflowId: id, title, revision, turns }, pending: [] });

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

function fixture(t, api, conversationId = 'supervisor-a') {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'), storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: tag => new Element(tag) } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {} } });
  t.after(() => { previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document; storage ? Object.defineProperty(globalThis, 'localStorage', storage) : delete globalThis.localStorage; });
  return new Harness(new Element('div'), { api, conversationId });
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
