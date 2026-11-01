import { spawn } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const KIND = 'macos-seatbelt';
const inside = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const invalid = () => Object.assign(new Error('总控隔离目录或应用端口无效。'), { code: 'SUPERVISOR_SANDBOX_INVALID' });
const unavailable = code => ({ status: 'unavailable', evidence: { kind: KIND, status: 'unavailable', code } });
const quote = value => JSON.stringify(value);
const directories = ['home', 'tmp', 'cache', 'config', 'data'];

async function canonical(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw invalid();
  const normalized = resolve(path);
  try { return await realpath(normalized); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return join(await canonical(dirname(normalized)), normalized.slice(dirname(normalized).length + 1)); }
}

function run(command, args, { cwd, env, signal, timeoutMs = 10000 } = {}) {
  return new Promise(resolveResult => {
    let child, output = '', errorOutput = '', settled = false;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); resolveResult({ ...result, stdout: output, stderr: errorOutput }); };
    const abort = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} finish({ status: 'unavailable', code: 'sandbox_probe_cancelled' }); };
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} finish({ status: 'unavailable', code: 'sandbox_probe_timeout' }); }, timeoutMs);
    if (signal?.aborted) return finish({ status: 'unavailable', code: 'sandbox_probe_cancelled' });
    try { child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { return finish({ status: 'unavailable', code: 'sandbox_spawn_failed' }); }
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', bytes => { output = (output + bytes).slice(0, 32768); });
    child.stderr.on('data', bytes => { errorOutput = (errorOutput + bytes).slice(0, 4000); });
    child.once('error', () => finish({ status: 'unavailable', code: 'sandbox_spawn_failed' }));
    child.once('exit', (code, stopped) => finish({ status: code === 0 && !stopped ? 'pass' : 'unavailable', exitCode: code }));
  });
}

