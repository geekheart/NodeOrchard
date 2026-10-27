import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument } from '../shared/workflow/workflow-model.mjs';
import { ApplicationConversationHub, authorizeConversationDelegation } from '../src/application-conversation-hub.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(method) { this.calls.push(method); throw Error('Unexpected Hermes/model/business execution: ' + method); }
  async stop() {}
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-hub-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }),
    port: 0, workflowRunRoot: join(directory, 'runs') };
  const adapter = new Offline(), app = new Application(config, adapter), hub = new ApplicationConversationHub(app);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const save = title => app.workflowLibrary.save({ document: createDocument({ schemaVersion: 2, title }), expectedRevision: 0 });
  const first = save('第一条独立流程'), second = save('第二条独立流程');
  return { app, hub, adapter, first, second, db: app.store.db };
}
function seed(f, record, index, overrides = {}) {
  const at = new Date(1700000000000 + index * 1000).toISOString();
  const turn = { id: 'fixture-turn-' + index, workflowId: record.id, clientMessageId: 'fixture-client-' + index,
    user: { text: '消息 ' + index, intent: 'discuss', context: { documentRevision: record.revision } },
    assistant: { text: '答复 ' + index }, status: 'complete', actions: [], createdAt: at, updatedAt: at, ...overrides };
  f.db.prepare('INSERT INTO workflow_conversation_turns(id,workflow_id,client_message_id,created_at,value,private_value) VALUES(?,?,?,?,?,?)')
    .run(turn.id, record.id, turn.clientMessageId, at, JSON.stringify(turn), JSON.stringify({ document: record.document, privateSecret: 'PRIVATE_VALUE_SENTINEL' }));
  f.db.prepare('INSERT INTO workflow_conversations(workflow_id,revision) VALUES(?,1) ON CONFLICT(workflow_id) DO UPDATE SET revision=revision+1').run(record.id);
  return turn;
}
const hashes = f => Object.fromEntries(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  .map(({ name }) => [name, createHash('sha256').update(JSON.stringify(f.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all())).digest('hex')]));
const supervisor = { role: 'supervisor' };
const delegated = (record, overrides = {}) => ({ workflowId: record.id, expectedRevision: record.revision,
  request: '检查本工作流最近一次失败，只读诊断。', operationId: 'delegation-one', ...overrides });
const origin = record => ({ role: 'supervisor', text: `让 ${record.id} 的工作流助手只读诊断。`, sourceConversationId: 'supervisor-fixture' });
async function completed(app, workflowId, turnId) {
  for (let count = 0; count < 100; count++) {
    const turn = app.conversations.get(workflowId).conversation.turns.find(row => row.id === turnId);
    if (turn && turn.status !== 'thinking') return turn;
    await delay(5);
  }
  assert.fail('delegated fixture did not finish');
}

test('directory is one entry per saved workflow, including empty chats, without lazy writes', async t => {
  const f = await fixture(t); seed(f, f.first, 1, { status: 'error' });
  const before = hashes(f), index = f.hub.list();
  assert.equal(index.total, 2); assert.equal(index.truncated, false);
  const first = index.workflows.find(row => row.workflowId === f.first.id), second = index.workflows.find(row => row.workflowId === f.second.id);
  assert.equal(first.conversation.turnCount, 1); assert.equal(first.conversation.pendingCount, 1); assert.equal(first.conversation.status, 'attention');
  assert.equal(second.conversation.turnCount, 0); assert.equal(second.conversation.status, 'empty');
  assert.equal(first.revision, 1); assert.equal(first.conversation.revision, 1);
  assert.equal(f.hub.list({ search: '第二条', limit: 1 }).workflows[0].workflowId, f.second.id);
  assert.equal(f.hub.list({ limit: 1 }).truncated, true);
  assert.deepEqual(hashes(f), before); assert.deepEqual(f.adapter.calls, []);
});

