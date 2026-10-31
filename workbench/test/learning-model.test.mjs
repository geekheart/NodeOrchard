import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { LearningModel } from '../src/workflows/learning-model.mjs';

function fixture(t, options = {}) {
  const app = new EventEmitter(); const db = new DatabaseSync(':memory:'); let count = 0;
  app.store = { db }; app.interrupted = []; app.submitted = [];
  app.createSession = async () => ({ id: 'local-' + ++count, runtimeSessionId: 'runtime-' + count });
  app.interrupt = async id => { app.interrupted.push(id); };
  app.adapter = { request: async () => ({ policy: { toolsAllowed: false, skillMutationBlocked: true, memoryAllowed: true, memoryWriteAllowed: false } }) };
  app.history = async () => ({ messages: [{ role: 'assistant', text: '{"score":100}' }] });
  const model = new LearningModel(app, options);
  app.submit = async (id, prompt, { learningRequestId }) => {
    assert.equal(model.allowsSubmit(id, learningRequestId), true);
    assert.equal(model.allowsSubmit(id, 'foreign-request'), false);
    app.submitted.push({ id, prompt });
    app.emit('event', { type: 'message.complete', sessionId: id, payload: { status: 'complete' } });
    return { status: 'streaming' };
  };
  t.after(async () => { await model.close(); db.close(); });
  return { app, model };
}

test('learning model confirms no-tools policy and authoritative history, protects durable sessions', async t => {
  const { app, model } = fixture(t); let sessionId;
  assert.equal(await model.generate('Return a JSON score.', { onSession: id => { sessionId = id; } }), '{"score":100}');
  assert.equal(app.submitted.length, 1);
  assert.equal(model.ownsSession(sessionId), true);
  assert.equal(model.allowsSubmit(sessionId, undefined), false);
  assert.equal(model.active.size, 0);
});

test('unconfirmed no-tools policy prevents any learning model submission', async t => {
  const { app, model } = fixture(t);
  app.adapter.request = async () => ({ policy: { toolsAllowed: true, skillMutationBlocked: true, memoryAllowed: true } });
  await assert.rejects(model.generate('Evaluate.'), /无工具策略/);
  assert.equal(app.submitted.length, 0); assert.deepEqual(app.interrupted, ['local-1']);
});

test('an explicit native Codex missing-access-token preparation failure is actionable and never submits a prompt', async t => {
  const { app, model } = fixture(t, { purpose: 'assistant' }), logs = [], calls = [];
  app.logger = { write: (...args) => logs.push(args) };
  app.adapter.request = async method => { calls.push(method); throw Object.assign(new Error('Codex auth is missing access_token. Run `hermes auth add openai-codex --type oauth` to re-authenticate. token=PRIVATE_NATIVE_AUTH'), { code: -32603 }); };
  await assert.rejects(model.generate('Classify this private task.'), error => {
    assert.equal(error.code, 'MODEL_AUTH_REQUIRED'); assert.equal(error.phase, 'prepare-model');
    assert.match(error.message, /Hermes Codex.*登录/); assert.match(error.message, /hermes auth add openai-codex --type oauth/);
    assert.doesNotMatch(error.message, /PRIVATE_NATIVE_AUTH|access_token\./); return true;
  });
  assert.deepEqual(calls, ['workbench.assistant.prepare']); assert.equal(app.submitted.length, 0);
  const metric = JSON.parse(app.store.db.prepare('SELECT value FROM application_model_calls WHERE session_id=?').get('local-1').value);
  assert.equal(metric.errorCode, 'MODEL_AUTH_REQUIRED'); assert.equal(metric.status, 'error'); assert.equal(metric.submittedAt, null);
  assert.doesNotMatch(JSON.stringify([metric, logs]), /PRIVATE_NATIVE_AUTH|auth add|access_token/);
});

test('generic native preparation errors are not guessed to be Codex authentication failures', async t => {
  const { app, model } = fixture(t, { purpose: 'assistant' });
  for (const message of ['Internal server error', 'Missing access_token for another provider', 'Codex auth is missing access_token_suffix']) {
    app.adapter.request = async () => { throw Object.assign(new Error(message), { code: 500 }); };
    await assert.rejects(model.generate('Classify.'), error => error.code === 500 && error.message === message);
  }
  assert.equal(app.submitted.length, 0);
  for (const row of app.store.db.prepare('SELECT value FROM application_model_calls').all()) assert.equal(JSON.parse(row.value).errorCode, 'MODEL_ERROR');
});

test('learning models require explicit denial of memory writes before submitting any prompt', async t => {
  const { app, model } = fixture(t);
  for (const value of [undefined, true, null]) {
    app.adapter.request = async () => ({ policy: { toolsAllowed: false, skillMutationBlocked: true, memoryAllowed: true,
      ...(value === undefined ? {} : { memoryWriteAllowed: value }) } });
    await assert.rejects(model.generate('Evaluate the private validation answer.'), /记忆只读策略/);
  }
  assert.equal(app.submitted.length, 0);
  assert.deepEqual(app.interrupted, ['local-1', 'local-2', 'local-3']);
});

