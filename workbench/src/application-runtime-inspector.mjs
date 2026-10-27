import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { minimalEnvironment } from './workflows/workflow-operations.mjs';
import { CODE_LANGUAGES } from '../shared/workflow/workflow-model.mjs';

const execute = promisify(execFile);
export const RUNTIME_INSPECTION_LIMITS = Object.freeze({ modules: 20, timeoutMs: 4000, outputBytes: 16384 });
const supportedLanguages = CODE_LANGUAGES;
const errorFor = (code, message) => Object.assign(new Error(message), { code });
const check = signal => { if (signal?.aborted) throw errorFor('ABORTED', '运行环境检查已停止。'); };
const PYTHON_PROBE = `import importlib.util, json, platform, sys
names = json.loads(sys.argv[1])
print(json.dumps({'version': platform.python_version(), 'modules': [{'name': name, 'available': importlib.util.find_spec(name) is not None} for name in names]}))
`;
const JAVASCRIPT_PROBE = `import { createRequire } from 'node:module';
const require = createRequire(process.argv[2]);
const modules = JSON.parse(process.argv[1]).map(name => {
  try { require.resolve(name); return { name, available: true }; }
  catch (error) { if (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return { name, available: false }; throw error; }
});
console.log(JSON.stringify({ version: process.versions.node, modules }));
`;

function parameters(input) {
  const invalid = () => { throw errorFor('RUNTIME_ARGUMENT_INVALID', '检查参数仅支持语言及最多20个顶层模块标识，不能包含路径、代码或表达式。'); };
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Object.getOwnPropertySymbols(input).length) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.entries(descriptors).some(([key, item]) => !['language', 'modules'].includes(key) || !Object.hasOwn(item, 'value'))) invalid();
  const language = descriptors.language?.value === undefined ? 'python' : descriptors.language.value;
  const modules = descriptors.modules?.value === undefined ? [] : descriptors.modules.value;
  if (!supportedLanguages.includes(language) || !Array.isArray(modules) || modules.length > RUNTIME_INSPECTION_LIMITS.modules
    || Object.getOwnPropertySymbols(modules).length) invalid();
  const entries = Object.entries(Object.getOwnPropertyDescriptors(modules)).filter(([key]) => key !== 'length');
  if (entries.length !== modules.length || entries.some(([key, item]) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= modules.length
    || !Object.hasOwn(item, 'value') || typeof item.value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(item.value))) invalid();
  return { language, names: [...new Set(entries.map(([, item]) => item.value))] };
}

export async function inspectCodeRuntime(app, input = {}, { signal, runner = execute } = {}) {
  const { language, names } = parameters(input);
  check(signal);
  const cwd = await mkdtemp(join(tmpdir(), 'workbench-runtime-inspect-'));
  try {
    check(signal);
    let output;
    try {
      output = await runner(language === 'python' ? (app?.config?.hermesPython || 'python3') : process.execPath,
        language === 'python' ? ['-B', '-c', PYTHON_PROBE, JSON.stringify(names)]
          : ['--input-type=module', '-e', JAVASCRIPT_PROBE, JSON.stringify(names), new URL('./workflows/workflow-code-worker.mjs', import.meta.url).href], {
        cwd, env: minimalEnvironment(), timeout: RUNTIME_INSPECTION_LIMITS.timeoutMs,
        maxBuffer: RUNTIME_INSPECTION_LIMITS.outputBytes, signal, killSignal: 'SIGKILL', windowsHide: true,
      });
    } catch (error) {
      check(signal);
      if (error?.code === 'ABORT_ERR') throw errorFor('ABORTED', '运行环境检查已停止。');
      if (error?.killed) throw errorFor('RUNTIME_TIMEOUT', '运行环境检查超时，未确认环境可用。');
      throw errorFor(error?.code === 'ENOENT' || error?.code === 'EACCES' ? 'RUNTIME_START_FAILED' : 'RUNTIME_FAILED',
        '无法完成运行环境检查，未确认解释器或库可用。');
    }
    check(signal);
    let result;
    try { result = JSON.parse(output.stdout); }
    catch { throw errorFor('RUNTIME_PROTOCOL_INVALID', '运行环境检查未返回有效结果。'); }
    if (!result || typeof result.version !== 'string' || !/^\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/.test(result.version)
      || !Array.isArray(result.modules) || result.modules.length !== names.length
      || result.modules.some((item, index) => item?.name !== names[index] || typeof item.available !== 'boolean')) {
      throw errorFor('RUNTIME_PROTOCOL_INVALID', '运行环境检查返回内容不完整，未确认环境可用。');
    }
    return { language, supportedLanguages: [...supportedLanguages], available: true, version: result.version,
      nodeVersion: process.version, modules: result.modules.map(({ name, available }) => ({ name, available })), libraryProbe: language === 'python' ? 'spec-only' : 'resolve-only',
      policy: { readOnly: true, fixedScript: true, installsPackages: false, codeSubprocessIsOsSandbox: false,
        codeCandidateRequiresToolRegistration: false },
      limitations: ['只检查模块能否被找到，不导入第三方模块；实际导入及业务兼容性需在代码节点验证。',
        ...(language === 'javascript' ? ['JavaScript 按代码执行器位置检查 Node 模块解析；仅提供 import 导出的包仍需在实际代码节点验证。'] : []),
        '代码节点使用独立子进程与最小环境变量，不是操作系统沙箱。', '代码候选可以直接使用代码节点，无需先注册为工具。'] };
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
