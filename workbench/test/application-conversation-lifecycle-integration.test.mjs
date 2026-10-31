import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { createDocument, createNode } from '../shared/workflow/workflow-model.mjs';
import { documentFingerprint } from '../shared/workflow/workflow-conversation-commands.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(method) { this.calls.push(method); throw Error('Unexpected real Hermes request: ' + method); }
  async stop() {}
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-lifecycle-http-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(root, 'data'), WORKBENCH_WORKSPACE_ROOT: join(root, 'workspace') }), port: 0 };
  const adapter = new Offline(), app = new Application(config, adapter); await app.workflowFoldersReady;
  const owner = app.applicationAssistant, calls = [];
  app.captureModelRoute = async () => ({ provider: 'fixture', model: 'fixture' });
  app.assistantModel.generate = async prompt => { calls.push(prompt); return JSON.stringify(prompt.startsWith('你是工作台的任务意图分类器') ? { intent: 'discuss' } : { text: '记录保留，无业务操作。' }); };
  const document = createDocument({ schemaVersion: 2, title: '归档HTTP隔离现场' });
  document.nodes = [createNode('tool', {}, { id: 'code', config: { executionMode: 'code', language: 'javascript', code: 'return input;' } })];
  const saved = app.workflowLibrary.save({ document, expectedRevision: 0 });
  await Promise.allSettled([...app.workflowFolders.pending.values()]);
  const server = createWorkbenchServer(config, app), origin = await server.listen();
  const token = (await (await fetch(origin + '/api/bootstrap')).json()).csrfToken;
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const request = async (path, body) => {
    const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Workbench-Token': token, Origin: origin },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  let sequence = 0;
  const create = async extra => {
    const result = await request('/api/app-assistant/conversations', { clientConversationId: 'http-topic-' + ++sequence, title: '总控HTTP ' + sequence, ...extra });
    assert.equal(result.status, 201); return result.body.conversation;
  };
  const path = topic => '/api/app-assistant/conversations/' + topic.id;
  const seed = (topic, status = 'complete', extra = {}) => {
    const id = 'http-seeded-turn-' + ++sequence, at = new Date().toISOString();
    owner.insertTurn({ id, conversationId: topic.id, user: { text: '原聊天内容', intent: 'diagnose' }, assistant: { text: '原诊断记录' }, actions: [], status, createdAt: at, updatedAt: at, ...extra }, id, id, topic.id);
    return id;
  };
  const state = () => Object.fromEntries(['workflow_documents', 'workflow_runs', 'workflow_conversation_turns', 'workflow_conversations',
    'application_conversation_turns', 'application_conversation_membership', 'workflow_artifacts', 'assistant_permission_settings']
    .map(table => [table, hash(app.store.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all())]));
  const finish = async (topic, id) => {
    for (let i = 0; i < 200; i++) { const turn = owner.readTurn(id, topic.id); if (!['thinking', 'queued'].includes(turn.status)) return turn; await delay(5); }
    assert.fail('isolated message did not settle');
  };
  const archive = async (topic, operationId = 'archive-http') => request(path(topic) + '/lifecycle', { action: 'archive', operationId, expectedRevision: topic.lifecycleRevision });
  return { root, app, owner, adapter, saved, calls, request, create, path, seed, state, finish, archive };
}

test('HTTP new conversation archives only its predecessor and directory groups history without changing chat or workflow rows', async t => {
  const f = await fixture(t), current = await f.create(), sibling = await f.create(); f.seed(current); f.seed(sibling);
  const before = f.state();
  const replacement = await f.create({ archiveConversationId: current.id, expectedArchiveRevision: current.lifecycleRevision });
  assert.equal(replacement.lifecycle, 'active');
  const read = await f.request(f.path(current)); assert.equal(read.status, 200); assert.equal(read.body.conversation.lifecycle, 'archived'); assert.equal(read.body.conversation.turns[0].user.text, '原聊天内容');
  const active = await f.request('/api/app-assistant/conversations');
  assert.equal(active.body.supervisors.some(row => row.id === current.id), false);
  assert(active.body.supervisors.some(row => row.id === sibling.id)); assert(active.body.supervisors.some(row => row.id === replacement.id));
  const grouped = await f.request('/api/conversation-hub');
  assert(grouped.body.archivedSupervisors.some(row => row.id === current.id)); assert.equal(grouped.body.supervisors.some(row => row.id === current.id), false);
  assert.deepEqual(f.state(), before); assert.deepEqual(f.adapter.calls, []); assert.equal(f.app.assistantPermissionSettings.get().supervisor.sourceRepair, false);
});

