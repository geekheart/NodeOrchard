import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { SessionUsage, sanitizeSessionUsage } from '../src/session-usage.mjs';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';

async function fixture(t, { fresh = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'session-usage-')), store = new Store(directory), usage = new SessionUsage(store.db);
  store.sessionUsage = usage;
  const session = store.create({ title: '数字遥测样例', cwd: directory, storedSessionId: 'stored-fixture', runtimeSessionId: 'runtime-fixture' });
  if (fresh) usage.registerNew(session.id);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, usage, session, begin: () => store.beginRun(session.id), observe: (value, options) => usage.observe(session.id, value, options) };
}
const numbers = (input, output, total = input + output, calls = 1) => ({ input, output, total, calls });

test('usage sanitizer admits finite numeric telemetry and explicit context provenance only', () => {
  let accessed = 0;
  const value = { ...numbers(80, 20, 125), prompt: 100, reasoning: 5, context_used: 900, context_max: 1000,
    context_percent: 90, context_estimated: true, context_source: 'local_estimate', cache_hit_pct: 12.5,
    avg_latency_s: 0.6, avg_tps: 31.2, api_key: 'SECRET', model: 'do-not-copy', get password() { accessed++; return 'SECRET'; } };
  const clean = sanitizeSessionUsage(value);
  assert.deepEqual(clean, { input: 80, output: 20, prompt: 100, reasoning: 5, total: 125, calls: 1,
    context_used: 900, context_max: 1000, context_percent: 90, cache_hit_pct: 12.5, avg_latency_s: 0.6, avg_tps: 31.2,
    context_estimated: true, context_source: 'local_estimate' });
  assert.equal(accessed, 0); assert.equal(clean.total, 125);
  for (const invalid of [null, [], '1', { input: -1, output: NaN, total: Infinity, calls: 1.5, context_percent: 101, context_source: 'secret' }]) assert.equal(sanitizeSessionUsage(invalid), null);
  assert.equal(sanitizeSessionUsage({ get input() { accessed++; return 50; } }), null); assert.equal(accessed, 0);
});

test('fresh sessions use known zero baselines and duplicate cumulative ticks never double count', async t => {
  const f = await fixture(t), runId = f.begin();
  f.observe({ ...numbers(100, 20, 135), reasoning: 15 }, { source: 'session.usage' });
  const first = f.usage.readRun(runId);
  assert.equal(first.status, 'measured'); assert.deepEqual(first.usage, { input: 100, output: 20, reasoning: 15, total: 135, calls: 1 });
  f.observe({ ...numbers(100, 20, 135), reasoning: 15 }, { source: 'message.complete', final: true });
  assert.deepEqual(f.usage.readRun(runId).usage, first.usage); assert.equal(f.usage.readRun(runId).final, true);
  assert.equal(f.usage.runs().length, 1); assert.equal(f.usage.read(f.session.id).usage.total, 135);
});

test('partial terminal counters or context cannot confirm older complete ticker values', async t => {
  for (const terminal of [{ input: 140, output: 30 }, { context_used: 700, context_max: 1000 }]) {
    const f = await fixture(t), runId = f.begin();
    f.observe(numbers(100, 20, 120, 1));
    assert.equal(f.usage.readRun(runId).status, 'measured');
    f.observe(terminal, { source: 'message.complete', final: true });
    const result = f.usage.readRun(runId);
    assert.equal(result.status, 'partial'); assert.equal(result.final, false);
    assert.equal(result.usage.total, 120);
    f.store.finishRun(f.session.id, 'complete');
    assert.equal(f.usage.readRun(runId).status, 'partial');
    const next = f.begin(); f.observe(numbers(200, 40, 240, 2), { source: 'message.complete', final: true });
    assert.equal(f.usage.readRun(next).status, 'missing'); assert.deepEqual(f.usage.readRun(next).usage, {});
  }
});

test('consecutive run usage is a counter delta and never repeats a previous turn', async t => {
  const f = await fixture(t), first = f.begin();
  f.observe(numbers(100, 20), { source: 'message.complete', final: true }); f.store.finishRun(f.session.id, 'complete');
  const second = f.begin(); f.observe(numbers(150, 30, 180, 3), { source: 'message.complete', final: true });
  assert.equal(f.usage.readRun(first).usage.total, 120);
  assert.deepEqual(f.usage.readRun(second).usage, { input: 50, output: 10, total: 60, calls: 2 });
  assert.equal(f.usage.readRun(second).status, 'measured');
});

