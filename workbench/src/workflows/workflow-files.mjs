import { constants } from 'node:fs';
import { access, readdir, realpath, stat, lstat, readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workflowInputFields, workflowInputValue } from '../../shared/workflow/workflow-inputs.mjs';
import { selectDeliveryArtifacts } from './workflow-delivery.mjs';
import { expandDeliveryPackages } from './workflow-delivery-package.mjs';

const execute = promisify(execFile);
const failure = (message, httpStatus = 400) => Object.assign(new Error(message), { httpStatus });
const copy = value => JSON.parse(JSON.stringify(value));
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_FILE = 512 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/plain', '.json': 'application/json', '.zip': 'application/zip' };
const inside = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep); };
const slug = value => String(value || 'workflow').replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 80) || 'workflow';
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const hidden = path => resolve(path).split(sep).some(part => part.startsWith('.') || /^(Library|Keychains|Application Support)$/i.test(part));
const secretName = path => /^(?:\.env(?:\..*)?|id_(?:rsa|ed25519)|credentials(?:\..*)?|authorized_keys|known_hosts)$/i.test(basename(path));
const glob = pattern => new RegExp('^' + pattern.split('').map(char => char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[\\^$+?.()|{}\[\]]/g, '\\$&')).join('') + '$', 'i');
const DELIVERY_MANIFEST = '.workbench-delivery.json';

// Resolve the existing prefix without requiring a new managed root to exist.
async function canonicalLocation(path) {
  let ancestor = resolve(path);
  while (true) {
    try { return resolve(await realpath(ancestor), relative(ancestor, path)); }
    catch (error) { if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error; ancestor = dirname(ancestor); }
  }
}
const hiddenWithin = (root, path) => relative(root, path).split(sep).some(part => part && (part.startsWith('.') || /^(Library|Keychains|Application Support)$/i.test(part)));

export function imageDimensions(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: 'png' };
  if (buffer.length >= 10 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), format: 'gif' };
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buffer.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3), format: 'webp' };
    if (kind === 'VP8L' && buffer[20] === 0x2f) { const bits = buffer.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, format: 'webp' }; }
    if (kind === 'VP8 ' && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff, format: 'webp' };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1]; offset += 2;
      if (marker === 0xd8 || marker === 0x01) continue;
      if (marker === 0xda || marker === 0xd9) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3), format: 'jpeg' };
      offset += length;
    }
  }
  return null;
}

