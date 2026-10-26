import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { HermesModels } from '../src/hermes-models.mjs';

const fixturePath = fileURLToPath(new URL('./fixtures/fake-hermes.mjs', import.meta.url));
const initial = { provider: 'openai-codex', model: 'test-model' };
const local = { provider: 'fixture-local', model: 'local-model' };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-model-management-'));
  const statePath = join(directory, 'hermes.json');
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace'),
    WORKBENCH_HERMES_ROOT: join(directory, 'fake-install'), WORKBENCH_HERMES_HOME: join(directory, 'fake-home') }),
    port: 0, command: process.execPath, args: [fixturePath], childEnv: { FAKE_HERMES_STATE_PATH: statePath,
      FAKE_APPROVAL_MODE: 'manual', FAKE_FALLBACK_PROVIDER: '', FAKE_RESUME_RACE: '' } };
  const f = { directory, statePath, config, applications: new Set() };
  f.create = () => { const app = new Application(config); f.applications.add(app); return app; };
  f.app = f.create();
  f.http = async () => {
    f.server = createWorkbenchServer(config, f.app); f.origin = await f.server.listen();
    f.csrf = (await (await fetch(f.origin + '/api/bootstrap')).json()).csrfToken;
  };
  t.after(async () => {
    try {
      if (f.server) await f.server.close();
      for (const app of f.applications) if (!app.closed) await app.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  return f;
}

function completion(app, sessionId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { app.off('event', listen); reject(Error('Fixture prompt did not finish')); }, 3000);
    function listen(event) {
      if (event.type !== 'message.complete' || event.sessionId !== sessionId) return;
      clearTimeout(timer); app.off('event', listen); resolve(event);
    }
    app.on('event', listen);
  });
}

async function runPrompt(app, session, prompt) {
  const done = completion(app, session.id);
  await app.submit(session.id, prompt);
  assert.equal((await done).payload.status, 'complete');
}

async function post(f, path, body, headers = {}) {
  const response = await fetch(f.origin + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Workbench-Token': f.csrf, ...headers,
  }, body: JSON.stringify(body) });
  return { status: response.status, value: await response.json() };
}

test('model catalog reads Hermes defaults and refreshes external provider changes without starting it offline', async t => {
  const f = await fixture(t), app = f.app;
  assert.deepEqual(await app.modelOptions(), { connected: false, current: { provider: '', model: '' }, providers: [] });
  assert.equal(app.adapter.state, 'stopped');
  await app.connect();
  const first = await app.modelOptions();
  assert.equal(first.connected, true); assert.deepEqual(first.current, initial);
  assert.deepEqual(first.providers, [
    { id: 'openai-codex', label: 'ChatGPT or Codex Subscription', models: ['test-model', 'test-model-alt'], authenticated: true },
    { id: 'fixture-local', label: 'Fixture Local Provider', models: ['local-model'], authenticated: true },
  ]);
  await app.adapter.request('config.set', { key: 'fixture_switch', value: local });
  assert.deepEqual((await app.modelOptions()).current, local, 'refresh must reread a change made by Hermes itself');
  assert.equal(app.preferences.defaultModel, '', 'the app must not create a second source of model defaults');
});

test('changing the Hermes default persists across restart and keeps old session routes intact', async t => {
  const f = await fixture(t), app = f.app;
  await app.connect();
  const old = await app.createSession({ title: 'first provider' });
  await runPrompt(app, old, 'retain old route');
  assert.equal((await app.history(old.id)).info.provider, initial.provider);
  const changed = await app.selectModel(local);
  assert.deepEqual(changed.current, local);
  assert.deepEqual(JSON.parse(await readFile(f.statePath, 'utf8')).modelRoute, local);
  const next = await app.createSession({ title: 'second provider' });
  await runPrompt(app, next, 'retain new route');
  assert.equal((await app.history(next.id)).info.provider, local.provider);
  assert.equal((await app.history(next.id)).info.model, local.model);
  assert.equal((await app.history(old.id)).info.provider, initial.provider);
  assert.equal((await app.history(old.id)).info.model, initial.model);
  await app.close();
  const restarted = f.create();
  await restarted.connect();
  assert.deepEqual((await restarted.modelOptions()).current, local);
  assert.equal((await restarted.history(old.id)).info.provider, initial.provider);
  assert.equal((await restarted.history(old.id)).info.model, initial.model);
  assert.equal((await restarted.history(next.id)).info.provider, local.provider);
  const afterRestart = await restarted.createSession({ title: 'after restart' });
  assert.equal((await restarted.history(afterRestart.id)).info.model, local.model);
});

