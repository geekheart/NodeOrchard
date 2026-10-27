import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ConversationHubUI, filterHubConversations } from '../public/conversation-hub-ui.js';

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = new Map(); this.attributes = {}; this.value = ''; this.textContent = ''; this.disabled = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
}
const flatten = value => [value, ...value.children.flatMap(flatten)];
const contents = value => flatten(value).map(item => item.textContent).join('\n');
const data = () => ({ workflows: [
  { workflowId: 'workflow-a', title: '采集热榜', lifecycle: 'active', conversation: { turnCount: 5, pendingCount: 1, active: false, status: 'error', lastMessage: { text: '原错误证据保留' } } },
  { workflowId: 'workflow-b', title: '整理报告', lifecycle: 'trashed', conversation: { turnCount: 2, pendingCount: 0, active: true, status: 'thinking' } },
], supervisors: [
  { id: 'supervisor-new', title: '修复热榜连接', turnCount: 2, pendingCount: 0, legacy: false },
  { id: 'global-application', title: '旧全局记录', turnCount: 3, pendingCount: 0, legacy: true },
] });

function fixture(t, api, options = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: tag => new Element(tag) } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'document', descriptor) : delete globalThis.document);
  const root = new Element(), opened = [], counts = [];
  const ui = new ConversationHubUI(root, { api, openSupervisor: id => opened.push(id), onCount: count => counts.push(count), ...options });
  t.after(() => ui.deactivate());
  return { ui, root, opened, counts };
}

test('directory activation reads existing conversations and prefers a recent topic without creating anything', async t => {
  const calls = [], f = fixture(t, async (...args) => { calls.push(args); return data(); });
  await f.ui.activate({});
  assert.deepEqual(calls, [['/api/conversation-hub']]); assert.deepEqual(f.opened, ['supervisor-new']); assert.deepEqual(f.counts, [3]);
  const hrefs = flatten(f.root).map(item => item.href).filter(Boolean);
  assert(hrefs.includes('#/workflows/workflow-a')); assert.equal(hrefs.includes('#/workflows/workflow-b'), false);
  assert.match(contents(f.root), /原错误证据保留/); assert.match(contents(f.root), /旧全局记录/);
  assert.equal(f.ui.data.workflows.length, 1);
});

test('an empty directory does not create or open an empty legacy conversation on GET', async t => {
  const f = fixture(t, async () => ({ workflows: [], supervisors: [{ id: 'global-application', legacy: true, turnCount: 0 }] }));
  await f.ui.activate({}); assert.deepEqual(f.opened, []); assert.match(contents(f.root), /先新建|新建/);
});

test('a populated legacy history remains an available default when there are no new topics', async t => {
  const f = fixture(t, async () => ({ workflows: [], supervisors: [{ id: 'global-application', legacy: true, turnCount: 3 }] }));
  await f.ui.activate({}); assert.deepEqual(f.opened, ['global-application']);
});

test('manual topic selection is never replaced by a late default selection', async t => {
  let release; const wait = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async () => wait); const opening = f.ui.activate({}); f.ui.selected = 'supervisor-explicit'; release(data()); await opening;
  assert.deepEqual(f.opened, []); assert.equal(f.ui.selected, 'supervisor-explicit');
});

test('failed creates preserve the human topic and retry the same identity until acknowledged', async t => {
  const writes = []; let failed = true;
  const f = fixture(t, async (_path, options) => {
    if (!options) return data(); writes.push(options.body); if (failed) throw Error('连接断开'); return { conversation: { id: 'supervisor-created' } };
  });
  f.ui.active = true; f.ui.titleInput.value = '检查采集超时'; await f.ui.create();
  assert.match(f.ui.status.textContent, /未确认/); assert.equal(f.ui.titleInput.value, '检查采集超时'); assert.deepEqual(f.opened, []);
  failed = false; await f.ui.create(); assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
  assert.deepEqual(Object.keys(writes[1]).sort(), ['clientConversationId', 'title']); assert.deepEqual(f.opened, ['supervisor-created']);
  assert.equal(f.ui.titleInput.value, '');
});

test('creation is explicit, blocks double submits, and never sends workflow documents or run requests', async t => {
  const calls = []; let release; const wait = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async (path, options) => { calls.push({ path, options }); if (options) { await wait; return { conversation: { id: 'supervisor-created' } }; } return data(); });
  f.ui.active = true; f.ui.titleInput.value = '新诊断'; const creating = f.ui.create(); await f.ui.create();
  assert.equal(calls.length, 1); assert.equal(f.ui.titleInput.disabled, true); release(); await creating;
  assert.equal(calls[0].path, '/api/app-assistant/conversations'); assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[1].path, '/api/conversation-hub'); assert.equal(calls[1].options, undefined);
});

test('leaving the page during a request prevents automatic navigation to a conversation', async t => {
  let release; const wait = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async () => wait); const activation = f.ui.activate({}); f.ui.deactivate(); release(data()); await activation;
  assert.deepEqual(f.opened, []);
});

