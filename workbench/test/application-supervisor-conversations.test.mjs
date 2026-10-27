import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { createDocument } from '../shared/workflow/workflow-model.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.calls = []; this.serverRequests = new Map(); }
  async request(method) { this.calls.push(method); throw Error('Unexpected Hermes/model/business execution: ' + method); }
  async stop() {}
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'supervisor-conversations-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }),
    port: 0, workflowRunRoot: join(directory, 'runs') };
  const f = { directory, config, prompts: [], events: [], modelResponse: () => ({ text: '已完成当前主题的诊断。' }) };
  f.open = async () => {
    f.adapter = new Offline(); f.app = new Application(config, f.adapter);
    f.app.captureModelRoute = async () => ({ provider: 'fixture-provider', model: 'fixture-model' });
    f.app.assistantModel.generate = async prompt => { f.prompts.push(prompt); return JSON.stringify(await f.modelResponse(prompt)); };
    f.app.on('event', event => f.events.push(event));
    f.bridge = createWorkbenchServer(config, f.app); f.origin = await f.bridge.listen();
    f.token = (await (await fetch(f.origin + '/api/bootstrap')).json()).csrfToken;
  };
  f.close = async () => { if (!f.app.closed) await f.bridge.close(); };
  f.restart = async () => { await f.close(); await f.open(); };
  f.request = async (path, body, headers = {}) => {
    const response = await fetch(f.origin + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Workbench-Token': f.token }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  f.create = async (title, key = 'create-' + crypto.randomUUID()) => {
    const result = await f.request('/api/app-assistant/conversations', { clientConversationId: key, title });
    assert.equal(result.status, 201); return result.body.conversation.id;
  };
  f.path = id => '/api/app-assistant/conversations/' + id;
  f.message = (id, text, extra = {}) => f.request(f.path(id) + '/messages', { clientMessageId: 'client-' + crypto.randomUUID(), text, ...extra });
  f.finished = async (id, turnId) => {
    for (let index = 0; index < 150; index++) {
      const turns = f.app.applicationAssistant.get(id).conversation.turns;
      const turn = turnId ? turns.find(row => row.id === turnId) : turns.at(-1);
      if (turn && turn.status !== 'thinking') return turn;
      await delay(5);
    }
    assert.fail('supervisor fixture did not finish');
  };
  t.after(async () => { await f.close(); await rm(directory, { recursive: true, force: true }); });
  await f.open(); return f;
}
const rows = (app, table) => app.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
function workflowHashes(app) {
  return Object.fromEntries(app.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workflow_%' ORDER BY name").all()
    .map(({ name }) => [name, createHash('sha256').update(JSON.stringify(rows(app, name))).digest('hex')]));
}
function source(prompt) { return JSON.parse(prompt.split('\nSOURCE_JSON=')[1].split('\nTOOL_RESULTS_JSON=')[0]); }
async function replayedConversationEvents(f, expected) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000);
  let reader;
  try {
    const response = await fetch(f.origin + '/api/events?after=0', { signal: controller.signal });
    assert.equal(response.status, 200); reader = response.body.getReader();
    const decoder = new TextDecoder(), events = []; let buffer = '';
    while (events.length < expected) {
      const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n'); buffer = frames.pop();
      for (const frame of frames) {
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        if (data) { const event = JSON.parse(data.slice(6)); if (event.type === 'application.conversation') events.push(event); }
      }
    }
    assert.equal(events.length, expected); return events;
  } finally { clearTimeout(timer); await reader?.cancel(); controller.abort(); }
}

test('migration and directory GET preserve legacy global rows and all existing workflow data', async t => {
  const f = await fixture(t), document = createDocument({ schemaVersion: 2, title: '保留的工作流' });
  f.app.workflowLibrary.save({ document, expectedRevision: 0 });
  const at = '2026-10-26T01:00:00Z', legacy = { id: 'legacy-original', user: { text: 'LEGACY_PRIVATE_SENTINEL', context: {}, intent: 'auto' },
    assistant: { text: '原始已完成的全局记录' }, actions: [], status: 'complete', createdAt: at, updatedAt: at };
  const beforeWorkflow = workflowHashes(f.app); await f.close();
  const db = new DatabaseSync(join(f.config.dataDir, 'workbench.sqlite'));
  db.exec('DROP TABLE application_conversation_membership; DROP TABLE application_conversations');
  db.prepare('INSERT INTO application_conversation_turns(id,client_id,digest,value) VALUES(?,?,?,?)').run(legacy.id, 'legacy-client', 'legacy-digest', JSON.stringify(legacy));
  const originalRows = db.prepare('SELECT * FROM application_conversation_turns ORDER BY rowid').all(); db.close();
  await f.open();
  const directory = await f.request('/api/conversation-hub'), old = await f.request('/api/app-assistant');
  assert.equal(directory.status, 200); assert.equal(directory.body.workflows[0].workflowId, document.id);
  assert.equal(directory.body.supervisors.find(row => row.id === 'global-application').legacy, true);
  assert.equal(old.body.conversation.turns[0].user.text, legacy.user.text);
  assert.deepEqual((await f.request('/api/app-assistant/conversations/global-application')).body, old.body);
  assert.deepEqual(rows(f.app, 'application_conversation_turns'), originalRows);
  assert.equal(rows(f.app, 'application_conversation_membership').length, 0);
  assert.deepEqual(workflowHashes(f.app), beforeWorkflow); assert.deepEqual(f.adapter.calls, []);
});

