import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApplicationSourceRepairs } from '../src/application-source-repairs.mjs';

const probe = { writeInside: true, readOutsideDenied: true, writeOutsideDenied: true, networkDenied: true, nodeChildWorks: true };
const passed = { status: 'pass', exitCode: 0, stdout: 'fixture passed', stderr: '', sandbox: { kind: 'macos-seatbelt', status: 'verified', probe } };
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'maintenance-verification-'));
  const tracked = ['workbench/src/feature.mjs', 'workbench/test/feature.test.mjs'];
  await mkdir(join(root, 'workbench/src'), { recursive: true }); await mkdir(join(root, 'workbench/test'), { recursive: true });
  await writeFile(join(root, tracked[0]), 'export const value = 1;\n');
  await writeFile(join(root, tracked[1]), "import test from 'node:test'; test('fixture', () => {});\n");
  const db = new DatabaseSync(':memory:'), logs = [], flags = { sourceRead: true, appLogs: true, sourceRepair: false };
  const app = { config: { projectRoot: root, appRoot: join(root, 'workbench'), dataDir: join(root, 'workbench/.local'), workspaceRoot: join(root, 'workflow'), workflowRunRoot: join(root, 'runs') },
    store: { db, list: () => [] }, workflows: { list: () => [] }, learning: { list: () => [] },
    assistantPermissionSettings: { get: () => ({ supervisor: flags }) }, logger: { write: (...args) => logs.push(args) } };
  const readGitState = async () => ({ tracked, dirty: [] });
  const service = new ApplicationSourceRepairs(app, { readGitState, ...options });
  const context = { role: 'supervisor', turnId: 'verification-turn', conversationId: 'verification-topic', authorize: async () => flags.sourceRead && flags.appLogs };
  t.after(async () => { await service.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, db, app, service, context, flags, logs, tracked, readGitState };
}
const request = operationId => ({ operationId, files: ['workbench/test/feature.test.mjs'] });

test('read-only verification runs selected source-copy tests with sourceRepair disabled and preserves original source', async t => {
  let runs = 0, staged;
  const f = await fixture(t, { sandboxRunner: async ({ sourceRoot, env, directory, files }) => {
    runs++; staged = directory;
    assert.equal(await readFile(join(sourceRoot, 'workbench/src/feature.mjs'), 'utf8'), 'export const value = 1;\n');
    assert.equal(env.HOME, join(directory, 'home')); assert.equal(env.WORKBENCH_DATA_DIR, join(directory, 'data'));
    assert.deepEqual(files, ['workbench/test/feature.test.mjs']);
    return passed;
  } });
  const result = await f.service.verifyReadOnlyTests(request('readonly-once'), f.context);
  assert.equal(result.status, 'pass'); assert.equal(result.sourceMatchesSnapshot, true);
  assert.match(result.snapshotHash, /^sha256:[a-f0-9]{64}$/); assert.equal(result.sourceFileCount, 2);
  assert.equal(f.flags.sourceRepair, false); assert.equal(runs, 1);
  assert.equal(await readFile(join(f.root, 'workbench/src/feature.mjs'), 'utf8'), 'export const value = 1;\n');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_repair_records').get().n, 0);
  await assert.rejects(access(staged), { code: 'ENOENT' });
  const replay = await f.service.verifyReadOnlyTests(request('readonly-once'), f.context);
  assert.equal(replay.status, 'pass'); assert.equal(replay.replayed, true); assert.equal(runs, 1);
});

test('verification requires sourceRead and appLogs even when sourceRepair is enabled, but admits a read-only supervisor', async t => {
  let calls = 0;
  const f = await fixture(t, { sandboxRunner: async () => { calls++; return passed; } });
  for (const key of ['sourceRead', 'appLogs']) {
    f.flags[key] = false; f.flags.sourceRepair = true;
    await assert.rejects(f.service.verifyReadOnlyTests(request('denied-' + key), f.context), { code: 'SOURCE_REPAIR_FORBIDDEN' });
    f.flags[key] = true;
  }
  await assert.rejects(f.service.verifyReadOnlyTests(request('wrong-role'), { ...f.context, role: 'workflow' }), { code: 'SOURCE_REPAIR_FORBIDDEN' });
  assert.equal(calls, 0); f.flags.sourceRepair = false;
  assert.equal((await f.service.verifyReadOnlyTests(request('readonly-child'), { ...f.context, readOnly: true })).status, 'pass');
  assert.equal(f.flags.sourceRepair, false);
  for (const path of ['workbench/src/application-maintenance-verification.mjs', 'workbench/test/application-maintenance-verification.test.mjs']) {
    assert.throws(() => f.service.path(path, true), { code: 'SOURCE_PATH_PROTECTED' });
  }
});

