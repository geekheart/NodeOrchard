import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SupervisorSessions, boundedSupervisorHistory } from '../src/supervisor-sessions.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:'), topics = new Map([['topic-one', { lifecycle: 'active', readOnly: false }], ['topic-two', { lifecycle: 'active', readOnly: false }]]);
  let tick = 0;
  const options = { db, readConversation: id => topics.get(id), now: () => new Date(1900000000000 + tick++).toISOString() };
  const service = new SupervisorSessions(options);
  t.after(() => db.close());
  return { service, db, topics, options };
}
const route = { provider: 'configured-provider', model: 'configured-model' };
const claim = (service, id = 'topic-one', turnId = 'turn-one', requestId = 'request-one') => service.begin(id, { expectedRevision: service.get(id)?.revision || 0, turnId, requestId, modelRoute: route });
const bind = (service, claim, extra = {}) => service.bind(claim.conversationId, { expectedRevision: claim.revision, turnId: claim.activeTurnId, storedSessionId: 'stored-one', runtimeSessionId: 'runtime-one', modelRoute: route, ...extra });

test('each supervisor topic retains its native session across consecutive human turns', t => {
  const { service } = fixture(t);
  assert.equal(service.get('topic-one'), null);
  const first = claim(service), binding = bind(service, first);
  assert.equal(binding.activeTurnId, 'turn-one');
  service.finish('topic-one', { turnId: 'turn-one', requestId: 'request-one', status: 'complete' });
  const next = claim(service, 'topic-one', 'turn-two', 'request-two');
  assert.equal(next.storedSessionId, 'stored-one'); assert.equal(next.runtimeSessionId, 'runtime-one');
  assert.deepEqual(next.modelRoute, route); assert.equal(next.activeTurnId, 'turn-two');
  assert.equal(service.get('topic-two'), null);
  service.finish('topic-one', { turnId: 'turn-two', status: 'complete' });
  assert.equal(service.get('topic-one').lastTurnId, 'turn-two');
});

test('stale versions and concurrent turns cannot take over a native supervisor session', t => {
  const { service } = fixture(t), first = claim(service);
  assert.throws(() => service.begin('topic-one', { expectedRevision: 0, turnId: 'another', requestId: 'another', modelRoute: route }), /版本|进行/);
  assert.throws(() => service.begin('topic-one', { expectedRevision: first.revision, turnId: 'another', requestId: 'another', modelRoute: route }), /进行/);
  assert.throws(() => service.bind('topic-one', { expectedRevision: first.revision, turnId: 'another', storedSessionId: 'stored-one', runtimeSessionId: 'runtime-one', modelRoute: route }), /轮次/);
  assert.throws(() => service.finish('topic-one', { turnId: 'another', status: 'complete' }), /轮次/);
  assert.throws(() => service.finish('topic-one', { turnId: 'turn-one', requestId: 'wrong-request', status: 'complete' }), /轮次/);
  assert.equal(service.get('topic-one').activeTurnId, 'turn-one');
});

test('different topics cannot share stored native history and the route stays pinned', t => {
  const { service } = fixture(t); const one = bind(service, claim(service));
  service.finish('topic-one', { turnId: one.activeTurnId, status: 'complete' });
  const two = claim(service, 'topic-two', 'turn-two', 'request-two');
  assert.throws(() => bind(service, two), /其它总控/);
  assert.throws(() => service.begin('topic-one', { expectedRevision: service.get('topic-one').revision, turnId: 'next-turn', requestId: 'next-request', modelRoute: { ...route, model: 'new-default' } }), /模型/);
  assert.deepEqual(service.get('topic-one').modelRoute, route);
});

test('completed or interrupted old requests remain non-replayable after newer turns', t => {
  const { service } = fixture(t); claim(service);
  service.finish('topic-one', { turnId: 'turn-one', status: 'interrupted' });
  claim(service, 'topic-one', 'turn-two', 'request-two');
  service.finish('topic-one', { turnId: 'turn-two', status: 'complete' });
  for (const identity of [{ turnId: 'turn-one', requestId: 'brand-new-request' }, { turnId: 'new-turn', requestId: 'request-one' }]) {
    assert.throws(() => service.begin('topic-one', { expectedRevision: service.get('topic-one').revision, modelRoute: route, ...identity }), /已经.*登记|重放/);
  }
  assert.equal(service.get('topic-one').activeTurnId, null);
});