test('the default conversation directory omits recycled and legacy archived workflows and restores their original conversations', async t => {
  const f = await fixture(t), save = title => f.app.workflowLibrary.save({ document: createDocument({ schemaVersion: 2, title }), expectedRevision: 0 });
  const active = save('正常会话'), recycled = save('回收站会话'), archived = save('旧归档会话');
  f.app.workflowLibrary.transition(recycled.id, 'trash', { expectedRevision: recycled.revision });
  const db = f.app.store.db, at = '2026-10-27T01:00:00Z';
  db.prepare('INSERT INTO workflow_lifecycle(workflow_id,lifecycle,archived_at,trashed_at) VALUES(?,?,?,NULL)').run(archived.id, 'archived', at);
  const turn = { id: 'retained-recycled-turn', workflowId: recycled.id, clientMessageId: 'retained-client', status: 'complete',
    user: { text: '保留的消息', intent: 'discuss', context: {} }, assistant: { text: '保留的回复' }, actions: [], createdAt: at, updatedAt: at };
  db.prepare('INSERT INTO workflow_conversation_turns(id,workflow_id,client_message_id,created_at,value,private_value) VALUES(?,?,?,?,?,?)')
    .run(turn.id, recycled.id, turn.clientMessageId, at, JSON.stringify(turn), '{}');
  const before = workflowHashes(f.app), conversationRows = rows(f.app, 'workflow_conversation_turns');
  for (const query of ['', '?limit=1']) {
    const response = await f.request('/api/conversation-hub' + query);
    assert.equal(response.status, 200); assert.equal(response.body.total, 1);
    assert.deepEqual(response.body.workflows.map(row => row.workflowId), [active.id]);
    assert.equal(response.body.supervisors.length, 1);
  }
  const search = await f.request('/api/conversation-hub?search=' + encodeURIComponent('回收站会话'));
  assert.equal(search.body.total, 0); assert.deepEqual(search.body.workflows, []);
  assert.deepEqual(workflowHashes(f.app), before);
  const current = f.app.workflowLibrary.get(recycled.id);
  f.app.workflowLibrary.transition(recycled.id, 'restore', { expectedRevision: current.revision });
  const restored = (await f.request('/api/conversation-hub')).body.workflows.find(row => row.workflowId === recycled.id);
  assert.equal(restored.lifecycle, 'active'); assert.equal(restored.conversation.turnCount, 1);
  assert.deepEqual(rows(f.app, 'workflow_conversation_turns'), conversationRows); assert.deepEqual(f.adapter.calls, []);
});

test('creating a supervisor topic is idempotent and rejects title conflicts and unauthorized request shapes', async t => {
  const f = await fixture(t), title = '诊断一件具体问题', id = await f.create(title, 'create-one');
  assert.equal(await f.create('  ' + title + '  ', 'create-one'), id);
  assert.equal((await f.request('/api/app-assistant/conversations', { clientConversationId: 'create-one', title: '另一主题' })).status, 409);
  for (const input of [{ clientConversationId: 'empty', title: ' ' }, { clientConversationId: '../bad', title },
    { clientConversationId: 'unknown', title, role: 'supervisor' }, { clientConversationId: 'too-long', title: 'x'.repeat(121) }]) {
    assert.equal((await f.request('/api/app-assistant/conversations', input)).status, 400);
  }
  assert.equal((await f.request('/api/app-assistant/conversations', { clientConversationId: 'forged', title }, { 'X-Workbench-Token': 'invalid' })).status, 403);
  assert.equal((await f.request('/api/app-assistant/conversations', { clientConversationId: 'forged', title }, { Origin: 'http://untrusted.invalid' })).status, 403);
  assert.equal((await f.request(f.path('supervisor-missing'))).status, 404);
  const stored = await f.request(f.path(id)); assert.equal(stored.body.conversation.title, title); assert.equal(stored.body.conversation.turns.length, 0);
  assert.equal((await f.request(f.path(id) + '?role=supervisor')).status, 400);
  assert.equal((await f.request('/api/app-assistant/conversations')).body.supervisors.length, 2);
  assert.deepEqual(f.adapter.calls, []);
});

