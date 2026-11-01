import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

const MAX_BYTES = 25 * 1024 * 1024;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const artifactId = value => typeof value === 'string' && /^artifact-[a-f0-9]{64}$/.test(value);
const inside = (root, path) => { const part = relative(root, path); return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const fail = (message, status = 403) => Object.assign(new Error(message), { httpStatus: status, code: 'SUPERVISOR_ARTIFACT_INVALID' });
const hash = value => createHash('sha256').update(value).digest('hex');
const name = value => typeof value === 'string' ? basename(value).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || 'artifact' : 'artifact';
const url = (conversationId, turnId, id) => `/api/app-assistant/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/artifacts/${id}`;
function mime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) return 'image/webp';
  return 'application/octet-stream';
}
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
async function regularBytes(path) {
  let file;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES) throw fail('总控产物必须是25MiB以内的独立普通文件。', before.size > MAX_BYTES ? 413 : 403);
    if (await realpath(path) !== path) throw fail('总控产物路径不能包含符号链接。');
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await file.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !same(before, opened) || await realpath(path) !== path) throw fail('总控产物文件身份已变化。', 409);
    const buffer = Buffer.alloc(opened.size + 1); let length = 0;
    while (length < buffer.length) { const result = await file.read(buffer, length, buffer.length - length, length); if (!result.bytesRead) break; length += result.bytesRead; }
    const after = await file.stat(), final = await lstat(path);
    if (length !== opened.size || after.nlink !== 1 || !same(opened, after) || !same(opened, final) || await realpath(path) !== path) throw fail('总控产物读取期间已变化。', 409);
    return buffer.subarray(0, length);
  } catch (error) { if (error.code === 'ENOENT') throw fail('总控产物文件不存在。', 404); throw error; }
  finally { await file?.close(); }
}

// Published bytes live outside the native sandbox. A browser can only read a
// turn-bound published descriptor; no URL parameter ever selects a source path.
export class SupervisorArtifacts {
  constructor(app, owner, { profile } = {}) { this.app = app; this.owner = owner; this.profile = profile; }
  turn(conversationId, turnId, writable = false) {
    if (!identifier(conversationId) || !identifier(turnId)) throw fail('总控产物归属身份无效。', 400);
    const turn = this.owner.readTurn(turnId, conversationId);
    if (turn.id !== turnId || (turn.conversationId || 'global-application') !== conversationId) throw fail('总控产物不属于此会话轮次。');
    if (writable && (!['thinking', 'queued'].includes(turn.status) || this.owner.lifecycle?.project(conversationId)?.lifecycle === 'archived' || turn.escalation?.readOnly)) throw fail('此总控轮次不能发布新的产物。', 409);
    return turn;
  }
  async directory(conversationId, turnId, create = false) {
    let directory = await realpath(this.app.config.dataDir);
    for (const part of ['supervisor-deliveries', conversationId, turnId]) {
      directory = join(directory, part);
      if (create) { try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw fail('总控交付目录身份无效。');
    }
    return directory;
  }
  async publish({ conversationId, turnId, path }) {
    this.turn(conversationId, turnId, true);
    if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || path.includes('\0')) throw fail('总控产物需要当前会话中的绝对文件路径。', 400);
    const profile = await this.profile?.();
    if (!profile || typeof profile.work !== 'string' || typeof profile.profile !== 'string') throw fail('总控产物运行目录尚未确认。', 503);
    const source = resolve(path), roots = [join(profile.work, conversationId), join(profile.profile, 'cache', 'images')];
    let admitted = false;
    for (const candidate of roots) {
      try { const root = resolve(candidate); if (await realpath(root) === root && inside(root, source)) { admitted = true; break; } }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!admitted) throw fail('总控只能发布当前主题工作目录或原生图片缓存中的产物。');
    const bytes = await regularBytes(source), sha256 = hash(bytes), id = 'artifact-' + hash(JSON.stringify([conversationId, turnId, source, sha256]));
    this.turn(conversationId, turnId, true);
    const directory = await this.directory(conversationId, turnId, true), destination = join(directory, id + '.blob');
    let file;
    try { file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600); await file.writeFile(bytes); await file.sync(); }
    catch (error) { if (error.code !== 'EEXIST') throw error; const existing = await regularBytes(destination); if (existing.length !== bytes.length || hash(existing) !== sha256) throw fail('已发布的总控产物身份发生冲突。', 409); }
    finally { await file?.close(); }
    this.turn(conversationId, turnId, true);
    return { id, name: name(source), mimeType: mime(bytes), size: bytes.length, sha256, url: url(conversationId, turnId, id) };
  }
  async read(conversationId, turnId, id) {
    const turn = this.turn(conversationId, turnId);
    if (!artifactId(id)) throw fail('总控产物编号无效。', 400);
    const descriptors = Array.isArray(turn.assistant?.nativeArtifacts) ? turn.assistant.nativeArtifacts : [];
    const descriptor = descriptors.find(item => item?.id === id);
    if (!descriptor || descriptor.url !== url(conversationId, turnId, id) || !/^[a-f0-9]{64}$/.test(descriptor.sha256) || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0 || descriptor.size > MAX_BYTES) throw fail('此轮次没有对应的已发布产物。', 404);
    let directory; try { directory = await this.directory(conversationId, turnId); } catch (error) { if (error.code === 'ENOENT') throw fail('已发布产物不存在。', 404); throw error; }
    const bytes = await regularBytes(join(directory, id + '.blob'));
    if (bytes.length !== descriptor.size || hash(bytes) !== descriptor.sha256) throw fail('已发布产物校验失败。', 409);
    const mimeType = mime(bytes);
    if (descriptor.mimeType !== mimeType) throw fail('已发布产物类型校验失败。', 409);
    return { bytes, mimeType, name: name(descriptor.name) };
  }
}
