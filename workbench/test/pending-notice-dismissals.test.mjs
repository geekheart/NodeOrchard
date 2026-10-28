import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingNoticeDismissals, pendingNoticeKey, requestNoticeKey } from '../public/pending-notice-dismissals.js';

function fixture() {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  return { values, options: { storage: () => storage } };
}
test('hidden notices survive reloads, stay scoped, restore individually and never change source objects', () => {
  const { values, options } = fixture(), request = { id: 'one', sessionId: 'session', method: 'approval', params: { command: 'PRIVATE_BODY' } };
  const before = structuredClone(request), key = requestNoticeKey(request), store = new PendingNoticeDismissals('one', options);
  store.hide([key]);
  assert.equal(new PendingNoticeDismissals('one', options).isHidden(key), true);
  assert.equal(new PendingNoticeDismissals('two', options).isHidden(key), false);
  assert.equal(JSON.stringify([...values]).includes('PRIVATE_BODY'), false); assert.deepEqual(request, before);
  store.restore([key]); assert.equal(new PendingNoticeDismissals('one', options).isHidden(key), false);
});
test('new requests, review versions and artifact hashes produce independent notice identities', () => {
  const base = pendingNoticeKey('review', 'run', 'node', 1, { a: 'first', b: 'second' });
  assert.equal(base, pendingNoticeKey('review', 'run', 'node', 1, { b: 'second', a: 'first' }));
  for (const key of [pendingNoticeKey('review', 'run', 'node', 2, { a: 'first', b: 'second' }), pendingNoticeKey('review', 'run', 'node', 1, { a: 'new', b: 'second' }), pendingNoticeKey('review', 'other-run', 'node', 1, { a: 'first', b: 'second' })]) assert.notEqual(key, base);
  assert.notEqual(requestNoticeKey({ id: 'one', sessionId: 's' }), requestNoticeKey({ id: 'two', sessionId: 's' }));
  assert.notEqual(requestNoticeKey({ id: 'one', sessionId: 's', params: { session_id: 'native-one' } }), requestNoticeKey({ id: 'one', sessionId: 's', params: { session_id: 'native-two' } }));
});
test('unavailable storage keeps closing and restoring usable in memory', () => {
  const store = new PendingNoticeDismissals('one', { storage() { throw Error('unavailable'); } });
  store.hide(['a']); assert.equal(store.isHidden('a'), true); store.restore(['a']); assert.equal(store.isHidden('a'), false);
  const missing = new PendingNoticeDismissals('missing', { storage: () => undefined });
  missing.hide(['a']); assert.equal(missing.isHidden('a'), true); missing.restore(['a']); assert.equal(missing.isHidden('a'), false);
});
test('preferences remain bounded and existing views see updates made by another view', () => {
  const { values, options } = fixture(), first = new PendingNoticeDismissals('one', options), second = new PendingNoticeDismissals('one', options);
  first.hide(Array.from({ length: 300 }, (_, index) => 'key-' + index));
  assert.equal(second.isHidden('key-299'), true); assert.equal(second.isHidden('key-0'), false);
  assert.equal(JSON.parse([...values.values()][0]).length, 256);
  second.restore(['key-299']); assert.equal(first.isHidden('key-299'), false);
});
