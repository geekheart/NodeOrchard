import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantModelProbe, ASSISTANT_MODEL_PROBE_LIMITS } from '../src/assistant-model-probe.mjs';

const ready = () => new Promise(resolve => setImmediate(resolve));
function fixture(generate = async () => '{"ok":true}') {
  const calls = [], logs = [];
  const app = {
    captureModelRoute: async () => ({ provider: 'fixture-provider', model: 'fixture-model' }),
    assistantModel: { generate: async (...args) => { calls.push(args); return generate(...args); } },
    logger: { write: (...args) => logs.push(args) },
  };
  return { app, calls, logs, probe: new AssistantModelProbe(app) };
}

test('fixed model probe uses the current protected controller and returns metadata without content', async () => {
  const f = fixture(async (prompt, options) => {
    options.onSession('session-probe');
    options.onProgress({ stage: 'model-response', label: 'PRIVATE_PROGRESS_BODY' });
    options.onProgress({ stage: 'model-output', label: 'PRIVATE_PROGRESS_BODY' });
    return '{"ok":true}';
  });
  const sessions = [], progress = [];
  const result = await f.probe.run({ onSession: id => sessions.push(id), onProgress: value => progress.push(value),
    trace: { workflowId: 'workflow-test', conversationId: 'conversation-test', turnId: 'turn-test' } });
  assert.equal(f.calls.length, 1);
  const [prompt, options] = f.calls[0];
  assert.ok(prompt.length < 400);
  assert.match(prompt, /\{"ok":true\}/);
  assert.deepEqual(options.modelRoute, { provider: 'fixture-provider', model: 'fixture-model' });
  assert.ok(options.deadlineAt <= Date.now() + 30000);
  assert.ok(options.firstResponseTimeoutMs <= 30000);
  assert.ok(options.outputIdleTimeoutMs <= 10000);
  assert.equal(result.status, 'complete');
  assert.equal(result.responseMatched, true);
  assert.equal(result.sessionId, 'session-probe');
  assert.equal(result.workflowExecuted, false);
  assert.equal(result.workflowModified, false);
  assert.equal(result.modelCalls, 1);
  assert.equal(typeof result.durationMs, 'number');
  assert.equal(typeof result.firstOutputMs, 'number');
  assert.ok(result.durationMs >= result.firstOutputMs);
  assert.deepEqual(sessions, ['session-probe']);
  assert.ok(progress.length >= 1);
  assert.equal(JSON.stringify([result, progress, f.logs]).includes('PRIVATE_PROGRESS_BODY'), false);
  assert.deepEqual(f.logs.map(row => row[1]), ['assistant.probe.started', 'assistant.probe.completed']);
  assert.equal(f.logs[0][2].turnId, 'turn-test');
});

test('a probe uses its parent turn model route even when the default changes', async () => {
  const f = fixture();
  f.app.captureModelRoute = async () => { throw new Error('the parent route must stay pinned'); };
  const modelRoute = { provider: 'pinned-provider', model: 'pinned-model' };
  assert.equal((await f.probe.run({ modelRoute })).success, true);
  assert.deepEqual(f.calls[0][1].modelRoute, modelRoute);
});

test('probe never returns or logs malformed model output or provider error text', async () => {
  const secret = 'PRIVATE_BODY_sk-aaaaaaaaaaaaaaaaaaaa';
  const malformed = fixture(async () => secret);
  const mismatch = await malformed.probe.run();
  assert.equal(mismatch.status, 'invalid-response');
  assert.equal(mismatch.responseMatched, false);
  assert.equal(JSON.stringify([mismatch, malformed.logs]).includes(secret), false);
  assert.equal(malformed.calls.length, 1);
  const failed = fixture(async () => { throw Object.assign(new Error(secret), { code: secret }); });
  const result = await failed.probe.run();
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, 'MODEL_PROBE_FAILED');
  assert.equal(result.responseMatched, false);
  assert.equal(JSON.stringify([result, failed.logs]).includes(secret), false);
  assert.equal(failed.calls.length, 1);
});

