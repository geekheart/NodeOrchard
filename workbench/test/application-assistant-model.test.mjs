import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { LearningModel } from '../src/workflows/learning-model.mjs';

test('application calls use a separate broker-only policy, durable owner and genuine image admission', async t => {
  const app = new EventEmitter(), db = new DatabaseSync(':memory:'), calls = [];
  const policy = { toolsAllowed: false, skillMutationBlocked: true, memoryAllowed: false, memoryWriteAllowed: false, applicationTools: 'broker-only', sourceMutationBlocked: true };
  app.store = { db }; app.interrupt = async () => {}; app.createSession = async () => ({ id: 'local', runtimeSessionId: 'runtime' });
  app.adapter = { request: async (method, args) => { calls.push({ method, args }); return method.endsWith('.images') ? { attached: args.images.length, mode: 'native-content' } : { policy }; } };
  app.history = async () => ({ messages: [{ role: 'assistant', text: '{"text":"页面可见"}' }] });
  const assistant = new LearningModel(app, { purpose: 'assistant' }), learning = new LearningModel(app);
  t.after(async () => { await assistant.close(); await learning.close(); db.close(); });
  app.submit = async (id, text, options) => { assert.equal(assistant.allowsSubmit(id, options.assistantRequestId), true); assert.equal(options.learningRequestId, undefined); app.emit('event', { type: 'message.complete', sessionId: id, payload: { status: 'complete' } }); };
  assert.equal(await assistant.generate('分析截图', { images: ['/private/diagnostics/frame.png'] }), '{"text":"页面可见"}');
  assert.deepEqual(calls.map(call => call.method), ['workbench.assistant.prepare', 'workbench.assistant.images']);
  assert.equal(assistant.ownsSession('local'), true); assert.equal(learning.ownsSession('local'), false);
  await assert.rejects(assistant.createMemoryScope({ id: crypto.randomUUID() }), /不能访问学习记忆/);
  await assert.rejects(learning.generate('截图', { images: ['/private/file.png'] }), /图像输入无效/);
});

test('a missing assistant guard or image acknowledgement fails closed before inference', async t => {
  const app = new EventEmitter(), db = new DatabaseSync(':memory:'); let submitted = 0, index = 0;
  app.store = { db }; app.interrupt = async () => {}; app.createSession = async () => ({ id: 'local-' + ++index, runtimeSessionId: 'runtime' }); app.submit = async () => { submitted++; };
  app.adapter = { request: async () => ({ policy: { toolsAllowed: false, memoryAllowed: true, memoryWriteAllowed: false, skillMutationBlocked: true } }) };
  const model = new LearningModel(app, { purpose: 'assistant' }); t.after(async () => { await model.close(); db.close(); });
  await assert.rejects(model.generate('检查'), /源码保护策略/); assert.equal(submitted, 0);
  app.adapter.request = async method => method.endsWith('.images') ? { attached: 0, mode: 'text-path' } : { policy: { toolsAllowed: false, memoryAllowed: false, memoryWriteAllowed: false, skillMutationBlocked: true, applicationTools: 'broker-only', sourceMutationBlocked: true } };
  await assert.rejects(model.generate('检查图像', { images: ['/private/diagnostics/image.png'] }), /未确认接收诊断关键帧/); assert.equal(submitted, 0);
});

function progressFixture(t, { timeoutMs = 1000 } = {}) {
  const app = new EventEmitter(), db = new DatabaseSync(':memory:'), phases = [], interrupted = [];
  app.store = { db };
  app.createSession = async () => ({ id: 'local', runtimeSessionId: 'runtime' });
  app.interrupt = async id => { interrupted.push(id); };
  app.adapter = { request: async () => ({ policy: { toolsAllowed: false, skillMutationBlocked: true,
    memoryAllowed: false, memoryWriteAllowed: false, applicationTools: 'broker-only', sourceMutationBlocked: true } }) };
  app.submit = async () => {};
  app.history = async () => ({ messages: [{ role: 'assistant', text: '{"text":"已检查"}' }] });
  const model = new LearningModel(app, { purpose: 'assistant', timeoutMs });
  t.after(async () => { await model.close(); db.close(); });
  return { app, model, phases, interrupted, onProgress: value => { phases.push(value); } };
}

