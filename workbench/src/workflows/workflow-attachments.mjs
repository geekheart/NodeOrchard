import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { lstat, readFile, writeFile, rename, rm, realpath, mkdir } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { imageDimensions } from './workflow-files.mjs';

export const WORKFLOW_ATTACHMENT_LIMITS = Object.freeze({ fileBytes: 32 * 1024 * 1024, turnBytes: 64 * 1024 * 1024, turnFiles: 8, textBytes: 8192, indexBytes: 8 * 1024 * 1024 });
export const WORKFLOW_ATTACHMENT_INDEX = 'inputs/attachments/index.json';
const INDEX = WORKFLOW_ATTACHMENT_INDEX, MAX_INDEX = WORKFLOW_ATTACHMENT_LIMITS.indexBytes;
const HASH = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MIME = { '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.log': 'text/plain',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.zip': 'application/zip', '.html': 'text/html', '.htm': 'text/html' };
const TEXT = new Set(['.txt', '.md', '.json', '.csv', '.tsv', '.log', '.yaml', '.yml', '.xml']);
const RASTER = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const digest = value => createHash('sha256').update(value).digest('hex');
const inside = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep); };
const identifier = value => { if (typeof value !== 'string' || !ID.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) fail('素材身份无效。'); return value; };
const secret = value => /^(?:\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|credentials(?:\..*)?|authorized_keys|known_hosts|\.git-credentials|\.npmrc|\.pypirc|(?:auth|tokens?|secrets?)(?:\.(?:json|ya?ml|toml))?|\.ssh|\.aws|\.gnupg|\.codex|\.hermes)$/i.test(value);
const object = (value, fields) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, field]) => !fields.includes(key) || !Object.hasOwn(field, 'value'))) fail('素材引用或请求包含无效字段。');
};
const fileName = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\\/\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value) || value === '.' || value === '..') fail('请选择有效的素材文件名称。');
  const name = value.normalize('NFC'); if (name.startsWith('.') || secret(name)) fail('请选择普通素材文件，不能上传隐藏或凭据文件。', 403); return name;
};
const mediaType = (name, bytes, supplied = '') => {
  if (typeof supplied !== 'string' || supplied && !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(supplied)) fail('素材 MIME 类型无效。');
  const image = imageDimensions(bytes), mime = (MIME[extname(name).toLowerCase()] || supplied || 'application/octet-stream').toLowerCase();
  if (image?.width && image?.height) return 'image/' + image.format;
  if (RASTER.has(mime) || RASTER.has(supplied.toLowerCase())) fail('图片内容无效，请选择真实的 PNG、JPEG、GIF 或 WebP 图片。');
  return mime;
};

