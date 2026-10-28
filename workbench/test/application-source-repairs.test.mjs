import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ApplicationSourceRepairs } from '../src/application-source-repairs.mjs';

const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'source-repair-service-'));
  await mkdir(join(root, 'workbench/src'), { recursive: true }); await mkdir(join(root, 'workbench/test'), { recursive: true });
  await writeFile(join(root, 'workbench/src/feature.mjs'), 'export const value = 1;\n');
  await writeFile(join(root, 'workbench/test/feature.test.mjs'), "import test from 'node:test'; test('fixture', () => {});\n");
  const db = new DatabaseSync(':memory:'), logs = []; let enabled = true, sourceRead = false;
  const app = { config: { projectRoot: root, appRoot: join(root, 'workbench'), dataDir: join(root, 'workbench/.local'), workspaceRoot: join(root, 'workflow'), workflowRunRoot: join(root, 'runs') }, store: { db, list: () => [] },
    workflows: { list: () => [] }, learning: { list: () => [] }, assistantPermissionSettings: { get: () => ({ supervisor: { sourceRepair: enabled, sourceRead } }) }, logger: { write: (...args) => logs.push(args) } };
  const service = new ApplicationSourceRepairs(app, { readGitState: async () => ({ tracked: ['workbench/src/feature.mjs', 'workbench/test/feature.test.mjs'], dirty: [] }), ...options });
  const context = { role: 'supervisor', turnId: 'fixture-turn', conversationId: 'fixture-topic', authorize: async () => { if (!enabled) throw Object.assign(Error('disabled'), { httpStatus: 403 }); return true; } };
  t.after(async () => { await service.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, app, service, context, logs, setEnabled: value => { enabled = value; }, setSourceRead: value => { sourceRead = value; } };
}

test('source read/list are bounded and patch uses the observed hash with an immutable operation receipt', async t => {
  const { root, service, context } = await fixture(t);
  const source = await service.read({ path: 'workbench/src/feature.mjs', startLine: 1, lineCount: 1 });
  assert.equal(source.hash, hash('export const value = 1;\n')); assert.equal(source.content, 'export const value = 1;');
  assert.equal((await service.list({ prefix: 'workbench/src', limit: 5 })).files[0].path, 'workbench/src/feature.mjs');
  const payload = { operationId: 'patch-one', summary: 'Correct the fixture value', changes: [{ path: source.path, expectedHash: source.hash, edits: [{ oldText: 'value = 1', newText: 'value = 2' }] }] };
  const repair = await service.patch(payload, context);
  assert.equal(repair.status, 'applied'); assert.equal(repair.files[0].afterHash, hash('export const value = 2;\n'));
  assert.equal(await readFile(join(root, source.path), 'utf8'), 'export const value = 2;\n');
  assert.equal((await service.patch(payload, context)).id, repair.id);
  await assert.rejects(service.patch({ ...payload, summary: 'A different operation' }, context), /操作|幂等/);
  assert.equal((await service.history({ limit: 5 })).repairs.length, 1);
});

test('a source-read-only supervisor can inspect registered source but cannot convert that access into a repair', async t => {
  const f = await fixture(t); f.setEnabled(false); f.setSourceRead(true);
  const context = { role: 'supervisor', authorize: async () => true, sourceAccess: 'read', allowSourceWrite: false, deadlineAt: null };
  const source = await f.service.read({ path: 'workbench/src/feature.mjs' }, context);
  assert.equal(source.content, 'export const value = 1;\n');
  const list = await f.service.list({ prefix: 'workbench/src' }, context);
  assert.equal(list.files.length, 1); assert.equal(list.files[0].writable, false);
  await assert.rejects(f.service.read({ path: 'workbench/.local/private.json' }, context), { code: 'SOURCE_FILE_UNTRACKED' });
  await assert.rejects(f.service.read({ path: 'workbench/src/feature.mjs' }, { ...context, role: 'workflow' }), { code: 'SOURCE_REPAIR_FORBIDDEN' });
  await assert.rejects(f.service.patch({ operationId: 'read-cannot-patch', summary: 'Forbidden', changes: [{ path: source.path, expectedHash: source.hash, content: 'changed' }] }, context), { code: 'SOURCE_REPAIR_FORBIDDEN' });
  assert.equal(await readFile(join(f.root, source.path), 'utf8'), 'export const value = 1;\n');
  f.setSourceRead(false);
  await assert.rejects(f.service.read({ path: source.path }, context), { code: 'SOURCE_REPAIR_FORBIDDEN' });
  assert.equal((await f.service.history()).repairs.length, 0);
});

