import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConversationIssueResolution, selectConversationIssue } from '../shared/workflow/workflow-conversation-issues.mjs';

const issue = (id, runId = 'run-a') => ({ id, workflowId: 'wf', status: 'error', user: { text: '原始问题 ' + id, context: { runId } }, assistant: { text: '原始报错' } });

test('only complete affirmative statements are local issue-resolution commands', () => {
  for (const text of ['这个问题解决了', '这个问题已经解决了。', '问题已解决', '已处理', '处理好了']) {
    assert.deepEqual(parseConversationIssueResolution(text), { disposition: 'handled' }, text);
  }
  for (const text of ['不用处理了', '这个问题不用再处理了！', '不再处理了']) {
    assert.deepEqual(parseConversationIssueResolution(text), { disposition: 'dismissed' }, text);
  }
  for (const text of ['这个问题解决了吗', '这个问题解决了？', '不用处理了吗？', '不要结束', '还没解决', '如果这个问题解决了怎么办',
    '他说这个问题解决了', '“这个问题解决了”是什么意思', '这个问题解决了，但还有别的要求', '`不用处理了`', '']) {
    assert.equal(parseConversationIssueResolution(text), null, text);
  }
});

test('ordinal commands carry no implicit permission to select a dynamically ordered target', () => {
  assert.deepEqual(parseConversationIssueResolution('第一个'), { ordinal: 1 });
  assert.deepEqual(parseConversationIssueResolution('第2个问题解决了'), { ordinal: 2, disposition: 'handled' });
  assert.deepEqual(parseConversationIssueResolution('第十项不用处理了'), { ordinal: 10, disposition: 'dismissed' });
  assert.equal(parseConversationIssueResolution('第0个不用处理了'), null);
  const result = selectConversationIssue([issue('a'), issue('b')], { ordinal: 1 });
  assert.equal(result.status, 'choose');
});

test('selection uses an explicit issue or a unique matching scope and otherwise asks', () => {
  const a = issue('a'), b = issue('b', 'run-b');
  assert.equal(selectConversationIssue([a], {}).turn.id, 'a');
  assert.equal(selectConversationIssue([a, b], { targetTurnId: 'a' }).turn.id, 'a');
  assert.equal(selectConversationIssue([a, b], { context: { runId: 'run-b' } }).turn.id, 'b');
  assert.equal(selectConversationIssue([a, b]).status, 'choose');
  assert.equal(selectConversationIssue([a], { context: { runId: 'unrelated-run' } }).status, 'choose');
  assert.equal(selectConversationIssue([a], { targetTurnId: 'cross-conversation-id' }).reason, 'target-missing');
  const artifact = { ...a, user: { ...a.user, context: { runId: 'run-a', artifactIds: ['file-a'] } } };
  assert.equal(selectConversationIssue([artifact], { context: { runId: 'run-a', artifactIds: ['file-b'] } }).status, 'choose');
  assert.equal(selectConversationIssue([artifact], { context: { runId: 'run-a', artifactIds: ['file-a'] } }).turn.id, 'a');
});

test('frozen numbering never shifts onto a different issue after the chosen target has closed', () => {
  const a = issue('a'), b = issue('b', 'run-b'), ids = ['a', 'b'];
  assert.equal(selectConversationIssue([a, b], { ordinal: 2, candidateIds: ids }).turn.id, 'b');
  const closed = { ...a, status: 'dismissed' };
  assert.equal(selectConversationIssue([closed, b], { ordinal: 1, candidateIds: ids }).reason, 'already-closed');
  assert.equal(selectConversationIssue([b], { ordinal: 1, candidateIds: ids }).reason, 'target-missing');
  assert.equal(selectConversationIssue([a, b], { ordinal: 3, candidateIds: ids }).status, 'choose');
});

test('review and active model gates remain protected and source history is never mutated by selection', () => {
  const review = { ...issue('review'), status: 'awaiting_action', actions: [{ kind: 'review-approve' }] };
  const active = { ...issue('active'), status: 'thinking' }, records = [review, active], before = JSON.stringify(records);
  assert.equal(selectConversationIssue(records, { targetTurnId: 'review' }).reason, 'protected-review');
  assert.equal(selectConversationIssue(records, { targetTurnId: 'active' }).reason, 'active');
  assert.equal(JSON.stringify(records), before);
  assert.equal(selectConversationIssue([]).status, 'none');
});