test('unknown options, override attempts and accessors are refused before any model call', async () => {
  for (const options of [{ prompt: 'run commands' }, { model: 'other' }, { provider: 'other' }, { path: '/private' },
    { deadlineAt: NaN }, { deadlineAt: 'tomorrow' }, { onProgress: true }, { trace: { prompt: 'secret' } }]) {
    const f = fixture();
    await assert.rejects(f.probe.run(options));
    assert.equal(f.calls.length, 0);
  }
  let observed = 0;
  const f = fixture();
  await assert.rejects(f.probe.run(Object.defineProperty({}, 'deadlineAt', { get() { observed++; return Date.now(); } })));
  assert.equal(observed, 0);
  assert.equal(f.calls.length, 0);
});

test('expired parent deadline and pre-abort prevent creating even a probe session', async () => {
  const f = fixture();
  const expired = await f.probe.run({ deadlineAt: Date.now() - 1 });
  assert.equal(expired.status, 'timeout');
  assert.equal(expired.modelCalls, 0);
  const controller = new AbortController(); controller.abort();
  const stopped = await f.probe.run({ signal: controller.signal });
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.modelCalls, 0);
  assert.equal(f.calls.length, 0);
});

test('unresponsive controller is cancelled at the parent deadline with no retries or late observations', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  let options, finish;
  const f = fixture(async (_prompt, value) => { options = value; return new Promise(resolve => { finish = resolve; }); });
  const progress = [], sessions = [];
  const pending = f.probe.run({ deadlineAt: Date.now() + 5000, onProgress: value => progress.push(value), onSession: id => sessions.push(id) });
  await ready();
  assert.equal(options.deadlineAt, 1005000);
  t.mock.timers.tick(5000);
  const result = await pending;
  assert.equal(result.status, 'timeout');
  assert.equal(result.errorCode, 'MODEL_PROBE_TIMEOUT');
  assert.equal(result.durationMs, 5000);
  assert.equal(options.signal.aborted, true);
  assert.equal(f.calls.length, 1);
  const before = progress.length;
  options.onProgress({ stage: 'model-output', label: 'LATE_PRIVATE_OUTPUT' });
  options.onSession('late-session');
  finish('{"ok":true}');
  await ready();
  assert.equal(progress.length, before);
  assert.deepEqual(sessions, []);
  assert.equal(f.logs.at(-1)[1], 'assistant.probe.failed');
});

test('default absolute ceiling is 30 seconds even when model emits continuous progress', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2000000 });
  let options;
  const f = fixture(async (_prompt, value) => { options = value; return new Promise(() => {}); });
  const pending = f.probe.run({ deadlineAt: Date.now() + 1000000 });
  await ready();
  assert.equal(options.deadlineAt, 2000000 + ASSISTANT_MODEL_PROBE_LIMITS.durationMs);
  for (let index = 0; index < 3; index++) {
    t.mock.timers.tick(9000);
    options.onProgress({ stage: 'model-output' });
  }
  t.mock.timers.tick(3000);
  const result = await pending;
  assert.equal(result.status, 'timeout');
  assert.equal(result.durationMs, 30000);
  assert.equal(options.signal.aborted, true);
  assert.equal(f.calls.length, 1);
});

test('external cancellation aborts the protected model and observers cannot alter outcome', async () => {
  const controller = new AbortController(); let options;
  const f = fixture(async (_prompt, value) => { options = value; value.onSession('session-probe'); value.onProgress({ stage: 'model-output' }); return new Promise(() => {}); });
  f.app.logger.write = () => { throw new Error('observer logger'); };
  const pending = f.probe.run({ signal: controller.signal, onSession: () => { throw new Error('observer session'); }, onProgress: async () => { throw new Error('observer progress'); } });
  await ready();
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(options.signal.aborted, true);
  assert.equal(f.calls.length, 1);
});

test('route preparation shares the deadline and never starts a late model', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 3000000 });
  const f = fixture(); let resolveRoute;
  f.app.captureModelRoute = () => new Promise(resolve => { resolveRoute = resolve; });
  const pending = f.probe.run({ deadlineAt: Date.now() + 1000 });
  await ready(); t.mock.timers.tick(1000);
  assert.equal((await pending).status, 'timeout');
  resolveRoute({ provider: 'fixture', model: 'fixture' });
  await ready(); assert.equal(f.calls.length, 0);
});