test('source-read revocation during a file check rejects the read without returning content', async t => {
  const f = await fixture(t); f.setEnabled(false); f.setSourceRead(true);
  let checks = 0;
  const context = { role: 'supervisor', authorize: async () => { if (++checks === 3) f.setSourceRead(false); return true; } };
  await assert.rejects(f.service.read({ path: 'workbench/src/feature.mjs' }, context), { code: 'SOURCE_REPAIR_FORBIDDEN' });
  assert.equal(checks, 3);
  assert.equal(await readFile(join(f.root, 'workbench/src/feature.mjs'), 'utf8'), 'export const value = 1;\n');
});

test('model experiment admission source remains readable but cannot be patched to raise its quota', async t => {
  const path = 'workbench/src/assistant-model-experiment.mjs', content = 'export const maxCallsPerTurn = 1;\n';
  const { root, service, context } = await fixture(t, { readGitState: async () => ({ tracked: [path], dirty: [] }) });
  await writeFile(join(root, path), content);
  const source = await service.read({ path }, context);
  assert.equal(source.content, content);
  assert.equal((await service.list({ prefix: 'workbench/src' }, { ...context, allowSourceWrite: true })).files[0].writable, false);
  await assert.rejects(service.patch({ operationId: 'raise-experiment-quota', summary: 'Raise model experiment quota',
    changes: [{ path, expectedHash: source.hash, content: 'export const maxCallsPerTurn = 100;\n' }] }, context), { code: 'SOURCE_PATH_PROTECTED', httpStatus: 403 });
  assert.equal(await readFile(join(root, path), 'utf8'), content);
  const record = (await service.history()).repairs[0];
  assert.equal(record.status, 'error'); assert.equal(record.error.code, 'SOURCE_PATH_PROTECTED'); assert.deepEqual(record.files, []);
});

test('rollback refuses later edits without changing the applied receipt, and human rollback works with AI permission off', async t => {
  const { root, service, context, setEnabled } = await fixture(t);
  const repair = await service.patch({ operationId: 'patch-rollback', summary: 'Fixture change', changes: [{ path: 'workbench/src/feature.mjs', expectedHash: hash('export const value = 1;\n'), content: 'export const value = 2;\n' }] }, context);
  assert.equal(repair.backupAvailable, true);
  await writeFile(join(root, 'workbench/src/feature.mjs'), 'human edit\n');
  await assert.rejects(service.rollback({ operationId: 'rollback-conflict', repairId: repair.id }, context), { code: 'SOURCE_ROLLBACK_CONFLICT' });
  assert.equal((await service.history()).repairs[0].status, 'applied');
  assert.equal(await readFile(join(root, 'workbench/src/feature.mjs'), 'utf8'), 'human edit\n');
  await writeFile(join(root, 'workbench/src/feature.mjs'), 'export const value = 2;\n'); setEnabled(false);
  await assert.rejects(service.rollback({ operationId: 'rollback-ai-disabled', repairId: repair.id }, context), { code: 'SOURCE_REPAIR_FORBIDDEN' });
  const human = { role: 'human', human: true, authorize: async () => true };
  assert.equal((await service.rollback({ operationId: 'rollback-human', repairId: repair.id }, human)).status, 'rolled_back');
  assert.equal(await readFile(join(root, 'workbench/src/feature.mjs'), 'utf8'), 'export const value = 1;\n');
});

