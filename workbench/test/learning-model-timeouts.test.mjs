import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { LearningModel } from '../src/workflows/learning-model.mjs';

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 9, 27) });
  const app = new EventEmitter(), db = new DatabaseSync(':memory:'), interrupted = [], progress = [];
  app.store = { db };
  app.createSession = async () => ({ id: 'assistant-session', runtimeSessionId: 'runtime-session' });
  app.interrupt = async id => { interrupted.push(id); };
  app.adapter = { request: async () => ({ policy: { toolsAllowed: false, skillMutationBlocked: true,
    memoryAllowed: false, memoryWriteAllowed: false, applicationTools: 'broker-only', sourceMutationBlocked: true } }) };
  app.submit = async () => {};
  app.history = async () => ({ messages: [{ role: 'assistant', text: '{"text":"complete"}' }] });
  const model = new LearningModel(app, { purpose: 'assistant', timeoutMs: 180000, ...options });
  t.after(async () => { await model.close(); db.close(); });
  return { app, db, model, interrupted, progress, generate: options => {
    const pending = model.generate('Return the next controlled diagnostic action.', { onProgress: value => { progress.push(value); }, ...options });
    pending.catch(() => {});
    return pending;
  } };
}

const ready = () => new Promise(resolve => setImmediate(resolve));
const delta = app => app.emit('event', { type: 'message.delta', sessionId: 'assistant-session', payload: { text: '{"text":' } });
const complete = app => app.emit('event', { type: 'message.complete', sessionId: 'assistant-session', payload: { status: 'complete' } });

test('an assistant first output at 179 seconds gets its bounded output window instead of the old 180-second cutoff', async t => {
  const { app, model, interrupted, generate } = fixture(t);
  const pending = generate(); await ready();
  t.mock.timers.tick(179350); delta(app);
  t.mock.timers.tick(650);
  assert.equal(model.active.has('assistant-session'), true, 'receiving output must not be cut off by the expired first-response timer');
  t.mock.timers.tick(1000); complete(app);
  assert.equal(await pending, '{"text":"complete"}');
  assert.deepEqual(interrupted, []);
});

