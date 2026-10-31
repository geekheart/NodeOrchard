import { constants } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, opendir, lstat, realpath, open, unlink, access } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { validateDocument, getPorts } from '../shared/workflow/workflow-model.mjs';
import { workflowInputValue } from '../shared/workflow/workflow-inputs.mjs';
import { validateNodeValue } from '../shared/workflow/workflow-validation.mjs';
import { minimalEnvironment } from './workflows/workflow-code-environment.mjs';
import { inspectSoftware } from './application-software-inspector.mjs';
import { sanitizeDiagnosticText } from './app-diagnostics.mjs';

export const MAINTENANCE_REPRODUCTION_LIMITS = Object.freeze({ nodes: 1, snapshotBytes: 2 * 1024 * 1024,
  jsonBytes: 64 * 1024, logBytesPerStream: 32768, materialFiles: 32, materialFileBytes: 32 * 1024 * 1024,
  materialBytes: 64 * 1024 * 1024, artifactFiles: 32, artifactFileBytes: 16 * 1024 * 1024,
  artifactBytes: 64 * 1024 * 1024, scannedFiles: 1024, durationMs: 180000 });
const LIMITS = MAINTENANCE_REPRODUCTION_LIMITS;
const execute = promisify(execFile);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const SUPPORTED = new Set(['input', 'tool', 'transform', 'condition', 'merge', 'validation', 'output', 'human']);
const TOOLS = new Set(['text.trim', 'text.uppercase', 'json.parse', 'json.stringify', 'json.keys']);
const ALIASES = { blender: ['blender', 'Blender', 'blender.exe', 'Blender.exe'], freecad: ['freecadcmd', 'FreeCADCmd', 'freecadcmd.exe', 'FreeCADCmd.exe'], ffmpeg: ['ffmpeg', 'ffmpeg.exe'] };
const POLICY = Object.freeze({ originalRunExecuted: false, originalWorkflowChanged: false, sourceWrites: false,
  permissionWrites: false, modelCalls: 0, network: false, automaticallyApprovesReviews: false,
  frozenCodeOnly: true, inputFromSavedEvidenceOnly: true, localDependencies: ['javascript-builtins', 'python-stdlib', 'blender', 'freecad', 'ffmpeg'] });
const fail = (code, message, httpStatus = 400) => Object.assign(new Error(message), { code, httpStatus });
const check = signal => { if (signal?.aborted) throw fail('ABORTED', '隔离复现已停止。'); };
const hash = value => createHash('sha256').update(value).digest('hex');
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const safePath = value => typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
const cleanText = value => sanitizeDiagnosticText(String(value || ''));
const boundedText = value => Buffer.from(cleanText(value)).subarray(0, LIMITS.logBytesPerStream).toString('utf8').replace(/\uFFFD$/, '');

