import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMaintenanceTask } from '../public/maintenance-task-ui.js';
import { ApplicationConversationUI } from '../public/application-conversation-ui.js';
import { WorkflowConversationUI } from '../public/workflow-conversation-ui.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.textContent = ''; this.disabled = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  querySelector(selector) { return this.children.find(node => node.tagName === selector) || this.children.map(node => node.querySelector?.(selector)).find(Boolean) || null; }
  focus() {}
}
const flatten = node => [node, ...node.children.flatMap(flatten)];
const task = (extra = {}) => ({ id: 'maintenance-a', revision: 3, conversationId: 'supervisor-a', sourceTurnId: 'turn-a', workflowId: 'workflow-a',
  status: 'waiting_permission', stage: 'repair', summary: '定位到执行器异常', note: '隔离复现完成', canContinue: false, canStop: true,
  permissionRequest: { permission: 'supervisor.sourceRepair', enabled: false, settingsUrl: '#/settings', reason: '修复需要源码写入权限' }, ...extra });
function dom(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: tag => new Element(tag) } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document);
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (id, revision, turns = []) => ({ conversation: { workflowId: id, title: id, revision, turns }, pending: [] });
const turn = (value = task()) => ({ id: value.sourceTurnId, user: { text: '修复执行问题', context: {} }, assistant: { text: '等待继续', maintenanceTask: value }, status: 'complete' });
class Harness extends ApplicationConversationUI {
  mount() {
    this.panel = new Element('aside'); this.panel.append(new Element('h2')); this.input = new Element('textarea'); this.runButton = new Element('button');
    this.messages = new Element('div'); this.messages.scrollTop = 0; this.messages.scrollHeight = 10;
    this.sendButton = new Element('button'); this.openButton = new Element('button'); this.renderCount = 0;
  }
  render() { this.renderCount++; if (this.workflowId) this.input.value = this.state().draft; }
  renderContext() {}
  renderNotice() {}
  toggle() {}
  schedulePoll() {}
}
async function uiFixture(t, api) {
  dom(t); const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {} } });
  t.after(() => storage ? Object.defineProperty(globalThis, 'localStorage', storage) : delete globalThis.localStorage);
  const ui = new Harness(new Element('div'), { api, conversationId: 'supervisor-a' }); await flush(); return ui;
}

test('maintenance card shows concise progress and a settings link without any permission toggle', t => {
  dom(t); const card = renderMaintenanceTask(task(), { supervisor: true });
  const nodes = flatten(card), text = nodes.map(node => node.textContent).join('\n');
  assert.match(text, /修复/); assert.match(text, /等待权限/); assert.match(text, /定位到执行器异常/);
  assert.equal(nodes.find(node => node.tagName === 'a').href, '#/settings');
  assert.equal(nodes.some(node => node.tagName === 'input'), false);
  assert.equal(nodes.find(node => node.textContent === '继续维护').disabled, true);
});

test('independent workflow cards only link to the owning supervisor and never expose maintenance actions', t => {
  dom(t); const card = renderMaintenanceTask(task({ canContinue: true }), { supervisor: false });
  const nodes = flatten(card);
  assert.equal(nodes.some(node => node.tagName === 'button'), false);
  assert.deepEqual(nodes.filter(node => node.tagName === 'a').map(node => node.href), ['#/conversations/supervisor-a']);
});

test('maintenance success labels retain the exact isolated verification scope', t => {
  dom(t);
  const source = flatten(renderMaintenanceTask(task({ status: 'verified', lastExperiment: { status: 'passed', scope: 'isolated-source-tests' } }), { supervisor: true })).map(node => node.textContent).join('\n');
  assert.match(source, /所列范围通过/); assert.match(source, /源码副本相关测试：通过/); assert.doesNotMatch(source, /全工作流|已修复/);
  const candidate = flatten(renderMaintenanceTask(task({ status: 'candidate_verified', lastExperiment: { status: 'failed', scope: 'isolated-node-reproduction' } }))).map(node => node.textContent).join('\n');
  assert.match(candidate, /候选验证通过/); assert.match(candidate, /单节点隔离复现：未通过/);
});

test('continue sends a new classified human message in the owning topic without consuming a draft or saved attachments', async t => {
  const calls = [], value = task({ status: 'waiting_continue', canContinue: true });
  const ui = await uiFixture(t, async (path, options) => { calls.push({ path, options }); return snapshot('supervisor-a', options ? 2 : 1, [turn(value)]); });
  const attachment = { key: 'saved-input', status: 'ready', attachment: { id: 'attachment-a', workflowId: 'workflow-a' } };
  ui.state().draft = '保留这句未发送的话'; ui.state().attachmentDrafts = [attachment];
  await ui.continueMaintenanceTask(value);
  const post = calls.find(call => call.options?.method === 'POST');
  assert.equal(post.path, '/api/app-assistant/conversations/supervisor-a/messages');
  assert.deepEqual(post.options.body.context, { maintenanceTaskId: value.id }); assert.equal(post.options.body.intent, 'auto');
  assert.match(post.options.body.clientMessageId, /^[A-Za-z0-9_-]+$/); assert.match(post.options.body.text, /仅在当前权限内推进，保留原工作流/);
  assert.equal(ui.state().draft, '保留这句未发送的话'); assert.deepEqual(ui.state().attachmentDrafts, [attachment]);
  assert.equal(post.options.body.attachments, undefined); assert.equal(calls.some(call => call.path.includes('assistant-permissions')), false);
});

