import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.mjs';
import { Application } from '../src/application.mjs';
import { createWorkbenchServer } from '../src/server.mjs';

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-editor-assets-'));
  const config = readConfig({
    WORKBENCH_PORT: '0',
    WORKBENCH_DATA_DIR: join(directory, 'data'),
    WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace'),
    WORKBENCH_HERMES_ROOT: join(directory, 'unused-hermes-install'),
    WORKBENCH_HERMES_HOME: join(directory, 'unused-hermes-home'),
  });
  const app = new Application(config);
  const backendCalls = [];
  for (const method of ['start', 'request']) {
    app.adapter[method] = () => {
      backendCalls.push(method);
      throw new Error(`Static asset requests must not call Hermes ${method}`);
    };
  }
  const bridge = createWorkbenchServer(config, app);
  t.after(async () => {
    try { await bridge.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const origin = await bridge.listen();
  const before = app.bootstrap();
  const workspaceBefore = (await readdir(config.workspaceRoot, { recursive: true })).sort();
  return {
    config, app, origin,
    async assertNoRuntimeChanges() {
      assert.deepEqual(backendCalls, []);
      assert.equal(app.adapter.state, 'stopped');
      assert.equal(app.adapter.proc, undefined);
      assert.deepEqual(app.bootstrap(), before);
      assert.equal(app.statistics().totals.runs, 0);
      assert.equal(app.sequence, 0);
      assert.deepEqual((await readdir(config.workspaceRoot, { recursive: true })).sort(), workspaceBefore);
      await assert.rejects(readFile(join(config.hermesHome, 'config.yaml')), { code: 'ENOENT' });
    },
  };
}

function assertSameOriginPolicy(response) {
  const policy = response.headers.get('content-security-policy');
  assert(policy);
  const directives = new Map(policy.split(';').map(part => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name, values];
  }));
  for (const name of ['default-src', 'script-src', 'style-src', 'connect-src']) {
    assert.deepEqual(directives.get(name), ["'self'"]);
  }
  assert.deepEqual(directives.get('frame-ancestors'), ["'none'"]);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

test('workflow editor assets are served as same-origin code without starting a runtime', async t => {
  const fixture = await setup(t);
  for (const [name, type] of [
    ['workflow-editor.js', 'text/javascript'],
    ['diagnostic-events.js', 'text/javascript'],
    ['shared/diagnostics.mjs', 'text/javascript'],
    ...['components', 'conversation-commands', 'dataset', 'inputs', 'model', 'plan', 'presets',
      'schedule-time', 'studio-utils', 'tools', 'validation', 'versioning']
      .map(name => [`shared/workflow/workflow-${name}.mjs`, 'text/javascript']),
    ['workflow-editor.css', 'text/css'],
    ['workflow-runtime-ui.js', 'text/javascript'],
    ['workflow-runtime-ui.css', 'text/css'],
    ['workflow-learning-ui.js', 'text/javascript'],
    ['workflow-learning-ui.css', 'text/css'],
  ]) {
    const response = await fetch(`${fixture.origin}/${name}`);
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get('content-type'), `${type}; charset=utf-8`);
    assertSameOriginPolicy(response);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(bytes.length > 0, `${name} must not be an empty placeholder`);
    const diskPath = name.startsWith('shared/') ? join(fixture.config.appRoot, name) : join(fixture.config.appRoot, 'public', name);
    assert.deepEqual(bytes, await readFile(diskPath));
  }
  await fixture.assertNoRuntimeChanges();
});

test('workflow static registration does not expose unlisted or private files', async t => {
  const fixture = await setup(t);
  for (const path of [
    '/workflow-editor.js.map',
    '/workflow-model.js',
    '/workflow-model.mjs',
    '/public/workflow-editor.js',
    '/shared/workflow/unknown.mjs',
    '/shared/workflow/workflow-model.mjs.map',
    '/shared/workflow/%2e%2e/%2e%2e/src/server.mjs',
    '/shared/workflow/%2e%2e%2f%2e%2e%2fsrc/server.mjs',
    '/shared/workflow/../../../.local/workbench.sqlite',
    '/src/server.mjs',
    '/src/workflows/workflow-runs.mjs',
    '/workflow/private-input.json',
    '/test/fixtures/fake-hermes.mjs',
  ]) {
    const response = await fetch(`${fixture.origin}${path}`);
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assertSameOriginPolicy(response);
    assert.deepEqual(await response.json(), { error: '接口不存在。' });
  }
  await fixture.assertNoRuntimeChanges();
});

test('the entire browser module graph resolves through public assets or the shared allowlist', async t => {
  const fixture = await setup(t), pending = ['/app.js'], visited = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const response = await fetch(fixture.origin + path);
    assert.equal(response.status, 200, `Missing imported browser module: ${path}`);
    assert.match(response.headers.get('content-type'), /^text\/javascript/);
    const source = await response.text();
    for (const match of source.matchAll(/\b(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const target = new URL(match[1], fixture.origin + path);
      assert.equal(target.origin, fixture.origin, `Browser import left the app origin: ${match[1]}`);
      assert.ok(target.pathname.startsWith('/shared/workflow/') || target.pathname === '/shared/diagnostics.mjs' || /^\/[^/]+\.js$/.test(target.pathname), target.pathname);
      pending.push(target.pathname);
    }
  }
  assert.ok(visited.has('/shared/workflow/workflow-model.mjs'));
  assert.ok(visited.has('/shared/workflow/workflow-components.mjs'));
  assert.ok(visited.has('/workflow-studio-ui.js'));
  await fixture.assertNoRuntimeChanges();
});