test('explicit related files and immutable operation IDs reject command, path and payload changes', async t => {
  let calls = 0; const f = await fixture(t, { sandboxRunner: async () => { calls++; return passed; } });
  for (const input of [{ operationId: 'empty', files: [] }, { operationId: 'glob', files: ['workbench/test/*.test.mjs'] },
    { operationId: 'command', files: ['--test'] }, { operationId: 'parent', files: ['workbench/test/../test/feature.test.mjs'] },
    { ...request('duplicate'), files: ['workbench/test/feature.test.mjs', 'workbench/test/feature.test.mjs'] }, { ...request('shell'), command: 'touch host' }]) {
    await assert.rejects(f.service.verifyReadOnlyTests(input, f.context), { code: 'SOURCE_VERIFICATION_INVALID' });
  }
  assert.equal(calls, 0);
  await f.service.verifyReadOnlyTests(request('fixed-request'), f.context);
  await assert.rejects(f.service.verifyReadOnlyTests({ ...request('fixed-request'), expectedSnapshotHash: 'sha256:' + '0'.repeat(64) }, f.context), { code: 'SOURCE_OPERATION_CONFLICT' });
  const stale = await f.service.verifyReadOnlyTests({ ...request('wrong-snapshot'), expectedSnapshotHash: 'sha256:' + '0'.repeat(64) }, f.context);
  assert.equal(stale.status, 'stale'); assert.equal(calls, 1);
});

test('source edits or a changed registered file list prevent a current pass, including idempotent readback', async t => {
  let f, calls = 0;
  f = await fixture(t, { sandboxRunner: async () => {
    calls++; if (calls === 1) await writeFile(join(f.root, 'workbench/src/feature.mjs'), 'human edit during the fixture\n');
    return passed;
  } });
  const changed = await f.service.verifyReadOnlyTests(request('changed-during-test'), f.context);
  assert.equal(changed.status, 'stale'); assert.equal(changed.observedStatus, 'pass'); assert.equal(changed.sourceMatchesSnapshot, false);
  const stable = await f.service.verifyReadOnlyTests(request('stable-test'), f.context); assert.equal(stable.status, 'pass');
  f.tracked.push('workbench/src/new-file.mjs'); await writeFile(join(f.root, 'workbench/src/new-file.mjs'), 'export const added = true;\n');
  const readback = await f.service.verifyReadOnlyTests(request('stable-test'), f.context);
  assert.equal(readback.status, 'stale'); assert.equal(readback.replayed, true); assert.equal(calls, 2);
});

test('unavailable or unverified sandboxes never fall back to host execution and receipts redact output and host paths', async t => {
  let calls = 0, f;
  f = await fixture(t, { sandboxRunner: async () => { calls++; return { ...passed, sandbox: { kind: 'host', status: 'verified' }, stdout: 'token=FIXTURE_SECRET ' + f.root + '\n' + 'x'.repeat(9000) }; } });
  const result = await f.service.verifyReadOnlyTests(request('unconfirmed-sandbox'), f.context);
  assert.equal(result.status, 'unavailable'); assert.equal(result.sandbox.status, 'unavailable'); assert.equal(result.sourceMatchesSnapshot, null);
  assert.equal(result.truncated, true); assert.equal(calls, 1);
  assert.equal(JSON.stringify(result).includes('FIXTURE_SECRET'), false); assert.equal(JSON.stringify(result).includes(f.root), false);
  assert.equal(JSON.stringify(f.logs).includes('fixture passed'), false); assert.equal(JSON.stringify(f.logs).includes('token='), false);
  assert(result.stdout.length + result.stderr.length <= 8000);
});

test('concurrent requests, cancellation and permission revocation do not replay or leave a source operation busy', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { sandboxRunner: async ({ context }) => { started(); await gate; return { ...passed, status: context.signal.aborted ? 'unknown' : 'pass' }; } });
  const controller = new AbortController(), pending = f.service.verifyReadOnlyTests(request('cancel-once'), { ...f.context, signal: controller.signal });
  await entered;
  assert.equal((await f.service.verifyReadOnlyTests(request('cancel-once'), f.context)).status, 'running');
  controller.abort(); release(); await assert.rejects(pending, { code: 'SOURCE_REPAIR_CANCELLED' });
  assert.equal(f.service.busy, false);
  assert.equal((await f.service.verifyReadOnlyTests(request('cancel-once'), f.context)).status, 'cancelled');
  f.service.sandboxRunner = async () => { f.flags.appLogs = false; return passed; };
  await assert.rejects(f.service.verifyReadOnlyTests(request('revoked'), f.context), { code: 'SOURCE_REPAIR_FORBIDDEN' });
  assert.equal(f.service.busy, false); assert.equal(f.db.prepare('SELECT status FROM source_read_verifications WHERE operation_id=?').get('revoked').status, 'cancelled');
});

