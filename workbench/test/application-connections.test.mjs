import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { ApplicationConnections } from '../src/application-connections.mjs';

const revision = 'sha256:' + '1'.repeat(64);
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const db = new DatabaseSync(':memory:'), adapter = new EventEmitter(), calls = [], events = [];
  let settle, invalidated = 0;
  adapter.state = 'ready'; adapter.request = async (method, params, timeout) => {
    calls.push({ method, params, timeout });
    if (method.endsWith('inspect')) return { native: true, revision, mcp: [{ name: 'fixture', enabled: true, command: '/private' }], catalog: [{ name: 'fixture', description: 'fixture', token: 'private-value' }], hosted: [], hostedAvailable: false };
    if (method.endsWith('manage')) return await new Promise(resolve => { settle = resolve; });
    if (method.endsWith('cancel')) { settle?.({ native: true, revision, settled: true, targets: [] }); return { cancelled: true }; }
    if (method.endsWith('respond')) return { accepted: true, settled: false };
  };
  const app = { store: { db }, adapter, publish: (...args) => events.push(args), skillIntegrations: { invalidate: () => invalidated++ } }, service = new ApplicationConnections(app);
  t.after(async () => { await service.close(); db.close(); });
  const context = { role: 'supervisor', sourceConversationId: 'supervisor-one', diagnosticTurnId: 'turn-one', authorize: async () => {} };
  const request = { action: 'install', connectors: [{ name: 'fixture', mcp: true }], expectedRevision: revision, operationId: 'operation-one' };
  const emit = (type = 'request', patch = {}) => adapter.emit('event', { type: 'workbench.connections.' + type, payload: { operation_id: request.operationId,
    conversation_id: context.sourceConversationId, turn_id: context.diagnosticTurnId, snapshot: { op_id: 'native-one', seq: 1, targets: [{ name: 'fixture', kind: 'mcp', action: 'install', state: 'pending',
      connect_url: 'https://auth.invalid/?opaque=one', required_env: [{ name: 'FIXTURE_KEY', secret: true, default: 'private-value', required: true }] }] }, ...patch } });
  return { db, adapter, calls, events, service, context, request, emit, settle: value => settle(value), invalidated: () => invalidated };
}

test('native catalog is projected without endpoint commands or credentials', async t => {
  const f = fixture(t), result = await f.service.call('connections.list', {}, f.context);
  assert.equal(result.native, true); assert.equal(result.revision, revision); assert.equal(result.mcp[0].name, 'fixture');
  assert(!JSON.stringify(result).includes('/private')); assert(!JSON.stringify(result).includes('private-value'));
});

test('connection mutations require supervisor current authorized human turn', async t => {
  const f = fixture(t);
  for (const context of [{ ...f.context, role: 'workflow' }, { ...f.context, readOnly: true }, { ...f.context, authorize: undefined }, { ...f.context, sourceConversationId: undefined }])
    await assert.rejects(f.service.call('connections.manage', f.request, context));
  assert.equal(f.calls.length, 0);
});

test('native card is bound to exact operation topic and turn; secrets only reach human response', async t => {
  const f = fixture(t), pending = f.service.call('connections.manage', f.request, f.context); await flush(); f.emit();
  assert.equal(f.service.requests('supervisor-other').length, 0); assert.equal(f.service.requests('supervisor-one').length, 1);
  assert.equal(f.service.requests('supervisor-one')[0].params.targets[0].required_env[0].default, '');
  await assert.rejects(f.service.respond('supervisor-other', 'operation-one', {}, { human: true, authorize: async () => {} }));
  await assert.rejects(f.service.respond('supervisor-one', 'operation-one', {}, { human: false, authorize: async () => {} }));
  await f.service.respond('supervisor-one', 'operation-one', { targets: [{ name: 'fixture', status: 'approved', env: { FIXTURE_KEY: 'human-secret' } }] }, { human: true, authorize: async () => {} });
  assert.equal(f.calls.find(row => row.method.endsWith('respond')).params.result.targets[0].env.FIXTURE_KEY, 'human-secret');
  f.settle({ native: true, revision, settled: true, targets: [{ name: 'fixture', state: 'connected', connect_url: 'https://private.invalid' }] });
  const result = await pending; assert.equal(result.status, 'settled'); assert.equal(result.targets[0].state, 'connected');
  assert(!JSON.stringify(result).includes('connect_url')); assert(!JSON.stringify(f.events).includes('human-secret'));
  assert.equal(f.invalidated(), 1); assert.equal(f.service.requests('supervisor-one').length, 0);
  assert.equal(f.calls.find(row => row.method.endsWith('manage')).timeout, null);
});

test('stale or cross-operation native frames cannot replace a pending card', async t => {
  const f = fixture(t), pending = f.service.call('connections.manage', f.request, f.context); await flush(); f.emit();
  f.emit('update', { conversation_id: 'other', snapshot: { seq: 9, targets: [] } });
  f.emit('update', { snapshot: { seq: 0, targets: [] } });
  assert.equal(f.service.requests('supervisor-one')[0].params.targets.length, 1);
  f.emit('complete', { snapshot: { settled: true } }); assert.equal(f.service.requests('supervisor-one').length, 0);
  f.settle({ native: true, revision, settled: true, targets: [] }); await pending;
});

test('same operation returns its durable receipt and cannot be rebound to new parameters', async t => {
  const f = fixture(t), pending = f.service.call('connections.manage', f.request, f.context); await flush();
  f.settle({ native: true, revision, settled: true, targets: [] }); const first = await pending;
  assert.deepEqual(await f.service.call('connections.manage', f.request, f.context), first);
  await assert.rejects(f.service.call('connections.manage', { ...f.request, action: 'enable' }, f.context));
  assert.equal(f.calls.filter(row => row.method.endsWith('manage')).length, 1);
});

test('pending durable operation after restart is unknown and never replayed', async t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO application_connection_operations VALUES(?,?,?,?,?,?,?)').run('historic', 'topic', 'turn', 'hash', 'pending', null, new Date().toISOString());
  const second = new ApplicationConnections({ store: { db: f.db }, adapter: f.adapter, publish() {} });
  assert.equal(f.db.prepare('SELECT status FROM application_connection_operations WHERE operation_id=?').get('historic').status, 'unknown');
  await second.close(); assert.equal(f.calls.length, 0);
});

test('stop cancels current native connection operation and clears cards without replay', async t => {
  const f = fixture(t), controller = new AbortController(), pending = f.service.call('connections.manage', f.request, { ...f.context, signal: controller.signal });
  await flush(); f.emit(); controller.abort(); await pending;
  assert.equal(f.calls.filter(row => row.method.endsWith('cancel')).length, 1);
  assert.equal(f.service.requests('supervisor-one').length, 0);
});
