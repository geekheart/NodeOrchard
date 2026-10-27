// Runs trusted user-authored local code. A separate process and minimal env keep
// lifecycle/results distinct; this module does not provide an OS sandbox.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { validateWorkflowToolConfig } from '../../shared/workflow/workflow-tools.mjs';

export const OPERATION_LIMITS = Object.freeze({ jsonBytes: 64 * 1024, logBytesPerStream: 32 * 1024 });
const JS_WORKER = fileURLToPath(new URL('./workflow-code-worker.mjs', import.meta.url));
const PY_WORKER = fileURLToPath(new URL('../../python/workflow_code_worker.py', import.meta.url));
const RESULT_CHANNEL_LIMIT = OPERATION_LIMITS.jsonBytes + 20000;
const errorFor = (code, message) => Object.assign(new Error(message), { code });

export function validateOperationNode(node) {
  return validateWorkflowToolConfig(node);
}

function inspectJson(value, label, depth = 0) {
  if (depth > 50) throw errorFor('JSON_INVALID', `${label}嵌套过深。`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length) throw errorFor('JSON_INVALID', `${label}必须是有效 JSON 数据，不能含 undefined 或 NaN。`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    const keys = Object.keys(descriptors).filter(key => key !== 'length');
    if (keys.length !== value.length || keys.some(key => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
      throw errorFor('JSON_INVALID', `${label}数组不能包含空位或额外属性。`);
    }
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!Object.hasOwn(descriptor, 'value')) throw errorFor('JSON_INVALID', `${label}不能包含访问器。`);
    inspectJson(descriptor.value, label, depth + 1);
  }
}

function checkedJson(value, label) {
  inspectJson(value, label);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > OPERATION_LIMITS.jsonBytes) {
    throw errorFor(label === '输出' ? 'OUTPUT_LIMIT' : 'INPUT_LIMIT', `${label}不能超过 64KB JSON。`);
  }
  return { value: JSON.parse(encoded), encoded };
}

function builtin(toolName, input) {
  if (['text.trim', 'text.uppercase', 'json.parse'].includes(toolName) && typeof input !== 'string') {
    throw errorFor('TOOL_INPUT_INVALID', '此工具需要真实文本输入。');
  }
  switch (toolName) {
    case 'text.trim': return input.trim();
    case 'text.uppercase': return input.toUpperCase();
    case 'json.parse': {
      try { return JSON.parse(input); }
      catch { throw errorFor('TOOL_INPUT_INVALID', '输入文本不是有效 JSON。'); }
    }
    case 'json.stringify': return JSON.stringify(input);
    case 'json.keys':
      if (input === null || typeof input !== 'object' || Array.isArray(input)) throw errorFor('TOOL_INPUT_INVALID', '读取字段名需要真实 JSON 对象输入。');
      return Object.keys(input);
    default: throw errorFor('TOOL_UNKNOWN', '未支持的工作台工具。');
  }
}

