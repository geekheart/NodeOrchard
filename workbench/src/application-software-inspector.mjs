import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { access, stat, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { minimalEnvironment } from './workflows/workflow-operations.mjs';

export const SOFTWARE_INSPECTION_LIMITS = Object.freeze({ software: 3, candidates: 8, pathEntries: 128,
  pathLength: 2048, timeoutMs: 4000, outputBytes: 16384 });
const SOFTWARE = Object.freeze({
  blender: { commands: ['blender', 'Blender'], bundle: 'Blender.app', cli: ['Contents/MacOS/Blender', 'Contents/MacOS/blender'],
    args: ['--background', '--factory-startup', '--version'], version: /^Blender[ \t]+(\d{1,4}\.\d{1,4}(?:\.\d{1,4})?)(?=[ \t\r\n(]|$)/m },
  freecad: { commands: ['freecadcmd', 'FreeCADCmd'], bundle: 'FreeCAD.app',
    cli: ['Contents/Resources/bin/freecadcmd', 'Contents/Resources/bin/FreeCADCmd', 'Contents/MacOS/FreeCADCmd', 'Contents/MacOS/freecadcmd'],
    args: ['--version'], version: /^FreeCAD[ \t]+(\d{1,4}\.\d{1,4}(?:\.\d{1,4})?)(?=[ \t\r\n(]|$)/m },
  ffmpeg: { commands: ['ffmpeg'], cli: [], args: ['-version'],
    version: /^ffmpeg version[ \t]+(\d{1,4}\.\d{1,4}(?:\.\d{1,4})?)(?=[ \t\r\n(]|$)/m },
});
const execute = promisify(execFile);
const SIGNALS = new Set(['SIGABRT', 'SIGTERM', 'SIGKILL', 'SIGSEGV', 'SIGILL', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGINT']);
const fail = (code, message) => Object.assign(new Error(message), { code });
const check = signal => { if (signal?.aborted) throw fail('ABORTED', '软件检查已停止。'); };
const safePath = value => typeof value === 'string' && value.length <= SOFTWARE_INSPECTION_LIMITS.pathLength
  && isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value);

function parameters(input) {
  const invalid = () => { throw fail('SOFTWARE_ARGUMENT_INVALID', '仅支持已知软件标识及是否验证启动，不接受命令、路径、参数或脚本。'); };
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Object.getOwnPropertySymbols(input).length) invalid();
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Object.entries(fields).some(([key, descriptor]) => !['software', 'verifyLaunch'].includes(key) || !Object.hasOwn(descriptor, 'value'))) invalid();
  const ids = fields.software?.value === undefined ? Object.keys(SOFTWARE) : fields.software.value;
  const verifyLaunch = fields.verifyLaunch?.value === undefined ? false : fields.verifyLaunch.value;
  if (typeof verifyLaunch !== 'boolean' || !Array.isArray(ids) || ids.length < 1 || ids.length > 3
    || Object.getOwnPropertySymbols(ids).length) invalid();
  const entries = Object.entries(Object.getOwnPropertyDescriptors(ids)).filter(([key]) => key !== 'length');
  if (entries.length !== ids.length || entries.some(([key, descriptor]) => !/^(0|[1-9]\d*)$/.test(key)
    || Number(key) >= ids.length || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string'
    || !Object.hasOwn(SOFTWARE, descriptor.value))) invalid();
  return { ids: [...new Set(entries.map(([, descriptor]) => descriptor.value))], verifyLaunch };
}

async function fileCandidate(path, source) {
  if (!safePath(path)) return null;
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  const executable = await access(path, constants.X_OK).then(() => true, () => false);
  return { path, source, executable, identity: `${info.dev}:${info.ino}` };
}

async function discover(id, { path, platform, applicationDirectories, signal }) {
  const definition = SOFTWARE[id], candidates = [], seen = new Set(), identities = new Set();
  const add = async (candidatePath, source) => {
    check(signal);
    if (seen.has(candidatePath) || candidates.length >= SOFTWARE_INSPECTION_LIMITS.candidates) return;
    seen.add(candidatePath);
    const candidate = await fileCandidate(candidatePath, source);
    if (candidate && !identities.has(candidate.identity)) {
      identities.add(candidate.identity);
      candidates.push({ path: candidate.path, source: candidate.source, executable: candidate.executable });
    }
  };
  const directories = [...new Set(path.split(platform === 'win32' ? ';' : ':', SOFTWARE_INSPECTION_LIMITS.pathEntries))].filter(safePath);
  for (const directory of directories) for (const command of definition.commands) {
    await add(join(directory, platform === 'win32' ? command + '.exe' : command), 'path');
  }
  let bundleFound = false;
  if (platform === 'darwin' && definition.bundle) for (const directory of applicationDirectories.slice(0, 2).filter(safePath)) {
    const bundle = join(directory, definition.bundle);
    bundleFound ||= Boolean((await stat(bundle).catch(() => null))?.isDirectory());
    for (const relative of definition.cli) await add(join(bundle, relative), 'macos-app');
  }
  check(signal);
  const selected = candidates.find(candidate => candidate.executable) || candidates[0] || null;
  const installed = bundleFound || candidates.length > 0;
  return { id, installed, installationStatus: installed ? 'found' : 'not-found',
    pathVisible: candidates.some(candidate => candidate.source === 'path' && candidate.executable),
    executable: selected?.executable === true, selectedPath: selected?.path ?? null, candidates,
    launch: { status: 'not-requested', version: null, errorCode: null, exitCode: null, signal: null, durationMs: null } };
}

function failureCode(error, stdout, stderr) {
  const text = stdout + '\n' + stderr;
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'SOFTWARE_OUTPUT_LIMIT';
  if (error?.killed || error?.code === 'ETIMEDOUT') return 'SOFTWARE_TIMEOUT';
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'SOFTWARE_PERMISSION_DENIED';
  if (['ENOENT', 'ENOTDIR', 'ENOEXEC'].includes(error?.code)) return 'SOFTWARE_START_FAILED';
  if (/Incompatible processor[\s\S]{0,200}requires the following features/i.test(text)) return 'SOFTWARE_CPU_FEATURE_UNAVAILABLE';
  if (/Library not loaded|image not found|symbol not found|undefined symbol|cannot open shared object/i.test(text)) return 'SOFTWARE_LIBRARY_UNAVAILABLE';
  if (/platform plugin|qt\.qpa/i.test(text)) return 'SOFTWARE_QT_PLUGIN_UNAVAILABLE';
  if (/Fatal Python error|ModuleNotFoundError|ImportError/i.test(text)) return 'SOFTWARE_PYTHON_RUNTIME_UNAVAILABLE';
  return 'SOFTWARE_PROCESS_EXITED';
}

async function verify(entry, { path, signal, runner, timeoutMs }) {
  if (!entry.selectedPath) return { ...entry.launch, status: 'not-found',
    errorCode: entry.installed ? 'SOFTWARE_CLI_NOT_FOUND' : 'SOFTWARE_NOT_FOUND' };
  if (!entry.executable) return { ...entry.launch, status: 'not-executable', errorCode: 'SOFTWARE_NOT_EXECUTABLE' };
  check(signal);
  const cwd = await mkdtemp(join(tmpdir(), 'workbench-software-inspect-'));
  const start = performance.now();
  const elapsed = () => Math.round(Math.max(0, performance.now() - start));
  try {
    check(signal);
    const env = { ...minimalEnvironment(), PATH: path, HOME: cwd, XDG_CONFIG_HOME: join(cwd, 'config'),
      XDG_CACHE_HOME: join(cwd, 'cache'), QT_QPA_PLATFORM: 'offscreen' };
    let output;
    try {
      output = await runner(entry.selectedPath, [...SOFTWARE[entry.id].args], { cwd, env,
        timeout: timeoutMs, maxBuffer: SOFTWARE_INSPECTION_LIMITS.outputBytes, encoding: 'utf8', signal,
        killSignal: 'SIGKILL', windowsHide: true, shell: false });
    } catch (error) {
      check(signal);
      if (error?.code === 'ABORT_ERR') throw fail('ABORTED', '软件检查已停止。');
      const stdout = typeof error?.stdout === 'string' ? error.stdout.slice(0, SOFTWARE_INSPECTION_LIMITS.outputBytes) : '';
      const stderr = typeof error?.stderr === 'string' ? error.stderr.slice(0, SOFTWARE_INSPECTION_LIMITS.outputBytes) : '';
      const errorCode = failureCode(error, stdout, stderr);
      return { status: errorCode === 'SOFTWARE_TIMEOUT' ? 'timeout' : errorCode === 'SOFTWARE_OUTPUT_LIMIT' ? 'output-limit' : 'failed',
        version: null, errorCode, exitCode: Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255 ? error.code : null,
        signal: SIGNALS.has(error?.signal) ? error.signal : null, durationMs: elapsed() };
    }
    check(signal);
    const stdout = typeof output?.stdout === 'string' ? output.stdout : '', stderr = typeof output?.stderr === 'string' ? output.stderr : '';
    if (Buffer.byteLength(stdout) > SOFTWARE_INSPECTION_LIMITS.outputBytes || Buffer.byteLength(stderr) > SOFTWARE_INSPECTION_LIMITS.outputBytes) {
      return { status: 'output-limit', version: null, errorCode: 'SOFTWARE_OUTPUT_LIMIT', exitCode: null, signal: null, durationMs: elapsed() };
    }
    const version = SOFTWARE[entry.id].version.exec(stdout + '\n' + stderr)?.[1] || null;
    return { status: version ? 'verified' : 'failed', version, errorCode: version ? null : 'SOFTWARE_VERSION_UNCONFIRMED',
      exitCode: 0, signal: null, durationMs: elapsed() };
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

export async function inspectSoftware(_app, input = {}, { signal, platform = process.platform,
  path = minimalEnvironment().PATH ?? (platform === 'win32' ? '' : '/usr/bin:/bin'),
  home = homedir(), applicationDirectories = ['/Applications', join(home, 'Applications')], runner = execute,
  timeoutMs = SOFTWARE_INSPECTION_LIMITS.timeoutMs } = {}) {
  const { ids, verifyLaunch } = parameters(input);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SOFTWARE_INSPECTION_LIMITS.timeoutMs) {
    throw fail('SOFTWARE_ARGUMENT_INVALID', '软件检查期限无效。');
  }
  check(signal);
  const software = [];
  for (const id of ids) {
    const entry = await discover(id, { path, platform, applicationDirectories, signal });
    if (verifyLaunch) entry.launch = await verify(entry, { path, signal, runner, timeoutMs });
    check(signal);
    software.push(entry);
  }
  check(signal);
  return { software, policy: { readOnly: true, fixedArguments: true, temporaryHome: true, changesPath: false,
    installsSoftware: false, opensUserFiles: false, startsGui: false },
  limitations: ['仅搜索有界的绝对 PATH 目录及 macOS 已知应用 CLI；未发现不等于未安装。',
    '启动验证只检查固定版本命令，不验证导入、建模、渲染、文件交付或 MCP 连接。',
    '仅验证优先选中的 CLI；其它候选的可执行标记不代表已经启动成功。',
    'PATH 中同名程序属于本机受信环境；检查不会提供操作系统沙箱或提升权限。'] };
}
