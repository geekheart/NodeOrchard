import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowBoard, workflowLifecycle, workflowLifecycleActions } from '../public/workflow-board.js';

class FakeElement {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = {}; this.dataset = {}; this.style = {}; this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; const classes = new Set(); this.classList = { toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) }; }
  append(...items) { for (const item of items) { item.remove?.(); item.parentElement = this; this.children.push(item); } }
  prepend(...items) { for (const item of [...items].reverse()) { item.remove?.(); item.parentElement = this; this.children.unshift(item); } }
  insertBefore(item, before) { if (item === before) return; item.remove?.(); const at = before ? this.children.indexOf(before) : -1; item.parentElement = this; if (at < 0) this.children.push(item); else this.children.splice(at, 0, item); }
  replaceChildren(...items) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...items); }
  contains(item) { return this === item || this.children.some(child => child.contains?.(item)); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this); this.parentElement = null; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  emit(type, props = {}) { const event = { target: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...props }; for (const listener of this.listeners.get(type) || []) listener(event); return event; }
  focus() { globalThis.document.activeElement = this; }
}
const summary = (id, lifecycle, extra = {}) => ({ id, title: `流程 ${id}`, lifecycle, revision: 4, state: 'ready', mode: 'execute', nodeCount: 3, edgeCount: 2, skillNames: ['outline'], latestRun: null, latestLearning: null, scheduleCount: 0, updatedAt: '2030-01-01T00:00:00Z', ...extra });
function mounted(t, initial = []) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document'), document = { activeElement: null, createElement: tag => new FakeElement(tag), createElementNS: (_ns, tag) => new FakeElement(tag) }; Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  let records = initial; const calls = [], opened = []; const ui = new WorkflowBoard(new FakeElement('section'), { api: async (path, options) => { calls.push({ path, options }); return { workflows: records }; }, onOpen: async id => opened.push(id), onCreate: async () => {}, taskURL: id => `#/task/${id}` });
  t.after(() => { if (ui.dialog) ui.dialog.pending = false; ui.deactivate(); if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else delete globalThis.document; });
  return { ui, calls, opened, document, get records() { return records; }, set records(value) { records = value; } };
}
function menuLabels(ui) { return ui.menu.children.filter(item => item.tagName === 'BUTTON').map(item => item.textContent); }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

// These tests exercise state transitions and UI submission barriers; the backend tests verify the persisted lifecycle policy.
test('two lifecycle tabs combine legacy archives with trash while old summaries stay active', async t => {
  const ctx = mounted(t, [summary('old', undefined), summary('a', 'active'), summary('b', 'archived', { archivedAt: '2030-01-02T00:00:00Z' }), summary('c', 'trashed')]); await ctx.ui.load();
  assert.equal(ctx.calls[0].path, '/api/workflow-library?lifecycle=all'); assert.equal(workflowLifecycle({}), 'active'); assert.equal(workflowLifecycle({ lifecycle: 'unexpected' }), 'unknown');
  assert.deepEqual([...ctx.ui.lifecycleTabs.keys()], ['active', 'trashed']); assert.equal(workflowLifecycle({ lifecycle: 'archived' }), 'trashed');
  assert.equal(ctx.ui.cards.get('old').card.hidden, false); assert.equal(ctx.ui.cards.get('b').card.hidden, true); assert.match(ctx.ui.summary.textContent, /工作流中 2 \/ 2.*全部 4/);
  ctx.ui.selectLifecycle('trashed'); assert.equal(ctx.ui.columnGrid.hidden, true); assert.equal(ctx.ui.inactiveList.hidden, false); assert.equal(ctx.ui.filterLabel.hidden, true); assert.equal(ctx.ui.cards.get('b').card.hidden, false); assert.equal(ctx.ui.cards.get('c').card.hidden, false); assert.equal(ctx.ui.cards.get('a').card.hidden, true); assert.match(ctx.ui.cards.get('b').updated.textContent, /已在回收站/); assert.match(ctx.ui.cards.get('b').timingText.textContent, /定时任务已停用/);
  assert.equal(ctx.ui.lifecycleTabs.get('trashed').total.textContent, '2'); assert.equal(ctx.ui.lifecycleTabs.get('trashed').tab.attributes['aria-selected'], 'true');
  ctx.ui.search.value = '不存在'; ctx.ui.render(); assert.equal(ctx.ui.empty.hidden, false); assert.equal(ctx.ui.emptyText.hidden, true); assert.equal(ctx.ui.emptyTitle.textContent, '没有匹配的工作流');
});

