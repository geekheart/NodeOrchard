import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application } from '../src/application.mjs';
import { LearningModel } from '../src/workflows/learning-model.mjs';
import { readConfig } from '../src/config.mjs';

const route = { provider: 'fixture-provider', model: 'fixture-model' };
const ready = () => new Promise(resolve => setImmediate(resolve));

class Gateway extends EventEmitter {
  constructor() { super(); this.state = 'ready'; this.calls = []; this.serverRequests = new Map(); this.sequence = 0; }
  async request(method, params = {}) {
    this.calls.push({ method, sessionId: params.session_id });
    if (method === 'config.get') return { value: 'manual' };
    if (method === 'config.set') return { value: params.value };
    if (method === 'session.create') {
      const id = 'runtime-fixture-' + ++this.sequence;
      return { session_id: id, stored_session_id: 'stored-fixture-' + this.sequence, info: { ...route, approval_mode: 'manual' } };
    }
    if (method === 'workbench.assistant.prepare') return { policy: { toolsAllowed: false, applicationTools: 'broker-only',
      sourceMutationBlocked: true, skillMutationBlocked: true, memoryAllowed: false, memoryWriteAllowed: false } };
    if (method === 'prompt.submit') return { status: 'streaming' };
    if (method === 'session.history') return { messages: [{ role: 'assistant', text: '{"ok":true}' }] };
    if (method === 'session.interrupt') {
      queueMicrotask(() => this.emit('event', { type: 'message.complete', session_id: params.session_id, payload: { status: 'interrupted' } }));
      return { interrupted: true };
    }
    throw Error('Unexpected isolated gateway operation: ' + method);
  }
  async stop() { this.state = 'stopped'; }
}

async function fixture(t, { historical = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-timeout-chain-'));
  const config = readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace'),
    WORKBENCH_RUN_ROOT: join(directory, 'runs'), WORKBENCH_HERMES_ROOT: join(directory, 'native-install'), WORKBENCH_HERMES_HOME: join(directory, 'native-home') });
  const adapter = new Gateway(), app = new Application(config, adapter);
  app.backend.state = 'ready';
  t.after(async () => { t.mock.timers.reset(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  await app.workflowFoldersReady; await app.sourceRepairs.ready;
  if (historical) {
    await app.assistantModel.close();
    app.assistantModel = new LearningModel(app, { purpose: 'assistant', timeoutMs: 180000 });
  }
  const started = Date.UTC(2026, 9, 28, 14, 52, 7, 614), normalized = [];
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: started });
  app.on('event', event => { if (['reasoning.delta', 'message.delta', 'message.complete'].includes(event.type)) normalized.push(event); });
  let sessionId;
  const pending = app.assistantModel.generate('Synthetic response-timing fixture. Return only {"ok":true}.', { modelRoute: route, onSession: id => { sessionId = id; } });
  pending.catch(() => {}); await ready();
  assert.equal(adapter.calls.filter(call => call.method === 'prompt.submit').length, 1);
  assert(sessionId); const runtimeId = app.store.get(sessionId).runtimeSessionId;
  const read = () => JSON.parse(app.store.db.prepare('SELECT value FROM application_model_calls WHERE session_id=?').get(sessionId).value);
  const frame = (type, payload = {}) => adapter.emit('event', { type, session_id: runtimeId, payload });
  const traceFrame = () => frame('model.request.trace', { trace: { version: 1, traceId: randomUUID(), requestId: read().requestId,
    requestIndex: 1, status: 'running', startedAt: new Date(started).toISOString(), updatedAt: new Date().toISOString(),
    durationMs: Date.now() - started, transport: 'httpx', observability: { headers: 'observed' },
    http: { status: 200 }, timings: { headersMs: 100, firstBodyByteMs: 105 }, sse: { events: {} }, bodyComplete: false } });
  return { app, adapter, started, normalized, pending, sessionId, runtimeId, read, frame, traceFrame };
}