export class WorkflowFiles {
  constructor(app, { allowedRoots, openDirectory, copyArtifact = copyFile } = {}) {
    this.app = app;
    this.db = app.store.db;
    this.managedRunRoot = app.config.workflowRunRoot ? resolve(app.config.workflowRunRoot) : null;
    this.roots = [...new Set([...(allowedRoots || [app.config.workspaceRoot, app.config.appRoot,
      ...['Documents', 'Desktop', 'Downloads', 'Pictures'].map(name => join(homedir(), name))]), this.managedRunRoot].filter(Boolean).map(path => resolve(path)))];
    this.publishing = new Set();
    this.copyArtifact = copyArtifact;
    this.openDirectory = openDirectory || (path => execute(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open', [path], { timeout: 5000 }));
    this.db.exec('CREATE TABLE IF NOT EXISTS workflow_file_runs (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS workflow_artifacts (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  async permitted(path, { existing = true } = {}) {
    if (typeof path !== 'string' || !path.trim() || path.includes('\0') || !isAbsolute(path)) throw failure('请选择有效的本地绝对路径。');
    const target = resolve(path);
    const managedRoot = this.managedRunRoot ? await canonicalLocation(this.managedRunRoot) : null;
    const managedPrefix = managedRoot && inside(managedRoot, target) ? managedRoot
      : this.managedRunRoot && inside(this.managedRunRoot, target) ? this.managedRunRoot : null;
    const managedTarget = !!managedPrefix;
    if ((hidden(target) && !(managedTarget && !hiddenWithin(managedPrefix, target))) || secretName(target)) throw failure('请选择普通资料目录，不能访问隐藏目录或凭据文件。', 403);
    let ancestor = target;
    while (true) {
      try { await stat(ancestor); break; }
      catch (error) { if (error.code !== 'ENOENT' || existing || dirname(ancestor) === ancestor) throw failure('路径不存在或无法访问。'); ancestor = dirname(ancestor); }
    }
    const canonical = await realpath(ancestor);
    const canonicalTarget = resolve(canonical, relative(ancestor, target));
    const canonicalManaged = managedRoot && inside(managedRoot, canonicalTarget);
    if (managedTarget && !canonicalManaged) throw failure('本机运行目录不能通过符号链接访问其它目录。', 403);
    if ((hidden(canonicalTarget) && !(canonicalManaged && !hiddenWithin(managedRoot, canonicalTarget))) || secretName(canonicalTarget)) throw failure('路径不能通过符号链接访问隐藏或敏感目录。', 403);
    const roots = (await Promise.all(this.roots.map(async root => { try { return await realpath(root); } catch { return root; } })));
    if (managedRoot) roots.push(managedRoot);
    if (!canonicalManaged && !roots.some(root => inside(root, canonicalTarget))) throw failure('请选择工作区、文稿、桌面、下载或图片目录内的资料。', 403);
    return canonicalTarget;
  }

  async file(path, { image = false, extensions = [] } = {}) {
    const canonical = await this.permitted(path);
    const metadata = await stat(canonical);
    if (!metadata.isFile()) throw failure('请选择文件。');
    if (metadata.size > MAX_FILE) throw failure('单个文件不能超过 512MB。', 413);
    await access(canonical, constants.R_OK);
    if (extensions.length && !extensions.includes(extname(canonical).toLowerCase())) throw failure('文件类型不符合要求：' + extensions.join('、'));
    const data = await readFile(canonical);
    const dimensions = imageDimensions(data);
    if (image && (!IMAGE_EXTENSIONS.has(extname(canonical).toLowerCase()) || !dimensions || !dimensions.width || !dimensions.height)) throw failure('图片格式无效，请使用 PNG、JPEG、WebP 或 GIF。');
    return { path: canonical, name: basename(canonical), size: data.length, sha256: digest(data), modifiedAt: metadata.mtime.toISOString(), ...(dimensions ? { image: dimensions } : {}) };
  }

  async inventory(path) {
    const root = await this.permitted(path);
    if (!(await stat(root)).isDirectory()) throw failure('请选择文件夹。');
    await access(root, constants.R_OK | constants.X_OK);
    const files = []; let totalBytes = 0;
    const visit = async (directory, depth) => {
      if (depth > 8) throw failure('目录层级过深，请选择更具体的资料目录。');
      for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (item.name.startsWith('.') || secretName(item.name)) continue;
        if (item.isSymbolicLink()) throw failure('资料文件夹包含符号链接，请明确选择真实资料文件。');
        const child = join(directory, item.name);
        if (item.isDirectory()) await visit(child, depth + 1);
        else if (item.isFile()) {
          if (files.length >= 1000) throw failure('资料目录超过 1000 个文件，请选择更具体的目录。');
          const entry = await this.file(child); totalBytes += entry.size;
          if (totalBytes > 2 * 1024 * 1024 * 1024) throw failure('资料目录超过 2GB，请选择更具体的目录。');
          files.push({ ...entry, relativePath: relative(root, entry.path) });
        }
      }
    };
    await visit(root, 0);
    return { path: root, kind: 'folder', files, totalBytes };
  }

  async writableRoot(path) {
    const target = await this.permitted(path, { existing: false });
    let ancestor = target;
    while (true) { try { const item = await stat(ancestor); if (!item.isDirectory()) throw failure('输出位置必须是文件夹。'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = dirname(ancestor); } }
    await access(ancestor, constants.W_OK | constants.X_OK);
    return target;
  }

  async preflight({ document, input, runId, outputDirectory } = {}, { folderWorkflowId } = {}) {
    if (!document || !Array.isArray(document.nodes)) throw failure('缺少工作流。');
    const nodes = document.nodes.filter(node => node.type === 'input');
    const errors = [], entries = [], normalized = {};
    for (const node of nodes) {
      const fields = workflowInputFields(node);
      const name = node.config?.fieldName || node.id;
      const original = workflowInputValue(document, input, node);
      if (!fields.length) { normalized[name] = original; continue; }
      const value = fields.length === 1 && (typeof original !== 'object' || original === null) ? { [fields[0].key]: original } : original;
      const result = {};
      for (const field of fields) {
        const supplied = value?.[field.key];
        const issue = (code, message) => errors.push({ nodeId: node.id, key: field.key, label: field.label, code, message });
        if (supplied === undefined || supplied === null || (typeof supplied === 'string' && !supplied.trim())) { if (field.required) issue('missing', '请先准备' + field.label + '。'); continue; }
        try {
          if (field.kind === 'number') { if (typeof supplied !== 'number' || !Number.isFinite(supplied)) throw failure('请输入有效数字。'); result[field.key] = supplied; entries.push({ nodeId: node.id, key: field.key, kind: field.kind, value: supplied }); }
          else if (field.kind === 'text') { if (typeof supplied !== 'string' || supplied.length > 64000) throw failure('请输入有效文本。'); result[field.key] = supplied; entries.push({ nodeId: node.id, key: field.key, kind: field.kind, value: supplied }); }
          else {
            let selected = supplied, selection = null;
            if (field.match) {
              const target = await this.permitted(supplied), metadata = await stat(target);
              if (metadata.isDirectory()) {
                const candidates = (await readdir(target, { withFileTypes: true })).filter(item => item.isFile() && !item.name.startsWith('.') && glob(field.match).test(item.name));
                if (candidates.length !== 1) { issue(candidates.length ? 'ambiguous' : 'missing', candidates.length ? `${field.label}匹配到 ${candidates.length} 个文件，请明确选择或整理目录。` : field.label + '未找到匹配文件：' + field.match); continue; }
                selected = join(target, candidates[0].name); selection = { directory: target, pattern: field.match };
              } else if (!metadata.isFile() || !glob(field.match).test(basename(target))) throw failure('所选文件不符合匹配要求：' + field.match);
              else selected = target;
            }
            const details = field.kind === 'folder' && !field.match ? await this.inventory(selected) : await this.file(selected, { image: field.kind === 'image', extensions: field.extensions });
            // Keep a folder binding reusable for manual preflight and schedules.
            // prepareRun resolves that binding into this run's fixed file path.
            result[field.key] = selection ? selection.directory : details.path;
            entries.push({ nodeId: node.id, key: field.key, label: field.label, kind: field.match ? 'file' : field.kind,
              ...(field.role ? { role: field.role } : {}), ...(selection ? { selection } : {}), ...details });
          }
        } catch (error) { issue('invalid', error.message); }
      }
      normalized[name] = result;
    }
    const workflowDirectory = this.app.workflowFolders?.directory(folderWorkflowId || document.id);
    let root, executionRoot;
    try { root = await this.writableRoot(outputDirectory || document.settings?.outputDirectory || (workflowDirectory ? join(workflowDirectory, 'outputs') : join(this.app.config.workspaceRoot, 'outputs'))); }
    catch (error) { errors.push({ nodeId: null, key: 'outputDirectory', label: '输出目录', code: 'invalid', message: error.message }); }
    try { executionRoot = workflowDirectory ? await this.writableRoot(join(workflowDirectory, 'runs')) : this.managedRunRoot ? await this.writableRoot(this.managedRunRoot) : root; }
    catch (error) { errors.push({ nodeId: null, key: 'workflowRunRoot', label: '本机运行目录', code: 'invalid', message: error.message }); }
    if (entries.some(entry => entry.kind === 'folder' && [root, executionRoot].filter(Boolean).some(output => inside(entry.path, output)))) {
      errors.push({ nodeId: null, key: 'outputDirectory', label: '输出目录', code: 'overlap', message: '输出目录位于输入资料文件夹内，会改变本次输入；请选择其它输出位置或更具体的输入目录。' });
    }
    const manifest = { version: 1, workflowId: document.id, preparedAt: new Date().toISOString(), entries };
    manifest.sha256 = digest(Buffer.from(JSON.stringify(entries)));
    const suffix = workflowDirectory ? [runId || '本次运行'] : [slug(document.title || document.id), runId || '本次运行'];
    const executionDirectory = executionRoot ? join(executionRoot, ...suffix) : null;
    const deliveryDirectory = root ? join(root, ...suffix) : null;
    if (executionDirectory && deliveryDirectory && executionDirectory !== deliveryDirectory
      && (inside(executionDirectory, deliveryDirectory) || inside(deliveryDirectory, executionDirectory))) {
      errors.push({ nodeId: null, key: 'outputDirectory', label: '输出目录', code: 'overlap', message: '交付目录不能与本机运行目录互相包含。' });
    }
    return { ok: errors.length === 0, errors, input: normalized, manifest,
      outputDirectory: executionDirectory, deliveryDirectory, outputRoot: root || null };
  }

  async prepareRun({ document, input, runId, outputDirectory, folderWorkflowId } = {}) {
    if (!UUID.test(runId || '')) throw failure('无效的运行 ID。');
    const existing = this.db.prepare('SELECT value FROM workflow_file_runs WHERE id=?').get(runId);
    if (existing) throw failure('此运行的输入快照已存在，不能覆盖。', 409);
    const result = await this.preflight({ document, input, runId, outputDirectory }, { folderWorkflowId });
    if (!result.ok) return result;
    if (this.app.workflowFolders) {
      const owner = folderWorkflowId || document.id;
      const captured = await this.app.workflowFolders.captureInputs(owner, result.manifest.entries);
      const paths = new Map([...captured.mappings, ...captured.directories].map(item => [item.source, join(this.app.workflowFolders.directory(owner), item.path)]));
      const relocate = value => typeof value === 'string' ? paths.get(value) || value : Array.isArray(value) ? value.map(relocate)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item)])) : value;
      result.input = relocate(result.input); result.manifest.entries = captured.entries;
      result.manifest.sha256 = digest(Buffer.from(JSON.stringify(captured.entries)));
    }
    result.bindingInput = copy(result.input);
    for (const entry of result.manifest.entries.filter(item => item.selection)) {
      const definition = document.nodes.find(node => node.id === entry.nodeId);
      result.input[definition.config?.fieldName || definition.id][entry.key] = entry.path;
    }
    await mkdir(result.outputDirectory, { recursive: true });
    const value = { ...result, runId, workflowId: document.id, createdAt: new Date().toISOString() };
    await writeFile(join(result.outputDirectory, '输入清单.json'), JSON.stringify(result.manifest, null, 2), { flag: 'wx' });
    this.db.prepare('INSERT INTO workflow_file_runs(id,value) VALUES(?,?)').run(runId, JSON.stringify(value));
    return copy(result);
  }

  run(runId) {
    const row = this.db.prepare('SELECT value FROM workflow_file_runs WHERE id=?').get(runId);
    if (!row) throw failure('没有本次运行的文件记录。', 404);
    return JSON.parse(row.value);
  }

  async nodeDirectory({ runId, nodeId, attempt = 1 }) {
    if (!IDENTIFIER.test(nodeId || '') || !Number.isInteger(attempt) || attempt < 1 || attempt > 10000) throw failure('节点或修改次数无效。');
    const run = this.run(runId), root = run.outputDirectory;
    const path = join(root, nodeId, '版本-' + attempt);
    if (run.importedArchive) {
      try {
        const actual = await this.permitted(path);
        if (!inside(await realpath(root), actual) || !(await stat(actual)).isDirectory()) throw failure('历史节点目录无效。');
        return actual;
      } catch { throw failure('导入的历史目录只供查看，不能创建新的节点版本。', 409); }
    }
    await this.permitted(path, { existing: false });
    await mkdir(path, { recursive: true });
    const actual = await realpath(path);
    if (!inside(await realpath(root), actual)) throw failure('节点目录越过本次运行目录。', 403);
    return actual;
  }

  async verifyInputs(runId) {
    const errors = [];
    for (const entry of this.run(runId).manifest.entries) {
      if (!entry.path) continue;
      try {
        if (entry.selection) {
          const directory = await this.permitted(entry.selection.directory);
          const matches = (await readdir(directory, { withFileTypes: true })).filter(item => item.isFile() && !item.name.startsWith('.') && glob(entry.selection.pattern).test(item.name));
          if (matches.length !== 1 || await realpath(join(directory, matches[0].name)) !== entry.path) throw failure('资料目录的匹配结果已变化或不再唯一，请重新准备运行。');
        }
        if (entry.kind === 'folder') {
          const current = await this.inventory(entry.path);
          if (JSON.stringify(current.files.map(file => [file.relativePath, file.sha256])) !== JSON.stringify(entry.files.map(file => [file.relativePath, file.sha256]))) throw failure('资料目录在运行中发生变化，请重新准备运行。');
        } else if ((await this.file(entry.path)).sha256 !== entry.sha256) throw failure('输入文件在运行中发生变化，请重新准备运行。');
      } catch (error) { errors.push({ nodeId: entry.nodeId, key: entry.key, message: error.message }); }
    }
    return { ok: !errors.length, errors };
  }

  async registerArtifact({ runId, nodeId, attempt = 1, path, label, role, kind } = {}) {
    const run = this.run(runId);
    if (run.importedArchive) throw failure('导入的历史运行只供查看，不能新增产物登记。', 409);
    if (!IDENTIFIER.test(nodeId || '') || !Number.isInteger(attempt) || attempt < 1 || attempt > 10000) throw failure('产物所属节点或版本无效。');
    let details;
    try {
      const actual = await this.permitted(path);
      if (!inside(await realpath(run.outputDirectory), actual)) throw failure('产物必须保存在本次运行的输出目录中。', 403);
      details = await this.file(actual);
    } catch (error) {
      // Identify the generated file, without presenting an output failure as a
      // missing user input or exposing its parent directories in the label.
      const name = (typeof path === 'string' ? basename(path).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069「」]/gu, '�').slice(0, 180) : '') || '未命名产物';
      error.message = `登记产物「${name}」失败：${error.message}`;
      throw error;
    }
    const id = randomUUID();
    const record = { id, artifactId: id, runId, nodeId, attempt, ...details, label: String(label || details.name).slice(0, 200),
      role: String(role || '').slice(0, 100), kind: String(kind || (details.image ? 'image' : 'file')).slice(0, 40),
      mimeType: MIME[extname(details.path).toLowerCase()] || 'application/octet-stream',
      previewUrl: '/api/workflow-v2/artifacts/' + id, downloadUrl: '/api/workflow-v2/artifacts/' + id + '?download=1', createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO workflow_artifacts(id,value) VALUES(?,?)').run(id, JSON.stringify(record));
    return copy(record);
  }

  getArtifact(id) {
    if (!UUID.test(id || '')) throw failure('无效的产物编号。');
    const row = this.db.prepare('SELECT value FROM workflow_artifacts WHERE id=?').get(id);
    if (!row) throw failure('产物不存在。', 404);
    return JSON.parse(row.value);
  }

  async readArtifact(id) {
    const record = this.getArtifact(id);
    const actual = await this.permitted(record.path);
    if (actual !== record.path || !inside(await realpath(this.run(record.runId).outputDirectory), actual)) throw failure('产物位置已变化，请重新生成并审核。', 409);
    const current = await this.file(actual);
    if (current.sha256 !== record.sha256 || current.size !== record.size) throw failure('产物内容已变化，原审核与预览已失效，请重新生成并审核。', 409);
    const data = await readFile(actual);
    if (digest(data) !== record.sha256) throw failure('读取期间产物发生变化，请重新生成并审核。', 409);
    return { record, data };
  }

  async verifyArtifacts(records) {
    const errors = [];
    for (const supplied of records || []) {
      try {
        const { record } = await this.readArtifact(supplied.artifactId || supplied.id);
        if ((supplied.sha256 && record.sha256 !== supplied.sha256) || (supplied.runId && record.runId !== supplied.runId)) throw failure('产物引用版本不一致。');
      } catch (error) { errors.push({ artifactId: supplied.artifactId || supplied.id, message: error.message }); }
    }
    return { ok: !errors.length, errors };
  }

  async browse({ directory, kind = 'file', extensions = '' } = {}) {
    if (!['file', 'folder', 'image'].includes(kind)) throw failure('不支持的资料选择类型。');
    const roots = [];
    for (const path of this.roots) { try { const actual = await this.permitted(path); if ((await stat(actual)).isDirectory()) roots.push({ label: basename(actual), path: actual }); } catch {} }
    if (!directory) return { directory: null, parent: null, roots, entries: [], truncated: false };
    const actual = await this.permitted(directory);
    if (!(await stat(actual)).isDirectory()) throw failure('请选择目录。');
    const allowed = String(extensions).split(',').filter(Boolean).map(value => value.toLowerCase());
    if (allowed.some(value => !/^\.[a-z0-9]{1,12}$/.test(value))) throw failure('无效的扩展名筛选。');
    const all = (await readdir(actual, { withFileTypes: true })).filter(item => !item.name.startsWith('.') && !secretName(item.name) && !item.isSymbolicLink() && (item.isFile() || item.isDirectory()));
    const entries = [];
    for (const item of all.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).slice(0, 500)) {
      const path = join(actual, item.name);
      try {
        await this.permitted(path);
        const folder = item.isDirectory(), extension = extname(path).toLowerCase();
        const selectable = folder ? kind === 'folder' : kind !== 'folder' && (!allowed.length || allowed.includes(extension)) && (kind !== 'image' || IMAGE_EXTENSIONS.has(extension));
        entries.push({ name: item.name, path, kind: folder ? 'folder' : 'file', size: folder ? null : (await stat(path)).size, selectable });
      } catch {}
    }
    let parent = null;
    try { parent = await this.permitted(dirname(actual)); } catch {}
    return { directory: actual, parent, roots, entries, truncated: all.length > 500 };
  }

  async deliveryArtifacts(runId) {
    const runtime = this.app.workflows?.get ? this.app.workflows.get(runId) : null;
    const selected = selectDeliveryArtifacts(runtime, id => this.getArtifact(id));
    return expandDeliveryPackages(runtime, selected, id => this.readArtifact(id));
  }

  async readDeliveryArtifact(artifact) {
    if (artifact.artifactId || artifact.id) return this.readArtifact(artifact.artifactId || artifact.id);
    const manifest = this.getArtifact(artifact.manifestArtifactId);
    if (manifest.runId !== artifact.runId || manifest.nodeId !== artifact.nodeId || manifest.attempt !== artifact.attempt
      || manifest.sha256 !== artifact.manifestSha256 || dirname(manifest.path) !== artifact.packageRoot
      || artifact.path !== join(artifact.packageRoot, artifact.packageEntry) || !inside(artifact.packageRoot, artifact.path)) throw failure('交付包成员的清单绑定无效。', 409);
    if (await this.permitted(artifact.path) !== artifact.path) throw failure('交付包成员位置发生变化。', 409);
    const actual = await this.file(artifact.path);
    if (actual.path !== artifact.path || actual.size !== artifact.size || actual.sha256 !== artifact.sha256) throw failure('交付包成员位置或内容与清单不一致。', 409);
    const data = await readFile(artifact.path);
    if (data.length !== artifact.size || digest(data) !== artifact.sha256) throw failure('交付包成员在读取期间发生变化。', 409);
    return { record: artifact, data };
  }

  async publicationInventory(directory, artifacts = null) {
    const root = await this.permitted(directory), files = [], directories = [];
    if (root !== directory) throw failure('本机原件目录位置已变化，已停止发布。', 409);
    const collect = async (path, details, artifact) => {
      const name = relative(root, path);
      if (files.length >= 50000) throw failure('显式交付文件超过 50000 个，请整理输出节点的交付范围。', 413);
      if (details.size > MAX_FILE) throw failure('交付文件超过单文件 512MB 上限：' + name, 413);
      if (name === DELIVERY_MANIFEST) throw failure('交付原件占用了系统交付清单文件名。');
      const bytes = await readFile(path), sha256 = digest(bytes);
      if (artifact && (bytes.length !== artifact.size || sha256 !== artifact.sha256)) {
        throw failure('交付原件与已登记 SHA 不一致：' + name + '；请核验当前产物后重试保存副本。', 409);
      }
      files.push({ path: name, bytes: bytes.length, sha256, ...(artifact ? {
        artifactId: artifact.artifactId || artifact.id, nodeId: artifact.nodeId, attempt: artifact.attempt,
        ...(artifact.manifestArtifactId ? { manifestArtifactId: artifact.manifestArtifactId,
          manifestSha256: artifact.manifestSha256, packageEntry: artifact.packageEntry } : {}),
      } : {}) });
    };
    if (artifacts !== null) {
      if (!(await lstat(root)).isDirectory()) throw failure('本机原件目录无效，已停止发布。', 409);
      const parents = new Set();
      for (const artifact of artifacts) {
        const path = artifact.path;
        if (!isAbsolute(path) || path !== resolve(path) || path === root || !inside(root, path)) throw failure('交付产物超出本次运行目录，已停止发布。', 409);
        const details = await lstat(path);
        if (details.isSymbolicLink() || await realpath(path) !== path) throw failure('交付产物或上级目录存在符号链接，已停止发布。', 409);
        if (!details.isFile()) throw failure('交付引用必须为已登记文件；文件夹请先打包或逐一声明文件后重试保存副本。', 409);
        const name = relative(root, path);
        if (name.split(sep).length > 41) throw failure('交付目录层级超过安全上限。');
        await collect(path, details, artifact);
        for (let parent = dirname(path); parent !== root; parent = dirname(parent)) parents.add(relative(root, parent));
      }
      directories.push(...[...parents].sort());
    } else {
      // Legacy file-only runs have no DAG declaration. Keep their historical
      // whole-directory publication without applying it to modern workflows.
      const visit = async (path, depth = 0) => {
        if (depth > 40) throw failure('交付目录层级超过安全上限。');
        const details = await lstat(path);
        if (details.isSymbolicLink()) throw failure('交付原件中存在符号链接，已停止发布。');
        if (details.isDirectory()) {
          if (path !== root) directories.push(relative(root, path));
          for (const child of (await readdir(path)).sort()) await visit(join(path, child), depth + 1);
        } else if (details.isFile()) {
          await collect(path, details);
        } else throw failure('交付原件含有非常规文件，已停止发布。');
      };
      await visit(root);
    }
    return { root, files, directories, fingerprint: digest(Buffer.from(JSON.stringify({ directories, files }))), bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
  }

  async publicationMatches(publication, inventory) {
    if (!publication || publication.fingerprint !== inventory.fingerprint) return false;
    try {
      const directory = await this.permitted(publication.directory);
      if ((await lstat(publication.directory)).isSymbolicLink()) return false;
      const manifest = JSON.parse(await readFile(join(directory, DELIVERY_MANIFEST), 'utf8'));
      if (manifest.status !== 'complete' || manifest.fingerprint !== inventory.fingerprint
        || JSON.stringify(manifest.files) !== JSON.stringify(inventory.files)
        || JSON.stringify(manifest.directories) !== JSON.stringify(inventory.directories)) return false;
      for (const name of inventory.directories) {
        const path = join(directory, name), details = await lstat(path);
        if (!details.isDirectory() || details.isSymbolicLink() || !inside(directory, await realpath(path))) return false;
      }
      for (const file of inventory.files) {
        const path = join(directory, file.path), canonical = await realpath(path);
        if (!inside(directory, canonical) || (await lstat(path)).isSymbolicLink()) return false;
        const bytes = await readFile(path);
        if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) return false;
      }
      return true;
    } catch { return false; }
  }

  async publishRun(runId) {
    const run = this.run(runId);
    if (run.importedArchive) throw failure('导入的历史运行只供查看，请从当前工作流新建运行后再交付。', 409);
    if (!run.deliveryDirectory || run.deliveryDirectory === run.outputDirectory) return null;
    if (this.publishing.has(runId)) throw failure('本次交付正在发布，请稍候。', 409);
    this.publishing.add(runId);
    let attempt, created = false;
    const save = patch => {
      const current = this.run(runId);
      const attempts = [...(current.publicationAttempts || []).filter(item => item.revision !== attempt.revision), copy(attempt)];
      this.db.prepare('UPDATE workflow_file_runs SET value=? WHERE id=?').run(JSON.stringify({ ...current, publicationAttempts: attempts, ...patch }), runId);
    };
    try {
      const inventory = await this.publicationInventory(run.outputDirectory, await this.deliveryArtifacts(runId));
      if (await this.publicationMatches(run.publication, inventory)) return copy(run.publication);
      const revision = Math.max(0, ...(run.publicationAttempts || []).map(item => item.revision || 0), run.publication?.revision || 0) + 1;
      const directory = revision === 1 ? run.deliveryDirectory : run.deliveryDirectory + '-交付-' + revision;
      attempt = { directory, revision, fingerprint: inventory.fingerprint, status: 'publishing', startedAt: new Date().toISOString() };
      save({});
      if (await this.writableRoot(directory) !== directory) throw failure('交付目录位置已变化，已停止发布。', 409);
      const parent = await this.permitted(dirname(directory), { existing: false });
      await mkdir(parent, { recursive: true });
      await this.permitted(parent);
      await mkdir(directory); // Exclusive: an existing delivery is never replaced.
      created = true;
      const canonical = await this.permitted(directory);
      if (canonical !== directory || (await lstat(directory)).isSymbolicLink()) throw failure('交付目录位置在发布时发生变化。', 409);
      const manifestPath = join(directory, DELIVERY_MANIFEST);
      await writeFile(manifestPath, JSON.stringify({ runId, ...attempt }, null, 2), { flag: 'wx' });
      for (const name of inventory.directories) {
        const target = join(directory, name);
        await mkdir(target, { recursive: true });
        if (!inside(directory, await realpath(target))) throw failure('交付副本目录发生变化。', 409);
      }
      for (const file of inventory.files) {
        const source = join(inventory.root, file.path), target = join(directory, file.path);
        if ((await lstat(source)).isSymbolicLink() || await realpath(source) !== source) throw failure('本机交付原件位置发生变化。', 409);
        await mkdir(dirname(target), { recursive: true });
        if (!inside(directory, await realpath(dirname(target)))) throw failure('交付副本目录发生变化。', 409);
        await this.copyArtifact(source, target, constants.COPYFILE_EXCL);
        const before = await readFile(source), after = await readFile(target);
        if (before.length !== file.bytes || after.length !== file.bytes || digest(before) !== file.sha256 || digest(after) !== file.sha256) {
          throw failure('交付复制前后 SHA 不一致：' + file.path, 409);
        }
      }
      const current = await this.publicationInventory(inventory.root, await this.deliveryArtifacts(runId));
      if (current.fingerprint !== inventory.fingerprint) throw failure('本机原件在发布期间发生变化，请重新发布。', 409);
      const publication = { directory, revision, fingerprint: inventory.fingerprint, fileCount: inventory.files.length,
        bytes: inventory.bytes, publishedAt: new Date().toISOString(), manifestPath };
      await writeFile(manifestPath, JSON.stringify({ runId, ...publication, status: 'complete', directories: inventory.directories, files: inventory.files }, null, 2));
      if (!await this.publicationMatches(publication, inventory)) throw failure('交付副本最终校验未通过，请重新发布。', 409);
      Object.assign(attempt, { status: 'complete', completedAt: publication.publishedAt });
      save({ publication });
      return copy(publication);
    } catch (cause) {
      const error = failure('交付副本发布失败；本机原件已保留。' + (cause.code === 'EEXIST' ? '目标目录已存在，未覆盖已有文件。' : cause.message), cause.httpStatus || (cause.code === 'EEXIST' ? 409 : 400));
      if (attempt) {
        Object.assign(attempt, { status: 'failed', completedAt: new Date().toISOString(), error: error.message });
        save({});
        if (created) {
          try {
            if (await realpath(attempt.directory) === attempt.directory && !(await lstat(attempt.directory)).isSymbolicLink()) {
              await writeFile(join(attempt.directory, DELIVERY_MANIFEST), JSON.stringify({ runId, ...attempt }, null, 2));
            }
          } catch { /* Publication failure never deletes the authoritative originals. */ }
        }
      }
      throw error;
    } finally { this.publishing.delete(runId); }
  }

  async openRunDirectory({ runId, nodeId, attempt = 1, kind } = {}) {
    if (kind !== undefined && kind !== 'original') throw failure('不支持的运行目录类型。');
    const run = this.run(runId);
    let path = nodeId ? await this.nodeDirectory({ runId, nodeId, attempt }) : run.outputDirectory;
    let currentPublication = true;
    if (this.app.workflows?.get) {
      try { currentPublication = this.app.workflows.get(runId).delivery?.status === 'complete'; }
      catch { currentPublication = false; }
    }
    if (!nodeId && kind !== 'original' && currentPublication && run.publication?.directory) {
      try {
        const published = await this.permitted(run.publication.directory);
        if (published === run.publication.directory && (await stat(published)).isDirectory()) path = published;
      } catch { /* A removed delivery copy must not hide the local originals. */ }
    }
    const actual = await this.permitted(path);
    await this.openDirectory(actual);
    return { opened: true, path: actual };
  }
}
