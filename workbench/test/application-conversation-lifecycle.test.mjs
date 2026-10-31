import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { ApplicationConversationLifecycle } from '../src/application-conversation-lifecycle.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(method) { this.calls.push(method); throw Error('Lifecycle tests must not request Hermes'); }
  async stop() {}
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'supervisor-lifecycle-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), port: 0 };
  const adapter = new Offline(), app = new Application(config, adapter); await app.workflowFoldersReady;
  const owner = app.applicationAssistant, service = new ApplicationConversationLifecycle(app, owner), db = app.store.db;
  let count = 0;
  const create = (extra = {}) => service.create({ clientConversationId: 'fixture-topic-' + ++count, title: '隔离会话 ' + count, ...extra }).conversation;
  const turn = (conversationId, status = 'complete', extra = {}) => {
    const id = 'fixture-turn-' + ++count, at = new Date().toISOString();
    owner.insertTurn({ id, ...(conversationId !== 'global-application' ? { conversationId } : {}), user: { text: '保留的排错消息', intent: 'diagnose' },
      assistant: { text: '保留的诊断结果' }, actions: [], status, createdAt: at, updatedAt: at, ...extra }, id, id, conversationId);
    return id;
  };
  const history = () => db.prepare('SELECT * FROM application_conversation_turns ORDER BY id').all();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, owner, service, db, adapter, create, turn, history };
}
const archive = (f, topic, operationId = 'archive-once') => f.service.change(topic.id, { action: 'archive', operationId, expectedRevision: topic.lifecycleRevision });

test('new supervisor conversation atomically archives only its chosen predecessor and preserves original messages', async t => {
  const f = await fixture(t), first = f.create(), sibling = f.create(); f.turn(first.id); f.turn(sibling.id);
  const before = f.history(), permissions = f.app.assistantPermissionSettings.get();
  const result = f.service.create({ clientConversationId: 'new-and-archive', title: '新的排查', archiveConversationId: first.id, expectedArchiveRevision: 0 });
  assert.equal(result.conversation.lifecycle, 'active'); assert.equal(result.archivedConversation.id, first.id);
  assert.equal(result.archivedConversation.lifecycle, 'archived'); assert.equal(result.archivedConversation.lifecycleRevision, 1);
  assert.match(result.archivedConversation.archivedAt, /^\d{4}-/); assert.equal(f.service.project(sibling.id).lifecycle, 'active');
  assert.equal(f.owner.get(result.conversation.id).conversation.turns.length, 0);
  assert.deepEqual(f.history(), before); assert.deepEqual(f.app.assistantPermissionSettings.get(), permissions);
  assert.deepEqual(f.adapter.calls, []); assert.equal(f.app.workflows.list().length, 0);
});

test('creation retry keeps the original id and archive receipt even after the old conversation is restored', async t => {
  const f = await fixture(t), first = f.create(), input = { clientConversationId: 'replace-idempotent', title: '新的话题', archiveConversationId: first.id, expectedArchiveRevision: 0 };
  const one = f.service.create(input), two = f.service.create(input);
  assert.equal(one.conversation.id, two.conversation.id); assert.equal(two.replayed, true);
  assert.equal(f.db.prepare('SELECT count(*) n FROM application_conversations').get().n, 2);
  f.service.change(first.id, { action: 'restore', operationId: 'restore-after-create', expectedRevision: 1 });
  const again = f.service.create(input); assert.equal(again.conversation.id, one.conversation.id);
  assert.equal(again.archivedConversation.lifecycle, 'active', 'replay reads current state without re-archiving');
  for (const change of [{ title: '更换标题' }, { archiveConversationId: one.conversation.id }, { expectedArchiveRevision: 2 }]) assert.throws(() => f.service.create({ ...input, ...change }), { httpStatus: 409 });
});

