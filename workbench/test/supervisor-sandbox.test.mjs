import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSupervisorSandbox } from '../src/supervisor-sandbox.mjs';

const exec = promisify(execFile);
const probe = { writeInside: true, readOutsideDenied: true, writeOutsideDenied: true, childConfined: true, networkDenied: true, readonlyReadable: true, readonlyLinkDenied: true, runtimeReadonlyDenied: true, proxyReachable: true };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-sandbox-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { runtimeRoot: join(root, 'private-runtime'), appRoot: join(root, 'app'), dataDir: join(root, 'app/.local'),
    workspaceRoot: join(root, 'workspace'), hermesHome: join(root, 'hermes'), hermesRoot: join(root, 'hermes/hermes-agent'), python: process.execPath, applicationPort: 4318 };
  for (const name of ['appRoot', 'dataDir', 'workspaceRoot', 'hermesHome', 'hermesRoot']) await mkdir(paths[name], { recursive: true });
  await mkdir(join(paths.appRoot, 'python'));
  return { root, paths };
}

test('unsupported platforms explicitly refuse native execution without probing or creating a runtime', async t => {
  const { paths } = await fixture(t);
  const result = await buildSupervisorSandbox(paths, { platform: 'linux', runner: () => assert.fail('No host fallback') });
  assert.equal(result.status, 'unavailable'); assert.equal(result.evidence.code, 'platform_unsupported');
  await assert.rejects(access(paths.runtimeRoot), { code: 'ENOENT' }); assert.equal(result.command, undefined);
});

test('native execution is admitted only after every independent kernel probe succeeds', { skip: process.platform !== 'darwin' }, async t => {
  const { paths } = await fixture(t); let calls = 0;
  const runner = async () => { calls++; return { status: 'pass', stdout: JSON.stringify(probe) }; };
  const result = await buildSupervisorSandbox(paths, { runner });
  assert.equal(calls, 1); assert.equal(result.status, 'verified'); assert.equal(result.command, '/usr/bin/sandbox-exec');
  assert.deepEqual(result.evidence.probe, probe); assert.match(result.profileHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.env.HOME, join(result.cwd, 'home')); assert.equal(result.env.TMPDIR, join(result.cwd, 'tmp'));
  for (const key of Object.keys(probe)) {
    const rejected = await buildSupervisorSandbox(paths, { runner: async () => ({ status: 'pass', stdout: JSON.stringify({ ...probe, [key]: false }) }) });
    assert.equal(rejected.status, 'unavailable', key); assert.equal(rejected.command, undefined, key);
  }
});

test('failed, malformed or cancelled probes never return an executable host fallback', { skip: process.platform !== 'darwin' }, async t => {
  const { paths } = await fixture(t);
  for (const observed of [{ status: 'unavailable', stdout: '' }, { status: 'pass', stdout: 'not-json' }, { status: 'unavailable', stdout: JSON.stringify(probe) }]) {
    const result = await buildSupervisorSandbox(paths, { runner: async () => observed });
    assert.equal(result.status, 'unavailable'); assert.equal(result.argsPrefix, undefined);
  }
  const result = await buildSupervisorSandbox({ ...paths, python: join(paths.root || paths.hermesHome, 'missing-python') });
  assert.equal(result.evidence.code, 'runtime_unavailable');
});

test('a writable runtime cannot encompass source, settings, workflow or Hermes directories', { skip: process.platform !== 'darwin' }, async t => {
  const { root, paths } = await fixture(t);
  for (const runtimeRoot of [root, paths.appRoot, paths.dataDir, paths.workspaceRoot, paths.hermesHome]) {
    await assert.rejects(buildSupervisorSandbox({ ...paths, runtimeRoot }), { code: 'SUPERVISOR_SANDBOX_INVALID' });
  }
  for (const readRoot of ['/', paths.appRoot, paths.dataDir, paths.workspaceRoot, paths.hermesHome]) {
    await assert.rejects(buildSupervisorSandbox({ ...paths, readRoots: [readRoot] }), { code: 'SUPERVISOR_SANDBOX_INVALID' });
  }
  for (const readOnlyRoot of [root, paths.runtimeRoot, paths.appRoot]) await assert.rejects(buildSupervisorSandbox({ ...paths, readOnlyRoots: [readOnlyRoot] }), { code: 'SUPERVISOR_SANDBOX_INVALID' });
  const alias = join(root, 'runtime-alias');
  await mkdir(join(root, 'runtime-target')); await symlink(join(root, 'runtime-target'), alias);
  await assert.rejects(buildSupervisorSandbox({ ...paths, runtimeRoot: alias }), { code: 'SUPERVISOR_SANDBOX_INVALID' });
});

