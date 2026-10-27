import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const WORKFLOW_ZIP_LIMITS = Object.freeze({ maxCompressedBytes: 256 * 1024 * 1024,
  maxUncompressedBytes: 512 * 1024 * 1024, maxFileBytes: 128 * 1024 * 1024, maxEntries: 10000 });
const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, END = 0x06054b50, DESCRIPTOR = 0x08074b50;
const UTF8 = 0x0800, FLAGS = UTF8 | 0x000e;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const bounds = (ok, message = 'ZIP 内容截断或记录范围无效。') => { if (!ok) fail(message); };
const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}
const crc32 = data => {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

function limitsFor(overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(overrides))
    || Reflect.ownKeys(overrides).some(key => !Object.hasOwn(WORKFLOW_ZIP_LIMITS, key))
    || Object.values(Object.getOwnPropertyDescriptors(overrides)).some(field => !Object.hasOwn(field, 'value'))) fail('ZIP 大小限制配置无效。');
  const result = { ...WORKFLOW_ZIP_LIMITS, ...overrides };
  if (Object.values(result).some(value => !Number.isSafeInteger(value) || value < 0)
    || result.maxEntries > 65534 || result.maxCompressedBytes > 0xfffffffe || result.maxUncompressedBytes > 0xfffffffe
    || result.maxFileBytes > 0xfffffffe) fail('ZIP 大小限制配置无效。');
  return result;
}

function pathRegistry() {
  // A trie stores components once; retaining every complete ancestor path
  // multiplies memory for a malicious collection of deeply nested names.
  const root = { children: new Map() };
  return name => {
    if (typeof name !== 'string' || !name || Buffer.byteLength(name, 'utf8') > 4096 || /[\\\x00-\x1f\x7f:<>"|?*]/.test(name)
      || name.startsWith('/')) fail('ZIP 文件名包含不安全路径。');
    if (decoder.decode(Buffer.from(name, 'utf8')) !== name) fail('ZIP 文件名包含无效 Unicode。');
    const directory = name.endsWith('/'), parts = (directory ? name.slice(0, -1) : name).split('/');
    if (parts.length > 128 || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || Buffer.byteLength(part, 'utf8') > 255)) {
      fail('ZIP 文件名包含不安全或不兼容的路径。');
    }
    let cursor = root;
    for (const part of parts) {
      if (cursor.kind === 'file') fail('ZIP 文件与文件夹路径冲突。');
      const key = part.normalize('NFC').toLowerCase();
      if (!cursor.children.has(key)) cursor.children.set(key, { name: part, children: new Map() });
      cursor = cursor.children.get(key);
      if (cursor.name !== part) fail('ZIP 路径大小写或 Unicode 规范化后发生冲突。');
    }
    if (cursor.kind) fail('ZIP 文件名重复，或大小写、Unicode 规范化后发生冲突。');
    if (!directory && cursor.children.size) fail('ZIP 文件与文件夹路径冲突。');
    cursor.kind = directory ? 'directory' : 'file';
    return directory;
  };
}

function extraFields(data) {
  let offset = 0;
  while (offset < data.length) {
    bounds(offset + 4 <= data.length, 'ZIP 扩展记录不完整。');
    const kind = data.readUInt16LE(offset), size = data.readUInt16LE(offset + 2); offset += 4;
    bounds(offset + size <= data.length, 'ZIP 扩展记录不完整。');
    if (kind === 0x0001) fail('暂不支持 ZIP64 工作流包。');
    offset += size;
  }
}

function nameText(bytes, flags) {
  if (!(flags & UTF8) && bytes.some(byte => byte >= 128)) fail('ZIP 文件名需要使用 UTF-8 编码。');
  try { return decoder.decode(bytes); } catch { fail('ZIP 文件名不是有效的 UTF-8。'); }
}
function versionFlags(version, flags, method) {
  if (version > 20) fail('ZIP 使用了尚不支持的版本或 ZIP64。');
  if (flags & ~FLAGS || method === 0 && flags & 6) fail('ZIP 使用了加密或尚不支持的标志。');
  if (![0, 8].includes(method)) fail('ZIP 压缩方式不受支持，仅支持 store 或 deflate。');
}

