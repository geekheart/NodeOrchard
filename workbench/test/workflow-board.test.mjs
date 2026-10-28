import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowBoard, filterWorkflowBoard, workflowBoardState } from '../public/workflow-board.js';

class FakeElement {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.listeners = new Map(); this.attributes = {}; this.dataset = {}; this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false;
    const classes = new Set(); this.classList = { toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) };
  }
  append(...items) { for (const item of items) { item.remove?.(); item.parentElement = this; this.children.push(item); } }
  prepend(...items) { for (const item of [...items].reverse()) { item.remove?.(); item.parentElement = this; this.children.unshift(item); } }
  insertBefore(item, before) { if (item === before) return; item.remove?.(); const index = before ? this.children.indexOf(before) : -1; item.parentElement = this; if (index < 0) this.children.push(item); else this.children.splice(index, 0, item); }
  replaceChildren(...items) { if (this.contains(globalThis.document?.activeElement)) globalThis.document.activeElement = null; this.children = []; this.append(...items); }
  contains(item) { return this === item || this.children.some(child => child.contains?.(item)); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this); this.parentElement = null; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  emit(type) { for (const listener of this.listeners.get(type) || []) listener({ target: this }); }
  focus() { globalThis.document.activeElement = this; }
}
function fakeDOM(t) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document'), tags = [], document = { activeElement: null, createElement(tag) { tags.push(tag); return new FakeElement(tag); }, createElementNS(_ns, tag) { tags.push(tag); return new FakeElement(tag); } };
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true }); t.after(() => descriptor ? Object.defineProperty(globalThis, 'document', descriptor) : delete globalThis.document); return { document, tags };
}
function summary(id, state = 'ready', overrides = {}) { return { id, title: `流程 ${id}`, state, mode: 'execute', nodeCount: 3, edgeCount: 2, revision: 1, readiness: { ready: state !== 'draft', error: state === 'draft' ? '尚未选择 Skill' : '' }, skillNames: ['humanizer'], latestRun: null, latestLearning: null, scheduleCount: 0, nextRunAt: null, updatedAt: '2030-01-01T01:00:00.000Z', ...overrides }; }
function mounted(t) {
  const { document, tags } = fakeDOM(t), calls = [], requests = [], opened = []; let records = [];
  const ui = new WorkflowBoard(new FakeElement('section'), { api: async path => { calls.push(path); return { workflows: records }; }, onOpen: async id => { opened.push(id); }, onCreate: async () => {}, getRequests: () => requests, taskURL: id => `#/task/${encodeURIComponent(id)}` });
  t.after(() => ui.deactivate()); return { ui, calls, requests, opened, document, tags, setRecords(value) { records = value; } };
}

test('board filters real workflow titles and Skill names while unknown states remain attention', () => {
  const records = [summary('a', 'draft', { title: '会议纪要', skillNames: ['meeting-action-items'] }), summary('b', 'running', { title: 'English rewrite' })];
  assert.deepEqual(filterWorkflowBoard(records, ' MEETING '), [records[0]]); assert.deepEqual(filterWorkflowBoard(records, 'english', 'running'), [records[1]]); assert.deepEqual(filterWorkflowBoard(records, '会议', 'ready'), []);
  assert.equal(workflowBoardState({ state: 'unexpected' }), 'attention');
});

test('loading an empty library never creates fake cards and exposes an explicit creation action', async t => {
  const { ui, calls } = mounted(t); assert.equal(ui.total.textContent, '—'); await ui.load(); assert.equal(calls.length, 1); assert.equal(calls[0], '/api/workflow-library?lifecycle=all'); assert.equal(ui.cards.size, 0); assert.equal(ui.empty.hidden, false); assert.equal(ui.emptyCreate.hidden, false); assert.equal(ui.viewport.hidden, true); assert.equal(ui.total.textContent, '0');
});

test('cards follow server state instead of treating an executed document as a running or completed task', async t => {
  const { ui, setRecords } = mounted(t); const records = [summary('a', 'draft'), summary('b', 'ready', { latestRun: { id: 'r-b', status: 'complete' } }), summary('c', 'running', { latestLearning: { id: 'l-c', status: 'running', bestScore: 0 } }), summary('d', 'attention', { latestRun: { id: 'r-d', status: 'error', error: '执行错误' }, scheduleCount: 2, nextRunAt: '2030-01-02T02:00:00.000Z' })];
  setRecords(records); await ui.load();
  for (const item of records) assert.equal(ui.cards.get(item.id).card.parentElement, ui.columns.get(item.state).list);
  assert.match(ui.cards.get('b').run.textContent, /已完成/); assert.equal(ui.cards.get('b').card.dataset.state, 'ready'); assert.match(ui.cards.get('c').learning.textContent, /最佳 0 分/); assert.match(ui.cards.get('d').timingText.textContent, /已启用定时 2.*下次/); assert.equal(ui.columns.get('running').count.textContent, '1');
});