export function minimalEnvironment(context) {
  const env = {};
  for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SystemRoot', 'SYSTEMROOT', 'WINDIR']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  if (context !== undefined) {
    if (!context || typeof context !== 'object' || Array.isArray(context)) throw errorFor('CONTEXT_INVALID', '代码节点运行上下文无效。');
    for (const [key, variable] of Object.entries({ runId: 'WORKBENCH_RUN_ID', workflowId: 'WORKBENCH_WORKFLOW_ID', nodeId: 'WORKBENCH_NODE_ID', learningId: 'WORKBENCH_LEARNING_ID', attemptId: 'WORKBENCH_ATTEMPT_ID' })) {
      if (context[key] === undefined) continue;
      if (typeof context[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(context[key])) throw errorFor('CONTEXT_INVALID', '代码节点运行上下文标识无效。');
      env[variable] = context[key];
    }
    if (context.outputDirectory !== undefined) {
      if (typeof context.outputDirectory !== 'string' || !isAbsolute(context.outputDirectory)) throw errorFor('CONTEXT_INVALID', '产物目录必须是绝对路径。');
      env.WORKBENCH_OUTPUT_DIRECTORY = context.outputDirectory;
      env.WORKBENCH_NODE_DIRECTORY = context.outputDirectory;
    }
    if (context.runOutputDirectory !== undefined) {
      if (typeof context.runOutputDirectory !== 'string' || !isAbsolute(context.runOutputDirectory)) throw errorFor('CONTEXT_INVALID', '运行产物目录必须是绝对路径。');
      env.WORKBENCH_RUN_OUTPUT_DIRECTORY = context.runOutputDirectory;
    }
    if (context.databasePath !== undefined) {
      if (typeof context.databasePath !== 'string' || !isAbsolute(context.databasePath)) throw errorFor('CONTEXT_INVALID', '运行数据库路径必须是绝对路径。');
      env.WORKBENCH_DATABASE_PATH = context.databasePath;
    }
    if (context.attempt !== undefined) {
      if (!Number.isInteger(context.attempt) || context.attempt < 1) throw errorFor('CONTEXT_INVALID', '节点尝试次数无效。');
      env.WORKBENCH_ATTEMPT = String(context.attempt);
    }
    if (context.reviewFeedback) env.WORKBENCH_REVIEW_FEEDBACK = String(context.reviewFeedback).slice(0, 8000);
  }
  return { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' };
}

function logCollector(stream, onLog) {
  const decoder = new StringDecoder('utf8');
  let bytes = 0;
  let truncated = false;
  const emit = text => {
    if (!text || truncated) return;
    const data = Buffer.from(text, 'utf8');
    const remaining = OPERATION_LIMITS.logBytesPerStream - bytes;
    const overflow = data.length > remaining;
    const output = overflow ? new StringDecoder('utf8').write(data.subarray(0, remaining)) : text;
    bytes += Buffer.byteLength(output, 'utf8');
    if (overflow) truncated = true;
    if (output || overflow) {
      try { onLog?.({ stream, text: output, ...(overflow ? { truncated: true } : {}) }); }
      catch { /* Logging UI/storage callbacks do not execute or change code results. */ }
    }
  };
  return { write: chunk => emit(decoder.write(chunk)), end: () => emit(decoder.end()) };
}

function runCode({ config, input, cwd, signal, onLog, pythonPath, context }) {
  if (signal?.aborted) return Promise.reject(errorFor('ABORTED', '执行已停止。'));
  return new Promise((resolve, reject) => {
    const language = config.language;
    const child = spawn(language === 'python' ? (pythonPath || 'python3') : process.execPath,
      language === 'python' ? ['-B', PY_WORKER] : [JS_WORKER], {
        cwd, env: minimalEnvironment(context), stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32', windowsHide: true,
      });
    const logs = { stdout: logCollector('stdout', onLog), stderr: logCollector('stderr', onLog) };
    const resultChunks = [];
    let resultBytes = 0;
    let failure = null;
    let settled = false;
    let hardTimer;
    const killGroup = signalName => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signalName);
        else child.kill(signalName);
      } catch { /* Already reaped or failed to spawn. */ }
    };
    const settle = (code, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(hardTimer);
      signal?.removeEventListener('abort', abort);
      logs.stdout.end(); logs.stderr.end();
      killGroup('SIGKILL');
      if (failure) { reject(failure); return; }
      let result;
      try { result = JSON.parse(Buffer.concat(resultChunks).toString('utf8')); }
      catch { reject(errorFor('CODE_PROTOCOL_INVALID', `代码进程未返回有效结果${exitSignal ? `（${exitSignal}）` : ''}。`)); return; }
      if (result?.ok !== true || code !== 0 || !Object.hasOwn(result, 'output')) {
        const known = new Set(['CODE_FAILED', 'CODE_ENVIRONMENT', 'OUTPUT_INVALID', 'OUTPUT_LIMIT']);
        reject(errorFor(known.has(result?.error?.code) ? result.error.code : 'CODE_FAILED',
          '代码执行失败：' + String(result?.error?.message || `进程退出码 ${code}`).slice(0, 4000)));
        return;
      }
      resolve(result.output);
    };
    const stop = error => {
      if (settled || failure) return;
      failure = error;
      // The app may exit immediately after abort returns. Send the final group
      // signal synchronously; a delayed escalation would disappear with it.
      killGroup('SIGKILL');
      hardTimer = setTimeout(() => {
        killGroup('SIGKILL');
        for (const stream of child.stdio) stream?.destroy();
        settle(null, 'SIGKILL');
      }, 1500);
    };
    const abort = () => stop(errorFor('ABORTED', '执行已停止。'));
    const timeout = setTimeout(() => stop(errorFor('TIMEOUT', '代码执行超时，已停止进程。')),
      (config.timeoutSeconds ?? 120) * 1000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => logs.stdout.write(chunk));
    child.stderr.on('data', chunk => logs.stderr.write(chunk));
    child.stdio[3].on('data', chunk => {
      resultBytes += chunk.length;
      if (resultBytes > RESULT_CHANNEL_LIMIT) { stop(errorFor('OUTPUT_LIMIT', '代码结果通道超过允许大小。')); return; }
      resultChunks.push(chunk);
    });
    child.stdin.on('error', () => {});
    child.on('error', () => { failure ||= errorFor('CODE_START_FAILED', '无法启动代码解释器，请检查本地安装路径。'); });
    child.once('exit', () => killGroup('SIGKILL'));
    child.once('close', settle);
    child.stdin.end(JSON.stringify({ code: config.code, input, context: context || {} }));
    // An AbortSignal can transition between the initial check and registration.
    if (signal?.aborted) abort();
  });
}

export async function executeOperation({ node, input, cwd, signal, onLog, pythonPath, context } = {}) {
  const selected = validateOperationNode(node);
  const config = { ...node.config };
  if (signal?.aborted) throw errorFor('ABORTED', '执行已停止。');
  const preparedInput = checkedJson(input, '输入').value;
  let output;
  let runtime;
  if (selected.kind === 'tool') {
    output = selected.toolName.startsWith('hdk.')
      ? await (await import('./workflow-capabilities.mjs')).executeCapability({ toolName: selected.toolName, input: preparedInput, cwd, signal, onLog, context, pythonPath })
      : builtin(selected.toolName, preparedInput);
    runtime = { ...selected, revision: `builtin:${selected.toolName}@1` };
  } else {
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || !(await stat(cwd).catch(() => null))?.isDirectory()) {
      throw errorFor('WORKSPACE_INVALID', '代码执行需要现有的工作区目录。');
    }
    if (signal?.aborted) throw errorFor('ABORTED', '执行已停止。');
    output = await runCode({ config, input: preparedInput, cwd, signal, onLog, pythonPath, context });
    runtime = { ...selected, revision: `sha256:${createHash('sha256').update(config.language + '\n' + config.code, 'utf8').digest('hex')}` };
  }
  const checked = checkedJson(output, '输出');
  return { output: checked.value, outputText: typeof checked.value === 'string' ? checked.value : checked.encoded, runtime };
}
