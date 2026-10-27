import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application } from '../src/application.mjs';
import { Store } from '../src/store.mjs';
import { initializeWorkspace } from '../src/workspace-layout.mjs';
import { DEFAULT_SHORTCUTS } from '../shared/keyboard-shortcuts.mjs';

async function fixture(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-project-layout-'));
  const config = {
    projectRoot, appRoot: join(projectRoot, 'workbench'),
    dataDir: join(projectRoot, 'workbench', '.local'),
    workspaceRoot: join(projectRoot, 'workflow'), workspaceRootConfigured: false,
    workflowRunRoot: join(projectRoot, 'local-originals'),
  };
  const stores = new Set(), applications = new Set();
  const store = () => { const instance = new Store(config.dataDir); stores.add(instance); return instance; };
  const application = () => { const instance = new Application(config); applications.add(instance); return instance; };
  t.after(async () => {
    for (const app of applications) if (!app.closed) await app.close();
    for (const instance of stores) { try { instance.close(); } catch {} }
    await rm(projectRoot, { recursive: true, force: true });
  });
  return { config, store, application };
}

test('first startup creates the project workflow workspace and uses it directly as the working directory', async t => {
  const { config, application } = await fixture(t);
  await assert.rejects(access(config.workspaceRoot), { code: 'ENOENT' });
  const app = application();
  assert.equal(app.preferences.defaultWorkspace, '.');
  assert.equal(app.backend.cwdDefault, config.workspaceRoot);
  assert.equal(app.workspace(), await realpath(config.workspaceRoot));
  assert.deepEqual((await readdir(config.workspaceRoot)).sort(), ['artifacts', 'outputs']);
  assert.notEqual(config.workflowRunRoot, config.workspaceRoot);
  await assert.rejects(access(config.workflowRunRoot), { code: 'ENOENT' });
  assert.equal(app.adapter.state, 'stopped', 'workspace creation does not start Hermes');
});

test('the former default preference migrates once without moving historical files, state or session paths', async t => {
  const { config, store } = await fixture(t);
  const oldWorkspace = join(config.appRoot, 'workspaces', 'default');
  await mkdir(oldWorkspace, { recursive: true });
  const oldArtifact = join(oldWorkspace, 'previous-result.txt');
  await writeFile(oldArtifact, 'previous immutable result');
  const state = store();
  state.savePreferences({ theme: 'dark', density: 'compact', defaultModel: '', defaultWorkspace: 'default' });
  const session = state.create({ title: 'history', cwd: oldWorkspace, storedSessionId: 'history', runtimeSessionId: null });

  const preferences = initializeWorkspace(config, state);
  assert.deepEqual(preferences, { theme: 'dark', density: 'compact', defaultModel: '', defaultWorkspace: '.', shortcuts: DEFAULT_SHORTCUTS });
  assert.deepEqual(state.preferences(), preferences);
  assert.equal(state.get(session.id).cwd, oldWorkspace);
  assert.equal(await readFile(oldArtifact, 'utf8'), 'previous immutable result');
  assert.equal(state.db.prepare('SELECT COUNT(*) AS count FROM workbench_migrations').get().count, 1);

  state.savePreferences({ ...preferences, defaultWorkspace: 'default' });
  assert.equal(initializeWorkspace(config, state).defaultWorkspace, 'default', 'a later explicit choice must not be migrated again');
});

test('a user-selected subdirectory is preserved and consumes the one-time default migration', async t => {
  const { config, store } = await fixture(t);
  const state = store();
  state.savePreferences({ defaultWorkspace: 'research' });
  assert.equal(initializeWorkspace(config, state).defaultWorkspace, 'research');
  state.savePreferences({ defaultWorkspace: 'default' });
  assert.equal(initializeWorkspace(config, state).defaultWorkspace, 'default');
});

test('explicit workspace roots and isolated data directories retain saved workspace preferences', async t => {
  const { config, store } = await fixture(t);
  const state = store();
  state.savePreferences({ defaultWorkspace: 'default' });
  for (const custom of [
    { ...config, workspaceRoot: join(config.projectRoot, 'custom-workspace') },
    { ...config, workspaceRootConfigured: true },
    { ...config, dataDir: join(config.projectRoot, 'custom-data') },
  ]) {
    assert.equal(initializeWorkspace(custom, state).defaultWorkspace, 'default');
    assert.equal(state.preferences().defaultWorkspace, 'default');
  }
  assert.equal(state.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='workbench_migrations'").get().count, 0);
});
