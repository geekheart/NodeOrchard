import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HermesModels } from '../src/hermes-models.mjs';

const catalog = () => ({ provider: 'custom:studio', model: 'studio-v1', secret: 'fixture-secret', providers: [
  { slug: 'custom:studio', name: 'Studio', models: ['studio-v1', 'studio-v1', 'studio-v2'], authenticated: true,
    api_key: 'fixture-secret', api_url: 'https://private.invalid', pricing: { secret: 'fixture-secret' } },
  { slug: 'configured-offline', name: 'Needs login', models: ['test'], authenticated: false },
  { slug: 'unknown-auth', models: ['test'], authenticated: null },
] });

function fixture() {
  const adapter = { state: 'ready', calls: [], payload: catalog(), async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'model.options') return structuredClone(this.payload);
    if (method === 'workbench.model.set') {
      this.payload.provider = params.provider; this.payload.model = params.model;
      return { ...params };
    }
    throw new Error('unexpected RPC');
  } };
  return { adapter, models: new HermesModels(adapter) };
}

test('model discovery uses explicit Hermes inventory and returns only safe identity fields', async () => {
  const { adapter, models } = fixture(), result = await models.read();
  assert.deepEqual(adapter.calls, [{ method: 'model.options', params: { explicit_only: true, include_unconfigured: false } }]);
  assert.deepEqual(result, { connected: true, current: { provider: 'custom:studio', model: 'studio-v1' }, providers: [
    { id: 'custom:studio', label: 'Studio', models: ['studio-v1', 'studio-v2'], authenticated: true },
    { id: 'configured-offline', label: 'Needs login', models: ['test'], authenticated: false },
    { id: 'unknown-auth', label: 'unknown-auth', models: ['test'], authenticated: null },
  ] });
  assert(!JSON.stringify(result).includes('fixture-secret'));
  assert(!JSON.stringify(result).includes('private.invalid'));
});

test('disconnected discovery is local and selecting requires a connected backend', async () => {
  const { adapter, models } = fixture(); adapter.state = 'stopped';
  assert.deepEqual(await models.read(), { connected: false, current: { provider: '', model: '' }, providers: [] });
  await assert.rejects(models.set({ provider: 'custom:studio', model: 'studio-v1' }), { code: 'MODEL_BACKEND_UNAVAILABLE' });
  assert.equal(adapter.calls.length, 0);
});

test('configured authenticated providers allow manual model IDs and require persisted readback', async () => {
  const { adapter, models } = fixture();
  const result = await models.set({ provider: 'custom:studio', model: 'manual/new:2026' });
  assert.deepEqual(result.current, { provider: 'custom:studio', model: 'manual/new:2026' });
  assert.deepEqual(adapter.calls.map(call => call.method), ['model.options', 'workbench.model.set', 'model.options']);
  assert.deepEqual(adapter.calls[1].params, { provider: 'custom:studio', model: 'manual/new:2026' });
});

test('invalid envelopes, controls, overlong values, missing and unauthenticated providers never mutate Hermes', async () => {
  const { adapter, models } = fixture();
  for (const value of [null, [], {}, { provider: '', model: 'x' }, { provider: 'a', model: 1 },
    { provider: 'x'.repeat(129), model: 'x' }, { provider: 'custom:studio', model: 'x'.repeat(257) },
    { provider: 'custom:studio', model: 'a\nb' }, { provider: 'custom:studio', model: 'x', api_key: 'fixture-secret' }]) {
    await assert.rejects(models.set(value), { code: 'MODEL_SELECTION_INVALID' });
  }
  assert.equal(adapter.calls.length, 0);
  for (const provider of ['absent', 'configured-offline', 'unknown-auth']) {
    await assert.rejects(models.set({ provider, model: 'anything' }), { code: 'MODEL_PROVIDER_UNAVAILABLE' });
  }
  assert(adapter.calls.every(call => call.method === 'model.options'));
});

test('a rejected selection cannot poison the serialized queue and reads wait for a pending switch', async () => {
  const { adapter, models } = fixture(); let release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const request = adapter.request.bind(adapter);
  adapter.request = async (method, params) => {
    if (method === 'workbench.model.set') { entered(); await gate; }
    return request(method, params);
  };
  await assert.rejects(models.set({ provider: 'absent', model: 'bad' }));
  const set = models.set({ provider: 'custom:studio', model: 'new' }); await enteredPromise;
  let readFinished = false; const read = models.read().then(value => { readFinished = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(readFinished, false);
  release(); assert.equal((await set).current.model, 'new'); assert.equal((await read).current.model, 'new');
});

test('upstream exceptions and native confirmation requests expose generic safe errors only', async () => {
  const { adapter, models } = fixture(), request = adapter.request.bind(adapter);
  adapter.request = async (method, params) => {
    if (method === 'workbench.model.set') throw Object.assign(new Error('fixture-secret https://private.invalid'), { code: 4303 });
    return request(method, params);
  };
  await assert.rejects(models.set({ provider: 'custom:studio', model: 'costly' }), cause => {
    assert.equal(cause.code, 'MODEL_NATIVE_CONFIRMATION_REQUIRED'); assert.equal(cause.httpStatus, 409);
    assert(!cause.message.includes('fixture-secret')); assert(!cause.message.includes('private.invalid')); return true;
  });
  adapter.request = async () => { throw new Error('fixture-secret https://private.invalid'); };
  await assert.rejects(models.read(), cause => cause.code === 'MODEL_CATALOG_UNAVAILABLE' && !cause.message.includes('fixture-secret'));
});

test('a stale or malformed persistence acknowledgment is never reported as a successful switch', async () => {
  for (const response of [{ provider: 'custom:studio', model: 'different' }, { provider: 'custom:studio', model: 'studio-v1' },
    { provider: 'custom:studio', model: 'new', api_key: 'fixture-secret' }]) {
    const { adapter, models } = fixture(), request = adapter.request.bind(adapter);
    adapter.request = (method, params) => method === 'workbench.model.set' ? Promise.resolve(response) : request(method, params);
    await assert.rejects(models.set({ provider: 'custom:studio', model: 'new' }), { code: 'MODEL_SELECTION_UNCONFIRMED' });
  }
});

test('Python model bridge tests use injected stdlib fakes without Hermes installation or credentials', () => {
  const result = spawnSync('python3', ['-I', '-B', fileURLToPath(new URL('./hermes_models_test.py', import.meta.url))],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /OK/);
});