test('invalid or overlapping proxy and application ports fail before execution', { skip: process.platform !== 'darwin' }, async t => {
  const { paths } = await fixture(t);
  for (const applicationPort of [0, -1, 65536, 1.1, '4318']) await assert.rejects(buildSupervisorSandbox({ ...paths, applicationPort }), { code: 'SUPERVISOR_SANDBOX_INVALID' });
  for (const egressProxyPort of [0, -1, 65536, 1.1, '7890', 4318]) await assert.rejects(buildSupervisorSandbox({ ...paths, egressProxyPort }), { code: 'SUPERVISOR_SANDBOX_INVALID' });
});

test('a previous native process cannot replace its temporary directory with a host symlink before a policy probe', { skip: process.platform !== 'darwin' }, async t => {
  const { root, paths } = await fixture(t);
  await mkdir(paths.runtimeRoot); await mkdir(join(root, 'outside')); await symlink(join(root, 'outside'), join(paths.runtimeRoot, 'tmp'));
  await assert.rejects(buildSupervisorSandbox(paths), { code: 'SUPERVISOR_SANDBOX_INVALID' });
});

test('native dependency reads permit only individual managed installations and preserve a selected venv', { skip: process.platform !== 'darwin' }, async t => {
  const { paths } = await fixture(t);
  const installs = join(paths.hermesHome, 'installs'), venv = join(installs, 'fixture-install/venv');
  await mkdir(join(venv, 'bin'), { recursive: true }); await writeFile(join(venv, 'pyvenv.cfg'), 'home = fixture');
  await symlink(process.execPath, join(venv, 'bin/python3'));
  const result = await buildSupervisorSandbox({ ...paths, python: join(venv, 'bin/python3'), runtimeDependencyRoots: [venv] }, { runner: async () => ({ status: 'pass', stdout: JSON.stringify(probe) }) });
  assert.equal(result.status, 'verified');
  for (const path of [paths.hermesHome, installs, paths.dataDir, paths.workspaceRoot]) await assert.rejects(buildSupervisorSandbox({ ...paths, runtimeDependencyRoots: [path] }), { code: 'SUPERVISOR_SANDBOX_INVALID' });
});

test('real Seatbelt confines native files and children and reaches only the dedicated proxy', { skip: process.platform !== 'darwin' }, async t => {
  const { paths } = await fixture(t);
  const proxy = createServer(socket => socket.end()); proxy.listen(0, '127.0.0.1'); await new Promise(resolve => proxy.once('listening', resolve));
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const application = createServer(socket => socket.end()); application.listen(0, '127.0.0.1'); await new Promise(resolve => application.once('listening', resolve));
  t.after(() => new Promise(resolve => application.close(resolve)));
  const options = { ...paths, applicationPort: application.address().port, egressProxyPort: proxy.address().port };
  const privateConfig = join(paths.runtimeRoot, 'profile/config.yaml'); await mkdir(join(paths.runtimeRoot, 'profile'), { recursive: true });
  await writeFile(privateConfig, 'private-model-choice'); options.readOnlyRoots = [privateConfig];
  const policy = await buildSupervisorSandbox(options);
  t.diagnostic('Native supervisor sandbox: ' + policy.status + (policy.evidence.code ? ' (' + policy.evidence.code + ')' : ''));
  if (process.env.WORKBENCH_REQUIRE_SEATBELT === '1') assert.equal(policy.status, 'verified');
  if (policy.status !== 'verified') { assert.equal(policy.command, undefined); return; }
  assert.deepEqual(policy.evidence.probe, probe);
  const markers = [join(paths.appRoot, 'python/source.py'), join(paths.dataDir, 'permissions.sqlite'), join(paths.workspaceRoot, 'workflow.json'), join(paths.hermesHome, 'config.yaml')];
  for (const path of markers) await writeFile(path, 'human-controlled-original');
  const program = `const fs=require('node:fs'),cp=require('node:child_process');const paths=${JSON.stringify(markers)};const checks=[];
    for(const path of paths){try{fs.writeFileSync(path,'changed');checks.push(false);}catch(e){checks.push(['EPERM','EACCES'].includes(e.code));}}
    const child=cp.spawnSync('/bin/sh',['-c','printf changed > "$1"','sh',paths[1]],{encoding:'utf8'});checks.push(child.status!==0);
    checks.push(fs.readFileSync(paths[0],'utf8')==='human-controlled-original');
    try{fs.writeFileSync(${JSON.stringify(privateConfig)},'changed');checks.push(false);}catch(e){checks.push(['EPERM','EACCES'].includes(e.code));}
    try{fs.renameSync(${JSON.stringify(join(paths.runtimeRoot, 'profile'))},${JSON.stringify(join(paths.runtimeRoot, 'moved-profile'))});checks.push(false);}catch(e){checks.push(['EPERM','EACCES'].includes(e.code));}
    fs.writeFileSync(${JSON.stringify(join(policy.cwd, 'home/native-memory.md'))},'native-memory');
    console.log(JSON.stringify(checks));`;
  const result = await exec(policy.command, [...policy.argsPrefix, process.execPath, '-e', program], { cwd: policy.cwd, env: { ...process.env, ...policy.env } });
  assert.deepEqual(JSON.parse(result.stdout), [true, true, true, true, true, true, true, true]);
  for (const path of markers) assert.equal(await readFile(path, 'utf8'), 'human-controlled-original');
  assert.equal(await readFile(privateConfig, 'utf8'), 'private-model-choice');
  assert.equal(await readFile(join(policy.cwd, 'home/native-memory.md'), 'utf8'), 'native-memory');
});