test('a restarted pending verification stays unknown and cannot start another test', async t => {
  let calls = 0;
  const f = await fixture(t, { sandboxRunner: async () => { calls++; return passed; } });
  const complete = await f.service.verifyReadOnlyTests(request('restart-once'), f.context);
  const row = f.db.prepare('SELECT value FROM source_read_verifications WHERE operation_id=?').get('restart-once'), record = JSON.parse(row.value);
  record.result.status = 'running'; f.db.prepare('UPDATE source_read_verifications SET status=?,value=? WHERE operation_id=?').run('running', JSON.stringify(record), 'restart-once');
  await f.service.close();
  const restarted = new ApplicationSourceRepairs(f.app, { readGitState: f.readGitState, sandboxRunner: async () => { assert.fail('unknown operation must not replay'); } });
  try {
    const result = await restarted.verifyReadOnlyTests(request('restart-once'), f.context);
    assert.equal(result.status, 'unknown'); assert.equal(result.verificationId, complete.verificationId); assert.equal(calls, 1);
  } finally { await restarted.close(); }
});

test('existingOnly refuses a missing receipt without reserving or starting a new verification', async t => {
  let calls = 0;
  const f = await fixture(t, { sandboxRunner: async () => { calls++; return passed; } });
  const input = request('missing-original-receipt');
  await assert.rejects(f.service.verifyReadOnlyTests(input, { ...f.context, existingOnly: true }), { code: 'SOURCE_VERIFICATION_MISSING', httpStatus: 409 });
  assert.equal(calls, 0); assert.equal(f.service.busy, false);
  const result = await f.service.verifyReadOnlyTests(input, f.context);
  assert.equal(result.status, 'pass'); assert.equal(result.replayed, false); assert.equal(calls, 1);
  const readback = await f.service.verifyReadOnlyTests(input, { ...f.context, existingOnly: true });
  assert.equal(readback.status, 'pass'); assert.equal(readback.replayed, true); assert.equal(calls, 1);
});

test('business activity blocks admission without reserving an operation ID, and a simultaneous same-ID request starts once', async t => {
  let calls = 0;
  const f = await fixture(t, { sandboxRunner: async () => { calls++; return passed; } });
  f.app.workflows.list = () => [{ status: 'running', nodes: {} }];
  await assert.rejects(f.service.verifyReadOnlyTests(request('business-idle'), f.context), { code: 'SOURCE_BUSINESS_BUSY' });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_read_verifications').get().n, 0);
  assert.equal(calls, 0); f.app.workflows.list = () => [];
  const results = await Promise.all([f.service.verifyReadOnlyTests(request('business-idle'), f.context), f.service.verifyReadOnlyTests(request('business-idle'), f.context)]);
  assert.equal(calls, 1); assert(results.every(result => ['running', 'pass'].includes(result.status)));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM source_read_verifications').get().n, 1);
});

test('real Seatbelt confines source-copy tests or reports unavailable without a host fallback', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'outside-private.txt'); await writeFile(outside, 'HOST_FIXTURE_MUST_NOT_BE_READ');
  await writeFile(join(f.root, 'workbench/test/feature.test.mjs'), `import test from 'node:test'; import assert from 'node:assert/strict'; import { readFile, writeFile } from 'node:fs/promises';
    test('outside access denied', async () => { await assert.rejects(readFile(${JSON.stringify(outside)}), e => ['EACCES','EPERM'].includes(e.code)); await assert.rejects(writeFile(${JSON.stringify(outside)}, 'overwritten'), e => ['EACCES','EPERM'].includes(e.code)); });`);
  const result = await f.service.verifyReadOnlyTests(request('real-seatbelt'), f.context);
  t.diagnostic('Seatbelt verification status: ' + result.status + ', sandbox: ' + result.sandbox.status);
  if (process.env.WORKBENCH_REQUIRE_SEATBELT === '1') assert.equal(result.status, 'pass');
  else assert(['pass', 'unavailable'].includes(result.status));
  if (result.status === 'pass') { assert.equal(result.sourceMatchesSnapshot, true); assert.deepEqual(result.sandbox.probe, probe); }
  assert.equal(await readFile(outside, 'utf8'), 'HOST_FIXTURE_MUST_NOT_BE_READ');
});
