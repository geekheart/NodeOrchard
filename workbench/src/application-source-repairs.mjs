import { constants } from 'node:fs';
import { lstat, realpath, mkdir, open, writeFile, rename, unlink, readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, relative, dirname, join, sep, isAbsolute, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { sanitizeDiagnosticText } from './app-diagnostics.mjs';

const execute = promisify(execFile);
const MAX_FILE = 256 * 1024, MAX_PATCH = 1024 * 1024, MAX_OUTPUT = 32768, MAX_SOURCE_PAGE = 1800;
const SOURCE = /^workbench\/(?:src|public|shared|python|test|assistant-skills|docs)\//;
const ROOT_FILES = new Set(['README.md', 'CONTEXT.md', 'AGENTS.md', 'workbench/README.md', 'workbench/package.json']);
const EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.md', '.css', '.html', '.json', '.txt', '.yaml', '.yml']);
const PROTECTED = new Set([
  'agents.md', 'context.md', 'workbench/package.json', 'workbench/package-lock.json',
  ...['application.mjs', 'server.mjs', 'main.mjs', 'store.mjs', 'config.mjs', 'assistant-permission-settings.mjs', 'application-assistant-permissions.mjs',
    'application-assistant.mjs', 'assistant-diagnostic-turn.mjs', 'assistant-model-experiment.mjs', 'application-source-tools.mjs', 'application-source-repairs.mjs'].map(name => 'workbench/src/' + name),
  ...['assistant-permissions-ui.js', 'source-repair-ui.js', 'app.js'].map(name => 'workbench/public/' + name),
  ...['application-source-repairs.test.mjs', 'application-source-tools.test.mjs', 'source-repair-ui.test.mjs', 'assistant-permission-settings.test.mjs',
    'application-assistant-permissions.test.mjs', 'assistant-permissions-ui.test.mjs'].map(name => 'workbench/test/' + name),
]);
const own = (value, key) => Object.hasOwn(value, key);
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fail = (message, code = 'SOURCE_REPAIR_INVALID', httpStatus = 400) => Object.assign(new Error(message), { code, httpStatus });
const inside = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep); };
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const timestamp = () => new Date().toISOString();
async function canonicalDirectory(path) {
  const absolute = resolve(path);
  try { return await realpath(absolute); } catch (error) { if (error.code !== 'ENOENT' || dirname(absolute) === absolute) throw error; return join(await canonicalDirectory(dirname(absolute)), relative(dirname(absolute), absolute)); }
}
const sensitive = value => /\bsk-[A-Za-z0-9_-]{20,}\b|\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i.test(value);
function clean(value, limit = MAX_OUTPUT) {
  return String(value ?? '').replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED]').slice(0, limit);
}
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => !keys.includes(key)) || Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !own(item, 'value'))) throw fail('源码操作字段无效。');
}
async function gitState(root) {
  const options = { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } };
  try {
    const tracked = (await execute('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'ls-files', '-z', '--cached'], options)).stdout.split('\0').filter(Boolean);
    const rows = (await execute('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], options)).stdout.split('\0');
    const dirty = [];
    for (let index = 0; index < rows.length; index++) if (rows[index]) { const row = rows[index]; dirty.push(row.slice(3)); if (/[RC]/.test(row.slice(0, 2)) && rows[index + 1]) dirty.push(rows[++index]); }
    return { tracked, dirty };
  } catch { throw fail('无法核对源码仓库状态，源码修复已停用。', 'SOURCE_GIT_UNAVAILABLE', 409); }
}

export class ApplicationSourceRepairs {
  constructor(app, { readGitState = gitState, sandboxRunner } = {}) {
    this.app = app; this.db = app.store.db; this.readGitState = readGitState; this.sandboxRunner = sandboxRunner;
    this.closed = false; this.busy = false; this.active = null; this.owned = new Map(); this.known = new Set();
    this.db.exec(`CREATE TABLE IF NOT EXISTS source_repair_records (id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_repair_operations (id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload_hash TEXT NOT NULL,repair_id TEXT NOT NULL,status TEXT NOT NULL,result TEXT);`);
    for (const row of this.db.prepare("SELECT * FROM source_repair_operations WHERE status='running'").all()) {
      this.db.prepare("UPDATE source_repair_operations SET status='unknown',result=? WHERE id=?").run(JSON.stringify({ repairId: row.repair_id, status: 'unknown', operationId: row.id }), row.id);
      const record = this.record(row.repair_id); if (record) { if (row.kind === 'patch' || row.kind === 'rollback') record.status = 'unknown';
        for (const item of record.tests || []) if (item.operationId === row.id && item.status === 'running') item.status = 'unknown'; this.save(record); }
    }
    this.ready = this.initialize(); this.ready.catch(() => {});
  }
  async initialize() {
    this.root = await realpath(resolve(this.app.config.projectRoot));
    if (await realpath(resolve(this.app.config.appRoot)) !== join(this.root, 'workbench')) throw fail('源码根目录配置不匹配。', 'SOURCE_ROOT_INVALID', 409);
    this.dataRoot = await canonicalDirectory(this.app.config.dataDir); this.backupRoot = join(this.dataRoot, 'source-repairs');
    this.excluded = await Promise.all([this.app.config.dataDir, this.app.config.workspaceRoot, this.app.config.workflowRunRoot].filter(Boolean).map(canonicalDirectory));
    const state = await this.readGitState(this.root); this.dirty = new Set(state.dirty); this.known = new Set(state.tracked);
    for (const row of this.db.prepare('SELECT value FROM source_repair_records ORDER BY rowid').all()) {
      const record = JSON.parse(row.value);
      for (const file of record.files || []) if (file.written || record.status === 'rolled_back') { this.owned.set(file.path, record.status === 'rolled_back' ? file.beforeHash : file.afterHash); this.known.add(file.path); }
    }
  }
  record(id) { const row = this.db.prepare('SELECT value FROM source_repair_records WHERE id=?').get(id); return row ? JSON.parse(row.value) : null; }
  save(record) { record.updatedAt = timestamp(); this.db.prepare('INSERT INTO source_repair_records(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(record.id, JSON.stringify(record)); }
  publicRecord(record) {
    return { id: record.id, summary: record.summary, status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt, operationId: record.operationId,
      actor: record.actor, backupStatus: record.backupStatus || 'incomplete', backupAvailable: record.backupStatus === 'complete', files: (record.files || []).map(({ path, beforeHash, afterHash, written }) => ({ path, beforeHash, afterHash, written: Boolean(written) })), tests: record.tests || [], ...(record.error ? { error: record.error } : {}) };
  }
  async checkpoint(context) {
    if (context.deadlineAt != null && (!Number.isSafeInteger(context.deadlineAt) || context.deadlineAt < 1)) throw fail('源码操作截止时间无效。');
    if (this.closed || context.signal?.aborted) throw fail('源码操作已取消。', 'SOURCE_REPAIR_CANCELLED', 409);
    if (context.deadlineAt && Date.now() >= context.deadlineAt) throw fail('源码操作已超过截止时间。', 'SOURCE_REPAIR_DEADLINE', 408);
    const human = context.human === true && context.role === 'human';
    const permitted = () => {
      const flags = this.app.assistantPermissionSettings?.get?.()?.supervisor;
      return flags?.sourceRepair === true || context.sourceAccess === 'read' && flags?.sourceRead === true;
    };
    if (!human && (context.human || context.role !== 'supervisor' || !permitted())) throw fail('源码工具权限未开启。', 'SOURCE_REPAIR_FORBIDDEN', 403);
    if (typeof context.authorize !== 'function') throw fail('缺少服务端源码修复授权。', 'SOURCE_REPAIR_FORBIDDEN', 403);
    if (await context.authorize() === false) throw fail('源码修复授权已失效。', 'SOURCE_REPAIR_FORBIDDEN', 403);
    if (this.closed || context.signal?.aborted) throw fail('源码操作已取消。', 'SOURCE_REPAIR_CANCELLED', 409);
    if (context.deadlineAt && Date.now() >= context.deadlineAt) throw fail('源码操作已超过截止时间。', 'SOURCE_REPAIR_DEADLINE', 408);
    if (!human && !permitted()) throw fail('源码工具权限已关闭。', 'SOURCE_REPAIR_FORBIDDEN', 403);
  }
  path(input, write = false) {
    if (typeof input !== 'string' || input.length > 240 || !/^[A-Za-z0-9_./-]+$/.test(input) || input.split('/').some(part => !part || part === '..' || part.startsWith('.'))
      || (!SOURCE.test(input) && !ROOT_FILES.has(input)) || !EXTENSIONS.has(extname(input).toLowerCase())
      || /(?:^|\/)(?:auth|credentials|secrets|tokens|config)\.(?:json|ya?ml|toml)$/i.test(input)) throw fail('源码路径不允许。', 'SOURCE_PATH_FORBIDDEN', 403);
    const absolute = resolve(this.root, input);
    if (!inside(this.root, absolute) || this.excluded.some(root => inside(root, absolute))) throw fail('源码路径越过允许范围。', 'SOURCE_PATH_FORBIDDEN', 403);
    if (write && (PROTECTED.has(input.toLowerCase()) || /(?:^|\/)(?:package(?:-lock)?\.json|[^/]*source-repair[^/]*|[^/]*source-tools[^/]*|[^/]*permission[^/]*)$/i.test(input))) throw fail('权限保护与修复入口源码不可由助手修改。', 'SOURCE_PATH_PROTECTED', 403);
    return absolute;
  }
  async inspect(input, { context, missing = false } = {}) {
    const absolute = this.path(input), parts = relative(this.root, absolute).split(sep); let current = this.root;
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]); let entry;
      try { entry = await lstat(current); } catch (error) { if (error.code === 'ENOENT' && missing) return { absolute, missing: true }; throw fail('源码文件不存在或不可读取。', 'SOURCE_FILE_UNAVAILABLE', 404); }
      if (context) await this.checkpoint(context);
      if (entry.isSymbolicLink() || index < parts.length - 1 && !entry.isDirectory() || index === parts.length - 1 && (!entry.isFile() || entry.nlink !== 1)) throw fail('不允许符号链接、硬链接或特殊源码文件。', 'SOURCE_LINK_FORBIDDEN', 403);
    }
    return { absolute, missing: false };
  }
  async source(input, { context, missing = false, known = true, searchBudget } = {}) {
    if (known && !this.known.has(input)) throw fail('只能读取已登记的仓库源码。', 'SOURCE_FILE_UNTRACKED', 403);
    const checked = await this.inspect(input, { context, missing });
    if (checked.missing) return { content: null, hash: 'missing', mode: 0o644 };
    let handle;
    try {
      handle = await open(checked.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); if (context) await this.checkpoint(context);
      const stat = await handle.stat(); if (context) await this.checkpoint(context);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE) throw fail('源码文件不是允许大小的普通文本。', 'SOURCE_FILE_UNAVAILABLE', 413);
      let bytes;
      if (searchBudget) {
        if (stat.size > searchBudget.remaining) throw fail('源码搜索已达到读取容量限制。', 'SOURCE_SEARCH_LIMIT', 413);
        searchBudget.remaining -= stat.size; searchBudget.bytes += stat.size;
        const buffer = Buffer.alloc(stat.size); let offset = 0;
        while (offset < buffer.length) {
          const result = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (context) await this.checkpoint(context);
          if (!result.bytesRead) break;
          offset += result.bytesRead;
        }
        const current = await handle.stat(); if (context) await this.checkpoint(context);
        if (current.size !== offset) throw fail('搜索期间源码已变化。', 'SOURCE_SEARCH_CHANGED', 409);
        bytes = buffer.subarray(0, offset);
      } else bytes = await handle.readFile();
      if (context) await this.checkpoint(context);
      const content = bytes.toString('utf8'); if (content.includes('\0') || !Buffer.from(content).equals(bytes)) throw fail('源码文件必须为UTF-8文本。', 'SOURCE_TEXT_INVALID', 400);
      return { content, hash: hash(bytes), mode: stat.mode & 0o777 };
    } finally { await handle?.close(); }
  }
  async list({ prefix = 'workbench', limit = 80 } = {}, context) {
    await this.ready;
    const guarded = context ? { ...context, sourceAccess: 'read' } : undefined;
    if (guarded) await this.checkpoint(guarded);
    if (typeof prefix !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(prefix) || prefix.split('/').some(part => !part || part.startsWith('.')) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw fail('源码列表参数无效。');
    const currentDirty = new Set((await this.readGitState(this.root)).dirty), files = []; let truncated = false;
    for (const path of [...this.known].sort()) {
      if (!path.startsWith(prefix)) continue;
      try { const source = await this.source(path, { context: guarded }); let writable = !guarded || guarded.allowSourceWrite === true; try { this.path(path, true); if ((this.dirty.has(path) || currentDirty.has(path)) && this.owned.get(path) !== source.hash) writable = false; } catch { writable = false; }
        if (files.length === limit) { truncated = true; break; } files.push({ path, hash: source.hash, size: Buffer.byteLength(source.content), writable }); } catch { /* Private/unavailable files are never projected. */ }
    }
    if (guarded) await this.checkpoint(guarded);
    return { files, truncated };
  }
  async read({ path, startLine = 1, startColumn = 1, lineCount = 120 } = {}, context) {
    await this.ready;
    const guarded = context ? { ...context, sourceAccess: 'read' } : undefined;
    if (guarded) await this.checkpoint(guarded);
    if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(startColumn) || startColumn < 1
      || !Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > 300) throw fail('源码行列范围无效。');
    const source = await this.source(path, { context: guarded });
    const lines = sanitizeDiagnosticText(clean(source.content, MAX_FILE), { preserveLines: true }).split('\n');
    const first = lines[startLine - 1], offset = startColumn - 1;
    if (first === undefined ? offset !== 0 : offset > first.length || offset > 0 && /[\uDC00-\uDFFF]/.test(first[offset] || '') && /[\uD800-\uDBFF]/.test(first[offset - 1])) throw fail('源码起始列无效。');
    let content = '', endLine = null, readLineCount = 0, nextStartLine = null, nextStartColumn = null;
    for (let index = startLine - 1; index < Math.min(lines.length, startLine - 1 + lineCount); index++) {
      const line = lines[index], begin = index === startLine - 1 ? offset : 0, separator = readLineCount ? '\n' : '';
      const remaining = MAX_SOURCE_PAGE - content.length - separator.length;
      let end = Math.min(line.length, begin + Math.max(0, remaining));
      if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1] || '') && /[\uDC00-\uDFFF]/.test(line[end])) end--;
      const redaction = line.lastIndexOf('[REDACTED]', end - 1);
      if (redaction >= begin && redaction + '[REDACTED]'.length > end) end = redaction;
      if (remaining < 0 || end === begin && begin < line.length) { nextStartLine = index + 1; nextStartColumn = begin + 1; break; }
      content += separator + line.slice(begin, end); endLine = index + 1; readLineCount++;
      if (end < line.length) { nextStartLine = index + 1; nextStartColumn = end + 1; break; }
      nextStartLine = index + 1 < lines.length ? index + 2 : null; nextStartColumn = nextStartLine === null ? null : 1;
    }
    if (guarded) await this.checkpoint(guarded);
    return { path, hash: source.hash, content, startLine, startColumn, endLine, readLineCount, totalLines: lines.length,
      truncated: nextStartLine !== null, nextStartLine, nextStartColumn };
  }
  async search(input = {}, context) {
    object(input, ['prefix', 'query', 'limit']);
    const { prefix = 'workbench/src', query, limit = 20 } = input;
    if (typeof prefix !== 'string' || prefix.length > 240 || !/^[A-Za-z0-9_./-]+$/.test(prefix)
      || prefix.split('/').some(part => !part || part.startsWith('.')) || typeof query !== 'string' || !query.trim()
      || query.length > 120 || /[\0\r\n]/.test(query) || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw fail('源码搜索需要有界的单行文字和已登记范围。');
    await this.ready;
    const guarded = context ? { ...context, sourceAccess: 'read' } : undefined;
    if (guarded) await this.checkpoint(guarded);
    const candidates = [...this.known].filter(path => path === prefix || path.startsWith(prefix + '/')).sort();
    if (!candidates.length) throw fail('只能搜索已登记的源码文件或目录。', 'SOURCE_FILE_UNTRACKED', 403);
    const matches = [], budget = { remaining: 2 * 1024 * 1024, bytes: 0 }; let scannedFiles = 0, truncated = false;
    scan: for (const [index, path] of candidates.entries()) {
      if (guarded) await this.checkpoint(guarded);
      if (scannedFiles >= 100) { truncated = true; break; }
      scannedFiles++;
      let source;
      try { source = await this.source(path, { context: guarded, searchBudget: budget }); }
      catch (error) {
        if (guarded) await this.checkpoint(guarded);
        truncated = true;
        if (error.code === 'SOURCE_SEARCH_LIMIT') break;
        if (!['SOURCE_FILE_UNAVAILABLE', 'SOURCE_FILE_UNTRACKED', 'SOURCE_LINK_FORBIDDEN', 'SOURCE_PATH_FORBIDDEN', 'SOURCE_TEXT_INVALID', 'SOURCE_SEARCH_CHANGED'].includes(error.code)) throw error;
        continue;
      }
      const lines = source.content.split('\n');
      for (const [lineIndex, text] of lines.entries()) {
        if (!text.includes(query)) continue;
        const visible = clean(text, MAX_FILE), start = Math.max(0, visible.indexOf(query) - 60), context = visible.slice(start, start + 240);
        matches.push({ path, line: lineIndex + 1, context, hash: source.hash });
        if (matches.length === limit) { truncated ||= lineIndex < lines.length - 1 || index < candidates.length - 1; break scan; }
      }
    }
    if (guarded) await this.checkpoint(guarded);
    return { matches, truncated, scannedFiles, scannedBytes: budget.bytes };
  }
  async history({ limit = 20, repairId, includeDiff = false } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || repairId !== undefined && !identifier(repairId) || typeof includeDiff !== 'boolean') throw fail('修复历史参数无效。');
    const rows = repairId ? [this.record(repairId)].filter(Boolean) : this.db.prepare('SELECT value FROM source_repair_records ORDER BY rowid DESC LIMIT ?').all(limit).map(row => JSON.parse(row.value));
    const repairs = rows.map(record => this.publicRecord(record));
    await this.ready.catch(() => {});
    for (const [index, record] of rows.entries()) if (record.backupStatus === 'complete') {
      try { for (const [fileIndex] of record.files.entries()) for (const side of ['before', 'after']) await this.backupSource(record, fileIndex, side, { metadataOnly: true }); }
      catch { repairs[index].backupAvailable = false; repairs[index].backupStatus = 'unavailable'; }
    }
    if (includeDiff) {
      let budget = 32768;
      for (let index = 0; index < rows.length; index++) for (let fileIndex = 0; fileIndex < (rows[index].files || []).length; fileIndex++) {
        const file = rows[index].files[fileIndex], diff = {};
        for (const side of ['before', 'after']) { let value = ''; try { value = await this.backupSource(rows[index], fileIndex, side) ?? ''; } catch { diff.unavailable = true; }
          diff[side] = clean(value, Math.min(4096, budget)); budget -= diff[side].length; diff.truncated ||= diff[side].length < value.length; }
        repairs[index].files[fileIndex].diff = diff;
      }
    }
    return { repairs };
  }
  async mutation(kind, input, context, action) {
    context = { ...context, sourceAccess: 'repair' };
    if (!identifier(input.operationId)) throw fail('修复操作ID无效。');
    if (kind !== 'rollback' && (context.human || context.role !== 'supervisor')) throw fail('此源码操作只供已授权总控调用。', 'SOURCE_REPAIR_FORBIDDEN', 403);
    await this.checkpoint(context);
    const digest = hash(JSON.stringify(canonical([kind, input]))), previous = this.db.prepare('SELECT * FROM source_repair_operations WHERE id=?').get(input.operationId);
    if (previous) { if (previous.payload_hash !== digest || previous.kind !== kind) throw fail('同一操作ID的幂等内容不能变化。', 'SOURCE_OPERATION_CONFLICT', 409); return previous.result ? JSON.parse(previous.result) : { repairId: previous.repair_id, status: previous.status, operationId: previous.id }; }
    if (this.busy) throw fail('另一项源码修复操作仍在进行。', 'SOURCE_REPAIR_BUSY', 409);
    this.busy = true;
    let writtenCount = 0;
    const controller = new AbortController(), guarded = { ...context, signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal, markSourceWrite: () => { writtenCount++; } };
    const id = kind === 'patch' ? randomUUID() : input.repairId;
    if (!identifier(id)) { this.busy = false; throw fail('修复记录ID无效。'); }
    this.db.prepare('INSERT INTO source_repair_operations(id,kind,payload_hash,repair_id,status) VALUES(?,?,?,?,?)').run(input.operationId, kind, digest, id, 'running');
    const work = (async () => {
      try {
        await this.ready; await this.checkpoint(guarded); const result = await action(id, guarded);
        try { await this.checkpoint(guarded); } catch (error) { if (!(kind === 'test' && result.status === 'timeout' && error.code === 'SOURCE_REPAIR_DEADLINE')) throw error; }
        this.db.prepare("UPDATE source_repair_operations SET status='complete',result=? WHERE id=?").run(JSON.stringify(result), input.operationId); return result;
      } catch (error) {
        const record = this.record(id), status = kind === 'rollback' ? writtenCount ? 'rollback_partial' : record?.status || 'error' : writtenCount ? 'partial' : 'error';
        if (kind !== 'test' && record) { record.status = status; record.error = { code: error.code || 'SOURCE_REPAIR_FAILED', message: clean(error.httpStatus ? error.message : '源码操作失败。', 1000) }; this.save(record); }
        const result = { repairId: id, operationId: input.operationId, status: kind === 'test' ? 'unknown' : status, error: { code: error.code || 'SOURCE_REPAIR_FAILED', message: clean(error.httpStatus ? error.message : '源码操作失败。', 1000) } };
        this.db.prepare("UPDATE source_repair_operations SET status='error',result=? WHERE id=?").run(JSON.stringify(result), input.operationId);
        error.repairId = id; throw error;
      } finally { this.busy = false; this.active = null; }
    })();
    this.active = { controller, work }; return work;
  }
  log(kind, record, operationId, status) { try { this.app.logger?.write(['error', 'partial', 'unknown'].includes(status) ? 'error' : 'info', 'source.repair.' + kind,
    { component: 'source-repair', operationId, repairId: record.id, status, fileCount: record.files?.length || 0 }); } catch { /* Audit logging never changes a repair receipt. */ } }
  async privateDirectory(id, context) {
    await mkdir(this.dataRoot, { recursive: true, mode: 0o700 }); await this.checkpoint(context);
    const data = await realpath(this.dataRoot); await this.checkpoint(context);
    if (data !== this.dataRoot) throw fail('修复备份目录不可为链接。', 'SOURCE_BACKUP_INVALID', 409);
    for (const path of [this.backupRoot, join(this.backupRoot, id)]) {
      try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      await this.checkpoint(context); const stat = await lstat(path); await this.checkpoint(context);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) throw fail('修复备份目录必须是私有目录且不可为链接。', 'SOURCE_BACKUP_INVALID', 409);
    }
    return join(this.backupRoot, id);
  }
  async backupSource(record, index, side, { context, metadataOnly = false } = {}) {
    const invalid = () => fail('修复备份完整性或目录校验失败。', 'SOURCE_BACKUP_INVALID', 409);
    if (!this.backupRoot || !identifier(record.id) || !Number.isInteger(index) || !record.files[index] || !['before', 'after'].includes(side)) throw invalid();
    let handle;
    try {
      if (await realpath(this.dataRoot) !== this.dataRoot) throw invalid(); if (context) await this.checkpoint(context);
      for (const path of [this.backupRoot, join(this.backupRoot, record.id)]) { const stat = await lstat(path); if (context) await this.checkpoint(context); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) throw invalid(); }
      handle = await open(join(this.backupRoot, record.id, index + '.' + side), constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); if (context) await this.checkpoint(context);
      const stat = await handle.stat(); if (context) await this.checkpoint(context);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE || stat.mode & 0o077) throw invalid();
      if (metadataOnly) return true;
      const bytes = await handle.readFile(); if (context) await this.checkpoint(context);
      const expected = record.files[index][side + 'Hash'];
      if (expected === 'missing') { if (bytes.length) throw invalid(); return null; }
      if (hash(bytes) !== expected) throw invalid(); return bytes.toString('utf8');
    } catch (error) { if (error.httpStatus && error.code !== 'SOURCE_BACKUP_INVALID') throw error; throw invalid(); }
    finally { await handle?.close(); }
  }
  async dirtyGuard(path, actualHash, context) {
    const state = await this.readGitState(this.root); await this.checkpoint(context);
    if ((this.dirty.has(path) || state.dirty.includes(path)) && this.owned.get(path) !== actualHash) throw fail('源码已有不属于本修复的人工或外部改动。', 'SOURCE_FILE_DIRTY', 409);
  }
  async parents(path, context) {
    let current = this.root;
    for (const part of relative(this.root, dirname(path)).split(sep)) {
      current = join(current, part); await this.checkpoint(context);
      try { await mkdir(current, { mode: 0o755 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      await this.checkpoint(context); const stat = await lstat(current); await this.checkpoint(context);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('源码父目录不可为链接。', 'SOURCE_LINK_FORBIDDEN', 403);
    }
  }
  async writeSource(file, content, expectedHash, context, onWritten, enforceDirty = false) {
    const path = this.path(file.path, true); await this.parents(path, context);
    const current = await this.source(file.path, { context, missing: true, known: false });
    if (current.hash !== expectedHash) throw fail('源码已变化，未覆盖新的修改。', 'SOURCE_HASH_CONFLICT', 409);
    if (enforceDirty) await this.dirtyGuard(file.path, current.hash, context);
    if (content === null) { await this.checkpoint(context); await unlink(path); onWritten(); await this.checkpoint(context); return; }
    const temporary = join(dirname(path), '.source-repair-' + randomUUID() + '.tmp');
    try {
      await this.checkpoint(context); await writeFile(temporary, content, { flag: 'wx', mode: file.mode || 0o644 }); await this.checkpoint(context);
      const last = await this.source(file.path, { context, missing: true, known: false }); if (last.hash !== expectedHash) throw fail('源码已变化，未覆盖新的修改。', 'SOURCE_HASH_CONFLICT', 409);
      await this.checkpoint(context); await rename(temporary, path); onWritten(); await this.checkpoint(context);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async patch(input, context = {}) {
    object(input, ['operationId', 'summary', 'changes']);
    if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 1000 || !Array.isArray(input.changes) || !input.changes.length || input.changes.length > 8) throw fail('源码修复说明或文件数量无效。');
    return this.mutation('patch', input, context, async (id, guarded) => {
      const record = { id, operationId: input.operationId, summary: clean(input.summary, 1000), status: 'preparing', createdAt: timestamp(), files: [], tests: [], actor: { role: guarded.role, turnId: identifier(guarded.turnId) ? guarded.turnId : null, conversationId: identifier(guarded.conversationId) ? guarded.conversationId : null } }; this.save(record);
      const plans = [], seen = new Set(); let total = 0;
      for (const change of input.changes) {
        object(change, ['path', 'expectedHash', 'content', 'edits', 'remove']); this.path(change.path, true);
        if (seen.has(change.path.toLowerCase()) || !/^(?:sha256:[a-f0-9]{64}|missing)$/.test(change.expectedHash || '') || ['content', 'edits', 'remove'].filter(key => own(change, key)).length !== 1) throw fail('源码修改需要唯一文件、预期哈希和唯一修改方式。'); seen.add(change.path.toLowerCase());
        const before = await this.source(change.path, { context: guarded, missing: true, known: false });
        if (before.hash !== change.expectedHash) throw fail('源码预期哈希已过期。', 'SOURCE_HASH_CONFLICT', 409);
        await this.dirtyGuard(change.path, before.hash, guarded);
        if (before.content !== null && sensitive(before.content)) throw fail('此源码含敏感凭据，不能由助手修改。', 'SOURCE_SENSITIVE_CONTENT', 403);
        let after = change.content;
        if (own(change, 'remove')) { if (change.remove !== true || before.hash === 'missing') throw fail('删除修改必须绑定现有源码。'); after = null; }
        if (own(change, 'edits')) {
          if (before.content === null || !Array.isArray(change.edits) || !change.edits.length || change.edits.length > 32) throw fail('源码替换列表无效。'); after = before.content;
          for (const edit of change.edits) { object(edit, ['oldText', 'newText']); if (typeof edit.oldText !== 'string' || !edit.oldText || typeof edit.newText !== 'string' || after.split(edit.oldText).length !== 2) throw fail('每个旧文本必须恰好出现一次。', 'SOURCE_EDIT_AMBIGUOUS', 409); after = after.replace(edit.oldText, () => edit.newText); }
        }
        if (after !== null && (typeof after !== 'string' || Buffer.byteLength(after) > MAX_FILE || after.includes('\0') || sensitive(after))) throw fail('候选源码必须是有界且不含凭据的文本。', 'SOURCE_TEXT_INVALID', 400);
        total += Buffer.byteLength(before.content || '') + Buffer.byteLength(after || ''); if (total > MAX_PATCH) throw fail('本次源码补丁超出容量限制。', 'SOURCE_PATCH_LIMIT', 413);
        if (after === before.content) throw fail('源码补丁没有有效变化。', 'SOURCE_NO_CHANGE', 400);
        plans.push({ path: change.path, before, after });
      }
      const backup = await this.privateDirectory(id, guarded);
      for (const [index, plan] of plans.entries()) {
        const file = { path: plan.path, beforeHash: plan.before.hash, afterHash: plan.after === null ? 'missing' : hash(plan.after), mode: plan.before.mode, written: false };
        record.files.push(file); this.save(record);
        for (const [side, content] of [['before', plan.before.content], ['after', plan.after]]) { await this.checkpoint(guarded); await writeFile(join(backup, index + '.' + side), content ?? '', { flag: 'wx', mode: 0o600 }); await this.checkpoint(guarded); }
      }
      record.backupStatus = 'complete'; record.status = 'applying'; this.save(record);
      // All files are validated before the first source write; each write checks
      // CAS again. The journal records partial outcomes rather than claiming a
      // multi-file filesystem transaction or silently undoing revoked writes.
      for (const [index, plan] of plans.entries()) await this.writeSource(record.files[index], plan.after, plan.before.hash, guarded, () => { guarded.markSourceWrite(); record.files[index].written = true; this.known.add(plan.path); this.owned.set(plan.path, record.files[index].afterHash); this.save(record); }, true);
      record.status = 'applied'; this.save(record); this.log('patch', record, input.operationId, record.status); return this.publicRecord(record);
    });
  }
  async rollback(input, context = {}) {
    object(input, ['operationId', 'repairId']);
    return this.mutation('rollback', input, context, async (id, guarded) => {
      const record = this.record(id); if (!record) throw fail('修复记录不存在。', 'SOURCE_REPAIR_NOT_FOUND', 404);
      const plans = [];
      for (const [index, file] of record.files.entries()) {
        const current = await this.source(file.path, { context: guarded, missing: true, known: false });
        if (current.hash !== file.afterHash && current.hash !== file.beforeHash) throw fail('修复后源码又有变化，不能覆盖回滚。', 'SOURCE_ROLLBACK_CONFLICT', 409);
        if (current.hash === file.beforeHash) { plans.push({ file, currentHash: current.hash, before: null }); continue; }
        const before = await this.backupSource(record, index, 'before', { context: guarded }); await this.checkpoint(guarded);
        if (before !== null && hash(before) !== file.beforeHash) throw fail('回滚备份完整性校验失败。', 'SOURCE_BACKUP_INVALID', 409);
        plans.push({ file, currentHash: current.hash, before });
      }
      for (const plan of plans) if (plan.currentHash !== plan.file.beforeHash) await this.writeSource(plan.file, plan.before, plan.currentHash, guarded, () => { guarded.markSourceWrite(); this.owned.set(plan.file.path, plan.file.beforeHash); this.save(record); });
      record.status = 'rolled_back'; delete record.error; this.save(record); this.log('rollback', record, input.operationId, record.status); return this.publicRecord(record);
    });
  }
  async idle(context) {
    const runs = await this.app.workflows?.list?.() || []; await this.checkpoint(context);
    const learning = await this.app.learning?.list?.() || []; await this.checkpoint(context);
    const sessions = await this.app.store.list(); await this.checkpoint(context);
    // History lists are bounded to their newest rows. Admission also inspects
    // every in-memory legacy/DAG run and learning batch, without stopping them.
    for (const active of [this.app.workflows?.active, this.app.workflows?.dag?.active]) if (active instanceof Map) for (const state of active.values()) if (state?.run) runs.push(state.run);
    if (this.app.learning?.active instanceof Map) for (const state of this.app.learning.active.values()) if (state?.job) learning.push(state.job);
    if (runs.some(run => ['queued', 'preparing', 'running', 'waiting'].includes(run.status)
      || Object.values(run.nodes || {}).some(node => ['queued', 'preparing', 'running', 'waiting'].includes(node.status)))
      || learning.some(job => ['queued', 'preparing', 'running', 'waiting', 'waiting_review'].includes(job.status))
      || sessions.some(session => ['running', 'busy', 'waiting'].includes(session.status))) throw fail('工作台仍有实际业务或模型活动，未启动源码测试。', 'SOURCE_BUSINESS_BUSY', 409);
  }
  async repairHashes(record, context) {
    const result = [];
    for (const file of record.files) {
      const source = await this.source(file.path, { context, missing: true, known: false });
      if (source.hash !== file.afterHash) throw fail('源码已变化，不能沿用此修复的测试结论。', 'SOURCE_HASH_CONFLICT', 409);
      result.push({ path: file.path, hash: source.hash });
    }
    return result;
  }
  async copySources(directory, record, context) {
    const sourceRoot = join(directory, 'source'), manifest = [];
    await mkdir(sourceRoot, { mode: 0o700 }); await this.checkpoint(context);
    let bytes = 0;
    for (const path of [...this.known].sort()) {
      try { this.path(path); } catch { continue; }
      if (record.files.some(file => file.path === path && file.afterHash === 'missing')) continue;
      const source = await this.source(path, { context }); bytes += Buffer.byteLength(source.content);
      if (manifest.length >= 2000 || bytes > 32 * 1024 * 1024) throw fail('源码测试副本超出容量限制。', 'SOURCE_SNAPSHOT_LIMIT', 413);
      const target = join(sourceRoot, path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await this.checkpoint(context);
      await writeFile(target, source.content, { flag: 'wx', mode: 0o400 }); await this.checkpoint(context);
      manifest.push({ path, hash: source.hash });
    }
    for (const file of record.files) if (file.afterHash !== 'missing' && !manifest.some(row => row.path === file.path && row.hash === file.afterHash)) throw fail('测试源码副本与修复版本不一致。', 'SOURCE_HASH_CONFLICT', 409);
    return { sourceRoot, manifest, snapshotHash: hash(JSON.stringify(manifest)) };
  }
  async verifyManifest(manifest, context) {
    for (const file of manifest) if ((await this.source(file.path, { context })).hash !== file.hash) throw fail('测试期间源码发生变化，结果未绑定当前源码。', 'SOURCE_TEST_STALE', 409);
  }
  async process(command, args, { cwd, env, context, maxMs = 90000 }) {
    await this.checkpoint(context);
    return new Promise(resolveResult => {
      const started = Date.now(), child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      if (this.active) this.active.child = child;
      let stdout = '', stderr = '', truncated = false, timeout = false, cancelled = false, spawnError = null, settled = false, hard, checking = false, verification = Promise.resolve();
      const capture = field => bytes => { const value = bytes.toString('utf8'); if (field === 'stdout') { truncated ||= stdout.length + value.length > MAX_OUTPUT; stdout = (stdout + value).slice(0, MAX_OUTPUT); }
        else { truncated ||= stderr.length + value.length > MAX_OUTPUT; stderr = (stderr + value).slice(0, MAX_OUTPUT); } };
      const kill = signal => { try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); } catch { /* Already exited. */ } };
      const stop = reason => { if (settled) return; timeout ||= reason === 'timeout'; cancelled ||= reason !== 'timeout'; kill('SIGTERM'); hard ||= setTimeout(() => kill('SIGKILL'), 1000); hard.unref?.(); };
      const abort = () => stop('cancelled');
      const timer = setTimeout(() => stop('timeout'), Math.max(1, Math.min(maxMs, (context.deadlineAt || Infinity) - Date.now()))); timer.unref?.();
      child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'));
      child.once('error', error => { spawnError = error.code || 'SPAWN_FAILED'; });
      const verify = () => { if (checking || settled) return; checking = true; verification = this.checkpoint(context).catch(error => stop(error.code === 'SOURCE_REPAIR_DEADLINE' ? 'timeout' : 'authorization')).finally(() => { checking = false; }); };
      const authorityTimer = setInterval(verify, 150); authorityTimer.unref?.();
      child.once('close', async (exitCode, signal) => {
        settled = true; clearTimeout(timer); clearTimeout(hard); clearInterval(authorityTimer); context.signal?.removeEventListener('abort', abort);
        await verification;
        if (this.active?.child === child) delete this.active.child;
        resolveResult({ status: timeout ? 'timeout' : cancelled || spawnError ? 'unknown' : exitCode === 0 ? 'pass' : 'fail', exitCode, signal: signal || null,
          stdout: clean(stdout), stderr: clean(stderr), truncated, durationMs: Date.now() - started, ...(spawnError ? { errorCode: spawnError } : {}) });
      });
      context.signal?.addEventListener('abort', abort, { once: true }); if (context.signal?.aborted) abort();
      verify();
    });
  }
  async runtimeReadPaths(nodePath, context) {
    const queue = [nodePath], seen = new Set(), files = new Set([nodePath]);
    const pathsFor = async path => {
      const output = await execute('/usr/bin/otool', ['-l', path], { encoding: 'utf8', timeout: 3000, maxBuffer: 256 * 1024, env: { PATH: '/usr/bin:/bin', HOME: dirname(nodePath) } }); await this.checkpoint(context);
      const paths = []; let rpath = false;
      for (const line of output.stdout.split('\n')) { if (line.trim() === 'cmd LC_RPATH') rpath = true; else if (rpath && /^\s*path /.test(line)) { paths.push(line.trim().replace(/^path /, '').replace(/ \(offset.*$/, '')); rpath = false; } }
      return paths;
    };
    const executablePaths = await pathsFor(nodePath);
    while (queue.length) {
      const path = queue.shift(); if (seen.has(path) || path.startsWith('/usr/lib/') || path.startsWith('/System/')) continue; seen.add(path);
      if (seen.size > 80) throw fail('Node运行时依赖超出隔离边界。', 'SOURCE_SANDBOX_UNAVAILABLE', 409);
      const output = await execute('/usr/bin/otool', ['-L', path], { encoding: 'utf8', timeout: 3000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', HOME: dirname(nodePath) } }); await this.checkpoint(context);
      let localPaths;
      for (const line of output.stdout.split('\n').slice(1)) {
        let value = line.trim().split(' (')[0]; if (!value) continue;
        if (value.startsWith('/usr/lib/') || value.startsWith('/System/')) { files.add(value); continue; }
        const expand = base => base.replace(/^@loader_path(?=\/|$)/, dirname(path)).replace(/^@executable_path(?=\/|$)/, dirname(nodePath));
        if (value.startsWith('@rpath/')) {
          localPaths ||= await pathsFor(path); const suffix = value.slice(7); let found;
          for (const base of [...localPaths, ...executablePaths]) { try { found = await realpath(resolve(expand(base), suffix)); await this.checkpoint(context); break; } catch (error) { if (error.httpStatus) throw error; } }
          if (!found) throw fail('Node运行时相对依赖无法确认。', 'SOURCE_SANDBOX_UNAVAILABLE', 409); value = found;
        } else value = expand(value);
        if (!value.startsWith('/')) throw fail('Node运行时依赖路径无效。', 'SOURCE_SANDBOX_UNAVAILABLE', 409);
        files.add(value); const actual = await realpath(value); await this.checkpoint(context); files.add(actual); if (!seen.has(actual)) queue.push(actual);
      }
    }
    return [...files];
  }
  async runSandbox({ directory, sourceRoot, files, env, context }) {
    const unavailable = code => ({ status: 'unavailable', sandbox: { kind: 'macos-seatbelt', status: 'unavailable', code } });
    if (process.platform !== 'darwin') return unavailable('platform_unsupported');
    const nodePath = await realpath(process.execPath); await this.checkpoint(context);
    let runtime;
    try { runtime = await this.runtimeReadPaths(nodePath, context); } catch (error) { if (error.httpStatus && error.code !== 'SOURCE_SANDBOX_UNAVAILABLE') throw error; return unavailable('node_runtime_unavailable'); }
    const quote = value => JSON.stringify(value), writable = ['home', 'tmp', 'data', 'workspace', 'runs'].map(name => join(directory, name));
    const profile = ['(version 1)', '(deny default)', '(deny network*)', '(allow process-fork)', '(allow sysctl-read)', '(allow process-info* (target self))', '(allow signal (target self))',
      `(allow process-exec (literal ${quote(nodePath)}))`,
      '(allow file-read-metadata)',
      `(allow file-read* (literal "/") (subpath ${quote(sourceRoot)}) ${writable.map(path => `(subpath ${quote(path)})`).join(' ')} (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share") ${runtime.map(path => `(literal ${quote(path)})`).join(' ')} (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))`,
      `(allow file-write* ${writable.map(path => `(subpath ${quote(path)})`).join(' ')} (literal "/dev/null"))`].join('\n');
    const sentinel = join(this.backupRoot, 'probe-' + randomUUID() + '.txt');
    await writeFile(sentinel, 'source-repair-sandbox-probe', { flag: 'wx', mode: 0o600 }); await this.checkpoint(context);
    const probeProgram = `const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');
      const forbidden=${JSON.stringify(sentinel)},allowed=${JSON.stringify(join(directory, 'tmp/probe'))},expected={writeInside:false,readOutsideDenied:false,writeOutsideDenied:false,networkDenied:false,nodeChildWorks:false};
      try{fs.writeFileSync(allowed,'probe');expected.writeInside=true}catch{}
      try{fs.readFileSync(forbidden)}catch(e){expected.readOutsideDenied=['EACCES','EPERM'].includes(e.code)}
      try{fs.writeFileSync(forbidden,'probe')}catch(e){expected.writeOutsideDenied=['EACCES','EPERM'].includes(e.code)}
      const child=cp.spawnSync(process.execPath,['-e','process.stdout.write("child-ok")'],{encoding:'utf8'});expected.nodeChildWorks=child.status===0&&child.stdout==='child-ok';
      const socket=net.connect({host:'127.0.0.1',port:9});const done=()=>{socket.destroy();console.log(JSON.stringify(expected))};socket.on('connect',done);socket.on('error',e=>{expected.networkDenied=['EACCES','EPERM'].includes(e.code);done()});socket.setTimeout(1000,done);`;
    let probe;
    try { probe = await this.process('/usr/bin/sandbox-exec', ['-p', profile, nodePath, '-e', probeProgram], { cwd: join(sourceRoot, 'workbench'), env, context, maxMs: 10000 }); }
    finally { await unlink(sentinel).catch(() => {}); }
    let verified; try { verified = JSON.parse(probe.stdout.trim()); } catch { return unavailable('sandbox_probe_failed'); }
    if (probe.status !== 'pass' || !['writeInside', 'readOutsideDenied', 'writeOutsideDenied', 'networkDenied', 'nodeChildWorks'].every(key => verified[key] === true)) return unavailable('sandbox_probe_failed');
    await this.checkpoint(context);
    const result = await this.process('/usr/bin/sandbox-exec', ['-p', profile, nodePath, '--test', ...files.map(path => relative('workbench', path))], { cwd: join(sourceRoot, 'workbench'), env, context });
    return { ...result, sandbox: { kind: 'macos-seatbelt', status: 'verified', probe: verified } };
  }
  async test(input, context = {}) {
    object(input, ['operationId', 'repairId', 'files']);
    if (!Array.isArray(input.files) || !input.files.length || input.files.length > 12 || new Set(input.files).size !== input.files.length
      || input.files.some(path => typeof path !== 'string' || !/^workbench\/test\/[A-Za-z0-9_-]+\.test\.mjs$/.test(path))) throw fail('测试只能选择workbench/test中的显式相关.test.mjs文件。');
    return this.mutation('test', input, context, async (id, guarded) => {
      guarded.deadlineAt = Math.min(guarded.deadlineAt || Infinity, Date.now() + 90000);
      const record = this.record(id); if (!record || !['applied', 'verified', 'test_failed'].includes(record.status)) throw fail('只有已应用且未回滚的修复可测试。', 'SOURCE_REPAIR_NOT_TESTABLE', 409);
      await this.idle(guarded); const hashes = await this.repairHashes(record, guarded);
      const entry = { id: randomUUID(), operationId: input.operationId, repairId: id, files: [...input.files], status: 'running', startedAt: timestamp(), completedAt: null, sourceHashes: hashes,
        sandbox: { kind: 'macos-seatbelt', status: 'checking' } }; record.tests.push(entry); this.save(record);
      let directory;
      try {
        await this.backupSource(record, 0, 'after', { context: guarded, metadataOnly: true });
        await mkdir(this.backupRoot, { recursive: true, mode: 0o700 }); await this.checkpoint(guarded);
        directory = await mkdtemp(join(this.backupRoot, 'test-')); await this.checkpoint(guarded);
        for (const name of ['home', 'tmp', 'data', 'workspace', 'runs']) { await mkdir(join(directory, name), { mode: 0o700 }); await this.checkpoint(guarded); }
        const snapshot = await this.copySources(directory, record, guarded);
        for (const path of input.files) if (!snapshot.manifest.some(file => file.path === path)) throw fail('所选测试不在源码副本中。', 'SOURCE_TEST_UNAVAILABLE', 404);
        await this.repairHashes(record, guarded); await this.idle(guarded);
        const env = { PATH: dirname(process.execPath) + ':/usr/bin:/bin', HOME: join(directory, 'home'), TMPDIR: join(directory, 'tmp'), LANG: 'C.UTF-8', TZ: 'UTC', CI: '1', OPENSSL_CONF: '/dev/null',
          WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace'), WORKBENCH_RUN_ROOT: join(directory, 'runs'), HERMES_HOME: join(directory, 'home/.hermes'),
          WORKBENCH_HERMES_HOME: join(directory, 'home/.hermes'), WORKBENCH_HERMES_ROOT: join(directory, 'home/unused-hermes'), HERMES_DISABLE_LAZY_INSTALLS: '1', PYTHONDONTWRITEBYTECODE: '1' };
        const runner = this.sandboxRunner || (options => this.runSandbox(options));
        const result = await runner({ directory, sourceRoot: snapshot.sourceRoot, files: input.files, env, context: guarded });
        if (!['pass', 'fail', 'timeout', 'unknown', 'unavailable'].includes(result?.status)) throw fail('测试执行器没有确认有效终态。', 'SOURCE_TEST_UNKNOWN', 409);
        Object.assign(entry, { status: result.status, exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null, signal: typeof result.signal === 'string' ? result.signal.slice(0, 32) : null,
          stdout: clean(result.stdout || ''), stderr: clean(result.stderr || ''), truncated: result.truncated === true, durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
          sandbox: result.sandbox, snapshotHash: snapshot.snapshotHash, sourceFileCount: snapshot.manifest.length, completedAt: timestamp() });
        try { await this.checkpoint(guarded); } catch (error) {
          if (entry.status === 'timeout' && error.code === 'SOURCE_REPAIR_DEADLINE') { record.status = 'applied'; this.save(record); this.log('test', record, input.operationId, entry.status); return entry; } throw error;
        }
        await this.verifyManifest(snapshot.manifest, guarded); await this.repairHashes(record, guarded);
        record.status = entry.status === 'pass' ? 'verified' : entry.status === 'fail' ? 'test_failed' : 'applied';
        this.save(record); this.log('test', record, input.operationId, entry.status); return entry;
      } catch (error) {
        if (entry.status !== 'running') entry.observedStatus = entry.status;
        entry.status = 'unknown'; entry.errorCode = error.code || 'SOURCE_TEST_FAILED'; entry.completedAt = timestamp(); record.status = 'applied'; this.save(record); this.log('test', record, input.operationId, entry.status); throw error;
      } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
    });
  }
  async close() { if (this.closed) return; this.closed = true; const active = this.active; active?.controller.abort(); await active?.work.catch(() => {}); await this.ready.catch(() => {}); }
}