test('real broad public read prefixes cannot reopen configured data inside code or managed runtime exceptions', { skip: process.platform !== 'darwin' }, async t => {
  const { root, paths } = await fixture(t);
  const dependency = join(paths.hermesHome, 'installs/fixture-revision/venv');
  paths.dataDir = join(dependency, 'private-app-data');
  paths.workspaceRoot = join(paths.appRoot, 'python/private-workflows');
  paths.runtimeRoot = join(paths.dataDir, 'native-runtime');
  for (const path of [dependency, paths.dataDir, paths.workspaceRoot, join(paths.appRoot, 'src')]) await mkdir(path, { recursive: true });
  const visible = [join(root, 'public-runtime.txt'), join(paths.appRoot, 'python/gateway.py'), join(paths.hermesRoot, 'run_agent.py'), join(dependency, 'site-package.py')];
  const hidden = [join(paths.appRoot, 'src/application.mjs'), join(paths.dataDir, 'permissions.sqlite'), join(paths.workspaceRoot, 'workflow.json'), join(paths.hermesHome, 'auth.json')];
  for (const path of visible) await writeFile(path, 'public-runtime');
  for (const path of hidden) await writeFile(path, 'private-application-data');
  const policy = await buildSupervisorSandbox({ ...paths, readRoots: [root], runtimeDependencyRoots: [dependency] });
  t.diagnostic('Protected roots under broad read prefix: ' + policy.status);
  if (process.env.WORKBENCH_REQUIRE_SEATBELT === '1') assert.equal(policy.status, 'verified');
  if (policy.status !== 'verified') return;
  const program = `const fs=require('node:fs'),checks=[];
    for(const path of ${JSON.stringify(visible)})checks.push(fs.readFileSync(path,'utf8')==='public-runtime');
    for(const path of ${JSON.stringify(hidden)}){try{fs.readFileSync(path);checks.push(false);}catch(e){checks.push(['EPERM','EACCES'].includes(e.code));}}
    fs.writeFileSync(${JSON.stringify(join(policy.cwd, 'home/private-state.txt'))},'native-state');console.log(JSON.stringify(checks));`;
  const result = await exec(policy.command, [...policy.argsPrefix, process.execPath, '-e', program], { cwd: policy.cwd, env: { ...process.env, ...policy.env } });
  assert.deepEqual(JSON.parse(result.stdout), Array(8).fill(true));
  assert.equal(await readFile(join(policy.cwd, 'home/private-state.txt'), 'utf8'), 'native-state');
  for (const path of hidden) assert.equal(await readFile(path, 'utf8'), 'private-application-data');
});