test('Hermes accepts custom model identities and explicit captured routes survive a later default change', async t => {
  const f = await fixture(t), app = f.app;
  await app.connect();
  const captured = await app.captureModelRoute();
  assert.deepEqual(captured, initial);
  const custom = { provider: 'fixture-local', model: 'organization/custom-model:v2' };
  assert.deepEqual((await app.selectModel(custom)).current, custom);
  assert(!((await app.modelOptions()).providers.find(row => row.id === custom.provider).models.includes(custom.model)), 'custom IDs need not occur in the suggested list');
  const pinned = await app.createSession({ title: 'captured before switch', modelRoute: captured });
  const next = await app.createSession({ title: 'current custom model' });
  assert.equal((await app.history(pinned.id)).info.provider, initial.provider);
  assert.equal((await app.history(pinned.id)).info.model, initial.model);
  assert.equal((await app.history(next.id)).info.provider, custom.provider);
  assert.equal((await app.history(next.id)).info.model, custom.model);
});

test('a failed Hermes selection leaves its default unchanged and is not reported as success', async t => {
  const f = await fixture(t), app = f.app;
  await app.connect();
  await app.adapter.request('config.set', { key: 'fixture_switch', value: { model_set_error: 'fixture-only-private-rejection' } });
  await assert.rejects(app.selectModel(local), error => {
    assert.equal(error.code, 'MODEL_SELECTION_FAILED');
    assert(!error.message.includes('fixture-only-private-rejection')); return true;
  });
  assert.deepEqual((await app.modelOptions()).current, initial);
  assert.equal(app.preferences.defaultModel, '');
  assert.equal(app.store.list().length, 0);
});

test('unconfirmed or mismatched Hermes write results cannot become a successful switch', async () => {
  for (const response of [initial, local, { ok: true }]) {
    const adapter = { state: 'ready', request: async method => {
      if (method === 'workbench.model.set') return response;
      if (method === 'model.options') return { ...initial, providers: [{ slug: 'fixture-local', name: 'Local', models: ['local-model'], authenticated: true }] };
      throw Error('Unexpected RPC');
    } };
    const models = new HermesModels(adapter);
    await assert.rejects(models.set(local), error => {
      assert.equal(error.code, 'MODEL_SELECTION_UNCONFIRMED'); return true;
    });
  }
});

test('an unconfigured or unconfirmed provider cannot receive a model write', async () => {
  for (const authenticated of [false, null]) {
    const methods = [], adapter = { state: 'ready', request: async method => {
      methods.push(method);
      return { ...initial, providers: [{ slug: 'fixture-local', models: ['local-model'], authenticated }] };
    } };
    await assert.rejects(new HermesModels(adapter).set(local), { code: 'MODEL_PROVIDER_UNAVAILABLE' });
    assert.deepEqual(methods, ['model.options']);
  }
});