test('an uncertain continuation reuses its original message ID and a stale topic callback never sends into another conversation', async t => {
  const posts = [], value = task({ status: 'waiting_continue', canContinue: true });
  const ui = await uiFixture(t, async (path, options) => {
    if (options) { posts.push(options.body); if (posts.length === 1) throw new Error('response lost'); }
    const id = path.includes('/messages') ? 'supervisor-a' : path.split('/').at(-1); return snapshot(id, 1, id === 'supervisor-a' ? [turn(value)] : []);
  });
  ui.state().draft = '其他草稿'; await ui.continueMaintenanceTask(value); await ui.continueMaintenanceTask(value);
  assert.equal(posts.length, 2); assert.equal(posts[0].clientMessageId, posts[1].clientMessageId);
  await ui.selectConversation('supervisor-b'); ui.state().draft = 'B 的消息';
  assert.equal(await ui.continueMaintenanceTask(value), false); assert.equal(posts.length, 2); assert.equal(ui.state().draft, 'B 的消息');
});

test('maintenance SSE updates only its saved topic, rejects foreign identity and cannot roll back task revision', async t => {
  const ui = await uiFixture(t, async path => snapshot(path.split('/').at(-1), 1, path.endsWith('supervisor-a') ? [turn()] : []));
  await ui.selectConversation('supervisor-b'); ui.state().draft = 'B 独立草稿'; const renders = ui.renderCount;
  const latest = task({ revision: 7, status: 'verified', stage: 'verify', canContinue: true });
  ui.onEvent({ type: 'application.maintenance', payload: { conversationId: 'supervisor-a', task: latest } });
  ui.onEvent({ type: 'application.maintenance', payload: { conversationId: 'supervisor-a', task: task({ revision: 2, status: 'running' }) } });
  ui.onEvent({ type: 'application.maintenance', payload: { conversationId: 'supervisor-b', task: latest } });
  ui.onEvent({ type: 'application.maintenance', payload: { conversationId: 'supervisor-foreign', task: task({ conversationId: 'supervisor-foreign' }) } });
  assert.equal(ui.state('supervisor-a').maintenanceTasks.get(latest.id).status, 'verified');
  assert.equal(ui.state('supervisor-a').maintenanceTasks.get(latest.id).revision, 7);
  assert.equal(ui.states.has('supervisor-foreign'), false); assert.equal(ui.renderCount, renders); assert.equal(ui.state().draft, 'B 独立草稿');
  await ui.selectConversation('supervisor-a'); assert.equal(ui.maintenanceTaskView(ui.state().conversation.turns[0]).dataset.maintenanceTaskId, latest.id);
});

test('permission save refreshes card eligibility through GET and never enables a permission or continues automatically', async t => {
  let reads = 0; const posts = [], ui = await uiFixture(t, async (path, options) => {
    if (options) posts.push({ path, options });
    return snapshot('supervisor-a', ++reads, [turn(task({ canContinue: reads > 1, permissionRequest: { permission: 'supervisor.sourceRepair', enabled: reads > 1, reason: '需要权限' } }))]);
  });
  ui.state().draft = '未发送草稿'; ui.onEvent({ type: 'assistant.permissions.updated', payload: { revision: 8 } }); await flush();
  assert.equal(reads, 2); assert.deepEqual(posts, []); assert.equal(ui.state().draft, '未发送草稿');
  const value = ui.state().maintenanceTasks.get('maintenance-a'); assert.equal(value.permissionRequest.enabled, true); assert.equal(value.canContinue, true);
});

test('stop binds the original topic, turn and task revision while a late response preserves the newly selected topic', async t => {
  let resolve; const pending = new Promise(done => { resolve = done; }), calls = [], value = task({ status: 'running' });
  const ui = await uiFixture(t, async (path, options) => { calls.push({ path, options }); return options ? pending : snapshot(path.split('/').at(-1), 1, path.endsWith('supervisor-a') ? [turn(value)] : []); });
  const stopping = ui.stopMaintenanceTask(value, 'turn-a'); await ui.selectConversation('supervisor-b'); ui.state().draft = 'B 的草稿';
  resolve(snapshot('supervisor-a', 2, [turn(task({ revision: 4, status: 'stopped', canStop: false }))])); await stopping;
  const post = calls.find(call => call.options);
  assert.equal(post.path, '/api/app-assistant/conversations/supervisor-a/turns/turn-a/action');
  assert.deepEqual(post.options.body, { action: 'stop-maintenance', taskId: value.id, expectedRevision: 3 });
  assert.equal(ui.workflowId, 'supervisor-b'); assert.equal(ui.state().draft, 'B 的草稿'); assert.equal(ui.state('supervisor-a').maintenanceTasks.get(value.id).status, 'stopped');
});

test('a task renders once at its newest message and independent workflow SSE remains read-only and bound', async t => {
  const ui = await uiFixture(t, async () => snapshot('supervisor-a', 1, [turn(), { ...turn(), id: 'turn-next' }]));
  assert.equal(ui.maintenanceTaskView(ui.state().conversation.turns[0]), null);
  assert(ui.maintenanceTaskView(ui.state().conversation.turns[1]));
  const workflow = Object.create(WorkflowConversationUI.prototype);
  Object.assign(workflow, { workflowId: 'workflow-a', states: new Map(), editor: { libraryReadOnly: false }, actionPending: new Set(), render() {} });
  workflow.state().conversation.turns = [turn()];
  workflow.acceptMaintenanceEvent({ conversationId: 'supervisor-a', task: task({ revision: 4, status: 'running' }) });
  const card = workflow.maintenanceTaskView(workflow.state().conversation.turns[0]);
  assert.equal(flatten(card).some(node => node.tagName === 'button'), false);
  assert.equal(workflow.acceptMaintenanceEvent({ conversationId: 'supervisor-a', task: task({ revision: 5, workflowId: 'workflow-b' }) }), false);
});
