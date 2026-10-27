import { randomUUID, createHash } from 'node:crypto';
import { lstat, readFile, readdir, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync, renameSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { encodeZip, decodeZip, WORKFLOW_ZIP_LIMITS } from './workflow-zip.mjs';
import { prepareImportedWorkflowRecords } from './workflow-package-records.mjs';

const FORMAT = 'NodeOrchard.workflow-package', MANIFEST = 'workflow-package.json';
const digest = data => createHash('sha256').update(data).digest('hex');
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const json = value => Buffer.from(JSON.stringify(value, null, 2));
const readJson = (entries, name, fallback) => {
  const entry = entries.find(row => row.name === name);
  if (!entry) { if (fallback !== undefined) return fallback; fail('工作流包缺少 ' + name + '。'); }
  try { return JSON.parse(entry.data.toString('utf8')); } catch { fail('工作流包中的 JSON 文件无效：' + name); }
};

// The .workflow extension wraps a normal ZIP containing the workflow folder.
// This module owns validation, staging, identity replacement and registration;
// neither unpacking nor registering can execute imported business code.
export class WorkflowPackages {
  constructor(app) {
    this.app = app; this.db = app.store.db; this.importing = new Map();
    this.db.exec('CREATE TABLE IF NOT EXISTS workflow_package_imports (operation_id TEXT PRIMARY KEY,digest TEXT NOT NULL,workflow_id TEXT NOT NULL,result TEXT NOT NULL)');
  }
  log(event, workflowId, status) {
    try { this.app.logger?.write('info', event, { component: 'workflow-package', workflowId, status }); } catch { /* Diagnostics cannot change the package receipt. */ }
  }
  async entries(directory) {
    const result = []; let bytes = 0;
    const visit = async (path, depth = 0) => {
      if (depth > 32) fail('工作流文件夹层级超过限制。', 413);
      for (const item of await readdir(path, { withFileTypes: true })) {
        const source = join(path, item.name), name = relative(directory, source).split(sep).join('/');
        if (name === MANIFEST) continue;
        this.app.workflowFolders.safePath(directory, source);
        const before = await lstat(source);
        if (before.isSymbolicLink() || !before.isDirectory() && !before.isFile()) fail('工作流包只支持普通文件和文件夹，不能包含链接。');
        if (before.isDirectory()) { result.push({ name: name + '/', data: Buffer.alloc(0) }); await visit(source, depth + 1); }
        else {
          if (before.size > WORKFLOW_ZIP_LIMITS.maxFileBytes) fail('工作流包中的单个文件不能超过 128 MB。', 413);
          const data = await readFile(source), after = await lstat(source);
          if (!after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || data.length !== before.size) fail('工作流文件正在变化，请稍后重新导出。', 409);
          bytes += data.length;
          if (bytes > WORKFLOW_ZIP_LIMITS.maxUncompressedBytes) fail('工作流文件夹超过 512 MB，无法打包。', 413);
          result.push({ name, data });
        }
        if (result.length >= WORKFLOW_ZIP_LIMITS.maxEntries) fail('工作流包文件数量超过限制。', 413);
      }
    };
    await visit(directory); return result.sort((a, b) => a.name.localeCompare(b.name));
  }
  async export(workflowId, { expectedRevision } = {}) {
    const current = this.app.workflowLibrary.get(workflowId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) fail('工作流版本已变化，请保存最新草稿后重新导出。', 409);
    const folder = await this.app.workflowFolders.sync(workflowId, { includeFiles: true });
    const entries = await this.entries(folder.directory);
    if (this.app.workflowLibrary.get(workflowId).revision !== expectedRevision) fail('工作流在归集资料时已变化，请重新导出。', 409);
    const manifest = { format: FORMAT, version: 1, workflowId, revision: expectedRevision, exportedAt: new Date().toISOString(),
      files: entries.filter(entry => !entry.name.endsWith('/')).map(entry => ({ name: entry.name, size: entry.data.length, sha256: digest(entry.data) })),
      dependencies: { skills: current.document.nodes.filter(node => node.type === 'skill').map(node => ({ ref: node.config.skillRef, revision: node.config.version })),
        languages: [...new Set(current.document.nodes.filter(node => node.type === 'tool' && node.config.executionMode === 'code').map(node => node.config.language))] } };
    this.app.workflowFolders.json(workflowId, MANIFEST, manifest);
    const data = encodeZip([...entries, { name: MANIFEST, data: json(manifest) }]);
    const title = String(current.document.title || '工作流').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').slice(0, 80);
    this.log('workflow.package.exported', workflowId, 'complete');
    return { data, filename: title + '.workflow', workflowId, revision: expectedRevision };
  }
  validate(data) {
    const entries = decodeZip(data), manifest = readJson(entries, MANIFEST);
    if (manifest?.format !== FORMAT || manifest.version !== 1 || !Array.isArray(manifest.files)) fail('工作流包格式或版本不受支持。');
    const files = new Map(entries.filter(entry => !entry.name.endsWith('/') && entry.name !== MANIFEST).map(entry => [entry.name, entry]));
    if (manifest.files.length !== files.size) fail('工作流包文件清单不完整。');
    const names = new Set();
    for (const item of manifest.files) {
      const entry = item && files.get(item.name);
      if (!entry || names.has(item.name) || item.size !== entry.data.length || item.sha256 !== digest(entry.data)) fail('工作流包文件完整性校验失败。');
      names.add(item.name);
    }
    const workflow = readJson(entries, 'workflow.json'), conversation = readJson(entries, 'conversation.json');
    if (workflow?.format !== 'NodeOrchard.workflow-folder' || workflow.version !== 1
      || workflow.id !== manifest.workflowId || workflow.document?.id !== manifest.workflowId
      || conversation.workflowId !== manifest.workflowId) fail('工作流包的流程与聊天身份不一致。');
    const mapping = readJson(entries, 'files.json');
    if (mapping?.version !== 1 || mapping.workflowId !== manifest.workflowId || !Array.isArray(mapping.entries) || !Array.isArray(mapping.directories)) fail('工作流包素材映射格式无效。');
    for (const entry of mapping.entries || []) {
      const file = files.get(entry.path);
      if (!file || digest(file.data) !== entry.sha256 || file.data.length !== entry.size) fail('工作流包的素材映射缺失或校验失败。');
    }
    return { entries, manifest, workflow, conversation, files: mapping,
      runs: readJson(entries, 'history/runs.json', []), fileRuns: readJson(entries, 'history/file-runs.json', []), artifacts: readJson(entries, 'history/artifacts.json', []) };
  }
  import(data, { filename, operationId } = {}) {
    if (typeof filename !== 'string' || extname(filename).toLowerCase() !== '.workflow' || basename(filename) !== filename || /[\\\0\r\n]/.test(filename)) fail('请选择 .workflow 工作流包。');
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(operationId || '')) fail('工作流导入请求身份无效。');
    if (!Buffer.isBuffer(data)) fail('工作流包必须是 ZIP 文件。');
    const fingerprint = digest(data), old = this.db.prepare('SELECT * FROM workflow_package_imports WHERE operation_id=?').get(operationId);
    if (old) { if (old.digest !== fingerprint) fail('相同导入请求不能对应不同文件。', 409); return Promise.resolve({ ...JSON.parse(old.result), workflow: this.app.workflowLibrary.get(old.workflow_id), idempotent: true }); }
    const pending = this.importing.get(operationId);
    if (pending) { if (pending.digest !== fingerprint) fail('相同导入请求不能对应不同文件。', 409); return pending.promise; }
    const promise = this.importNew(data, operationId, fingerprint).finally(() => this.importing.delete(operationId));
    this.importing.set(operationId, { digest: fingerprint, promise }); return promise;
  }
  async importNew(data, operationId, fingerprint) {
    const source = this.validate(data), id = 'workflow-' + randomUUID(), destination = this.app.workflowFolders.directory(id);
    const prepared = prepareImportedWorkflowRecords({ sourceWorkflowId: source.manifest.workflowId, targetWorkflowId: id,
      directory: destination, document: source.workflow.document, conversation: source.conversation,
      runs: source.runs, fileRuns: source.fileRuns, artifacts: source.artifacts, files: source.files });
    const root = dirname(destination); await mkdir(root, { recursive: true });
    const temporary = await mkdtemp(join(root, '.import-')); let registered = false, moved = false;
    try {
      for (const entry of source.entries) {
        const target = this.app.workflowFolders.safePath(temporary, join(temporary, entry.name));
        if (entry.name.endsWith('/')) { await mkdir(target, { recursive: true }); continue; }
        await mkdir(dirname(target), { recursive: true }); await writeFile(target, entry.data, { flag: 'wx' });
      }
      const history = join(temporary, 'history', 'import-' + randomUUID()); await mkdir(history, { recursive: true });
      for (const name of ['workflow.json', 'conversation.json', 'files.json', MANIFEST, 'history/runs.json', 'history/file-runs.json', 'history/artifacts.json', 'history/input-sync.json', 'history/migration-errors.json']) {
        const entry = source.entries.find(item => item.name === name);
        if (entry) await writeFile(join(history, name.replaceAll('/', '-')), entry.data);
      }
      const at = new Date().toISOString();
      const record = { id, document: prepared.document, revision: 1, createdAt: at, updatedAt: at, origin: 'saved', lifecycle: 'active', archivedAt: null, trashedAt: null };
      await writeFile(join(temporary, 'workflow.json'), json({ format: 'NodeOrchard.workflow-folder', version: 1, ...record }));
      await writeFile(join(temporary, 'conversation.json'), json({ version: 1, workflowId: id, revision: prepared.turns.length,
        turns: prepared.turns.map(row => ({ ...row.turn, privateValue: row.privateValue })) }));
      await writeFile(join(temporary, 'files.json'), json({ version: 1, workflowId: id,
        entries: source.files.entries.map(entry => ({ ...entry, source: join(destination, entry.path) })),
        directories: source.files.directories.map(entry => ({ ...entry, source: join(destination, entry.path) })) }));
      for (const name of ['input-sync.json', 'migration-errors.json']) {
        if (source.entries.some(entry => entry.name === 'history/' + name)) await writeFile(join(temporary, 'history', name), json({
          version: 1, workflowId: id, status: 'complete', source: 'import', updatedAt: at,
          ...(name === 'migration-errors.json' ? { errors: [] } : { revision: 1 }),
        }));
      }
      for (const run of prepared.runs) {
        await mkdir(join(temporary, 'runs', run.id, 'files'), { recursive: true });
        await writeFile(join(temporary, 'runs', run.id, 'record.json'), json(run));
      }
      for (const [name, value] of [['runs', prepared.runs], ['file-runs', prepared.fileRuns], ['artifacts', prepared.artifacts]]) {
        await mkdir(join(temporary, 'history'), { recursive: true }); await writeFile(join(temporary, 'history', name + '.json'), json(value));
      }
      // The initial package manifest describes its source. The next export
      // generates a new manifest after rebasing; keep the source in history.
      await rm(join(temporary, MANIFEST));
      const result = { workflow: record, imported: true, warnings: prepared.warnings || [] };
      if (existsSync(destination)) fail('工作流目标文件夹已存在，未覆盖。', 409);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare("INSERT INTO workflow_documents(id,revision,created_at,updated_at,document,origin) VALUES(?,1,?,?,?,'saved')").run(id, at, at, JSON.stringify(prepared.document));
        this.db.prepare('INSERT INTO workflow_conversations(workflow_id,revision) VALUES(?,?)').run(id, prepared.turns.length);
        for (const { turn, privateValue } of prepared.turns) this.db.prepare('INSERT INTO workflow_conversation_turns(id,workflow_id,client_message_id,created_at,value,private_value) VALUES(?,?,?,?,?,?)')
          .run(turn.id, id, turn.clientMessageId, turn.createdAt || at, JSON.stringify(turn), JSON.stringify(privateValue));
        for (const [table, records] of [['workflow_runs', prepared.runs], ['workflow_file_runs', prepared.fileRuns], ['workflow_artifacts', prepared.artifacts]]) {
          for (const row of records) this.db.prepare('INSERT INTO ' + table + '(id,value) VALUES(?,?)').run(row.id || row.runId, JSON.stringify(row));
        }
        this.db.prepare('INSERT INTO workflow_package_imports(operation_id,digest,workflow_id,result) VALUES(?,?,?,?)').run(operationId, fingerprint, id, JSON.stringify(result));
        renameSync(temporary, destination); moved = true;
        this.db.exec('COMMIT'); registered = true;
      } catch (error) { this.db.exec('ROLLBACK'); if (moved) { renameSync(destination, temporary); moved = false; } throw error; }
      this.app.publish?.('workflow.document', null, { workflow: this.app.workflowLibrary.summary(record, this.app.workflowLibrary.activities()) });
      this.log('workflow.package.imported', id, 'complete'); return result;
    } finally { if (!registered) await rm(temporary, { recursive: true, force: true }); }
  }
}
