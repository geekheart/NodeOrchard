import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { AssistantModelExperiment, syntheticExperimentPrompt } from '../src/assistant-model-experiment.mjs';

const ready = () => new Promise(resolve => setImmediate(resolve));
const reference = () => ({ workflowId: 'workflow-source', turnId: 'source-turn', callIndex: 2, sessionId: 'source-session',
  provider: 'openai-codex', model: 'historical-model', reasoningEffort: 'medium', reasoningEffortWire: 'medium', promptCharacters: 21204, modelTerminalConfirmed: true });
function fixture(t, generate = async () => '{"ok":true}') {
  const app = new EventEmitter(), calls = [], logs = [], settings = { revision: 7, supervisor: { modelExperiment: true }, modelExperimentLimits: { maxInputCharacters: 50000 } };
  app.store = { db: new DatabaseSync(':memory:') }; t.after(() => app.store.db.close());
  app.assistantPermissionSettings = { get: () => structuredClone(settings) };
  app.assistantModel = { generate: async (...args) => { calls.push(args); return generate(...args); } };
  app.logger = { write: (...args) => logs.push(args) };
  const runner = new AssistantModelExperiment(app), run = options => runner.run({ reference: reference(), conversationId: 'supervisor-one',
    turnId: 'diagnostic-turn', permissionRevision: settings.revision, authorize: async () => {}, ...options });
  return { app, calls, logs, settings, runner, run };
}

test('synthetic experiment uses only the historical route, reasoning and exact input character scale', async t => {
  const f = fixture(t), sessions = [];
  f.app.captureModelRoute = () => { throw Error('must not use current defaults'); };
  const result = await f.run({ onSession: id => sessions.push(id) });
  assert.equal(result.status, 'complete'); assert.equal(result.success, true); assert.equal(f.calls.length, 1);
  const [prompt, options] = f.calls[0];
  assert.equal(prompt.length, 21204); assert.match(prompt, /SYNTHETIC_DATA/);
  assert.deepEqual(options.modelRoute, { provider: 'openai-codex', model: 'historical-model' });
  assert.equal(options.reasoningEffort, 'medium'); assert.equal(options.expectedReasoningEffort, 'medium'); assert.equal(options.expectedReasoningEffortWire, 'medium');
  for (const key of ['deadlineAt', 'firstResponseTimeoutMs', 'outputIdleTimeoutMs', 'images', 'userImages', 'memoryScopeId']) assert.equal(Object.hasOwn(options, key), false);
  assert.deepEqual(result.outputBudget, { mode: 'instruction-only', hardLimit: false, maxOutputTokens: null });
  assert.equal(result.inputBudget.maxInputCharacters, 50000); assert.equal(result.inputBudget.hardLimit, true);
  assert.equal(result.workflowExecuted, false); assert.equal(result.workflowModified, false); assert.equal(result.originalPromptRead, false);
  assert.equal(result.modelCalls, 1); assert.equal(result.responseMatched, true);
});

test('unknown or oversized references cannot start a model and do not silently reduce the requested scale', async t => {
  const f = fixture(t);
  for (const patch of [{ reasoningEffort: null }, { reasoningEffortWire: null }, { model: null }, { promptCharacters: null },
    { modelTerminalConfirmed: false }, { promptCharacters: 50001 }]) {
    const result = await f.run({ reference: { ...reference(), ...patch } });
    assert.equal(result.status, 'unavailable'); assert.equal(result.modelCalls, 0);
  }
  assert.equal(f.calls.length, 0);
  assert.throws(() => syntheticExperimentPrompt(100001));
});

test('one durable attempt per supervisor turn survives restart and cannot be multiplied by a different source', async t => {
  const f = fixture(t); await f.run();
  await assert.rejects(f.run({ reference: { ...reference(), sessionId: 'different-session' } }), { code: 'MODEL_EXPERIMENT_QUOTA' });
  const restarted = new AssistantModelExperiment(f.app);
  await assert.rejects(restarted.run({ reference: reference(), conversationId: 'supervisor-one', turnId: 'diagnostic-turn',
    permissionRevision: 7, authorize: async () => {} }), { code: 'MODEL_EXPERIMENT_QUOTA' });
  assert.equal(f.calls.length, 1);
  assert.equal((await f.run({ turnId: 'second-diagnostic-turn' })).success, true); assert.equal(f.calls.length, 2);
});

test('disabled or changed human settings stop admission and limits are never supplied through tool parameters', async t => {
  const f = fixture(t); f.settings.supervisor.modelExperiment = false;
  await assert.rejects(f.run(), { httpStatus: 403 }); assert.equal(f.calls.length, 0);
  f.settings.supervisor.modelExperiment = true;
  await assert.rejects(f.run({ permissionRevision: 6 }), { httpStatus: 409 });
  await assert.rejects(f.run({ reference: { ...reference(), prompt: 'PRIVATE_SOURCE_PROMPT' } }), { httpStatus: 400 });
  assert.equal(f.calls.length, 0);
});

test('cancellation and permission updates end a long wait without retries or late output', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  let resolve, options;
  const f = fixture(t, (_prompt, value) => { options = value; return new Promise(done => { resolve = done; }); });
  const controller = new AbortController(), observed = [], pending = f.run({ signal: controller.signal, onSession: id => observed.push(id) });
  await ready(); t.mock.timers.tick(24 * 60 * 60 * 1000); assert.equal(options.signal.aborted, false);
  controller.abort(); assert.equal((await pending).status, 'cancelled'); assert.equal(options.signal.aborted, true);
  options.onSession('late-session'); resolve('PRIVATE_LATE_RESPONSE'); await ready(); assert.deepEqual(observed, []); assert.equal(f.calls.length, 1);
  const second = f.run({ turnId: 'another-turn' }); await ready(); f.app.emit('event', { type: 'assistant.permissions.updated' });
  assert.equal((await second).status, 'cancelled'); assert.equal(f.calls.length, 2);
});

test('errors, invalid output and stored receipts expose metadata without model or error bodies', async t => {
  const secret = 'PRIVATE_PROVIDER_BODY';
  const f = fixture(t, async () => { throw Object.assign(new Error(secret), { code: secret }); });
  const result = await f.run(); assert.equal(result.status, 'error'); assert.equal(result.errorCode, 'MODEL_EXPERIMENT_FAILED');
  const stored = f.app.store.db.prepare('SELECT value FROM assistant_model_experiments').all();
  assert.equal(JSON.stringify([result, f.logs, stored]).includes(secret), false);
  const mismatch = await f.run({ turnId: 'invalid-response-turn', reference: { ...reference(), reasoningEffort: 'ultra', reasoningEffortWire: 'xhigh' } });
  assert.equal(mismatch.status, 'error'); assert.equal(Object.hasOwn(f.calls[1][1], 'reasoningEffort'), false);
  assert.equal(f.calls[1][1].expectedReasoningEffort, 'ultra'); assert.equal(f.calls.length, 2);
});
