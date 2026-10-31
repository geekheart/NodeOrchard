import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationReferencesUI } from '../public/conversation-references-ui.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.textContent = ''; this.disabled = false; this.hidden = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
}
const nodes = node => [node, ...node.children.flatMap(nodes)];
const reference = (n = 1, extra = {}) => ({ workflowId: 'workflow-a', workflowTitle: '工作流 A', turnId: 'turn-' + n,
  updatedAt: '2026-10-31T10:00:00.000Z', sourceDigest: 'sha256:' + String(n).padStart(64, '0'), sourceStatus: 'error', status: 'current', preview: '第' + n + '次失败', ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, api = async () => ({ workflows: [{ workflowId: 'workflow-a', title: '工作流 A' }] })) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: tag => new Element(tag) } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document);
  const calls = [], states = new Map();
  const owner = { workflowId: 'supervisor-a', editor: { libraryReadOnly: false }, api: async (path, options) => { calls.push({ path, options }); return api(path, options); },
    state(id = owner.workflowId) { if (!states.has(id)) states.set(id, { conversation: { workflowId: id, lifecycle: 'active' }, draft: id + ' 的草稿', attachmentDrafts: [{ name: id + '.png' }] }); return states.get(id); },
    clearRetryTarget(state) { state.retryOfTurnId = null; }, updateSendButton() {} };
  const ui = new ConversationReferencesUI(owner), host = new Element('div'); ui.mount(host);
  return { ui, owner, host, calls, states };
}

test('the picker mounts quietly and only performs manual GETs for active workflow and precise message choices', async t => {
  const f = fixture(t, async path => path.includes('?workflowId=')
    ? { workflow: { workflowId: 'workflow-a' }, turns: [reference()], hasMore: false }
    : { workflows: [{ workflowId: 'workflow-a', title: '工作流 A' }] });
  assert.equal(f.calls.length, 0); assert.equal(f.host.children[0], f.ui.element);
  await f.ui.open(); assert.equal(f.calls[0].path, '/api/app-assistant/references');
  const select = nodes(f.ui.element).find(node => node.tagName === 'select'); select.value = 'workflow-a'; select.listeners.change(); await flush();
  const choose = nodes(f.ui.element).find(node => node.attributes['aria-label'] === '引用消息：第1次失败');
  assert(choose); choose.listeners.click();
  assert.deepEqual(f.ui.references(), [{ workflowId: 'workflow-a', turnId: 'turn-1', updatedAt: reference().updatedAt, sourceDigest: reference().sourceDigest }]);
  assert(f.calls.every(call => call.options === undefined));
  assert.equal(f.owner.state().draft, 'supervisor-a 的草稿'); assert.equal(f.owner.state().attachmentDrafts[0].name, 'supervisor-a.png');
});

test('reference drafts have a maximum of four and a reselected message replaces only that reference version', t => {
  const f = fixture(t), state = f.owner.state();
  for (let index = 1; index <= 4; index++) assert.equal(f.ui.add(reference(index)), true);
  assert.equal(f.ui.add(reference(5)), false); assert.match(f.ui.picker().error, /最多引用4条/);
  assert.equal(f.ui.add(reference(1, { sourceDigest: 'sha256:' + 'f'.repeat(64) })), true);
  assert.equal(f.ui.entries().length, 4); assert.equal(f.ui.references()[0].sourceDigest, 'sha256:' + 'f'.repeat(64));
  assert.equal(f.ui.references()[0].preview, undefined); assert.equal(f.ui.references()[0].read, undefined);
  const first = f.ui.entries()[0]; assert.equal(f.ui.remove(first), true); assert.equal(f.ui.entries().length, 3); assert.equal(state.draft, 'supervisor-a 的草稿');
});

test('opening cached options does not repeatedly fetch or put complete transcripts into draft references', async t => {
  const f = fixture(t); await f.ui.open(); await f.ui.open(); await f.ui.open();
  assert.equal(f.calls.length, 1);
  f.ui.add(reference(1, { assistant: { text: 'PRIVATE_BODY' }, privateValue: 'PRIVATE_VALUE', read: { tool: 'shell' } }));
  assert.equal(JSON.stringify(f.ui.references()).includes('PRIVATE'), false);
});

test('pagination uses the delivered source cursor and merges only the selected workflow without duplicates', async t => {
  const f = fixture(t, async path => path.includes('beforeTurnId=')
    ? { workflow: { workflowId: 'workflow-a' }, turns: [reference(1), reference(2)], hasMore: false }
    : { workflow: { workflowId: 'workflow-a' }, turns: [reference(2), reference(3)], hasMore: true, nextBeforeTurnId: 'turn-2' });
  const captured = f.ui.capture(); await f.ui.load(captured, { workflowId: 'workflow-a' });
  await f.ui.load(captured, { workflowId: 'workflow-a', beforeTurnId: f.ui.picker().nextBeforeTurnId });
  assert.equal(f.calls[1].path, '/api/app-assistant/references?workflowId=workflow-a&beforeTurnId=turn-2');
  assert.deepEqual(f.ui.picker().turns.map(value => value.turnId), ['turn-1', 'turn-2', 'turn-3']); assert.equal(f.ui.picker().hasMore, false);
});

test('late workflow-selection reads cannot replace a newer selection in the same topic', async t => {
  const first = deferred(), second = deferred();
  const f = fixture(t, path => path.includes('workflow-a') ? first.promise : second.promise), captured = f.ui.capture();
  const a = f.ui.load(captured, { workflowId: 'workflow-a' }), b = f.ui.load(captured, { workflowId: 'workflow-b' });
  second.resolve({ workflow: { workflowId: 'workflow-b' }, turns: [reference(2, { workflowId: 'workflow-b', workflowTitle: '工作流 B' })] }); await b;
  first.resolve({ workflow: { workflowId: 'workflow-a' }, turns: [reference()] }); await a;
  assert.equal(f.ui.picker().workflowId, 'workflow-b'); assert.equal(f.ui.picker().turns[0].workflowId, 'workflow-b');
});

