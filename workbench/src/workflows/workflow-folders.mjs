import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat, writeFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { workflowInputFields, workflowInputValue } from '../../shared/workflow/workflow-inputs.mjs';

const execute = promisify(execFile), clone = value => structuredClone(value);
const hash = data => createHash('sha256').update(data).digest('hex');
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_FILES = 10000, MAX_BYTES = 2 * 1024 ** 3, MAX_FILE = 512 * 1024 ** 2;
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const inside = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep); };
const posix = path => path.split(sep).join('/');
const materialIdentity = item => JSON.stringify([item.source, item.sha256, item.kind, item.runId, item.nodeId, item.key, item.artifactId]);
const directoryIdentity = item => JSON.stringify([item.source, item.kind, item.runId, item.nodeId, item.key]);
const credentialPart = part => /^(?:\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|credentials(?:\..*)?|authorized_keys|known_hosts|\.git-credentials|\.npmrc|\.pypirc|(?:auth|tokens?|secrets?)(?:\.(?:json|ya?ml|toml))?|\.ssh|\.aws|\.gnupg|\.codex|\.hermes|Keychains)$/i.test(part);
const identifier = value => {
  if (typeof value !== 'string' || !IDENTIFIER.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) fail('无效的工作流文件夹 ID。');
  return value;
};

