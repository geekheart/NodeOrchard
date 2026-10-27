// Trusted local code runner, not an OS sandbox. The result uses fd 3 so normal
// console/stdout/stderr logs cannot become workflow data accidentally.
import { writeFileSync } from 'node:fs';

const MAX_JSON_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 600000;
const ENVIRONMENT_CODES = new Set([
  'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED',
  'ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ENOSPC', 'EDQUOT', 'EROFS', 'EMFILE', 'ENFILE', 'EIO',
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED', 'CERT_REJECTED', 'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_DECRYPT_CERT_SIGNATURE', 'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_HANDSHAKE_TIMEOUT', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_DESTROYED',
]);
const errorProperty = (value, key) => { try { return value?.[key]; } catch { return undefined; } };

// Only typed errors identify a known environment failure. Free-form business
// messages and unknown error codes do not become environment diagnoses.
function errorCode(error) {
  const code = errorProperty(error, 'code');
  if (['OUTPUT_INVALID', 'OUTPUT_LIMIT'].includes(code)) return code;
  const seen = new Set(); let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current);
    if (ENVIRONMENT_CODES.has(errorProperty(current, 'code'))) return 'CODE_ENVIRONMENT';
    current = errorProperty(current, 'cause');
  }
  return 'CODE_FAILED';
}

function jsonValue(value, depth = 0) {
  if (depth > 50) throw Object.assign(new Error('结果嵌套过深。'), { code: 'OUTPUT_INVALID' });
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length) throw Object.assign(new Error('代码必须返回有效 JSON 数据，不能返回 undefined、NaN 或特殊对象。'), { code: 'OUTPUT_INVALID' });
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    const keys = Object.keys(descriptors).filter(key => key !== 'length');
    if (keys.length !== value.length || keys.some(key => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
      throw Object.assign(new Error('结果数组不能包含空位或额外属性。'), { code: 'OUTPUT_INVALID' });
    }
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!Object.hasOwn(descriptor, 'value')) throw Object.assign(new Error('结果不能包含访问器。'), { code: 'OUTPUT_INVALID' });
    jsonValue(descriptor.value, depth + 1);
  }
}

const flush = stream => new Promise(resolve => {
  try { stream.write('', resolve); } catch { resolve(); }
});

let envelope;
let exitCode = 0;
try {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_REQUEST_BYTES) throw new Error('代码请求过大。');
    chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof request.code !== 'string' || !request.code.trim() || request.code.length > 100000) throw new Error('代码函数体无效。');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const main = new AsyncFunction('input', 'context', request.code);
  const output = await main(request.input, Object.freeze(request.context || {}));
  jsonValue(output);
  const encoded = JSON.stringify(output);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_JSON_BYTES) {
    throw Object.assign(new Error('代码输出不能超过 64KB JSON。'), { code: 'OUTPUT_LIMIT' });
  }
  envelope = { ok: true, output };
} catch (error) {
  envelope = { ok: false, error: { code: errorCode(error), message: String(error?.message || error).slice(0, 4000) } };
  exitCode = 1;
}
await Promise.all([flush(process.stdout), flush(process.stderr)]);
writeFileSync(3, JSON.stringify(envelope) + '\n');
process.exit(exitCode);
