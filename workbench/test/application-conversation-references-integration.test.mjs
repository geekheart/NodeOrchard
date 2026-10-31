import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { createDocument } from '../shared/workflow/workflow-model.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'ready'; this.serverRequests = new Map(); this.calls = []; }
  async request(method) { this.calls.push(method); throw Error('Unexpected native/model/business request in isolated fixture'); }
  async stop() {}
}
const source = prompt => JSON.parse(prompt.split('\nSOURCE_JSON=')[1].split('\nTOOL_RESULTS_JSON=')[0]);
const wire = reference => Object.fromEntries(['workflowId', 'turnId', 'updatedAt', 'sourceDigest'].filter(key => reference[key] !== undefined).map(key => [key, reference[key]]));
async function until(read) { for (let i = 0; i < 200; i++) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('HTTP conversation did not settle'); }
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-reference-http-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), port: 0 };
  const adapter = new Offline(), app = new Application(config, adapter); await app.workflowFoldersReady; app.backend.state = 'ready';
  app.captureModelRoute = async () => ({ provider: 'fixture', model: 'fixture' });
  const f = { app, adapter, prompts: [], onClassify: () => {}, decision: () => ({ text: '只读排查完成，原工作流未改动。' }) };
  app.assistantModel.generate = async (prompt, options) => {
    const classification = prompt.startsWith('你是工作台的任务意图分类器'); f.prompts.push({ prompt, options, classification });
    if (classification) { await f.onClassify(); return JSON.stringify({ intent: 'diagnose' }); }
    return JSON.stringify(await f.decision(source(prompt), prompt));
  };
  const server = createWorkbenchServer(config, app); f.origin = await server.listen();
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  f.token = (await (await fetch(f.origin + '/api/bootstrap')).json()).csrfToken;
  f.request = async (path, body, headers = {}) => {
    const response = await fetch(f.origin + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Workbench-Token': f.token }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const saved = app.workflowLibrary.save({ document: createDocument({ schemaVersion: 2, title: '聊天引用排错现场' }), expectedRevision: 0 });
  f.saved = saved;
  f.seed = (index, overrides = {}) => {
    const at = new Date(1700000000000 + index * 1000).toISOString();
    const turn = { id: 'http-source-turn-' + index, workflowId: saved.id, clientMessageId: 'http-source-client-' + index,
      user: { text: 'SELECTED_USER_BODY_' + index, intent: 'diagnose', context: { documentRevision: saved.revision } },
      assistant: { text: 'SELECTED_ASSISTANT_BODY_' + index, operations: [{ code: 'PRIVATE_BUSINESS_CODE_SENTINEL' }], checkpoint: { note: 'PRIVATE_CHECKPOINT_SENTINEL' } },
      status: 'error', actions: [], createdAt: at, updatedAt: at, ...overrides };
    app.store.db.prepare('INSERT INTO workflow_conversation_turns(id,workflow_id,client_message_id,created_at,value,private_value) VALUES(?,?,?,?,?,?)')
      .run(turn.id, saved.id, turn.clientMessageId, at, JSON.stringify(turn), JSON.stringify({ document: saved.document, secret: 'PRIVATE_SOURCE_VALUE_SENTINEL' }));
    app.store.db.prepare('INSERT INTO workflow_conversations(workflow_id,revision) VALUES(?,1) ON CONFLICT(workflow_id) DO UPDATE SET revision=revision+1').run(saved.id);
    return turn;
  };
  f.selected = f.seed(1); f.unrelated = f.seed(2, { user: { text: 'UNRELATED_USER_BODY', intent: 'discuss', context: {} }, assistant: { text: 'UNRELATED_ASSISTANT_BODY' } });
  f.feedback = f.seed(3, { user: { text: 'PRIVATE_FEEDBACK_USER_BODY', intent: 'feedback', context: {} }, assistant: { text: 'PRIVATE_FEEDBACK_ASSISTANT_BODY' } });
  f.topic = (await f.request('/api/app-assistant/conversations', { clientConversationId: 'reference-http-topic', title: '总控引用验收' })).body.conversation.id;
  f.path = '/api/app-assistant/conversations/' + f.topic;
  f.finished = async id => until(async () => { const snapshot = await f.request(f.path), turn = snapshot.body.conversation.turns.find(turn => turn.id === id); return turn && turn.status !== 'thinking' && turn; });
  f.pick = async () => {
    const response = await f.request('/api/app-assistant/references?workflowId=' + saved.id); assert.equal(response.status, 200);
    return response.body.turns.find(turn => turn.turnId === f.selected.id);
  };
  f.message = (reference, extra = {}) => ({ clientMessageId: 'reference-message', text: '请只读分析我引用的工作流聊天故障', conversationReferences: [wire(reference)], ...extra });
  f.state = () => ['workflow_documents', 'workflow_conversation_turns', 'workflow_conversations', 'workflow_runs'].map(table =>
    createHash('sha256').update(JSON.stringify(app.store.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all())).digest('hex'));
  f.updateSource = patch => app.store.db.prepare('UPDATE workflow_conversation_turns SET value=? WHERE id=?').run(JSON.stringify({ ...f.selected, ...patch }), f.selected.id);
  f.settings = patch => { const flags = app.assistantPermissionSettings.get(); app.assistantPermissionSettings.save({ expectedRevision: flags.revision, workflow: flags.workflow, supervisor: { ...flags.supervisor, ...patch } }); };
  return f;
}

test('HTTP picker → supervisor message → exact source tool reads the chosen chat only after classification and metadata preparation', async t => {
  const f = await fixture(t), before = f.state(), index = await f.request('/api/app-assistant/references');
  assert.equal(index.status, 200); assert.equal(index.body.workflows[0].workflowId, f.saved.id);
  const reference = await f.pick(); assert(reference.sourceDigest); assert(reference.preview.length <= 150);
  let decisions = 0;
  f.decision = initial => ++decisions === 1 ? { tool: 'conversation.inspect', arguments: initial.conversationReferences[0].read.arguments } : { text: '已读取选中消息中的故障；其余消息未展开。' };
  const started = await f.request(f.path + '/messages', f.message(reference)); assert.equal(started.status, 202);
  const turn = await f.finished(started.body.turn.id);
  assert.equal(turn.status, 'complete'); assert.equal(f.prompts.length, 3); assert.equal(f.prompts[0].classification, true);
  assert.equal(f.prompts[0].prompt.includes('SELECTED_USER_BODY_1'), false); assert.equal(f.prompts[0].prompt.includes('SELECTED_ASSISTANT_BODY_1'), false);
  const initial = source(f.prompts[1].prompt); assert.equal(initial.conversationReferences.length, 1); assert.equal(initial.conversationReferences[0].read.arguments.turnId, f.selected.id);
  assert.equal(f.prompts[1].prompt.includes('SELECTED_USER_BODY_1'), false); assert.equal(f.prompts[1].prompt.includes('SELECTED_ASSISTANT_BODY_1'), false);
  assert.match(f.prompts[2].prompt, /SELECTED_USER_BODY_1/); assert.match(f.prompts[2].prompt, /SELECTED_ASSISTANT_BODY_1/);
  for (const item of f.prompts) for (const forbidden of ['UNRELATED_USER_BODY', 'UNRELATED_ASSISTANT_BODY', 'PRIVATE_FEEDBACK_USER_BODY', 'PRIVATE_FEEDBACK_ASSISTANT_BODY', 'PRIVATE_BUSINESS_CODE_SENTINEL', 'PRIVATE_CHECKPOINT_SENTINEL', 'PRIVATE_SOURCE_VALUE_SENTINEL']) assert.equal(item.prompt.includes(forbidden), false, forbidden);
  const persisted = f.app.applicationAssistant.readTurn(turn.id, f.topic), serialized = JSON.stringify(persisted.user.conversationReferences);
  assert.equal(persisted.user.conversationReferences[0].sourceDigest, reference.sourceDigest); assert.equal(serialized.includes('SELECTED_'), false); assert.equal(serialized.includes('PRIVATE_'), false);
  assert.deepEqual(f.state(), before); assert.deepEqual(f.adapter.calls, []); assert.equal(f.app.workflows.list().length, 0);
});

test('invalid references, unavailable permissions and extra request fields are rejected before a model request', async t => {
  const f = await fixture(t), reference = await f.pick(), body = f.message(reference);
  for (const payload of [{ ...body, conversationReferences: {} }, { ...body, conversationReferences: [{ ...wire(reference), sourceCode: 'not allowed' }] },
    { ...body, conversationReferences: Array.from({ length: 5 }, () => wire(reference)) }, { ...body, transcript: 'copied source body' }]) {
    const response = await f.request(f.path + '/messages', payload); assert.equal(response.status, 400); assert.equal(f.prompts.length, 0);
  }
  const feedback = await f.request(f.path + '/messages', { ...body, conversationReferences: [{ workflowId: f.saved.id, turnId: f.feedback.id }] });
  assert.equal(feedback.status, 403); assert.equal(f.prompts.length, 0);
  f.settings({ crossWorkflowRead: false });
  assert.equal((await f.request('/api/app-assistant/references')).status, 403);
  assert.equal((await f.request(f.path + '/messages', body)).status, 403); assert.equal(f.prompts.length, 0);
  assert.equal(f.app.applicationAssistant.get(f.topic).conversation.turns.length, 0); assert.equal(f.app.assistantPermissionSettings.get().supervisor.sourceRepair, false);
});

test('source changes before submission reject the selected version, while changes between classification and planning are explicitly stale', async t => {
  const f = await fixture(t), reference = await f.pick();
  f.updateSource({ assistant: { text: 'NEW_UNSELECTED_SOURCE_BODY' } });
  const stale = await f.request(f.path + '/messages', f.message(reference)); assert.equal(stale.status, 409); assert.equal(f.prompts.length, 0);
  const fresh = await f.pick();
  f.onClassify = () => f.updateSource({ assistant: { text: 'CHANGED_DURING_CLASSIFICATION_BODY' }, updatedAt: '2026-10-31T12:00:00.000Z' });
  let decisions = 0;
  f.decision = initial => ++decisions === 1 ? { tool: 'conversation.inspect', arguments: initial.conversationReferences[0].read.arguments } : { text: '引用版本已变化，不能把旧引用当当前证据。' };
  const started = await f.request(f.path + '/messages', f.message(fresh, { clientMessageId: 'source-race' })); assert.equal(started.status, 202);
  const turn = await f.finished(started.body.turn.id);
  assert.equal(turn.status, 'complete'); assert.equal(source(f.prompts[1].prompt).conversationReferences[0].status, 'stale');
  assert.equal(f.prompts.some(item => item.prompt.includes('CHANGED_DURING_CLASSIFICATION_BODY')), false);
  assert.equal(f.prompts.some(item => item.prompt.includes('NEW_UNSELECTED_SOURCE_BODY')), false);
  assert.match(f.prompts[2].prompt, /引用消息已变化/);
});

test('same-message recovery never repeats model work and an explicit retry keeps exactly the original reference identity', async t => {
  const f = await fixture(t), reference = await f.pick(), body = f.message(reference); let fail = true;
  f.decision = () => { if (fail) throw Error('FIXTURE_PROVIDER_FAILURE'); return { text: '重试已读取相同引用身份。' }; };
  const started = await f.request(f.path + '/messages', body), parent = await f.finished(started.body.turn.id); assert.equal(parent.status, 'error');
  const calls = f.prompts.length, repeated = await f.request(f.path + '/messages', body);
  assert.equal(repeated.body.turn.id, parent.id); assert.equal(f.prompts.length, calls);
  const changed = await f.request(f.path + '/messages', { ...body, clientMessageId: 'changed-retry', retryOfTurnId: parent.id, conversationReferences: [] });
  assert.equal(changed.status, 409); assert.equal(f.prompts.length, calls);
  fail = false;
  const retried = await f.request(f.path + '/messages', { ...body, clientMessageId: 'same-reference-retry', retryOfTurnId: parent.id }); assert.equal(retried.status, 202);
  const turn = await f.finished(retried.body.turn.id); assert.equal(turn.status, 'complete');
  assert.deepEqual(turn.user.conversationReferences.map(wire), parent.user.conversationReferences.map(wire));
  assert.equal(f.app.workflows.list().length, 0);
});

test('retry comparison accepts equivalent reference fields independent of JSON key order and server-filled optional version fields', async t => {
  const f = await fixture(t); let fail = true;
  f.decision = () => { if (fail) throw Error('FIXTURE_PROVIDER_FAILURE'); return { text: '已按原消息引用续接。' }; };
  const bare = { workflowId: f.saved.id, turnId: f.selected.id }, body = f.message(bare), started = await f.request(f.path + '/messages', body);
  const parent = await f.finished(started.body.turn.id); assert.equal(parent.status, 'error'); fail = false;
  const retry = await f.request(f.path + '/messages', { ...body, clientMessageId: 'normalized-reference-retry', retryOfTurnId: parent.id,
    conversationReferences: [{ turnId: f.selected.id, workflowId: f.saved.id }] });
  assert.equal(retry.status, 202); assert.equal((await f.finished(retry.body.turn.id)).status, 'complete');
});

test('picker HTTP reads do not require CSRF or mutate source chats, while origins, unknown/duplicate queries and untrusted message writes are rejected', async t => {
  const f = await fixture(t), before = f.state();
  assert.equal((await f.request('/api/app-assistant/references')).status, 200);
  for (const path of ['/api/app-assistant/references?path=/outside', '/api/app-assistant/references?workflowId=' + f.saved.id + '&workflowId=' + f.saved.id,
    '/api/app-assistant/references?beforeTurnId=' + f.selected.id]) assert.equal((await f.request(path)).status, 400);
  assert.equal((await f.request('/api/app-assistant/references', undefined, { Origin: 'https://example.com' })).status, 403);
  const reference = await f.pick();
  assert.equal((await f.request(f.path + '/messages', f.message(reference), { 'X-Workbench-Token': 'invalid' })).status, 403);
  assert.equal((await f.request(f.path + '/messages', f.message(reference), { Origin: 'https://example.com' })).status, 403);
  assert.equal(f.prompts.length, 0); assert.deepEqual(f.state(), before); assert.deepEqual(f.adapter.calls, []);
});

test('concurrent retries of the same reference message share its durable turn instead of racing past asynchronous reference admission', async t => {
  const f = await fixture(t), reference = await f.pick(), body = f.message(reference);
  let release; const gate = new Promise(resolve => { release = resolve; }); f.onClassify = () => gate;
  try {
    const results = await Promise.all([f.request(f.path + '/messages', body), f.request(f.path + '/messages', body)]);
    assert.deepEqual(results.map(result => result.status), [202, 202]);
    assert.equal(results[0].body.turn.id, results[1].body.turn.id);
    assert.equal(f.app.applicationAssistant.get(f.topic).conversation.turns.length, 1);
    await until(() => f.prompts.some(item => item.classification));
    assert.equal(f.prompts.filter(item => item.classification).length, 1);
    release(); assert.equal((await f.finished(results[0].body.turn.id)).status, 'complete');
  } finally { release(); }
});