// Folder records are complete portable materializations of the operational
// index. They never move or rewrite frozen historical execution identities.
export class WorkflowFolders {
  constructor(app, { openDirectory } = {}) {
    this.app = app; this.db = app.store.db; this.pending = new Map(); this.inputRequests = new Map();
    this.workspace = resolve(app.config.workspaceRoot);
    this.openDirectory = openDirectory || (path => execute(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open', [path], { timeout: 5000 }));
  }
  table(name) { return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
  root() {
    const workspace = realpathSync(this.workspace), root = join(workspace, 'workflows');
    this.safePath(workspace, root); return root;
  }
  safePath(root, target) {
    if (!inside(root, target)) fail('工作流文件夹路径越界。', 403);
    let current = root;
    for (const part of ['', ...relative(root, target).split(sep).filter(Boolean)]) {
      if (part) current = join(current, part);
      try { if (lstatSync(current).isSymbolicLink()) fail('工作流文件夹不能包含符号链接。', 403); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
    return target;
  }
  directory(workflowId) {
    identifier(workflowId); const root = this.root(); return this.safePath(root, join(root, workflowId));
  }
  ensure(workflowId) {
    const directory = this.directory(workflowId); mkdirSync(directory, { recursive: true });
    for (const name of ['inputs', 'outputs', 'runs', 'history', 'skills']) {
      const target = this.safePath(directory, join(directory, name)); mkdirSync(target, { recursive: true });
    }
    return directory;
  }
  json(workflowId, name, value) {
    const directory = this.ensure(workflowId), path = this.safePath(directory, join(directory, name)), serialized = JSON.stringify(value, null, 2) + '\n';
    mkdirSync(dirname(path), { recursive: true }); this.safePath(directory, path);
    if (existsSync(path) && readFileSync(path, 'utf8') === serialized) return;
    const temporary = path + '.' + randomUUID() + '.tmp';
    try { writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 }); this.safePath(directory, path); renameSync(temporary, path); }
    finally { rmSync(temporary, { force: true }); }
  }
  record(workflowId) {
    identifier(workflowId);
    if (this.app.workflowLibrary) return this.app.workflowLibrary.get(workflowId);
    const row = this.table('workflow_documents') && this.db.prepare('SELECT * FROM workflow_documents WHERE id=?').get(workflowId);
    if (!row) fail('工作流文档不存在。', 404);
    const life = this.table('workflow_lifecycle') && this.db.prepare('SELECT * FROM workflow_lifecycle WHERE workflow_id=?').get(workflowId);
    return { id: row.id, document: JSON.parse(row.document), revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, origin: row.origin,
      lifecycle: life?.lifecycle === 'archived' ? 'trashed' : life?.lifecycle || 'active', archivedAt: life?.archived_at || null, trashedAt: life?.trashed_at || null };
  }
  syncDocument(record) {
    if (!record || record.id !== record.document?.id) fail('工作流文件夹文档身份不匹配。');
    // A long migration must not replace a save completed while it copied files.
    const latest = this.record(record.id);
    if (latest.revision >= record.revision) record = latest;
    this.json(record.id, 'workflow.json', { format: 'NodeOrchard.workflow-folder', version: 1, ...clone(record) });
    return { workflowId: record.id, directory: this.directory(record.id) };
  }
  inputBindings(document) {
    const bindings = [];
    for (const node of document.nodes.filter(node => node.type === 'input')) {
      const fields = workflowInputFields(node), original = workflowInputValue(document, undefined, node);
      const values = fields.length === 1 && (typeof original !== 'object' || original === null) ? { [fields[0].key]: original } : original;
      for (const field of fields.filter(field => ['file', 'folder', 'image'].includes(field.kind))) {
        const path = values?.[field.key] || (field.key === 'path' ? node.config.path : undefined);
        if (typeof path === 'string' && path.trim()) bindings.push({ nodeId: node.id, key: field.key, kind: field.kind,
          path, match: field.match || '', extensions: field.extensions || [] });
      }
    }
    return bindings.sort((left, right) => (left.nodeId + '/' + left.key).localeCompare(right.nodeId + '/' + right.key));
  }
  inputStatus(workflowId) { const status = this.inputRequests.get(workflowId)?.status; return status ? clone(status) : null; }
  status(workflowId) {
    const directory = this.directory(workflowId);
    const read = name => {
      const path = this.safePath(directory, join(directory, 'history', name));
      try {
        const file = lstatSync(path);
        if (!file.isFile() || file.size > 64 * 1024) fail('工作流资料诊断状态格式无效。', 409);
        const value = JSON.parse(readFileSync(path, 'utf8'));
        if (value.version !== 1 || value.workflowId !== workflowId) fail('工作流资料诊断状态身份不一致。', 409);
        return value;
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    return { inputSync: read('input-sync.json'), migration: read('migration-errors.json') };
  }
  scheduleInputs(record) {
    // The database save has already committed. Material failures belong to this
    // background request and must never turn that successful save into a retry.
    if (this.closing) return Promise.resolve({ workflowId: record.id, status: 'closed' });
    let request;
    const status = (phase, details = {}) => {
      request.status = { version: 1, workflowId: record.id, revision: record.revision, fingerprint: request.fingerprint,
        status: phase, updatedAt: new Date().toISOString(), ...details };
      if (this.inputRequests.get(record.id) !== request) return request.status;
      try { this.json(record.id, 'history/input-sync.json', request.status); }
      catch (error) { request.status.stateWriteError = error.message; }
      return request.status;
    };
    try {
      const bindings = this.inputBindings(record.document), fingerprint = hash(JSON.stringify(bindings));
      const previousRequest = this.inputRequests.get(record.id);
      if (previousRequest?.fingerprint === fingerprint) return previousRequest.promise;
      if (!bindings.length && !previousRequest) return Promise.resolve({ workflowId: record.id, status: 'not-required' });
      request = { fingerprint, status: null, promise: null };
      this.inputRequests.set(record.id, request); status('queued');
      const previous = this.pending.get(record.id) || Promise.resolve(), snapshot = clone(record);
      const task = previous.catch(() => {}).then(async () => {
        if (this.inputRequests.get(record.id) !== request) return status('superseded');
        try {
          this.app.workflowLibrary?.assertAvailable(record.id); status('copying');
          const files = bindings.length ? await this.collect(record.id, snapshot, { fileRuns: [], runs: [], artifacts: [], learning: [] }) : { entries: [], directories: [], totalBytes: 0 };
          return status('complete', { files: files.entries.length, directories: files.directories.length, totalBytes: files.totalBytes });
        } catch (error) { return status('error', { error: error.message }); }
      }).finally(() => { if (this.pending.get(record.id) === task) this.pending.delete(record.id); });
      request.promise = task; this.pending.set(record.id, task); return task;
    } catch (error) {
      request ||= { fingerprint: null, status: null, promise: null };
      this.inputRequests.set(record.id, request);
      request.promise = Promise.resolve(status('error', { error: error.message })); return request.promise;
    }
  }
  syncConversation(workflowId) {
    identifier(workflowId); this.app.workflowLibrary?.assertAvailable(workflowId);
    const revision = this.table('workflow_conversations') ? this.db.prepare('SELECT revision FROM workflow_conversations WHERE workflow_id=?').get(workflowId)?.revision || 0 : 0;
    const rows = this.table('workflow_conversation_turns') ? this.db.prepare('SELECT value,private_value FROM workflow_conversation_turns WHERE workflow_id=? ORDER BY rowid').all(workflowId) : [];
    const turns = rows.map(row => ({ ...JSON.parse(row.value), privateValue: JSON.parse(row.private_value || '{}') }));
    this.json(workflowId, 'conversation.json', { version: 1, workflowId, revision, turns });
  }
  syncRun(run) {
    if (!run || typeof run !== 'object') fail('运行文件记录无效。');
    identifier(run.id); let owner = run; const visited = new Set([run.id]);
    while (owner.parentRunId) {
      identifier(owner.parentRunId);
      if (visited.has(owner.parentRunId) || visited.size > 32) fail('子运行的父级归属无效。', 409);
      const row = this.table('workflow_runs') && this.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(owner.parentRunId);
      if (!row) fail('子运行缺少可核对的父运行。', 409);
      owner = JSON.parse(row.value); identifier(owner.id); visited.add(owner.id);
    }
    const workflowId = identifier(owner.workflowId);
    if (owner.document?.id && owner.document.id !== workflowId || run.folderWorkflowId && run.folderWorkflowId !== workflowId
      || owner.folderWorkflowId && owner.folderWorkflowId !== workflowId) fail('运行与工作流文件夹归属不一致。', 409);
    if (this.table('workflow_library_meta') && this.db.prepare('SELECT 1 FROM workflow_library_meta WHERE key=?').get('deleted:' + workflowId)) return { workflowId, skipped: true };
    this.json(workflowId, posix(join('runs', run.id, 'record.json')), clone(run));
    return { workflowId, directory: this.directory(workflowId) };
  }
  async resolveMaterial(workflowId, source, { sha256, size, kind, runId, nodeId, artifactId } = {}) {
    identifier(workflowId);
    if (typeof source !== 'string' || !isAbsolute(source) || source.includes('\0')) return null;
    const directory = this.directory(workflowId); let mapping;
    try { mapping = JSON.parse(await readFile(this.safePath(directory, join(directory, 'files.json')), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (mapping.workflowId !== workflowId || !Array.isArray(mapping.entries) || !Array.isArray(mapping.directories)) fail('工作流资料映射无效。', 409);
    const matches = item => item.source === resolve(source) && (kind === undefined || item.kind === kind)
      && (runId === undefined || item.runId === runId) && (nodeId === undefined || item.nodeId === nodeId)
      && (artifactId === undefined || item.artifactId === artifactId) && (sha256 === undefined || item.sha256 === sha256);
    const verify = async item => {
      if (typeof item.path !== 'string' || isAbsolute(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256 || '')
        || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FILE) fail('工作流资料映射格式无效。', 409);
      const path = this.safePath(directory, resolve(directory, item.path)), before = await lstat(path);
      if (!before.isFile() || before.size !== item.size || size !== undefined && before.size !== size) fail('工作流资料副本位置或大小发生变化。', 409);
      const data = await readFile(path), after = await lstat(path);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || hash(data) !== item.sha256 || data.length !== item.size) fail('工作流资料副本哈希发生变化。', 409);
      return { ...item, path, data };
    };
    const files = mapping.entries.filter(matches), file = files.at(-1);
    if (file) return verify(file);
    if (sha256 || artifactId || size !== undefined) return null;
    const selected = mapping.directories.filter(matches).at(-1);
    if (!selected || typeof selected.path !== 'string' || isAbsolute(selected.path)) return null;
    const path = this.safePath(directory, resolve(directory, selected.path));
    if (!(await lstat(path)).isDirectory()) fail('工作流资料副本文件夹无效。', 409);
    for (const item of mapping.entries.filter(item => inside(resolve(source), item.source) && (item.path === selected.path || item.path.startsWith(selected.path + '/')))) await verify(item);
    return { ...selected, path, folder: true };
  }
  values(table) { return this.table(table) ? this.db.prepare(`SELECT value FROM ${table}`).all().map(row => JSON.parse(row.value)) : []; }
  history(workflowId) {
    const all = this.values('workflow_runs'), runs = all.filter(run => run.workflowId === workflowId), ids = new Set(runs.map(run => run.id));
    let added;
    do { added = false; for (const run of all) if (ids.has(run.parentRunId) && !ids.has(run.id)) { ids.add(run.id); runs.push(run); added = true; } } while (added);
    return { runs, fileRuns: this.values('workflow_file_runs').filter(run => run.workflowId === workflowId || ids.has(run.runId || run.id)),
      artifacts: this.values('workflow_artifacts').filter(artifact => ids.has(artifact.runId)),
      learning: this.values('workflow_learning').filter(job => job.workflowId === workflowId),
      feedback: this.values('workflow_feedback').filter(row => row.workflowId === workflowId || ids.has(row.runId)),
      schedules: this.values('workflow_schedules').filter(row => row.workflowId === workflowId || ids.has(row.lastTrigger?.runId)) };
  }
  ownedRun(workflowId, runId) {
    identifier(runId);
    const read = id => {
      const row = this.table('workflow_runs') && this.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(id);
      if (!row) fail('运行资料缺少已登记的归属记录。', 409);
      const run = JSON.parse(row.value); if (run.id !== id) fail('运行资料登记身份不一致。', 409); return run;
    };
    const run = read(runId), visited = new Set([runId]); let root = run;
    while (root.parentRunId) {
      identifier(root.parentRunId);
      if (visited.has(root.parentRunId) || visited.size > 32) fail('运行资料的父级归属无效。', 409);
      visited.add(root.parentRunId); root = read(root.parentRunId);
    }
    if (root.workflowId !== workflowId || run.folderWorkflowId && run.folderWorkflowId !== workflowId) fail('运行资料归属其他工作流。', 409);
    return run;
  }
  async source(path, trustedRoot, ownedRoot) {
    if (!isAbsolute(path || '')) fail('工作流资料需要有效的绝对路径。');
    // Admission still owns roots, hidden/credential policy and canonicalization.
    let permitted;
    try {
      if (ownedRoot) {
        // The caller bound this exact root to a persisted, owned run. Root
        // admission remains unchanged; only ordinary children may be hidden.
        const root = await this.source(ownedRoot);
        this.safePath(ownedRoot, path);
        if (relative(ownedRoot, path).split(sep).some(credentialPart)) fail('受控运行资料不能包含凭据文件。', 403);
        permitted = await realpath(path);
        if (!inside(root, permitted)) fail('受控运行资料路径越界。', 403);
      } else if (trustedRoot) {
        this.safePath(resolve(this.app.config.dataDir), trustedRoot);
        this.safePath(trustedRoot, path); const root = await realpath(trustedRoot); permitted = await realpath(path);
        if (!inside(root, permitted)) fail('固定 Skill 快照路径越界。', 403);
      } else {
        const roots = [this.workspace, ...(this.app.workflowFiles.roots || [])].filter(root => inside(root, resolve(path))).sort((left, right) => right.length - left.length);
        if (roots[0]) this.safePath(roots[0], resolve(path));
        permitted = await this.app.workflowFiles.permitted(path);
      }
    } catch (error) { fail('工作流资料无法归集：' + error.message, error.httpStatus || 400); }
    if ((await lstat(path)).isSymbolicLink()) fail('工作流资料不能使用符号链接。', 403);
    return permitted;
  }
  async collect(workflowId, record, history) {
    const directory = this.ensure(workflowId), entries = [], directories = [], byIdentity = new Map(), expected = new Map();
    const ownedRuns = new Map();
    for (const run of history.runs) {
      const registered = this.ownedRun(workflowId, run.id);
      if (registered.outputDirectory !== run.outputDirectory || registered.deliveryDirectory !== run.deliveryDirectory) fail('运行资料根目录与登记归属不一致。', 409);
      ownedRuns.set(run.id, registered);
    }
    const ownedRoot = meta => ['run', 'delivery', 'artifact'].includes(meta.kind)
      ? meta.kind === 'delivery' ? ownedRuns.get(meta.runId)?.deliveryDirectory : ownedRuns.get(meta.runId)?.outputDirectory : null;
    let cached = { entries: [], directories: [] };
    try { cached = JSON.parse(readFileSync(this.safePath(directory, join(directory, 'files.json')), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const cachedFile = async (source, expectedHash) => {
      for (const item of [...(cached.entries || [])].reverse()) {
        if (item.source !== resolve(source) || expectedHash && item.sha256 !== expectedHash || !/^[a-f0-9]{64}$/.test(item.sha256 || '')
          || typeof item.path !== 'string' || isAbsolute(item.path)) continue;
        const path = this.safePath(directory, resolve(directory, item.path));
        try { const data = await readFile(path); if (hash(data) === item.sha256) return { path, data, sha256: item.sha256 }; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return null;
    };
    let total = 0;
    for (const run of history.fileRuns) for (const entry of run.manifest?.entries || []) {
      if (entry.path && entry.kind !== 'folder' && entry.sha256) expected.set(entry.path, entry.sha256);
      for (const file of entry.files || []) if (file.path && file.sha256) expected.set(file.path, file.sha256);
    }
    for (const artifact of history.artifacts) if (artifact.path && artifact.sha256) expected.set(artifact.path, artifact.sha256);
    const addFile = async (source, target, meta = {}, expectedHash) => {
      const recorded = expectedHash || expected.get(source), admissionRoot = meta.kind === 'skill-snapshot' ? join(this.app.config.dataDir, 'workflow-snapshots', identifier(meta.runId)) : null;
      let canonical, data, sha256, sourceUnavailable = false;
      try {
        canonical = await this.source(source, admissionRoot, ownedRoot(meta)); const before = await stat(canonical);
        if (!before.isFile() || before.size > MAX_FILE) fail('资料不是普通文件或超过单文件 512MB 限制。', 413);
        data = await readFile(canonical); const after = await stat(canonical); sha256 = hash(data);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || data.length !== after.size) fail('资料在归集期间变化，请重试。', 409);
        // Imported delivery receipts remain inert source evidence with their
        // original run ID; only a live receipt claims controller ownership.
        if (meta.kind === 'delivery' && !ownedRuns.get(meta.runId)?.importedArchive && basename(source) === '.workbench-delivery.json') {
          let manifest; try { manifest = JSON.parse(data.toString('utf8')); } catch { fail('交付清单登记格式无效。', 409); }
          if (manifest.runId !== meta.runId) fail('交付清单与登记运行归属不一致。', 409);
        }
        if (recorded && sha256 !== recorded) fail('已登记资料哈希发生变化，无法完整归集。', 409);
      } catch (error) {
        if (/符号链接|越界|凭据|归属|清单登记/.test(error.message)) throw error;
        const recovered = await cachedFile(source, recorded); if (!recovered) throw error;
        ({ path: canonical, data, sha256 } = recovered); sourceUnavailable = true;
      }
      // One physical file can be an input, an output and a registered artifact.
      // Preserve every role so import can bind frozen records to their run tree.
      const sourceKey = materialIdentity({ source: resolve(source), sha256, ...meta }), previous = byIdentity.get(sourceKey);
      if (previous) { entries.splice(entries.indexOf(previous), 1); entries.push(previous); return previous; }
      if (entries.length >= MAX_FILES || total + data.length > MAX_BYTES) fail('工作流资料超过 10000 项或 2GB，请整理后重试。', 413);
      target = target.replace('/@content/', '/' + sha256.slice(0, 20) + '/');
      const relativePath = inside(directory, resolve(source)) && canonical === resolve(source) ? posix(relative(directory, canonical)) : target;
      const destination = this.safePath(directory, join(directory, relativePath));
      if (canonical !== destination) {
        mkdirSync(dirname(destination), { recursive: true }); this.safePath(directory, destination);
        const temporary = destination + '.' + randomUUID() + '.tmp';
        try { await writeFile(temporary, data, { flag: 'wx', mode: 0o600 }); this.safePath(directory, destination); await rename(temporary, destination); }
        finally { await rm(temporary, { force: true }); }
      }
      const value = { source: resolve(source), path: relativePath, sha256, size: data.length, ...meta, ...(sourceUnavailable ? { sourceUnavailable: true } : {}) };
      entries.push(value); byIdentity.set(sourceKey, value); total += data.length; return value;
    };
    const addDirectory = async (source, target, meta = {}, depth = 0) => {
      if (depth > 16) fail('资料文件夹超过允许层级。', 413);
      const admissionRoot = meta.kind === 'skill-snapshot' ? join(this.app.config.dataDir, 'workflow-snapshots', identifier(meta.runId)) : null;
      let canonical;
      try { canonical = await this.source(source, admissionRoot, ownedRoot(meta)); }
      catch (error) {
        if (/符号链接|越界|凭据/.test(error.message)) throw error;
        const identity = directoryIdentity({ source: resolve(source), ...meta });
        const prior = [...(cached.directories || [])].reverse().find(item => directoryIdentity(item) === identity);
        if (!prior || typeof prior.path !== 'string' || isAbsolute(prior.path)) throw error;
        const owned = this.safePath(directory, resolve(directory, prior.path));
        if (!(await stat(owned)).isDirectory()) throw error;
        // Recover only the previously registered tree, verifying every file.
        // Extra files in a local copy cannot change a frozen old run implicitly.
        const belongs = item => item.kind === meta.kind && item.runId === meta.runId && inside(resolve(source), item.source)
          && (item.path === prior.path || item.path.startsWith(prior.path + '/'));
        for (const item of (cached.directories || []).filter(belongs)) {
          const path = posix(join(target, relative(resolve(source), item.source)));
          this.safePath(directory, join(directory, path)); mkdirSync(join(directory, path), { recursive: true });
          directories.push({ ...item, path, sourceUnavailable: true });
        }
        const latestFiles = new Map();
        for (const item of (cached.entries || []).filter(belongs)) latestFiles.set(JSON.stringify([item.source, item.kind, item.runId, item.nodeId, item.key, item.artifactId]), item);
        for (const item of latestFiles.values()) await addFile(item.source, posix(join(target, relative(resolve(source), item.source))), meta, item.sha256);
        return;
      }
      const information = await stat(canonical);
      if (!information.isDirectory()) fail('登记的资料文件夹不存在。');
      const relativePath = inside(directory, canonical) ? posix(relative(directory, canonical)) : target;
      this.safePath(directory, join(directory, relativePath)); mkdirSync(join(directory, relativePath), { recursive: true });
      const mapped = { source: canonical, path: relativePath, ...meta };
      if (!directories.some(item => directoryIdentity(item) === directoryIdentity(mapped))) directories.push(mapped);
      for (const item of (await readdir(canonical, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (item.isSymbolicLink()) fail('资料文件夹含符号链接，无法完整归集。', 403);
        const child = join(canonical, item.name), destination = posix(join(relativePath, item.name));
        if (item.isDirectory()) await addDirectory(child, destination, meta, depth + 1);
        else if (item.isFile()) await addFile(child, destination, meta);
        else fail('资料文件夹包含不支持的文件类型。');
      }
    };
    const inputTarget = source => posix(join('inputs', hash(resolve(source)).slice(0, 16), '@content', basename(source)));
    const addInput = async (entry, meta = {}) => {
      if (!entry.path) return;
      if (entry.kind === 'folder') {
        // Frozen manifests enumerate the exact files. Avoid capturing new,
        // unrelated files added later to a historical input folder.
        let canonical, sourceUnavailable = false;
        try { canonical = await this.source(entry.path); }
        catch (error) {
          const prior = [...(cached.directories || [])].reverse().find(item => item.source === resolve(entry.path));
          if (!prior || typeof prior.path !== 'string' || isAbsolute(prior.path) || /符号链接|越界/.test(error.message)) throw error;
          canonical = this.safePath(directory, resolve(directory, prior.path)); sourceUnavailable = true;
        }
        const identity = hash(JSON.stringify((entry.files || []).map(file => [file.relativePath || relative(entry.path, file.path), file.sha256]))).slice(0, 20);
        const target = inside(directory, canonical) ? posix(relative(directory, canonical)) : inputTarget(canonical).replace('/@content/', '/' + identity + '/');
        this.safePath(directory, join(directory, target)); mkdirSync(join(directory, target), { recursive: true });
        const mapped = { source: resolve(entry.path), path: target, kind: 'input', ...meta, ...(sourceUnavailable ? { sourceUnavailable: true } : {}) };
        const prior = directories.findIndex(item => directoryIdentity(item) === directoryIdentity(mapped)); if (prior >= 0) directories.splice(prior, 1);
        directories.push(mapped);
        if (Array.isArray(entry.files)) {
          for (const file of entry.files) { const rel = relative(resolve(entry.path), file.path); if (!inside(resolve(entry.path), file.path)) fail('输入资料清单路径越界。', 403); await addFile(file.path, posix(join(target, rel)), { kind: 'input', ...meta }, file.sha256); }
        } else await addDirectory(canonical, target, { kind: 'input', ...meta });
      } else {
        const result = await addFile(entry.path, inputTarget(entry.path), { kind: 'input', ...meta }, entry.sha256);
        if (entry.selection?.directory) {
          let original, sourceUnavailable = false;
          try { original = await this.source(entry.selection.directory); }
          catch (error) {
            if (/符号链接|越界/.test(error.message) || !(cached.directories || []).some(item => item.source === resolve(entry.selection.directory) && item.kind === 'input')) throw error;
            original = resolve(entry.selection.directory); sourceUnavailable = true;
          }
          const target = posix(dirname(result.path)), mapped = { source: original, path: target, kind: 'input', ...meta, ...(sourceUnavailable ? { sourceUnavailable: true } : {}) };
          if (!directories.some(item => directoryIdentity(item) === directoryIdentity(mapped))) directories.push(mapped);
        }
      }
    };
    // Recorded identities take precedence over current reusable defaults.
    for (const run of history.fileRuns) for (const entry of run.manifest?.entries || []) await addInput(entry, { runId: run.runId || run.id, nodeId: entry.nodeId, key: entry.key });
    for (const node of record.document.nodes.filter(node => node.type === 'input')) {
      const fields = workflowInputFields(node), original = workflowInputValue(record.document, undefined, node);
      const values = fields.length === 1 && (typeof original !== 'object' || original === null) ? { [fields[0].key]: original } : original;
      for (const field of fields.filter(field => ['file', 'folder', 'image'].includes(field.kind))) {
        const path = values?.[field.key] || (field.key === 'path' ? node.config.path : undefined);
        if (typeof path !== 'string' || !path.trim()) continue;
        if (field.match) {
          const inputNode = { ...node, config: { ...node.config, fields: [field], defaultValue: { [field.key]: path } } };
          const preflight = value => this.app.workflowFiles.preflight({ document: { ...record.document, nodes: [{ ...inputNode, config: { ...inputNode.config, defaultValue: { [field.key]: value } } }] } });
          let verified = await preflight(path);
          if (!verified.ok) {
            let absent = false;
            try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') absent = true; }
            if (absent) {
              const prior = [...(cached.directories || [])].reverse().find(item => item.source === resolve(path) && item.kind === 'input');
              const recovered = prior ? { path: this.safePath(directory, resolve(directory, prior.path)), folder: true } : await cachedFile(path);
              if (recovered) {
                const restored = await preflight(recovered.path);
                if (restored.ok) {
                  restored.manifest.entries = restored.manifest.entries.map(entry => ({ ...entry,
                    path: recovered.folder ? join(path, relative(recovered.path, entry.path)) : path,
                    ...(entry.selection ? { selection: { ...entry.selection, directory: path } } : {}) }));
                  verified = restored;
                }
              }
            }
          }
          if (!verified.ok) fail('已配置的输入资料无法完整归集：' + verified.errors.map(error => error.message).join('；'));
          for (const entry of verified.manifest.entries) await addInput(entry, { nodeId: node.id, key: field.key });
        } else {
          let details;
          try { details = field.kind === 'folder' ? await this.app.workflowFiles.inventory(path) : await this.app.workflowFiles.file(path, { image: field.kind === 'image', extensions: field.extensions || [] }); }
          catch (error) {
            if (/符号链接|越界/.test(error.message)) throw error;
            if (field.kind === 'folder') {
              const prior = [...(cached.directories || [])].reverse().find(item => item.source === resolve(path));
              if (!prior || typeof prior.path !== 'string' || isAbsolute(prior.path)) throw error;
              const owned = this.safePath(directory, resolve(directory, prior.path)); if (!(await stat(owned)).isDirectory()) throw error;
              const files = (cached.entries || []).filter(item => inside(resolve(path), item.source) && item.path.startsWith(prior.path + '/'))
                .map(item => ({ path: item.source, sha256: item.sha256, size: item.size, relativePath: posix(relative(resolve(path), item.source)) }));
              details = { path, files };
            } else {
              const recovered = await cachedFile(path); if (!recovered) throw error;
              details = { ...await this.app.workflowFiles.file(recovered.path, { image: field.kind === 'image', extensions: field.extensions || [] }), path };
            }
          }
          await addInput({ ...details, kind: field.kind }, { nodeId: node.id, key: field.key });
        }
      }
    }
    for (const run of history.runs) {
      if (run.outputDirectory) await addDirectory(run.outputDirectory, posix(join('runs', identifier(run.id), 'files')), { kind: 'run', runId: run.id });
      if (run.deliveryDirectory && run.deliveryDirectory !== run.outputDirectory) {
        // A delivery directory can legitimately be absent before approval.
        try { await lstat(run.deliveryDirectory); await addDirectory(run.deliveryDirectory, posix(join('outputs', identifier(run.id), 'delivery')), { kind: 'delivery', runId: run.id }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const snapshot = join(this.app.config.dataDir, 'workflow-snapshots', identifier(run.id));
      try { await lstat(snapshot); await addDirectory(snapshot, posix(join('skills', run.id)), { kind: 'skill-snapshot', runId: run.id }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const artifact of history.artifacts) {
      const run = history.runs.find(item => item.id === artifact.runId), output = run?.outputDirectory;
      const mapped = output && directories.find(item => item.source === resolve(output) && item.kind === 'run' && item.runId === artifact.runId);
      if (!mapped || !inside(resolve(output), resolve(artifact.path))) fail('已登记产物缺少对应的运行目录，无法完整归集。', 409);
      const target = posix(join(mapped.path, relative(resolve(output), resolve(artifact.path))));
      await addFile(artifact.path, target, { kind: 'artifact', runId: artifact.runId, nodeId: artifact.nodeId, artifactId: artifact.id }, artifact.sha256);
    }
    const mergedEntries = [...(cached.entries || []).filter(old => !entries.some(item => materialIdentity(item) === materialIdentity(old)
      || item.path === old.path && item.sha256 !== old.sha256)), ...entries];
    const mergedDirectories = [...(cached.directories || []).filter(old => !directories.some(item => directoryIdentity(item) === directoryIdentity(old))), ...directories];
    this.json(workflowId, 'files.json', { version: 1, workflowId, entries: mergedEntries, directories: mergedDirectories });
    return { entries, directories, totalBytes: total };
  }
  async captureInputs(workflowId, entries) {
    identifier(workflowId);
    if (!Array.isArray(entries)) fail('输入资料清单无效。');
    const previous = this.pending.get(workflowId) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const files = await this.collect(workflowId, { document: { nodes: [] } }, { fileRuns: [{ manifest: { entries } }], runs: [], artifacts: [], learning: [] });
      const directory = this.directory(workflowId), fileMap = new Map(files.entries.map(item => [item.source, item])), folderMap = new Map(files.directories.map(item => [item.source, item]));
      const bound = clone(entries).map(entry => {
        const mapping = entry.kind === 'folder' ? folderMap.get(resolve(entry.path || '')) : fileMap.get(resolve(entry.path || ''));
        if (mapping) entry.path = join(directory, mapping.path);
        if (entry.selection?.directory) { const parent = folderMap.get(resolve(entry.selection.directory)); if (parent) entry.selection.directory = join(directory, parent.path); }
        for (const file of entry.files || []) { const target = fileMap.get(resolve(file.path)); if (target) file.path = join(directory, target.path); }
        return entry;
      });
      return { entries: bound, mappings: files.entries, directories: files.directories };
    });
    this.pending.set(workflowId, task);
    try { return await task; } finally { if (this.pending.get(workflowId) === task) this.pending.delete(workflowId); }
  }
  async sync(workflowId, { includeFiles = false } = {}) {
    identifier(workflowId);
    const previous = this.pending.get(workflowId) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const record = this.record(workflowId); this.syncDocument(record); this.syncConversation(workflowId);
      const result = { workflowId, directory: this.directory(workflowId) };
      if (includeFiles) {
        const history = this.history(workflowId);
        for (const [file, value] of [['runs', history.runs], ['file-runs', history.fileRuns], ['artifacts', history.artifacts], ['learning', history.learning], ['feedback', history.feedback], ['schedules', history.schedules]]) this.json(workflowId, 'history/' + file + '.json', value);
        result.files = await this.collect(workflowId, record, history);
        // Capture any save/chat completed while material files were copied.
        const latest = this.record(workflowId); this.syncDocument(latest); this.syncConversation(workflowId);
        if (latest.revision !== record.revision) fail('归集期间工作流已变化，请重新导出当前版本。', 409);
      }
      return result;
    });
    this.pending.set(workflowId, task);
    try { return await task; } finally { if (this.pending.get(workflowId) === task) this.pending.delete(workflowId); }
  }
  async migrate() {
    const result = { migrated: [], errors: [] };
    if (!this.table('workflow_documents')) return result;
    for (const { id } of this.db.prepare('SELECT id FROM workflow_documents ORDER BY rowid').all()) {
      try {
        await this.sync(id, { includeFiles: true }); result.migrated.push(id);
        if (existsSync(this.safePath(this.directory(id), join(this.directory(id), 'history/migration-errors.json')))) this.json(id, 'history/migration-errors.json', { version: 1, workflowId: id, status: 'complete', updatedAt: new Date().toISOString(), errors: [] });
      }
      catch (error) {
        result.errors.push({ workflowId: id, message: error.message });
        try { this.json(id, 'history/migration-errors.json', { version: 1, workflowId: id, status: 'error', updatedAt: new Date().toISOString(), errors: [{ message: error.message }] }); } catch { /* The caller retains the failure even if the directory itself is unavailable. */ }
      }
    }
    return result;
  }
  async open(workflowId) {
    this.record(workflowId);
    let request;
    do { request = this.inputRequests.get(workflowId); await request?.promise; }
    while (request !== this.inputRequests.get(workflowId));
    const record = this.record(workflowId); this.syncDocument(record); this.syncConversation(workflowId);
    const result = { workflowId, directory: this.directory(workflowId), ...(request ? { inputSync: this.inputStatus(workflowId) } : {}) };
    this.directory(workflowId); await this.openDirectory(result.directory);
    return { ...result, opened: true };
  }
  async close() {
    this.closing = true;
    while (this.pending.size) await Promise.allSettled([...this.pending.values()]);
  }
}
