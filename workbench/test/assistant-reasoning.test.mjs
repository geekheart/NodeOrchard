import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createWorkbenchServer } from '../src/server.mjs';

const route = Object.freeze({ provider: 'fixture-provider', model: 'fixture-model' });

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-reasoning-'));
  const adapter = new EventEmitter();
  adapter.state = 'ready'; adapter.serverRequests = new Map(); adapter.stop = async () => {};
  const calls = [];
  let entered;
  const configured = new Promise(resolve => { entered = resolve; });
  adapter.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'config.get' && params.key === 'approvals.mode') return { value: 'manual' };
    if (method === 'session.create') {
      adapter.onCreate?.(params);
      return { session_id: 'runtime', stored_session_id: 'stored',
        info: { ...route, tools: {}, skills: {}, lazy: true, ...adapter.createInfo } };
    }
    if (method === 'config.set' && params.key === 'yolo' && params.scope === 'session') { entered(); return { value: 'off' }; }
    if (method === 'session.close' && params.session_id === 'runtime') return { closed: true };
    throw new Error('Unexpected native mutation or model request: ' + method);
  };
  const app = new Application({ ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace'),
    WORKBENCH_HERMES_HOME: join(directory, 'hermes-home'), WORKBENCH_HERMES_ROOT: join(directory, 'hermes-install') }),
    workflowRunRoot: join(directory, 'runs') }, adapter);
  app.backend.state = 'ready';
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const info = (payload, runtime = 'runtime') => adapter.emit('event', { type: 'session.info', session_id: runtime, payload: { ...route, ...payload } });
  return { app, adapter, calls, configured, info };
}

test('managed assistant pins native reasoning and waits for its built-agent info before confirming it', async t => {
  const f = await setup(t);
  let settled = false;
  const pending = f.app.createSession({ modelRoute: route, managedPurpose: 'assistant', assistantReasoningEffort: 'medium' });
  pending.then(() => { settled = true; }, () => { settled = true; });
  await f.configured;
  assert.equal(f.calls.find(call => call.method === 'session.create').params.reasoning_effort, 'medium');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'the lazy create snapshot is not an effective-effort readback');
  f.info({ reasoning_effort: 'medium', reasoning_effort_wire: 'medium' }, 'another-runtime');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'another session cannot confirm the requested override');
  f.info({ reasoning_effort: 'medium', reasoning_effort_wire: 'medium', reasoning: 'PRIVATE_THOUGHT', config: { token: 'PRIVATE_CONFIG' } });
  const session = await pending;
  assert.equal(session.requestedReasoningEffort, 'medium');
  assert.equal(session.reasoningEffort, 'medium');
  assert.equal(session.reasoningEffortWire, 'medium');
  assert.deepEqual(f.app.sessionInfo.get('runtime'), { ...route, reasoning_effort: 'medium', reasoning_effort_wire: 'medium' });
  assert.deepEqual(f.calls.filter(call => call.method === 'config.set').map(call => call.params), [{ key: 'yolo', value: 'off', scope: 'session', session_id: 'runtime' }]);
});

test('an unpinned assistant inherits native reasoning and exposes only observed effort metadata', async t => {
  const f = await setup(t);
  f.adapter.createInfo = { lazy: false, reasoning_effort: 'ultra', reasoning_effort_wire: 'max', reasoning: 'PRIVATE_THOUGHT' };
  const session = await f.app.createSession({ modelRoute: route, managedPurpose: 'assistant' });
  assert.equal(Object.hasOwn(f.calls.find(call => call.method === 'session.create').params, 'reasoning_effort'), false);
  assert.equal(Object.hasOwn(session, 'requestedReasoningEffort'), false);
  assert.equal(session.reasoningEffort, 'ultra');
  assert.equal(session.reasoningEffortWire, 'max');
  assert.equal(JSON.stringify(session).includes('PRIVATE_THOUGHT'), false);
});

test('the native built-agent event can arrive before the create response without losing its confirmation', async t => {
  const f = await setup(t);
  f.adapter.onCreate = () => f.info({ reasoning_effort: 'low', reasoning_effort_wire: 'low' });
  const session = await f.app.createSession({ modelRoute: route, managedPurpose: 'assistant', assistantReasoningEffort: 'low' });
  assert.equal(session.requestedReasoningEffort, 'low');
  assert.equal(session.reasoningEffortWire, 'low');
  assert.equal(f.adapter.listenerCount('event'), 1, 'temporary confirmation listeners are removed');
});

