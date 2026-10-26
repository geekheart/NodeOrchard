import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkGitBoundary, pathBoundaryViolation } from '../scripts/check-git-boundary.mjs';

const script = fileURLToPath(new URL('../scripts/check-git-boundary.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'git-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const write = async (path, content = 'private fixture content') => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  const git = (...args) => execFileSync('git', ['-C', root, ...args]);
  return { root, write, git };
}

test('private runtime, hardware cases, learned Skills and credentials have precise path boundaries', () => {
  for (const path of [
    'workflow/input.txt', 'workbench/workflow/skills/name/SKILL.md', 'workbench/workspaces/input.txt',
    'workbench/.local/state.json', 'nested/.workbench-skills/run/SKILL.md', 'workflow-snapshots/run/skill.json',
    'nested/.workbench-learning-memory/MEMORY.md', 'design/private-image.png', 'multica/.git/config',
    'workbench/hdk/learning/result.json', 'workbench/hdk/guide-profile-case.json',
    'workbench/skills/labels.json',
    'workbench/docs/refactor-evidence/audit.json', 'workbench/docs/run.png', 'workbench/docs/verification.md',
    'learned-SKILL.md', 'skill-learning.diff', 'workbench/skills/candidates/candidate/SKILL.md',
    '.env', 'workbench/.env.local', 'state.sqlite-wal', 'state.db', 'auth.json', 'credentials.yaml',
    'id_ed25519', 'local.key', 'board.epro2', 'export.oim.json',
  ]) assert.ok(pathBoundaryViolation(path), path);
  for (const path of [
    'workbench/shared/workflow/workflow-model.mjs', 'workbench/examples/demo.workflow.json',
    'workbench/skills/board-pinout/SKILL.md', 'workbench/skills/hdk-test-firmware/assets/main/main.c',
    'workbench/hdk/resources/catalog.json', 'workbench/hdk/runtime.py',
    'workbench/hdk/learning/input.schema.json',
    'workbench/hdk/learning/README.md',
    'workbench/test/workflow-snapshots.test.mjs', '.env.example', 'workbench/.env.template',
    'README.md', 'AGENTS.md', 'workbench/docs/architecture.md',
  ]) assert.equal(pathBoundaryViolation(path), null, path);
});

test('ignored private data is not read, while force-staged data is blocked without changing the index', async t => {
  const f = await fixture(t);
  await f.write('.gitignore', '/workflow/\n/workbench/.local/\n');
  await f.write('workflow/input.txt'); await f.write('workbench/.local/state.json');
  await f.write('workbench/shared/workflow/model.mjs', 'export const schema = 1;');
  await f.write('workbench/examples/demo.workflow.json', '{}');
  await f.write('workbench/skills/example/SKILL.md', '# Seed skill');
  let result = await checkGitBoundary({ repo: f.root });
  assert.equal(result.candidateCount, 4); assert.deepEqual(result.violations, []);
  f.git('add', '--force', 'workflow/input.txt', 'workbench/.local/state.json');
  const before = await readFile(join(f.root, '.git/index'));
  result = await checkGitBoundary({ repo: f.root });
  assert.deepEqual(result.violations.map(value => value.path), ['workbench/.local/state.json', 'workflow/input.txt']);
  assert.deepEqual(await readFile(join(f.root, '.git/index')), before);
});

test('unignored learning exports and verification artifacts are rejected before they can be added', async t => {
  const f = await fixture(t);
  for (const path of ['workbench/hdk/learning/result.json', 'workbench/hdk/guide-input-case.json',
    'workbench/docs/refactor-evidence/run.json', 'workbench/docs/run.png', 'workbench/.env.production']) await f.write(path);
  const result = await checkGitBoundary({ repo: f.root });
  assert.equal(result.violations.length, 5);
  assert.ok(result.violations.every(value => value.rule !== null));
});

test('symlinks cannot publish an alias into private data, outside the repository or an old staged link', async t => {
  const f = await fixture(t);
  await f.write('.gitignore', '/workflow/\n'); await f.write('workflow/private.txt'); await f.write('README.md', '# Public');
  await symlink('workflow/private.txt', join(f.root, 'private-alias'));
  await symlink('../outside-private.txt', join(f.root, 'outside-alias'));
  await symlink('README.md', join(f.root, 'public-alias'));
  f.git('add', 'private-alias');
  await rm(join(f.root, 'private-alias')); await symlink('README.md', join(f.root, 'private-alias'));
  const result = await checkGitBoundary({ repo: f.root });
  assert.deepEqual(result.violations.map(value => value.path), ['outside-alias', 'private-alias']);
  assert.equal(result.violations.find(value => value.path === 'private-alias').rule, 'private-symlink-target');
});

test('CLI reports filenames and rules without sensitive content; personal path scanning is opt-in', async t => {
  const f = await fixture(t);
  const sensitive = 'not-a-real-token-should-never-print';
  await f.write('credentials.json', sensitive);
  let run = spawnSync(process.execPath, [script, '--repo', f.root], { encoding: 'utf8' });
  assert.equal(run.status, 1); assert.match(run.stderr, /credentials\.json.*credential-file/);
  assert.ok(!run.stderr.includes(sensitive)); assert.ok(!run.stdout.includes(sensitive));
  await rm(join(f.root, 'credentials.json'));
  const personal = '/' + ['Users', 'private-person', 'Documents', 'input.json'].join('/');
  await f.write('source.mjs', 'export const input = ' + JSON.stringify(personal));
  run = spawnSync(process.execPath, [script, '--repo', f.root], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  run = spawnSync(process.execPath, [script, '--repo', f.root, '--personal-paths'], { encoding: 'utf8' });
  assert.equal(run.status, 1); assert.match(run.stderr, /source\.mjs.*personal-home-literal/);
  assert.ok(!run.stderr.includes(personal));
  f.git('add', 'source.mjs');
  await f.write('source.mjs', 'export const input = null;');
  run = spawnSync(process.execPath, [script, '--repo', f.root, '--personal-paths'], { encoding: 'utf8' });
  assert.equal(run.status, 1, 'staged personal paths cannot be concealed by changing the worktree');
  assert.match(run.stderr, /source\.mjs.*personal-home-literal/);
  assert.ok(!run.stderr.includes(personal));
});
