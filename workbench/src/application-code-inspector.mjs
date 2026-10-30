import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimalEnvironment } from './workflows/workflow-operations.mjs';
import { sanitizeDiagnosticText } from './app-diagnostics.mjs';

export const CODE_INSPECTION_LIMITS = Object.freeze({ timeoutMs: 5000, outputBytes: 32768, codeCharacters: 100000, scriptVariables: 8 });
const worker = fileURLToPath(new URL('../python/workflow_code_validation.py', import.meta.url));
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  && !['__proto__', 'prototype', 'constructor'].includes(value);
const fail = (code, message, httpStatus = 400) => { throw Object.assign(new Error(message), { code, httpStatus }); };
const check = signal => { if (signal?.aborted) fail('ABORTED', '代码静态检查已停止。', 409); };

function parameters(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Reflect.ownKeys(input).some(key => !['workflowId', 'nodeId', 'runId', 'pythonScriptVariables'].includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(input)).some(field => !Object.hasOwn(field, 'value'))) fail('CODE_CHECK_ARGUMENT_INVALID', '代码检查参数无效。');
  const { workflowId, nodeId, runId, pythonScriptVariables = [] } = input;
  if (!id(workflowId) || !id(nodeId) || runId !== undefined && !id(runId) || !Array.isArray(pythonScriptVariables)
    || pythonScriptVariables.length > CODE_INSPECTION_LIMITS.scriptVariables
    || Reflect.ownKeys(pythonScriptVariables).length !== pythonScriptVariables.length + 1
    || Array.from({ length: pythonScriptVariables.length }, (_, index) => Object.getOwnPropertyDescriptor(pythonScriptVariables, String(index)))
      .some(field => !field || !Object.hasOwn(field, 'value') || typeof field.value !== 'string' || !/^(?!__)[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(field.value))) {
    fail('CODE_CHECK_ARGUMENT_INVALID', '请绑定工作流与代码节点，仅可指定最多8个静态Python子脚本变量名。');
  }
  return { workflowId, nodeId, runId, pythonScriptVariables: [...new Set(pythonScriptVariables)] };
}

function runValidator(command, args, options, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', bytes = 0, overflow = false;
    const collect = chunk => { bytes += chunk.length; if (bytes > CODE_INSPECTION_LIMITS.outputBytes) { overflow = true; child.kill('SIGKILL'); } };
    child.stdout.on('data', chunk => { collect(chunk); if (!overflow) stdout += chunk.toString('utf8'); });
    child.stderr.on('data', collect);
    child.stdin.on('error', () => {});
    child.once('error', reject);
    child.once('close', (code, signal) => overflow
      ? reject(Object.assign(new Error(), { code: 'OUTPUT_LIMIT' }))
      : code === 0 ? resolve({ stdout }) : reject(Object.assign(new Error(), { code: 'VALIDATOR_FAILED', signal })));
    child.stdin.end(request);
  });
}