test('scope, gate files, startup dirty files, symlinks and hardlinks cannot be modified', async t => {
  const { root, service, context } = await fixture(t, { readGitState: async () => ({ tracked: ['workbench/src/feature.mjs'], dirty: ['workbench/src/feature.mjs'] }) });
  for (const path of ['../outside.mjs', 'workbench/.local/record.json', 'workflow/input.json', 'workbench/src/server.mjs', 'workbench/src/application-source-tools.mjs', 'workbench/public/source-repair-ui.js', 'workbench/src/assistant-diagnostic-turn.mjs']) {
    await assert.rejects(service.patch({ operationId: 'forbidden-' + Math.random().toString(36).slice(2), summary: 'Forbidden', changes: [{ path, expectedHash: 'missing', content: 'changed\n' }] }, context), error => /^SOURCE_PATH_/.test(error.code));
  }
  await assert.rejects(service.patch({ operationId: 'dirty', summary: 'Dirty', changes: [{ path: 'workbench/src/feature.mjs', expectedHash: hash('export const value = 1;\n'), content: 'changed\n' }] }, context), { code: 'SOURCE_FILE_DIRTY' });
  await symlink(join(root, 'workbench/src/feature.mjs'), join(root, 'workbench/src/symlink.mjs'));
  await link(join(root, 'workbench/src/feature.mjs'), join(root, 'workbench/src/hardlink.mjs'));
  for (const path of ['workbench/src/symlink.mjs', 'workbench/src/hardlink.mjs']) await assert.rejects(service.patch({ operationId: path.split('/').at(-1).replace('.', '-'), summary: 'Link', changes: [{ path, expectedHash: hash('export const value = 1;\n'), content: 'changed\n' }] }, context), { code: 'SOURCE_LINK_FORBIDDEN' });
});

test('revocation after one source write stops the remaining files and preserves a human-recoverable partial receipt', async t => {
  const { root, service, context, setEnabled } = await fixture(t);
  const input = { operationId: 'revoke-between-files', summary: 'Two file change', changes: [
    { path: 'workbench/src/feature.mjs', expectedHash: hash('export const value = 1;\n'), content: 'export const value = 2;\n' },
    { path: 'workbench/src/new.mjs', expectedHash: 'missing', content: 'export const added = true;\n' },
  ] };
  const guarded = { ...context, authorize: async () => { if ((await readFile(join(root, 'workbench/src/feature.mjs'), 'utf8')).includes('value = 2')) setEnabled(false); return true; } };
  await assert.rejects(service.patch(input, guarded), { code: 'SOURCE_REPAIR_FORBIDDEN' });
  const record = (await service.history()).repairs[0]; assert.equal(record.status, 'partial'); assert.equal(record.backupAvailable, true);
  await assert.rejects(readFile(join(root, 'workbench/src/new.mjs')), { code: 'ENOENT' });
  await service.rollback({ operationId: 'recover-partial', repairId: record.id }, { role: 'human', human: true, authorize: async () => true });
  assert.equal(await readFile(join(root, 'workbench/src/feature.mjs'), 'utf8'), 'export const value = 1;\n');
});