test('stop while preparing prevents submission even after the RPC later succeeds', async t => {
  const { app, model } = fixture(t); const controller = new AbortController(); let resolvePrepare;
  app.adapter.request = () => new Promise(resolve => { resolvePrepare = resolve; });
  const pending = model.generate('Evaluate.', { signal: controller.signal }); pending.catch(() => {});
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  resolvePrepare({ policy: { toolsAllowed: false, skillMutationBlocked: true, memoryAllowed: true, memoryWriteAllowed: false } });
  await assert.rejects(pending, /停止/); assert.equal(app.submitted.length, 0);
});

test('a terminal before a lost ACK stays authoritative in learning model calls', async t => {
  const { app, model } = fixture(t);
  app.submit = async id => {
    app.emit('event', { type: 'message.complete', sessionId: id, payload: { status: 'complete' } });
    throw new Error('Lost ACK');
  };
  assert.equal(await model.generate('Evaluate.'), '{"score":100}');
});

test('learning model stops on unexpected interaction, disconnect or timeout', async t => {
  const { app, model } = fixture(t, { timeoutMs: 30 });
  app.submit = async id => {
    app.emit('event', { type: 'request.open', sessionId: id, payload: { id: 'tool' } });
  };
  await assert.rejects(model.generate('Evaluate.'), /意外请求/);
  app.submit = async () => {};
  const disconnected = model.generate('Evaluate.'); disconnected.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  app.emit('event', { type: 'backend.status', payload: { state: 'disconnected' } });
  await assert.rejects(disconnected, /连接中断/);
  const timeout = model.generate('Evaluate.');
  const keepAlive = setInterval(() => {}, 10);
  try { await assert.rejects(timeout, /超时/); } finally { clearInterval(keepAlive); }
});

test('late history after abort cannot turn a stopped learning model call into success', async t => {
  const { app, model } = fixture(t); const controller = new AbortController(); let resolveHistory;
  app.history = () => new Promise(resolve => { resolveHistory = resolve; });
  const pending = model.generate('Evaluate.', { signal: controller.signal }); pending.catch(() => {});
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  resolveHistory({ messages: [{ role: 'assistant', text: 'late success' }] });
  await assert.rejects(pending, /停止/); assert.equal(model.active.size, 0);
});

