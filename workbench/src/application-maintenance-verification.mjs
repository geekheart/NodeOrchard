import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { sanitizeDiagnosticText } from './app-diagnostics.mjs';

export const MAINTENANCE_VERIFICATION_LIMITS = Object.freeze({ testFiles: 12, durationMs: 90000, sourceFiles: 2000, sourceBytes: 32 * 1024 * 1024, outputCharacters: 8000 });
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const fail = (message, code = 'SOURCE_VERIFICATION_INVALID', httpStatus = 400) => Object.assign(new Error(message), { code, httpStatus });
const at = () => new Date().toISOString();
const PROBES = ['writeInside', 'readOutsideDenied', 'writeOutsideDenied', 'networkDenied', 'nodeChildWorks'];

export function initializeReadOnlyVerifications(db) {
  db.exec('CREATE TABLE IF NOT EXISTS source_read_verifications (operation_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,status TEXT NOT NULL,value TEXT NOT NULL)');
  for (const row of db.prepare("SELECT operation_id,value FROM source_read_verifications WHERE status='running'").all()) {
    const record = JSON.parse(row.value);
    Object.assign(record.result, { status: 'unknown', sourceMatchesSnapshot: null, completedAt: at(), errorCode: 'SOURCE_VERIFICATION_RESTARTED' });
    db.prepare("UPDATE source_read_verifications SET status='unknown',value=? WHERE operation_id=?").run(JSON.stringify(record), row.operation_id);
  }
}

function parameters(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Reflect.ownKeys(input).some(key => !['operationId', 'files', 'expectedSnapshotHash'].includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(input)).some(field => !Object.hasOwn(field, 'value'))
    || !identifier(input.operationId) || !Array.isArray(input.files) || !input.files.length || input.files.length > 12
    || Reflect.ownKeys(input.files).length !== input.files.length + 1
    || Array.from({ length: input.files.length }, (_, i) => Object.getOwnPropertyDescriptor(input.files, String(i)))
      .some(field => !field || !Object.hasOwn(field, 'value') || typeof field.value !== 'string' || !/^workbench\/test\/[A-Za-z0-9_-]+\.test\.mjs$/.test(field.value))
    || new Set(input.files).size !== input.files.length
    || input.expectedSnapshotHash !== undefined && (typeof input.expectedSnapshotHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.expectedSnapshotHash))) {
    throw fail('只读验证需要稳定操作ID及最多12个明确相关的workbench/test/*.test.mjs文件，不接受命令或通配符。');
  }
  return { operationId: input.operationId, files: [...input.files].sort(), ...(input.expectedSnapshotHash ? { expectedSnapshotHash: input.expectedSnapshotHash } : {}) };
}

async function sourcePaths(service, context) {
  const state = await service.readGitState(service.root); await service.checkpoint(context);
  return [...new Set([...state.tracked, ...service.owned.keys()])].filter(path => {
    try { service.path(path); return true; } catch { return false; }
  }).sort();
}

async function snapshotSources(service, directory, context) {
  const sourceRoot = join(directory, 'source'), manifest = [];
  await mkdir(sourceRoot, { mode: 0o700 });
  let bytes = 0, sourceFileCount = 0;
  for (const path of await sourcePaths(service, context)) {
    const source = await service.source(path, { context, missing: true, known: false });
    bytes += Buffer.byteLength(source.content || '');
    if (manifest.length >= 2000 || bytes > MAINTENANCE_VERIFICATION_LIMITS.sourceBytes) throw fail('只读验证源码快照超过容量限制。', 'SOURCE_SNAPSHOT_LIMIT', 413);
    manifest.push({ path, hash: source.hash });
    if (source.hash === 'missing') continue;
    const target = join(sourceRoot, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await service.checkpoint(context);
    await writeFile(target, source.content, { flag: 'wx', mode: 0o400 }); await service.checkpoint(context); sourceFileCount++;
  }
  return { sourceRoot, manifest, sourceFileCount, snapshotHash: hash(JSON.stringify(manifest)) };
}

async function verifyCurrentSources(service, manifest, context) {
  if (JSON.stringify(await sourcePaths(service, context)) !== JSON.stringify(manifest.map(file => file.path))) throw fail('测试期间已登记源码清单发生变化。', 'SOURCE_TEST_STALE', 409);
  for (const file of manifest) {
    let source;
    try { source = await service.source(file.path, { context, missing: true, known: false }); }
    catch (error) {
      if (!['SOURCE_FILE_UNAVAILABLE', 'SOURCE_LINK_FORBIDDEN', 'SOURCE_TEXT_INVALID'].includes(error.code)) throw error;
      throw fail('测试期间源码身份或可读性发生变化。', 'SOURCE_TEST_STALE', 409);
    }
    if (source.hash !== file.hash) throw fail('测试期间源码发生变化，结果不代表当前版本。', 'SOURCE_TEST_STALE', 409);
  }
}

function sandboxEvidence(value) {
  const kind = value?.kind === 'macos-seatbelt' ? value.kind : 'unavailable';
  const verified = kind === 'macos-seatbelt' && value?.status === 'verified' && PROBES.every(key => value.probe?.[key] === true);
  return verified ? { kind, status: 'verified', probe: Object.fromEntries(PROBES.map(key => [key, true])) }
    : { kind, status: 'unavailable', code: typeof value?.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value.code) ? value.code : 'sandbox_unconfirmed' };
}