for (const [name, observed] of [
  ['a different requested effort', { reasoning_effort: 'ultra', reasoning_effort_wire: 'max' }],
  ['a different effective effort', { reasoning_effort: 'medium', reasoning_effort_wire: 'high' }],
  ['missing native reasoning', {}],
  ['an invalid effective effort', { reasoning_effort: 'medium', reasoning_effort_wire: 'PRIVATE_INVALID_VALUE' }],
  ['an unexpected model', { model: 'other-model', reasoning_effort: 'medium', reasoning_effort_wire: 'medium' }],
  ['an unexpected provider', { provider: 'other-provider', reasoning_effort: 'medium', reasoning_effort_wire: 'medium' }],
]) {
  test(`an assistant refuses ${name} instead of treating its request as confirmed`, async t => {
    const f = await setup(t);
    const pending = f.app.createSession({ modelRoute: route, managedPurpose: 'assistant', assistantReasoningEffort: 'medium' });
    const rejected = assert.rejects(pending, { code: 'ASSISTANT_REASONING_UNCONFIRMED' });
    await f.configured;
    f.info(observed);
    await rejected;
    assert.equal(f.app.store.list().length, 0);
    assert.equal(f.app.sessionInfo.has('runtime'), false, 'an unconfirmed runtime cannot remain as a cached session');
    assert.deepEqual(f.calls.filter(call => call.method === 'session.close').map(call => call.params), [{ session_id: 'runtime' }]);
    assert.equal(f.calls.some(call => call.method === 'prompt.submit'), false);
    assert.equal(f.adapter.listenerCount('event'), 1);
  });
}

test('an assistant fails closed if its built-agent confirmation never arrives', async t => {
  const f = await setup(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.app.createSession({ modelRoute: route, managedPurpose: 'assistant', assistantReasoningEffort: 'medium' });
  const rejected = assert.rejects(pending, { code: 'ASSISTANT_REASONING_UNCONFIRMED' });
  await f.configured;
  await new Promise(resolve => setImmediate(resolve));
  f.info({ lazy: true, reasoning_effort: 'medium', reasoning_effort_wire: 'medium' });
  t.mock.timers.tick(10_001);
  await rejected;
  t.mock.timers.reset();
  assert.equal(f.app.store.list().length, 0);
  assert.equal(f.adapter.listenerCount('event'), 1);
});

test('disconnect while waiting for confirmation rejects without a prompt', async t => {
  const f = await setup(t);
  const pending = f.app.createSession({ modelRoute: route, managedPurpose: 'assistant', assistantReasoningEffort: 'low' });
  const rejected = assert.rejects(pending, { code: 'ASSISTANT_REASONING_UNCONFIRMED' });
  await f.configured;
  f.adapter.emit('state', { state: 'disconnected' });
  await rejected;
  assert.equal(f.app.store.list().length, 0);
});

test('assistant effort is not a public task or learning parameter and invalid inputs never reach Hermes', async t => {
  const f = await setup(t);
  for (const input of [
    { assistantReasoningEffort: 'medium' },
    { managedPurpose: 'learning', assistantReasoningEffort: 'medium' },
    ...['high', 'ultra', '', null, true, { effort: 'medium' }].map(assistantReasoningEffort => ({ managedPurpose: 'assistant', assistantReasoningEffort })),
    { managedPurpose: 'assistant', reasoning_effort: 'medium' },
    { managedPurpose: 'assistant', fast: true },
  ]) await assert.rejects(f.app.createSession({ modelRoute: route, ...input }));
  assert.deepEqual(f.calls, []);
});

test('normal tasks do not send an override or receive assistant reasoning metadata', async t => {
  const f = await setup(t);
  const session = await f.app.createSession({ modelRoute: route });
  const params = f.calls.find(call => call.method === 'session.create').params;
  assert.equal(Object.hasOwn(params, 'reasoning_effort'), false);
  assert.equal(Object.hasOwn(params, 'fast'), false);
  assert.equal(Object.hasOwn(session, 'requestedReasoningEffort'), false);
  assert.equal(Object.hasOwn(session, 'reasoningEffort'), false);
  assert.equal(Object.hasOwn(session, 'reasoningEffortWire'), false);
});

test('session info projects only safe reasoning enums and never thoughts or config', async t => {
  const f = await setup(t);
  await f.app.createSession({ modelRoute: route });
  f.info({ reasoning_effort: { effort: 'ultra' }, reasoning_effort_wire: 'PRIVATE_INVALID_EFFORT',
    reasoning: 'PRIVATE_THOUGHT', reasoning_config: { effort: 'ultra', secret: 'PRIVATE_CONFIG' } });
  assert.deepEqual(f.app.sessionInfo.get('runtime'), route);
  f.info({ reasoning_effort: 'ultra', reasoning_effort_wire: 'xhigh', reasoning: 'PRIVATE_THOUGHT' });
  assert.deepEqual(f.app.sessionInfo.get('runtime'), { ...route, reasoning_effort: 'ultra', reasoning_effort_wire: 'xhigh' });
});

test('the public sessions HTTP endpoint cannot set managed purpose or native reasoning', async t => {
  const f = await setup(t);
  const bridge = createWorkbenchServer({ ...f.app.config, host: '127.0.0.1', port: 0 }, f.app);
  t.after(() => bridge.close());
  const origin = await bridge.listen();
  const token = (await (await fetch(origin + '/api/bootstrap')).json()).csrfToken;
  for (const extra of [{ managedPurpose: 'assistant' }, { assistantReasoningEffort: 'medium' }, { reasoning_effort: 'medium' }]) {
    const response = await fetch(origin + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token },
      body: JSON.stringify({ title: 'public-task', ...extra }) });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(f.calls, []);
});