test('attention explains the newest activity rather than an older run error and schedule count means enabled plans', async t => {
  const { ui, setRecords } = mounted(t); setRecords([summary('a', 'attention', { latestRun: { status: 'error', error: 'old execution error', completedAt: '2030-01-01T00:00:00Z' }, latestLearning: { status: 'exhausted', error: '', completedAt: '2030-01-02T00:00:00Z' }, scheduleCount: 0 })]); await ui.load();
  assert.equal(ui.cards.get('a').reason.textContent, '本次学习尚未达到目标'); assert.equal(ui.cards.get('a').timingText.textContent, '暂无已启用定时任务');
});

test('route activation loads once and hidden boards do not fetch in response to incoming events', async t => {
  const { ui, calls } = mounted(t); ui.activate(); await ui.loadPromise; ui.activate(); assert.equal(calls.length, 1);
  ui.handleEvent({ type: 'workflow.document', payload: { workflow: summary('a') } }); assert.ok(ui.reloadTimer); ui.deactivate(); assert.equal(ui.reloadTimer, null);
  ui.handleEvent({ type: 'workflow.run', payload: { id: 'run', workflowId: 'a', status: 'running' } }); assert.equal(calls.length, 1); ui.activate(); await ui.loadPromise; assert.equal(calls.length, 2);
});

test('refresh updates existing cards in place and preserves search focus, text and selection', async t => {
  const { ui, setRecords, document } = mounted(t); setRecords([summary('a')]); await ui.load(); const row = ui.cards.get('a'); ui.search.value = 'humanizer'; ui.search.selectionStart = 4; ui.search.focus();
  setRecords([summary('a', 'running', { latestRun: { id: 'r', status: 'running' } })]); await ui.load();
  assert.equal(ui.cards.get('a'), row); assert.equal(row.card.parentElement, ui.columns.get('running').list); assert.equal(ui.search.value, 'humanizer'); assert.equal(ui.search.selectionStart, 4); assert.equal(document.activeElement, ui.search);
  ui.filter.value = 'ready'; ui.filter.emit('change'); assert.equal(row.card.hidden, true); assert.equal(ui.emptyClear.hidden, false);
});

test('a lifecycle event during a GET invalidates its stale response and a subsequent read accepts the new state', async t => {
  const { ui, setRecords } = mounted(t); setRecords([summary('a')]); await ui.load(); let done;
  ui.api = () => new Promise(resolve => { done = resolve; }); const pending = ui.load();
  ui.handleEvent({ type: 'workflow.run', payload: { id: 'run-a', workflowId: 'a', status: 'running' } }); done({ workflows: [summary('a', 'draft', { title: 'stale title' })] }); await pending;
  assert.equal(ui.workflows[0].title, '流程 a'); assert.equal(ui.reloadNeeded, true);
  ui.api = async () => ({ workflows: [summary('a', 'running')] }); await ui.load(); assert.equal(ui.cards.get('a').card.dataset.state, 'running'); assert.equal(ui.reloadNeeded, false);
});

test('streamed text alone does not starve board refresh while lifecycle, learning and schedule changes invalidate it', t => {
  const { ui } = mounted(t); ui.handleEvent({ type: 'workflow.run', payload: { id: 'r', workflowId: 'a', status: 'running', partialText: 'one' } }); const revision = ui.eventRevision;
  ui.handleEvent({ type: 'workflow.run', payload: { id: 'r', workflowId: 'a', status: 'running', partialText: 'two' } }); assert.equal(ui.eventRevision, revision);
  ui.handleEvent({ type: 'workflow.run', payload: { id: 'r', workflowId: 'a', status: 'complete' } });
  ui.handleEvent({ type: 'learning.run', payload: { id: 'l', workflowId: 'a', status: 'running', phase: 'optimizing' } });
  ui.handleEvent({ type: 'workflow.schedule', payload: { deleted: true, id: 's', workflowId: 'a' } }); assert.equal(ui.eventRevision, revision + 3);
});