test('assistant reports preparation, actual response and authoritative readback phases without regressing after a late ACK', async t => {
  const { app, model, phases, onProgress } = progressFixture(t);
  let acknowledge;
  app.submit = async id => {
    app.emit('event', { type: 'message.delta', sessionId: id, payload: { text: '{"text":' } });
    await new Promise(resolve => { acknowledge = resolve; });
  };
  const pending = model.generate('检查', { onProgress });
  pending.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(phases.map(phase => phase.stage), ['create-session', 'prepare-model', 'submit-model', 'model-output']);
  acknowledge(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(phases.at(-1).stage, 'model-output');
  app.emit('event', { type: 'message.complete', sessionId: 'local', payload: { status: 'complete' } });
  assert.equal(await pending, '{"text":"已检查"}');
  assert.equal(phases.at(-1).stage, 'read-result');
  assert(phases.every(phase => typeof phase.label === 'string' && Number.isFinite(Date.parse(phase.startedAt)) && phase.elapsedMs >= 0));
});

test('assistant timeout identifies the actual blocked phase and never treats partial output or late history as success', async t => {
  for (const stage of ['create-session', 'prepare-model', 'prepare-images', 'submit-model', 'model-response', 'model-output', 'read-result']) {
    await t.test(stage, async sub => {
      const { app, model, phases, interrupted, onProgress } = progressFixture(sub, { timeoutMs: 30 });
      let release;
      if (stage === 'create-session') app.createSession = () => new Promise(resolve => { release = () => resolve({ id: 'late', runtimeSessionId: 'late-runtime' }); });
      if (stage === 'prepare-model') app.adapter.request = () => new Promise(resolve => { release = () => resolve({ policy: {} }); });
      if (stage === 'prepare-images') {
        const prepare = app.adapter.request;
        app.adapter.request = method => method.endsWith('.images')
          ? new Promise(resolve => { release = () => resolve({ attached: 1, mode: 'native-content' }); }) : prepare(method);
      }
      if (stage === 'submit-model') app.submit = () => new Promise(() => {});
      if (stage === 'model-output') app.submit = async id => {
        app.emit('event', { type: 'message.delta', sessionId: id, payload: { text: 'partial' } });
      };
      if (stage === 'read-result') {
        app.submit = async id => { app.emit('event', { type: 'message.complete', sessionId: id, payload: { status: 'complete' } }); };
        app.history = () => new Promise(resolve => { release = () => resolve({ messages: [{ role: 'assistant', text: 'late result' }] }); });
      }
      const keepAlive = setInterval(() => {}, 10);
      try {
        await assert.rejects(model.generate('检查', { onProgress, ...(stage === 'prepare-images' ? { images: ['/private/diagnostics/frame.png'] } : {}) }), error => {
          assert.equal(error.code, 'MODEL_TIMEOUT'); assert.equal(error.phase, stage);
          assert(error.elapsedMs >= 20); assert.match(error.message, /应用助手调用累计等待.*超时.*停止在.*阶段/);
          assert.doesNotMatch(error.message, /学习模型/); return true;
        });
        assert.equal(phases.at(-1).stage, stage);
        release?.(); await new Promise(resolve => setImmediate(resolve));
        assert.equal(model.pending.size, 0);
        assert.equal(interrupted.length, 1, 'a created or late-created session is interrupted exactly once');
      } finally { clearInterval(keepAlive); }
    });
  }
});

test('observer exceptions and rejected promises cannot prevent guarded submission or completion', async t => {
  const { app, model } = progressFixture(t);
  app.submit = async id => { app.emit('event', { type: 'message.complete', sessionId: id, payload: { status: 'complete' } }); };
  assert.equal(await model.generate('检查', { onProgress: () => { throw new Error('UI unavailable'); } }), '{"text":"已检查"}');
  assert.equal(await model.generate('检查', { onProgress: async () => { throw new Error('UI unavailable'); } }), '{"text":"已检查"}');
});