const relativePath = value => {
  if (typeof value !== 'string' || isAbsolute(value) || value === INDEX || /[\\:\x00-\x1f\x7f<>"|?*]/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.') || secret(part))) fail('素材索引包含无效位置或凭据路径。', 409);
  return value;
};
export function attachmentMetadata(workflowId, entry, directory) {
  const path = resolve(directory, relativePath(entry.relativePath));
  if (!inside(directory, path) || path === directory) fail('素材位置越界。', 403);
  return { id: entry.id, workflowId, name: entry.name, path, relativePath: entry.relativePath, sha256: entry.sha256, size: entry.size, mimeType: entry.mimeType,
    url: '/api/workflow-library/' + workflowId + '/attachments/' + entry.id + '/content' };
}
export function normalizeAttachmentRegistry(source, workflowId) {
  identifier(workflowId); object(source, ['version', 'workflowId', 'entries', 'operations']);
  identifier(source.workflowId);
  if (source.version !== 1 || !ID.test(source.workflowId || '') || !Array.isArray(source.entries) || source.entries.length > 10000
    || source.operations !== undefined && (!Array.isArray(source.operations) || source.operations.length > 20000)) fail('素材索引格式无效。', 409);
  const foreign = source.workflowId !== workflowId, ids = new Set(), aliases = new Map();
  const entries = source.entries.map(raw => {
    object(raw, ['id', 'workflowId', 'name', 'relativePath', 'sha256', 'size', 'mimeType', 'aliases', 'path', 'url']);
    identifier(raw.id); const name = fileName(raw.name); relativePath(raw.relativePath);
    if (raw.workflowId !== undefined && raw.workflowId !== source.workflowId) fail('素材索引条目的工作流归属不一致。', 409);
    if (!HASH.test(raw.sha256 || '') || !Number.isSafeInteger(raw.size) || raw.size < 0 || raw.size > WORKFLOW_ATTACHMENT_LIMITS.fileBytes
      || typeof raw.mimeType !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(raw.mimeType)) fail('素材索引包含无效大小、类型或哈希。', 409);
    const id = foreign ? 'attachment-' + digest(workflowId + '\0' + raw.id + '\0' + raw.sha256).slice(0, 32) : raw.id;
    if (ids.has(id) || raw.aliases !== undefined && (!Array.isArray(raw.aliases) || raw.aliases.some(alias => !ID.test(alias)))) fail('素材索引身份重复或别名无效。', 409);
    ids.add(id);
    const entry = { id, workflowId, name, relativePath: raw.relativePath, sha256: raw.sha256, size: raw.size, mimeType: raw.mimeType.toLowerCase(),
      aliases: [...new Set([...(raw.aliases || []), ...(foreign ? [raw.id] : [])])].filter(alias => alias !== id) };
    for (const alias of [id, ...entry.aliases]) { if (aliases.has(alias) && aliases.get(alias) !== id) fail('素材索引别名冲突。', 409); aliases.set(alias, id); }
    return entry;
  });
  const operations = (source.operations || []).map(raw => {
    object(raw, ['id', 'kind', 'digest', 'attachmentId']); identifier(raw.id);
    if (!['upload', 'reference'].includes(raw.kind) || !HASH.test(raw.digest || '') || !aliases.has(raw.attachmentId)) fail('素材操作回执无效。', 409);
    return { id: raw.id, kind: raw.kind, digest: raw.digest, attachmentId: aliases.get(raw.attachmentId) };
  });
  if (new Set(operations.map(op => op.id)).size !== operations.length) fail('素材操作身份重复。', 409);
  return { version: 1, workflowId, entries, operations };
}
export function attachmentEntries(registry, refs, workflowId) {
  if (!Array.isArray(refs) || refs.length > WORKFLOW_ATTACHMENT_LIMITS.turnFiles) fail('每条消息最多使用 8 个素材引用。');
  const entries = refs.map(ref => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || ref.workflowId !== workflowId) fail('素材引用不属于当前工作流。', 403);
    identifier(ref.id); const entry = registry.entries.find(entry => entry.id === ref.id || entry.aliases.includes(ref.id));
    if (!entry) fail('当前工作流没有登记此素材。', 404);
    if (ref.sha256 !== undefined && ref.sha256 !== entry.sha256 || ref.size !== undefined && ref.size !== entry.size
      || ref.relativePath !== undefined && ref.relativePath !== entry.relativePath) fail('聊天素材引用与登记位置、哈希或大小不一致。', 409);
    return entry;
  });
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) fail('素材引用重复。');
  if (entries.reduce((sum, entry) => sum + entry.size, 0) > WORKFLOW_ATTACHMENT_LIMITS.turnBytes) fail('每条消息的素材不能超过 64MB。', 413);
  return entries;
}