test('abort settles a learning model call even while the submit ACK is blocked', async t => {
  const { app, model } = fixture(t); const controller = new AbortController();
  app.submit = () => new Promise(() => {});
  const pending = model.generate('Evaluate.', { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, /停止/); assert.equal(model.active.size, 0);
});

test('abort and close settle during session creation, and late unused sessions stay managed', async t => {
  const { app, model } = fixture(t); let releaseCreate;
  app.createSession = () => new Promise(resolve => { releaseCreate = resolve; });
  const controller = new AbortController();
  const pending = model.generate('Evaluate.', { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, /停止/);
  releaseCreate({ id: 'late', runtimeSessionId: 'late-runtime' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(model.ownsSession('late'), true); assert.equal(app.submitted.length, 0);
  const closing = model.generate('Evaluate.');
  await model.close(); await assert.rejects(closing, /关闭/);
  releaseCreate({ id: 'after-close', runtimeSessionId: 'unused' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.submitted.length, 0); assert.equal(model.pending.size, 0);
});

test('memory capture has no prompt, and subsequent model calls confirm the same fixed batch context', async t => {
  const { app, model } = fixture(t), id = randomUUID(), calls = [];
  const policy = { toolsAllowed: false, memoryAllowed: true, memoryWriteAllowed: false, skillMutationBlocked: true,
    externalMemoryAllowed: false, memoryMode: 'batch-snapshot', memoryScopeId: id };
  app.adapter.request = async (method, params) => { calls.push({ method, params }); return { policy }; };
  let anchor;
  const scope = await model.createMemoryScope({ id, onSession: value => { anchor = value; } });
  assert.deepEqual(scope, { id, mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false });
  assert.equal(model.ownsSession(anchor), true); assert.equal(model.allowsSubmit(anchor, undefined), false);
  assert.deepEqual(app.submitted, [], 'capturing memory must never send a model prompt');
  await model.generate('Score one validation result.', { memoryScopeId: id });
  await model.generate('Rewrite using training evidence.', { memoryScopeId: id });
  assert.deepEqual(calls.map(row => row.method), ['workbench.learning.memory.capture', 'workbench.learning.prepare', 'workbench.learning.prepare']);
  assert(calls.every(row => row.params.memory_scope_id === id));
  await model.releaseMemoryScope(id);
  assert.deepEqual(calls.at(-1), { method: 'workbench.learning.memory.release', params: { memory_scope_id: id } });
  assert.equal(model.memoryScopes.size, 0);
});

test('persistent scope restoration confirms the exact original descriptor without creating a session or capturing live memory', async t => {
  const { app, model } = fixture(t), id = randomUUID(), calls = [];
  const snapshot = { version: 1, scopeId: id, digest: 'sha256:' + 'a'.repeat(64) };
  app.createSession = async () => assert.fail('Restoring a snapshot must not create a live-memory anchor');
  app.adapter.request = async (method, params) => {
    calls.push({ method, params });
    return { policy: { toolsAllowed: false, memoryAllowed: true, memoryWriteAllowed: false, externalMemoryAllowed: false,
      memoryMode: 'batch-snapshot', memoryScopeId: id, skillMutationBlocked: true }, snapshot: { ...snapshot } };
  };
  const restored = await model.restoreMemoryScope({ id, snapshot });
  assert.equal(restored.snapshot.digest, snapshot.digest); assert.equal(model.memoryScopes.has(id), true);
  assert.deepEqual(calls, [{ method: 'workbench.learning.memory.restore', params: { snapshot } }]);
  model.suspendMemoryScope(id); await model.close();
  assert.equal(calls.length, 1, 'suspending a human wait preserves its persisted memory for the next gateway');
  assert.equal(app.submitted.length, 0);
});

test('a missing or changed persistent snapshot rejects recovery without a fresh capture or model prompt', async t => {
  const { app, model } = fixture(t), id = randomUUID();
  const snapshot = { version: 1, scopeId: id, digest: 'sha256:' + 'a'.repeat(64) }, calls = [];
  app.adapter.request = async method => { calls.push(method); throw new Error('Original memory snapshot missing'); };
  await assert.rejects(model.restoreMemoryScope({ id, snapshot }), /snapshot missing/);
  assert.deepEqual(calls, ['workbench.learning.memory.restore']); assert.equal(model.memoryScopes.size, 0);
  app.adapter.request = async method => { calls.push(method); return { policy: { toolsAllowed: false, memoryAllowed: true,
    memoryWriteAllowed: false, externalMemoryAllowed: false, memoryMode: 'batch-snapshot', memoryScopeId: id,
    skillMutationBlocked: true }, snapshot: { ...snapshot, digest: 'sha256:' + 'b'.repeat(64) } }; };
  await assert.rejects(model.restoreMemoryScope({ id, snapshot }), /原批次记忆/);
  assert(calls.every(method => method === 'workbench.learning.memory.restore'));
  assert.equal(app.submitted.length, 0); assert.equal(model.memoryScopes.size, 0);
});

test('batch controls reject a missing, changed or live memory acknowledgement before submitting', async t => {
  const { app, model } = fixture(t), id = randomUUID();
  const policy = { toolsAllowed: false, memoryAllowed: true, memoryWriteAllowed: false, skillMutationBlocked: true,
    externalMemoryAllowed: false, memoryMode: 'batch-snapshot', memoryScopeId: id };
  for (const changes of [{ memoryScopeId: randomUUID() }, { memoryMode: 'live' }, { externalMemoryAllowed: true }, { memoryWriteAllowed: true }]) {
    app.adapter.request = async () => ({ policy: { ...policy, ...changes } });
    await assert.rejects(model.generate('Sensitive validation score.', { memoryScopeId: id }), /记忆/);
    await assert.rejects(model.createMemoryScope({ id }), /记忆/);
  }
  assert.equal(app.submitted.length, 0);
});

test('aborting a delayed memory capture settles immediately and releases a late admission', async t => {
  const { app, model } = fixture(t), id = randomUUID(), controller = new AbortController(), releases = [];
  let acknowledge;
  app.adapter.request = async (method, params) => {
    if (method === 'workbench.learning.memory.capture') return new Promise(resolve => { acknowledge = resolve; });
    if (method === 'workbench.learning.memory.release') { releases.push(params.memory_scope_id); return { released: true }; }
    throw new Error('No other operation can follow a stopped capture.');
  };
  const pending = model.createMemoryScope({ id, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, /停止/);
  assert(releases.includes(id)); assert.equal(model.pending.size, 0);
  acknowledge({ policy: { toolsAllowed: false, memoryAllowed: true, memoryWriteAllowed: false, skillMutationBlocked: true,
    externalMemoryAllowed: false, memoryMode: 'batch-snapshot', memoryScopeId: id } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 2); assert.equal(app.submitted.length, 0); assert.equal(model.memoryScopes.size, 0);
});

test('memory capture times out or loses connection without admitting model submissions', async t => {
  const { app, model } = fixture(t, { timeoutMs: 25 }), id = randomUUID(), releases = [];
  app.adapter.request = async (method, params) => {
    if (method === 'workbench.learning.memory.release') { releases.push(params.memory_scope_id); return { released: true }; }
    return new Promise(() => {});
  };
  const pending = model.createMemoryScope({ id });
  await new Promise(resolve => setImmediate(resolve));
  app.emit('event', { type: 'backend.status', payload: { state: 'disconnected' } });
  await assert.rejects(pending, /连接中断/);
  const secondId = randomUUID(), timeout = model.createMemoryScope({ id: secondId });
  const keepAlive = setInterval(() => {}, 10);
  try { await assert.rejects(timeout, /超时/); } finally { clearInterval(keepAlive); }
  assert.deepEqual(releases, [id, secondId]); assert.equal(app.submitted.length, 0);
});
