import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { HistoricalUsage, historicalAllocation, historicalRunUsage } from '../src/historical-usage.mjs';

const at = '2026-10-27T01:00:00.000Z', end = '2026-10-27T01:01:00.000Z';
const numbers = { input: 100, output: 10, prompt: 120, completion: 10, total: 130, calls: 1, reasoning: 5, cache_read: 20, cache_write: 0 };
const context = { used: 120, max: null, percent: null, estimated: false, historical: true, kind: 'last-request-input', capturedAt: null, source: 'hermes.persisted-usage-anchor' };
const remote = (storedSessionId, extra = {}) => ({ storedSessionId, found: true, source: 'hermes.state-db', usage: numbers, tokensRecorded: true,
  startedAt: at, endedAt: end, firstMessageAt: at, lastMessageAt: end, firstUserMessageAt: at, lastUserMessageAt: at, messageCount: 2, userMessageCount: 1,
  parentId: null, hasChildren: false, compressed: false, context, modelUsage: [{ model: 'fixture-model', provider: 'fixture', task: '', usage: numbers }], ...extra });
function fixture(t, count = 1) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,stored_session_id TEXT); CREATE TABLE runs(id TEXT PRIMARY KEY,session_id TEXT,status TEXT,started_at TEXT,completed_at TEXT);
    CREATE TABLE workflow_documents(id TEXT,document TEXT); CREATE TABLE run_usage(run_id TEXT,value TEXT); CREATE TABLE session_usage(session_id TEXT,value TEXT);`);
  const calls = [], app = { store: { db }, closed: false, adapter: { state: 'ready', request: async (method, args) => { calls.push([method, args]); return { schemaVersion: 1, sessions: args.stored_session_ids.map(id => remote(id)) }; } } };
  for (let index = 0; index < count; index++) {
    db.prepare('INSERT INTO sessions VALUES(?,?)').run('session-' + index, 'stored-' + index);
    db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run('run-' + index, 'session-' + index, 'complete', at, end);
  }
  db.prepare('INSERT INTO workflow_documents VALUES(?,?)').run('workflow', '{"private":"PRIVATE_BUSINESS_SENTINEL"}');
  const service = new HistoricalUsage(app);
  const business = () => ['sessions', 'runs', 'workflow_documents', 'run_usage', 'session_usage'].map(name => [name, db.prepare('SELECT * FROM ' + name + ' ORDER BY rowid').all()]);
  return { app, db, calls, service, business };
}

test('history refresh imports only known stored identities in bounded batches and changes no business or live usage records', async t => {
  const f = fixture(t, 51), before = f.business(), result = await f.service.refresh();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0][1].stored_session_ids.length, 50); assert.equal(f.calls[1][1].stored_session_ids.length, 1);
  assert(f.calls.every(([name]) => name === 'workbench.usage.history'));
  assert.equal(result.matched, 51); assert.equal(result.attributedRuns, 51); assert.equal(result.contextSnapshots, 51);
  const record = f.service.read('session-0'); assert.equal(record.usage.total, 130); assert.equal(record.allocation.runId, 'run-0'); assert.equal(record.context.capturedAt, null);
  assert.deepEqual(f.business(), before); assert.equal(JSON.stringify(record).includes('PRIVATE_'), false);
});

test('concurrent refreshes coalesce and identical repeated results preserve rows without duplicate counting', async t => {
  const f = fixture(t); let release;
  f.app.adapter.request = async () => new Promise(resolve => { release = resolve; });
  const first = f.service.refresh(), second = f.service.refresh(); assert.equal(first, second);
  release({ schemaVersion: 1, sessions: [remote('stored-0')] }); await first;
  const before = f.service.read('session-0'); f.app.adapter.request = async () => ({ schemaVersion: 1, sessions: [remote('stored-0')] });
  const again = await f.service.refresh(); assert.equal(again.updated, 0); assert.equal(again.unchanged, 1); assert.equal(again.attributedRuns, 1);
  assert.deepEqual(f.service.read('session-0'), before);
});

test('missing sessions and zero counters without a reliable anchor remain unavailable rather than fabricated zero use', async t => {
  const f = fixture(t, 2); f.app.adapter.request = async () => ({ schemaVersion: 1, sessions: [
    { storedSessionId: 'stored-0', found: false, source: 'hermes.state-db' }, remote('stored-1', { usage: Object.fromEntries(Object.keys(numbers).map(key => [key, key === 'calls' ? 1 : 0])), context: null, modelUsage: [] }),
  ] });
  const result = await f.service.refresh(); assert.equal(result.missing, 1); assert.equal(result.unavailable, 1); assert.equal(result.attributedRuns, 0);
  assert.equal(f.service.read('session-0'), null); assert.equal(f.service.read('session-1').tokensRecorded, false);
});

test('malformed, duplicate, foreign, negative, credential-bearing or incomplete batch responses fail before any row is written', async t => {
  const cases = [
    { schemaVersion: 2, sessions: [remote('stored-0')] }, { schemaVersion: 1, sessions: [] },
    { schemaVersion: 1, sessions: [remote('foreign')] }, { schemaVersion: 1, sessions: [remote('stored-0', { usage: { ...numbers, total: -1 } })] },
    { schemaVersion: 1, sessions: [remote('stored-0', { usage: { input: 1 } })] }, { schemaVersion: 1, sessions: [remote('stored-0', { credentials: 'SECRET' })] },
    { schemaVersion: 1, sessions: [remote('stored-0', { usage: { ...numbers, total: 999 } })] },
    { schemaVersion: 1, sessions: [remote('stored-0', { context: { ...context, capturedAt: at } })] },
  ];
  for (const response of cases) { const f = fixture(t); f.app.adapter.request = async () => response; await assert.rejects(f.service.refresh(), { httpStatus: 502 }); assert.equal(f.db.prepare('SELECT count(*) n FROM hermes_usage_history').get().n, 0); }
  const f = fixture(t, 2); f.app.adapter.request = async () => ({ schemaVersion: 1, sessions: [remote('stored-0'), remote('stored-0')] });
  await assert.rejects(f.service.refresh(), /重复/); assert.equal(f.db.prepare('SELECT count(*) n FROM hermes_usage_history').get().n, 0);
});

test('accessors cannot run while validating upstream metadata and unknown fields do not enter the cache', async t => {
  const f = fixture(t); let reads = 0;
  const response = { schemaVersion: 1, sessions: [{ ...remote('stored-0'), get usage() { reads++; return numbers; } }] };
  f.app.adapter.request = async () => response; await assert.rejects(f.service.refresh(), /格式/); assert.equal(reads, 0);
});

test('closed or offline applications refuse refresh and a late source response cannot write after close', async t => {
  const f = fixture(t); f.app.adapter.state = 'stopped'; await assert.rejects(f.service.refresh(), { httpStatus: 503 });
  f.app.adapter.state = 'ready'; let release; f.app.adapter.request = async () => new Promise(resolve => { release = resolve; });
  const pending = f.service.refresh(); f.service.close(); release({ schemaVersion: 1, sessions: [remote('stored-0')] });
  await assert.rejects(pending, { httpStatus: 409 }); assert.equal(f.db.prepare('SELECT count(*) n FROM hermes_usage_history').get().n, 0);
  await assert.rejects(f.service.refresh(), { httpStatus: 409 });
});

test('each batch is atomic if a local stored identity changes during its read', async t => {
  const f = fixture(t, 2); f.app.adapter.request = async () => {
    f.db.prepare('UPDATE sessions SET stored_session_id=? WHERE id=?').run('changed', 'session-1');
    return { schemaVersion: 1, sessions: [remote('stored-0'), remote('stored-1')] };
  };
  await assert.rejects(f.service.refresh(), { httpStatus: 409 }); assert.equal(f.db.prepare('SELECT count(*) n FROM hermes_usage_history').get().n, 0);
});

test('allocation refuses multiple local turns, unfinished runs, shared stored identities and remote lineage or mismatched time', async t => {
  const f = fixture(t); await f.service.refresh(); const record = f.service.read('session-0'), session = f.db.prepare('SELECT * FROM sessions').get(), runs = f.db.prepare('SELECT * FROM runs').all();
  assert.equal(historicalAllocation(record, session, runs, 1).runId, 'run-0');
  for (const [candidate, rows, count] of [
    [record, [...runs, { ...runs[0], id: 'later' }], 1], [record, [{ ...runs[0], completed_at: null }], 1],
    [record, [{ ...runs[0], status: 'running' }], 1], [record, runs, 2],
    [{ ...record, parentId: 'parent' }, runs, 1], [{ ...record, compressed: true }, runs, 1], [{ ...record, hasChildren: true }, runs, 1],
    [{ ...record, hasChildren: null }, runs, 1], [{ ...record, lastMessageAt: '2026-10-27T02:00:00Z' }, runs, 1],
    [{ ...record, firstMessageAt: null, firstUserMessageAt: null }, runs, 1],
  ]) assert.equal(historicalAllocation(candidate, session, rows, count).runId, null);
});

test('history is a non-additive fallback: measured and reset live runs win, partial histories must dominate every known delta', async t => {
  const f = fixture(t); await f.service.refresh(); const history = f.service.read('session-0'), session = f.db.prepare('SELECT * FROM sessions').get(), runs = f.db.prepare('SELECT * FROM runs').all();
  const fallback = historicalRunUsage(history, session, runs, 1); assert.equal(fallback.usage.total, 130); assert.equal(fallback.historical, true);
  for (const status of ['measured', 'reset']) { const live = { status, usage: { total: 15 } }; assert.equal(historicalRunUsage(history, session, runs, 1, live), live); }
  const partial = { status: 'partial', usage: { total: 10, input: 5 } }; assert.equal(historicalRunUsage(history, session, runs, 1, partial).usage.total, 130);
  const larger = { status: 'partial', usage: { total: 131 } }; assert.equal(historicalRunUsage(history, session, runs, 1, larger), larger);
  assert.equal(historicalRunUsage(history, session, [...runs, { ...runs[0], id: 'future-run' }], 1, partial), partial);
});
