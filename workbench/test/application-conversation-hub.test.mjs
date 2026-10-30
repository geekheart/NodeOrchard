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
  app.applicationAssistant.intentClassifier.classify = async () => ({ intent: 'diagnose', modelRoute: { provider: 'fixture', model: 'fixture' } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const save = title => app.workflowLibrary.save({ document: createDocument({ schemaVersion: 2, title }), expectedRevision: 0 });
  const first = save('第一条独立流程'), second = save('第二条独立流程');
  return { app, hub, adapter, first, second, db: app.store.db, config };
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

test('recycle directory includes legacy archives without rewriting workflow or conversation history', async t => {
  const f = await fixture(t); seed(f, f.first, 1);
  f.db.prepare('INSERT INTO workflow_lifecycle(workflow_id,lifecycle,archived_at,trashed_at) VALUES(?,?,?,NULL)')
    .run(f.first.id, 'archived', '2026-10-27T01:00:00.000Z');
  const before = hashes(f), recycled = f.hub.list({ lifecycle: 'trashed' });
  assert.deepEqual(f.hub.tools()[0].inputSchema.properties.lifecycle.enum, ['active', 'trashed', 'all']);
  assert.deepEqual(recycled.workflows.map(row => [row.workflowId, row.lifecycle, row.conversation.turnCount]), [[f.first.id, 'trashed', 1]]);
  assert.deepEqual(f.hub.list({ lifecycle: 'archived' }), recycled);
  assert.deepEqual(f.hub.list().workflows.map(row => row.workflowId), [f.second.id]);
  assert.equal(f.hub.read({ workflowId: f.first.id }).turns[0].id, 'fixture-turn-1');
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

test('supervisor conversation tools respect current trusted read and management flags', async t => {
  const f = await fixture(t);
  for (const descriptor of f.hub.tools().filter(tool => tool.roles.includes('supervisor'))) await assert.rejects(f.hub.call(descriptor.name, {}, { role: 'workflow' }), { httpStatus: 403 });
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
  for (let count = 0; count < 100 && !calls.length; count++) await delay(5);
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

async function escalationSource(f, record = f.first, index = 101) {
  const turn = seed(f, record, index, { user: { text: '请排查这个报错并提出修复建议，保留工作流现场。', intent: 'diagnose', context: { documentRevision: record.revision } }, status: 'thinking' });
  const scope = await f.app.applicationAssistant.permissions.bind({ role: 'workflow', workflowId: record.id, document: record.document });
  return { turn, context: { role: 'workflow', workflowId: record.id, permissionScope: scope, diagnosticTurnId: turn.id,
    escalationAuthorized: true, text: turn.user.text } };
}

test('a workflow escalation records a bounded request without implicitly starting a model', async t => {
  const f = await fixture(t), { turn, context } = await escalationSource(f), before = f.app.applicationAssistant.listConversations().length;
  const args = { operationId: 'escalate-one', summary: '需要总控检查模型响应。token=PRIVATE_SUMMARY' };
  const receipt = await f.hub.call('conversation.escalate', args, context);
  assert.equal(receipt.status, 'recorded'); assert.equal(receipt.modelRequested, false); assert.equal(receipt.readOnly, true);
  assert.equal(receipt.sourceWorkflowId, f.first.id); assert.equal(receipt.sourceTurnId, turn.id);
  assert.equal(receipt.workflowExecuted, false); assert.equal(receipt.workflowModified, false);
  assert.equal(f.app.applicationAssistant.listConversations().length, before); assert.deepEqual(f.adapter.calls, []);
  const repeat = await f.hub.call('conversation.escalate', { ...args, operationId: 'different-id-same-origin' }, context);
  assert.equal(repeat.escalationId, receipt.escalationId); assert.equal(repeat.replayed, true);
  await assert.rejects(f.hub.call('conversation.escalate', { ...args, summary: 'different content' }, context), { httpStatus: 409 });
  const read = await f.hub.call('conversation.escalation', {}, context);
  assert.equal(read.escalationId, receipt.escalationId); assert.equal(read.selection, 'latest');
  assert.equal(JSON.stringify(read).includes('PRIVATE_SUMMARY'), false); assert.equal(read.diagnosisOnly, true);
  assert.deepEqual(f.app.workflowLibrary.get(f.first.id), f.first); assert.equal(f.app.workflows.list().length, 0);
});

async function supervisorCompleted(owner, conversationId, turnId) {
  for (let count = 0; count < 100; count++) {
    const turn = owner.readTurn(turnId, conversationId); if (turn.status !== 'thinking') return turn; await delay(5);
  }
  assert.fail('supervisor fixture did not finish');
}

test('the private supervisor message entry enforces read-only scope and does not reuse topic history or checkpoints', async t => {
  const f = await fixture(t), { turn } = await escalationSource(f), owner = f.app.applicationAssistant, plans = [], classifications = [];
  const topic = owner.createConversation({ clientConversationId: 'readonly-topic', title: '隔离诊断主题' }).conversation;
  owner.intentClassifier.classify = async options => { classifications.push(options); return { intent: 'diagnose', modelRoute: { provider: 'fixture', model: 'fixture' } }; };
  owner.plan = async options => { plans.push(options); return { text: '诊断建议；未修改工作流。' }; };
  const metadata = { escalationId: 'escalation-private', sourceWorkflowId: f.first.id, sourceTurnId: turn.id, operationId: 'private-once' };
  const input = { clientMessageId: 'private-child', text: '这个问题解决了', context: { workflowId: f.first.id } };
  const response = await owner.messageReadOnly(input, topic.id, metadata), child = await supervisorCompleted(owner, topic.id, response.turn.id);
  assert.equal(child.escalation.readOnly, true); assert.equal(child.escalation.workflowBound, true); assert.equal(child.escalation.noReverseDelegation, true); assert.equal(child.escalation.sourceTurnId, turn.id);
  assert.equal(plans.length, 1); assert.equal(plans[0].role, 'supervisor'); assert.equal(plans[0].readOnly, true); assert.equal(plans[0].workflowBound, true);
  assert.equal(plans[0].context.workflowId, f.first.id); assert.deepEqual(plans[0].history, []); assert.equal(plans[0].checkpoint, undefined);
  assert.equal(classifications[0].readOnly, true); assert.equal(child.status, 'complete'); assert.deepEqual(child.actions, []);
  await assert.rejects(owner.message({ ...input, clientMessageId: 'forged-third-param' }, topic.id, { readOnly: true, escalation: metadata }), { httpStatus: 403 });
  await assert.rejects(owner.action(child.id, { action: 'mark-applied' }, topic.id), { httpStatus: 403 });
  assert.equal(f.app.conversations.readTurn(f.first.id, turn.id).turn.status, 'thinking'); assert.deepEqual(f.adapter.calls, []);
});

test('explicit escalation start is nonblocking and concurrent or changed operation IDs cannot duplicate model admission', async t => {
  const f = await fixture(t), { context } = await escalationSource(f), owner = f.app.applicationAssistant;
  const plans = []; owner.plan = async options => { plans.push(options); return { text: '应先修改工具配置；未运行或修改。token=PRIVATE_RESULT',
    progress: { stage: 'complete', label: '诊断完成', modelCalls: 1 }, checkpoint: { secret: 'PRIVATE_CHECKPOINT' } }; };
  const original = owner.messageReadOnly.bind(owner); let release, entries = 0;
  const gate = new Promise(resolve => { release = resolve; });
  owner.messageReadOnly = async (...args) => { entries++; await gate; return original(...args); };
  const args = { operationId: 'start-once', summary: '检查当前失败', start: true }, pending = f.hub.call('conversation.escalate', args, context);
  for (let count = 0; count < 100 && !entries; count++) await delay(5);
  const concurrent = await f.hub.call('conversation.escalate', { ...args, operationId: 'new-id-cannot-replay' }, context);
  assert.equal(entries, 1); assert.equal(concurrent.status, 'starting'); assert.equal(concurrent.modelRequested, null);
  release(); const receipt = await pending;
  await supervisorCompleted(owner, receipt.conversationId, receipt.turnId);
  const result = await f.hub.call('conversation.escalation', { escalationId: receipt.escalationId }, context);
  assert.equal(result.status, 'complete'); assert.equal(result.diagnosisOnly, true); assert.equal(result.workflowModified, false);
  assert.match(result.text, /修改工具配置/); assert.equal(result.progress.stage, 'complete');
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false); assert.equal(Object.hasOwn(result, 'checkpoint'), false);
  assert.equal(plans.length, 1); assert.equal(plans[0].readOnly, true); assert.equal(plans[0].context.workflowId, f.first.id);
  const replay = await f.hub.call('conversation.escalate', args, context);
  assert.equal(replay.turnId, receipt.turnId); assert.equal(entries, 1); assert.equal(plans.length, 1);
  assert.deepEqual(f.app.workflowLibrary.get(f.first.id), f.first); assert.equal(f.app.workflows.list().length, 0); assert.deepEqual(f.adapter.calls, []);
});

test('missing supervisor read permissions preserve a blocked request without creating a topic or requesting a model', async t => {
  const f = await fixture(t), owner = f.app.applicationAssistant, settings = f.app.assistantPermissionSettings.get();
  f.app.assistantPermissionSettings.save({ expectedRevision: settings.revision, workflow: settings.workflow, supervisor: { ...settings.supervisor, appLogs: false } });
  const { context } = await escalationSource(f), before = owner.listConversations().length;
  owner.messageReadOnly = async () => { assert.fail('blocked request must not be dispatched'); };
  const receipt = await f.hub.call('conversation.escalate', { operationId: 'blocked-start', summary: '排错', start: true }, context);
  assert.equal(receipt.status, 'blocked'); assert.equal(receipt.modelRequested, false); assert.deepEqual(receipt.missingPermissions, ['supervisor.appLogs']);
  assert.equal(owner.listConversations().length, before); assert.equal(Object.hasOwn(receipt, 'conversationId'), false);
  assert.equal((await f.hub.call('conversation.escalation', { sourceTurnId: receipt.sourceTurnId }, context)).status, 'blocked');
  assert.deepEqual(f.adapter.calls, []);
});

test('escalation source and readback remain scoped, classified and exclude delegated or learning origins', async t => {
  const f = await fixture(t), { context, turn } = await escalationSource(f), args = { operationId: 'scope-start', summary: '诊断' };
  await assert.rejects(f.hub.call('conversation.escalate', args, { ...context, escalationAuthorized: false }), { httpStatus: 403 });
  await assert.rejects(f.hub.call('conversation.escalate', args, { ...context, diagnosticTurnId: 'missing-source' }), { httpStatus: 404 });
  const readonly = await f.app.applicationAssistant.permissions.bind({ role: 'workflow', workflowId: f.first.id, readOnly: true });
  await assert.rejects(f.hub.call('conversation.escalate', args, { ...context, permissionScope: readonly }), { httpStatus: 403 });
  const foreign = await escalationSource(f, f.second, 102);
  await assert.rejects(f.hub.call('conversation.escalate', { ...args, targetTurnId: foreign.turn.id }, context), { httpStatus: 404 });
  const first = await f.hub.call('conversation.escalate', args, context);
  await assert.rejects(f.hub.call('conversation.escalation', { escalationId: first.escalationId }, foreign.context), { httpStatus: 403 });
  const learned = seed(f, f.first, 103, { user: { text: 'PRIVATE_TRAINING', intent: 'skill', context: {} } });
  await assert.rejects(f.hub.call('conversation.escalate', { ...args, operationId: 'no-learning', targetTurnId: learned.id }, context), { httpStatus: 403 });
  const stored = f.app.conversations.readTurn(f.first.id, turn.id); stored.privateValue.readOnly = true;
  f.db.prepare('UPDATE workflow_conversation_turns SET private_value=? WHERE id=?').run(JSON.stringify(stored.privateValue), turn.id);
  await assert.rejects(f.hub.call('conversation.escalate', args, context), { httpStatus: 403 });
  const originalGet = f.app.workflows.get;
  f.app.workflows.get = id => id === 'learn-run' ? { id, workflowId: f.second.id, document: { ...f.second.document, mode: 'learn' } } : originalGet.call(f.app.workflows, id);
  await assert.rejects(f.hub.call('conversation.escalate', { operationId: 'no-learn-run', summary: '诊断', runId: 'learn-run' }, foreign.context), { httpStatus: 403 });
  assert.equal(f.app.workflows.list().length, 0); assert.deepEqual(f.adapter.calls, []);
});

test('an enabled source-repair flag cannot let an escalated supervisor mutate or reverse-delegate', async t => {
  const f = await fixture(t), settings = f.app.assistantPermissionSettings.get();
  f.app.assistantPermissionSettings.save({ expectedRevision: settings.revision, workflow: settings.workflow, supervisor: { ...settings.supervisor, sourceRepair: true } });
  const { context } = await escalationSource(f), owner = f.app.applicationAssistant;
  owner.plan = async options => {
    const scope = await owner.permissions.bind({ role: options.role, workflowId: options.context.workflowId, readOnly: options.readOnly, workflowBound: options.workflowBound });
    for (const name of ['workflow.propose', 'app.source.patch', 'app.source.test', 'conversation.delegate', 'conversation.escalate', 'assistant.experiment']) assert.equal(owner.permissions.allowed(name, scope), false, name);
    assert.equal(owner.permissions.allowed('app.source.read', scope), true);
    await assert.rejects(f.hub.call('conversation.delegate', delegated(f.first), { role: 'supervisor', permissionScope: scope, text: '交给当前助手诊断', workflowId: f.first.id }), { httpStatus: 403 });
    return { text: '不能发布候选', operations: [{ op: 'set-title', title: 'forbidden' }] };
  };
  const receipt = await f.hub.call('conversation.escalate', { operationId: 'no-writes', summary: '排错', start: true }, context);
  const child = await supervisorCompleted(owner, receipt.conversationId, receipt.turnId);
  assert.equal(child.status, 'error'); assert.match(child.assistant.text, /仅允许只读诊断/); assert.deepEqual(child.actions, []);
  await assert.rejects(owner.action(child.id, { action: 'mark-applied' }, receipt.conversationId), { httpStatus: 403 });
  assert.deepEqual(f.app.workflowLibrary.get(f.first.id), f.first); assert.equal(f.app.workflows.list().length, 0); assert.deepEqual(f.adapter.calls, []);
});

test('unknown escalation admission and restart retain the original identity without retrying a model', async t => {
  const f = await fixture(t), { context } = await escalationSource(f), owner = f.app.applicationAssistant; let calls = 0;
  owner.messageReadOnly = async () => { calls++; throw Error('PRIVATE_UNKNOWN_START'); };
  const args = { operationId: 'unknown-start', summary: '排错', start: true }, receipt = await f.hub.call('conversation.escalate', args, context);
  assert.equal(receipt.status, 'unknown'); assert.equal(receipt.modelRequested, null); assert.equal(JSON.stringify(receipt).includes('PRIVATE_'), false);
  assert.equal((await f.hub.call('conversation.escalate', args, context)).escalationId, receipt.escalationId); assert.equal(calls, 1);
  const row = f.db.prepare('SELECT value FROM workflow_diagnostic_escalations WHERE id=?').get(receipt.escalationId), interrupted = JSON.parse(row.value);
  interrupted.status = 'starting'; f.db.prepare('UPDATE workflow_diagnostic_escalations SET value=? WHERE id=?').run(JSON.stringify(interrupted), receipt.escalationId);
  await f.app.close(); const adapter = new Offline(), app = new Application(f.config, adapter);
  t.after(() => app.close()); const hub = app.applicationAssistant.hub;
  const scope = await app.applicationAssistant.permissions.bind({ role: 'workflow', workflowId: f.first.id });
  const current = { ...context, permissionScope: scope }; let retried = false;
  app.applicationAssistant.messageReadOnly = async () => { retried = true; assert.fail('restart must not replay'); };
  const read = await hub.call('conversation.escalation', { escalationId: receipt.escalationId }, current);
  assert.equal(read.status, 'unknown'); assert.equal(read.escalationId, receipt.escalationId);
  await hub.call('conversation.escalate', args, current); assert.equal(retried, false); assert.deepEqual(adapter.calls, []);
});

test('readback requires the immutable child origin and workflow-bound scope before exposing its text', async t => {
  const f = await fixture(t), { context } = await escalationSource(f), owner = f.app.applicationAssistant;
  owner.plan = async () => ({ text: 'OWN_RESULT_ONLY' });
  const receipt = await f.hub.call('conversation.escalate', { operationId: 'origin-proof', summary: '诊断', start: true }, context);
  const child = await supervisorCompleted(owner, receipt.conversationId, receipt.turnId);
  assert.equal((await f.hub.call('conversation.escalation', {}, context)).text, 'OWN_RESULT_ONLY');
  for (const variant of [{ ...child, escalation: { ...child.escalation, workflowBound: false } }, { ...child, escalation: { ...child.escalation, workflowBound: 'true' } },
    { ...child, user: { ...child.user, context: { workflowId: f.second.id } }, assistant: { text: 'FOREIGN_CHILD_BODY' } }]) {
    owner.save(variant); const read = await f.hub.call('conversation.escalation', {}, context);
    assert.equal(read.status, 'unknown'); assert.equal(JSON.stringify(read).includes('OWN_RESULT_ONLY'), false); assert.equal(JSON.stringify(read).includes('FOREIGN_CHILD_BODY'), false);
  }
});

const pendingPlan = options => new Promise((resolve, reject) => {
  if (options.signal.aborted) reject(Error('stopped'));
  else options.signal.addEventListener('abort', () => reject(Error('stopped')), { once: true });
});

test('normal source completion leaves the diagnostic running and explicit source interruption stops only its child', async t => {
  const f = await fixture(t), first = await escalationSource(f), second = await escalationSource(f, f.second, 102), owner = f.app.applicationAssistant;
  owner.plan = pendingPlan;
  const a = await f.hub.call('conversation.escalate', { operationId: 'child-a', summary: '诊断A', start: true }, first.context);
  const b = await f.hub.call('conversation.escalate', { operationId: 'child-b', summary: '诊断B', start: true }, second.context);
  const source = f.app.conversations.readTurn(f.first.id, first.turn.id).turn; source.status = 'complete'; f.app.conversations.update(source);
  assert.equal(owner.readTurn(a.turnId, a.conversationId).status, 'thinking');
  await f.app.conversations.action(f.first.id, first.turn.id, { action: 'interrupt-turn' });
  assert.equal((await supervisorCompleted(owner, a.conversationId, a.turnId)).status, 'interrupted');
  assert.equal(owner.readTurn(b.turnId, b.conversationId).status, 'thinking');
  assert.equal((await f.hub.call('conversation.escalation', { escalationId: a.escalationId }, first.context)).status, 'interrupted');
  await f.app.conversations.action(f.second.id, second.turn.id, { action: 'interrupt-turn' });
  await supervisorCompleted(owner, b.conversationId, b.turnId); assert.deepEqual(f.adapter.calls, []);
});

test('an interruption during start survives a late child acknowledgement and cannot be restarted', async t => {
  const f = await fixture(t), { turn, context } = await escalationSource(f), owner = f.app.applicationAssistant; owner.plan = pendingPlan;
  const original = owner.messageReadOnly.bind(owner); let acknowledge, accepted;
  const gate = new Promise(resolve => { acknowledge = resolve; });
  owner.messageReadOnly = async (...args) => { accepted = await original(...args); await gate; return accepted; };
  const args = { operationId: 'late-ack', summary: '诊断', start: true }, pending = f.hub.call('conversation.escalate', args, context);
  for (let count = 0; count < 100 && !accepted; count++) await delay(5);
  assert(accepted); await f.app.conversations.action(f.first.id, turn.id, { action: 'interrupt-turn' });
  acknowledge(); const receipt = await pending;
  assert.equal(receipt.status, 'interrupted'); assert.equal((await supervisorCompleted(owner, receipt.conversationId, receipt.turnId)).status, 'interrupted');
  const replay = await f.hub.call('conversation.escalate', args, context); assert.equal(replay.status, 'interrupted'); assert.equal(replay.turnId, receipt.turnId);
  assert.deepEqual(f.adapter.calls, []);
});