function object(value, keys) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => !keys.includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !Object.hasOwn(field, 'value'))) {
    throw fail('REPRODUCTION_ARGUMENT_INVALID', '复现只接受已保存的快照、输入来源和已登记素材身份。');
  }
}
function identifier(value) {
  if (typeof value !== 'string' || !ID.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw fail('REPRODUCTION_ARGUMENT_INVALID', '复现对象身份无效。');
  return value;
}
function identifiers(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum || Object.getOwnPropertySymbols(value).length) throw fail('REPRODUCTION_ARGUMENT_INVALID', '复现身份列表无效。');
  const fields = Object.getOwnPropertyDescriptors(value), keys = Object.keys(fields).filter(key => key !== 'length');
  if (keys.length !== value.length || keys.some(key => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length || !Object.hasOwn(fields[key], 'value'))) throw fail('REPRODUCTION_ARGUMENT_INVALID', '复现身份列表不能包含访问器、额外字段或空位。');
  return keys.map(key => identifier(fields[key].value));
}
function parameters(input) {
  object(input, ['snapshot', 'inputSource', 'materials']); object(input.snapshot, ['workflowId', 'expectedRevision', 'runId', 'nodeIds']);
  const snapshot = input.snapshot; identifier(snapshot.workflowId);
  if (snapshot.expectedRevision !== undefined && (!Number.isSafeInteger(snapshot.expectedRevision) || snapshot.expectedRevision < 1)) throw fail('REPRODUCTION_ARGUMENT_INVALID', '快照版本无效。');
  if (snapshot.runId !== undefined) identifier(snapshot.runId);
  const nodeIds = identifiers(snapshot.nodeIds, 1);
  if (nodeIds.length !== 1) throw fail('REPRODUCTION_ARGUMENT_INVALID', '首版隔离复现需要明确选择一个节点。');
  const inputSource = input.inputSource === undefined ? 'defaults' : input.inputSource;
  const materials = identifiers(input.materials === undefined ? [] : input.materials, LIMITS.materialFiles);
  if (!['defaults', 'run'].includes(inputSource) || inputSource === 'run' && !snapshot.runId
    || !Array.isArray(materials) || materials.length > LIMITS.materialFiles) throw fail('REPRODUCTION_ARGUMENT_INVALID', '输入来源或素材身份无效。');
  if (new Set(materials).size !== materials.length) throw fail('REPRODUCTION_ARGUMENT_INVALID', '素材身份不能重复。');
  return { snapshot: { ...snapshot, nodeIds }, inputSource, materials };
}
function json(value) {
  if (value === undefined) throw fail('REPRODUCTION_INPUT_UNAVAILABLE', '没有可冻结的节点输入。');
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > LIMITS.jsonBytes) throw fail('REPRODUCTION_INPUT_LIMIT', '复现输入或输出超过64KiB。', 413);
  return JSON.parse(encoded);
}
function select(value, path = '') {
  for (const key of path ? path.split('.') : []) {
    if (!/^[\p{L}\p{N}_$-]+$/u.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)
      || !value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}
function ancestors(document, nodeId) {
  const ids = new Set(), pending = document.edges.filter(edge => edge.targetNode === nodeId).map(edge => edge.sourceNode);
  while (pending.length) {
    const id = pending.pop(); if (ids.has(id)) continue; ids.add(id);
    pending.push(...document.edges.filter(edge => edge.targetNode === id).map(edge => edge.sourceNode));
  }
  return ids;
}
function defaultInput(document, node) {
  if (node.type === 'input') return json(workflowInputValue(document, undefined, node));
  const ports = getPorts(node).inputs, values = {};
  for (const port of ports) {
    const edge = document.edges.find(edge => edge.targetNode === node.id && edge.targetPort === port.id);
    if (!edge) { if (port.required !== false) throw fail('REPRODUCTION_INPUT_UNAVAILABLE', '所选节点缺少已冻结输入。'); continue; }
    const source = document.nodes.find(row => row.id === edge.sourceNode);
    if (source?.type !== 'input') throw fail('REPRODUCTION_INPUT_UNAVAILABLE', '默认输入只支持直接连接的输入节点；请选择已有运行的节点输入。');
    const output = workflowInputValue(document, undefined, source);
    const sourcePort = getPorts(source).outputs.find(row => row.id === edge.sourcePort);
    values[port.id] = json(select(output, sourcePort?.valuePath));
  }
  return json(ports.length === 1 && ports[0].id === 'in' ? values.in ?? null : values);
}
async function freeze(app, input) {
  const saved = await app.workflowLibrary.get(input.snapshot.workflowId);
  if (saved.id !== input.snapshot.workflowId || saved.lifecycle && saved.lifecycle !== 'active') throw fail('REPRODUCTION_SOURCE_INVALID', '源工作流不可用。', 409);
  if (input.snapshot.expectedRevision !== undefined && input.snapshot.expectedRevision !== saved.revision) throw fail('REPRODUCTION_SOURCE_STALE', '源工作流版本已变化。', 409);
  const run = input.snapshot.runId ? await app.workflows.get(input.snapshot.runId) : null;
  if (run && (run.id !== input.snapshot.runId || run.workflowId !== saved.id || run.parentRunId || run.learningId || run.memoryScopeId
    || run.document?.mode !== 'execute' || run.importedArchive)) throw fail('REPRODUCTION_SOURCE_INVALID', '复现仅接受当前工作流的普通顶层运行。', 403);
  const document = validateDocument(structuredClone(run?.document || saved.document));
  if (document.id !== saved.id || document.mode !== 'execute') throw fail('REPRODUCTION_SOURCE_INVALID', '复现不接受学习快照或其它工作流。', 403);
  if (Buffer.byteLength(JSON.stringify(document)) > LIMITS.snapshotBytes) throw fail('REPRODUCTION_SOURCE_LIMIT', '源快照超过容量限制。', 413);
  const node = document.nodes.find(row => row.id === input.snapshot.nodeIds[0]);
  if (!node) throw fail('REPRODUCTION_SOURCE_INVALID', '快照中不存在所选节点。', 404);
  const upstreamHuman = document.nodes.filter(row => row.type === 'human' && ancestors(document, node.id).has(row.id));
  const waiting = node.type === 'human' || upstreamHuman.some(row => !run || run.nodes?.[row.id]?.status !== 'complete');
  const supported = SUPPORTED.has(node.type) && !(node.type === 'tool' && node.config.executionMode === 'tool' && !TOOLS.has(node.config.toolName));
  const value = waiting || !supported ? null : input.inputSource === 'run'
    ? json(run.nodes?.[node.id]?.input) : defaultInput(document, node);
  return { document, node, run, input: value, waiting, supported, source: { workflowId: saved.id,
    revision: saved.revision, runId: run?.id || null, nodeId: node.id, snapshotOrigin: run ? 'run' : 'saved' } };
}

// Only authenticated registry/manifest entries reach this reader. Reject every
// symlink component and lock the final regular file with O_NOFOLLOW; never read
// a model-supplied path merely because it resembles an input path.
async function regularBytes(path, expected, maxBytes) {
  if (!safePath(path) || path !== resolve(path)) throw fail('REPRODUCTION_MATERIAL_INVALID', '已登记资料位置无效。', 409);
  let cursor = path;
  while (true) {
    const info = await lstat(cursor);
    const systemAlias = process.platform === 'darwin' && (cursor === '/var' && await realpath(cursor) === '/private/var'
      || cursor === '/tmp' && await realpath(cursor) === '/private/tmp');
    if (info.isSymbolicLink() && !systemAlias) throw fail('REPRODUCTION_MATERIAL_INVALID', '复现资料不能经过符号链接。', 409);
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes || expected?.size !== undefined && before.size !== expected.size) throw fail('REPRODUCTION_MATERIAL_INVALID', '资料类型、大小或硬链接身份无效。', 409);
    const data = await handle.readFile(), after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || data.length !== before.size
      || expected?.sha256 && hash(data) !== expected.sha256) throw fail('REPRODUCTION_MATERIAL_STALE', '资料哈希或版本已变化。', 409);
    return data;
  } finally { await handle.close(); }
}
function strings(value, result = new Set()) {
  if (typeof value === 'string') result.add(value);
  else if (Array.isArray(value)) value.forEach(item => strings(item, result));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => strings(item, result));
  return result;
}
function relocate(value, mapping) {
  if (typeof value === 'string') return mapping.get(value) || value;
  if (Array.isArray(value)) return value.map(item => relocate(item, mapping));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item, mapping)]));
  return value;
}
async function copyMaterials(app, frozen, refs, directory, signal) {
  const requested = strings(frozen.input), entries = [], mapping = new Map(), manifest = [];
  const sourceManifest = frozen.run?.sourceManifest;
  if (sourceManifest && !Array.isArray(sourceManifest) && sourceManifest.workflowId !== frozen.source.workflowId) throw fail('REPRODUCTION_MATERIAL_INVALID', '运行输入清单归属不一致。', 409);
  for (const entry of Array.isArray(sourceManifest) ? sourceManifest : sourceManifest?.entries || []) {
    if (entry.kind === 'folder' && requested.has(entry.path)) throw fail('REPRODUCTION_MATERIAL_UNSUPPORTED', '首版复现仅复制已登记普通文件，不复制整个目录。', 409);
    if (requested.has(entry.path) && !['folder'].includes(entry.kind)) entries.push({ ...entry, id: 'run-input-' + entries.length });
  }
  for (const id of refs) {
    check(signal);
    const item = await app.workflowAttachments.content(frozen.source.workflowId, id);
    if (item.attachment?.workflowId !== frozen.source.workflowId || item.attachment.id !== id) throw fail('REPRODUCTION_MATERIAL_INVALID', '素材不属于源工作流。', 403);
    entries.push(item.attachment);
  }
  let total = 0;
  for (const entry of entries) {
    check(signal);
    if (manifest.length >= LIMITS.materialFiles || !SHA.test(entry.sha256 || '') || !Number.isSafeInteger(entry.size) || entry.size < 0) throw fail('REPRODUCTION_MATERIAL_LIMIT', '资料数量或哈希无效。', 413);
    if (mapping.has(entry.path)) continue;
    if (entry.path.split(sep).some(part => /^\.(?:env|ssh|aws|codex|hermes)(?:\.|$)|^(?:credentials|auth\.json|tokens\.json)$/i.test(part))) throw fail('REPRODUCTION_MATERIAL_INVALID', '凭据和私有配置不能作为复现资料。', 403);
    const bytes = await regularBytes(entry.path, entry, LIMITS.materialFileBytes); total += bytes.length;
    if (total > LIMITS.materialBytes) throw fail('REPRODUCTION_MATERIAL_LIMIT', '资料总容量超出限制。', 413);
    const extension = /^\.[a-z0-9]{1,12}$/i.test(extname(entry.path)) ? extname(entry.path).toLowerCase() : '.bin';
    const target = join(directory, 'inputs', `${manifest.length}-${entry.sha256.slice(0, 16)}${extension}`);
    await writeFile(target, bytes, { flag: 'wx', mode: 0o400 }); check(signal);
    mapping.set(entry.path, target); manifest.push({ id: entry.id, path: relative(directory, target), sha256: hash(bytes), size: bytes.length });
  }
  return { input: relocate(frozen.input, mapping), manifest };
}

