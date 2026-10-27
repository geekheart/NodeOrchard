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
  assert.fail('expected settled isolated conversation');
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-resolution-'));
  const app = new Application(readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), new Offline());
  let document = createDocument({ schemaVersion: 2, title: '对话结束事项隔离测试' });
  document.nodes = [createNode('input', {}, { id: 'input', config: { outputType: 'text' } }),
    createNode('tool', {}, { id: 'trim', config: { executionMode: 'tool', toolName: 'text.trim', inputType: 'text', outputType: 'text' } }),
    createNode('human', {}, { id: 'review', config: { inputType: 'text', outputType: 'text', reviewTargetNodeId: 'trim' } }), createNode('output', {}, { id: 'output' })];
  for (const [sourceNode, targetNode] of [['input', 'trim'], ['trim', 'review'], ['review', 'output']]) document = connectNodes(document, { sourceNode, sourcePort: 'out', targetNode, targetPort: 'in' });
  const saved = app.workflowLibrary.save({ document, expectedRevision: 0 }); let modelCalls = 0;
  app.conversations.planner = async () => { modelCalls++; throw Error('fixture model timeout'); };
  app.applicationAssistant.plan = async () => { modelCalls++; throw Error('fixture model timeout'); };
  const read = (id, global = false) => (global ? app.applicationAssistant.get() : app.conversations.get(document.id)).conversation.turns.find(turn => turn.id === id);
  const send = (text, extra = {}, global = false) => global
    ? app.applicationAssistant.message({ clientMessageId: crypto.randomUUID(), text, context: {}, ...extra })
    : app.conversations.message(document.id, { clientMessageId: crypto.randomUUID(), text, intent: 'auto', document, context: {}, ...extra });
  const failed = async (text = '检查这个错误', context = {}, global = false) => { const { turn } = await send(text, { context }, global); return until(() => read(turn.id, global)?.status === 'error' && read(turn.id, global)); };
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, document, saved, read, send, failed, get modelCalls() { return modelCalls; } };
}

test('a short natural completion closes the only workflow issue locally and retains its history', async t => {
  const f = await fixture(t), parent = await f.failed(), before = structuredClone(parent), count = f.modelCalls;
  const request = { clientMessageId: 'handled-once' }, response = await f.send('这个问题解决了', request);
  assert.equal(response.turn.status, 'complete'); assert.equal(f.modelCalls, count);
  const done = f.read(parent.id); assert.equal(done.status, 'dismissed'); assert.equal(done.resolution.kind, 'handled');
  assert.equal(done.resolution.byTurnId, response.turn.id); assert.deepEqual(done.assistant, before.assistant);
  assert.match(response.turn.assistant.text, /聊天|事项/);
  const duplicate = await f.send('这个问题解决了', request); assert.equal(duplicate.turn.id, response.turn.id);
  await assert.rejects(f.send('不用处理了', request), error => error.httpStatus === 409);
  assert.deepEqual(f.app.workflowLibrary.get(f.document.id), f.saved); assert.deepEqual(f.app.workflows.list(), []); assert.deepEqual(f.app.adapter.calls, []);
});

test('global resolution uses an explicit reply target and a duplicate message cannot close a second issue', async t => {
  const f = await fixture(t), first = await f.failed('第一个错误', {}, true), second = await f.failed('第二个错误', {}, true), count = f.modelCalls;
  const request = { clientMessageId: 'dismiss-once', replyToTurnId: first.id };
  const response = await f.send('不用处理了', request, true);
  assert.equal(response.turn.status, 'complete'); assert.equal(f.read(first.id, true).resolution.kind, 'dismissed');
  assert.equal(f.read(second.id, true).status, 'error'); assert.equal(f.modelCalls, count);
  assert.equal((await f.send('不用处理了', request, true)).turn.id, response.turn.id);
  assert.equal(f.read(second.id, true).status, 'error'); assert.deepEqual(f.app.adapter.calls, []);
});

test('ambiguous issues are listed inside chat and a textual ordinal closes only the frozen chosen item', async t => {
  const f = await fixture(t), first = await f.failed('第一个错误'), second = await f.failed('第二个错误'), count = f.modelCalls;
  const asked = await f.send('这个问题解决了');
  assert.equal(asked.turn.status, 'complete'); assert.equal(asked.turn.assistant.issueResolution.status, 'choose');
  const candidates = asked.turn.assistant.issueResolution.candidateIds; assert.deepEqual(new Set(candidates), new Set([first.id, second.id]));
  assert.match(asked.turn.assistant.text, /第1个|第一个/);
  const chosen = await f.send('第2个'); assert.equal(chosen.turn.status, 'complete');
  assert.equal(f.read(candidates[1]).status, 'dismissed'); assert.equal(f.read(candidates[0]).status, 'error'); assert.equal(f.modelCalls, count);
});

