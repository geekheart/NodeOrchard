import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, lstat, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareSupervisorProfile, supervisorPython } from '../src/supervisor-profile.mjs';

const execute = promisify(execFile);
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'supervisor-profile-'))), home = join(root, 'source'), installed = join(root, 'installed'), runtime = join(root, 'runtime');
  for (const path of [home, installed, join(home, 'skills'), join(home, 'plugins')]) await mkdir(path, { recursive: true });
  const config = { hermesHome: home, hermesRoot: installed, hermesPython: process.execPath, appRoot: fileURLToPath(new URL('..', import.meta.url)) }, calls = [];
  const rewrite = async (...args) => { calls.push(args); };
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home, installed, runtime, config, calls, rewrite };
}
const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

test('private native profile never changes source auth/config and preserves refreshed auth until a human source generation changes', async t => {
  const f = await fixture(t); await writeFile(join(f.home, 'auth.json'), '{"fixture":"source-one"}'); await writeFile(join(f.home, 'config.yaml'), 'model: fixture\n');
  const first = await prepareSupervisorProfile(f.config, f.runtime, { rewrite: f.rewrite });
  await writeFile(join(first.profile, 'auth.json'), '{"fixture":"private-refresh"}');
  await prepareSupervisorProfile(f.config, f.runtime, { rewrite: f.rewrite });
  assert.equal(await readFile(join(first.profile, 'auth.json'), 'utf8'), '{"fixture":"private-refresh"}');
  assert.equal(await readFile(join(f.home, 'auth.json'), 'utf8'), '{"fixture":"source-one"}');
  await writeFile(join(f.home, 'auth.json'), '{"fixture":"human-login-two"}');
  const changed = await prepareSupervisorProfile(f.config, f.runtime, { rewrite: f.rewrite });
  assert.equal(await readFile(join(changed.profile, 'auth.json'), 'utf8'), '{"fixture":"human-login-two"}');
  const control = changed.readOnlyRoots.find(path => path.endsWith('/control')); assert(control);
  const marker = JSON.parse(await readFile(join(control, 'auth-source.json'), 'utf8'));
  assert.equal(marker.sourceSha256, createHash('sha256').update('{"fixture":"human-login-two"}').digest('hex'));
  assert(!JSON.stringify(marker).includes('human-login-two')); assert.equal((await lstat(join(changed.profile, 'auth.json'))).mode & 0o777, 0o600);
});

test('removed source config, dotenv and auth cannot survive as stale private copies', async t => {
  const f = await fixture(t);
  for (const [name, value] of [['config.yaml', 'model: old\n'], ['.env', 'OLD_FIXTURE_TOKEN=fake\n'], ['auth.json', '{"fixture":"old"}']]) await writeFile(join(f.home, name), value);
  const first = await prepareSupervisorProfile(f.config, f.runtime, { rewrite: f.rewrite });
  for (const name of ['config.yaml', '.env', 'auth.json']) await rm(join(f.home, name));
  await prepareSupervisorProfile(f.config, f.runtime, { rewrite: f.rewrite });
  assert.equal(await readFile(join(first.profile, 'config.yaml'), 'utf8'), '{}\n');
  assert.equal(await exists(join(first.profile, '.env')), false); assert.equal(await exists(join(first.profile, 'auth.json')), false);
});

test('fresh extension snapshots remove deleted source skills/plugins while keeping native-generated skills and memories', async t => {
  const f = await fixture(t);
  await mkdir(join(f.home, 'skills', 'source-skill')); await writeFile(join(f.home, 'skills', 'source-skill', 'SKILL.md'), 'fixture skill');
  await mkdir(join(f.home, 'plugins', 'source-plugin')); await writeFile(join(f.home, 'plugins', 'source-plugin', 'plugin.yaml'), 'name: fixture');
  const first = await prepareSupervisorProfile(f.config, f.runtime, { rewrite: f.rewrite }), firstSkills = f.calls[0][1][2];
  await writeFile(join(first.profile, 'skills', 'generated.md'), 'native-generation'); await writeFile(join(first.profile, 'memories', 'MEMORY.md'), 'native memory');
  await rm(join(f.home, 'skills', 'source-skill'), { recursive: true }); await rm(join(f.home, 'plugins', 'source-plugin'), { recursive: true });
  const second = await prepareSupervisorProfile(f.config, f.runtime, { rewrite: f.rewrite }), secondSkills = f.calls[1][1][2];
  assert.notEqual(firstSkills, secondSkills); assert(second.readOnlyRoots.some(path => secondSkills.startsWith(path + '/')));
  assert.equal(await exists(join(secondSkills, 'source-skill')), false); assert.equal(await exists(join(second.profile, 'plugins', 'source-plugin')), false);
  assert.equal(await readFile(join(second.profile, 'skills', 'generated.md'), 'utf8'), 'native-generation');
  assert.equal(await readFile(join(second.profile, 'memories', 'MEMORY.md'), 'utf8'), 'native memory');
});