test('the same client message ID can carry different content in distinct topics while retries stay idempotent', async t => {
  const f = await fixture(t), a = await f.create('主题 A'), b = await f.create('主题 B');
  const first = await f.message(a, 'A 的独立问题', { clientMessageId: 'shared-client' });
  const second = await f.message(b, 'B 的独立问题', { clientMessageId: 'shared-client' });
  const [ta, tb] = await Promise.all([f.finished(a, first.body.turn.id), f.finished(b, second.body.turn.id)]);
  assert.notEqual(ta.id, tb.id); assert.equal(ta.conversationId, a); assert.equal(tb.conversationId, b);
  assert.equal(f.app.applicationAssistant.get(a).conversation.turns[0].user.text, 'A 的独立问题');
  assert.equal(f.app.applicationAssistant.get(b).conversation.turns[0].user.text, 'B 的独立问题');
  assert.equal(f.app.applicationAssistant.get().conversation.turns.length, 0);
  const repeated = await f.message(a, 'A 的独立问题', { clientMessageId: 'shared-client' });
  assert.equal(repeated.body.turn.id, ta.id); assert.equal(f.prompts.length, 2);
  assert.equal((await f.message(a, '另一问题', { clientMessageId: 'shared-client' })).status, 409);
});

test('actual model prompts, checkpoints and conversation event payloads stay inside their supervisor topic', async t => {
  const f = await fixture(t), a = await f.create('主题 A'), b = await f.create('主题 B');
  await f.message(a, 'CASE_A_PRIVATE_SENTINEL'); const firstA = await f.finished(a);
  await f.message(b, 'CASE_B_PRIVATE_SENTINEL'); const firstB = await f.finished(b);
  await f.message(a, 'CASE_A_FOLLOW_UP'); await f.finished(a);
  assert.equal(f.prompts.length, 3);
  assert.equal(source(f.prompts[0]).recentConversation.length, 0); assert.equal(source(f.prompts[1]).recentConversation.length, 0);
  assert.match(JSON.stringify(source(f.prompts[2]).recentConversation), /CASE_A_PRIVATE_SENTINEL/);
  assert.equal(f.prompts[1].includes('CASE_A_PRIVATE_SENTINEL'), false); assert.equal(f.prompts[2].includes('CASE_B_PRIVATE_SENTINEL'), false);
  assert.notEqual(firstA.assistant.checkpoint.scope, firstB.assistant.checkpoint.scope);
  const conversationEvents = f.events.filter(event => event.type === 'application.conversation');
  assert(conversationEvents.length > 0);
  const streamed = await replayedConversationEvents(f, conversationEvents.length);
  for (const event of [...conversationEvents, ...streamed]) {
    const body = event.payload; assert([a, b].includes(body.conversationId));
    assert(body.conversation.turns.every(turn => turn.conversationId === body.conversationId));
    assert.equal(JSON.stringify(body).includes(body.conversationId === a ? 'CASE_B_PRIVATE_SENTINEL' : 'CASE_A_PRIVATE_SENTINEL'), false);
  }
  assert.deepEqual(f.adapter.calls, []);
});

test('failed checkpoint continuation and reply/retry/action targets cannot cross supervisor topics', async t => {
  const f = await fixture(t), a = await f.create('主题 A'), b = await f.create('主题 B'), captured = [];
  f.app.applicationAssistant.plan = async options => {
    captured.push(options);
    if (options.text === 'A 独立失败') { options.onCheckpoint({ version: 1, scope: 'A_CHECKPOINT_SENTINEL', evidence: [], steps: [] }); throw Error('A 失败'); }
    return { text: '主题 B 已完成' };
  };
  await f.message(a, 'A 独立失败'); const failed = await f.finished(a);
  await f.message(b, 'B 独立问题'); await f.finished(b);
  assert.equal(captured[1].checkpoint, undefined); assert.equal(captured[1].history.length, 0);
  const beforeA = f.app.applicationAssistant.get(a), beforeB = f.app.applicationAssistant.get(b);
  assert.equal((await f.message(b, failed.user.text, { retryOfTurnId: failed.id })).status, 404);
  assert.equal((await f.message(b, '这个问题解决了', { replyToTurnId: failed.id })).status, 404);
  assert.equal((await f.request(f.path(b) + '/turns/' + failed.id + '/action', { action: 'dismiss-turn' })).status, 404);
  assert.equal((await f.request('/api/app-assistant/turns/' + failed.id + '/action', { action: 'dismiss-turn' })).status, 404);
  assert.deepEqual(f.app.applicationAssistant.get(a), beforeA); assert.deepEqual(f.app.applicationAssistant.get(b), beforeB);
  await f.message(a, failed.user.text, { retryOfTurnId: failed.id }); await f.finished(a);
  assert.equal(captured.at(-1).checkpoint.scope, 'A_CHECKPOINT_SENTINEL');
  assert.equal(JSON.stringify(captured.at(-1).history).includes('B 独立问题'), false);
  assert.equal(captured.at(-1).sourceConversationId, a);
});

