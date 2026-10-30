import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectSoftware } from '../src/application-software-inspector.mjs';
const execute = promisify(execFile);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'software-inspector-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function binary(path, content = '#!/bin/sh\nprintf "Blender 5.2.1 LTS\\n"\n') {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content); await chmod(path, 0o700); return path;
}

test('discovery reports PATH CLI independently of launch verification and never starts a process by default', async t => {
  const directory = await fixture(t), executable = await binary(join(directory, 'blender'));
  const result = await inspectSoftware({}, { software: ['blender'] }, { path: directory, platform: 'linux',
    runner: async () => { throw new Error('discovery must not execute'); } });
  assert.equal(result.software.length, 1);
  const entry = result.software[0];
  assert.equal(entry.id, 'blender'); assert.equal(entry.installed, true);
  assert.equal(entry.installationStatus, 'found'); assert.equal(entry.pathVisible, true);
  assert.equal(entry.executable, true); assert.equal(entry.selectedPath, executable);
  assert.deepEqual(entry.candidates, [{ path: executable, source: 'path', executable: true }]);
  assert.equal(entry.launch.status, 'not-requested'); assert.equal(entry.launch.version, null);
});

test('launch verification uses fixed headless arguments and a cleaned minimal environment with temporary HOME', async t => {
  const directory = await fixture(t);
  const executable = await binary(join(directory, 'blender'), '#!/bin/sh\n[ "$#" = 3 ] && [ "$1" = --background ] && [ "$2" = --factory-startup ] && [ "$3" = --version ] || exit 17\n[ "$HOME" -ef "$PWD" ] || exit 18\nprintf "Blender 5.2.1 LTS\\n"\n');
  const key = 'WORKBENCH_SOFTWARE_SYNTHETIC_SECRET', previous = process.env[key], oldPythonPath = process.env.PYTHONPATH;
  process.env[key] = 'PRIVATE_TOKEN'; process.env.PYTHONPATH = '/PRIVATE_NOT_FOR_CHILD';
  let options;
  try {
    const result = await inspectSoftware({}, { software: ['blender'], verifyLaunch: true }, { path: directory, platform: 'linux',
      runner: async (file, args, settings) => {
        assert.equal(file, executable); options = settings;
        assert.equal(settings.env[key], undefined); assert.equal(settings.env.PYTHONPATH, undefined);
        assert.equal(settings.env.PYTHONDONTWRITEBYTECODE, '1'); assert.equal(settings.env.HOME, settings.cwd);
        assert.equal(settings.env.QT_QPA_PLATFORM, 'offscreen');
        return execute(file, args, settings);
      } });
    assert.equal(result.software[0].launch.status, 'verified');
    assert.equal(result.software[0].launch.version, '5.2.1');
    assert.equal(result.software[0].launch.exitCode, 0);
    assert.equal(result.software[0].launch.errorCode, null);
    assert.ok(result.software[0].launch.durationMs >= 0);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  } finally {
    previous === undefined ? delete process.env[key] : process.env[key] = previous;
    oldPythonPath === undefined ? delete process.env.PYTHONPATH : process.env.PYTHONPATH = oldPythonPath;
  }
  assert.equal(await stat(options.cwd).catch(() => null), null);
});

test('macOS bundle discovery finds headless Blender and FreeCAD CLI without PATH and never starts their GUI launcher', async t => {
  const directory = await fixture(t), applications = join(directory, 'Applications');
  const blender = await binary(join(applications, 'Blender.app/Contents/MacOS/Blender'));
  const freecad = await binary(join(applications, 'FreeCAD.app/Contents/Resources/bin/freecadcmd'),
    '#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = --version ] || exit 19\nprintf "FreeCAD 1.1.1 Revision: 20260414 (Git shallow)\\n"\n');
  await binary(join(applications, 'FreeCAD.app/Contents/MacOS/FreeCAD'), '#!/bin/sh\nexit 29\n');
  const result = await inspectSoftware({}, { verifyLaunch: true }, { platform: 'darwin', path: '', applicationDirectories: [applications] });
  assert.equal(result.software[0].selectedPath, blender);
  assert.equal(result.software[1].selectedPath, freecad);
  for (const entry of result.software.slice(0, 2)) {
    assert.equal(entry.installed, true); assert.equal(entry.pathVisible, false); assert.equal(entry.executable, true);
    assert.equal(entry.launch.status, 'verified'); assert.equal(entry.candidates[0].source, 'macos-app');
  }
  assert.equal(result.software[1].launch.version, '1.1.1');
  assert.equal(result.software[2].launch.status, 'not-found');
  assert.equal(result.software[2].installed, false);
});

test('GUI-only installation and a non-executable CLI remain distinct from not installed and never launch', async t => {
  const directory = await fixture(t), applications = join(directory, 'Applications'), path = join(directory, 'bin');
  await binary(join(applications, 'FreeCAD.app/Contents/MacOS/FreeCAD'));
  const ffmpeg = await binary(join(path, 'ffmpeg')); await chmod(ffmpeg, 0o600);
  let executed = false;
  const result = await inspectSoftware({}, { software: ['freecad', 'ffmpeg', 'blender'], verifyLaunch: true }, {
    platform: 'darwin', path, applicationDirectories: [applications], runner: async () => { executed = true; throw Error('must not execute'); } });
  assert.equal(executed, false);
  assert.equal(result.software[0].installed, true); assert.equal(result.software[0].executable, false);
  assert.equal(result.software[0].launch.errorCode, 'SOFTWARE_CLI_NOT_FOUND');
  assert.equal(result.software[1].installed, true); assert.equal(result.software[1].pathVisible, false);
  assert.equal(result.software[1].launch.status, 'not-executable');
  assert.equal(result.software[2].installationStatus, 'not-found');
  assert.equal(result.software[2].launch.errorCode, 'SOFTWARE_NOT_FOUND');
});