test('model HTTP routes enforce CSRF, strict input and public-only catalog projection', async t => {
  const f = await fixture(t); await f.http();
  let result = await (await fetch(f.origin + '/api/models')).json();
  assert.deepEqual(result, { connected: false, current: { provider: '', model: '' }, providers: [] });
  assert.equal(f.app.adapter.state, 'stopped');
  await f.app.connect();
  const request = f.app.adapter.request.bind(f.app.adapter);
  f.app.adapter.request = async (method, ...args) => {
    const value = await request(method, ...args);
    if (method === 'model.options') return { ...value, api_key: 'fixture-private-key', access_token: 'fixture-private-access',
      providers: value.providers.map(row => ({ ...row, api_key: 'fixture-private-key', base_url: 'https://private.fixture.invalid', key_hint: 'fixture-secret-hint' })) };
    return value;
  };
  const noCsrf = await fetch(f.origin + '/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(local) });
  assert.equal(noCsrf.status, 403);
  assert.equal((await fetch(f.origin + '/api/models', { headers: { Origin: 'https://untrusted.fixture.invalid' } })).status, 403);
  for (const body of [null, [], {}, { ...local, token: 'fixture-secret' }, { provider: '', model: local.model }, { provider: local.provider, model: '' }, { ...local, model: 'bad\nmodel' }, { ...local, provider: 'not-configured' }]) {
    const failed = await post(f, '/api/models', body);
    assert.equal(failed.status, 400, JSON.stringify(failed));
    assert.deepEqual((await f.app.modelOptions()).current, initial);
  }
  const changed = await post(f, '/api/models', local);
  assert.equal(changed.status, 200, JSON.stringify(changed.value));
  assert.deepEqual(changed.value.current, local);
  result = await (await fetch(f.origin + '/api/models')).json();
  assert.deepEqual(result.current, local);
  for (const object of [changed.value, result, f.app.bootstrap()]) {
    const text = JSON.stringify(object);
    for (const privateValue of ['fixture-private-key', 'fixture-private-access', 'private.fixture.invalid', 'fixture-secret-hint']) assert(!text.includes(privateValue));
  }
  assert.deepEqual(Object.keys(result).sort(), ['connected', 'current', 'providers']);
  assert.deepEqual(Object.keys(result.providers[0]).sort(), ['authenticated', 'id', 'label', 'models']);
  assert.equal(f.app.store.list().length, 0, 'model management must not create a conversation or run');
});

test('model HTTP reports backend rejection and native confirmation without claiming a switch', async t => {
  const f = await fixture(t); await f.app.connect(); await f.http();
  const request = f.app.adapter.request.bind(f.app.adapter);
  for (const [code, status] of [[-32020, 503], [4303, 409]]) {
    f.app.adapter.request = (method, ...args) => {
      if (method === 'workbench.model.set') throw Object.assign(Error('fixture-private-upstream-detail'), { code });
      return request(method, ...args);
    };
    const failed = await post(f, '/api/models', local);
    assert.equal(failed.status, status, JSON.stringify(failed.value));
    assert(!JSON.stringify(failed.value).includes('fixture-private-upstream-detail'));
    assert.deepEqual((await f.app.modelOptions()).current, initial);
  }
});

test('the public session endpoint cannot override the Hermes default with an internal model pin', async t => {
  const f = await fixture(t); await f.app.connect(); await f.http();
  await f.app.selectModel(local);
  for (const body of [{ modelRoute: initial }, { provider: initial.provider, model: initial.model },
    { title: 'attempted override', cwd: '.', modelRoute: initial }]) {
    const rejected = await post(f, '/api/sessions', body);
    assert.equal(rejected.status, 400, JSON.stringify(rejected.value));
    assert.equal(f.app.store.list().length, 0, 'an internal-only route must not be created through HTTP');
    assert.deepEqual((await f.app.modelOptions()).current, local);
  }
  const created = await post(f, '/api/sessions', { title: 'Hermes default', cwd: '.' });
  assert.equal(created.status, 201, JSON.stringify(created.value));
  assert.equal((await f.app.history(created.value.id)).info.provider, local.provider);
  assert.equal((await f.app.history(created.value.id)).info.model, local.model);
});


test('old session schemas preserve known subscription routes and refuse to guess an unknown empty route', async t => {
  const f = await fixture(t), app = f.app;
  await app.connect();
  const knownEmpty = await app.createSession({ title: 'legacy empty with recorded model' });
  const persisted = await app.createSession({ title: 'legacy persisted without local route' });
  await runPrompt(app, persisted, 'authoritative stored history');
  app.store.update(persisted.id, { model: '', provider: '' });
  const unknownEmpty = app.store.create({ title: 'legacy unknown empty', cwd: app.config.workspaceRoot,
    storedSessionId: 'legacy-unknown-empty', runtimeSessionId: null });
  await app.selectModel(local);
  await app.close();
  const db = new DatabaseSync(join(f.config.dataDir, 'workbench.sqlite'));
  try { db.exec('ALTER TABLE sessions DROP COLUMN provider'); } finally { db.close(); }
  const restarted = f.create();
  assert.equal(restarted.store.get(knownEmpty.id).provider, initial.provider);
  assert.equal(restarted.store.get(knownEmpty.id).model, initial.model);
  assert.equal(restarted.store.get(unknownEmpty.id).provider, '');
  await restarted.connect();
  assert.deepEqual((await restarted.modelOptions()).current, local);
  assert.equal((await restarted.history(knownEmpty.id)).info.provider, initial.provider);
  assert.equal((await restarted.history(knownEmpty.id)).info.model, initial.model);
  const methods = [], request = restarted.adapter.request.bind(restarted.adapter);
  restarted.adapter.request = (method, ...args) => { methods.push(method); return request(method, ...args); };
  await assert.rejects(restarted.history(unknownEmpty.id), /旧空会话.*未记录模型/);
  assert(!methods.includes('session.create'), 'unknown legacy route must not be recreated under the new default');
  const history = await restarted.history(persisted.id);
  assert.equal(history.info.provider, initial.provider);
  assert.equal(history.info.model, initial.model);
  assert.equal(restarted.store.get(persisted.id).provider, initial.provider, 'persisted Hermes history fills missing local route metadata');
  assert.deepEqual((await restarted.modelOptions()).current, local);
});