test('late requests stay with their original topic, while stale choice/remove callbacks cannot alter the new draft', async t => {
  const pending = deferred(), f = fixture(t, () => pending.promise), captured = f.ui.capture(), old = captured.state;
  f.ui.add(reference(), captured); const oldReference = f.ui.entries(old)[0];
  const loading = f.ui.load(captured, { workflowId: 'workflow-a' });
  f.owner.workflowId = 'supervisor-b'; const current = f.owner.state(); f.ui.render();
  assert.equal(f.ui.add(reference(2), captured), false); assert.equal(f.ui.remove(oldReference, captured), false);
  pending.resolve({ workflow: { workflowId: 'workflow-a' }, turns: [reference(3)] }); await loading;
  assert.equal(current.conversationReferences.length, 0); assert.equal(current.draft, 'supervisor-b 的草稿');
  assert.equal(f.owner.workflowId, 'supervisor-b'); assert.equal(f.ui.picker(old).turns[0].turnId, 'turn-3');
  f.ui.add(reference(4)); assert.equal(f.ui.entries(current)[0].turnId, 'turn-4'); assert.equal(f.ui.entries(old)[0].turnId, 'turn-1');
});

test('archived topics show saved references but disable picker, removal, restore and late additions', async t => {
  const pending = deferred(), f = fixture(t, () => pending.promise), state = f.owner.state();
  f.ui.add(reference()); const captured = f.ui.capture(), loading = f.ui.load(captured, { workflowId: 'workflow-a' });
  state.conversation.lifecycle = 'archived'; f.ui.render();
  assert(nodes(f.ui.element).filter(node => node.tagName === 'button').every(node => node.disabled));
  assert.equal(await f.ui.open(), false); assert.equal(f.ui.add(reference(2), captured), false); assert.equal(f.ui.remove(f.ui.entries()[0], captured), false);
  assert.equal(f.ui.restore({ user: { conversationReferences: [reference(3)] } }, state), false);
  pending.resolve({ workflow: { workflowId: 'workflow-a' }, turns: [reference(2)] }); assert.equal(await loading, false);
  assert.equal(f.ui.entries()[0].turnId, 'turn-1');
});

test('consuming a confirmed request removes only its unchanged entries and keeps later additions, reselections and source versions', t => {
  const f = fixture(t), state = f.owner.state(); f.ui.add(reference(1)); f.ui.add(reference(2)); f.ui.add(reference(3));
  const request = { conversationReferences: f.ui.references(state) }, second = f.ui.entries()[1];
  f.ui.remove(second); f.ui.add(reference(2));
  f.ui.entries().find(value => value.turnId === 'turn-3').sourceDigest = 'sha256:' + 'e'.repeat(64);
  f.ui.add(reference(4)); f.ui.consume(state, request);
  assert.deepEqual(f.ui.entries().map(value => value.turnId), ['turn-3', 'turn-2', 'turn-4']);
  assert.equal(state.draft, 'supervisor-a 的草稿'); assert.equal(state.attachmentDrafts.length, 1);
});

test('unknown message responses keep reference drafts and tracked retry requests reuse the same selected identities', t => {
  const f = fixture(t), state = f.owner.state(); f.ui.add(reference(1));
  const request = { clientMessageId: 'same-id', conversationReferences: f.ui.references() };
  assert.equal(f.ui.entries().length, 1); f.ui.trackRequest(state, request); f.ui.add(reference(2));
  f.ui.trackRequest(state, request); assert.equal(f.ui.entries().length, 2);
  f.ui.consume(state, request); assert.deepEqual(f.ui.entries().map(value => value.turnId), ['turn-2']); assert.equal(request.clientMessageId, 'same-id');
});

test('restoring a saved reference selection preserves draft text and renders only fixed source links and message metadata', t => {
  const f = fixture(t), stored = [reference(1, { workflowTitle: '<img src=x onerror=alert(1)>', preview: 'PRIVATE_SOURCE_BODY', read: { url: 'javascript:alert(1)' } }), reference(2, { status: 'stale' })];
  f.ui.restore({ user: { conversationReferences: stored } });
  const view = f.ui.messageView(stored), links = nodes(view).filter(node => node.tagName === 'a');
  assert.equal(links.length, 2); assert(links.every(link => link.href === '#/workflows/workflow-a'));
  assert.equal(nodes(view).some(node => node.tagName === 'img'), false); assert.equal(nodes(view).map(node => node.textContent).join('').includes('PRIVATE_SOURCE_BODY'), false);
  assert.match(links[1].textContent, /来源已变化/); assert.equal(f.owner.state().draft, 'supervisor-a 的草稿');
  assert.equal(f.ui.messageView(null).children.length, 0);
});

test('malformed foreign picker replies are rejected, rendered errors are bounded, and no source is added or navigated', async t => {
  const f = fixture(t, async () => ({ workflow: { workflowId: 'workflow-b' }, turns: [reference(2)] }));
  assert.equal(await f.ui.load(f.ui.capture(), { workflowId: 'workflow-a' }), false);
  assert.match(f.ui.picker().error, /不匹配/); assert.equal(f.ui.entries().length, 0); assert.equal(f.owner.workflowId, 'supervisor-a');
  assert.equal(f.ui.add(reference(1, { workflowId: 'javascript:alert(1)' })), false);
});
