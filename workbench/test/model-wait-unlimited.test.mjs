import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { LearningModel } from '../src/workflows/learning-model.mjs';

const ready = () => new Promise(resolve => setImmediate(resolve));
const day = 24 * 60 * 60 * 1000;
function fixture(t, purpose = 'assistant') {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 9, 28) });
  const app = new EventEmitter(), db = new DatabaseSync(':memory:'), interrupted = [], submitted = [];
  app.store = { db }; app.createSession = async () => ({ id: 'controlled', runtimeSessionId: 'native-controlled' });
  app.interrupt = async id => { interrupted.push(id); };
  app.adapter = { request: async () => ({ policy: { toolsAllowed: false, skillMutationBlocked: true,
    memoryAllowed: purpose === 'learning', memoryWriteAllowed: false, applicationTools: 'broker-only', sourceMutationBlocked: true } }) };
  app.submit = async (...args) => { submitted.push(args); };
  app.history = async () => ({ messages: [{ role: 'assistant', text: 'authoritative result' }] });
  const model = new LearningModel(app, { purpose });
  t.after(async () => { await model.close(); db.close(); });
  const generate = options => { const promise = model.generate('A controlled model request.', options); promise.catch(() => {}); return promise; };
  const emit = (type, payload) => app.emit('event', { type, sessionId: 'controlled', payload });
  const metrics = () => JSON.parse(db.prepare('SELECT value FROM application_model_calls WHERE session_id=?').get('controlled').value);
  return { app, model, generate, emit, metrics, interrupted, submitted };
}

test('default assistant waits beyond all former deadlines and accepts a late first output, idle gap and final readback', async t => {
  const f = fixture(t), pending = f.generate(); await ready();
  assert.deepEqual(f.metrics().timeoutPolicy, { firstResponseTimeoutMs: null, outputIdleTimeoutMs: null, maxDurationMs: null, deadlineAt: null });
  t.mock.timers.tick(day); assert.equal(f.model.active.size, 1); assert.deepEqual(f.interrupted, []);
  f.emit('message.delta', { text: 'partial' }); t.mock.timers.tick(day);
  assert.equal(f.model.active.size, 1); assert.deepEqual(f.interrupted, []);
  let readback; f.app.history = () => new Promise(resolve => { readback = resolve; });
  f.emit('message.complete', { status: 'complete' }); t.mock.timers.tick(day);
  assert.equal(f.model.active.size, 1); readback({ messages: [{ role: 'assistant', text: 'late authoritative result' }] });
  assert.equal(await pending, 'late authoritative result'); assert.equal(f.metrics().status, 'complete'); assert.equal(f.submitted.length, 1);
});

test('default learning model also waits for its native result rather than imposing a local three-minute cutoff', async t => {
  const f = fixture(t, 'learning'), pending = f.generate(); await ready();
  t.mock.timers.tick(day); assert.equal(f.model.active.size, 1); assert.deepEqual(f.interrupted, []);
  f.emit('message.complete', { status: 'complete' }); assert.equal(await pending, 'authoritative result'); assert.equal(f.submitted.length, 1);
});

test('a native timeout after a long wait remains the authoritative error and never replays the model request', async t => {
  const f = fixture(t), pending = f.generate(); await ready(); t.mock.timers.tick(day);
  f.emit('error', { message: 'Provider request timed out upstream.' });
  await assert.rejects(pending, /Provider request timed out upstream/);
  assert.equal(f.metrics().timeoutKind, null); assert.equal(f.metrics().status, 'error'); assert.equal(f.submitted.length, 1);
});

test('manual stop and backend disconnect still settle an unlimited wait and ignore late output', async t => {
  const f = fixture(t), controller = new AbortController(), pending = f.generate({ signal: controller.signal }); await ready();
  t.mock.timers.tick(day); controller.abort(); await assert.rejects(pending, error => error.code === 'MODEL_ABORTED');
  f.emit('message.complete', { status: 'complete' }); assert.equal(f.metrics().status, 'interrupted'); assert.equal(f.model.active.size, 0);
  const disconnected = f.generate(); await ready(); t.mock.timers.tick(day);
  f.app.emit('event', { type: 'backend.status', payload: { state: 'disconnected' } });
  await assert.rejects(disconnected, error => error.code === 'MODEL_DISCONNECTED'); assert.equal(f.submitted.length, 2);
});
