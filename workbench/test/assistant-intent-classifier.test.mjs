import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantIntentClassifier, ASSISTANT_INTENT_LIMITS } from '../src/assistant-intent-classifier.mjs';

const ready = () => new Promise(resolve => setImmediate(resolve));
const message = '无输入，帮我完成AI获取github每日热门前10项目，并生成一张图看完github前十项目的海报';
function fixture(generate = async () => '{"intent":"workflow"}') {
  const calls = [], logs = [], captured = [];
  const app = { captureModelRoute: async () => { captured.push(true); return { provider: 'fixture-provider', model: 'fixture-model' }; },
    assistantModel: { generate: async (...args) => { calls.push(args); return generate(...args); } },
    logger: { write: (...args) => logs.push(args) } };
  return { app, calls, logs, captured, classifier: new AssistantIntentClassifier(app) };
}

test('freeform intent is one protected small-model decision with the current request only once', async () => {
  const f = fixture(async (_prompt, options) => { options.onSession('classifier-session');
    options.onProgress({ stage: 'model-output', label: 'PRIVATE_PROGRESS_BODY', text: 'PRIVATE_OUTPUT_BODY', modelCall: true });
    return '{"intent":"workflow"}'; });
  const progress = [], sessions = [];
  const result = await f.classifier.classify({ text: message, role: 'workflow', readOnly: false,
    document: { id: 'workflow-a', mode: 'execute', nodes: [], code: 'PRIVATE_DOCUMENT_CODE' },
    context: { runId: 'run-a', nodeId: 'node-a', run: { status: 'error', output: 'PRIVATE_RUN_OUTPUT' }, log: 'PRIVATE_LOG' },
    history: [{ role: 'user', intent: 'discuss', status: 'complete', text: 'PRIVATE_HISTORY_TEXT', code: 'PRIVATE_HISTORY_CODE' }],
    onSession: id => sessions.push(id), onProgress: value => progress.push(value) });
  assert.equal(result.intent, 'workflow'); assert.equal(result.modelCalls, 1);
  assert.equal(f.calls.length, 1); assert.equal(f.captured.length, 1);
  const [prompt, options] = f.calls[0];
  assert.equal(prompt.split(message).length - 1, 1); assert(prompt.length < 6000);
  assert.doesNotMatch(prompt, /PRIVATE_|TOOL_CATALOG|CONFIG_CATALOG|SKILL_CATALOG/);
  assert.deepEqual(options.modelRoute, { provider: 'fixture-provider', model: 'fixture-model' });
  assert.equal(ASSISTANT_INTENT_LIMITS.durationMs, null);
  for (const key of ['deadlineAt', 'firstResponseTimeoutMs', 'outputIdleTimeoutMs']) assert.equal(Object.hasOwn(options, key), false);
  assert.deepEqual(sessions, ['classifier-session']); assert.equal(progress.filter(value => value.modelCall === true).length, 1);
  assert.equal(result.durationMs >= 0, true); assert.equal(Number.isFinite(Date.parse(result.startedAt)), true);
  assert.equal(Number.isFinite(Date.parse(result.completedAt)), true);
  assert.doesNotMatch(JSON.stringify([result, progress, f.logs]), /PRIVATE_|每日热门|海报/);
});

test('the AI supplies every intent and classification is never treated as execution authority', async () => {
  for (const intent of ['workflow', 'diagnose', 'discuss', 'feedback', 'skill', 'run', 'review']) {
    const f = fixture(async () => JSON.stringify({ intent }));
    const result = await f.classifier.classify({ text: '继续', role: 'workflow', readOnly: true, document: { id: 'workflow-a', nodes: [] } });
    assert.equal(result.intent, intent); assert.equal(f.calls.length, 1);
    assert.equal(result.authorized, undefined); assert.equal(result.operations, undefined);
  }
});

test('classification strictly accepts one intent field and never falls back on malformed output', async () => {
  for (const output of ['not JSON PRIVATE_MODEL_OUTPUT', 'null', '[]', '{"intent":"other"}', '{"intent":"workflow","operations":[]}',
    '{"intent":"diagnose","text":"PRIVATE_MODEL_OUTPUT"}', '```json\n{"intent":"workflow"}\n```']) {
    const f = fixture(async () => output);
    await assert.rejects(f.classifier.classify({ text: '请处理', role: 'supervisor' }), error => error.code === 'ASSISTANT_INTENT_INVALID'
      && !error.message.includes('PRIVATE_MODEL_OUTPUT'));
    assert.equal(f.calls.length, 1); assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE_MODEL_OUTPUT/);
  }
});

