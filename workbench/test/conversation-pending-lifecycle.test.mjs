import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(method) { this.calls.push(method); throw Error('Unexpected Hermes execution'); }
  async stop() {}
}
async function until(read) {
  for (let index = 0; index < 100; index++) { const value = read(); if (value) return value; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('expected settled fixture conversation');
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-pending-'));
  const config = readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') });
  const adapter = new Offline(), app = new Application(config, adapter);
  let document = createDocument({ schemaVersion: 2, title: '待处理隔离样例' });
  document.nodes = [createNode('input', {}, { id: 'input', config: { outputType: 'text' } }),
    createNode('tool', {}, { id: 'trim', config: { executionMode: 'tool', toolName: 'text.trim', inputType: 'text', outputType: 'text' } }),
    createNode('human', {}, { id: 'review', config: { inputType: 'text', outputType: 'text', reviewTargetNodeId: 'trim' } }),
    createNode('output', {}, { id: 'output' })];
  for (const [sourceNode, targetNode] of [['input', 'trim'], ['trim', 'review'], ['review', 'output']]) document = connectNodes(document, { sourceNode, sourcePort: 'out', targetNode, targetPort: 'in' });
  const saved = app.workflowLibrary.save({ document, expectedRevision: 0 });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const read = id => app.conversations.get(document.id).conversation.turns.find(turn => turn.id === id);
  const send = (text = '检查这个错误', extra = {}) => app.conversations.message(document.id, { clientMessageId: crypto.randomUUID(), text, intent: 'discuss', document, context: {}, ...extra });
  const failed = async extra => {
    app.conversations.planner = async () => { throw Error('fixture model timeout'); };
    const { turn } = await send('检查这个错误', extra); return until(() => read(turn.id)?.status === 'error' && read(turn.id));
  };
  const raw = id => app.store.db.prepare('SELECT value FROM workflow_conversation_turns WHERE id=?').get(id).value;
  return { app, adapter, document, saved, read, send, failed, raw };
}

test('an explicit successful workflow retry supersedes only its failed parent without rewriting history or business state', async t => {
  const f = await fixture(t), parent = await f.failed(), raw = f.raw(parent.id);
  f.app.conversations.planner = async () => ({ text: '诊断已完成；业务尚未重跑。' });
  const request = { retryOfTurnId: parent.id }, next = await f.send(parent.user.text, request);
  await until(() => f.read(next.turn.id)?.status === 'complete');
  const projected = f.read(parent.id);
  assert.equal(projected.status, 'error'); assert.equal(projected.pendingState.status, 'superseded');
  assert.equal(projected.pendingState.byTurnId, next.turn.id); assert.equal(f.raw(parent.id), raw);
  assert.equal(f.read(next.turn.id).retryOfTurnId, parent.id);
  assert.deepEqual(f.app.workflowLibrary.get(f.document.id), f.saved); assert.deepEqual(f.app.workflows.list(), []); assert.deepEqual(f.adapter.calls, []);
});

test('unrelated success and an unsuccessful retry cannot silently resolve the old failure', async t => {
  const f = await fixture(t), parent = await f.failed();
  f.app.conversations.planner = async () => ({ text: '另一条咨询完成。' });
  const unrelated = await f.send('另一件事情'); await until(() => f.read(unrelated.turn.id)?.status === 'complete');
  assert.notEqual(f.read(parent.id).pendingState?.status, 'superseded');
  const failedRetry = await f.failed({ retryOfTurnId: parent.id });
  assert.equal(failedRetry.status, 'error'); assert.notEqual(f.read(parent.id).pendingState?.status, 'superseded');
});

test('workflow retry admission rejects changed text, context, unknown or cross-workflow parents and uncertain actions', async t => {
  const f = await fixture(t), parent = await f.failed({ context: { nodeId: 'trim' } });
  const count = f.app.conversations.get(f.document.id).conversation.turns.length;
  for (const extra of [
    { text: '不同问题', context: parent.user.context, retryOfTurnId: parent.id },
    { context: {}, retryOfTurnId: parent.id },
    { context: parent.user.context, retryOfTurnId: 'turn-missing' },
    { context: parent.user.context, retryOfTurnId: null },
  ]) await assert.rejects(f.send(parent.user.text, extra), /重试|轮次|事项/);
  let other = createDocument({ schemaVersion: 2, title: '另一工作流' });
  f.app.workflowLibrary.save({ document: other, expectedRevision: 0 });
  await assert.rejects(f.app.conversations.message(other.id, { clientMessageId: crypto.randomUUID(), text: parent.user.text, intent: 'discuss', document: other, context: {}, retryOfTurnId: parent.id }), /轮次|重试/);
  const rawParent = f.app.conversations.readTurn(f.document.id, parent.id).turn;
  for (const patch of [{ status: 'thinking' }, { status: 'complete' }, { actions: [{ kind: 'review-approve' }] }, { outcome: { action: 'rerun', status: 'unknown' } }]) {
    f.app.conversations.update({ ...rawParent, ...patch });
    await assert.rejects(f.send(parent.user.text, { context: parent.user.context, retryOfTurnId: parent.id }), /重试|未确认|事项/);
  }
  assert.equal(f.app.conversations.get(f.document.id).conversation.turns.length, count); assert.deepEqual(f.app.workflows.list(), []);
});

test('retry network delivery remains idempotent and never calls the planner twice', async t => {
  const f = await fixture(t), parent = await f.failed(); let calls = 0;
  f.app.conversations.planner = async () => { calls++; return { text: '仅分析一次。' }; };
  const request = { clientMessageId: 'same-retry', text: parent.user.text, document: f.document, context: parent.user.context, intent: 'discuss', retryOfTurnId: parent.id };
  const first = await f.app.conversations.message(f.document.id, request); await until(() => f.read(first.turn.id)?.status === 'complete');
  const again = await f.app.conversations.message(f.document.id, request);
  assert.equal(again.turn.id, first.turn.id); assert.equal(calls, 1);
  await assert.rejects(f.app.conversations.message(f.document.id, { ...request, retryOfTurnId: 'different' }), /相同消息/);
});

test('already processed review cards are projected out while current reviews and unreadable targets remain pending', async t => {
  const f = await fixture(t), run = { id: 'fixture-review-run', workflowId: f.document.id, document: f.document, schemaVersion: 2,
    status: 'waiting_review', nodes: { review: { status: 'waiting_review', attempt: 1, attemptId: 'attempt-one', artifacts: [] } } };
  f.app.workflows.write.run(run.id, JSON.stringify(run));
  const response = await f.send('通过', { intent: 'auto' }), id = response.turn.id, raw = f.raw(id);
  assert.equal(f.read(id).status, 'awaiting_action'); assert.notEqual(f.read(id).pendingState?.status, 'resolved');
  run.nodes.review.status = 'complete'; run.status = 'complete'; f.app.workflows.write.run(run.id, JSON.stringify(run));
  assert.equal(f.read(id).pendingState.status, 'resolved'); assert.equal(f.raw(id), raw);
  await assert.rejects(f.app.conversations.action(f.document.id, id, { action: 'review-approve', actionId: response.turn.actions[0].id }),
    error => error.httpStatus === 409 && /历史审核入口已结束/.test(error.message));
  assert.equal(f.raw(id), raw);
  run.nodes.review = { status: 'waiting_review', attempt: 2, attemptId: 'attempt-two', artifacts: [] }; run.status = 'waiting_review';
  f.app.workflows.write.run(run.id, JSON.stringify(run));
  assert.equal(f.read(id).pendingState.status, 'resolved'); assert.equal(f.app.conversations.get(f.document.id).pending[0].context.attempt, 2);
  const target = response.turn.actions[0].context, get = f.app.workflows.get;
  run.nodes.review = { status: 'waiting_review', attempt: 1, attemptId: 'mismatched-attempt', artifacts: [] }; f.app.workflows.write.run(run.id, JSON.stringify(run));
  assert.equal(f.app.conversations.reviewState(f.document.id, target), 'unknown'); assert.notEqual(f.read(id).pendingState?.status, 'resolved');
  run.nodes.review = { status: 'unknown', attempt: 1, attemptId: 'attempt-one', artifacts: [] }; f.app.workflows.write.run(run.id, JSON.stringify(run));
  assert.equal(f.app.conversations.reviewState(f.document.id, target), 'unknown');
  f.app.workflows.get = () => { throw Error('fixture missing run'); };
  assert.equal(f.app.conversations.reviewState(f.document.id, target), 'unknown'); f.app.workflows.get = get;
  assert.equal(f.raw(id), raw); assert.deepEqual(f.adapter.calls, []);
});

test('global retries preserve real scope and cannot replace a completed operation', async t => {
  const f = await fixture(t), assistant = f.app.applicationAssistant, context = { workflowId: f.document.id, runId: 'selected-old-run' };
  assistant.plan = async () => { throw Error('fixture global model timeout'); };
  const request = { clientMessageId: 'global-parent', text: '检查同一个问题', context }, first = await assistant.message(request);
  const globalTurn = id => assistant.get().conversation.turns.find(turn => turn.id === id);
  const parent = await until(() => globalTurn(first.turn.id)?.status === 'error' && globalTurn(first.turn.id));
  assert.deepEqual(parent.user.context, context);
  const raw = f.app.store.db.prepare('SELECT value FROM application_conversation_turns WHERE id=?').get(parent.id).value;
  for (const extra of [{ text: '别的问题' }, { context: { workflowId: f.document.id } }, { retryOfTurnId: 'turn-missing' }]) {
    await assert.rejects(assistant.message({ ...request, clientMessageId: crypto.randomUUID(), retryOfTurnId: parent.id, ...extra }), /重试|事项/);
  }
  assistant.plan = async () => ({ text: '诊断已完成，未修复或重跑业务。' });
  const retryRequest = { ...request, clientMessageId: 'global-retry', retryOfTurnId: parent.id }, retry = await assistant.message(retryRequest);
  await until(() => globalTurn(retry.turn.id)?.status === 'complete');
  assert.equal(globalTurn(parent.id).pendingState.status, 'superseded'); assert.equal(globalTurn(parent.id).pendingState.byTurnId, retry.turn.id);
  assert.equal(f.app.store.db.prepare('SELECT value FROM application_conversation_turns WHERE id=?').get(parent.id).value, raw);
  assert.equal((await assistant.message(retryRequest)).turn.id, retry.turn.id);
  await assert.rejects(assistant.message({ ...retryRequest, clientMessageId: 'not-completed-parent', retryOfTurnId: retry.turn.id }), /重试|事项/);
  assert.deepEqual(f.app.workflowLibrary.get(f.document.id), f.saved); assert.deepEqual(f.app.workflows.list(), []); assert.deepEqual(f.adapter.calls, []);
});

test('global admission never retries an uncertain action or an old human review', async t => {
  const f = await fixture(t), assistant = f.app.applicationAssistant;
  assistant.plan = async () => { throw Error('fixture model timeout'); };
  const request = { clientMessageId: 'global-uncertain', text: '检查问题', context: {} }, first = await assistant.message(request);
  const parent = await until(() => assistant.get().conversation.turns.find(turn => turn.id === first.turn.id && turn.status === 'error'));
  for (const patch of [{ outcome: { action: 'rerun', status: 'unknown' } }, { actions: [{ kind: 'review-revise' }] }, { status: 'thinking' }]) {
    assistant.save({ ...parent, ...patch });
    await assert.rejects(assistant.message({ ...request, clientMessageId: crypto.randomUUID(), retryOfTurnId: parent.id }), /重试|未确认|事项/);
  }
  assert.equal(assistant.get().conversation.turns.length, 1); assert.deepEqual(f.app.workflows.list(), []); assert.deepEqual(f.adapter.calls, []);
});
