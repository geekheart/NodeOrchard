export function safeText(value) {
  return String(value ?? '').replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[已隐藏密钥]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已隐藏]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|csrf[_ -]?token|password|authorization)["']?\s*[:=]\s*["']?)([^\s"',;}\]]+)/gi, '$1[已隐藏]');
}
export function redact(value, seen = new WeakSet()) {
  if (typeof value === 'string') return safeText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[循环引用]'; seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    ['key', 'apikey', 'token', 'accesstoken', 'refreshtoken', 'csrftoken', 'authorization', 'cookie', 'setcookie', 'password', 'secret', 'credentials', 'credential', 'clientsecret', 'idtoken'].includes(key.toLowerCase().replace(/[^a-z]/g, '')) ? '[已隐藏]' : redact(entry, seen)]));
}

// Diagnostic previews only. Runtime events and durable run records stay intact.
export const DIAGNOSTIC_LIMITS = Object.freeze({ eventBytes: 32 * 1024, bufferBytes: 2 * 1024 * 1024,
  eventCount: 200, depth: 8, entries: 40, nodes: 512, stringCharacters: 2048 });
const encoder = new TextEncoder();
const size = text => encoder.encode(text).length;
const clip = (text, bytes) => new TextDecoder().decode(encoder.encode(text).subarray(0, Math.max(0, bytes)), { stream: true });

export function diagnosticSnapshot(input, { redact: redactValue = redact } = {}) {
  const reasons = new Set(), seen = new WeakSet(); let budget = DIAGNOSTIC_LIMITS.eventBytes / 2, nodes = 0;
  const omit = reason => { reasons.add(reason); return `[${reason}]`; };
  const text = value => {
    if (/^data:[^,]{0,160};base64,/.test(value.slice(0, 180))) return omit('二进制 data URL 已省略');
    const characters = Math.min(DIAGNOSTIC_LIMITS.stringCharacters, Math.max(0, Math.floor(budget / 3)));
    let result = value.slice(0, characters);
    if (result.length < value.length) result += omit('长文本已截断');
    budget -= size(result) + 8; return result;
  };
  const visit = (value, depth) => {
    if (++nodes > DIAGNOSTIC_LIMITS.nodes || budget <= 0) return omit('诊断容量上限');
    budget -= 16;
    if (typeof value === 'string') return text(value);
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value !== 'object') return `[${typeof value}]`;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return omit(`二进制 ${value.byteLength} bytes 已省略`);
    if (typeof Blob !== 'undefined' && value instanceof Blob) return omit(`二进制 Blob ${value.size} bytes 已省略`);
    if (seen.has(value)) return omit('循环或重复引用已省略');
    if (depth >= DIAGNOSTIC_LIMITS.depth) return omit('嵌套层级上限');
    seen.add(value);
    if (Array.isArray(value)) {
      const result = [];
      for (let index = 0; index < Math.min(value.length, DIAGNOSTIC_LIMITS.entries) && budget > 0; index++) {
        const property = Object.getOwnPropertyDescriptor(value, String(index));
        result.push(property && Object.hasOwn(property, 'value') ? visit(property.value, depth + 1) : '[未读取访问器]');
      }
      if (result.length < value.length) result.push(omit(`数组其余 ${value.length - result.length} 项已省略`));
      return result;
    }
    const result = Object.create(null); let count = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (++count > DIAGNOSTIC_LIMITS.entries || budget <= 0) { result['…'] = omit('其余字段已省略'); break; }
      const property = Object.getOwnPropertyDescriptor(value, key), name = key.slice(0, 120);
      budget -= size(name) + 8;
      result[name] = property && Object.hasOwn(property, 'value') ? visit(property.value, depth + 1) : '[未读取访问器]';
    }
    return result;
  };
  let value;
  try { value = redactValue(visit(input, 0)); }
  catch { value = '[诊断快照无法读取]'; reasons.add('诊断快照无法读取'); }
  return { value, truncated: reasons.size > 0, reasons: [...reasons],
    retainedBytes: Math.min(DIAGNOSTIC_LIMITS.eventBytes, Math.max(512, DIAGNOSTIC_LIMITS.eventBytes / 2 - budget + nodes * 32)) };
}

export function diagnosticEvent(event, options) {
  const preview = diagnosticSnapshot(event, options);
  const source = event.payload?.run || event.payload?.schedule || event.payload || {};
  const metadata = { id: event.id, type: event.type, at: event.at, sessionId: event.sessionId,
    status: source.status, currentNodeId: source.currentNodeId, title: source.title };
  const snapshot = diagnosticSnapshot(Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined)), options).value;
  return { id: snapshot.id, type: snapshot.type || '未知事件', at: snapshot.at, sessionId: snapshot.sessionId,
    summary: [snapshot.status, snapshot.currentNodeId, snapshot.title].filter(value => typeof value === 'string').join(' · ').slice(0, 180),
    preview };
}

export function appendDiagnosticEvent(events, event, options) {
  const result = [...events, diagnosticEvent(event, options)];
  let bytes = result.reduce((total, item) => total + item.preview.retainedBytes, 0);
  while (result.length > 1 && (result.length > DIAGNOSTIC_LIMITS.eventCount || bytes > DIAGNOSTIC_LIMITS.bufferBytes)) {
    bytes -= result.shift().preview.retainedBytes;
  }
  return result;
}

export function formatDiagnosticEvent(event) {
  const preview = event.preview;
  const body = JSON.stringify(preview.value, null, 2) ?? 'null';
  const truncated = preview.truncated || size(body) > DIAGNOSTIC_LIMITS.eventBytes;
  const notice = truncated ? '【诊断预览已截断，单条最多 32 KiB；完整数据请查看运行记录。】\n' : '';
  return notice + clip(body, DIAGNOSTIC_LIMITS.eventBytes - size(notice));
}