test('gateway normalization, the historical first-response deadline and interrupt explain an 180005ms / 181-second failure', async t => {
  const f = await fixture(t, { historical: true });
  t.mock.timers.setTime(f.started + 179999);
  f.traceFrame();
  assert.equal(f.app.store.db.prepare('SELECT count(*) count FROM application_model_request_traces WHERE session_id=?').get(f.sessionId).count, 1);
  assert.equal(f.read().firstOutputAt, null, 'HTTP headers and raw body activity are metadata, not visible answer output');
  assert.equal(f.app.events.some(event => event.type === 'model.request.trace'), false, 'raw trace payloads stay off the browser message event stream');
  f.frame('reasoning.delta', { text: 'synthetic-reasoning-activity' });
  assert.equal(f.normalized.at(-1).sessionId, f.sessionId, 'Application must map the gateway runtime to its owned local session');
  assert.equal(f.app.assistantModel.active.has(f.sessionId), true);
  assert.equal(f.read().firstOutputAt, null);
  assert.equal(f.read().outputCharacters, 0, 'reasoning activity is not a visible answer delta');

  // A late event may be dispatched ahead of the already-due timer callback.
  // The actual handleEvent guard must still enforce the original deadline.
  t.mock.timers.setTime(f.started + 180005);
  f.frame('reasoning.delta', { text: 'synthetic-late-activity' });
  await assert.rejects(f.pending, error => error.code === 'MODEL_TIMEOUT' && error.timeoutKind === 'first-response'
    && error.phase === 'model-response' && error.elapsedMs === 180005 && /181 秒/.test(error.message));
  await ready();
  const metric = f.read();
  assert.equal(metric.status, 'timeout'); assert.equal(metric.errorCode, 'MODEL_TIMEOUT'); assert.equal(metric.timeoutKind, 'first-response');
  assert.equal(Date.parse(metric.completedAt) - Date.parse(metric.startedAt), 180005);
  assert.equal(metric.firstOutputAt, null); assert.equal(metric.outputCharacters, 0);
  assert.equal(metric.timeoutPolicy.firstResponseTimeoutMs, 180000);
  assert.deepEqual(f.adapter.calls.filter(call => call.method === 'session.interrupt'), [{ method: 'session.interrupt', sessionId: f.runtimeId }]);
  assert.equal(f.app.assistantModel.active.size, 0); assert.equal(f.app.assistantModel.pending.size, 0);
  assert.equal(f.app.store.get(f.sessionId).status, 'interrupted');
  f.frame('message.delta', { text: 'synthetic-late-answer' });
  f.frame('message.complete', { status: 'complete' }); await ready();
  assert.deepEqual(f.read(), metric, 'late terminal events cannot rewrite the confirmed controller timeout');
  assert.equal(f.adapter.calls.filter(call => call.method === 'session.history').length, 0);
});

test('the current no-deadline default permits the same gateway silence beyond the historical cutoff and completes normally', async t => {
  const f = await fixture(t);
  t.mock.timers.setTime(f.started + 180005); f.traceFrame(); f.frame('reasoning.delta', { text: 'synthetic-reasoning-activity' });
  assert.equal(f.read().status, 'running'); assert.equal(f.read().firstOutputAt, null);
  assert.equal(f.app.assistantModel.active.has(f.sessionId), true);
  assert.deepEqual(f.adapter.calls.filter(call => call.method === 'session.interrupt'), []);
  t.mock.timers.setTime(f.started + 600000); f.frame('message.delta', { text: '{"ok":' });
  assert.equal(f.read().firstOutputAt, new Date(f.started + 600000).toISOString());
  f.frame('message.complete', { status: 'complete' });
  assert.equal(await f.pending, '{"ok":true}');
  const metric = f.read(); assert.equal(metric.status, 'complete'); assert.equal(metric.timeoutKind, null);
  assert.deepEqual(metric.timeoutPolicy, { firstResponseTimeoutMs: null, outputIdleTimeoutMs: null, maxDurationMs: null, deadlineAt: null });
  assert.equal(f.adapter.calls.filter(call => call.method === 'session.history').length, 1);
  assert.equal(f.adapter.calls.filter(call => call.method === 'prompt.submit').length, 1);
  assert.deepEqual(f.adapter.calls.filter(call => call.method === 'session.interrupt'), []);
});
