import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCodeRuntime } from '../src/application-runtime-inspector.mjs';
import { CODE_LANGUAGES } from '../shared/workflow/workflow-model.mjs';
import { executeOperation } from '../src/workflows/workflow-operations.mjs';
import { mkdtemp, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('Python inspection reports the same real interpreter as code nodes and discovers modules without importing them', async t => {
  const app = { config: { hermesPython: process.env.WORKBENCH_TEST_PYTHON || 'python3' } };
  const result = await inspectCodeRuntime(app, { modules: ['json', 'this', 'nodeorchard_missing_module_a7b930'] });
  assert.equal(result.language, 'python');
  assert.equal(result.available, true);
  assert.deepEqual(result.supportedLanguages, [...CODE_LANGUAGES]);
  assert.match(result.version, /^\d+\.\d+\.\d+/);
  assert.equal(result.nodeVersion, process.version);
  assert.deepEqual(result.modules, [{ name: 'json', available: true }, { name: 'this', available: true },
    { name: 'nodeorchard_missing_module_a7b930', available: false }]);
  assert.equal(result.libraryProbe, 'spec-only');
  assert.equal(result.policy.codeSubprocessIsOsSandbox, false);
  assert.equal(result.policy.codeCandidateRequiresToolRegistration, false);
  const cwd = await mkdtemp(join(tmpdir(), 'runtime-inspector-code-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const actual = await executeOperation({ node: { type: 'tool', config: { executionMode: 'code', language: 'python',
    code: 'import platform\nreturn platform.python_version()' } }, input: null, cwd, pythonPath: app.config.hermesPython });
  assert.equal(result.version, actual.output);
});

test('JavaScript inspection uses the actual code-node Node executable and resolves modules without loading them', async () => {
  const result = await inspectCodeRuntime({ config: { hermesPython: '/must-not-start-python' } },
    { language: 'javascript', modules: ['fs', 'nodeorchard_missing_module_a7b930'] });
  assert.equal(result.version, process.versions.node);
  assert.equal(result.nodeVersion, process.version);
  assert.equal(result.libraryProbe, 'resolve-only');
  assert.deepEqual(result.modules, [{ name: 'fs', available: true }, { name: 'nodeorchard_missing_module_a7b930', available: false }]);
});

test('runtime inspection refuses paths, source, expressions, accessors and excessive module requests before spawning', async () => {
  let executed = false, accessed = false;
  const runner = async () => { executed = true; throw Error('must not run'); };
  const getterArray = []; Object.defineProperty(getterArray, '0', { enumerable: true, get() { accessed = true; return 'json'; } });
  for (const args of [
    { language: 'shell' }, { modules: ['os.system'] }, { modules: ['../os'] }, { modules: ['/tmp/module'] },
    { modules: ['json;import os'] }, { modules: ['--eval'] }, { modules: ['json\0'] }, { modules: ['json\n'] },
    { modules: Array(21).fill('json') }, { modules: 'json' }, { modules: null }, { language: null }, { modules: new Array(2) }, { modules: getterArray },
    { code: 'write files' }, { cwd: '/tmp' }, { executable: 'sh' },
    { get language() { accessed = true; return 'python'; } },
  ]) await assert.rejects(inspectCodeRuntime({}, args, { runner }), { code: 'RUNTIME_ARGUMENT_INVALID' });
  assert.equal(executed, false);
  assert.equal(accessed, false);
});

test('inspection reuses minimal code-node environment and removes its isolated temporary directory', async () => {
  const key = 'WORKBENCH_INSPECT_SYNTHETIC_SECRET', old = process.env[key], oldPythonPath = process.env.PYTHONPATH;
  process.env[key] = 'not-for-child'; process.env.PYTHONPATH = '/must-not-be-inherited';
  let options, executable;
  try {
    await inspectCodeRuntime({ config: { hermesPython: 'python3' } }, { modules: ['json'] }, { runner: async (file, args, settings) => {
      executable = file; options = settings;
      assert.equal(settings.env[key], undefined);
      assert.equal(settings.env.PYTHONPATH, undefined);
      assert.equal(settings.env.PYTHONDONTWRITEBYTECODE, '1');
      assert.equal(settings.env.PYTHONUTF8, '1');
      assert.notEqual(settings.cwd, process.cwd());
      return execute(file, args, settings);
    } });
  } finally {
    old === undefined ? delete process.env[key] : process.env[key] = old;
    oldPythonPath === undefined ? delete process.env.PYTHONPATH : process.env.PYTHONPATH = oldPythonPath;
  }
  assert.equal(executable, 'python3');
  assert.equal(await stat(options.cwd).catch(() => null), null);
});

test('interpreter startup failures, nonzero exits and malformed output never report available', async () => {
  await assert.rejects(inspectCodeRuntime({ config: { hermesPython: '/no-such-runtime-inspector-python' } }), { code: 'RUNTIME_START_FAILED' });
  await assert.rejects(inspectCodeRuntime({ config: { hermesPython: process.execPath } }), { code: 'RUNTIME_FAILED' });
  for (const stdout of ['', 'not json', '{"version":"3.12.1","modules":[{"name":"json","available":"true"}]}',
    '{"version":"3.12.1","modules":[]}', '{"version":"made up","modules":[{"name":"json","available":true}]}']) {
    await assert.rejects(inspectCodeRuntime({}, { modules: ['json'] }, { runner: async () => ({ stdout }) }), { code: 'RUNTIME_PROTOCOL_INVALID' });
  }
});

test('deadline and cancellation kill an isolated real child and preserve failure status', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-inspector-timeout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'slow-python');
  await writeFile(executable, '#!/bin/sh\nexec sleep 30\n'); await chmod(executable, 0o700);
  const app = { config: { hermesPython: executable } };
  const controller = new AbortController();
  const stopped = inspectCodeRuntime(app, {}, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 50);
  await assert.rejects(stopped, { code: 'ABORTED' }); clearTimeout(timer);
  const already = new AbortController(); already.abort();
  await assert.rejects(inspectCodeRuntime(app, {}, { signal: already.signal }), { code: 'ABORTED' });
  await assert.rejects(inspectCodeRuntime(app), { code: 'RUNTIME_TIMEOUT' });
});

test('a late runner success after abort remains cancelled and removes temporary state', async () => {
  const controller = new AbortController(); let cwd;
  await assert.rejects(inspectCodeRuntime({}, {}, { signal: controller.signal, runner: async (_file, _args, options) => {
    cwd = options.cwd; controller.abort(); return { stdout: '{"version":"3.12.1","modules":[]}' };
  } }), { code: 'ABORTED' });
  assert.equal(await stat(cwd).catch(() => null), null);
});