test('questions, negations and quotations about completion remain ordinary discussion', async t => {
  const f = await fixture(t), parent = await f.failed(); let questions = 0;
  f.app.conversations.planner = async () => { questions++; return { text: '只作讨论。' }; };
  for (const text of ['这个问题解决了吗？', '这个问题还没解决', '请解释“不用处理了”的意思']) {
    const posted = await f.send(text); await until(() => f.read(posted.turn.id)?.status === 'complete');
  }
  assert.equal(questions, 3); assert.equal(f.read(parent.id).status, 'error');
});

test('a current human review cannot be closed or approved by a completion statement', async t => {
  const f = await fixture(t), parent = await f.failed();
  const run = { id: 'review-run', workflowId: f.document.id, document: f.document, schemaVersion: 2, status: 'waiting_review',
    nodes: { review: { status: 'waiting_review', attempt: 1, attemptId: 'review-attempt', artifacts: [] } } };
  f.app.workflows.write.run(run.id, JSON.stringify(run)); const before = f.app.workflows.get(run.id), count = f.modelCalls;
  const response = await f.send('这个问题解决了', { context: { runId: run.id, nodeId: 'review', attempt: 1, attemptId: 'review-attempt' } });
  assert.equal(response.turn.status, 'complete'); assert.match(response.turn.assistant.text, /审核/);
  assert.equal(f.read(parent.id).status, 'error'); assert.deepEqual(f.app.workflows.get(run.id), before); assert.equal(f.modelCalls, count);
});

test('explicit reply targets never cross conversations and no-target statements do not call the model', async t => {
  const f = await fixture(t), parent = await f.failed(), count = f.modelCalls;
  await assert.rejects(f.send('不用处理了', { replyToTurnId: parent.id }, true), error => [404, 409].includes(error.httpStatus));
  const none = await f.send('不用处理了', {}, true); assert.equal(none.turn.status, 'complete'); assert.match(none.turn.assistant.text, /没有|暂无/);
  assert.equal(f.modelCalls, count); assert.equal(f.read(parent.id).status, 'error');
});

test('an explicit ordinary chat target may end attention while its associated human gate remains untouched', async t => {
  const f = await fixture(t), run = { id: 'review-run', workflowId: f.document.id, document: f.document, schemaVersion: 2, status: 'waiting_review',
    nodes: { review: { status: 'waiting_review', attempt: 1, attemptId: 'review-attempt', artifacts: [] } } };
  f.app.workflows.write.run(run.id, JSON.stringify(run));
  const context = { runId: run.id, nodeId: 'review', attempt: 1, attemptId: 'review-attempt' }, parent = await f.failed('诊断这次审核错误', context);
  const before = f.app.workflows.get(run.id), count = f.modelCalls;
  const response = await f.send('不用处理了', { replyToTurnId: parent.id, context });
  assert.equal(response.turn.status, 'complete'); assert.equal(f.read(parent.id).status, 'dismissed');
  assert.deepEqual(f.app.workflows.get(run.id), before); assert.equal(f.app.conversations.get(f.document.id).pending.length, 1);
  assert.equal(f.modelCalls, count); assert.deepEqual(f.app.adapter.calls, []);
});

test('an ordinal answer rechecks frozen candidates and never substitutes a different pending issue', async t => {
  const f = await fixture(t); await f.failed('待选择 A'); await f.failed('待选择 B');
  const asked = await f.send('不用处理了'), ids = asked.turn.assistant.issueResolution.candidateIds;
  await f.app.conversations.action(f.document.id, ids[0], { action: 'dismiss-turn' });
  const response = await f.send('第1个');
  assert.equal(response.turn.status, 'complete'); assert.match(response.turn.assistant.text, /已经收起/);
  assert.equal(f.read(ids[1]).status, 'error');
});

test('a global completion statement also protects a selected current review without invoking a model', async t => {
  const f = await fixture(t), parent = await f.failed('普通全局诊断失败', {}, true);
  const run = { id: 'review-run', workflowId: f.document.id, document: f.document, schemaVersion: 2, status: 'waiting_review',
    nodes: { review: { status: 'waiting_review', attempt: 1, attemptId: 'review-attempt', artifacts: [] } } };
  f.app.workflows.write.run(run.id, JSON.stringify(run)); const before = f.app.workflows.get(run.id), count = f.modelCalls;
  const response = await f.send('这个问题解决了', { context: { workflowId: f.document.id, runId: run.id, nodeId: 'review' } }, true);
  assert.equal(response.turn.status, 'complete'); assert.match(response.turn.assistant.text, /审核/);
  assert.equal(f.read(parent.id, true).status, 'error'); assert.deepEqual(f.app.workflows.get(run.id), before); assert.equal(f.modelCalls, count);
});
