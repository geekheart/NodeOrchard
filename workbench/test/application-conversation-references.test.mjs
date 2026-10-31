import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument } from '../shared/workflow/workflow-model.mjs';
import { ApplicationConversationReferences } from '../src/application-conversation-references.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(method) { this.calls.push(method); throw Error('No native/model/workflow call is permitted in this fixture'); }
  async stop() {}
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-references-'));
  const app = new Application({ ...readConfig({ WORKBENCH_DATA_DIR: join(root, 'data'), WORKBENCH_WORKSPACE_ROOT: join(root, 'workspace') }), port: 0 }, new Offline());
  await app.workflowFoldersReady;
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const owner = app.applicationAssistant, refs = new ApplicationConversationReferences(app, owner);
  const save = (title, mode = 'execute') => app.workflowLibrary.save({ document: { ...createDocument({ schemaVersion: 2, title }), mode }, expectedRevision: 0 });
  const first = save('第一条诊断流程'), second = save('另一条流程');
  const context = { permissionScope: await owner.permissions.bind({ role: 'supervisor' }) };
  const seed = (record, index, overrides = {}) => {
    const at = new Date(1700000000000 + index * 1000).toISOString();
    const turn = { id: 'reference-turn-' + index, workflowId: record.id, clientMessageId: 'reference-client-' + index,
      user: { text: '请查明故障 ' + index, intent: 'diagnose', context: { documentRevision: record.revision } },
      assistant: { text: '发现实际错误 ' + index, operations: [{ code: 'BUSINESS_CODE_SENTINEL' }], checkpoint: { private: 'PRIVATE_CHECKPOINT_SENTINEL' } },
      status: 'error', actions: [], createdAt: at, updatedAt: at, ...overrides };
    app.store.db.prepare('INSERT INTO workflow_conversation_turns(id,workflow_id,client_message_id,created_at,value,private_value) VALUES(?,?,?,?,?,?)')
      .run(turn.id, record.id, turn.clientMessageId, at, JSON.stringify(turn), JSON.stringify({ document: record.document, secret: 'PRIVATE_RECORD_SENTINEL' }));
    app.store.db.prepare('INSERT INTO workflow_conversations(workflow_id,revision) VALUES(?,1) ON CONFLICT(workflow_id) DO UPDATE SET revision=revision+1').run(record.id);
    return turn;
  };
  const settings = async patch => {
    const value = app.assistantPermissionSettings.get();
    app.assistantPermissionSettings.save({ expectedRevision: value.revision, workflow: value.workflow, supervisor: { ...value.supervisor, ...patch } });
    return { permissionScope: await owner.permissions.bind({ role: 'supervisor' }) };
  };
  const input = turn => ({ workflowId: turn.workflowId, turnId: turn.id, updatedAt: turn.updatedAt });
  const update = (turn, patch) => app.store.db.prepare('UPDATE workflow_conversation_turns SET value=? WHERE id=?').run(JSON.stringify({ ...turn, ...patch }), turn.id);
  const state = () => ['workflow_documents', 'workflow_conversation_turns', 'workflow_conversations', 'workflow_runs', 'assistant_permission_settings'].map(table => {
    const rows = app.store.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all();
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  });
  return { app, owner, refs, first, second, seed, settings, context, input, update, save, state };
}
const wire = reference => Object.fromEntries(['workflowId', 'turnId', 'updatedAt', 'sourceDigest'].map(key => [key, reference[key]]));

