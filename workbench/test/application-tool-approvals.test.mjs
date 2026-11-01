import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { ApplicationToolApprovals } from '../src/application-tool-approvals.mjs';
import { ApplicationConnections } from '../src/application-connections.mjs';
import { createWorkbenchServer } from '../src/server.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const db = new DatabaseSync(':memory:'), notifications = [], app = { store: { db }, applicationAssistant: { listConversations: () => [{ id: 'supervisor-one' }], emit: owner => notifications.push(owner) }, conversations: { emit: owner => notifications.push(owner) } };
  const approvals = new ApplicationToolApprovals(app);
  t.after(() => { approvals.close(); db.close(); });
  const details = { kind: 'mcp', title: 'Allow fixture once', details: { server: 'fixture', tool: 'write', arguments: { content: 'visible proposal' } } };
  const context = { conversationId: 'supervisor-one', turnId: 'turn-one', authorize: async () => {} };
  const stored = id => JSON.parse(db.prepare('SELECT value FROM application_tool_approvals WHERE id=?').get(id).value);
  return { db, approvals, details, context, stored, notifications, app };
}

test('approval is bound to its owner human turn revision and one manual response', async t => {
  const f = fixture(t), wait = f.approvals.request(f.details, f.context); await flush();
  const [card] = f.approvals.requests('supervisor-one'); assert.equal(card.owner, f.context.conversationId); assert.equal(card.turnId, f.context.turnId); assert.equal(card.revision, 1);
  assert.deepEqual(f.approvals.requests('workflow-other'), []);
  for (const [owner, input, identity] of [['other', { expectedRevision: 1, choice: 'once' }, { human: true }], ['supervisor-one', { expectedRevision: 2, choice: 'once' }, { human: true }],
    ['supervisor-one', { expectedRevision: 1, choice: 'once' }, {}], ['supervisor-one', { expectedRevision: 1, choice: 'always' }, { human: true }],
    ['supervisor-one', { expectedRevision: 1, choice: 'once', role: 'supervisor' }, { human: true }]]) {
    await assert.rejects(f.approvals.respond(owner, card.id, input, identity));
  }
  assert.equal(f.approvals.requests('supervisor-one').length, 1);
  const reply = await f.approvals.respond('supervisor-one', card.id, { expectedRevision: 1, choice: 'once' }, { human: true });
  assert.deepEqual(reply, { accepted: true, executed: false }); assert.equal(await wait, true);
  assert.equal(f.stored(card.id).status, 'approved'); assert.equal(f.stored(card.id).revision, 2);
  await assert.rejects(f.approvals.respond('supervisor-one', card.id, { expectedRevision: 1, choice: 'once' }, { human: true }));
});

test('denial returns false without granting a future attempt permission', async t => {
  const f = fixture(t), wait = f.approvals.request(f.details, f.context); await flush(); const [card] = f.approvals.requests('supervisor-one');
  await f.approvals.respond('supervisor-one', card.id, { expectedRevision: 1, choice: 'deny' }, { human: true }); assert.equal(await wait, false);
  assert.equal(f.stored(card.id).status, 'denied');
  const next = f.approvals.request(f.details, { ...f.context, turnId: 'turn-two' }); await flush(); const [newCard] = f.approvals.requests('supervisor-one'); assert.notEqual(newCard.id, card.id); assert.equal(newCard.turnId, 'turn-two');
  await f.approvals.respond('supervisor-one', newCard.id, { expectedRevision: 1, choice: 'deny' }, { human: true }); await next;
});

test('current turn and scope are reauthorized before manual approval', async t => {
  const f = fixture(t); let current = true;
  const pending = f.approvals.request(f.details, { ...f.context, authorize: async () => { if (!current) throw new Error('turn or permission changed'); } });
  const rejection = assert.rejects(pending, /turn or permission changed/); await flush(); const [card] = f.approvals.requests('supervisor-one'); current = false;
  await assert.rejects(f.approvals.respond('supervisor-one', card.id, { expectedRevision: 1, choice: 'once' }, { human: true }), /turn or permission changed/);
  await rejection; assert.equal(f.stored(card.id).status, 'cancelled'); assert.deepEqual(f.approvals.requests('supervisor-one'), []);
});

test('stop while approval waits cancels durable request and invalidates its answer', async t => {
  const f = fixture(t), controller = new AbortController(), pending = f.approvals.request(f.details, { ...f.context, signal: controller.signal });
  const rejection = assert.rejects(pending, /停止/); await flush(); const [card] = f.approvals.requests('supervisor-one'); controller.abort(); await rejection;
  assert.equal(f.stored(card.id).status, 'cancelled'); await assert.rejects(f.approvals.respond('supervisor-one', card.id, { expectedRevision: 1, choice: 'once' }, { human: true }));
});