test('stale or busy predecessor refuses the complete replacement transaction without creating a new topic', async t => {
  const f = await fixture(t), first = f.create(); f.turn(first.id, 'thinking');
  const input = { clientConversationId: 'busy-replacement', title: '不应被创建', archiveConversationId: first.id, expectedArchiveRevision: 0 };
  assert.throws(() => f.service.create(input), { httpStatus: 409 });
  assert.equal(f.db.prepare('SELECT count(*) n FROM application_conversations').get().n, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM application_conversation_creations').get().n, 1);
  assert.equal(f.service.project(first.id).lifecycle, 'active');
  assert.throws(() => f.service.create({ ...input, expectedArchiveRevision: 999 }), /版本/);
  assert.equal(f.owner.readTurn(f.owner.get(first.id).conversation.turns[0].id, first.id).status, 'thinking', 'archive never stops the active model');
});

test('a failure after predecessor metadata changes rolls back both creation and archival atomically', async t => {
  const f = await fixture(t), first = f.create(); f.turn(first.id); const before = f.history();
  f.db.exec("CREATE TEMP TRIGGER fail_new_topic BEFORE INSERT ON application_conversations WHEN NEW.client_id='insertion-rejected' BEGIN SELECT RAISE(ABORT,'fixture creation rejected'); END");
  assert.throws(() => f.service.create({ clientConversationId: 'insertion-rejected', title: '应原子失败', archiveConversationId: first.id, expectedArchiveRevision: 0 }), /fixture creation rejected/);
  assert.equal(f.service.project(first.id).lifecycle, 'active'); assert.equal(f.service.project(first.id).lifecycleRevision, 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM application_conversation_creations WHERE client_id='insertion-rejected'").get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM application_conversations').get().n, 1); assert.deepEqual(f.history(), before);
});

test('an in-memory model reservation blocks archival even before a thinking row is visible', async t => {
  const f = await fixture(t), topic = f.create(); f.owner.activeConversations.set(topic.id, 'reserved-turn');
  assert.throws(() => archive(f, topic), /仍在回复/); assert.equal(f.service.project(topic.id).lifecycle, 'active');
  f.owner.activeConversations.delete(topic.id); assert.equal(archive(f, topic).conversation.lifecycle, 'archived');
});

test('archived conversations remain readable, can be restored, and never delete or rewrite their original turn identities', async t => {
  const f = await fixture(t), topic = f.create(), id = f.turn(topic.id), before = f.history();
  const result = archive(f, topic); assert.equal(result.conversation.lifecycle, 'archived');
  assert.equal(f.owner.get(topic.id).conversation.turns[0].id, id); assert.throws(() => f.service.assertWritable(topic.id), { httpStatus: 409 });
  assert.equal(f.service.matches(topic.id), false); assert.equal(f.service.matches(topic.id, 'archived'), true); assert.equal(f.service.matches(topic.id, 'all'), true);
  assert.throws(() => f.service.matches(topic.id, 'trash'), /筛选范围/);
  const restored = f.service.change(topic.id, { action: 'restore', operationId: 'restore-once', expectedRevision: 1 });
  assert.equal(restored.conversation.lifecycle, 'active'); assert.equal(restored.conversation.archivedAt, null); assert.equal(restored.conversation.lifecycleRevision, 2);
  assert.doesNotThrow(() => f.service.assertWritable(topic.id)); assert.deepEqual(f.history(), before);
  const replay = archive(f, topic); assert.equal(replay.replayed, true); assert.equal(replay.conversation.lifecycle, 'active'); assert.equal(replay.operation.lifecycle, 'archived');
  assert.throws(() => f.service.change(topic.id, { action: 'restore', operationId: 'archive-once', expectedRevision: 2 }), /操作 ID/);
});

test('legacy global history archives with metadata only and remains at its original identity', async t => {
  const f = await fixture(t), id = f.turn('global-application'), before = f.history();
  const result = f.service.create({ clientConversationId: 'replace-legacy', title: '新的总控会话', archiveConversationId: 'global-application', expectedArchiveRevision: 0 });
  assert.equal(result.archivedConversation.id, 'global-application'); assert.equal(result.archivedConversation.legacy, true);
  assert.equal(f.owner.get('global-application').conversation.turns[0].id, id); assert.deepEqual(f.history(), before);
  assert.equal(f.db.prepare("SELECT count(*) n FROM application_conversations WHERE id='global-application'").get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM application_conversation_membership WHERE turn_id=?').get(id).n, 0);
  f.service.change('global-application', { action: 'restore', operationId: 'restore-legacy', expectedRevision: 1 });
  assert.equal(f.service.project('global-application').lifecycle, 'active');
});

test('running and uncertain maintenance work blocks archiving while waiting permission or continuation may be preserved', async t => {
  const f = await fixture(t);
  for (const status of ['running', 'unknown', 'waiting_permission', 'waiting_continue']) {
    const topic = f.create(), taskId = 'maintenance-' + status;
    f.db.prepare('INSERT INTO assistant_maintenance_tasks VALUES(?,?,?,?)').run(taskId, topic.id, 'source-' + status, JSON.stringify({ id: taskId, conversationId: topic.id, status }));
    if (['running', 'unknown'].includes(status)) assert.throws(() => archive(f, topic, 'archive-' + status), { httpStatus: 409 });
    else assert.equal(archive(f, topic, 'archive-' + status).conversation.lifecycle, 'archived');
  }
  const topic = f.create(), taskId = 'maintenance-unknown-experiment';
  f.db.prepare('INSERT INTO assistant_maintenance_tasks VALUES(?,?,?,?)').run(taskId, topic.id, 'source-experiment', JSON.stringify({ id: taskId, conversationId: topic.id, status: 'stopped' }));
  f.db.prepare('INSERT INTO assistant_maintenance_experiments VALUES(?,?,?,?)').run('experiment-unknown', taskId, 'admission-unknown', JSON.stringify({ id: 'experiment-unknown', status: 'unknown' }));
  assert.throws(() => archive(f, topic, 'archive-experiment-unknown'), /实验结果未确认/);
});

test('persisted unknown mutation receipts and source repairs cannot be hidden by archiving', async t => {
  const f = await fixture(t), topic = f.create();
  f.turn(topic.id, 'error', { assistant: { text: '结果未确认', checkpoint: { mutationReceipts: [{ tool: 'workflow.copy', operationId: 'copy-unknown', status: 'unknown' }] } } });
  assert.throws(() => archive(f, topic), /结果未确认/);
  const other = f.create();
  f.db.prepare('INSERT INTO source_repair_records VALUES(?,?)').run('repair-unknown', JSON.stringify({ id: 'repair-unknown', actor: { conversationId: other.id }, status: 'partial', tests: [] }));
  assert.throws(() => archive(f, other, 'archive-source-unknown'), /源码修复/);
});

test('read-only escalation identity survives archive and restore without becoming an ordinary writable supervisor', async t => {
  const f = await fixture(t), topic = f.create();
  f.turn(topic.id, 'complete', { escalation: { readOnly: true, workflowBound: true, sourceWorkflowId: 'workflow-fixture' } });
  assert.equal(f.service.project(topic.id).readOnly, true);
  assert.equal(archive(f, topic).conversation.readOnly, true);
  const restored = f.service.change(topic.id, { action: 'restore', operationId: 'restore-readonly', expectedRevision: 1 });
  assert.equal(restored.conversation.readOnly, true); assert.equal(restored.conversation.lifecycle, 'active');
});

test('lifecycle metadata and operation receipts survive a new service instance without replaying history or work', async t => {
  const f = await fixture(t), topic = f.create(), id = f.turn(topic.id), before = f.history(); archive(f, topic);
  const restarted = new ApplicationConversationLifecycle(f.app, f.owner);
  assert.equal(restarted.project(topic.id).lifecycle, 'archived');
  const result = restarted.change(topic.id, { action: 'archive', operationId: 'archive-once', expectedRevision: 0 });
  assert.equal(result.replayed, true); assert.equal(result.operation.lifecycleRevision, 1);
  assert.equal(f.owner.readTurn(id, topic.id).user.text, '保留的排错消息'); assert.deepEqual(f.history(), before); assert.deepEqual(f.adapter.calls, []);
});

test('malformed lifecycle input cannot supply roles, accessors, invalid targets or revisions', async t => {
  const f = await fixture(t), topic = f.create(); let invoked = false;
  assert.throws(() => f.service.create({ clientConversationId: 'role-forge', title: 'x', role: 'supervisor' }), /参数/);
  assert.throws(() => f.service.create({ clientConversationId: 'accessor', get title() { invoked = true; return 'x'; } }), /参数/); assert.equal(invoked, false);
  for (const [index, value] of [{ archiveConversationId: '../other', expectedArchiveRevision: 0 }, { archiveConversationId: topic.id }, { expectedArchiveRevision: 0 }].entries()) assert.throws(() => f.service.create({ clientConversationId: 'bad-' + index, title: 'x', ...value }));
  for (const value of [{ action: 'delete' }, { operationId: '../escape' }, { expectedRevision: -1 }, { expectedRevision: 0.5 }, { role: 'supervisor' }]) assert.throws(() => f.service.change(topic.id, { action: 'archive', operationId: 'valid', expectedRevision: 0, ...value }));
  assert.throws(() => f.service.change('missing-topic', { action: 'archive', operationId: 'missing', expectedRevision: 0 }), { httpStatus: 404 });
  assert.equal(f.service.project(topic.id).lifecycle, 'active');
});