function runProcess(command, args, { cwd, env, request, signal, timeoutMs = LIMITS.durationMs }) {
  check(signal);
  return new Promise(resolveResult => {
    const start = Date.now(), child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    const buffers = [[], [], []], sizes = [0, 0, 0], limits = [LIMITS.logBytesPerStream, LIMITS.logBytesPerStream, LIMITS.jsonBytes + 8192];
    let timedOut = false, cancelled = false, truncated = false, spawnFailed = false, settled = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const abort = () => { cancelled = true; kill(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs); timer.unref?.();
    for (const [index, stream] of [child.stdout, child.stderr, child.stdio[3]].entries()) stream.on('data', chunk => {
      if (sizes[index] < limits[index]) buffers[index].push(chunk.subarray(0, limits[index] - sizes[index]));
      sizes[index] += chunk.length; truncated ||= sizes[index] > limits[index];
    });
    child.once('error', () => { spawnFailed = true; });
    child.stdin.on('error', () => {}); child.stdin.end(request ? JSON.stringify(request) : undefined);
    const finish = (exitCode, terminationSignal) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); kill();
      const [stdout, stderr, result] = buffers.map(parts => Buffer.concat(parts).toString('utf8'));
      let envelope; try { envelope = JSON.parse(result); } catch {}
      resolveResult({ status: cancelled ? 'cancelled' : timedOut ? 'timeout' : spawnFailed ? 'unavailable' : exitCode === 0 ? 'passed' : 'failed',
        exitCode, signal: terminationSignal, stdout, stderr, envelope, truncated, durationMs: Date.now() - start });
    };
    child.once('close', finish);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}

async function executablePath(name, path) {
  const candidates = safePath(name) ? [name] : name && !name.includes('/') ? path.split(':').filter(safePath).map(directory => join(directory, name)) : [];
  for (const candidate of candidates.slice(0, 128)) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return realpath(candidate);
  }
  return null;
}
async function runtimePaths(executable, signal) {
  const queue = [executable], seen = new Set(), paths = new Set([executable]);
  const settings = { encoding: 'utf8', timeout: 3000, maxBuffer: 256 * 1024, signal, env: { PATH: '/usr/bin:/bin' } };
  const rpaths = async path => {
    const { stdout } = await execute('/usr/bin/otool', ['-l', path], settings);
    return [...stdout.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset/g)].map(match => match[1]);
  };
  const executableRpaths = await rpaths(executable);
  while (queue.length) {
    check(signal); const path = queue.shift(); if (seen.has(path) || path.startsWith('/System/') || path.startsWith('/usr/lib/')) continue;
    seen.add(path); if (seen.size > 160) throw fail('REPRODUCTION_SANDBOX_UNAVAILABLE', '本地运行时依赖超过隔离边界。');
    const { stdout } = await execute('/usr/bin/otool', ['-L', path], settings); let local;
    const installNames = new Set((await execute('/usr/bin/otool', ['-D', path], settings)).stdout.split('\n').slice(1).map(row => row.trim()).filter(Boolean));
    const expand = value => value.replace(/^@loader_path(?=\/|$)/, dirname(path)).replace(/^@executable_path(?=\/|$)/, dirname(executable));
    for (let value of stdout.split('\n').slice(1).map(row => row.trim().split(' (')[0]).filter(Boolean)) {
      // otool -L includes a dylib's own install-name, which is not another
      // dependency to resolve (frameworks commonly use an unresolved @rpath ID).
      if (installNames.has(value)) continue;
      // dyld's shared-cache libraries need not exist as individual files.
      if (value.startsWith('/System/') || value.startsWith('/usr/lib/')) { paths.add(value); continue; }
      if (value.startsWith('@rpath/')) {
        local ||= await rpaths(path); let found;
        for (const base of [...local, ...executableRpaths]) { try { found = await realpath(resolve(expand(base), value.slice(7))); break; } catch {} }
        if (!found) throw fail('REPRODUCTION_SANDBOX_UNAVAILABLE', '本地动态库位置无法确认。'); value = found;
      } else value = expand(value);
      if (!safePath(value)) throw fail('REPRODUCTION_SANDBOX_UNAVAILABLE', '本地运行时依赖位置无效。');
      paths.add(value); const actual = await realpath(value); paths.add(actual); queue.push(actual);
    }
  }
  return [...paths];
}
async function createSandbox(app, { directory, runtime, node, signal, platform, inspectionOptions = {} }) {
  const unavailable = code => ({ sandbox: { kind: 'macos-seatbelt', status: 'unavailable', code } });
  if (platform !== 'darwin') return unavailable('platform_unsupported');
  try {
    const basePath = minimalEnvironment().PATH || '/usr/bin:/bin', nodePath = await realpath(process.execPath);
    const language = node.type === 'condition' ? 'javascript' : node.config.language || 'javascript';
    let pythonPath = language === 'python' ? await executablePath(app.config?.hermesPython || 'python3', basePath) : null, pythonLibraries = [];
    if (language === 'python' && !pythonPath) return unavailable('python_runtime_unavailable');
    if (pythonPath) {
      // /usr/bin/python3 can be an xcrun dispatcher. Ask a fixed isolated
      // standard-library probe for the real interpreter; do not grant the
      // dispatcher, Xcode tools, user site or Hermes installation wholesale.
      const probe = await execute(pythonPath, ['-I', '-S', '-B', '-c', 'import sys,sysconfig,json; print(json.dumps({"executable":sys.executable,"basePrefix":sys.base_prefix,"libraries":[sysconfig.get_path("stdlib"),sysconfig.get_path("platstdlib")]}))'],
        { cwd: directory, env: { PATH: basePath, HOME: join(directory, 'home'), PYTHONDONTWRITEBYTECODE: '1' }, signal, timeout: 4000, maxBuffer: 8192 });
      const result = JSON.parse(probe.stdout);
      if (!safePath(result.executable) || !Array.isArray(result.libraries) || result.libraries.some(path => !safePath(path))) return unavailable('python_runtime_unavailable');
      pythonPath = await realpath(result.executable); pythonLibraries = result.libraries;
      // Apple's framework bin launcher starts one further fixed Python.app
      // executable. Start that binary directly instead of granting xcrun or a
      // whole developer-tools directory execution privileges.
      if (safePath(result.basePrefix) && /\/Python3?\.framework\/Versions\/\d+\.\d+$/.test(result.basePrefix)) {
        const framework = join(result.basePrefix, 'Resources/Python.app/Contents/MacOS/Python');
        if (await access(framework, constants.X_OK).then(() => true, () => false)) pythonPath = await realpath(framework);
      }
    }
    const discovered = await inspectSoftware(app, {}, { ...inspectionOptions, platform, path: basePath, signal });
    const software = discovered.software.filter(entry => entry.executable && safePath(entry.selectedPath));
    // Current macOS /bin/sh is a fixed dispatcher, not the selected shell
    // binary. Resolve only Apple's fixed, root-owned selection location and
    // accept its finite built-in targets; never inherit an arbitrary SHELL.
    const shellSelection = '/private/var/select/sh';
    const shell = await realpath(shellSelection).catch(() => '/bin/sh');
    if (!['/bin/sh', '/bin/bash', '/bin/dash', '/bin/zsh'].includes(shell)) return unavailable('shell_runtime_unavailable');
    const executables = [...new Set([nodePath, ...(pythonPath ? [pythonPath] : []), '/bin/sh', shell, ...await Promise.all(software.map(entry => realpath(entry.selectedPath)))])];
    const reads = new Set([runtime, shellSelection]), subpaths = new Set(['/System', '/usr/lib', '/usr/share', '/Library/Fonts', '/private/var/db/timezone']), denied = new Set();
    for (const path of executables) {
      const bundle = /^(.*\.app)\//.exec(path)?.[1];
      if (bundle) subpaths.add(bundle);
      for (const dependency of await runtimePaths(path, signal)) reads.add(dependency);
    }
    if (pythonPath) {
      // -I/-S prevent user/site customizations. Only standard-library roots are
      // read, never Hermes configuration, credentials or site-packages.
      for (const path of pythonLibraries) { const actual = await realpath(path); subpaths.add(actual); denied.add(join(actual, 'site-packages')); }
      // Python executable initialization also checks the adjacent lib tree.
      reads.add(dirname(pythonPath));
    }
    const bin = join(runtime, 'bin'); await mkdir(bin, { mode: 0o700 });
    for (const entry of software) {
      const content = '#!/bin/sh\nunset PYTHONHOME PYTHONPATH __PYVENV_LAUNCHER__ VIRTUAL_ENV\nexport HOME=' + shellQuote(join(directory, 'home'))
        + '\nexport XDG_CONFIG_HOME=' + shellQuote(join(directory, 'home/config')) + '\nexport XDG_CACHE_HOME=' + shellQuote(join(directory, 'home/cache'))
        + (entry.id === 'freecad' ? '\nexport QT_QPA_PLATFORM=offscreen\nexport FREECAD_USER_HOME=' + shellQuote(join(directory, 'home'))
          + '\nexport FREECAD_USER_DATA=' + shellQuote(join(directory, 'home/config')) + '\nexport FREECAD_USER_TEMP=' + shellQuote(join(directory, 'tmp')) : '')
        + '\nexec ' + shellQuote(entry.selectedPath) + ' "$@"\n';
      for (const alias of ALIASES[entry.id]) {
        try { await writeFile(join(bin, alias), content, { mode: 0o700, flag: 'wx' }); }
        catch (error) { if (error.code !== 'EEXIST' || await readFile(join(bin, alias), 'utf8') !== content) throw error; }
      }
    }
    const env = { PATH: bin + ':' + dirname(nodePath) + (pythonPath ? ':' + dirname(pythonPath) : '') + ':' + basePath,
      HOME: join(directory, 'home'), TMPDIR: join(directory, 'tmp'), XDG_CONFIG_HOME: join(directory, 'home/config'),
      XDG_CACHE_HOME: join(directory, 'home/cache'), LANG: 'C.UTF-8', TZ: 'UTC', QT_QPA_PLATFORM: 'offscreen', OPENSSL_CONF: '/dev/null',
      PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' };
    const writable = ['home', 'tmp', 'workspace'].map(name => join(directory, name));
    const q = JSON.stringify;
    const blender = software.find(entry => entry.id === 'blender' && /\/Blender\.app\/Contents\/MacOS\/[Bb]lender$/.test(entry.selectedPath));
    const blenderPath = blender ? await realpath(blender.selectedPath) : null;
    // Apple's own Metal sandbox profiles enumerate these clients/services.
    // Scope the exception to the one discovered Blender executable, not the
    // workflow Node/Python worker, shell, FreeCAD, FFmpeg or an entire bundle.
    const gpu = blenderPath ? [`(with-filter (process-path ${q(blenderPath)})`,
      '(allow iokit-open ' + ['IOSurfaceRootUserClient', 'IOGPUDeviceUserClient', 'IOAccelDevice2', 'IOAccelSharedUserClient2', 'IOAccelCommandQueue',
        'AGXDeviceUserClient', 'AGXSharedUserClient', 'AGXDevice', 'AGXCommandQueue'].map(name => `(iokit-user-client-class ${q(name)})`).join(' ') + ')',
      '(allow mach-lookup (global-name "com.apple.MTLCompilerService") (global-name "com.apple.gpumemd.source")))'] : [];
    const profile = ['(version 1)', '(deny default)', '(deny network*)', '(allow process-fork)', '(allow sysctl-read)',
      '(allow process-info* (target self))', '(allow signal (target self))', '(allow file-read-metadata)',
      `(allow process-exec (subpath ${q(bin)}) ${executables.map(path => `(literal ${q(path)})`).join(' ')})`,
      `(allow file-read* (literal "/") ${[runtime, join(directory, 'inputs'), ...writable, ...subpaths].map(path => `(subpath ${q(path)})`).join(' ')} ${[...reads, '/dev/null', '/dev/random', '/dev/urandom'].map(path => `(literal ${q(path)})`).join(' ')})`,
      `(allow file-write* ${writable.map(path => `(subpath ${q(path)})`).join(' ')} (literal "/dev/null"))`,
      ...[...denied].map(path => `(deny file-read* (subpath ${q(path)}))`), ...gpu].join('\n');
    const sentinel = join(dirname(directory), '.maintenance-probe-' + randomUUID());
    await writeFile(sentinel, 'private-isolation-sentinel', { flag: 'wx', mode: 0o600 });
    const program = `const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');
      const result={writeInside:false,readOutsideDenied:false,writeOutsideDenied:false,networkDenied:false,nodeChildWorks:false,shellChildWorks:false};
      try{fs.writeFileSync(${q(join(directory, 'tmp/probe'))},'probe');result.writeInside=true}catch{}
      try{fs.readFileSync(${q(sentinel)})}catch(e){result.readOutsideDenied=['EACCES','EPERM'].includes(e.code)}
      try{fs.writeFileSync(${q(sentinel)},'bad')}catch(e){result.writeOutsideDenied=['EACCES','EPERM'].includes(e.code)}
      result.nodeChildWorks=cp.spawnSync(process.execPath,['-e','process.exit(0)']).status===0;
      result.shellChildWorks=cp.spawnSync('/bin/sh',['-c',':']).status===0;
      const socket=net.connect({host:'127.0.0.1',port:9});let done=false;const finish=()=>{if(done)return;done=true;socket.destroy();console.log(JSON.stringify(result))};
      socket.on('connect',finish);socket.on('error',e=>{result.networkDenied=['EACCES','EPERM'].includes(e.code);finish()});socket.setTimeout(1000,finish);`;
    let probe;
    try { probe = await runProcess('/usr/bin/sandbox-exec', ['-p', profile, nodePath, '-e', program], { cwd: directory, env, signal, timeoutMs: 10000 }); }
    finally { await unlink(sentinel).catch(() => {}); }
    let verification; try { verification = JSON.parse(probe.stdout); } catch {}
    if (probe.status !== 'passed' || !verification || !['writeInside', 'readOutsideDenied', 'writeOutsideDenied', 'networkDenied', 'nodeChildWorks', 'shellChildWorks'].every(key => verification[key] === true)) {
      const result = unavailable(/sandbox_init:.*Operation not permitted/.test(probe.stderr) ? 'sandbox_host_restricted' : 'sandbox_probe_failed');
      result.sandbox.probe = verification || null; result.sandbox.probeExitCode = probe.exitCode; return result;
    }
    return { sandbox: { kind: 'macos-seatbelt', status: 'verified', probe: verification }, env, pythonPath, nodePath,
      software: software.map(({ id, pathVisible }) => ({ id, available: true, pathVisible })),
      run: options => runProcess('/usr/bin/sandbox-exec', ['-p', profile, options.command, ...options.args], { ...options, env: { ...env, ...options.env } }) };
  } catch (error) { check(signal); return unavailable(error.code === 'ENOENT' ? 'runtime_missing' : 'sandbox_setup_failed'); }
}

async function artifacts(directory, signal) {
  const files = [], pending = [join(directory, 'workspace')]; let scanned = 0, total = 0, truncated = false;
  while (pending.length) {
    check(signal); const current = pending.shift();
    const handle = await opendir(current);
    for await (const entry of handle) {
      if (++scanned > LIMITS.scannedFiles) { truncated = true; pending.length = 0; break; }
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (relative(join(directory, 'workspace'), path).split(sep).length <= 8) pending.push(path); else truncated = true; }
      else if (entry.isFile()) files.push(path);
    }
  }
  files.sort((a, b) => Number(/\.(gif|mp4|webm|blend|step|stp)$/i.test(b)) - Number(/\.(gif|mp4|webm|blend|step|stp)$/i.test(a)) || a.localeCompare(b));
  const manifest = [];
  for (const path of files) {
    check(signal); const info = await lstat(path);
    if (info.nlink !== 1 || info.size > LIMITS.artifactFileBytes || total + info.size > LIMITS.artifactBytes || manifest.length >= LIMITS.artifactFiles) { truncated = true; continue; }
    try {
      const data = await regularBytes(path, { size: info.size }, LIMITS.artifactFileBytes); total += data.length;
      const image = /^\.(png|jpe?g|gif|webp|svg)$/i.test(extname(path));
      manifest.push({ path: relative(directory, path), size: data.length, sha256: hash(data), requiresHumanReview: image, reviewStatus: image ? 'not-approved' : 'not-required' });
    } catch { truncated = true; }
  }
  return { manifest, truncated };
}
function builtin(name, value) {
  if (['text.trim', 'text.uppercase', 'json.parse'].includes(name) && typeof value !== 'string') throw fail('TOOL_INPUT_INVALID', '此工具需要真实文本输入。');
  if (name === 'text.trim') return value.trim();
  if (name === 'text.uppercase') return value.toUpperCase();
  if (name === 'json.parse') { try { return JSON.parse(value); } catch { throw fail('TOOL_INPUT_INVALID', '输入文本不是有效 JSON。'); } }
  if (name === 'json.stringify') return JSON.stringify(value);
  if (name === 'json.keys') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail('TOOL_INPUT_INVALID', '读取字段名需要真实 JSON 对象输入。');
    return Object.keys(value);
  }
  throw fail('REPRODUCTION_UNSUPPORTED', '工具不属于受支持的本地纯工具。');
}

