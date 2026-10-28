import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { LearningModel } from '../src/workflows/learning-model.mjs';

function fixture(t, purpose = 'assistant', readback = {}) {
  const app = new EventEmitter(), db = new DatabaseSync(':memory:'), created = [], submitted = [], logs = [];
  app.store = { db }; app.logger = { write: (...args) => logs.push(args) };
  app.createSession = async options => { created.push(options); return { id: 'local-session', runtimeSessionId: 'runtime-session', ...readback }; };
  app.interrupt = async () => {};
  app.adapter = { request: async () => ({ policy: { toolsAllowed: false, skillMutationBlocked: true,
    memoryAllowed: purpose === 'learning', memoryWriteAllowed: false, applicationTools: 'broker-only', sourceMutationBlocked: true } }) };
  app.history = async () => ({ messages: [{ role: 'assistant', text: '{"text":"fixture-result"}' }] });
  app.submit = async (...args) => { submitted.push(args); app.emit('event', { type: 'message.complete', sessionId: 'local-session', payload: { status: 'complete' } }); };
  const model = new LearningModel(app, { purpose });
  t.after(async () => { await model.close(); db.close(); });
  return { app, db, model, created, submitted, logs,
    metrics: () => JSON.parse(db.prepare('SELECT value FROM application_model_calls WHERE session_id=?').get('local-session').value) };
}

test('an assistant-only reasoning override reaches native session creation and records confirmed requested/effective/wire metadata', async t => {
  const f = fixture(t, 'assistant', { requestedReasoningEffort: 'medium', reasoningEffort: 'medium', reasoningEffortWire: 'medium', reasoning: 'PRIVATE_THOUGHT' });
  const modelRoute = { provider: 'fixture', model: 'fixture-model' };
  assert.equal(await f.model.generate('Generate a controlled workflow candidate.', { reasoningEffort: 'medium', modelRoute }), '{"text":"fixture-result"}');
  assert.equal(f.created[0].assistantReasoningEffort, 'medium');
  assert.equal(f.created[0].managedPurpose, 'assistant'); assert.deepEqual(f.created[0].modelRoute, modelRoute);
  const saved = f.metrics();
  assert.equal(saved.requestedReasoningEffort, 'medium'); assert.equal(saved.reasoningEffort, 'medium'); assert.equal(saved.reasoningEffortWire, 'medium');
  assert(!JSON.stringify([saved, f.logs]).includes('PRIVATE_THOUGHT'));
});

test('calls without an override inherit their native route and do not pretend wire effort equals requested effort', async t => {
  const f = fixture(t, 'assistant', { requestedReasoningEffort: 'ultra', reasoningEffort: 'ultra', reasoningEffortWire: 'xhigh' });
  await f.model.generate('Classify this message.');
  assert.equal(Object.hasOwn(f.created[0], 'assistantReasoningEffort'), false);
  const saved = f.metrics();
  assert.equal(saved.requestedReasoningEffort, 'ultra'); assert.equal(saved.reasoningEffort, 'ultra'); assert.equal(saved.reasoningEffortWire, 'xhigh');
});

test('an inherited lazy session records native effort after preparation without inventing a requested override', async t => {
  const f = fixture(t);
  f.app.sessionInfo = new Map();
  const prepare = f.app.adapter.request;
  f.app.adapter.request = async (...args) => {
    const value = await prepare(...args);
    f.app.sessionInfo.set('runtime-session', { reasoning_effort: 'ultra', reasoning_effort_wire: 'xhigh', thinking: 'PRIVATE_THOUGHT' });
    return value;
  };
  await f.model.generate('Classify this message without changing the native configuration.');
  const saved = f.metrics();
  assert.equal(Object.hasOwn(f.created[0], 'assistantReasoningEffort'), false);
  assert.equal(saved.requestedReasoningEffort, null); assert.equal(saved.reasoningEffort, 'ultra'); assert.equal(saved.reasoningEffortWire, 'xhigh');
  assert(!JSON.stringify([saved, f.logs]).includes('PRIVATE_THOUGHT'));
});

test('low and medium are the only admitted assistant overrides', async t => {
  for (const effort of ['low', 'medium']) {
    const f = fixture(t, 'assistant', { requestedReasoningEffort: effort, reasoningEffort: effort, reasoningEffortWire: effort });
    await f.model.generate('Generate a controlled candidate.', { reasoningEffort: effort });
    assert.equal(f.created[0].assistantReasoningEffort, effort);
  }
  for (const effort of ['high', 'ultra', 'xhigh', null, { effort: 'medium' }]) {
    const f = fixture(t);
    await assert.rejects(f.model.generate('Generate a controlled candidate.', { reasoningEffort: effort }), /推理|reasoning/i);
    assert.deepEqual(f.created, []); assert.deepEqual(f.submitted, []);
  }
});

test('learning calls cannot override reasoning and retain their previous creation contract when omitted', async t => {
  const f = fixture(t, 'learning');
  for (const effort of ['low', 'medium']) await assert.rejects(f.model.generate('Learning control.', { reasoningEffort: effort }), /应用助手|推理/);
  assert.deepEqual(f.created, []); assert.deepEqual(f.submitted, []);
  await f.model.generate('Learning control.');
  assert.equal(Object.hasOwn(f.created[0], 'assistantReasoningEffort'), false);
  assert.equal(Object.hasOwn(f.created[0], 'managedPurpose'), false);
});

test('unknown or unconfirmed reasoning readback remains null instead of copying request or private strings into metrics', async t => {
  const f = fixture(t, 'assistant', { requestedReasoningEffort: 'PRIVATE_REQUESTED', reasoningEffort: 'PRIVATE_EFFECTIVE', reasoningEffortWire: 'PRIVATE_WIRE' });
  await f.model.generate('Controlled call.');
  const saved = f.metrics();
  assert.equal(saved.requestedReasoningEffort, null); assert.equal(saved.reasoningEffort, null); assert.equal(saved.reasoningEffortWire, null);
  assert(!JSON.stringify([saved, f.logs]).includes('PRIVATE_'));
});

test('a diagnostic experiment verifies inherited historical reasoning before submitting any prompt', async t => {
  const f = fixture(t, 'assistant', { reasoningEffort: 'ultra', reasoningEffortWire: 'xhigh' });
  await f.model.generate('Synthetic diagnostic sample.', { expectedReasoningEffort: 'ultra', expectedReasoningEffortWire: 'xhigh' });
  assert.equal(f.submitted.length, 1); assert.equal(Object.hasOwn(f.created[0], 'assistantReasoningEffort'), false);
});

test('changed or unavailable native reasoning refuses an experiment before a paid model submission', async t => {
  for (const metadata of [{ reasoningEffort: 'medium', reasoningEffortWire: 'medium' }, {}]) {
    const f = fixture(t, 'assistant', metadata);
    await assert.rejects(f.model.generate('Synthetic diagnostic sample.', { expectedReasoningEffort: 'ultra', expectedReasoningEffortWire: 'xhigh' }),
      error => error.code === 'MODEL_CONFIGURATION_UNCONFIRMED');
    assert.equal(f.submitted.length, 0);
  }
  const f = fixture(t, 'learning');
  await assert.rejects(f.model.generate('Never submit.', { expectedReasoningEffort: 'medium' }), /预期推理配置/); assert.equal(f.submitted.length, 0);
});