test('pending requests remain linked to real tasks, update in place and disappear only when cancelled', t => {
  const { ui, requests } = mounted(t); ui.active = true; requests.push({ id: 'approval-a', method: 'approval', sessionId: 'session / a', params: { command: '<b>untrusted command</b>' } }); ui.handleEvent({ type: 'request.open' });
  const row = ui.pendingCards.get('approval-a'); assert.equal(row.title.textContent, '执行审批'); assert.equal(row.link.href, '#/task/session%20%2F%20a'); assert.equal(row.description.textContent, '<b>untrusted command</b>'); assert.equal(ui.pending.hidden, false);
  requests[0].params.description = '需要批准'; ui.handleEvent({ type: 'request.open' }); assert.equal(ui.pendingCards.get('approval-a'), row); assert.equal(row.description.textContent, '需要批准'); requests.length = 0; ui.handleEvent({ type: 'request.cancel' }); assert.equal(ui.pending.hidden, true); assert.equal(ui.pendingCards.size, 0);
});

test('pending notice close buttons hide and restore without acknowledging requests, and fresh native requests reappear', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'localStorage', descriptor) : delete globalThis.localStorage);
  const { ui, requests, calls } = mounted(t);
  requests.push({ id: 'approval-a', method: 'approval', sessionId: 'session-a', params: { session_id: 'native-a' } }, { id: 'clarify-b', method: 'clarify', sessionId: 'session-b' });
  const before = structuredClone(requests); ui.renderPending();
  const row = ui.pendingCards.get('approval-a'); row.close.emit('click');
  assert.equal(row.card.hidden, true); assert.equal(ui.pendingCards.get('clarify-b').card.hidden, false);
  assert.equal(ui.pendingRestore.textContent, '显示已隐藏 · 1'); assert.deepEqual(requests, before); assert.equal(calls.length, 0);
  const reloaded = new WorkflowBoard(new FakeElement('section'), { api: () => assert.fail('Display preferences cannot call the backend'), onOpen() {}, onCreate() {}, getRequests: () => requests, taskURL: id => '#/task/' + id });
  t.after(() => reloaded.deactivate());
  assert.equal(reloaded.pendingCards.get('approval-a').card.hidden, true);
  requests[0].params.session_id = 'native-new'; ui.renderPending(); assert.equal(row.card.hidden, false);
  ui.pendingClose.emit('click'); assert.equal(ui.pendingList.hidden, true); assert.equal(ui.pendingRestore.textContent, '显示已隐藏 · 2');
  ui.pendingRestore.emit('click'); assert.equal(ui.pendingList.hidden, false); assert.equal(row.card.hidden, false);
  assert.equal(ui.pendingCards.get('clarify-b').card.hidden, false); assert.equal(calls.length, 0);
});

test('failed or malformed reads retain existing cards and provide retry without a false empty-library state', async t => {
  const { ui, setRecords } = mounted(t); setRecords([summary('a')]); await ui.load(); const card = ui.cards.get('a').card;
  ui.api = async () => { throw new Error('temporarily unavailable'); }; await ui.load(); assert.equal(ui.cards.get('a').card, card); assert.match(ui.noticeText.textContent, /读取失败/); assert.equal(ui.retryButton.hidden, false); assert.equal(ui.empty.hidden, true);
  ui.api = async () => ({ workflows: [{ title: 'missing identity' }] }); await ui.load(); assert.equal(ui.workflows[0].id, 'a'); assert.match(ui.noticeText.textContent, /格式不正确/);
});

test('open and create callbacks are explicit, do not call a model and reject duplicate clicks while in flight', async t => {
  const { ui, setRecords, calls } = mounted(t); setRecords([summary('a')]); await ui.load(); let done, count = 0;
  ui.onOpen = id => { assert.equal(id, 'a'); count++; return new Promise(resolve => { done = resolve; }); }; const opening = ui.open('a'); await ui.open('a'); assert.equal(count, 1); done(); await opening; assert.equal(ui.cards.get('a').card.disabled, false);
  ui.onCreate = () => { count++; return new Promise(resolve => { done = resolve; }); }; const creating = ui.create(); await ui.create(); assert.equal(count, 2); done(); await creating; assert.equal(ui.cards.size, 1); assert.equal(calls.length, 1);
});

test('untrusted titles and errors use text nodes and preserve the existing card when its title changes', async t => {
  const { ui, setRecords, tags } = mounted(t), title = '<img src=x onerror=alert(1)>';
  setRecords([summary('a', 'attention', { title, latestRun: { status: 'error', error: '<script>bad()</script>' } })]); await ui.load(); assert.equal(ui.cards.get('a').title.textContent, title); assert.equal(ui.cards.get('a').reason.textContent, '<script>bad()</script>'); assert.equal(tags.includes('img'), false); assert.equal(tags.includes('script'), false);
});