test('a stop that wins while authorization awaits cannot approve the stale waiter', async t => {
  const f = fixture(t), controller = new AbortController(); let authorizeCalls = 0, unblock;
  const pending = f.approvals.request(f.details, { ...f.context, signal: controller.signal, authorize: async () => { if (++authorizeCalls > 1) await new Promise(resolve => { unblock = resolve; }); } });
  const rejection = assert.rejects(pending, /停止/); await flush(); const [card] = f.approvals.requests('supervisor-one');
  const response = f.approvals.respond('supervisor-one', card.id, { expectedRevision: 1, choice: 'once' }, { human: true }); const responseRejection = assert.rejects(response, /失效/);
  await flush(); controller.abort(); unblock(); await Promise.all([rejection, responseRejection]); assert.equal(f.stored(card.id).status, 'cancelled');
});

test('shutdown and startup keep interrupted receipts without replaying approvals', async t => {
  const f = fixture(t), pending = f.approvals.request(f.details, f.context), rejection = assert.rejects(pending, /关闭/); await flush(); const [card] = f.approvals.requests('supervisor-one');
  f.approvals.close(); await rejection; assert.equal(f.stored(card.id).status, 'interrupted');
  const orphan = { id: 'orphaned-card', owner: 'supervisor-one', turnId: 'turn-older', status: 'pending', revision: 1, title: 'fixture', details: {} }; f.db.prepare('INSERT INTO application_tool_approvals VALUES(?,?,?)').run(orphan.id, orphan.owner, JSON.stringify(orphan));
  const restarted = new ApplicationToolApprovals(f.app); assert.equal(f.stored(orphan.id).status, 'interrupted'); assert.deepEqual(restarted.requests('supervisor-one'), []);
  await assert.rejects(restarted.respond('supervisor-one', orphan.id, { expectedRevision: 1, choice: 'once' }, { human: true })); restarted.close();
});

test('credential fields are removed from approval details before persistence and projection', async t => {
  const f = fixture(t), pending = f.approvals.request({ ...f.details, details: { server: 'fixture', arguments: { api_key: 'plain-private-key', nested: { password: 'plain-private-password', access_token: 'plain-private-token' } },
    note: 'Bearer sk-private-value-long' } }, f.context); await flush(); const [card] = f.approvals.requests('supervisor-one');
  const visible = JSON.stringify(card), persisted = JSON.stringify(f.stored(card.id));
  for (const secret of ['plain-private-key', 'plain-private-password', 'plain-private-token', 'sk-private-value-long']) { assert(!visible.includes(secret), secret); assert(!persisted.includes(secret), secret); }
  await f.approvals.respond('supervisor-one', card.id, { expectedRevision: 1, choice: 'deny' }, { human: true }); await pending;
});

test('workflow approval carries run ownership even without an active chat message', async t => {
  const f = fixture(t), pending = f.approvals.request(f.details, { conversationId: 'workflow-one', runId: 'run-one', authorize: async () => {} }); await flush();
  const [card] = f.approvals.requests('workflow-one'); assert.equal(card.runId, 'run-one'); assert.equal(card.turnId, undefined);
  await f.approvals.respond('workflow-one', card.id, { expectedRevision: 1, choice: 'once' }, { human: true }); assert.equal(await pending, true);
});

