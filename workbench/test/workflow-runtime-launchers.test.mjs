import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareRuntimeLaunchers } from '../src/workflows/workflow-runtime-launchers.mjs';
import { executeOperation } from '../src/workflows/workflow-operations.mjs';
const execute = promisify(execFile);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-launcher-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "space ' quoted"), applications = join(root, 'Applications'), path = join(root, 'bin');
  await mkdir(applications, { recursive: true }); await mkdir(path);
  return { root, applications, path, options: { platform: 'darwin', path, temporaryRoot: root,
    inspectionOptions: { applicationDirectories: [applications] } } };
}
async function fakeCli(path) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '#!' + process.execPath + '\nconsole.log(JSON.stringify({args:process.argv.slice(2),script:process.argv[1],home:process.env.HOME,config:process.env.XDG_CONFIG_HOME,cache:process.env.XDG_CACHE_HOME,qt:process.env.QT_QPA_PLATFORM??null,freecadHome:process.env.FREECAD_USER_HOME,freecadData:process.env.FREECAD_USER_DATA,freecadTemp:process.env.FREECAD_USER_TEMP,secret:process.env.RUNTIME_LAUNCHER_PRIVATE_SECRET??null}));\n');
  await chmod(path, 0o700); return path;
}

test('scoped launchers make missing macOS software aliases executable without changing parent PATH or argument contents', async t => {
  const f = await fixture(t), target = await fakeCli(join(f.applications, 'Blender.app/Contents/MacOS/Blender'));
  const env = { PATH: f.path }, originalPath = process.env.PATH;
  await assert.rejects(execute('/bin/sh', ['-c', 'command -v blender'], { env }));
  const lease = await prepareRuntimeLaunchers(env, f.options);
  const args = ['with space', "single' and double\"", '; touch NEVER_RUN', '$(touch NEVER_RUN)', '`touch NEVER_RUN`'];
  try {
    assert.equal(process.env.PATH, originalPath); assert.deepEqual(env, { PATH: f.path });
    assert.ok(lease.env.PATH.startsWith(f.path + ':'));
    assert.equal((await stat(lease.directory)).mode & 0o777, 0o700);
    const result = JSON.parse((await execute('blender.exe', args, { env: lease.env, cwd: f.root })).stdout);
    assert.deepEqual(result.args, args); assert.equal(result.script, target);
    assert.ok(result.home.startsWith(lease.directory)); assert.equal(result.config, join(result.home, 'config'));
    assert.equal(result.cache, join(result.home, 'cache')); assert.equal(result.secret, null);
    assert.equal(await stat(join(f.root, 'NEVER_RUN')).catch(() => null), null);
  } finally { await lease.cleanup(); }
  assert.equal(await stat(lease.directory).catch(() => null), null);
});

test('existing PATH executables keep precedence and all fallback variants exec the selected native path', async t => {
  const f = await fixture(t), existing = await fakeCli(join(f.path, 'blender.exe'));
  await fakeCli(join(f.applications, 'Blender.app/Contents/MacOS/Blender'));
  const lease = await prepareRuntimeLaunchers({ PATH: f.path }, f.options);
  try {
    const result = JSON.parse((await execute('blender', ['argument'], { env: lease.env })).stdout);
    assert.equal(result.script, existing); assert.deepEqual(result.args, ['argument']);
    assert.equal(lease.aliases.find(alias => alias.command === 'blender').source, 'path');
    const direct = JSON.parse((await execute('blender.exe', [], { env: lease.env })).stdout);
    assert.equal(direct.script, existing); assert.equal(direct.home, undefined);
  } finally { await lease.cleanup(); }
});