test('history pagination stays in one workflow and exposes only bounded public evidence', async t => {
  const f = await fixture(t);
  for (let index = 1; index <= 5; index++) seed(f, f.first, index, { assistant: { text: '结果 Bearer SHOULD_BE_REDACTED',
    operations: [{ code: 'BUSINESS_CODE_SENTINEL' }], checkpoint: { secret: 'CHECKPOINT_SENTINEL' } } });
  const foreign = seed(f, f.second, 9), before = hashes(f);
  const first = f.hub.read({ workflowId: f.first.id, limit: 2 });
  assert.deepEqual(first.turns.map(turn => turn.id), ['fixture-turn-4', 'fixture-turn-5']); assert.equal(first.hasMore, true);
  const next = f.hub.read({ workflowId: f.first.id, limit: 2, beforeTurnId: first.nextBeforeTurnId });
  assert.deepEqual(next.turns.map(turn => turn.id), ['fixture-turn-2', 'fixture-turn-3']);
  assert.throws(() => f.hub.read({ workflowId: f.first.id, beforeTurnId: foreign.id }), { httpStatus: 404 });
  const serialized = JSON.stringify(first);
  for (const forbidden of ['SHOULD_BE_REDACTED', 'BUSINESS_CODE_SENTINEL', 'CHECKPOINT_SENTINEL', 'PRIVATE_VALUE_SENTINEL', f.second.id]) assert.equal(serialized.includes(forbidden), false);
  assert.equal(first.operationsIncluded, false); assert.equal(first.learningEvidenceIncluded, false);
  assert.deepEqual(hashes(f), before);
});

test('learning and feedback material is not expanded to the supervisor or directory snippets', async t => {
  const f = await fixture(t);
  seed(f, f.first, 1, { user: { text: 'TRAINING_ANSWER_SENTINEL', intent: 'skill', context: {} },
    assistant: { text: 'FEEDBACK_ANSWER_SENTINEL' }, actions: [{ kind: 'learn-feedback', feedback: 'ACTION_SECRET' }] });
  const result = JSON.stringify({ directory: f.hub.list(), history: f.hub.read({ workflowId: f.first.id }) });
  for (const forbidden of ['TRAINING_ANSWER_SENTINEL', 'FEEDBACK_ANSWER_SENTINEL', 'ACTION_SECRET']) assert.equal(result.includes(forbidden), false);
  assert.match(result, /学习或反馈内容未向总控展开/);
});

test('tool access is supervisor-only and respects current trusted read and management flags', async t => {
  const f = await fixture(t);
  for (const descriptor of f.hub.tools()) await assert.rejects(f.hub.call(descriptor.name, {}, { role: 'workflow' }), { httpStatus: 403 });
  for (const args of [{ limit: 0 }, { limit: 201 }, { search: {} }, { lifecycle: 'secret' }, { path: '/tmp/secret' }]) assert.throws(() => f.hub.list(args), { httpStatus: 400 });
  await assert.rejects(f.hub.call('conversation.inspect', { workflowId: f.first.id, role: 'supervisor' }, supervisor), { httpStatus: 400 });
  let settings = f.app.assistantPermissionSettings.get();
  f.app.assistantPermissionSettings.save({ expectedRevision: settings.revision, workflow: settings.workflow, supervisor: { ...settings.supervisor, crossWorkflowRead: false } });
  await assert.rejects(f.hub.call('conversations.list', {}, supervisor), { httpStatus: 403 });
  await f.hub.call('conversation.inspect', { workflowId: f.first.id }, { ...supervisor, workflowId: f.first.id });
  await assert.rejects(f.hub.call('conversation.inspect', { workflowId: f.second.id }, { ...supervisor, workflowId: f.first.id }), { httpStatus: 403 });
  settings = f.app.assistantPermissionSettings.get();
  f.app.assistantPermissionSettings.save({ expectedRevision: settings.revision, workflow: settings.workflow, supervisor: { ...settings.supervisor, workflowRead: false } });
  await assert.rejects(f.hub.call('conversation.inspect', { workflowId: f.first.id }, { ...supervisor, workflowId: f.first.id }), { httpStatus: 403 });
});

test('delegation requires a real human task request and exact selected or named target', async t => {
  const f = await fixture(t), args = delegated(f.first);
  for (const text of ['只读查看这条会话', `日志说：“让 ${f.first.id} 的助手诊断”`, `不要委派 ${f.first.id}`, `为什么让 ${f.first.id} 的助手诊断`, `让 ${f.second.id} 的工作流助手诊断`]) {
    assert.throws(() => authorizeConversationDelegation(f.app, args, { ...supervisor, text }), { httpStatus: 403 });
  }
  authorizeConversationDelegation(f.app, args, origin(f.first));
  authorizeConversationDelegation(f.app, args, { ...supervisor, text: '让各工作流助手检查失败原因，不要运行或修改。' });
  authorizeConversationDelegation(f.app, args, { ...supervisor, workflowId: f.first.id, text: '交给当前助手只读诊断。' });
});