async function httpFixture(t) {
  const db = new DatabaseSync(':memory:'), app = new EventEmitter(), adapter = new EventEmitter(), calls = [];
  let writable = true, connectionManage = true, settleNative;
  adapter.state = 'ready'; adapter.request = async (method, params) => {
    calls.push({ method, params });
    if (method.endsWith('.manage')) return new Promise(resolve => { settleNative = resolve; });
    if (method.endsWith('.respond')) return { accepted: true, settled: false };
    if (method.endsWith('.cancel')) { settleNative?.({ native: true, revision: 'sha256:' + '1'.repeat(64), settled: true, targets: [] }); return { cancelled: true }; }
  };
  app.store = { db }; app.adapter = adapter; app.sequence = 0; app.bootstrap = () => ({}); app.publish = () => {};
  app.applicationAssistant = {
    lifecycle: { assertWritable(owner) { if (!writable || owner !== 'supervisor-one') throw Object.assign(new Error('topic is read-only'), { httpStatus: 403 }); } },
    listConversations: () => [{ id: 'supervisor-one' }], emit() {},
    get(owner) { return { conversation: { workflowId: owner, turns: [] }, nativeRequests: [], connectionRequests: app.connections.requests(owner), toolRequests: app.toolApprovals.requests(owner) }; },
  };
  app.assistantPermissionSettings = { get: () => ({ supervisor: { connectionManage } }) };
  app.toolApprovals = new ApplicationToolApprovals(app); app.connections = new ApplicationConnections(app);
  app.close = async () => { app.toolApprovals.close(); await app.connections.close(); db.close(); };
  const bridge = createWorkbenchServer({ host: '127.0.0.1', port: 0, appRoot: process.cwd() }, app), origin = await bridge.listen();
  t.after(() => bridge.close()); const csrf = (await (await fetch(origin + '/api/bootstrap')).json()).csrfToken;
  const post = (path, body, headers = {}) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Workbench-Token': csrf, ...headers }, body: JSON.stringify(body) });
  return { app, adapter, calls, post, authorize: async () => app.applicationAssistant.lifecycle.assertWritable('supervisor-one'), revoke: () => { writable = false; }, disableConnections: () => { connectionManage = false; } };
}

test('HTTP approval endpoint preserves CSRF origin ownership and exact revision before resolving its real waiter', async t => {
  const f = await httpFixture(t), pending = f.app.toolApprovals.request({ kind: 'mcp', title: 'fixture', details: {} }, { conversationId: 'supervisor-one', turnId: 'turn-one', authorize: f.authorize });
  await flush(); const [card] = f.app.toolApprovals.requests('supervisor-one'), path = '/api/tool-approvals/supervisor-one/' + card.id, body = { expectedRevision: 1, choice: 'once' };
  assert.equal((await f.post(path, body, { 'X-Workbench-Token': '' })).status, 403);
  assert.equal((await f.post(path, body, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await f.post('/api/tool-approvals/other/' + card.id, body)).status, 409);
  assert.equal((await f.post(path, { ...body, expectedRevision: 2 })).status, 409);
  assert.equal(f.app.toolApprovals.requests('supervisor-one').length, 1);
  const accepted = await f.post(path, body); assert.equal(accepted.status, 200); assert.deepEqual(await accepted.json(), { accepted: true, executed: false }); assert.equal(await pending, true);
  assert.equal(f.calls.length, 0, 'approval does not itself execute an external tool');
});

test('HTTP native connection reply is scoped human-only guarded and never echoes credential values', async t => {
  const f = await httpFixture(t), revision = 'sha256:' + '1'.repeat(64), pending = f.app.connections.call('connections.manage', {
    action: 'install', connectors: [{ name: 'fixture', mcp: true }], expectedRevision: revision, operationId: 'connection-one',
  }, { role: 'supervisor', sourceConversationId: 'supervisor-one', diagnosticTurnId: 'turn-one', authorize: f.authorize });
  await flush(); f.adapter.emit('event', { type: 'workbench.connections.request', payload: { operation_id: 'connection-one', conversation_id: 'supervisor-one', turn_id: 'turn-one',
    snapshot: { op_id: 'native-operation', seq: 1, targets: [{ name: 'fixture', kind: 'mcp', state: 'pending', required_env: [{ name: 'FIXTURE_KEY', secret: true, required: true }] }] } } });
  const path = '/api/app-assistant/conversations/supervisor-one/connections/connection-one', body = { targets: [{ name: 'fixture', status: 'approved', env: { FIXTURE_KEY: 'human-only-private-value' } }] };
  assert.equal((await f.post(path, body, { 'X-Workbench-Token': '' })).status, 403);
  assert.equal((await f.post(path, body, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await f.post('/api/app-assistant/conversations/other/connections/connection-one', body)).status, 403);
  assert.equal(f.calls.filter(row => row.method.endsWith('.respond')).length, 0);
  const response = await f.post(path, body); assert.equal(response.status, 200); assert(!(await response.text()).includes('human-only-private-value'));
  assert.equal(f.calls.find(row => row.method.endsWith('.respond')).params.result.targets[0].env.FIXTURE_KEY, 'human-only-private-value');
  f.disableConnections(); assert.equal((await f.post(path, body)).status, 403); assert.equal(f.calls.filter(row => row.method.endsWith('.respond')).length, 1);
  f.revoke(); assert.equal((await f.post(path, { settled_by: 'continue' })).status, 403);
  await f.app.connections.close(); await pending;
});