test('FreeCADCmd fallback has a private offscreen profile while absence and other platforms keep the original environment', async t => {
  const f = await fixture(t);
  await fakeCli(join(f.applications, 'FreeCAD.app/Contents/Resources/bin/freecadcmd'));
  const lease = await prepareRuntimeLaunchers({ PATH: f.path }, f.options);
  try {
    const result = JSON.parse((await execute('FreeCADCmd', ['--version'], { env: lease.env })).stdout);
    assert.equal(result.qt, 'offscreen'); assert.ok(result.home.startsWith(lease.directory));
    assert.equal(result.freecadHome, result.home); assert.equal(result.freecadData, result.config);
    assert.ok(result.freecadTemp.startsWith(lease.directory)); assert.equal((await stat(result.freecadTemp)).isDirectory(), true);
  } finally { await lease.cleanup(); }
  const plain = await prepareRuntimeLaunchers({ PATH: f.path }, { ...f.options, platform: 'linux' });
  assert.equal(plain.directory, null); assert.deepEqual(plain.env, { PATH: f.path });
  const absent = await prepareRuntimeLaunchers({ PATH: f.path }, { ...f.options, inspectionOptions: { applicationDirectories: [] } });
  assert.equal(absent.directory, null); assert.deepEqual(absent.env, { PATH: f.path });
});

test('preparation cancellation and filesystem failure preserve cancellation and remove only owned temporary files', async t => {
  const f = await fixture(t), controller = new AbortController();
  await fakeCli(join(f.applications, 'Blender.app/Contents/MacOS/Blender')); controller.abort();
  await assert.rejects(prepareRuntimeLaunchers({ PATH: f.path }, { ...f.options, signal: controller.signal }), { code: 'ABORTED' });
  await assert.rejects(prepareRuntimeLaunchers({ PATH: f.path }, { ...f.options, temporaryRoot: join(f.root, 'absent') }), { code: 'CODE_ENVIRONMENT' });
  assert.equal((await readdir(f.root)).some(name => name.startsWith('workbench-runtime-cli-')), false);
});

test('real code workers receive fallback aliases and clean them after success, failure, cancellation and timeout', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t); await fakeCli(join(f.path, 'blender'));
  const original = process.env.PATH; process.env.PATH = f.path;
  const operation = (code, language = 'javascript', timeoutSeconds = 5) => executeOperation({
    node: { type: 'tool', config: { executionMode: 'code', language, code, inputType: 'any', outputType: 'object', timeoutSeconds } },
    input: null, cwd: f.root, pythonPath: '/usr/bin/python3',
  });
  try {
    const js = await operation("const {spawnSync}=await import('node:child_process'); const r=spawnSync('blender.exe',['with space'],{encoding:'utf8'}); if(r.status)throw Error(r.stderr); return JSON.parse(r.stdout);");
    const py = await operation("import json, subprocess\nreturn json.loads(subprocess.check_output(['blender.exe','python argument'],text=True))", 'python');
    assert.deepEqual(js.output.args, ['with space']); assert.deepEqual(py.output.args, ['python argument']);
    assert(js.runtime.softwareAliases.some(alias => alias.command === 'blender.exe'));
    for (const result of [js, py]) assert.equal(await stat(join(result.output.home, '..', '..')).catch(() => null), null);
    for (const kind of ['error', 'abort', 'timeout']) {
      const controller = new AbortController(); let root;
      const code = "console.log(process.env.PATH.split(':').at(-1)); " + (kind === 'error' ? "throw Error('fixture failure');" : 'await new Promise(resolve=>setTimeout(resolve,60000)); return {};');
      const pending = executeOperation({ node: { type: 'tool', config: { executionMode: 'code', language: 'javascript', code, inputType: 'any', outputType: 'object', timeoutSeconds: 1 } },
        input: null, cwd: f.root, signal: controller.signal, onLog: entry => { if (entry.stream === 'stdout') { root = join(entry.text.trim(), '..'); if (kind === 'abort') controller.abort(); } } });
      await assert.rejects(pending, { code: kind === 'error' ? 'CODE_FAILED' : kind === 'abort' ? 'ABORTED' : 'TIMEOUT' });
      assert.ok(root?.includes('workbench-runtime-cli-')); assert.equal(await stat(root).catch(() => null), null);
    }
  } finally { if (original === undefined) delete process.env.PATH; else process.env.PATH = original; }
});