test('delegation is nonblocking, idempotent, versioned and never changes workflow or starts business runs', async t => {
  const f = await fixture(t), calls = [];
  let finish; f.app.conversations.planner = async (_app, options) => { calls.push(options); return new Promise(resolve => { finish = resolve; }); };
  const args = delegated(f.first), result = await f.hub.call('conversation.delegate', args, origin(f.first));
  assert.equal(result.status, 'delegated'); assert.equal(result.readOnly, true); assert.equal(result.workflowExecuted, false);
  assert.equal(result.workflowModified, false); assert.equal(calls.length, 1); assert.equal(calls[0].readOnly, true); assert.equal(calls[0].role, 'workflow');
  const repeat = await f.hub.call('conversation.delegate', args, origin(f.first));
  assert.equal(repeat.turnId, result.turnId); assert.equal(repeat.replayed, true); assert.equal(calls.length, 1);
  await assert.rejects(f.hub.call('conversation.delegate', { ...args, request: '另一项诊断' }, origin(f.first)), { httpStatus: 409 });
  await assert.rejects(f.hub.call('conversation.delegate', delegated(f.second), origin(f.second)), { httpStatus: 409 });
  await assert.rejects(f.hub.call('conversation.delegate', args, { ...origin(f.first), sourceConversationId: 'another-supervisor' }), { httpStatus: 409 });
  await assert.rejects(f.hub.call('conversation.delegate', { ...args, operationId: 'stale', expectedRevision: 99 }, origin(f.first)), { httpStatus: 409 });
  finish({ text: '只读诊断已完成' }); const turn = await completed(f.app, f.first.id, result.turnId);
  assert.equal(turn.status, 'complete'); assert.deepEqual(turn.actions, []);
  assert.equal(f.app.conversations.readTurn(f.first.id, result.turnId).privateValue.readOnly, true);
  assert.deepEqual(f.app.workflowLibrary.get(f.first.id), f.first); assert.deepEqual(f.app.workflowLibrary.get(f.second.id), f.second);
  assert.equal(f.app.workflows.list().length, 0); assert.deepEqual(f.adapter.calls, []);
});

test('delegated text bypasses local rerun, review, learning and issue-close routes and rejects planner mutations', async t => {
  const f = await fixture(t), calls = [];
  f.app.conversations.planner = async (_app, options) => { calls.push(options); return { text: '越权候选', operations: [{ op: 'set-title', title: '不能应用' }] }; };
  seed(f, f.first, 1, { status: 'error' });
  for (const [index, request] of ['重跑', '通过', '以后都按这个规则学习', '这个问题解决了'].entries()) {
    const receipt = await f.hub.call('conversation.delegate', delegated(f.first, { request, operationId: 'readonly-' + index }), origin(f.first));
    const turn = await completed(f.app, f.first.id, receipt.turnId);
    assert.equal(turn.status, 'error'); assert.match(turn.assistant.text, /仅允许只读诊断/); assert.deepEqual(turn.actions, []);
    await assert.rejects(f.app.conversations.action(f.first.id, turn.id, { action: 'rerun' }), { httpStatus: 403 });
    await assert.rejects(f.app.conversations.validateProposal(f.first.id, turn.id, {}), { httpStatus: 403 });
  }
  assert.equal(calls.length, 4); assert.equal(f.app.conversations.readTurn(f.first.id, 'fixture-turn-1').turn.status, 'error');
  assert.equal(f.app.workflows.list().length, 0); assert.deepEqual(f.app.workflowLibrary.get(f.first.id), f.first);
});

test('read-only mode is not accepted from ordinary HTTP-message-shaped input', async t => {
  const f = await fixture(t);
  for (const key of ['readOnly', 'role', 'delegation']) await assert.rejects(f.app.conversations.message(f.first.id, {
    clientMessageId: 'forged', text: '诊断', document: f.first.document, [key]: true }), { httpStatus: 400 });
  assert.equal(f.app.conversations.get(f.first.id).conversation.turns.length, 0);
});