// Every native tool and descendant process runs inside this same OS policy.
// The application dispatcher stays outside it and applies human permissions.
// No command is returned unless the actual kernel policy passed its probe.
export async function buildSupervisorSandbox(options = {}, { platform = process.platform, runner = run } = {}) {
  if (platform !== 'darwin') return unavailable('platform_unsupported');
  const { applicationPort } = options;
  if (!Number.isInteger(applicationPort) || applicationPort < 1 || applicationPort > 65535) throw invalid();
  if (options.egressProxyPort !== undefined && (!Number.isInteger(options.egressProxyPort) || options.egressProxyPort < 1 || options.egressProxyPort > 65535 || options.egressProxyPort === applicationPort)) throw invalid();
  const runtimeRoot = await canonical(options.runtimeRoot);
  const protectedRoots = await Promise.all(['appRoot', 'dataDir', 'workspaceRoot', 'hermesHome'].map(key => canonical(options[key])));
  if (protectedRoots.some(path => inside(runtimeRoot, path))) throw invalid();
  if (['readOnlyRoots', 'readRoots', 'runtimeDependencyRoots'].some(key => options[key] !== undefined && !Array.isArray(options[key]))) throw invalid();
  const readOnlyRoots = await Promise.all((options.readOnlyRoots || []).map(canonical));
  if (readOnlyRoots.some(path => path === runtimeRoot || !inside(runtimeRoot, path))) throw invalid();
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(options.runtimeRoot)).isSymbolicLink() || !(await lstat(runtimeRoot)).isDirectory()) throw invalid();
  for (const name of directories) {
    const path = join(runtimeRoot, name);
    try { const entry = await lstat(path); if (!entry.isDirectory() || entry.isSymbolicLink()) throw invalid(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(path, { mode: 0o700 }); }
    if (await realpath(path) !== path) throw invalid();
  }
  let node, python, hermesRoot;
  try {
    await access('/usr/bin/sandbox-exec', constants.X_OK);
    node = await realpath(process.execPath);
    python = await realpath(options.python);
    hermesRoot = await realpath(options.hermesRoot || join(options.hermesHome, 'hermes-agent'));
  } catch { return unavailable('runtime_unavailable'); }
  if (inside(hermesRoot, protectedRoots[3])) throw invalid();
  const readRoots = [runtimeRoot, join(protectedRoots[0], 'python'), hermesRoot, dirname(dirname(python)), dirname(dirname(node)),
    '/System', '/usr', '/bin', '/sbin', '/opt/homebrew', '/Library/Apple/System', '/Library/Frameworks', '/private/etc', '/private/var/db/timezone'];
  // Native headless software may read its installed bundle, but does not gain
  // access to arbitrary user apps, desktop automation or host data directories.
  for (const bundle of ['/Applications/Blender.app', '/Applications/FreeCAD.app']) readRoots.push(await canonical(bundle));
  const installsRoot = await canonical(join(protectedRoots[3], 'installs'));
  const dependencyRoots = [];
  for (const path of options.runtimeDependencyRoots || []) {
    const value = await realpath(path);
    if (value === installsRoot || !inside(installsRoot, value)) throw invalid();
    readRoots.push(value); dependencyRoots.push(value);
  }
  // Keep a selected virtual environment's pyvenv.cfg and site-packages visible.
  // The executable's realpath alone refers to the base Python installation.
  const selectedPythonRoot = await canonical(dirname(dirname(options.python)));
  if (selectedPythonRoot !== installsRoot && inside(installsRoot, selectedPythonRoot)) { readRoots.push(selectedPythonRoot); dependencyRoots.push(selectedPythonRoot); }
  const toolsRoot = await canonical(join(protectedRoots[3], 'tools'));
  for (const path of [dirname(dirname(python)), dirname(dirname(node))]) if (path !== toolsRoot && inside(toolsRoot, path)) dependencyRoots.push(path);
  for (const path of options.readRoots || []) {
    const value = await canonical(path);
    if (value === sep || protectedRoots.some(root => inside(root, value))) throw invalid();
    readRoots.push(value);
  }
  // A public runtime prefix such as /opt/homebrew or a software bundle can
  // contain a user-configured workspace/database. Subtract each protected
  // root independently so a narrower code exception never reopens host data.
  const readGuards = protectedRoots.map((root, index) => {
    const exceptions = [runtimeRoot, ...(index === 0 ? [join(root, 'python')] : []), ...(index === 3 ? [hermesRoot, ...dependencyRoots] : [])];
    return `(require-not (require-all (subpath ${quote(root)}) (require-not (require-any ${[...new Set(exceptions)].map(path => `(subpath ${quote(path)})`).join(' ')}))))`;
  });
  const sentinelRoot = await realpath(await mkdtemp(join(tmpdir(), 'supervisor-policy-probe-')));
  const probeId = randomUUID(), sentinel = join(sentinelRoot, 'outside.txt'), readable = join(sentinelRoot, 'readonly.txt'), allowed = join(runtimeRoot, 'tmp', 'policy-probe-' + probeId + '.txt');
  const runtimeReadonly = join(runtimeRoot, 'tmp', 'policy-probe-readonly-' + probeId + '.txt');
  await writeFile(sentinel, 'outside-private', { mode: 0o600 }); await writeFile(readable, 'readonly-private', { mode: 0o600 });
  await writeFile(runtimeReadonly, 'runtime-readonly', { mode: 0o600, flag: 'wx' }); readOnlyRoots.push(runtimeReadonly);
  const stableParents = new Set([runtimeRoot]);
  for (const path of readOnlyRoots) for (let parent = dirname(path); inside(runtimeRoot, parent); parent = dirname(parent)) stableParents.add(parent);
  const profile = [
    '(version 1)', '(deny default)', '(allow process-fork)', '(allow process-exec)', '(allow sysctl-read)',
    '(allow process-info* signal (target self) (target children))', '(allow file-read-metadata)',
    `(allow file-read* (require-all (require-any ${[...new Set(readRoots)].map(path => `(subpath ${quote(path)})`).join(' ')} (literal ${quote(readable)}) (literal "/") (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (subpath "/dev/fd")) ${readGuards.join(' ')}))`,
    `(allow file-write* (require-all (subpath ${quote(runtimeRoot)}) (require-not (require-any ${readOnlyRoots.map(path => `(subpath ${quote(path)})`).join(' ')}))) (literal "/dev/null") (subpath "/dev/fd"))`,
    // Protect the ancestors too: renaming a profile directory must not move
    // its immutable credentials onto a writable path under the same runtime.
    `(deny file-write-unlink ${[...stableParents].map(path => `(literal ${quote(path)})`).join(' ')})`,
    // Only the host-controlled public-only proxy is reachable. A native tool
    // cannot bypass the broker through localhost, a system proxy or DNS.
    ...(options.egressProxyPort === undefined ? [] : [`(allow network-outbound (remote tcp "localhost:${options.egressProxyPort}"))`]),
    '(allow mach-lookup (global-name "com.apple.SystemConfiguration.DNSConfiguration") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.trustd.agent") (global-name "com.apple.networkd"))',
  ].join('\n');
  const env = { HOME: join(runtimeRoot, 'home'), TMPDIR: join(runtimeRoot, 'tmp'), XDG_CACHE_HOME: join(runtimeRoot, 'cache'),
    XDG_CONFIG_HOME: join(runtimeRoot, 'config'), XDG_DATA_HOME: join(runtimeRoot, 'data'), PYTHONDONTWRITEBYTECODE: '1', HERMES_DISABLE_LAZY_INSTALLS: '1' };
  const program = `const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net');
    const result={writeInside:false,readOutsideDenied:false,writeOutsideDenied:false,childConfined:false,networkDenied:false,readonlyReadable:false,readonlyLinkDenied:false,runtimeReadonlyDenied:false,proxyReachable:${options.egressProxyPort === undefined}};
    const outside=${JSON.stringify(sentinel)},inside=${JSON.stringify(allowed)};
    try{fs.writeFileSync(inside,'inside');result.writeInside=fs.readFileSync(inside,'utf8')==='inside';}catch{}
    try{fs.readFileSync(outside);}catch(e){result.readOutsideDenied=['EACCES','EPERM'].includes(e.code);}
    try{fs.writeFileSync(outside,'changed');}catch(e){result.writeOutsideDenied=['EACCES','EPERM'].includes(e.code);}
    try{fs.writeFileSync(${JSON.stringify(runtimeReadonly)},'changed');}catch(e){result.runtimeReadonlyDenied=['EACCES','EPERM'].includes(e.code);}
    try{result.readonlyReadable=fs.readFileSync(${JSON.stringify(readable)},'utf8')==='readonly-private';}catch{}
    try{const link=inside+'.link';fs.linkSync(${JSON.stringify(readable)},link);fs.writeFileSync(link,'changed');}catch(e){result.readonlyLinkDenied=['EACCES','EPERM'].includes(e.code);}
    const childCode='const fs=require("node:fs");try{fs.writeFileSync('+JSON.stringify(outside)+',"child");process.exit(2);}catch(e){process.exit(["EACCES","EPERM"].includes(e.code)?0:3);}';
    result.childConfined=cp.spawnSync(process.execPath,['-e',childCode],{encoding:'utf8'}).status===0;
    const probe=(port,denied)=>new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});let done=false;const end=()=>{if(done)return;done=true;socket.destroy();resolve();};socket.on('error',e=>{if(denied)result.networkDenied=['EACCES','EPERM'].includes(e.code);end();});socket.on('connect',()=>{if(!denied)result.proxyReachable=true;end();});socket.setTimeout(1000,end);});
    Promise.all([probe(${applicationPort},true),${options.egressProxyPort === undefined ? 'Promise.resolve()' : `probe(${options.egressProxyPort},false)`}]).then(()=>console.log(JSON.stringify(result)));`;
  let observed;
  try { observed = await runner('/usr/bin/sandbox-exec', ['-p', profile, node, '-e', program], { cwd: runtimeRoot, env: { ...process.env, ...env }, signal: options.signal }); }
  finally { await rm(sentinelRoot, { recursive: true, force: true }); await rm(allowed, { force: true }); await rm(allowed + '.link', { force: true }); await rm(runtimeReadonly, { force: true }); }
  let probe;
  try { probe = JSON.parse(observed.stdout.trim()); } catch { return unavailable(observed.code || 'sandbox_probe_failed'); }
  if (observed.status !== 'pass' || !['writeInside', 'readOutsideDenied', 'writeOutsideDenied', 'childConfined', 'networkDenied', 'readonlyReadable', 'readonlyLinkDenied', 'runtimeReadonlyDenied', 'proxyReachable'].every(key => probe[key] === true)) return unavailable('sandbox_probe_failed');
  return { status: 'verified', command: '/usr/bin/sandbox-exec', argsPrefix: ['-p', profile], cwd: runtimeRoot, env,
    evidence: { kind: KIND, status: 'verified', probe }, profileHash: 'sha256:' + createHash('sha256').update(profile).digest('hex') };
}