test('references persist only exact identity metadata and expose a bounded read pointer without copying source history', async t => {
  const f = await fixture(t), selected = f.seed(f.first, 1), other = f.seed(f.first, 2), before = f.state();
  const [reference] = await f.refs.resolve([f.input(selected)], f.context);
  assert.equal(reference.turnId, selected.id); assert.equal(reference.workflowId, f.first.id); assert.equal(reference.workflowTitle, f.first.document.title);
  assert.equal(reference.status, 'current'); assert.match(reference.sourceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(reference.read, { tool: 'conversation.inspect', arguments: { workflowId: f.first.id, turnId: selected.id, expectedUpdatedAt: selected.updatedAt, sourceDigest: reference.sourceDigest } });
  const serialized = JSON.stringify(reference);
  for (const forbidden of [selected.user.text, selected.assistant.text, other.user.text, 'BUSINESS_CODE_SENTINEL', 'PRIVATE_CHECKPOINT_SENTINEL', 'PRIVATE_RECORD_SENTINEL']) assert.equal(serialized.includes(forbidden), false);
  assert.deepEqual(await f.refs.project([reference], f.context), [reference]);
  assert.deepEqual(f.state(), before); assert.deepEqual(f.app.adapter.calls, []); assert.equal(f.app.workflows.list().length, 0);
});

test('the actual conversation.inspect dispatcher reads one referenced turn with its version and no unrelated pending conversation', async t => {
  const f = await fixture(t), selected = f.seed(f.first, 1); f.seed(f.first, 2); f.seed(f.second, 3);
  const [reference] = await f.refs.resolve([f.input(selected)], f.context);
  const result = await f.owner.call('conversation.inspect', reference.read.arguments, { permissionScope: f.context.permissionScope });
  assert.equal(result.exact, true); assert.equal(result.turns.length, 1); assert.equal(result.turns[0].id, selected.id);
  assert.equal(result.turns[0].user.text, selected.user.text); assert.equal(result.turns[0].assistant.text, selected.assistant.text);
  assert.deepEqual(result.pending, []); assert.equal(result.hasMore, false); assert.equal(result.sourceDigest, reference.sourceDigest);
  const serialized = JSON.stringify(result);
  for (const forbidden of ['BUSINESS_CODE_SENTINEL', 'PRIVATE_CHECKPOINT_SENTINEL', 'PRIVATE_RECORD_SENTINEL', f.second.id]) assert.equal(serialized.includes(forbidden), false);
  for (const extra of [{ beforeTurnId: selected.id }, { limit: 1 }, { expectedUpdatedAt: 'invalid' }, { sourceDigest: 'invalid' }]) {
    await assert.rejects(f.owner.call('conversation.inspect', { ...reference.read.arguments, ...extra }, { permissionScope: f.context.permissionScope }), { httpStatus: 400 });
  }
  await assert.rejects(f.owner.call('conversation.inspect', { workflowId: f.first.id, expectedUpdatedAt: selected.updatedAt }, { permissionScope: f.context.permissionScope }), { httpStatus: 400 });
});

test('source body changes at the same timestamp are stale and never silently substitute current text for a selected reference', async t => {
  const f = await fixture(t), turn = f.seed(f.first, 1), [reference] = await f.refs.resolve([f.input(turn)], f.context);
  f.update(turn, { assistant: { text: 'NEW_SOURCE_BODY_SENTINEL' } });
  const [projected] = await f.refs.project([reference], f.context);
  assert.equal(projected.status, 'stale'); assert.equal(projected.sourceDigest, reference.sourceDigest);
  assert.equal(JSON.stringify(projected).includes('NEW_SOURCE_BODY_SENTINEL'), false);
  await assert.rejects(f.refs.resolve([wire(reference)], f.context), { httpStatus: 409 });
  await assert.rejects(f.owner.call('conversation.inspect', reference.read.arguments, { permissionScope: f.context.permissionScope }), { httpStatus: 409 });
  const fresh = await f.owner.call('conversation.inspect', { workflowId: f.first.id, turnId: turn.id }, { permissionScope: f.context.permissionScope });
  assert.equal(fresh.turns[0].assistant.text, 'NEW_SOURCE_BODY_SENTINEL'); assert.notEqual(fresh.sourceDigest, reference.sourceDigest);
});

test('updated source versions, foreign ownership and deleted sources are explicitly rejected or unavailable', async t => {
  const f = await fixture(t), turn = f.seed(f.first, 1), [reference] = await f.refs.resolve([f.input(turn)], f.context);
  f.update(turn, { updatedAt: new Date(1700000009999).toISOString() });
  assert.equal((await f.refs.project([reference], f.context))[0].status, 'stale');
  await assert.rejects(f.refs.resolve([{ ...f.input(turn), workflowId: f.second.id }], f.context), { httpStatus: 404 });
  f.app.store.db.prepare('DELETE FROM workflow_conversation_turns WHERE id=?').run(turn.id);
  assert.equal((await f.refs.project([reference], f.context))[0].status, 'unavailable');
});

test('recycled workflows are omitted from picker and become unavailable without changing or deleting their conversations', async t => {
  const f = await fixture(t), turn = f.seed(f.first, 1), [reference] = await f.refs.resolve([f.input(turn)], f.context);
  f.app.store.db.prepare('INSERT INTO workflow_lifecycle(workflow_id,lifecycle,trashed_at) VALUES(?,?,?)').run(f.first.id, 'trashed', new Date().toISOString());
  const before = f.state();
  assert.deepEqual((await f.refs.options({}, f.context)).workflows, []);
  assert.equal((await f.refs.project([reference], f.context))[0].status, 'unavailable');
  await assert.rejects(f.refs.resolve([wire(reference)], f.context), { httpStatus: 409 });
  await assert.rejects(f.refs.options({ workflowId: f.first.id }, f.context), { httpStatus: 409 });
  assert.deepEqual(f.state(), before); assert.equal(f.app.conversations.readTurn(f.first.id, turn.id).turn.id, turn.id);
});

test('learning and feedback records remain hidden from both picker and selected-reference resolution', async t => {
  const f = await fixture(t), ordinary = f.seed(f.first, 1);
  const feedback = f.seed(f.first, 2, { user: { intent: 'feedback', text: 'PRIVATE_FEEDBACK_SENTINEL', context: {} }, assistant: { text: 'PRIVATE_FEEDBACK_RESULT' } });
  const learning = f.save('学习材料', 'learn'); f.seed(learning, 3);
  const page = await f.refs.options({ workflowId: f.first.id }, f.context);
  assert.deepEqual(page.turns.map(turn => turn.turnId), [ordinary.id]);
  assert.equal(JSON.stringify(page).includes('PRIVATE_FEEDBACK'), false);
  assert.equal((await f.refs.options({}, f.context)).workflows.some(row => row.workflowId === learning.id), false);
  await assert.rejects(f.refs.resolve([f.input(feedback)], f.context), { httpStatus: 403 });
  await assert.rejects(f.refs.options({ workflowId: learning.id }, f.context), { httpStatus: 409 });
});

test('picker previews stay bounded and long messages use the exact source digest rather than a truncated list-page digest', async t => {
  const f = await fixture(t), turn = f.seed(f.first, 1, { user: { text: 'Long message '.repeat(1000), intent: 'diagnose', context: {} },
    assistant: { text: 'LONG_ASSISTANT_BODY '.repeat(1000) } });
  const page = await f.refs.options({ workflowId: f.first.id }, f.context);
  assert.equal(page.turns.length, 1); assert(page.turns[0].preview.length <= 150);
  const [reference] = await f.refs.resolve([wire(page.turns[0])], f.context);
  assert.equal(reference.turnId, turn.id); assert.equal(reference.sourceDigest, page.turns[0].sourceDigest);
  assert.equal(JSON.stringify(reference).includes('LONG_ASSISTANT_BODY'), false);
});

test('reference picker pages only eligible source records and keeps the original cursor when restricted messages are filtered', async t => {
  const f = await fixture(t);
  for (let index = 1; index <= 25; index++) f.seed(f.first, index, index === 25 ? { user: { intent: 'skill', text: 'PRIVATE_SKILL', context: {} } } : {});
  const page = await f.refs.options({ workflowId: f.first.id }, f.context);
  assert.equal(page.hasMore, true); assert.equal(page.turns.length, 19); assert.equal(page.nextBeforeTurnId, 'reference-turn-6');
  const older = await f.refs.options({ workflowId: f.first.id, beforeTurnId: page.nextBeforeTurnId }, f.context);
  assert.deepEqual(older.turns.map(turn => turn.turnId), [1, 2, 3, 4, 5].map(n => 'reference-turn-' + n));
  assert.equal(older.hasMore, false); assert.equal(JSON.stringify(page).includes('PRIVATE_SKILL'), false);
});

test('only current unrestricted supervisors can reference chats; source reading does not require material or source-write permissions', async t => {
  const f = await fixture(t), turn = f.seed(f.first, 1);
  const workflow = { permissionScope: await f.owner.permissions.bind({ role: 'workflow', workflowId: f.first.id }) };
  const child = { permissionScope: await f.owner.permissions.bind({ role: 'supervisor', workflowId: f.first.id, readOnly: true, workflowBound: true }) };
  for (const context of [workflow, child, {}]) await assert.rejects(f.refs.resolve([f.input(turn)], context), { httpStatus: 403 });
  for (const flag of ['workflowRead', 'crossWorkflowRead']) {
    const denied = await f.settings({ [flag]: false });
    await assert.rejects(f.refs.options({}, denied), { httpStatus: 403 });
    await assert.rejects(f.refs.resolve([f.input(turn)], denied), { httpStatus: 403 });
    await f.settings({ [flag]: true });
  }
  const read = await f.settings({ workspaceRead: false, sourceRead: false, sourceRepair: false });
  assert.equal((await f.refs.resolve([f.input(turn)], read)).length, 1);
  assert.equal(f.app.assistantPermissionSettings.get().supervisor.sourceRepair, false);
});

test('permission changes during an asynchronous scope check prevent source data delivery', async t => {
  const f = await fixture(t), turn = f.seed(f.first, 1), original = f.owner.permissions.current.bind(f.owner.permissions); let count = 0;
  f.owner.permissions.current = async scope => {
    count++;
    if (count === 2) await f.settings({ crossWorkflowRead: false });
    return original(scope);
  };
  await assert.rejects(f.refs.resolve([f.input(turn)], f.context), { httpStatus: 409 });
});

test('reference identity payloads are bounded pure data with no foreign fields, duplication, callbacks or source bodies', async t => {
  const f = await fixture(t), turn = f.seed(f.first, 1), one = f.input(turn); let invoked = false;
  const getter = { ...one }; Object.defineProperty(getter, 'updatedAt', { enumerable: true, get() { invoked = true; return turn.updatedAt; } });
  for (const raw of [{}, new Array(2), [one, one], Array.from({ length: 5 }, (_, index) => ({ ...one, turnId: 'other-' + index })),
    [{ ...one, body: 'copied transcript' }], [{ ...one, sourceDigest: 'wrong' }], [{ ...one, updatedAt: 'wrong' }], [getter], [{ ...one, turnId: '__proto__' }]]) {
    await assert.rejects(f.refs.resolve(raw, f.context), { httpStatus: 400 });
  }
  assert.equal(invoked, false); assert.deepEqual(await f.refs.resolve(undefined, {}), []);
});
