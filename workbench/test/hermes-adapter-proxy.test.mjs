import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HermesAdapter } from '../src/hermes-adapter.mjs';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';

async function fixture(t, resolveProxyEnvironment) {
  const directory = await mkdtemp(join(tmpdir(), 'hermes-proxy-adapter-'));
  const gateway = join(directory, 'gateway.mjs');
  await writeFile(gateway, `import { createInterface } from 'node:readline';
    console.log(JSON.stringify({method:'event',params:{type:'gateway.ready'}}));
    for await (const line of createInterface({input:process.stdin})) {
      const frame=JSON.parse(line);
      const keys=['HTTP_PROXY','HTTPS_PROXY','HERMES_MODEL','HERMES_INFERENCE_PROVIDER'];
      const result=frame.method==='test.environment' ? Object.fromEntries(keys.filter(key=>Object.hasOwn(process.env,key)).map(key=>[key,process.env[key]])) : {};
      console.log(JSON.stringify({id:frame.id,result}));
    }
  `);
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace'),
    WORKBENCH_HERMES_ROOT: join(directory, 'hermes'), WORKBENCH_HERMES_HOME: join(directory, 'home') }),
    command: process.execPath, args: [gateway], readyTimeout: 2000,
    childEnv: { HTTP_PROXY: 'http://explicit.example.test:8123', HERMES_MODEL: 'must-not-override', HERMES_INFERENCE_PROVIDER: 'must-not-override' } };
  const adapter = new HermesAdapter(config, { resolveProxyEnvironment });
  t.after(async () => { await adapter.stop(); await rm(directory, { recursive: true, force: true }); });
  return { adapter, config };
}

test('each Hermes spawn resolves the merged child environment and emits only safe proxy metadata', async t => {
  let calls = 0;
  const originalEnvironment = JSON.stringify(Object.entries(process.env).sort());
  const { adapter } = await fixture(t, async env => {
    calls++;
    assert.equal(env.HTTP_PROXY, 'http://explicit.example.test:8123', 'childEnv is merged before proxy resolution');
    return { env: { ...env, HTTP_PROXY: 'http://inherited.example.test:' + (8100 + calls), HTTPS_PROXY: 'http://inherited.example.test:' + (8100 + calls) },
      diagnostics: { source: 'system', status: 'applied', count: 2, proxy: 'PRIVATE_PROXY_ADDRESS', password: 'PRIVATE_PROXY_CREDENTIAL' } };
  });
  const policies = [];
  adapter.on('network-policy', value => policies.push(value));
  await adapter.start();
  assert.equal(calls, 1);
  assert.deepEqual(await adapter.request('test.environment'), { HTTP_PROXY: 'http://inherited.example.test:8101', HTTPS_PROXY: 'http://inherited.example.test:8101' });
  assert.deepEqual(policies, [{ source: 'system', status: 'applied', count: 2 }]);
  await adapter.stop();
  await adapter.start();
  assert.equal(calls, 2, 'reconnect must resolve fresh system settings');
  assert.equal((await adapter.request('test.environment')).HTTP_PROXY, 'http://inherited.example.test:8102');
  assert.equal(JSON.stringify(Object.entries(process.env).sort()) === originalEnvironment, true, 'parent environment stays unchanged');
  assert.equal(JSON.stringify(adapter.log).includes('PRIVATE_PROXY'), false);
});

test('application proxy diagnostics persist only safe metadata and do not create business activity', async t => {
  const { adapter, config } = await fixture(t, async env => ({ env, diagnostics: { source: 'explicit', status: 'preserved' } }));
  const app = new Application(config, adapter);
  t.after(() => app.close());
  await app.workflowFoldersReady;
  adapter.emit('network-policy', { source: 'system', status: 'applied', count: 2, proxy: 'PRIVATE_PROXY_ADDRESS', password: 'PRIVATE_PROXY_CREDENTIAL' });
  adapter.emit('network-policy', { source: 'system', status: 'unavailable', code: 'system_proxy_read_failed', error: 'PRIVATE_PROXY_CREDENTIAL' });
  const entries = app.logger.read({ component: 'hermes' }).entries.filter(row => row.event === 'hermes.proxy.environment');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].level, 'info');
  assert.deepEqual(entries[0].context, { source: 'system', status: 'applied', count: 2 });
  assert.equal(entries[1].level, 'warn');
  assert.deepEqual(entries[1].context, { source: 'system', status: 'unavailable', code: 'system_proxy_read_failed' });
  assert.equal(JSON.stringify(entries).includes('PRIVATE_PROXY'), false);
  for (const table of ['workflow_documents', 'workflow_runs', 'workflow_learning', 'workflow_conversation_turns', 'application_conversation_turns']) {
    assert.equal(app.store.db.prepare('SELECT count(*) count FROM ' + table).get().count, 0);
  }
  assert.equal(app.store.list().length, 0);
});

test('stopping during system proxy discovery cannot spawn Hermes after cancellation', async t => {
  let release, entered;
  const discovering = new Promise(resolve => { entered = resolve; });
  const { adapter } = await fixture(t, env => {
    entered();
    return new Promise(resolve => { release = () => resolve({ env, diagnostics: { source: 'system', status: 'applied', count: 1 } }); });
  });
  const starting = adapter.start();
  const outcome = starting.then(() => null, error => error);
  // The old adapter ignores the resolver, so this assertion also detects the
  // missing discovery seam without waiting for an external service.
  assert.equal(typeof release, 'function');
  await discovering;
  await adapter.stop();
  release();
  assert.match((await outcome)?.message || '', /取消/);
  assert.equal(adapter.proc, undefined);
  assert.equal(adapter.state, 'stopped');
});

test('a stop requested by the proxy observation cannot start a late native process', async t => {
  const { adapter } = await fixture(t, async env => ({ env, diagnostics: { source: 'explicit', status: 'preserved' } }));
  adapter.on('network-policy', () => { void adapter.stop(); });
  await assert.rejects(adapter.start(), /取消/);
  assert.equal(adapter.proc, undefined);
  assert.equal(adapter.state, 'stopped');
});