test('unknown software, arbitrary commands or paths, accessors and oversized requests are refused before execution', async () => {
  let executed = false, accessed = false;
  const list = []; Object.defineProperty(list, '0', { enumerable: true, get() { accessed = true; return 'blender'; } });
  for (const input of [null, { software: [] }, { software: ['python'] }, { software: ['../blender'] }, { software: ['/bin/sh'] },
    { software: ['blender;evil'] }, { software: Array(4).fill('blender') }, { software: new Array(2) }, { software: list },
    { verifyLaunch: null }, { verifyLaunch: 1 }, { args: ['--python', 'user.py'] }, { executable: '/bin/sh' },
    { cwd: '/tmp' }, { timeoutMs: 30000 }, { get software() { accessed = true; return ['blender']; } }]) {
    await assert.rejects(inspectSoftware({}, input, { runner: async () => { executed = true; } }), { code: 'SOFTWARE_ARGUMENT_INVALID' });
  }
  assert.equal(accessed, false); assert.equal(executed, false);
});

test('launch failures return fixed categories without stderr, credentials, environment or false version success', async t => {
  const directory = await fixture(t);
  await binary(join(directory, 'freecadcmd'), '#!/bin/sh\nprintf "FreeCAD 1.1.1\\n"\nprintf "Incompatible processor. This Qt build requires the following features:\\n neon PRIVATE_SECRET\\n" >&2\nexit 6\n');
  await binary(join(directory, 'ffmpeg'), '#!/bin/sh\nprintf "PRIVATE_SECRET /private/config credentials\\n"\n');
  const result = await inspectSoftware({}, { software: ['freecad', 'ffmpeg'], verifyLaunch: true }, { path: directory, platform: 'linux' });
  assert.equal(result.software[0].launch.status, 'failed'); assert.equal(result.software[0].launch.version, null);
  assert.equal(result.software[0].launch.errorCode, 'SOFTWARE_CPU_FEATURE_UNAVAILABLE');
  assert.equal(result.software[0].launch.exitCode, 6);
  assert.equal(result.software[1].launch.errorCode, 'SOFTWARE_VERSION_UNCONFIRMED');
  assert.equal(result.software[1].launch.exitCode, 0);
  const encoded = JSON.stringify(result);
  for (const privateText of ['PRIVATE_SECRET', '/private/config', 'stderr', 'stdout']) assert.equal(encoded.includes(privateText), false);
});

test('timeout, output limits and cancellation terminate isolated real CLI probes and remove temporary HOME', async t => {
  const directory = await fixture(t);
  await binary(join(directory, 'blender'), '#!/bin/sh\nexec /bin/sleep 30\n');
  await binary(join(directory, 'ffmpeg'), '#!/bin/sh\nexec /usr/bin/yes PRIVATE_OUTPUT\n');
  const options = [];
  const runner = (file, args, settings) => { options.push(settings); return execute(file, args, settings); };
  const timeout = await inspectSoftware({}, { software: ['blender'], verifyLaunch: true }, { path: directory, platform: 'linux', timeoutMs: 30, runner });
  assert.equal(timeout.software[0].launch.status, 'timeout');
  const noisy = await inspectSoftware({}, { software: ['ffmpeg'], verifyLaunch: true }, { path: directory, platform: 'linux', runner });
  assert.equal(noisy.software[0].launch.status, 'output-limit');
  assert.equal(JSON.stringify(noisy).includes('PRIVATE_OUTPUT'), false);
  const controller = new AbortController();
  const pending = inspectSoftware({}, { software: ['blender'], verifyLaunch: true }, { path: directory, platform: 'linux', runner, signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, { code: 'ABORTED' }); clearTimeout(timer);
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(inspectSoftware({}, {}, { signal: stopped.signal }), { code: 'ABORTED' });
  for (const settings of options) assert.equal(await stat(settings.cwd).catch(() => null), null);
});

test('a late runner success cannot override cancellation and cleans its temporary state', async t => {
  const directory = await fixture(t); await binary(join(directory, 'blender'));
  const controller = new AbortController(); let cwd;
  await assert.rejects(inspectSoftware({}, { software: ['blender'], verifyLaunch: true }, { path: directory, platform: 'linux', signal: controller.signal,
    runner: async (_file, _args, settings) => { cwd = settings.cwd; controller.abort(); return { stdout: 'Blender 5.2.1 LTS' }; } }), { code: 'ABORTED' });
  assert.equal(await stat(cwd).catch(() => null), null);
});

test('candidate lists remain bounded and non-macOS discovery does not scan application bundles', async t => {
  const directory = await fixture(t), directories = [];
  for (let index = 0; index < 12; index++) {
    const path = join(directory, 'bin-' + index); directories.push(path); await binary(join(path, 'blender'));
  }
  const result = await inspectSoftware({}, { software: ['blender'] }, { path: directories.join(':'), platform: 'linux' });
  assert.equal(result.software[0].candidates.length, 8);
  assert.equal(result.software[0].selectedPath, join(directories[0], 'blender'));
  const applications = join(directory, 'Applications'); await binary(join(applications, 'Blender.app/Contents/MacOS/Blender'));
  const absent = await inspectSoftware({}, { software: ['blender'] }, { path: '', platform: 'linux', applicationDirectories: [applications] });
  assert.equal(absent.software[0].installed, false);
});