test('related tests fail closed without an OS sandbox and reject stale repairs or active business work', async t => {
  let runnerCalls = 0;
  const { root, app, service, context } = await fixture(t, { sandboxRunner: async () => { runnerCalls++; return { status: 'unavailable', sandbox: { status: 'unavailable', kind: 'fixture', code: 'no_sandbox' } }; } });
  const repair = await service.patch({ operationId: 'test-patch', summary: 'Fixture test change', changes: [{ path: 'workbench/src/feature.mjs', expectedHash: hash('export const value = 1;\n'), content: 'export const value = 2;\n' }] }, context);
  for (const files of [[], ['workbench/test/*.test.mjs'], ['--test'], ['workbench/src/feature.mjs'], ['workbench/test/../test/feature.test.mjs']]) await assert.rejects(service.test({ operationId: 'bad-test-' + Math.random().toString(36).slice(2), repairId: repair.id, files }, context), /测试/);
  const result = await service.test({ operationId: 'no-sandbox', repairId: repair.id, files: ['workbench/test/feature.test.mjs'] }, context);
  assert.equal(result.status, 'unavailable'); assert.equal(runnerCalls, 1);
  assert.equal(result.sourceHashes[0].hash, hash('export const value = 2;\n'));
  assert.equal((await service.history()).repairs[0].tests[0].status, 'unavailable');
  await writeFile(join(root, 'workbench/src/feature.mjs'), 'later edit\n');
  await assert.rejects(service.test({ operationId: 'stale-test', repairId: repair.id, files: ['workbench/test/feature.test.mjs'] }, context), { code: 'SOURCE_HASH_CONFLICT' });
  assert.equal(runnerCalls, 1);
  await writeFile(join(root, 'workbench/src/feature.mjs'), 'export const value = 2;\n'); app.workflows.list = () => [{ status: 'running', nodes: {} }];
  await assert.rejects(service.test({ operationId: 'busy-business-test', repairId: repair.id, files: ['workbench/test/feature.test.mjs'] }, context), { code: 'SOURCE_BUSINESS_BUSY' });
  assert.equal(runnerCalls, 1);
});

test('test results use a private clean environment and become unknown when the bound source changes during execution', async t => {
  let hostRoot;
  const { root, service, context } = await fixture(t, { sandboxRunner: async ({ directory, env, sourceRoot }) => {
    assert.equal(env.HOME, join(directory, 'home')); assert.equal(env.WORKBENCH_DATA_DIR, join(directory, 'data'));
    assert.equal(env.OPENSSL_CONF, '/dev/null'); assert.equal(Object.hasOwn(env, 'SOURCE_REPAIR_FIXTURE_SECRET'), false);
    assert.equal(await readFile(join(sourceRoot, 'workbench/src/feature.mjs'), 'utf8'), 'export const value = 2;\n');
    await writeFile(join(hostRoot, 'workbench/src/feature.mjs'), 'concurrent user edit\n');
    return { status: 'pass', exitCode: 0, stdout: 'fixture pass', sandbox: { status: 'verified', kind: 'fixture' } };
  } }); hostRoot = root;
  const repair = await service.patch({ operationId: 'stale-during-test-patch', summary: 'Fixture', changes: [{ path: 'workbench/src/feature.mjs', expectedHash: hash('export const value = 1;\n'), content: 'export const value = 2;\n' }] }, context);
  const previous = process.env.SOURCE_REPAIR_FIXTURE_SECRET; process.env.SOURCE_REPAIR_FIXTURE_SECRET = 'never-forward-this-fixture-value';
  try { await assert.rejects(service.test({ operationId: 'stale-during-test', repairId: repair.id, files: ['workbench/test/feature.test.mjs'] }, context), { code: 'SOURCE_TEST_STALE' }); }
  finally { if (previous === undefined) delete process.env.SOURCE_REPAIR_FIXTURE_SECRET; else process.env.SOURCE_REPAIR_FIXTURE_SECRET = previous; }
  assert.equal((await service.history()).repairs[0].tests[0].status, 'unknown');
});

test('observed deadline timeouts retain a timeout result instead of silently converting to an unknown success', async t => {
  const { service, context } = await fixture(t, { sandboxRunner: async ({ context: running }) => {
    running.deadlineAt = Date.now() - 1;
    return { status: 'timeout', exitCode: null, stdout: '', stderr: '', sandbox: { status: 'verified', kind: 'fixture' } };
  } });
  const repair = await service.patch({ operationId: 'timeout-patch', summary: 'Fixture', changes: [{ path: 'workbench/src/feature.mjs', expectedHash: hash('export const value = 1;\n'), content: 'export const value = 2;\n' }] }, context);
  const result = await service.test({ operationId: 'timeout-test', repairId: repair.id, files: ['workbench/test/feature.test.mjs'] }, context);
  assert.equal(result.status, 'timeout'); assert.equal((await service.history()).repairs[0].tests[0].status, 'timeout');
});

