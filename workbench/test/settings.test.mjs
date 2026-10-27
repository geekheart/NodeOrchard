import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { DEFAULT_SHORTCUTS } from '../shared/keyboard-shortcuts.mjs';
import { createWorkbenchServer } from '../src/server.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-hermes.mjs', import.meta.url));

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-preferences-test-'));
  const config = {
    ...readConfig({
      WORKBENCH_HERMES_ROOT: join(directory, 'fake-install'),
      WORKBENCH_HERMES_HOME: join(directory, 'fake-home'),
    }),
    dataDir: join(directory, 'db'),
    workspaceRoot: join(directory, 'workspace'),
    workflowRunRoot: join(directory, 'runs'),
    command: process.execPath,
    args: [fixture],
    childEnv: {
      FAKE_HERMES_STATE_PATH: join(directory, 'hermes.json'),
      FAKE_APPROVAL_MODE: 'manual',
      FAKE_FALLBACK_PROVIDER: '',
      FAKE_RESUME_RACE: '',
    },
  };
  const applications = new Set();
  const create = () => {
    const app = new Application(config);
    applications.add(app);
    return app;
  };
  t.after(async () => {
    for (const app of applications) if (!app.closed) await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { app: create(), create, config, directory };
}

test('saved preferences and the Hermes default survive restart without a local model override', async t => {
  const { app, create, config } = await setup(t);
  const expected = {
    theme: 'dark', density: 'compact', defaultWorkspace: 'research', defaultModel: '', shortcuts: DEFAULT_SHORTCUTS,
  };
  await app.connect();
  assert.deepEqual((await app.saveSettings({ preferences: expected })).preferences, expected);
  await app.selectModel({ provider: 'fixture-local', model: 'local-model' });
  await app.close();

  const restarted = create();
  const loaded = await restarted.settings();
  assert.deepEqual(loaded.preferences, expected);
  assert.equal(loaded.approvalMode, null, 'an offline app cannot confirm the backend approval mode');
  assert.equal(restarted.adapter.state, 'stopped', 'loading preferences does not start Hermes');
  await restarted.connect();
  const session = await restarted.createSession({ title: 'preference defaults' });
  assert.equal(session.cwd, await realpath(join(config.workspaceRoot, 'research')));
  assert.equal((await restarted.history(session.id)).info.model, 'local-model');
  assert.equal((await restarted.history(session.id)).info.provider, 'fixture-local');
  assert.equal((await restarted.settings()).approvalMode, 'manual');
});

test('shortcut preference patches persist across restart without resetting other bindings or connecting Hermes', async t => {
  const { app, create } = await setup(t);
  assert.deepEqual((await app.settings()).preferences.shortcuts, DEFAULT_SHORTCUTS);
  await app.saveSettings({ preferences: { shortcuts: { 'chat.send': ['Ctrl+Shift+Enter'], 'canvas.fit': [] } } });
  await app.saveSettings({ preferences: { theme: 'dark', shortcuts: { 'canvas.toggleProperties': ['H'], 'canvas.toggleLibrary': ['F'] } } });
  const saved = (await app.settings()).preferences;
  assert.deepEqual(saved.shortcuts['chat.send'], ['Ctrl+Shift+Enter']); assert.deepEqual(saved.shortcuts['canvas.fit'], []);
  assert.deepEqual(saved.shortcuts['canvas.toggleProperties'], ['H']); assert.deepEqual(saved.shortcuts['workflow.undo'], DEFAULT_SHORTCUTS['workflow.undo']);
  assert.deepEqual(saved.shortcuts['canvas.toggleLibrary'], ['F'], 'a disabled current action does not conflict with its obsolete default');
  assert.equal(app.adapter.state, 'stopped'); await app.close();
  const restarted = create(); assert.deepEqual((await restarted.settings()).preferences, saved);
  assert.equal(restarted.adapter.state, 'stopped');
});

test('settings HTTP rejects shortcut conflicts atomically and serves the shared keyboard contract without side effects', async t => {
  const { app, config } = await setup(t), bridge = createWorkbenchServer({ ...config, port: 0 }, app), origin = await bridge.listen();
  t.after(() => bridge.close());
  const boot = await (await fetch(origin + '/api/bootstrap')).json();
  const initial = (await app.settings()).preferences;
  const response = await fetch(origin + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': boot.csrfToken },
    body: JSON.stringify({ preferences: { theme: 'dark', shortcuts: { 'chat.focus': ['Ctrl+Enter'] } } }) });
  assert.equal(response.status, 400); assert.match((await response.json()).error, /冲突/);
  assert.deepEqual((await app.settings()).preferences, initial);
  const accepted = await fetch(origin + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': boot.csrfToken },
    body: JSON.stringify({ preferences: { shortcuts: { 'chat.send': ['Ctrl+Shift+Enter'] } } }) });
  assert.equal(accepted.status, 200); assert.deepEqual((await accepted.json()).preferences.shortcuts['chat.send'], ['Ctrl+Shift+Enter']);
  const script = await fetch(origin + '/shared/keyboard-shortcuts.mjs');
  assert.equal(script.status, 200); assert.match(script.headers.get('content-type'), /javascript/); assert.match(await script.text(), /SHORTCUT_ACTIONS/);
  assert.equal(app.adapter.state, 'stopped');
});