// A .workflow file is an ordinary ZIP32 archive; names are root-relative and
// every entry is regular data or an empty directory. No filesystem is touched.
export function encodeZip(entries, overrides = {}) {
  const limits = limitsFor(overrides), register = pathRegistry();
  if (!Array.isArray(entries)) fail('ZIP 条目必须是列表。');
  if (entries.length > limits.maxEntries) fail('ZIP 文件数量超过上限。', 413);
  const chunks = [], headers = []; let offset = 0, expanded = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !Buffer.isBuffer(entry.data)) fail('ZIP 条目需要文件名和 Buffer 内容。');
    const directory = register(entry.name), data = entry.data, name = Buffer.from(entry.name, 'utf8');
    if (directory && data.length) fail('ZIP 文件夹条目不能包含文件内容。');
    if (data.length > limits.maxFileBytes || (expanded += data.length) > limits.maxUncompressedBytes) fail('ZIP 文件或总解压大小超过上限。', 413);
    let compressed = directory ? data : deflateRawSync(data), method = compressed.length < data.length ? 8 : 0;
    if (!method) compressed = data;
    const needed = method ? 20 : 10, crc = crc32(data), local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL); local.writeUInt16LE(needed, 4); local.writeUInt16LE(UTF8, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x0021, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(needed, 6);
    central.writeUInt16LE(UTF8, 8); central.writeUInt16LE(method, 10); central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE((((directory ? 0x41ed : 0x81a4) << 16) | (directory ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    chunks.push(local, name, compressed); headers.push(central, name);
    offset += local.length + name.length + compressed.length;
    if (offset > limits.maxCompressedBytes) fail('ZIP 压缩包大小超过上限。', 413);
  }
  const centralSize = headers.reduce((sum, data) => sum + data.length, 0), end = Buffer.alloc(22);
  if (offset + centralSize + end.length > limits.maxCompressedBytes) fail('ZIP 压缩包大小超过上限。', 413);
  end.writeUInt32LE(END); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...headers, end], offset + centralSize + end.length);
}

function endRecord(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === END && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) return offset;
  }
  fail('ZIP 结束记录缺失、截断或存在额外尾部数据。');
}

function descriptorEnd(buffer, start, entry, centralOffset) {
  // Data descriptors may include an optional signature. A CRC can itself equal
  // that signature, so accept only the layout whose complete values match.
  for (const signature of [true, false]) {
    const offset = start + (signature ? 4 : 0), end = offset + 12;
    if (end > centralOffset || signature && buffer.readUInt32LE(start) !== DESCRIPTOR) continue;
    if (buffer.readUInt32LE(offset) === entry.crc && buffer.readUInt32LE(offset + 4) === entry.compressed
      && buffer.readUInt32LE(offset + 8) === entry.size) return end;
  }
  fail('ZIP 数据描述符与中央目录不一致。');
}