test('archived HTTP messages refuse a new client while an original client id still reads its immutable receipt', async t => {
  const f = await fixture(t), topic = await f.create(), message = { clientMessageId: 'persisted-original-client', text: '解释当前工作台能力' };
  const sent = await f.request(f.path(topic) + '/messages', message); assert.equal(sent.status, 202);
  const turn = await f.finish(topic, sent.body.turn.id); assert.equal(turn.status, 'complete'); assert.equal(f.calls.length, 2);
  const before = f.state(); assert.equal((await f.archive(topic)).status, 200);
  const retry = await f.request(f.path(topic) + '/messages', message); assert.equal(retry.status, 202); assert.equal(retry.body.turn.id, turn.id);
  const fresh = await f.request(f.path(topic) + '/messages', { ...message, clientMessageId: 'new-client-after-archive' });
  assert.equal(fresh.status, 409); assert.match(fresh.body.error, /归档/);
  const altered = await f.request(f.path(topic) + '/messages', { ...message, text: '另一条消息' }); assert.equal(altered.status, 409);
  assert.equal(f.calls.length, 2); assert.deepEqual(f.state(), before);
});

test('archived proposals cannot apply to a workflow and safe stop remains available without changing history', async t => {
  const f = await fixture(t), topic = await f.create(), turnId = f.seed(topic, 'proposed', { assistant: { text: '待应用候选',
    targetWorkflowId: f.saved.id, expectedRevision: f.saved.revision, baseFingerprint: documentFingerprint(f.saved.document),
    operations: [{ op: 'update-node', nodeId: 'code', config: { code: 'return { altered: true };' } }] } });
  const before = f.state(); assert.equal((await f.archive(topic)).status, 200);
  const action = f.path(topic) + '/turns/' + turnId + '/action';
  const apply = await f.request(action, { action: 'mark-applied' }); assert.equal(apply.status, 409); assert.match(apply.body.error, /归档/);
  const dismiss = await f.request(action, { action: 'dismiss-turn' }); assert.equal(dismiss.status, 409);
  const stop = await f.request(action, { action: 'interrupt-turn' }); assert.equal(stop.status, 200); assert.equal(stop.body.conversation.lifecycle, 'archived');
  assert.deepEqual(f.state(), before); assert.equal(f.app.workflowLibrary.get(f.saved.id).revision, f.saved.revision); assert.deepEqual(f.adapter.calls, []);
});

test('an HTTP message paused in attachment resolution cannot insert a late turn after archival', async t => {
  const f = await fixture(t), topic = await f.create();
  const attachment = await f.app.workflowAttachments.upload(f.saved.id, { name: '诊断输入.txt', mimeType: 'text/plain', operationId: 'http-upload' }, Buffer.from('isolated material'));
  const entered = deferred(), gate = deferred(), original = f.app.workflowAttachments.resolve.bind(f.app.workflowAttachments);
  f.app.workflowAttachments.resolve = async (...args) => { const value = await original(...args); entered.resolve(); await gate.promise; return value; };
  const before = f.state();
  const pending = f.request(f.path(topic) + '/messages', { clientMessageId: 'paused-attachment-client', text: '查看素材', context: { workflowId: f.saved.id }, attachments: [{ workflowId: f.saved.id, id: attachment.id }] });
  await entered.promise;
  const archived = await f.archive(topic); assert.equal(archived.status, 200); gate.resolve();
  const response = await pending; assert.equal(response.status, 409); assert.match(response.body.error, /归档/);
  assert.deepEqual(f.state(), before); assert.equal(f.calls.length, 0); assert.deepEqual(f.adapter.calls, []);
});