// Attachment identities grant access only to indexed, hash-bound files within
// one workflow folder. No model or client supplied absolute path is a read ref.
export class WorkflowAttachments {
  constructor(app) { this.app = app; this.folders = app.workflowFolders; }
  admit(workflowId, write = false, { inFlight = false } = {}) {
    identifier(workflowId); this.folders.directory(workflowId);
    if (this.app.closed || write && this.folders.closing && !inFlight) fail('工作台正在关闭，未接收新的素材。', 503);
    if (write) this.app.workflowLibrary.assertRunnable(workflowId);
    else this.app.workflowLibrary.assertAvailable(workflowId);
  }
  metadata(workflowId, entry) {
    const directory = this.folders.directory(workflowId), metadata = attachmentMetadata(workflowId, entry, directory);
    this.folders.safePath(directory, metadata.path); return metadata;
  }
  registry(workflowId) {
    const directory = this.folders.directory(workflowId), path = this.folders.safePath(directory, join(directory, INDEX)); let source;
    try {
      const stat = lstatSync(path); if (!stat.isFile() || stat.size > MAX_INDEX) fail('素材索引不是有效的普通文件。', 409);
      source = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, workflowId, entries: [], operations: [] }; throw error; }
    const registry = normalizeAttachmentRegistry(source, workflowId);
    registry.entries.forEach(entry => this.metadata(workflowId, entry)); return registry;
  }
  list(workflowId) { this.admit(workflowId); return this.registry(workflowId).entries.map(entry => this.metadata(workflowId, entry)); }
  entry(workflowId, attachmentId, registry = this.registry(workflowId)) {
    identifier(attachmentId); const entry = registry.entries.find(entry => entry.id === attachmentId || entry.aliases.includes(attachmentId));
    if (!entry) fail('当前工作流没有登记此素材。', 404); return entry;
  }
  async bytes(workflowId, entry) {
    const attachment = this.metadata(workflowId, entry); let before;
    try { before = await lstat(attachment.path); }
    catch (error) { if (error.code === 'ENOENT') fail('素材副本已丢失，请重新添加。', 409); throw error; }
    if (!before.isFile() || before.size !== attachment.size) fail('素材位置或大小发生变化，请重新添加。', 409);
    const data = await readFile(attachment.path), after = await lstat(attachment.path);
    if (!after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || data.length !== attachment.size || digest(data) !== attachment.sha256) fail('素材哈希发生变化，请重新添加。', 409);
    return { attachment, data };
  }
  async content(workflowId, attachmentId) {
    this.admit(workflowId); return this.bytes(workflowId, this.entry(workflowId, attachmentId));
  }
  async resolve(workflowId, refs) {
    this.admit(workflowId);
    if (!Array.isArray(refs)) fail('素材引用格式无效。'); refs.forEach(ref => object(ref, ['id', 'workflowId']));
    const entries = attachmentEntries(this.registry(workflowId), refs, workflowId);
    return Promise.all(entries.map(async entry => (await this.bytes(workflowId, entry)).attachment));
  }
  async read(workflowId, attachmentId, options = {}) {
    object(options, ['offset', 'limit']); const { offset = 0, limit = WORKFLOW_ATTACHMENT_LIMITS.textBytes } = options;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > WORKFLOW_ATTACHMENT_LIMITS.textBytes) fail('素材读取范围无效，单次最多 8KB。');
    const { attachment, data } = await this.content(workflowId, attachmentId);
    if (!TEXT.has(extname(attachment.name).toLowerCase()) || data.subarray(0, 8192).includes(0)) return { attachment, contentAvailable: false, offset, totalBytes: attachment.size, truncated: false, reason: '此素材为二进制或不支持的文本格式，仅返回已验证元数据。' };
    if (offset > data.length) fail('素材读取偏移超出文件大小。');
    const end = Math.min(data.length, offset + limit), decoder = new StringDecoder('utf8'); let start = offset;
    while (start < end && (data[start] & 0xc0) === 0x80) start++;
    return { attachment, contentAvailable: true, text: decoder.write(data.subarray(start, end)), offset, totalBytes: attachment.size, truncated: end < data.length };
  }
  enqueue(workflowId, action) {
    this.admit(workflowId, true);
    const previous = this.folders.pending.get(workflowId) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => { this.admit(workflowId, true, { inFlight: true }); return action(); })
      .finally(() => { if (this.folders.pending.get(workflowId) === task) this.folders.pending.delete(workflowId); });
    this.folders.pending.set(workflowId, task); return task;
  }
  async reuse(workflowId, registry, operationId, kind, fingerprint) {
    const previous = registry.operations.find(operation => operation.id === operationId);
    if (!previous) return null;
    if (previous.kind !== kind || previous.digest !== fingerprint) fail('相同素材操作身份不能重试不同的内容或来源。', 409);
    return (await this.bytes(workflowId, this.entry(workflowId, previous.attachmentId, registry))).attachment;
  }
  async store(workflowId, registry, operationId, kind, fingerprint, { name, mimeType, data, ownedPath }) {
    const sha256 = digest(data), existing = registry.entries.find(entry => entry.sha256 === sha256 && entry.size === data.length
      && (!ownedPath || this.metadata(workflowId, entry).path === ownedPath));
    let entry = existing;
    if (existing) await this.bytes(workflowId, existing);
    else {
      const directory = this.folders.ensure(workflowId), extension = /^\.[a-z0-9]{1,12}$/i.test(extname(name)) ? extname(name).toLowerCase() : '.bin';
      const ownedRelative = ownedPath ? relative(directory, ownedPath).split(sep).join('/') : 'inputs/attachments/' + sha256 + extension;
      const path = this.folders.safePath(directory, join(directory, relativePath(ownedRelative)));
      if (!ownedPath) {
        await mkdir(dirname(path), { recursive: true }); this.folders.safePath(directory, path);
        if (existsSync(path)) {
          const present = await readFile(path); if (digest(present) !== sha256) fail('已存在的素材副本哈希不一致，未覆盖文件。', 409);
        } else {
          const temporary = path + '.' + randomUUID() + '.tmp';
          try { await writeFile(temporary, data, { flag: 'wx', mode: 0o600 }); this.folders.safePath(directory, path); await rename(temporary, path); }
          finally { await rm(temporary, { force: true }); }
        }
      }
      entry = { id: 'attachment-' + randomUUID(), workflowId, name, relativePath: ownedRelative, sha256, size: data.length, mimeType, aliases: [] }; registry.entries.push(entry);
    }
    this.admit(workflowId, true, { inFlight: true });
    registry.operations.push({ id: operationId, kind, digest: fingerprint, attachmentId: entry.id });
    if (registry.entries.length > 10000 || registry.operations.length > 20000 || Buffer.byteLength(JSON.stringify(registry)) > MAX_INDEX) fail('素材索引已达到容量上限。', 413);
    this.folders.json(workflowId, INDEX, registry);
    this.app.logEvents?.write('info', 'workflow.attachment.stored', { component: 'workflow', workflowId, operationId, count: data.length, status: 'complete' });
    return this.metadata(workflowId, entry);
  }
  async upload(workflowId, request, data) {
    object(request, ['name', 'mimeType', 'operationId']); const name = fileName(request.name), operationId = identifier(request.operationId);
    if (!Buffer.isBuffer(data) || data.length > WORKFLOW_ATTACHMENT_LIMITS.fileBytes) fail('单个素材文件不能超过 32MB。', 413);
    data = Buffer.from(data);
    const mimeType = mediaType(name, data, request.mimeType), fingerprint = digest(JSON.stringify({ name, mimeType, sha256: digest(data), size: data.length }));
    return this.enqueue(workflowId, async () => {
      const registry = this.registry(workflowId), reused = await this.reuse(workflowId, registry, operationId, 'upload', fingerprint);
      return reused || this.store(workflowId, registry, operationId, 'upload', fingerprint, { name, mimeType, data });
    });
  }
  async reference(workflowId, request) {
    object(request, ['path', 'operationId']); const operationId = identifier(request.operationId), supplied = request.path;
    if (typeof supplied !== 'string' || !isAbsolute(supplied) || supplied.includes('\0')) fail('素材必须使用本地绝对路径。');
    const name = fileName(basename(supplied)), fingerprint = digest(JSON.stringify({ path: resolve(supplied) }));
    return this.enqueue(workflowId, async () => {
      const registry = this.registry(workflowId), reused = await this.reuse(workflowId, registry, operationId, 'reference', fingerprint); if (reused) return reused;
      const directory = this.folders.directory(workflowId); let path;
      if (inside(directory, resolve(supplied))) {
        this.folders.safePath(directory, resolve(supplied));
        if (relative(directory, resolve(supplied)).split(sep).some(part => part.startsWith('.') || secret(part))) fail('不能引用隐藏或凭据素材。', 403);
        path = await realpath(supplied); if (!inside(directory, path)) fail('素材路径越界。', 403);
      } else path = await this.folders.source(supplied);
      if (path === join(directory, INDEX)) fail('不能将素材索引本身作为素材引用。', 409);
      const before = await lstat(path); if (!before.isFile()) fail('请选择普通素材文件。');
      if (before.size > WORKFLOW_ATTACHMENT_LIMITS.fileBytes) fail('单个素材文件不能超过 32MB。', 413);
      const data = await readFile(path), after = await lstat(path);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || data.length !== after.size) fail('素材在归集期间发生变化，请重新选择。', 409);
      return this.store(workflowId, registry, operationId, 'reference', fingerprint, { name, mimeType: mediaType(name, data), data, ...(inside(directory, path) ? { ownedPath: path } : {}) });
    });
  }
}