export function decodeZip(buffer, overrides = {}) {
  const limits = limitsFor(overrides);
  if (!Buffer.isBuffer(buffer)) fail('ZIP 内容必须是 Buffer。');
  if (buffer.length > limits.maxCompressedBytes) fail('ZIP 压缩包大小超过上限。', 413);
  if (buffer.length < 22) fail('ZIP 文件过短或已截断。');
  const end = endRecord(buffer), count = buffer.readUInt16LE(end + 10), centralSize = buffer.readUInt32LE(end + 12), centralOffset = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || buffer.readUInt16LE(end + 8) !== count) fail('不支持多卷 ZIP。');
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('暂不支持 ZIP64 工作流包。');
  if (count > limits.maxEntries) fail('ZIP 文件数量超过上限。', 413);
  bounds(centralOffset + centralSize === end, 'ZIP 中央目录范围无效。');
  const entries = [], register = pathRegistry(); let cursor = centralOffset, declaredBytes = 0;
  for (let index = 0; index < count; index++) {
    bounds(cursor + 46 <= end && buffer.readUInt32LE(cursor) === CENTRAL, 'ZIP 中央目录不完整。');
    const needed = buffer.readUInt16LE(cursor + 6), flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10);
    versionFlags(needed, flags, method);
    const crc = buffer.readUInt32LE(cursor + 16), compressed = buffer.readUInt32LE(cursor + 20), size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28), extraLength = buffer.readUInt16LE(cursor + 30), commentLength = buffer.readUInt16LE(cursor + 32);
    const external = buffer.readUInt32LE(cursor + 38), offset = buffer.readUInt32LE(cursor + 42), finish = cursor + 46 + nameLength + extraLength + commentLength;
    if (compressed === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) fail('暂不支持 ZIP64 工作流包。');
    if (method === 0 && compressed !== size) fail('ZIP 未压缩文件的长度记录不一致。');
    if (buffer.readUInt16LE(cursor + 34)) fail('不支持多卷 ZIP。');
    bounds(finish <= end, 'ZIP 中央目录不完整。');
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLength), name = nameText(rawName, flags), directory = register(name);
    const type = (external >>> 16) & 0xf000;
    if (![0, 0x8000, 0x4000].includes(type) || external & 0x400 || type === 0x4000 && !directory
      || type === 0x8000 && directory || external & 0x10 && !directory) fail('ZIP 只能包含普通文件与文件夹，不允许链接或特殊文件。');
    if (directory && size) fail('ZIP 文件夹条目不能包含文件内容。');
    if (size > limits.maxFileBytes || (declaredBytes += size) > limits.maxUncompressedBytes) fail('ZIP 文件或总解压大小超过上限。', 413);
    extraFields(buffer.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength));
    entries.push({ name, rawName, directory, needed, flags, method, crc, compressed, size, offset,
      time: buffer.readUInt16LE(cursor + 12), date: buffer.readUInt16LE(cursor + 14) });
    cursor = finish;
  }
  bounds(cursor === end, 'ZIP 中央目录大小或文件数量不一致。');
  let expectedOffset = 0;
  for (const entry of [...entries].sort((left, right) => left.offset - right.offset)) {
    const offset = entry.offset;
    bounds(offset === expectedOffset && offset + 30 <= centralOffset && buffer.readUInt32LE(offset) === LOCAL,
      'ZIP 局部记录重叠、缺失或含未登记内容。');
    const nameLength = buffer.readUInt16LE(offset + 26), extraLength = buffer.readUInt16LE(offset + 28), dataStart = offset + 30 + nameLength + extraLength;
    bounds(dataStart <= centralOffset && dataStart + entry.compressed <= centralOffset);
    const localName = buffer.subarray(offset + 30, offset + 30 + nameLength);
    bounds(localName.equals(entry.rawName) && buffer.readUInt16LE(offset + 4) === entry.needed
      && buffer.readUInt16LE(offset + 6) === entry.flags && buffer.readUInt16LE(offset + 8) === entry.method
      && buffer.readUInt16LE(offset + 10) === entry.time && buffer.readUInt16LE(offset + 12) === entry.date,
    'ZIP 局部记录与中央目录不一致。');
    extraFields(buffer.subarray(offset + 30 + nameLength, dataStart));
    const values = [buffer.readUInt32LE(offset + 14), buffer.readUInt32LE(offset + 18), buffer.readUInt32LE(offset + 22)];
    const wanted = [entry.crc, entry.compressed, entry.size];
    bounds(values.every((value, index) => value === wanted[index] || !!(entry.flags & 8) && value === 0), 'ZIP 文件大小或校验记录不一致。');
    entry.start = dataStart; entry.end = dataStart + entry.compressed;
    expectedOffset = entry.flags & 8 ? descriptorEnd(buffer, entry.end, entry, centralOffset) : entry.end;
  }
  bounds(expectedOffset === centralOffset, 'ZIP 含未登记的局部文件或额外内容。');
  let actualBytes = 0;
  return entries.map(entry => {
    const compressed = buffer.subarray(entry.start, entry.end); let data;
    if (entry.method === 0) data = Buffer.from(compressed);
    else {
      try {
        const inflated = inflateRawSync(compressed, { info: true,
          maxOutputLength: Math.max(1, Math.min(entry.size + 1, limits.maxFileBytes + 1, limits.maxUncompressedBytes - actualBytes + 1)) });
        bounds(inflated.engine.bytesWritten === compressed.length, 'ZIP 压缩流含多余内容。'); data = inflated.buffer;
      } catch (error) {
        if (error.httpStatus) throw error;
        if (error.code === 'ERR_BUFFER_TOO_LARGE') fail('ZIP 实际解压大小超过上限或声称大小。', 413);
        fail('ZIP 压缩数据损坏。');
      }
    }
    if (data.length > limits.maxFileBytes || (actualBytes += data.length) > limits.maxUncompressedBytes) fail('ZIP 实际解压大小超过上限。', 413);
    bounds(data.length === entry.size && crc32(data) === entry.crc, 'ZIP 文件长度或 CRC 校验失败。');
    return { name: entry.name, data };
  });
}