test('native compaction may replace its persistent identity only with the expected predecessor', t => {
  const { service } = fixture(t); let current = bind(service, claim(service));
  assert.throws(() => bind(service, current, { storedSessionId: 'compressed-session' }), /原会话/);
  current = bind(service, current, { storedSessionId: 'compressed-session', previousStoredSessionId: 'stored-one', runtimeSessionId: 'runtime-compressed' });
  assert.equal(current.storedSessionId, 'compressed-session'); assert.equal(current.previousStoredSessionId, 'stored-one');
  assert.throws(() => bind(service, current, { storedSessionId: 'next-session', previousStoredSessionId: 'stored-one' }), /原会话/);
});

test('restart interrupts an active turn without replaying it and retains stored history identity', t => {
  const { service, options } = fixture(t); bind(service, claim(service));
  const restarted = new SupervisorSessions(options), restored = restarted.get('topic-one');
  assert.equal(restored.activeTurnId, null); assert.equal(restored.runtimeSessionId, null);
  assert.equal(restored.storedSessionId, 'stored-one'); assert.equal(restored.status, 'interrupted');
  assert.equal(restored.lastTurnId, 'turn-one'); assert.equal(restored.lastRequestId, 'request-one');
  assert.equal(restored.interruptionReason, 'runtime-restart');
  assert.throws(() => restarted.finish('topic-one', { turnId: 'turn-one', status: 'complete' }), /轮次/);
});

test('disconnect clears a live runtime and never invents a completed result', t => {
  const { service } = fixture(t); bind(service, claim(service)); service.disconnect();
  const current = service.get('topic-one'); assert.equal(current.runtimeSessionId, null);
  assert.equal(current.status, 'interrupted'); assert.equal(current.storedSessionId, 'stored-one');
  assert.equal(current.interruptionReason, 'runtime-disconnected');
});

test('archived or source-bound read-only conversations cannot admit native execution', t => {
  const { service, topics } = fixture(t);
  topics.set('topic-one', { lifecycle: 'archived', readOnly: false });
  assert.throws(() => claim(service), /归档/);
  topics.set('topic-one', { lifecycle: 'active', readOnly: true });
  assert.throws(() => claim(service), /只读/);
  topics.set('topic-one', { lifecycle: 'active', readOnly: false });
  const current = bind(service, claim(service));
  assert.throws(() => service.archive('topic-one', { expectedRevision: current.revision }), /进行/);
  service.finish('topic-one', { turnId: current.activeTurnId, status: 'complete' });
  topics.set('topic-one', { lifecycle: 'archived', readOnly: false });
  const archived = service.archive('topic-one', { expectedRevision: service.get('topic-one').revision });
  assert.equal(archived.runtimeSessionId, null); assert.equal(archived.storedSessionId, 'stored-one');
  assert.equal(archived.archived, true);
  topics.set('topic-one', { lifecycle: 'active', readOnly: false });
  const resumed = claim(service, 'topic-one', 'restored-turn', 'restored-request');
  assert.equal(resumed.storedSessionId, 'stored-one'); assert.equal(resumed.archived, false);
});

test('old chat history is imported as bounded read-only data without actions, scopes, or hidden reasoning', () => {
  const turns = Array.from({ length: 20 }, (_, i) => ({ id: 'old-' + i, user: { text: '旧消息' + i + 'x'.repeat(5000), context: { permissions: { sourceRepair: true } } },
    assistant: { text: '旧回答' + i, reasoning: 'private-thoughts', operations: [{ kind: 'delete' }] }, actions: [{ action: 'run' }] }));
  const snapshot = structuredClone(turns), history = boundedSupervisorHistory(turns);
  assert.equal(history.readOnly, true); assert.equal(history.kind, 'historical-data'); assert.equal(history.authorizationRestored, false);
  assert(history.characters <= 12000); assert(history.messages.length <= 12); assert.equal(history.truncated, true);
  assert.match(history.sha256, /^sha256:[a-f0-9]{64}$/);
  assert(history.messages.at(-1).text.includes('旧回答19'));
  const serialized = JSON.stringify(history); assert(!serialized.includes('sourceRepair')); assert(!serialized.includes('private-thoughts')); assert(!serialized.includes('operations'));
  assert.deepEqual(turns, snapshot);
});
