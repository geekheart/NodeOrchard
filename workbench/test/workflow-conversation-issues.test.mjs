import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationTurnGroups } from '../public/workflow-conversation-ui.js';
import { projectConversationIssues, canRetryConversationTurn } from '../shared/workflow/workflow-conversation-issues.mjs';

const failure = (id, overrides = {}) => ({ id, workflowId: 'wf', status: 'error', user: { text: '检查失败原因', context: { runId: 'old-run', nodeId: 'node', attempt: 1, attemptId: 'attempt-one' } }, assistant: { text: '原始超时' }, ...overrides });
const retry = (id, parent, status = 'complete') => ({ ...failure(id), retryOfTurnId: parent, status });

test('a confirmed finished historical issue exits pending while its error remains in history', () => {
  const old = { id: 'old', status: 'error', assistant: { text: '原始超时' }, pendingState: { status: 'superseded', label: '已由后续重试接续' } };
  const next = { id: 'next', status: 'complete' }, groups = conversationTurnGroups([old, next]);
  assert.deepEqual(groups.unresolved, []);
  assert.equal(groups.history[0].assistant.text, '原始超时');
  assert.equal(groups.history[0].status, 'error');
});

test('successful explicit retry closes the failure chain without changing original history or business state', () => {
  const turns = [failure('a'), retry('b', 'a', 'error'), retry('c', 'b')], before = JSON.stringify(turns);
  const result = projectConversationIssues(turns);
  assert.equal(JSON.stringify(turns), before);
  assert.deepEqual(conversationTurnGroups(result).unresolved, []);
  assert.equal(result[0].status, 'error'); assert.equal(result[0].assistant.text, '原始超时');
  assert.equal(result[0].pendingState.byTurnId, 'c'); assert.equal(result[1].pendingState.byTurnId, 'c');
  assert.equal(Object.hasOwn(result[0].pendingState, 'businessResolved'), false);
});

test('an unrelated success or an unsuccessful retry cannot silently resolve another issue', () => {
  for (const next of [failure('b', { status: 'complete' }), retry('b', 'a', 'error'), retry('b', 'a', 'interrupted'), retry('b', 'a', 'thinking')]) {
    const result = projectConversationIssues([failure('a'), next]);
    assert.equal(result[0].pendingState, undefined);
    assert.ok(conversationTurnGroups(result).unresolved.some(turn => turn.id === 'a'));
  }
});

test('a replacement proposal closes only the old model failure and still requires user application', () => {
  const result = projectConversationIssues([failure('a'), retry('b', 'a', 'proposed')]);
  assert.deepEqual(conversationTurnGroups(result).unresolved.map(turn => turn.id), ['b']);
  assert.equal(result[1].outcome, undefined);
});

test('retry links cannot cross text, context, workflow, ordering or uncertain operation boundaries', () => {
  const candidates = [
    { ...retry('b', 'a'), user: { text: '无关的问题', context: failure('a').user.context } },
    { ...retry('b', 'a'), user: { text: failure('a').user.text, context: { runId: 'different-run' } } },
    { ...retry('b', 'a'), workflowId: 'another-workflow' },
    { ...retry('b', 'b') },
  ];
  for (const next of candidates) assert.equal(projectConversationIssues([failure('a'), next])[0].pendingState, undefined);
  assert.equal(projectConversationIssues([retry('b', 'a'), failure('a')])[1].pendingState, undefined);
  const uncertain = failure('a', { outcome: { action: 'rerun', status: 'unknown' } });
  assert.equal(canRetryConversationTurn(uncertain), false);
  assert.equal(projectConversationIssues([uncertain, retry('b', 'a')])[0].pendingState, undefined);
});

test('only confirmed processing of every exact review identity closes an old review choice', () => {
  const context = failure('a').user.context, turn = failure('review', { status: 'awaiting_action', actions: [
    { kind: 'review-approve', context }, { kind: 'review-stop', context: { ...context, nodeId: 'other-node' } },
  ] });
  assert.equal(canRetryConversationTurn(turn), false);
  const resolved = projectConversationIssues([turn], { reviewState: () => 'resolved' });
  assert.equal(conversationTurnGroups(resolved).unresolved.length, 0);
  assert.equal(resolved[0].status, 'awaiting_action');
  for (const reviewState of [() => 'pending', () => 'unknown', () => { throw Error('offline'); }]) {
    assert.equal(conversationTurnGroups(projectConversationIssues([turn], { reviewState })).unresolved.length, 1);
  }
  const partial = projectConversationIssues([turn], { reviewState: ctx => ctx.nodeId === 'node' ? 'resolved' : 'unknown' });
  assert.equal(partial[0].pendingState.status, 'unknown');
  const incomplete = { ...turn, actions: [{ kind: 'review-approve', context: { runId: 'old-run' } }] };
  assert.equal(conversationTurnGroups(projectConversationIssues([incomplete], { reviewState: () => 'resolved' })).unresolved.length, 1);
});

test('a stored or stale client-facing projection cannot override current review evidence', () => {
  const turn = failure('a', { pendingState: { status: 'resolved' } });
  const result = projectConversationIssues([turn]);
  assert.equal(result[0].pendingState, undefined);
  assert.equal(conversationTurnGroups(result).unresolved.length, 1);
});