function outputText(value, service, directory, sourceRoot) {
  let result = sanitizeDiagnosticText(typeof value === 'string' ? value : '', { preserveLines: true });
  for (const [path, label] of [[sourceRoot, '<source-copy>'], [directory, '<test-copy>'], [service.root, '<source>'], [service.app.config.projectRoot, '<source>'], [homedir(), '<home>']]) {
    if (path) result = result.replaceAll(path, label);
  }
  return result.replace(/\/(?:Users|home)\/[^/\s]+/g, '<home>');
}

function log(service, result, context) {
  try { service.app.logger?.write(['pass', 'running'].includes(result.status) ? 'info' : 'warn', 'maintenance.verification.state', {
    component: 'maintenance', operationId: result.operationId, status: result.status, fileCount: result.files.length,
    ...(result.durationMs != null ? { durationMs: result.durationMs } : {}), ...(result.errorCode ? { code: result.errorCode } : {}),
    ...(identifier(context.turnId) ? { turnId: context.turnId } : {}), ...(identifier(context.conversationId) ? { conversationId: context.conversationId } : {}),
  }); } catch { /* Logging cannot grant execution or alter a verification result. */ }
}

export async function verifyReadOnlyTests(service, rawInput, context = {}) {
  const input = parameters(rawInput), originalAuthorize = context.authorize;
  if (context.role !== 'supervisor' || context.human || typeof originalAuthorize !== 'function') throw fail('只读源码验证需要服务端总控授权。', 'SOURCE_REPAIR_FORBIDDEN', 403);
  const authorize = async () => {
    const allowed = () => { const flags = service.app.assistantPermissionSettings?.get?.()?.supervisor; return flags?.sourceRead === true && flags?.appLogs === true; };
    if (!allowed()) throw fail('只读源码验证需要人工开启源码读取与软件日志权限。', 'SOURCE_REPAIR_FORBIDDEN', 403);
    const result = await originalAuthorize();
    if (!allowed()) throw fail('只读源码验证权限已关闭。', 'SOURCE_REPAIR_FORBIDDEN', 403);
    return result;
  };
  const guarded = { ...context, sourceAccess: 'read', authorize };
  await service.ready; await service.checkpoint(guarded);
  const digest = hash(JSON.stringify(input)), previous = service.db.prepare('SELECT * FROM source_read_verifications WHERE operation_id=?').get(input.operationId);
  if (previous) {
    if (previous.payload_hash !== digest) throw fail('同一验证操作ID不能更换测试或源码预期版本。', 'SOURCE_OPERATION_CONFLICT', 409);
    const record = JSON.parse(previous.value), result = { ...record.result, replayed: true };
    if (['pass', 'fail'].includes(result.status)) {
      try { await verifyCurrentSources(service, record.manifest, guarded); }
      catch (error) { if (error.code !== 'SOURCE_TEST_STALE') throw error; Object.assign(result, { status: 'stale', observedStatus: result.status, sourceMatchesSnapshot: false, errorCode: error.code }); }
    }
    return result;
  }
  if (context.existingOnly === true) throw fail('原验证回执不存在，未重新执行。', 'SOURCE_VERIFICATION_MISSING', 409);
  await service.idle(guarded);
  if (service.db.prepare('SELECT 1 FROM source_read_verifications WHERE operation_id=?').get(input.operationId)) return verifyReadOnlyTests(service, input, context);
  if (service.busy) throw fail('另一项源码操作仍在进行，未启动只读验证。', 'SOURCE_REPAIR_BUSY', 409);
  service.busy = true;
  const controller = new AbortController();
  guarded.signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
  guarded.deadlineAt = Math.min(context.deadlineAt || Infinity, Date.now() + MAINTENANCE_VERIFICATION_LIMITS.durationMs);
  const result = { verificationId: 'verification-' + randomUUID(), operationId: input.operationId, files: input.files, status: 'running',
    snapshotHash: null, sourceFileCount: 0, sourceMatchesSnapshot: null, sandbox: { kind: 'macos-seatbelt', status: 'checking' },
    readOnly: true, sourceModified: false, networkAllowed: false, budgetMs: MAINTENANCE_VERIFICATION_LIMITS.durationMs,
    startedAt: at(), completedAt: null, replayed: false };
  const record = { result, manifest: [] };
  const save = () => service.db.prepare('UPDATE source_read_verifications SET status=?,value=? WHERE operation_id=?').run(result.status, JSON.stringify(record), input.operationId);
  try { service.db.prepare('INSERT INTO source_read_verifications VALUES(?,?,?,?)').run(input.operationId, digest, 'running', JSON.stringify(record)); }
  catch (error) { service.busy = false; throw error; }
  log(service, result, context);
  const work = (async () => {
    let directory;
    try {
      await service.checkpoint(guarded); await service.idle(guarded);
      const base = await service.privateDirectory('read-verifications', guarded);
      directory = await mkdtemp(join(base, 'test-')); await service.checkpoint(guarded);
      for (const name of ['home', 'tmp', 'data', 'workspace', 'runs']) await mkdir(join(directory, name), { mode: 0o700 });
      const snapshot = await snapshotSources(service, directory, guarded); record.manifest = snapshot.manifest;
      Object.assign(result, { snapshotHash: snapshot.snapshotHash, sourceFileCount: snapshot.sourceFileCount }); save();
      if (input.expectedSnapshotHash && input.expectedSnapshotHash !== snapshot.snapshotHash) throw fail('源码快照与要求验证的版本不一致。', 'SOURCE_TEST_STALE', 409);
      for (const path of input.files) if (!snapshot.manifest.some(file => file.path === path && file.hash !== 'missing')) throw fail('所选测试不在已登记源码快照中。', 'SOURCE_TEST_UNAVAILABLE', 404);
      await verifyCurrentSources(service, snapshot.manifest, guarded); await service.idle(guarded);
      const env = { PATH: dirname(process.execPath) + ':/usr/bin:/bin', HOME: join(directory, 'home'), TMPDIR: join(directory, 'tmp'), LANG: 'C.UTF-8', TZ: 'UTC', CI: '1', OPENSSL_CONF: '/dev/null',
        WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace'), WORKBENCH_RUN_ROOT: join(directory, 'runs'),
        HERMES_HOME: join(directory, 'home/.hermes'), WORKBENCH_HERMES_HOME: join(directory, 'home/.hermes'), WORKBENCH_HERMES_ROOT: join(directory, 'home/unused-hermes'), HERMES_DISABLE_LAZY_INSTALLS: '1', PYTHONDONTWRITEBYTECODE: '1' };
      const observed = await (service.sandboxRunner || (options => service.runSandbox(options)))({ directory, sourceRoot: snapshot.sourceRoot, files: input.files, env, context: guarded });
      const sandbox = sandboxEvidence(observed?.sandbox); result.sandbox = sandbox;
      if (sandbox.status !== 'verified') result.status = 'unavailable';
      else if (!['pass', 'fail', 'timeout', 'unknown', 'unavailable'].includes(observed?.status)) throw fail('隔离验证没有确认有效终态。', 'SOURCE_VERIFICATION_UNKNOWN', 409);
      else result.status = observed.status;
      const stdout = outputText(observed?.stdout, service, directory, snapshot.sourceRoot), stderr = outputText(observed?.stderr, service, directory, snapshot.sourceRoot);
      Object.assign(result, { stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000), truncated: observed?.truncated === true || stdout.length > 4000 || stderr.length > 4000,
        exitCode: Number.isInteger(observed?.exitCode) ? observed.exitCode : null, durationMs: Number.isFinite(observed?.durationMs) && observed.durationMs >= 0 ? observed.durationMs : null });
      if (['pass', 'fail'].includes(result.status)) { await service.checkpoint(guarded); await verifyCurrentSources(service, snapshot.manifest, guarded); result.sourceMatchesSnapshot = true; }
      else await service.checkpoint(result.status === 'timeout' ? { ...guarded, deadlineAt: context.deadlineAt } : guarded);
    } catch (error) {
      const observedStatus = result.status;
      if (error.code === 'SOURCE_TEST_STALE') Object.assign(result, { status: 'stale', observedStatus, sourceMatchesSnapshot: false });
      else if (error.code === 'SOURCE_REPAIR_DEADLINE') Object.assign(result, { status: 'timeout', observedStatus, sourceMatchesSnapshot: null });
      else Object.assign(result, { status: guarded.signal.aborted || error.code === 'SOURCE_REPAIR_FORBIDDEN' ? 'cancelled' : 'unknown', observedStatus, sourceMatchesSnapshot: null });
      result.errorCode = /^SOURCE_[A-Z_]{1,70}$/.test(error.code || '') ? error.code : 'SOURCE_VERIFICATION_FAILED';
      if (['SOURCE_REPAIR_CANCELLED', 'SOURCE_REPAIR_FORBIDDEN', 'SOURCE_BUSINESS_BUSY'].includes(error.code)) throw error;
    } finally {
      try {
        result.completedAt = at(); save(); log(service, result, context);
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally { service.busy = false; service.active = null; }
    }
    return result;
  })();
  service.active = { controller, work }; return work;
}
