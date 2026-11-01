import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolApprovalsUI } from '../public/tool-approvals-ui.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.textContent = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const request = (owner = 'supervisor-one', extra = {}) => ({ id: 'tool-approval-one', owner, turnId: 'turn-one', revision: 1, status: 'pending', title: 'Write once', details: { content: 'fixture' }, ...extra });
function fixture(t, rows = [request()]) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'); Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: tag => new Element(tag) } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document);
  const states = new Map(), calls = [], loads = [];
  const state = owner => { if (!states.has(owner)) states.set(owner, { conversation: { lifecycle: 'active', readOnly: false, turns: [{ id: 'turn-one', status: 'thinking' }] }, toolRequests: rows.filter(row => row.owner === owner) }); return states.get(owner); };
  const chat = { workflowId: 'supervisor-one', state, async api(path, options) { calls.push({ path, options }); return {}; }, async load(force) { loads.push({ owner: chat.workflowId, force }); } };
  const ui = new ToolApprovalsUI(chat); ui.render();
  return { chat, ui, calls, loads, state, buttons: () => descendants(ui.host).filter(node => node.tagName === 'button') };
}

test('approval cards are owner-local text and only explicit clicks submit exact revisions', async t => {
  const f = fixture(t, [request('supervisor-one', { details: { note: '<img src=x onerror=alert(1)>' } }), request('supervisor-other')]);
  assert.equal(f.ui.host.children.length, 1); assert.equal(f.calls.length, 0);
  assert(descendants(f.ui.host).some(node => node.tagName === 'pre' && node.textContent.includes('<img src=x'))); assert.equal(descendants(f.ui.host).filter(node => node.tagName === 'img').length, 0);
  await f.buttons()[0].listeners.click();
  assert.deepEqual(f.calls, [{ path: '/api/tool-approvals/supervisor-one/tool-approval-one', options: { method: 'POST', body: { expectedRevision: 1, choice: 'once' } } }]);
  assert.equal(f.ui.host.hidden, true);
});

test('switching topics invalidates a cached card click without leaking its approval', async t => {
  const f = fixture(t), stale = f.buttons()[0]; f.chat.workflowId = 'supervisor-other'; f.ui.render();
  await stale.listeners.click(); assert.equal(f.calls.length, 0); assert.equal(f.ui.host.hidden, true);
});

test('archived read-only and ended human turns disable pending approvals', async t => {
  for (const change of [state => { state.conversation.lifecycle = 'archived'; }, state => { state.conversation.readOnly = true; }, state => { state.conversation.turns[0].status = 'done'; }]) {
    const f = fixture(t); change(f.state('supervisor-one')); f.ui.render();
    for (const button of f.buttons()) { assert.equal(button.disabled, true); await button.listeners.click(); }
    assert.equal(f.calls.length, 0);
  }
});

test('a request removed by SSE cannot be approved through its detached old card', async t => {
  const f = fixture(t), stale = f.buttons()[0]; f.state('supervisor-one').toolRequests = []; f.ui.render();
  await stale.listeners.click(); assert.equal(f.calls.length, 0);
});

test('double click admits one POST and a late reply cannot load the newly selected topic', async t => {
  const f = fixture(t), pending = deferred(), approve = f.buttons()[0];
  f.chat.api = (path, options) => { f.calls.push({ path, options }); return pending.promise; };
  const first = approve.listeners.click(); await approve.listeners.click(); assert.equal(f.calls.length, 1);
  f.chat.workflowId = 'supervisor-other'; f.ui.render(); pending.resolve({}); await first; assert.deepEqual(f.loads, []);
});

test('a revised pending request submits its current revision and cannot reuse an older closure', async t => {
  const f = fixture(t), old = f.buttons()[0]; f.state('supervisor-one').toolRequests = [request('supervisor-one', { revision: 2 })]; f.ui.render();
  await old.listeners.click(); assert.equal(f.calls.length, 0, 'old displayed version must no longer authorize');
  await f.buttons()[0].listeners.click(); assert.equal(f.calls[0].options.body.expectedRevision, 2);
});

test('a workflow-run approval can be answered without inventing a chat turn', async t => {
  const f = fixture(t, [request('workflow-one', { turnId: undefined, runId: 'run-one' })]); f.chat.workflowId = 'workflow-one'; f.state('workflow-one').conversation.turns = []; f.ui.render();
  assert.equal(f.ui.host.children.length, 1); await f.buttons()[1].listeners.click(); assert.equal(f.calls[0].options.body.choice, 'deny');
});