test('private backup links cannot expose other files through history or rollback', async t => {
  const { root, service, context } = await fixture(t);
  const repair = await service.patch({ operationId: 'backup-patch', summary: 'Fixture', changes: [{ path: 'workbench/src/feature.mjs', expectedHash: hash('export const value = 1;\n'), content: 'export const value = 2;\n' }] }, context);
  const privateFile = join(root, 'private-fixture.txt'); await writeFile(privateFile, 'PRIVATE_FIXTURE_MUST_NOT_LEAK');
  const backup = join(root, 'workbench/.local/source-repairs', repair.id, '0.before'); await rm(backup); await symlink(privateFile, backup);
  const history = await service.history({ repairId: repair.id, includeDiff: true });
  assert.equal(JSON.stringify(history).includes('PRIVATE_FIXTURE_MUST_NOT_LEAK'), false);
  assert.equal(history.repairs[0].backupAvailable, false);
  await assert.rejects(service.rollback({ operationId: 'linked-backup-rollback', repairId: repair.id }, context), { code: 'SOURCE_BACKUP_INVALID' });
});

test('verified and failed tests are version-bound, repeatable, idempotent and remove only their staging copy', async t => {
  let calls = 0, staging;
  const { service, context } = await fixture(t, { sandboxRunner: async ({ directory }) => { staging = directory; return { status: ++calls === 2 ? 'fail' : 'pass', exitCode: calls === 2 ? 1 : 0, sandbox: { status: 'verified', kind: 'fixture' } }; } });
  const repair = await service.patch({ operationId: 'verify-patch', summary: 'Fixture', changes: [{ path: 'workbench/src/feature.mjs', expectedHash: hash('export const value = 1;\n'), content: 'export const value = 2;\n' }] }, context);
  const input = { operationId: 'verify-test', repairId: repair.id, files: ['workbench/test/feature.test.mjs'] };
  assert.equal((await service.test(input, context)).status, 'pass'); assert.equal((await service.history()).repairs[0].status, 'verified');
  await assert.rejects(readFile(join(staging, 'source/workbench/src/feature.mjs')), { code: 'ENOENT' });
  assert.equal((await service.test(input, context)).status, 'pass'); assert.equal(calls, 1);
  assert.equal((await service.test({ ...input, operationId: 'verify-test-failed' }, context)).status, 'fail'); assert.equal((await service.history()).repairs[0].status, 'test_failed');
  assert.equal((await service.test({ ...input, operationId: 'verify-test-again' }, context)).status, 'pass'); assert.equal((await service.history()).repairs[0].status, 'verified');
});

test('restart restores owned verified files while fresh human edits remain protected even after AI reads their new hash', async t => {
  let dirty = [];
  const readGitState = async () => ({ tracked: ['workbench/src/feature.mjs', 'workbench/test/feature.test.mjs'], dirty });
  const { root, app, service, context } = await fixture(t, { readGitState, sandboxRunner: async () => ({ status: 'pass', sandbox: { status: 'verified', kind: 'fixture' } }) });
  const repair = await service.patch({ operationId: 'restart-patch', summary: 'Fixture', changes: [{ path: 'workbench/src/feature.mjs', expectedHash: hash('export const value = 1;\n'), content: 'export const value = 2;\n' }] }, context);
  await service.test({ operationId: 'restart-verified', repairId: repair.id, files: ['workbench/test/feature.test.mjs'] }, context);
  await service.close(); dirty = ['workbench/src/feature.mjs'];
  const restarted = new ApplicationSourceRepairs(app, { readGitState });
  try {
    const observed = await restarted.read({ path: 'workbench/src/feature.mjs' });
    await restarted.patch({ operationId: 'restart-owned', summary: 'Owned continuation', changes: [{ path: observed.path, expectedHash: observed.hash, content: 'export const value = 3;\n' }] }, context);
    await writeFile(join(root, observed.path), 'human edit after restart\n');
    const humanSource = await restarted.read({ path: observed.path });
    await assert.rejects(restarted.patch({ operationId: 'overwrite-new-human', summary: 'Must be rejected', changes: [{ path: observed.path, expectedHash: humanSource.hash, content: 'overwrite\n' }] }, context), { code: 'SOURCE_FILE_DIRTY' });
    assert.equal((await restarted.list({ prefix: 'workbench/src' })).files[0].writable, false);
    assert.equal(await readFile(join(root, observed.path), 'utf8'), 'human edit after restart\n');
  } finally { await restarted.close(); }
});