test('each lifecycle exposes only legal actions and separate menu buttons never open the editor', async t => {
  const { ui, opened } = mounted(t, [summary('a', 'active'), summary('b', 'archived'), summary('c', 'trashed')]); await ui.load();
  for (const row of ui.cards.values()) { assert.equal(row.card.tagName, 'ARTICLE'); assert.equal(row.openButton.contains(row.more), false); assert.equal(row.more.contains(row.openButton), false); assert.match(row.openButton.attributes['aria-label'], /^打开工作流：/); }
  ui.cards.get('a').more.emit('click'); assert.deepEqual(menuLabels(ui), ['移入回收站']); assert.deepEqual(opened, []); assert.equal(ui.cards.get('a').more.attributes['aria-expanded'], 'true');
  ui.selectLifecycle('trashed'); ui.cards.get('b').more.emit('click'); assert.deepEqual(menuLabels(ui), ['恢复到工作流', '永久删除工作流']);
  ui.selectLifecycle('trashed'); ui.cards.get('c').more.emit('click'); assert.deepEqual(menuLabels(ui), ['恢复到工作流', '永久删除工作流']); assert.deepEqual(workflowLifecycleActions({ lifecycle: 'deleted' }), []);
});

test('waiting review and learning work cannot be silently trashed or stopped from the menu', async t => {
  const { ui, calls } = mounted(t, [summary('review', 'active', { state: 'attention', latestRun: { status: 'waiting_review' } }), summary('learn', 'active', { state: 'attention', latestLearning: { status: 'waiting' } })]); await ui.load();
  for (const id of ['review', 'learn']) { ui.toggleMenu(id); assert.equal(ui.menu.children[0].disabled, true); assert.match(ui.menu.children[1].textContent, /先停止/); ui.openLifecycleDialog(id, 'trash', ui.cards.get(id).more); assert.equal(ui.dialog, null); }
  assert.equal(calls.length, 1);
});

test('trash sends the revision once and keeps the original card until a new authoritative list arrives', async t => {
  const ctx = mounted(t, [summary('a', 'active')]); const { ui } = ctx; await ui.load(); const post = deferred(), read = deferred(); const mutations = []; let reads = 0;
  ui.api = (path, options) => { if (options?.method === 'POST') { mutations.push({ path, options }); return post.promise; } reads++; return read.promise; };
  ui.openLifecycleDialog('a', 'trash', ui.cards.get('a').more); assert.match(ui.dialog.panel.children[2].textContent, /停用关联定时任务/); const submitting = ui.submitLifecycle(); await ui.submitLifecycle();
  assert.equal(mutations.length, 1); assert.equal(mutations[0].path, '/api/workflow-library/a/trash'); assert.deepEqual(mutations[0].options.body, { expectedRevision: 4 }); assert.equal(ui.dialog.pending, true); assert.equal(ui.dialog.cancel.disabled, true); assert.equal(workflowLifecycle(ui.workflows[0]), 'active');
  post.resolve({ workflow: summary('a', 'trashed', { revision: 5 }) }); await Promise.resolve(); await Promise.resolve(); assert.equal(reads, 1); assert.equal(ui.cards.get('a').card.hidden, false);
  read.resolve({ workflows: [summary('a', 'trashed', { revision: 5 })] }); await submitting; assert.equal(ui.dialog, null); assert.equal(ui.cards.get('a').card.hidden, true); assert.match(ui.noticeText.textContent, /已移入回收站/);
});

