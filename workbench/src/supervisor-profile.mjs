import { createHash } from 'node:crypto';
import { access, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';

const execute = promisify(execFile);
const inside = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const fail = message => Object.assign(new Error(message), { code: 'SUPERVISOR_PROFILE_UNAVAILABLE' });
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink() || await realpath(path) !== resolve(path)) throw fail('总控运行目录必须是独立真实目录。');
}
async function readOptional(source) {
  let file;
  try {
    file = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024) throw fail('Hermes 配置文件类型或大小不受支持。');
    const bytes = await file.readFile(); if (bytes.length > 4 * 1024 * 1024) throw fail('Hermes 配置文件大小不受支持。'); return bytes;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await file?.close(); }
}
async function privateFile(path, bytes) {
  let file;
  try {
    file = await open(path, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
    const info = await file.stat(); if (!info.isFile() || info.nlink !== 1) throw fail('总控配置副本身份已变化。');
    await file.truncate(0); await file.writeFile(bytes); await file.chmod(0o600);
  } finally { await file?.close(); }
}
async function removeOptional(path) {
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw fail('总控配置副本身份已变化。'); await rm(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function copyOptional(source, destination, { onlyOnce = false, clearMissing = false } = {}) {
  const bytes = await readOptional(source);
  if (bytes === null) { if (clearMissing) await removeOptional(destination); return; }
  if (onlyOnce && await readOptional(destination) !== null) return;
  await privateFile(destination, bytes);
}
async function copyLibrary(source, destination) {
  let sourceRoot;
  try { sourceRoot = await realpath(source); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let entries = 0, bytes = 0;
  const visit = async (from, to) => {
    await privateDirectory(to);
    for (const item of await readdir(from, { withFileTypes: true })) {
      if (++entries > 30000) throw fail('Hermes 扩展目录超过继承上限。');
      if (item.isSymbolicLink() || item.name === '__pycache__' || item.name === '.git') continue;
      const sourcePath = join(from, item.name), target = join(to, item.name);
      if (item.isDirectory()) await visit(sourcePath, target);
      else if (item.isFile()) {
        const info = await lstat(sourcePath);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (bytes += info.size) > 128 * 1024 * 1024) throw fail('Hermes 扩展资料无法安全继承。');
        try { const dest = await lstat(target); if (!dest.isFile() || dest.isSymbolicLink() || dest.nlink !== 1) throw fail('总控扩展副本身份已变化。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await copyFile(sourcePath, target); await chmod(target, info.mode & 0o111 ? 0o700 : 0o600);
      }
    }
  };
  await visit(sourceRoot, destination);
}

// Read the committed Hermes environment. Never bootstrap or install dependencies
// merely to locate them, and retain the venv path rather than its Python symlink.
export async function supervisorPython(config) {
  const root = await realpath(config.hermesRoot), key = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const installs = await realpath(join(config.hermesHome, 'installs')).catch(() => null);
  if (installs) {
    try {
      const facts = JSON.parse(await readFile(join(installs, key, 'facts.json'), 'utf8'));
      const environment = facts.packages?.venv?.environment;
      if (typeof environment === 'string' && isAbsolute(environment)) {
        const path = await realpath(environment);
        if (!inside(join(installs, key), path) || path === join(installs, key)) throw fail('Hermes 已选依赖环境位置无效。');
        const python = join(path, 'bin', 'python3'); await access(python);
        return { python, dependencyRoots: [path] };
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await access(config.hermesPython);
  return { python: config.hermesPython, dependencyRoots: [] };
}

export async function prepareSupervisorProfile(config, runtimeRoot, { rewrite = execute } = {}) {
  runtimeRoot = resolve(runtimeRoot); await privateDirectory(runtimeRoot);
  const sourceHome = await realpath(config.hermesHome);
  if (inside(sourceHome, runtimeRoot) || inside(runtimeRoot, sourceHome)) throw fail('总控私有目录不能覆盖原 Hermes 配置目录。');
  const profile = join(runtimeRoot, 'profile'), work = join(runtimeRoot, 'work'), control = join(runtimeRoot, 'control');
  for (const path of [profile, work, control, join(profile, 'skills'), join(profile, 'memories')]) await privateDirectory(path);
  const inputs = await mkdtemp(join(runtimeRoot, 'inputs-')), skills = join(inputs, 'skills'), plugins = join(inputs, 'plugins');
  for (const path of [inputs, skills, plugins]) await privateDirectory(path);
  const { python, dependencyRoots } = await supervisorPython(config);
  for (const name of ['.env', 'config.yaml']) await copyOptional(join(sourceHome, name), join(profile, name), { clearMissing: true });
  // A refreshed private OAuth cache survives restarts until the human's source
  // auth generation changes. The generation marker itself is host-only.
  const sourceAuth = await readOptional(join(sourceHome, 'auth.json')), generationPath = join(control, 'auth-source.json');
  const sourceDigest = sourceAuth === null ? null : createHash('sha256').update(sourceAuth).digest('hex');
  const generationBytes = await readOptional(generationPath); let generation;
  try { generation = generationBytes === null ? null : JSON.parse(generationBytes.toString('utf8')); }
  catch { throw fail('总控认证代次记录无效。'); }
  if (generation && (generation.version !== 1 || generation.sourceSha256 !== null && !/^[a-f0-9]{64}$/.test(generation.sourceSha256))) throw fail('总控认证代次记录无效。');
  const authPath = join(profile, 'auth.json');
  if (sourceAuth === null) await removeOptional(authPath);
  else if (!generation || generation.sourceSha256 !== sourceDigest || await readOptional(authPath) === null) await privateFile(authPath, sourceAuth);
  await privateFile(generationPath, JSON.stringify({ version: 1, sourceSha256: sourceDigest }));
  for (const name of ['MEMORY.md', 'USER.md']) await copyOptional(join(sourceHome, 'memories', name), join(profile, 'memories', name), { onlyOnce: true });
  await copyLibrary(join(sourceHome, 'skills'), skills);
  await copyLibrary(join(sourceHome, 'plugins'), plugins);
  // Native Hermes discovers user plugins at its fixed home/plugins path. Use a
  // fresh verified copy each launch; never overlay an old plugin directory.
  const pluginPath = join(profile, 'plugins'), stagedPlugins = join(inputs, 'active-plugins');
  await copyLibrary(plugins, stagedPlugins);
  try { const old = await lstat(pluginPath); if (!old.isDirectory() || old.isSymbolicLink() || await realpath(pluginPath) !== pluginPath) throw fail('总控插件副本身份已变化。'); await rm(pluginPath, { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rename(stagedPlugins, pluginPath);
  const configPath = join(profile, 'config.yaml');
  if (await readOptional(configPath) === null) await privateFile(configPath, '{}\n');
  await rewrite(python, [join(config.appRoot, 'python', 'supervisor_profile.py'), configPath, skills, work], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', HERMES_DISABLE_LAZY_INSTALLS: '1' },
  });
  const readOnlyRoots = [configPath, join(profile, '.env'), inputs, pluginPath, control];
  return { profile, work, python, dependencyRoots, readOnlyRoots, runtimeRoot };
}