test('legacy preferences and malformed persisted shortcut maps fall back without discarding valid appearance settings', async t => {
  const { app, create } = await setup(t);
  app.store.savePreferences({ theme: 'dark', density: 'compact', defaultWorkspace: '.', shortcuts: { unknown: ['Ctrl+Enter'] } });
  await app.close();
  const restarted = create(), loaded = (await restarted.settings()).preferences;
  assert.equal(loaded.theme, 'dark'); assert.equal(loaded.density, 'compact'); assert.deepEqual(loaded.shortcuts, DEFAULT_SHORTCUTS);
  restarted.store.savePreferences({ theme: 'light', density: 'comfortable', defaultWorkspace: '.' }); await restarted.close();
  const legacy = create(); assert.deepEqual(legacy.preferences.shortcuts, DEFAULT_SHORTCUTS); assert.equal(legacy.preferences.theme, 'light');
});

test('a new installation starts sessions directly in its workspace root', async t => {
  const { app, config } = await setup(t);
  assert.equal(app.preferences.defaultWorkspace, '.');
  await app.connect();
  const session = await app.createSession({ title: 'root workspace default' });
  assert.equal(session.cwd, await realpath(config.workspaceRoot));
  assert.equal(app.store.get(session.id).cwd, session.cwd);
});

test('invalid settings are rejected atomically and cannot create paths outside the workspace', async t => {
  const { app, directory, config } = await setup(t);
  const initial = (await app.settings()).preferences;
  const outside = join(directory, 'outside');
  await mkdir(outside);
  await symlink(outside, join(config.workspaceRoot, 'escape'));
  const invalid = [
    { preferences: { theme: 'neon' } },
    { preferences: { density: 1 } },
    { preferences: { theme: 'dark', unexpected: true } },
    { preferences: { theme: 'dark' }, hermesHome: outside },
    { preferences: { defaultWorkspace: '../must-not-exist' } },
    { preferences: { defaultWorkspace: 'escape/must-not-exist' } },
  ];
  for (const input of invalid) {
    await assert.rejects(async () => app.saveSettings(input));
    assert.deepEqual((await app.settings()).preferences, initial, 'a rejected patch must not partly save');
  }
  await assert.rejects(access(join(directory, 'must-not-exist')), { code: 'ENOENT' });
  await assert.rejects(access(join(outside, 'must-not-exist')), { code: 'ENOENT' });
  assert.equal(app.adapter.state, 'stopped');
});

test('local default model overrides are rejected and only Hermes owns model selection', async t => {
  const { app } = await setup(t);
  for (const model of ['test-model-alt', 'unknown-custom-model']) {
    await assert.rejects(async () => app.saveSettings({ preferences: { defaultModel: model } }), /Hermes|模型/);
  }
  assert.equal((await app.settings()).preferences.defaultModel, '');
  assert.equal(app.adapter.state, 'stopped', 'rejecting an obsolete preference does not contact Hermes');
  await app.connect();
  await app.selectModel({ provider: 'fixture-local', model: 'local-model' });
  await assert.rejects(async () => app.saveSettings({ preferences: { defaultModel: 'test-model' } }), /Hermes|模型/);
  await app.saveSettings({ preferences: { defaultModel: '' } });
  assert.equal((await app.settings()).preferences.defaultModel, '');
  assert.deepEqual((await app.modelOptions()).current, { provider: 'fixture-local', model: 'local-model' });
});

test('a legacy defaultModel is ignored on load without replacing the Hermes default', async t => {
  const { app, create } = await setup(t);
  await app.connect();
  await app.selectModel({ provider: 'fixture-local', model: 'custom/legacy-safe-model' });
  app.store.savePreferences({ ...app.preferences, theme: 'dark', defaultModel: 'stale-subscription-model' });
  await app.close();
  const restarted = create();
  assert.equal(restarted.preferences.theme, 'dark');
  assert.equal(restarted.preferences.defaultModel, '');
  assert.equal(restarted.adapter.state, 'stopped');
  await restarted.connect();
  assert.deepEqual((await restarted.modelOptions()).current, { provider: 'fixture-local', model: 'custom/legacy-safe-model' });
  const session = await restarted.createSession();
  assert.equal((await restarted.history(session.id)).info.model, 'custom/legacy-safe-model');
});