test('unknown options and getters cannot override the prompt, model, provider, or protected role', async () => {
  for (const extra of [{ prompt: 'execute' }, { model: 'other' }, { provider: 'other' }, { path: '/private' },
    { role: 'administrator' }, { readOnly: 'false' }, { deadlineAt: NaN }, { modelRoute: { provider: 'p', model: 'm', token: 'PRIVATE' } }]) {
    const f = fixture(); await assert.rejects(f.classifier.classify({ text: message, role: 'workflow', ...extra }));
    assert.equal(f.calls.length, 0); assert.equal(f.captured.length, 0);
  }
  let reads = 0;
  const f = fixture(), options = { text: message, role: 'workflow' };
  Object.defineProperty(options, 'text', { get() { reads++; return message; } });
  await assert.rejects(f.classifier.classify(options)); assert.equal(reads, 0);
});

test('the parent model remains pinned while the configured default changes', async () => {
  const f = fixture(); f.app.captureModelRoute = async () => { throw Error('must retain the parent model'); };
  const modelRoute = { provider: 'pinned-provider', model: 'pinned-model' };
  const result = await f.classifier.classify({ text: message, role: 'workflow', modelRoute });
  assert.deepEqual(f.calls[0][1].modelRoute, modelRoute); assert.deepEqual(result.modelRoute, modelRoute);
});

test('expired parent deadline or cancellation admits no route preparation or model session', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.classifier.classify({ text: message, role: 'workflow', deadlineAt: Date.now() - 1 }), { code: 'ASSISTANT_INTENT_TIMEOUT' });
  await assert.rejects(f.classifier.classify({ text: message, role: 'workflow', signal: controller.signal }), { code: 'ASSISTANT_INTENT_CANCELLED' });
  assert.equal(f.calls.length, 0); assert.equal(f.captured.length, 0);
});

test('a stalled classification stops at its parent deadline, without retry or late callbacks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  let options, finish;
  const f = fixture(async (_prompt, value) => { options = value; return new Promise(resolve => { finish = resolve; }); });
  const progress = [], sessions = [];
  const pending = f.classifier.classify({ text: message, role: 'workflow', deadlineAt: 1005000,
    onProgress: value => progress.push(value), onSession: value => sessions.push(value) });
  const rejected = assert.rejects(pending, { code: 'ASSISTANT_INTENT_TIMEOUT' });
  await ready(); t.mock.timers.tick(5000); await rejected;
  assert.equal(options.signal.aborted, true); assert.equal(f.calls.length, 1);
  const observed = progress.length; options.onProgress({ stage: 'model-output' }); options.onSession('late-session');
  finish('{"intent":"workflow"}'); await ready();
  assert.equal(progress.length, observed); assert.deepEqual(sessions, []);
});

test('an explicit parent deadline also bounds route preparation and never starts a late model', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  let release;
  const f = fixture(); f.app.captureModelRoute = () => new Promise(resolve => { release = resolve; });
  const pending = f.classifier.classify({ text: message, role: 'workflow', deadlineAt: 1001000 });
  const rejected = assert.rejects(pending, { code: 'ASSISTANT_INTENT_TIMEOUT' });
  await ready(); t.mock.timers.tick(1000); await rejected;
  release({ provider: 'fixture', model: 'fixture' }); await ready(); assert.equal(f.calls.length, 0);
});