test('native dependency selection uses the source realpath hash and retains the selected venv path', async t => {
  const f = await fixture(t), key = createHash('sha256').update(await realpath(f.installed)).digest('hex').slice(0, 16), install = join(f.home, 'installs', key), environment = join(install, 'venv');
  await mkdir(join(environment, 'bin'), { recursive: true }); await symlink(process.execPath, join(environment, 'bin', 'python3'));
  await writeFile(join(install, 'facts.json'), JSON.stringify({ packages: { venv: { environment } } }));
  const result = await supervisorPython(f.config);
  assert.equal(result.python, join(environment, 'bin', 'python3')); assert.deepEqual(result.dependencyRoots, [environment]);
  assert.notEqual(result.python, await realpath(result.python), 'a venv executable must not be canonicalized into its base runtime');
});

test('private preparation rejects source aliases and authentication symlinks', async t => {
  const f = await fixture(t); await assert.rejects(prepareSupervisorProfile(f.config, f.home, { rewrite: f.rewrite }), /原 Hermes/);
  await writeFile(join(f.root, 'outside-auth.json'), '{"fixture":"outside"}'); await symlink(join(f.root, 'outside-auth.json'), join(f.home, 'auth.json'));
  await assert.rejects(prepareSupervisorProfile(f.config, f.runtime, { rewrite: f.rewrite }));
  assert.equal(await readFile(join(f.root, 'outside-auth.json'), 'utf8'), '{"fixture":"outside"}');
});

test('private YAML/dotenv rewrite pins execution and strips policy overrides without loading Hermes', async t => {
  const f = await fixture(t), python = process.env.WORKBENCH_TEST_HERMES_PYTHON;
  if (!python) { t.skip('Set WORKBENCH_TEST_HERMES_PYTHON to an installed Python with Hermes YAML and dotenv for this isolated parser test.'); return; }
  const path = join(f.root, 'config.yaml'), dotenv = join(f.root, '.env'), work = join(f.root, 'work'), skills = join(f.root, 'skills');
  await writeFile(path, 'terminal:\n  backend: ssh\n  cwd: /outside\nskills:\n  external_dirs: [/old]\nmodel: fixture\n');
  await writeFile(dotenv, 'TERMINAL_ENV="docker\\nremote"\nTERMINAL_CWD=/outside\nHOME=/outside\nHERMES_HOME=/outside\nHTTPS_PROXY=http://127.0.0.1:4318\nNO_PROXY=*\nPYTHONPATH=/outside\nNODE_OPTIONS=--inspect\nWORKBENCH_TOKEN=fixture\nFIXTURE_API_KEY="keep-fixture\\nsecond-line"\n');
  await execute(python, [join(f.config.appRoot, 'python', 'supervisor_profile.py'), path, skills, work], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  const { stdout } = await execute(python, ['-c', 'import json,sys,hermes_yaml as yaml;from dotenv import dotenv_values;print(json.dumps({"config":yaml.safe_load(open(sys.argv[1])),"env":dict(dotenv_values(sys.argv[2]))}))', path, dotenv]);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.config.terminal, { backend: 'local', cwd: work }); assert.deepEqual(result.config.skills.external_dirs, [skills]);
  assert.deepEqual(result.env, { FIXTURE_API_KEY: 'keep-fixture\nsecond-line' }); assert.equal(result.config.model, 'fixture');
});