export async function inspectWorkflowCode(app, input, { signal, document, runner = runValidator } = {}) {
  const { workflowId, nodeId, runId, pythonScriptVariables } = parameters(input);
  check(signal);
  app.workflowLibrary.assertAvailable(workflowId);
  let source, revision = null;
  if (runId) {
    const run = app.workflows.get(runId);
    if (!run || run.workflowId !== workflowId || run.parentRunId || run.learningId || run.memoryScopeId) {
      fail('CODE_CHECK_SCOPE_INVALID', '运行不属于指定工作流的普通业务快照。', 403);
    }
    source = run.document;
  } else if (document?.id === workflowId) source = document;
  else {
    const record = app.workflowLibrary.get(workflowId);
    source = record.document; revision = record.revision;
  }
  if (!source || source.id !== workflowId || source.mode === 'learn') fail('CODE_CHECK_SCOPE_INVALID', '没有可读取的普通工作流快照。', 403);
  const node = source.nodes?.find(item => item.id === nodeId);
  if (!node || !['tool', 'transform'].includes(node.type) || node.type === 'tool' && node.config?.executionMode !== 'code'
    || node.config?.language !== 'python' || typeof node.config.code !== 'string') fail('CODE_CHECK_NODE_INVALID', '只支持指定工作流中的Python代码节点。');
  const code = node.config.code;
  if (code.length > CODE_INSPECTION_LIMITS.codeCharacters) fail('CODE_CHECK_TOO_LARGE', '代码超过静态检查的大小限制。', 413);
  const codeSha256 = createHash('sha256').update(code).digest('hex');
  const cwd = await mkdtemp(join(tmpdir(), 'workbench-code-inspect-'));
  try {
    check(signal);
    let output;
    try {
      output = await runner(app.config?.hermesPython || 'python3', ['-B', worker], {
        cwd, env: minimalEnvironment(), timeout: CODE_INSPECTION_LIMITS.timeoutMs,
        signal, killSignal: 'SIGKILL', windowsHide: true,
      }, JSON.stringify({ code, pythonScriptVariables }));
    } catch (error) {
      check(signal);
      fail(error.code === 'OUTPUT_LIMIT' ? 'CODE_CHECK_OUTPUT_LIMIT' : 'CODE_CHECK_UNAVAILABLE', '静态检查未完成，不能确认语法有效。', 409);
    }
    check(signal);
    let result;
    try { result = JSON.parse(output.stdout); } catch { fail('CODE_CHECK_PROTOCOL_INVALID', '静态检查结果无效。', 502); }
    if (result?.version !== 1 || result.language !== 'python' || result.analysisOnly !== true || result.executed !== false
      || !['valid', 'invalid'].includes(result.status) || typeof result.body?.valid !== 'boolean'
      || (result.body.valid ? result.wrapper?.kind !== 'ast-function' || result.wrapper.stringConstantsPreserved !== true : result.wrapper !== null)
      || !Array.isArray(result.nestedScripts) || result.nestedScripts.length > pythonScriptVariables.length
      || result.nestedScripts.some(item => !pythonScriptVariables.includes(item.variable) || !['valid', 'invalid', 'unavailable'].includes(item.status))
      || result.body.valid && (result.nestedScripts.length !== pythonScriptVariables.length
        || result.nestedScripts.some((item, index) => item.variable !== pythonScriptVariables[index]))
      || result.status !== (!result.body.valid || result.nestedScripts.some(item => item.status === 'invalid') ? 'invalid' : 'valid')) {
      fail('CODE_CHECK_PROTOCOL_INVALID', '静态检查结果不符合执行器协议。', 502);
    }
    const text = value => typeof value === 'string' ? sanitizeDiagnosticText(value).slice(0, 240) : '';
    const errorView = error => ({ type: text(error?.type), message: text(error?.message),
      line: Number.isSafeInteger(error?.line) && error.line >= 0 ? error.line : null,
      column: Number.isSafeInteger(error?.column) && error.column >= 0 ? error.column : null });
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    return { version: 1, language: 'python', analysisOnly: true, executed: false, status: result.status,
      body: { valid: result.body.valid, ...(result.body.error ? { error: errorView(result.body.error) } : {}) },
      wrapper: result.wrapper ? { kind: 'ast-function', stringConstantsPreserved: true,
        sourceStringConstants: count(result.wrapper.sourceStringConstants), wrappedStringConstants: count(result.wrapper.wrappedStringConstants) } : null,
      nestedScripts: result.nestedScripts.map(item => ({ variable: item.variable, status: item.status,
        kind: ['literal', 'literal-template'].includes(item.kind) ? item.kind : null, substitutionsEvaluated: false,
        ...(item.error ? { error: errorView(item.error) } : {}), ...(item.reason ? { reason: text(item.reason) } : {}) })),
      limits: CODE_INSPECTION_LIMITS,
      limitations: ['仅检查语法与真实函数体包装，不导入依赖、不执行代码，不保证环境、业务或产物正确。',
        '静态子脚本或replace模板只检查原始字面量，动态替换后的实际脚本仍未验证。'],
      workflowId, nodeId, runId: runId || null, source: runId ? 'frozen-run' : document?.id === workflowId ? 'current-draft' : 'saved-workflow',
      revision, codeSha256,
      policy: { readOnly: true, executesUserCode: false, importsUserModules: false, installsDependencies: false },
    };
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
