import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { executeCapability } from '../src/workflows/workflow-capabilities.mjs';
import { WORKFLOW_TOOLS } from '../shared/workflow/workflow-tools.mjs';

test('DAG HDK capability boundaries bind SQLite runs, attempts, receipts and original image/report bytes', () => {
  const python = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
  execFileSync(python, ['-B', fileURLToPath(new URL('./hdk-dag-capabilities.test.py', import.meta.url))],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 1048576 });
});

test('the capability bridge rejects non HDK methods and already aborted calls before spawning a converter', async () => {
  await assert.rejects(executeCapability({ toolName: 'shell.exec', input: {}, context: {} }), /未知|不支持/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(executeCapability({ toolName: 'hdk.four.prepare', input: {}, context: {}, signal: controller.signal }), /停止/);
});

test('the relocated capability bridge reaches the fixed Python entry point with an isolated missing database', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-capability-entry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'unavailable-fixture.sqlite');
  await assert.rejects(executeCapability({ toolName: 'hdk.four.prepare', input: {}, context: { databasePath } }), error => {
    assert.match(error.message, /unavailable-fixture\.sqlite/);
    assert.doesNotMatch(error.message, /can't open file|No module named/);
    return true;
  });
});

test('the capability bridge accepts every registered HDK name, including numeric firmware targets, before cancellation', async () => {
  const controller = new AbortController(); controller.abort();
  const registered = WORKFLOW_TOOLS.filter(tool => tool.id.startsWith('hdk.')).map(tool => tool.id);
  assert.ok(registered.includes('hdk.full.build-v3'));
  assert.ok(registered.includes('hdk.full.build-c61'));
  for (const toolName of registered) {
    await assert.rejects(executeCapability({ toolName, input: {}, context: {}, signal: controller.signal }), /^Error: 任务已停止。$/);
  }
});

test('the capability bridge rejects unregistered HDK methods even when their names resemble registered capabilities', async () => {
  const controller = new AbortController(); controller.abort();
  for (const toolName of ['hdk.full.build-v4', 'hdk.full.build-c62', 'hdk.full.unregistered', 'hdk.unknown.prepare']) {
    await assert.rejects(executeCapability({ toolName, input: {}, context: {}, signal: controller.signal }), /未知板卡能力/);
  }
});
