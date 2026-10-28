import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { sanitizeDiagnosticText } from './app-diagnostics.mjs';

export const RUNTIME_SOURCE_COMPONENTS = Object.freeze({
  'codex-stream': 'agent/codex_runtime.py',
  'provider-call': 'agent/chat_completion_helpers.py',
  'request-client': 'agent/client_lifecycle.py',
  'client-factory': 'agent/agent_runtime_helpers.py',
  'gateway-output': 'tui_gateway/prompt_turn.py',
});
const MAX_FILE = 256 * 1024, MAX_PAGE = 1800;
const fail = (message, code, httpStatus = 403) => Object.assign(new Error(message), { code, httpStatus });
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;

// Only verified source files use this display projection. These are literal
// program tags, not a control session's reasoning or message body.
export const escapeSourceMarkup = value => value.replace(/<(?=\/?(?:think|thinking|analysis|reasoning)\b)/gi, '&lt;');
export function sourceDisplayText(value) {
  const escaped = escapeSourceMarkup(value);
  return { content: sanitizeDiagnosticText(escaped, { preserveLines: true }), sourceMarkupEscaped: escaped !== value };
}

// The caller supplies only a component. Installation roots come from trusted
// process configuration; no Python import, configuration read or execution occurs.
export async function readRuntimeSource(config, component, checkpoint = async () => {}) {
  if (typeof component !== 'string' || !Object.hasOwn(RUNTIME_SOURCE_COMPONENTS, component)) throw fail('未开放此诊断源码组件。', 'SOURCE_RUNTIME_COMPONENT_INVALID', 400);
  if (typeof config?.hermesRoot !== 'string' || !isAbsolute(config.hermesRoot)) throw fail('Hermes诊断源码不可用。', 'SOURCE_RUNTIME_UNAVAILABLE', 404);
  let handle;
  try {
    await checkpoint(); const root = await realpath(config.hermesRoot); await checkpoint();
    const path = RUNTIME_SOURCE_COMPONENTS[component], parts = path.split('/'), entries = [];
    let absolute = root;
    for (const [index, part] of ['', ...parts].entries()) {
      if (part) absolute = join(absolute, part);
      const stat = await lstat(absolute); await checkpoint();
      const file = index === parts.length;
      if (stat.isSymbolicLink() || (file ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw fail('诊断源码不允许链接或特殊文件。', 'SOURCE_LINK_FORBIDDEN');
      if (file && stat.size > MAX_FILE) throw fail('诊断源码超过单文件容量。', 'SOURCE_FILE_UNAVAILABLE', 413);
      entries.push({ path: absolute, stat });
    }
    const original = entries.at(-1).stat;
    const verify = async () => {
      if (await realpath(config.hermesRoot) !== root || await realpath(absolute) !== absolute) throw fail('诊断源码路径已变化。', 'SOURCE_RUNTIME_CHANGED', 409);
      await checkpoint();
      for (const entry of entries) {
        const current = await lstat(entry.path); await checkpoint();
        if (current.isSymbolicLink() || !sameIdentity(entry.stat, current)) throw fail('诊断源码路径已变化。', 'SOURCE_RUNTIME_CHANGED', 409);
      }
    };
    await verify(); handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); await checkpoint();
    const opened = await handle.stat(); await checkpoint();
    if (!sameIdentity(original, opened) || !opened.isFile() || opened.nlink !== 1 || opened.size !== original.size) throw fail('诊断源码文件已变化。', 'SOURCE_RUNTIME_CHANGED', 409);
    await verify();
    const bytes = Buffer.alloc(opened.size); let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset); await checkpoint();
      if (!result.bytesRead) break; offset += result.bytesRead;
    }
    const final = await handle.stat(); await checkpoint(); await verify();
    if (offset !== bytes.length || !sameIdentity(opened, final) || final.nlink !== 1 || final.size !== opened.size
      || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) throw fail('诊断源码内容已变化。', 'SOURCE_RUNTIME_CHANGED', 409);
    const content = bytes.toString('utf8');
    if (content.includes('\0') || !Buffer.from(content).equals(bytes)) throw fail('诊断源码必须是UTF-8文本。', 'SOURCE_TEXT_INVALID', 400);
    return { origin: 'hermes-installed', component, path, content, hash: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    if (error.httpStatus) throw error;
    throw fail('Hermes诊断源码不可用。', 'SOURCE_RUNTIME_UNAVAILABLE', 404);
  } finally { await handle?.close(); }
}

export function sourceReadPage(source, { startLine = 1, startColumn = 1, lineCount = 120 } = {}) {
  if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(startColumn) || startColumn < 1
    || !Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > 300) throw fail('源码行列范围无效。', 'SOURCE_REPAIR_INVALID', 400);
  const display = sourceDisplayText(source.content), lines = display.content.split('\n'), first = lines[startLine - 1], offset = startColumn - 1;
  if (first === undefined ? offset !== 0 : offset > first.length || offset > 0 && /[\uDC00-\uDFFF]/.test(first[offset] || '') && /[\uD800-\uDBFF]/.test(first[offset - 1])) throw fail('源码起始列无效。', 'SOURCE_REPAIR_INVALID', 400);
  let content = '', endLine = null, readLineCount = 0, nextStartLine = null, nextStartColumn = null;
  for (let index = startLine - 1; index < Math.min(lines.length, startLine - 1 + lineCount); index++) {
    const line = lines[index], begin = index === startLine - 1 ? offset : 0, separator = readLineCount ? '\n' : '';
    const remaining = MAX_PAGE - content.length - separator.length;
    let end = Math.min(line.length, begin + Math.max(0, remaining));
    if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1] || '') && /[\uDC00-\uDFFF]/.test(line[end])) end--;
    const redaction = line.lastIndexOf('[REDACTED]', end - 1);
    if (redaction >= begin && redaction + '[REDACTED]'.length > end) end = redaction;
    if (remaining < 0 || end === begin && begin < line.length) { nextStartLine = index + 1; nextStartColumn = begin + 1; break; }
    content += separator + line.slice(begin, end); endLine = index + 1; readLineCount++;
    if (end < line.length) { nextStartLine = index + 1; nextStartColumn = end + 1; break; }
    nextStartLine = index + 1 < lines.length ? index + 2 : null; nextStartColumn = nextStartLine === null ? null : 1;
  }
  return { path: source.path, hash: source.hash, ...(source.origin ? { origin: source.origin, component: source.component } : {}), sourceMarkupEscaped: display.sourceMarkupEscaped,
    content, startLine, startColumn, endLine, readLineCount, totalLines: lines.length, truncated: nextStartLine !== null, nextStartLine, nextStartColumn };
}