test('created and deleted files both roll back and logs contain metadata instead of source bodies', async t => {
  const { root, service, context, logs } = await fixture(t);
  const repair = await service.patch({ operationId: 'create-delete', summary: 'Swap fixture files', changes: [
    { path: 'workbench/src/feature.mjs', expectedHash: hash('export const value = 1;\n'), remove: true },
    { path: 'workbench/src/replacement.mjs', expectedHash: 'missing', content: 'export const replacement = true;\n' },
  ] }, context);
  await service.rollback({ operationId: 'restore-swap', repairId: repair.id }, context);
  assert.equal(await readFile(join(root, 'workbench/src/feature.mjs'), 'utf8'), 'export const value = 1;\n');
  await assert.rejects(readFile(join(root, 'workbench/src/replacement.mjs')), { code: 'ENOENT' });
  assert.equal(JSON.stringify(logs).includes('export const'), false);
});

test('older active runs and learning batches outside the 20-row history block only the repair test, while pure human waits remain allowed', async t => {
  let calls = 0;
  const { app, service, context } = await fixture(t, { sandboxRunner: async () => { calls++; return { status: 'unavailable', sandbox: { status: 'unavailable', kind: 'fixture' } }; } });
  const repair = await service.patch({ operationId: 'old-active-patch', summary: 'Fixture', changes: [{ path: 'workbench/src/feature.mjs', expectedHash: hash('export const value = 1;\n'), content: 'export const value = 2;\n' }] }, context);
  app.workflows.list = () => Array.from({ length: 20 }, (_, index) => ({ id: 'recent-' + index, status: 'complete', nodes: {} }));
  const older = { run: { id: 'older-running', status: 'running', nodes: {} } }; app.workflows.active = new Map([['older-running', older]]);
  const request = operationId => ({ operationId, repairId: repair.id, files: ['workbench/test/feature.test.mjs'] });
  await assert.rejects(service.test(request('old-legacy-active'), context), { code: 'SOURCE_BUSINESS_BUSY' });
  assert.equal(older.run.status, 'running'); assert.equal(calls, 0); app.workflows.active.clear();
  const waiting = { run: { id: 'older-human', status: 'waiting_review', nodes: { human: { status: 'waiting_review' } } } }; app.workflows.dag = { active: new Map([['older-human', waiting]]) };
  assert.equal((await service.test(request('pure-human-allowed'), context)).status, 'unavailable'); assert.equal(calls, 1);
  waiting.run.nodes.business = { status: 'running' };
  await assert.rejects(service.test(request('old-dag-active'), context), { code: 'SOURCE_BUSINESS_BUSY' }); delete waiting.run.nodes.business;
  const learning = { job: { id: 'older-learning', status: 'running' } }; app.learning.active = new Map([['older-learning', learning]]);
  await assert.rejects(service.test(request('old-learning-active'), context), { code: 'SOURCE_BUSINESS_BUSY' });
  assert.equal(learning.job.status, 'running'); assert.equal(calls, 1);
});