test('readonly captures cannot create topics but can inspect the directory', async t => {
  const calls = [], f = fixture(t, async (path, options) => { calls.push({ path, options }); return data(); }, { readOnly: true });
  await f.ui.activate({ id: 'global-application' }); f.ui.titleInput.value = '禁止创建'; await f.ui.create();
  assert.deepEqual(calls, [{ path: '/api/conversation-hub', options: undefined }]); assert.equal(f.ui.createButton.disabled, true); assert.deepEqual(f.opened, []);
});

test('search and status filters operate on summaries without merging workflows or history', () => {
  const rows = data().workflows;
  assert.deepEqual(filterHubConversations(rows, { query: '错误证据' }).map(row => row.workflowId), ['workflow-a']);
  assert.deepEqual(filterHubConversations(rows, { filter: 'active' }), []);
  assert.deepEqual(filterHubConversations(rows, { filter: 'pending' }).map(row => row.workflowId), ['workflow-a']);
  assert.deepEqual(filterHubConversations(rows, { query: '整理报告' }), []);
  rows[1].lifecycle = 'active';
  assert.deepEqual(filterHubConversations(rows, { filter: 'active' }).map(row => row.workflowId), ['workflow-b']);
  assert.equal(rows.length, 2);
});

test('directory excludes recycled and legacy archived conversations from every filter and count', async t => {
  const records = data(); records.workflows.push({ ...records.workflows[1], workflowId: 'workflow-c', title: '旧归档报告', lifecycle: 'archived' });
  const before = structuredClone(records);
  const f = fixture(t, async () => records);
  await f.ui.activate({ id: 'supervisor-new' });
  assert.deepEqual(f.ui.filterInput.children.map(item => [item.value, item.textContent]),
    [['all', '全部'], ['pending', '待处理'], ['active', '正在回复']]);
  assert.equal(f.ui.data.workflows.length, 1); assert.deepEqual(f.counts, [3]);
  assert.equal(f.ui.status.textContent, '1 个工作流独立会话 · 2 个总控主题');
  for (const filter of ['all', 'pending', 'active']) {
    f.ui.filterInput.value = filter; f.ui.filterInput.listeners.get('change')();
    assert.doesNotMatch(contents(f.ui.workflowList), /整理报告|旧归档报告|回收站/);
    assert.equal(filterHubConversations(records.workflows, { filter }).some(row => row.lifecycle !== 'active'), false);
  }
  f.ui.search.value = '报告'; f.ui.search.listeners.get('input')();
  assert.doesNotMatch(contents(f.ui.workflowList), /整理报告|旧归档报告/);
  assert.deepEqual(records, before);
});

test('lifecycle events hide a trashed conversation and show it again after restoration without writing history', async t => {
  const records = data(); records.workflows[1].lifecycle = 'active'; let reads = 0;
  const f = fixture(t, async (_path, options) => { assert.equal(options, undefined); reads++; return structuredClone(records); });
  await f.ui.activate({ id: 'supervisor-new' });
  assert.match(contents(f.ui.workflowList), /整理报告/);
  records.workflows[1].lifecycle = 'trashed'; f.ui.onEvent({ type: 'workflow.lifecycle' }); await delay(230);
  assert.doesNotMatch(contents(f.ui.workflowList), /整理报告/); assert.equal(f.ui.data.workflows.length, 1);
  records.workflows[1].lifecycle = 'active'; f.ui.onEvent({ type: 'workflow.lifecycle' }); await delay(230);
  assert.match(contents(f.ui.workflowList), /整理报告/); assert.equal(f.ui.data.workflows.length, 2);
  assert.equal(reads, 3); assert.deepEqual(f.counts, [4, 3, 4]);
});

test('ordinary historical tasks remain navigable and managed model sessions are not duplicated', async t => {
  const f = fixture(t, async () => data(), { getSessions: () => [{ id: 'old-task', title: '旧普通任务', updatedAt: '2026-10-27T01:00:00Z' }, { id: 'worker', title: '模型控制会话', workflowManaged: true }] });
  await f.ui.activate({ id: 'supervisor-new' });
  assert.match(contents(f.ui.history), /旧普通任务/); assert.doesNotMatch(contents(f.ui.history), /模型控制会话/);
  assert.equal(flatten(f.ui.history).find(item => item.href)?.href, '#/task/old-task');
});

test('routing aliases project links to conversation management and mounts shared global chat only there', async () => {
  const [app, html] = await Promise.all([readFile(new URL('../public/app.js', import.meta.url), 'utf8'), readFile(new URL('../public/index.html', import.meta.url), 'utf8')]);
  assert.match(app, /showApplicationChat = route\.page === 'conversations' && Boolean\(route\.id\)/);
  assert.match(app, /parts\[0\] === 'project' \|\| parts\[0\] === 'projects'/);
  assert.match(app, /history\.replaceState\(null, '', '#\/conversations'\)/);
  assert.match(html, /data-nav="conversations" aria-label="对话管理"/);
  assert.doesNotMatch(html, /data-page="projects"/);
});