// This function is an executor-owned seam. Its request contains source IDs,
// never code, shell commands or arbitrary replacement inputs. The caller owns
// authorization and durable operation admission; this directory is additionally
// one-shot so an unknown result cannot silently re-execute on retry/restart.
export async function runMaintenanceReproduction(app, request, { directory, signal, platform = process.platform, trustedCandidate,
  sandboxFactory = createSandbox, inspectionOptions = {}, timeoutMs = LIMITS.durationMs } = {}) {
  const input = parameters(request); check(signal);
  if (!safePath(directory) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LIMITS.durationMs) throw fail('REPRODUCTION_ARGUMENT_INVALID', '隔离目录或期限无效。');
  const frozen = await freeze(app, input); check(signal);
  const snapshotHash = 'sha256:' + hash(JSON.stringify(frozen.document));
  let candidateHash;
  if (trustedCandidate !== undefined) {
    // Server-only option: it is deliberately absent from parameters() and the
    // public tool schema. The maintenance service binds this validated proposal
    // to its source receipt before reaching this executor.
    object(trustedCandidate, ['document', 'baseSnapshotHash']);
    if (trustedCandidate.baseSnapshotHash !== undefined && trustedCandidate.baseSnapshotHash !== snapshotHash) throw fail('REPRODUCTION_CANDIDATE_STALE', '候选与冻结源快照不一致。', 409);
    const document = validateDocument(structuredClone(trustedCandidate.document));
    if (Buffer.byteLength(JSON.stringify(document)) > LIMITS.snapshotBytes || document.id !== frozen.source.workflowId || document.mode !== 'execute') throw fail('REPRODUCTION_CANDIDATE_INVALID', '候选超出源工作流归属或容量边界。', 409);
    const candidateNode = document.nodes.find(row => row.id === frozen.node.id);
    if (!candidateNode || candidateNode.type !== frozen.node.type || !SUPPORTED.has(candidateNode.type)
      || candidateNode.type === 'tool' && candidateNode.config.executionMode === 'tool' && !TOOLS.has(candidateNode.config.toolName)) throw fail('REPRODUCTION_CANDIDATE_INVALID', '候选改变了目标节点类型或需要未支持的外部工具。', 409);
    candidateHash = 'sha256:' + hash(JSON.stringify(document));
    // Preserve frozen source input, identity, topology and original human gates.
    // Only this isolated node's business config changes.
    frozen.node = { ...frozen.node, config: structuredClone(candidateNode.config) };
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw fail('REPRODUCTION_ARGUMENT_INVALID', '隔离目录不能是符号链接。');
  directory = await realpath(directory);
  if (!(await lstat(directory)).isDirectory()) throw fail('REPRODUCTION_ARGUMENT_INVALID', '隔离目录无效。');
  const existing = await opendir(directory);
  try {
    const entry = await existing.read();
    if (entry) {
      if (await lstat(join(directory, 'admission.json')).then(() => true, () => false)) throw fail('REPRODUCTION_REPLAY_REFUSED', '此复现目录已有准入记录，只能读取结果，不能自动重放。', 409);
      throw fail('REPRODUCTION_DIRECTORY_INVALID', '只接受服务端创建的独占空目录。', 409);
    }
  } finally { await existing.close(); }
  try { await writeFile(join(directory, 'admission.json'), JSON.stringify({ version: 1, snapshotHash, source: frozen.source }), { flag: 'wx', mode: 0o400 }); }
  catch (error) { if (error.code === 'EEXIST') throw fail('REPRODUCTION_REPLAY_REFUSED', '此复现目录已有准入记录，只能读取结果，不能自动重放。', 409); throw error; }
  await writeFile(join(directory, 'frozen-snapshot.json'), JSON.stringify({ version: 1, source: frozen.source, snapshotHash,
    document: frozen.document, input: frozen.input, ...(candidateHash ? { candidateHash, testedNode: frozen.node } : {}) }), { flag: 'wx', mode: 0o400 });
  const result = { version: 1, status: 'unavailable', source: frozen.source, snapshotHash, inputHash: null, sandbox: { kind: 'macos-seatbelt', status: 'not-run' },
    policy: { ...POLICY }, nodeResults: [], logs: { stdout: '', stderr: '', truncated: false }, materials: [], artifacts: [], artifactsTruncated: false, durationMs: 0 };
  if (candidateHash) result.candidateHash = candidateHash;
  const started = Date.now();
  const finish = async (status, code) => {
    result.status = status; if (code) result.code = code; result.durationMs = Date.now() - started;
    await writeFile(join(directory, 'receipt.json'), JSON.stringify(result), { flag: 'wx', mode: 0o400 }); return result;
  };
  if (!frozen.supported) return finish('unsupported', 'node_type_unsupported');
  if (frozen.waiting) return finish('waiting_review', 'human_gate_not_approved');
  for (const name of ['runtime', 'inputs', 'workspace', 'home', 'home/config', 'home/cache', 'tmp']) await mkdir(join(directory, name), { recursive: true, mode: 0o700 });
  const staged = await copyMaterials(app, frozen, input.materials, directory, signal); result.materials = staged.manifest;
  result.inputHash = 'sha256:' + hash(JSON.stringify(frozen.input));
  const runtime = join(directory, 'runtime');
  for (const [source, name] of [[new URL('./workflows/workflow-code-worker.mjs', import.meta.url), 'worker.mjs'],
    [new URL('../python/workflow_code_worker.py', import.meta.url), 'workflow_code_worker.py'],
    [new URL('../python/workflow_code_validation.py', import.meta.url), 'workflow_code_validation.py']]) {
    await writeFile(join(runtime, name), await readFile(fileURLToPath(source)), { mode: 0o400, flag: 'wx' });
  }
  const sandbox = await sandboxFactory(app, { directory, runtime, node: frozen.node, signal, platform, inspectionOptions });
  result.sandbox = sandbox?.sandbox || { kind: 'macos-seatbelt', status: 'unavailable', code: 'sandbox_probe_failed' };
  if (result.sandbox.kind !== 'macos-seatbelt' || result.sandbox.status !== 'verified' || typeof sandbox.run !== 'function') return finish('unavailable', result.sandbox.code || 'sandbox_probe_failed');
  result.software = sandbox.software || [];
  const node = frozen.node, cwd = join(directory, 'workspace', node.id); await mkdir(cwd, { mode: 0o700 });
  const record = { nodeId: node.id, type: node.type, status: 'running', codeHash: 'sha256:' + hash(node.config.code || node.config.expression || node.config.toolName || ''), inputHash: result.inputHash };
  result.nodeResults.push(record);
  try {
    check(signal); let output;
    if (['input', 'merge', 'output'].includes(node.type)) output = staged.input;
    else if (node.type === 'validation') { record.validation = validateNodeValue(staged.input, node.config.rules, node.title); output = staged.input; }
    else if (node.type === 'tool' && node.config.executionMode === 'tool') output = builtin(node.config.toolName, staged.input);
    else {
      const language = node.type === 'condition' ? 'javascript' : node.config.language || 'javascript';
      const context = { workflowId: frozen.source.workflowId, nodeId: node.id, runId: 'maintenance-isolated', attempt: 1,
        outputDirectory: cwd, runOutputDirectory: join(directory, 'workspace'), isolatedReproduction: true };
      const execution = await sandbox.run({ command: language === 'python' ? sandbox.pythonPath : sandbox.nodePath || process.execPath,
        args: language === 'python' ? ['-I', '-S', '-B', '-c', `import runpy,sys;sys.path.insert(0,${JSON.stringify(runtime)});runpy.run_path(${JSON.stringify(join(runtime, 'workflow_code_worker.py'))},run_name='__main__')`]
          : [join(runtime, 'worker.mjs')], cwd, signal, timeoutMs: Math.min(timeoutMs, (node.config.timeoutSeconds || 120) * 1000),
        env: { ...sandbox.env, WORKBENCH_OUTPUT_DIRECTORY: cwd, WORKBENCH_NODE_DIRECTORY: cwd, WORKBENCH_RUN_OUTPUT_DIRECTORY: join(directory, 'workspace'),
          WORKBENCH_RUN_ID: 'maintenance-isolated', WORKBENCH_NODE_ID: node.id, WORKBENCH_WORKFLOW_ID: frozen.source.workflowId },
        request: { code: node.type === 'condition' ? 'return Boolean(' + node.config.expression + ');' : node.config.code, input: staged.input, context } });
      result.logs = { stdout: boundedText(execution.stdout), stderr: boundedText(execution.stderr), truncated: execution.truncated === true
        || Buffer.byteLength(cleanText(execution.stdout)) > LIMITS.logBytesPerStream || Buffer.byteLength(cleanText(execution.stderr)) > LIMITS.logBytesPerStream };
      record.exitCode = execution.exitCode ?? null; record.durationMs = execution.durationMs ?? null;
      if (execution.status !== 'passed' || execution.envelope?.ok !== true) {
        record.status = execution.status === 'cancelled' ? 'cancelled' : 'failed';
        record.errorCode = ['CODE_ENVIRONMENT', 'CODE_FAILED', 'OUTPUT_INVALID', 'OUTPUT_LIMIT'].includes(execution.envelope?.error?.code)
          ? execution.envelope.error.code : execution.status === 'timeout' ? 'REPRODUCTION_TIMEOUT' : 'REPRODUCTION_EXECUTION_FAILED';
        record.error = boundedText(execution.envelope?.error?.message || '隔离执行没有返回有效成功回执。');
      } else output = execution.envelope.output;
    }
    if (record.status === 'running') {
      if (node.type === 'condition') { record.selectedPort = output ? 'yes' : 'no'; output = staged.input; }
      record.output = json(output); record.outputHash = 'sha256:' + hash(JSON.stringify(record.output)); record.status = 'passed';
      if (node.type === 'output') await writeFile(join(cwd, 'output.json'), JSON.stringify(output), { flag: 'wx', mode: 0o600 });
    }
  } catch (error) {
    record.status = signal?.aborted ? 'cancelled' : 'failed'; record.errorCode = signal?.aborted ? 'ABORTED' : error.code || 'REPRODUCTION_EXECUTION_FAILED';
    record.error = boundedText(error.message);
  }
  const collected = await artifacts(directory, signal?.aborted ? undefined : signal); result.artifacts = collected.manifest; result.artifactsTruncated = collected.truncated;
  if (signal?.aborted) { record.status = 'cancelled'; record.errorCode = 'ABORTED'; }
  return finish(record.status === 'passed' ? 'passed' : record.status === 'cancelled' ? 'cancelled' : 'failed');
}