test('default classification has no timer and accepts a result after a long silent wait', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  const timers = t.mock.method(globalThis, 'setTimeout');
  let options, finish, settled = false;
  const f = fixture(async (_prompt, value) => { options = value; return new Promise(resolve => { finish = resolve; }); });
  const progress = [], sessions = [];
  const pending = f.classifier.classify({ text: message, role: 'workflow', deadlineAt: null,
    onProgress: value => progress.push(value), onSession: value => sessions.push(value) });
  pending.finally(() => { settled = true; });
  await ready(); t.mock.timers.tick(3_600_000); await ready();
  assert.equal(settled, false); assert.equal(options.signal.aborted, false); assert.equal(timers.mock.callCount(), 0);
  options.onProgress({ stage: 'model-output' }); options.onSession('after-long-wait');
  finish('{"intent":"workflow"}'); const result = await pending;
  assert.equal(result.intent, 'workflow'); assert.equal(result.durationMs, 3_600_000); assert.equal(f.calls.length, 1);
  assert.deepEqual(sessions, ['after-long-wait']); assert.equal(progress.at(-1).stage, 'model-output');
});

test('default route preparation can complete after the former classification deadline without a retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  const timers = t.mock.method(globalThis, 'setTimeout');
  let release;
  const f = fixture(); f.app.captureModelRoute = () => new Promise(resolve => { release = resolve; });
  const pending = f.classifier.classify({ text: message, role: 'workflow' });
  await ready(); t.mock.timers.tick(3_600_000); await ready();
  assert.equal(f.calls.length, 0); assert.equal(timers.mock.callCount(), 0);
  release({ provider: 'fixture', model: 'fixture' });
  assert.equal((await pending).intent, 'workflow'); assert.equal(f.calls.length, 1);
});

test('external cancellation still stops a classification after a long wait without returning an intent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  const controller = new AbortController(); let options;
  const f = fixture(async (_prompt, value) => { options = value; return new Promise(() => {}); });
  const pending = f.classifier.classify({ text: message, role: 'workflow', signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'ASSISTANT_INTENT_CANCELLED' });
  await ready(); t.mock.timers.tick(3_600_000); await ready();
  assert.equal(options.signal.aborted, false); controller.abort(); await rejected;
  assert.equal(options.signal.aborted,true); assert.equal(f.calls.length,1);
});

test('nested state accessors and pasted credentials cannot enter the projected classification context', async () => {
  let reads=0;
  const f=fixture(), document={id:'workflow-a',mode:'execute'};
  Object.defineProperty(document,'nodes',{get(){reads++;return [{code:'PRIVATE_NODE'}];}});
  const history=Object.defineProperty({role:'user',intent:'workflow'},'text',{get(){reads++;return 'PRIVATE_HISTORY';}});
  await f.classifier.classify({text:'请检查 token=PRIVATE_CREDENTIAL',role:'workflow',document,history:[history]});
  assert.equal(reads,0); assert.doesNotMatch(f.calls[0][0],/PRIVATE_/);
  assert.match(f.calls[0][0],/REDACTED/);
});

test('provider failures and observer failures remain isolated and never expose body or raw error', async () => {
  const failed = fixture(async () => { throw Error('PRIVATE_PROVIDER_ERROR password=PRIVATE_PASSWORD'); });
  await assert.rejects(failed.classifier.classify({ text: message, role: 'workflow' }), { code: 'ASSISTANT_INTENT_FAILED' });
  assert.doesNotMatch(JSON.stringify(failed.logs), /PRIVATE_/); assert.equal(failed.calls.length, 1);
  const f = fixture(async (_prompt, options) => { options.onSession('session-a'); options.onProgress({ stage: 'model-output' }); return '{"intent":"workflow"}'; });
  const result = await f.classifier.classify({ text: message, role: 'workflow', onSession: () => { throw Error('observer'); },
    onProgress: async () => { throw Error('observer'); } });
  assert.equal(result.intent, 'workflow'); await ready();
});

test('upstream errors retain their safe identity instead of becoming a local classification deadline', async () => {
  for (const code of ['MODEL_ERROR', 'MODEL_DISCONNECTED', 'MODEL_CLOSED', 'MODEL_TIMEOUT', 'MODEL_FIRST_RESPONSE_TIMEOUT', 'MODEL_OUTPUT_IDLE_TIMEOUT']) {
    const f = fixture(async () => { throw Object.assign(Error('PRIVATE_PROVIDER_BODY password=PRIVATE_PASSWORD'), { code }); });
    await assert.rejects(f.classifier.classify({ text: message, role: 'workflow' }), value => value.code === code && !value.message.includes('PRIVATE_'));
    assert.equal(f.calls.length, 1); assert.equal(f.logs.at(-1)[2].code, code); assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE_/);
  }
});