test('purge requires the exact complete name, only exists in trash, and errors preserve the input', async t => {
  const { ui, calls } = mounted(t, [summary('a', 'active'), summary('c', 'trashed', { title: '完整流程 / C' })]); await ui.load(); ui.openLifecycleDialog('a', 'purge'); assert.equal(ui.dialog, null);
  ui.selectLifecycle('trashed'); ui.openLifecycleDialog('c', 'purge', ui.cards.get('c').more); const dialog = ui.dialog; assert.equal(dialog.submit.disabled, true); assert.match(dialog.panel.children[2].textContent, /运行历史和已生成文件保留/);
  dialog.input.value = '完整流程'; dialog.input.emit('input'); await ui.submitLifecycle(); assert.equal(calls.length, 1); dialog.input.value = '完整流程 / C '; dialog.input.emit('input'); assert.equal(dialog.submit.disabled, true);
  dialog.input.value = '完整流程 / C'; dialog.input.emit('input'); assert.equal(dialog.submit.disabled, false); const mutations = []; ui.api = async (path, options) => { mutations.push({ path, options }); throw new Error('版本已变化，请刷新后重新打开操作'); };
  await ui.submitLifecycle(); assert.equal(ui.dialog, dialog); assert.equal(dialog.input.value, '完整流程 / C'); assert.match(dialog.error.textContent, /版本已变化/); assert.equal(dialog.submit.disabled, false); assert.deepEqual(mutations[0].options.body, { expectedRevision: 4, confirmationTitle: '完整流程 / C' });
});

test('restore returns directly to active using one explicit action and the current revision', async t => {
  const { ui } = mounted(t, [summary('c', 'trashed')]); await ui.load(); const calls = []; let lifecycle = 'trashed', revision = 4;
  ui.api = async (path, options) => { calls.push({ path, options }); if (options?.method === 'POST') { lifecycle = 'active'; revision++; return { workflow: summary('c', lifecycle, { revision }) }; } return { workflows: [summary('c', lifecycle, { revision })] }; };
  ui.selectLifecycle('trashed'); ui.openLifecycleDialog('c', 'restore'); await ui.submitLifecycle(); assert.equal(ui.workflows[0].lifecycle, 'active');
  const mutations = calls.filter(item => item.options?.method === 'POST'); assert.equal(mutations.length, 1); assert.equal(mutations[0].path, '/api/workflow-library/c/restore'); assert.deepEqual(mutations[0].options.body, { expectedRevision: 4 });
  ui.selectLifecycle('active'); assert.equal(ui.cards.get('c').card.hidden, false); assert.deepEqual(workflowLifecycleActions(ui.workflows[0]), ['trash']);
});

test('a successful mutation with a failed refresh offers a read retry without repeating the mutation', async t => {
  const { ui } = mounted(t, [summary('c', 'trashed')]); await ui.load(); ui.selectLifecycle('trashed'); let posts = 0, healthy = false;
  ui.api = async (_path, options) => { if (options?.method === 'POST') { posts++; return { deleted: true, id: 'c', lifecycle: 'deleted' }; } if (!healthy) throw new Error('read temporarily unavailable'); return { workflows: [] }; };
  ui.openLifecycleDialog('c', 'purge'); ui.dialog.input.value = '流程 c'; ui.dialog.input.emit('input'); await ui.submitLifecycle(); assert.equal(posts, 1); assert.equal(ui.dialog.committed, true); assert.equal(ui.dialog.input.disabled, true); assert.equal(ui.dialog.submit.textContent, '重新读取列表'); assert.match(ui.dialog.error.textContent, /不会重复提交操作/); assert.equal(ui.cards.has('c'), true);
  healthy = true; await ui.submitLifecycle(); assert.equal(posts, 1); assert.equal(ui.dialog, null); assert.equal(ui.cards.has('c'), false); assert.match(ui.noticeText.textContent, /已永久删除/);
});