test('an HTTP message paused while resolving an exact workflow chat reference cannot bypass archived write admission', async t => {
  const f = await fixture(t), topic = await f.create(), db = f.app.store.db, at = new Date().toISOString();
  const source = { id: 'referenced-source-turn', workflowId: f.saved.id, clientMessageId: 'source-client', user: { text: '工作流中的错误', intent: 'diagnose' },
    assistant: { text: '实际错误证据' }, status: 'error', actions: [], createdAt: at, updatedAt: at };
  db.prepare('INSERT INTO workflow_conversation_turns(id,workflow_id,client_message_id,created_at,value,private_value) VALUES(?,?,?,?,?,?)')
    .run(source.id, source.workflowId, source.clientMessageId, at, JSON.stringify(source), '{}');
  db.prepare('INSERT INTO workflow_conversations(workflow_id,revision) VALUES(?,1) ON CONFLICT(workflow_id) DO UPDATE SET revision=revision+1').run(f.saved.id);
  const entered = deferred(), gate = deferred(), original = f.owner.references.resolve.bind(f.owner.references);
  f.owner.references.resolve = async (...args) => { const value = await original(...args); entered.resolve(); await gate.promise; return value; };
  const before = f.state();
  const pending = f.request(f.path(topic) + '/messages', { clientMessageId: 'paused-reference-client', text: '排查引用消息', conversationReferences: [{ workflowId: source.workflowId, turnId: source.id, updatedAt: source.updatedAt }] });
  await entered.promise; assert.equal((await f.archive(topic)).status, 200); gate.resolve();
  const response = await pending; assert.equal(response.status, 409); assert.match(response.body.error, /归档/);
  assert.deepEqual(f.state(), before); assert.equal(f.calls.length, 0); assert.deepEqual(f.adapter.calls, []);
});

test('a proposal paused in permission checks cannot mutate its workflow after the topic is archived', async t => {
  const f = await fixture(t), topic = await f.create(), turnId = f.seed(topic, 'proposed', { assistant: { text: '待应用',
    targetWorkflowId: f.saved.id, expectedRevision: f.saved.revision, baseFingerprint: documentFingerprint(f.saved.document),
    operations: [{ op: 'update-node', nodeId: 'code', config: { code: 'return { changed: true };' } }] } });
  const entered = deferred(), gate = deferred(), original = f.owner.permissions.document.bind(f.owner.permissions);
  f.owner.permissions.document = async (...args) => { const value = await original(...args); entered.resolve(); await gate.promise; return value; };
  const before = f.state(), pending = f.request(f.path(topic) + '/turns/' + turnId + '/action', { action: 'mark-applied' });
  await entered.promise; assert.equal((await f.archive(topic)).status, 200); gate.resolve();
  const response = await pending; assert.equal(response.status, 409); assert.match(response.body.error, /归档/); assert.deepEqual(f.state(), before);
});

test('a restored source-bound read-only child rejects ordinary messages and stays read-only in the HTTP directory', async t => {
  const f = await fixture(t), topic = await f.create(); f.seed(topic, 'complete', { escalation: { readOnly: true, workflowBound: true, sourceWorkflowId: f.saved.id } });
  assert.equal((await f.request(f.path(topic))).body.conversation.readOnly, true);
  assert.equal((await f.archive(topic)).status, 200);
  const restored = await f.request(f.path(topic) + '/lifecycle', { action: 'restore', operationId: 'restore-readonly-http', expectedRevision: 1 });
  assert.equal(restored.status, 200); assert.equal(restored.body.conversation.readOnly, true);
  const before = f.state(), result = await f.request(f.path(topic) + '/messages', { clientMessageId: 'cannot-promote-child', text: '修复软件并修改代码' });
  assert.equal(result.status, 403); assert.match(result.body.error, /只读诊断/);
  const directory = await f.request('/api/app-assistant/conversations'); assert.equal(directory.body.supervisors.find(row => row.id === topic.id).readOnly, true);
  assert.deepEqual(f.state(), before); assert.equal(f.calls.length, 0); assert.equal(f.app.assistantPermissionSettings.get().supervisor.sourceRepair, false);
});