test('old sessions with no baseline never charge their historical cumulative count to a new run', async t => {
  const f = await fixture(t, { fresh: false }), runId = f.begin();
  assert.equal(f.usage.read(f.session.id), null);
  f.observe(numbers(1000, 200, 1200, 30));
  assert.equal(f.usage.readRun(runId).status, 'missing'); assert.deepEqual(f.usage.readRun(runId).usage, {});
  f.observe(numbers(1050, 215, 1265, 32), { source: 'message.complete', final: true });
  const observed = f.usage.readRun(runId);
  assert.equal(observed.status, 'partial'); assert.deepEqual(observed.usage, { input: 50, output: 15, total: 65, calls: 2 });
});

test('restored pre-run snapshots establish a real baseline without inventing absent counters', async t => {
  const f = await fixture(t, { fresh: false });
  f.observe(numbers(1000, 200, 1200, 30), { source: 'session.resume' });
  const runId = f.begin(); f.observe(numbers(1050, 220, 1270, 31), { source: 'message.complete', final: true });
  assert.equal(f.usage.readRun(runId).status, 'measured'); assert.equal(f.usage.readRun(runId).usage.total, 70);
  assert.equal(Object.hasOwn(f.usage.readRun(runId).usage, 'reasoning'), false);
});

test('an unmeasured prior turn invalidates stale baselines for the next run', async t => {
  const f = await fixture(t), first = f.begin();
  f.observe(numbers(100, 20), { at: '2020-01-01T00:00:00.000Z' });
  f.store.finishRun(f.session.id, 'error');
  assert.equal(f.usage.readRun(first).status, 'partial');
  const second = f.begin(); f.observe(numbers(180, 30), { source: 'message.complete', final: true });
  assert.equal(f.usage.readRun(first).final, false);
  assert.equal(f.usage.readRun(second).status, 'missing'); assert.deepEqual(f.usage.readRun(second).usage, {});
});

test('persisted usage survives a service restart without changing the original run rows', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'usage-restart-')); let store = new Store(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  let usage = new SessionUsage(store.db); store.sessionUsage = usage;
  const session = store.create({ title: '持久化样例', cwd: directory, storedSessionId: 'persisted', runtimeSessionId: null });
  usage.registerNew(session.id); const runId = store.beginRun(session.id);
  usage.observe(session.id, numbers(35, 15), { source: 'message.complete', final: true }); store.finishRun(session.id, 'complete');
  const before = { session: usage.read(session.id), run: usage.readRun(runId), rows: store.runs(session.id) };
  store.close(); store = new Store(directory); usage = new SessionUsage(store.db);
  assert.deepEqual(usage.read(session.id), before.session); assert.deepEqual(usage.readRun(runId), before.run);
  assert.deepEqual(store.runs(session.id), before.rows);
});

test('counter resets establish a new generation and cannot subtract across it', async t => {
  const f = await fixture(t), runId = f.begin();
  f.observe(numbers(100, 20)); f.observe(numbers(5, 2));
  assert.equal(f.usage.read(f.session.id).generation, 1); assert.equal(f.usage.readRun(runId).status, 'reset');
  assert.deepEqual(f.usage.readRun(runId).usage, {});
  f.observe(numbers(9, 3), { source: 'message.complete', final: true });
  assert.equal(f.usage.readRun(runId).status, 'reset'); assert.equal(f.usage.readRun(runId).usage.total, 5);
});

test('context snapshots preserve provider estimates and do not masquerade as billing totals', async t => {
  const f = await fixture(t);
  f.observe({ context_used: 1500, context_max: 2000, context_percent: 75, context_estimated: true, context_source: 'local_estimate' });
  const snapshot = f.usage.read(f.session.id);
  assert.equal(snapshot.usage.context_used, 1500); assert.equal(snapshot.usage.context_estimated, true);
  assert.equal(Object.hasOwn(snapshot.usage, 'total'), false); assert.equal(f.usage.runs().length, 0);
});

test('counter and provenance-only frames never advance an older context measurement timestamp', async t => {
  const f = await fixture(t), old = '2026-10-20T00:00:00.000Z', later = '2026-10-21T00:00:00.000Z';
  f.observe({ context_used: 1500, context_max: 2000, context_estimated: true, context_source: 'local_estimate' }, { at: old });
  f.observe(numbers(20, 5), { at: later });
  assert.equal(f.usage.read(f.session.id).capturedAt, later); assert.equal(f.usage.read(f.session.id).contextCapturedAt, old);
  f.observe({ context_estimated: false, context_source: 'provider_usage' }, { at: '2026-10-22T00:00:00.000Z' });
  assert.equal(f.usage.read(f.session.id).contextCapturedAt, old);
  f.observe({ context_used: 0 }, { at: '2026-10-23T00:00:00.000Z' });
  assert.equal(f.usage.read(f.session.id).contextCapturedAt, '2026-10-23T00:00:00.000Z');
});