test('empty statistics have no success denominator or fabricated billing metrics', async t => {
  const { app } = await setup(t);
  const result = await app.statistics(7);
  assert.equal(result.days, 7);
  assert.equal(result.totals.runs, 0);
  assert.equal(result.totals.successRate, null);
  assert.equal(result.daily.length, 7);
  assert.deepEqual(result.recentRuns, []);
  for (const object of [result, result.totals]) {
    assert(!Object.hasOwn(object, 'tokens'));
    assert(!Object.hasOwn(object, 'cost'));
  }
  assert.equal(app.adapter.state, 'stopped');
  assert.throws(() => app.statistics(14), /7|30/);
});

test('statistics include UTC boundary dates and use all terminal outcomes as the denominator', async t => {
  const { app, config } = await setup(t);
  const store = app.store;
  const session = store.create({
    title: 'known outcomes', cwd: config.workspaceRoot, storedSessionId: 'known-outcomes', runtimeSessionId: null,
  });
  const waiting = store.create({
    title: 'older waiting session', cwd: config.workspaceRoot, storedSessionId: 'older-waiting', runtimeSessionId: null,
  });
  store.update(waiting.id, { status: 'waiting' });
  store.create({ title: 'unused session', cwd: config.workspaceRoot, storedSessionId: 'unused', runtimeSessionId: null });
  store.db.prepare('UPDATE sessions SET created_at=?').run('2025-01-01T00:00:00.000Z');
  const outcomes = [
    ['complete', '2026-10-24T00:00:00.000Z'],
    ['complete', '2026-10-18T00:00:00.000Z'], // First included day of the 7-day window.
    ['error', '2026-10-24T03:00:00.000Z'],
    ['interrupted', '2026-10-23T15:00:00.000Z'],
    ['unknown', '2026-10-19T12:00:00.000Z'],
    ['failed', '2026-10-17T23:59:59.999Z'], // Outside 7 days, inside 30.
    ['interrupted', '2026-09-25T00:00:00.000Z'], // First included day of the 30-day window.
    ['complete', '2026-09-24T23:59:59.999Z'], // Outside 30 days.
    ['complete', '2026-10-25T00:00:00.000Z'], // Tomorrow is outside both windows.
    ['running', '2026-10-24T04:00:00.000Z'], // Included in runs, excluded from the success denominator.
  ];
  for (const [status, startedAt] of outcomes) {
    const id = store.beginRun(session.id);
    if (status !== 'running') store.finishRun(session.id, status);
    store.db.prepare('UPDATE runs SET started_at=?, completed_at=? WHERE id=?')
      .run(startedAt, status === 'running' ? null : startedAt, id);
  }
  const now = new Date('2026-10-24T10:30:00.000Z');
  const weekly = store.statistics(7, now);
  assert.deepEqual(weekly.totals, {
    sessions: 3, active: 2, runs: 6, completed: 2, failed: 1, interrupted: 1, unknown: 1, successRate: 0.4,
  });
  assert.equal(weekly.daily[0].date, '2026-10-18');
  assert.equal(weekly.daily.at(-1).date, '2026-10-24');
  assert.equal(weekly.daily[0].completed, 1);
  assert.equal(weekly.daily.at(-1).runs, 3);
  assert.equal(weekly.daily.reduce((sum, day) => sum + day.runs, 0), 6);
  assert(!weekly.recentRuns.some(run => run.startedAt.startsWith('2026-10-17') || run.startedAt.startsWith('2026-10-25')));

  const monthly = store.statistics(30, now);
  assert.equal(monthly.totals.sessions, 3);
  assert.equal(monthly.totals.active, 2);
  assert.equal(monthly.totals.runs, 8);
  assert.equal(monthly.totals.completed, 2);
  assert.equal(monthly.totals.failed, 2);
  assert.equal(monthly.totals.interrupted, 2);
  assert.equal(monthly.totals.unknown, 1);
  assert.equal(monthly.totals.successRate, 2 / 7);
  assert.equal(monthly.daily.length, 30);
  assert.equal(monthly.daily[0].date, '2026-09-25');
  assert.equal(monthly.daily.at(-1).date, '2026-10-24');
  assert.equal(monthly.daily[0].interrupted, 1);
});