test('a real rejected maintenance lookup leaves no experiment admission and does not permanently prevent archival', async t => {
  for (const name of ['maintenance.task', 'maintenance.experiment']) await t.test(name, async sub => {
    const f = await fixture(sub), topic = await f.create();
    f.app.assistantModel.generate = async prompt => {
      f.calls.push(prompt); if (prompt.startsWith('你是工作台的任务意图分类器')) return JSON.stringify({ intent: 'diagnose' });
      const task = f.owner.maintenance.latest(topic.id);
      return JSON.stringify(name === 'maintenance.task' ? { tool: name, arguments: { action: 'inspect', taskId: 'maintenance-does-not-exist' } }
        : { tool: name, arguments: { action: 'status', taskId: task.id, experimentId: 'experiment-does-not-exist' } });
    };
    const message = await f.request(f.path(topic) + '/messages', { clientMessageId: 'rejected-lookup', text: '排查故障，保留原流程', context: { workflowId: f.saved.id } });
    assert.equal(message.status, 202); const turn = await f.finish(topic, message.body.turn.id);
    assert.equal(turn.status, 'error'); assert.match(turn.assistant.text, /不存在/);
    assert(turn.assistant.checkpoint.mutationReceipts.some(receipt => receipt.tool === name && receipt.status === 'unknown'));
    assert.equal(f.owner.maintenance.latest(topic.id).status, 'ready');
    assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM assistant_maintenance_experiments').get().n, 0);
    const before = f.state(), archived = await f.archive(topic); assert.equal(archived.status, 200); assert.equal(archived.body.conversation.lifecycle, 'archived');
    assert.deepEqual(f.state(), before); assert.equal(f.app.workflows.list().length, 0); assert.deepEqual(f.adapter.calls, []);
  });
});

test('a genuinely admitted experiment with an unknown terminal receipt still blocks archival', async t => {
  const f = await fixture(t), topic = await f.create(); let decisions = 0, executions = 0;
  f.owner.maintenance.reproduce = async () => { executions++; return { status: 'unknown', sandbox: { kind: 'macos-seatbelt', status: 'verified' } }; };
  f.app.assistantModel.generate = async prompt => {
    f.calls.push(prompt); if (prompt.startsWith('你是工作台的任务意图分类器')) return JSON.stringify({ intent: 'diagnose' });
    if (decisions++) return JSON.stringify({ text: '隔离回执尚未确认，未继续修复或重放。' });
    const task = f.owner.maintenance.latest(topic.id);
    return JSON.stringify({ tool: 'maintenance.experiment', arguments: { action: 'reproduce', taskId: task.id, expectedRevision: task.revision, nodeId: 'code' } });
  };
  const message = await f.request(f.path(topic) + '/messages', { clientMessageId: 'unknown-real-admission', text: '排查并复现测试节点', context: { workflowId: f.saved.id } });
  assert.equal(message.status, 202); const turn = await f.finish(topic, message.body.turn.id); assert.equal(turn.status, 'complete');
  assert.equal(executions, 1); const task = f.owner.maintenance.latest(topic.id); assert.equal(task.status, 'unknown');
  const experiment = f.owner.maintenance.readExperiment(task.lastExperimentId); assert.equal(experiment.status, 'unknown');
  const result = await f.archive(topic); assert.equal(result.status, 409); assert.match(result.body.error, /未确认/);
  assert.equal(f.owner.lifecycle.project(topic.id).lifecycle, 'active'); assert.equal(executions, 1); assert.equal(f.app.workflows.list().length, 0);
  assert.equal(f.app.assistantPermissionSettings.get().supervisor.sourceRepair, false); assert.deepEqual(f.adapter.calls, []);
});