test('explicitly bounded assistant budgets and durable metadata describe real first output without persisting content', async t => {
  const { app, db, generate, progress } = fixture(t);
  const pending = generate(); await ready();
  const read = () => JSON.parse(db.prepare('SELECT value FROM application_model_calls WHERE session_id=?').get('assistant-session').value);
  const initial = read();
  assert.deepEqual(initial.timeoutPolicy, { firstResponseTimeoutMs: 180000, outputIdleTimeoutMs: 60000,
    maxDurationMs: 360000, deadlineAt: new Date(Date.now() + 360000).toISOString() });
  assert.equal(initial.firstOutputAt, null); assert.equal(initial.lastOutputAt, null);
  assert.equal(initial.promptCharacters, 'Return the next controlled diagnostic action.'.length);
  t.mock.timers.tick(1250); delta(app);
  const first = read(); assert.equal(first.firstOutputAt, new Date(Date.now()).toISOString());
  assert.equal(first.outputCharacters, '{"text":'.length);
  const writesBeforeChunk = first;
  t.mock.timers.tick(250); delta(app);
  assert.deepEqual(read(), writesBeforeChunk, 'later chunks must not produce persistent writes');
  complete(app); await pending;
  const final = read();
  assert.equal(final.status, 'complete'); assert.equal(final.timeoutKind, null); assert.equal(final.errorCode, null);
  assert.equal(final.lastOutputAt, new Date(Date.now()).toISOString()); assert.equal(final.completedAt, final.lastOutputAt);
  assert(final.outputCharacters > 0); assert(progress.every(row => row.metrics?.version === 1));
  assert.doesNotMatch(JSON.stringify(final), /Return the next|complete\"\}|runtime-session/);
});

test('empty deltas never extend first-response admission and timeout interrupts exactly once', async t => {
  const { app, db, model, interrupted, generate } = fixture(t);
  const pending = generate(); await ready();
  for (let index = 0; index < 17; index++) {
    t.mock.timers.tick(10000);
    app.emit('event', { type: 'message.delta', sessionId: 'assistant-session', payload: { text: '' } });
  }
  t.mock.timers.tick(10000);
  await assert.rejects(pending, error => error.code === 'MODEL_TIMEOUT' && error.timeoutKind === 'first-response' && error.phase === 'model-response');
  complete(app); delta(app); await ready();
  assert.equal(model.active.size, 0); assert.deepEqual(interrupted, ['assistant-session']);
  const saved = JSON.parse(db.prepare('SELECT value FROM application_model_calls').get().value);
  assert.equal(saved.firstOutputAt, null); assert.equal(saved.outputCharacters, 0); assert.equal(saved.status, 'timeout');
});

test('assistant output idle resets on actual chunks but stalls fail with partial-output metadata', async t => {
  const { app, db, interrupted, generate } = fixture(t);
  const pending = generate(); await ready();
  t.mock.timers.tick(10000); delta(app);
  t.mock.timers.tick(59000); delta(app);
  t.mock.timers.tick(59000);
  assert.deepEqual(interrupted, []);
  app.emit('event', { type: 'message.delta', sessionId: 'assistant-session', payload: {} });
  t.mock.timers.tick(1000);
  await assert.rejects(pending, error => error.code === 'MODEL_TIMEOUT' && error.timeoutKind === 'output-idle' && error.elapsedMs === 129000);
  const saved = JSON.parse(db.prepare('SELECT value FROM application_model_calls').get().value);
  assert.equal(saved.status, 'timeout'); assert.equal(saved.timeoutKind, 'output-idle'); assert(saved.outputCharacters > 0);
  assert.deepEqual(interrupted, ['assistant-session']);
});

test('an endless nonempty stream remains bounded by the original absolute deadline', async t => {
  const { app, interrupted, generate } = fixture(t);
  const pending = generate(); await ready();
  for (let index = 0; index < 7; index++) { t.mock.timers.tick(50000); delta(app); }
  t.mock.timers.tick(10000);
  await assert.rejects(pending, error => error.timeoutKind === 'absolute' && error.elapsedMs === 360000);
  assert.deepEqual(interrupted, ['assistant-session']);
});

test('a parent turn deadline cancels model output and ignores a late authoritative completion', async t => {
  const { app, db, model, interrupted, generate } = fixture(t); let historyCalls = 0;
  app.history = async () => { historyCalls++; return { messages: [{ role: 'assistant', text: 'late' }] }; };
  const deadlineAt = Date.now() + 35000, pending = generate({ deadlineAt }); await ready();
  t.mock.timers.tick(30000); delta(app); t.mock.timers.tick(5000);
  await assert.rejects(pending, error => error.timeoutKind === 'absolute' && error.metrics.timeoutPolicy.deadlineAt === new Date(deadlineAt).toISOString());
  complete(app); await ready();
  assert.equal(historyCalls, 0); assert.equal(model.pending.size, 0); assert.deepEqual(interrupted, ['assistant-session']);
  assert.equal(JSON.parse(db.prepare('SELECT value FROM application_model_calls').get().value).status, 'timeout');
});

test('an expired parent deadline never creates a new model session', async t => {
  const { app, generate } = fixture(t); let created = 0;
  app.createSession = async () => { created++; throw new Error('must not be called'); };
  await assert.rejects(generate({ deadlineAt: Date.now() - 1 }), error => error.timeoutKind === 'absolute');
  assert.equal(created, 0);
});

test('a successful terminal before a late submit ACK gets a bounded readback window', async t => {
  const { app, interrupted, generate } = fixture(t); let acknowledge, readback;
  app.submit = () => new Promise(resolve => { acknowledge = resolve; });
  app.history = () => new Promise(resolve => { readback = resolve; });
  const pending = generate(); await ready();
  t.mock.timers.tick(179500); complete(app);
  t.mock.timers.tick(1000); acknowledge();
  readback({ messages: [{ role: 'assistant', text: 'authoritative result' }] });
  assert.equal(await pending, 'authoritative result'); assert.deepEqual(interrupted, []);
});

test('single-call probe budgets may shorten but cannot expand configured response and idle limits', async t => {
  const { app, db, generate } = fixture(t);
  const pending = generate({ firstResponseTimeoutMs: 30000, outputIdleTimeoutMs: 10000, deadlineAt: Date.now() + 30000 }); await ready();
  t.mock.timers.tick(1000); delta(app); t.mock.timers.tick(10000);
  await assert.rejects(pending, error => error.timeoutKind === 'output-idle');
  const second = generate({ firstResponseTimeoutMs: 400000, outputIdleTimeoutMs: 400000 }); await ready();
  const policy = JSON.parse(db.prepare('SELECT value FROM application_model_calls').get().value).timeoutPolicy;
  assert.equal(policy.firstResponseTimeoutMs, 180000); assert.equal(policy.outputIdleTimeoutMs, 60000);
  complete(app); await second;
});

test('abort and shutdown persist terminal status and never admit late output as success', async t => {
  const { app, db, model, interrupted, generate } = fixture(t), controller = new AbortController();
  const pending = generate({ signal: controller.signal }); await ready(); delta(app); controller.abort();
  await assert.rejects(pending, error => error.code === 'MODEL_ABORTED');
  complete(app);
  assert.equal(JSON.parse(db.prepare('SELECT value FROM application_model_calls').get().value).status, 'interrupted');
  const closing = generate(); await ready(); await model.close();
  await assert.rejects(closing, error => error.code === 'MODEL_CLOSED');
  const saved = JSON.parse(db.prepare('SELECT value FROM application_model_calls').get().value);
  assert.equal(saved.status, 'interrupted'); assert.equal(saved.errorCode, 'MODEL_CLOSED');
  assert.deepEqual(interrupted, ['assistant-session', 'assistant-session']);
});

test('unavailable metrics persistence never changes the authoritative guarded model result', async t => {
  const { app, db, generate } = fixture(t);
  db.exec('DROP TABLE application_model_calls');
  const pending = generate(); await ready(); delta(app); complete(app);
  assert.equal(await pending, '{"text":"complete"}');
});

test('a frame queued ahead of an overdue timer cannot renew an already expired wait window', async t => {
  const { app, interrupted, generate } = fixture(t);
  const pending = generate(); await ready();
  t.mock.timers.setTime(Date.now() + 180001); delta(app);
  await assert.rejects(pending, error => error.timeoutKind === 'first-response');
  assert.deepEqual(interrupted, ['assistant-session']);
});