test('a legacy context snapshot keeps its original measurement date on the first new counter frame', async t => {
  const f = await fixture(t), old = '2026-10-20T00:00:00.000Z';
  f.usage.writeSession({ sessionId: f.session.id, capturedAt: old, source: 'session.info', generation: 0, newSession: false, usage: { context_used: 800, context_max: 1000 } });
  f.observe(numbers(20, 5), { at: '2026-10-21T00:00:00.000Z' });
  assert.equal(f.usage.read(f.session.id).contextCapturedAt, old);
});

test('invalid or foreign observations do not create telemetry rows', async t => {
  const f = await fixture(t, { fresh: false });
  assert.equal(f.observe({ input: '100', api_key: 'SECRET' }), null);
  assert.equal(f.usage.observe('foreign', numbers(100, 20)), null);
  assert.equal(f.observe(numbers(100, 20), { source: 'secret-unsupported' }), null);
  assert.equal(f.usage.read(f.session.id), null); assert.deepEqual(f.usage.runs(), []);
});

test('telemetry errors in the store hook cannot prevent execution state changes', async t => {
  const f = await fixture(t);
  f.store.sessionUsage = { beginRun() { throw Error('telemetry failure'); } };
  const id = f.begin(); assert.equal(f.store.runs(f.session.id).at(-1).id, id); assert.equal(f.store.get(f.session.id).status, 'running');
});

test('application wires info, streaming and failed completions to telemetry without exposing arbitrary usage fields', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'application-usage-'));
  class Offline extends EventEmitter { constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.log = []; } async stop() {} }
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), workflowRunRoot: join(directory, 'runs') };
  const app = new Application(config, new Offline());
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const session = app.store.create({ title: '应用遥测样例', cwd: directory, storedSessionId: 'stored-app', runtimeSessionId: 'runtime-app' });
  app.sessionUsage.registerNew(session.id); const runId = app.store.beginRun(session.id);
  app.onGatewayEvent({ type: 'session.info', session_id: 'runtime-app', payload: { model: 'fixture', usage: { ...numbers(10, 2), secret: 'PRIVATE' } } });
  assert.equal(app.sessionInfo.get('runtime-app').usage.total, 12); assert.equal(JSON.stringify(app.sessionInfo.get('runtime-app')).includes('PRIVATE'), false);
  app.onGatewayEvent({ type: 'session.usage', session_id: 'runtime-app', payload: { usage: numbers(12, 3) } });
  app.onGatewayEvent({ type: 'message.complete', session_id: 'runtime-app', payload: { status: 'error', error: 'fixture failure', usage: numbers(15, 4) } });
  assert.equal(app.sessionUsage.readRun(runId).usage.total, 19); assert.equal(app.sessionUsage.readRun(runId).final, true);
  assert.equal(app.store.runs(session.id)[0].status, 'error');
  app.sessionUsage.observe = () => { throw Error('observer failed'); };
  assert.doesNotThrow(() => app.onGatewayEvent({ type: 'session.usage', session_id: 'runtime-app', payload: { usage: numbers(20, 5) } }));
});

test('session creation and resume snapshots establish usage baselines without requesting usage or history RPCs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'application-usage-lifecycle-')), calls = [], route = { provider: 'fixture', model: 'fixture-model' };
  class Fake extends EventEmitter {
    constructor() { super(); this.state = 'ready'; this.serverRequests = new Map(); this.log = []; }
    async request(method) {
      calls.push(method);
      if (method === 'config.get') return { value: 'manual' };
      if (method === 'config.set') return {};
      if (method === 'session.create') return { session_id: 'runtime-created', stored_session_id: 'stored-created', info: { ...route, usage: { ...numbers(0, 0, 0, 0), secret: 'PRIVATE' } } };
      if (method === 'session.activate') return { session_id: 'runtime-created', stored_session_id: 'stored-created', info: { ...route, usage: numbers(20, 5) } };
      if (method === 'session.interrupt') return {};
      throw Error('Unexpected RPC: ' + method);
    }
    async stop() {}
  }
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), workflowRunRoot: join(directory, 'runs') };
  const app = new Application(config, new Fake()); app.backend.state = 'ready';
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const session = await app.createSession({ modelRoute: route });
  assert.equal(app.sessionUsage.read(session.id).source, 'session.create'); assert.equal(app.sessionUsage.read(session.id).newSession, true);
  await app.resume(session.id);
  assert.equal(app.sessionUsage.read(session.id).source, 'session.resume'); assert.equal(app.sessionUsage.read(session.id).usage.total, 25);
  assert.equal(JSON.stringify(app.sessionUsage.read(session.id)).includes('PRIVATE'), false);
  assert.equal(calls.includes('session.usage'), false); assert.equal(calls.includes('session.history'), false); assert.equal(calls.includes('prompt.submit'), false);
});