test('menus and dialogs support Escape, focus return, tab trapping and tab arrow navigation', async t => {
  const { ui, document } = mounted(t, [summary('b', 'archived')]); await ui.load(); ui.selectLifecycle('trashed'); const more = ui.cards.get('b').more; more.focus(); more.emit('click'); const first = ui.menu.children[0], second = ui.menu.children[1]; assert.equal(document.activeElement, first);
  ui.menu.emit('keydown', { key: 'ArrowDown' }); assert.equal(document.activeElement, second); ui.root.emit('keydown', { key: 'Escape' }); assert.equal(ui.menu.hidden, true); assert.equal(document.activeElement, more);
  ui.openLifecycleDialog('b', 'restore', more); assert.equal(document.activeElement, ui.dialog.cancel); ui.dialog.overlay.emit('keydown', { key: 'Tab', shiftKey: true }); assert.equal(document.activeElement, ui.dialog.submit); ui.dialog.overlay.emit('keydown', { key: 'Escape' }); assert.equal(ui.dialog, null); assert.equal(document.activeElement, more);
  ui.lifecycleTabs.get('trashed').tab.emit('keydown', { key: 'ArrowRight' }); assert.equal(ui.lifecycle, 'active'); assert.equal(document.activeElement, ui.lifecycleTabs.get('active').tab);
});

test('lifecycle events invalidate a pending read and unknown lifecycle data cannot hide a workflow silently', async t => {
  const { ui } = mounted(t, [summary('a', 'active')]); await ui.load(); const read = deferred(); ui.api = () => read.promise; const loading = ui.load(); ui.handleEvent({ type: 'workflow.lifecycle', payload: { workflow: summary('a', 'trashed', { revision: 5 }) } }); read.resolve({ workflows: [summary('a', 'active')] }); await loading; assert.equal(ui.reloadNeeded, true); assert.equal(ui.workflows[0].lifecycle, 'active');
  ui.api = async () => ({ workflows: [summary('a', 'unexpected')] }); await ui.load(); assert.match(ui.noticeText.textContent, /格式不正确/); assert.equal(ui.workflows[0].lifecycle, 'active');
});

test('toolbar clearing stays available for a matching search and restores every workflow in the current tab', async t => {
  const { ui, document, calls } = mounted(t, [summary('a', 'active', { title: '归档与回收站 · 功能验收' }), summary('b', 'active'), summary('c', 'archived')]); await ui.load();
  assert.equal(ui.clearFilterButton.hidden, true); ui.search.value = '归档与回收站 · 功能验收'; ui.search.emit('input');
  assert.equal(ui.empty.hidden, true); assert.equal(ui.clearFilterButton.hidden, false); assert.equal(ui.filterContext.hidden, false); assert.match(ui.filterHint.textContent, /当前筛选：搜索“归档与回收站 · 功能验收”/); assert.equal(ui.cards.get('a').card.hidden, false); assert.equal(ui.cards.get('b').card.hidden, true);
  ui.clearFilterButton.emit('click'); assert.equal(ui.search.value, ''); assert.equal(ui.filter.value, 'all'); assert.equal(ui.lifecycle, 'active'); assert.equal(ui.cards.get('b').card.hidden, false); assert.equal(ui.cards.get('c').card.hidden, true); assert.equal(ui.clearFilterButton.hidden, true); assert.equal(document.activeElement, ui.search); assert.equal(calls.length, 1);
});

test('toolbar clearing resets a state-only filter and keeps trash tab selection', async t => {
  const { ui } = mounted(t, [summary('a', 'active'), summary('b', 'active', { state: 'draft' }), summary('c', 'archived'), summary('d', 'trashed')]); await ui.load();
  ui.filter.value = 'draft'; ui.filter.emit('change'); assert.equal(ui.clearFilterButton.hidden, false); assert.match(ui.filterHint.textContent, /状态：待完善/); ui.clearFilterButton.emit('click'); assert.equal(ui.cards.get('a').card.hidden, false); assert.equal(ui.filter.value, 'all');
  for (const lifecycle of ['trashed']) { ui.selectLifecycle(lifecycle); ui.search.value = '流程'; ui.filter.value = 'ready'; ui.search.emit('input'); assert.equal(ui.clearFilterButton.hidden, false); ui.clearFilterButton.emit('click'); assert.equal(ui.lifecycle, lifecycle); assert.equal(ui.search.value, ''); assert.equal(ui.filter.value, 'all'); assert.equal(ui.clearFilterButton.hidden, true); }
});