test('one active turn blocks only its own topic and independent topics can diagnose concurrently', async t => {
  const f = await fixture(t), a = await f.create('主题 A'), b = await f.create('主题 B'), pending = new Map();
  f.app.applicationAssistant.plan = async options => new Promise(resolve => { pending.set(options.sourceConversationId, resolve); });
  const first = await f.message(a, 'A 等待诊断'), second = await f.message(b, 'B 等待诊断');
  assert.equal(first.status, 202); assert.equal(second.status, 202); assert.equal(pending.size, 2);
  assert.equal((await f.message(a, 'A 不应并发')).status, 409);
  assert.equal(f.app.applicationAssistant.get(a).conversation.turns.length, 1);
  pending.get(b)({ text: 'B 独立完成' }); await f.finished(b, second.body.turn.id);
  assert.equal(f.app.applicationAssistant.get(a).conversation.turns[0].status, 'thinking');
  pending.get(a)({ text: 'A 独立完成' }); await f.finished(a, first.body.turn.id);
  assert.equal(f.app.applicationAssistant.activeConversations.size, 0); assert.equal(f.app.applicationAssistant.active.size, 0);
});

test('new topics and their membership survive restart while uncompleted work is recovered without replay', async t => {
  const f = await fixture(t), a = await f.create('持久主题 A'), b = await f.create('持久主题 B');
  await f.message(a, 'A 完成历史'); const complete = await f.finished(a);
  const savedComplete = rows(f.app, 'application_conversation_turns').find(row => row.id === complete.id);
  f.app.applicationAssistant.plan = async () => new Promise(() => {});
  const interrupted = await f.message(b, 'B 未结束历史');
  await f.restart();
  assert.equal(f.app.applicationAssistant.get(a).conversation.turns[0].id, complete.id);
  assert.deepEqual(rows(f.app, 'application_conversation_turns').find(row => row.id === complete.id), savedComplete);
  const recovered = f.app.applicationAssistant.get(b).conversation.turns[0];
  assert.equal(recovered.id, interrupted.body.turn.id); assert.equal(recovered.status, 'interrupted');
  assert.equal(f.app.applicationAssistant.get().conversation.turns.length, 0);
  const listing = await f.request('/api/app-assistant/conversations');
  for (const id of [a, b, 'global-application']) assert(listing.body.supervisors.some(row => row.id === id));
  assert.equal(f.app.applicationAssistant.active.size, 0); assert.deepEqual(f.adapter.calls, []);
  assert.equal(rows(f.app, 'application_conversation_membership').length, 2);
});

test('a successful explicit retry clears topic pending count without rewriting the original failed record', async t => {
  const f = await fixture(t), id = await f.create('重试后收起待处理');
  f.modelResponse = () => { throw Error('ORIGINAL_FAILED_DIAGNOSIS'); };
  await f.message(id, '检查同一项失败原因'); const failed = await f.finished(id);
  assert.equal(failed.status, 'error'); assert.match(failed.assistant.text, /ORIGINAL_FAILED_DIAGNOSIS/);
  const original = rows(f.app, 'application_conversation_turns').find(row => row.id === failed.id);
  assert.equal(f.app.applicationAssistant.listConversations().find(row => row.id === id).pendingCount, 1);
  f.modelResponse = () => ({ text: '显式重试已成功完成诊断。' });
  const response = await f.message(id, failed.user.text, { retryOfTurnId: failed.id });
  const retried = await f.finished(id, response.body.turn.id);
  assert.equal(retried.status, 'complete'); assert.equal(retried.retryOfTurnId, failed.id);
  assert.equal(f.app.applicationAssistant.listConversations().find(row => row.id === id).pendingCount, 0);
  const directory = await f.request('/api/conversation-hub');
  assert.equal(directory.body.supervisors.find(row => row.id === id).pendingCount, 0);
  const projected = f.app.applicationAssistant.get(id).conversation.turns.find(turn => turn.id === failed.id);
  assert.equal(projected.status, 'error'); assert.equal(projected.pendingState.status, 'superseded');
  assert.match(projected.assistant.text, /ORIGINAL_FAILED_DIAGNOSIS/);
  assert.deepEqual(rows(f.app, 'application_conversation_turns').find(row => row.id === failed.id), original);
});
