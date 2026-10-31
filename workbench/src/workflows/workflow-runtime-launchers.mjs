import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { inspectSoftware } from '../application-software-inspector.mjs';

const ALIASES = Object.freeze({
  blender: ['blender', 'Blender', 'blender.exe', 'Blender.exe'],
  freecad: ['freecadcmd', 'FreeCADCmd', 'freecadcmd.exe', 'FreeCADCmd.exe'],
  ffmpeg: ['ffmpeg', 'ffmpeg.exe'],
});
const fail = (code, message) => Object.assign(new Error(message), { code });
const check = signal => { if (signal?.aborted) throw fail('ABORTED', '执行已停止。'); };
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

// This executor-owned preparation seam has no model tool schema. Each fixed
// launcher execs one discovered CLI and forwards the caller's argument vector
// literally, rather than interpolating business arguments into shell text.
export async function prepareRuntimeLaunchers(baseEnv, { signal, platform = process.platform,
  path = baseEnv.PATH || '', temporaryRoot = tmpdir(), inspectionOptions = {} } = {}) {
  check(signal);
  const env = { ...baseEnv }, aliases = [];
  const empty = { env, aliases, directory: null, cleanup: async () => {} };
  if (platform !== 'darwin') return empty;
  const probe = await inspectSoftware({}, { software: Object.keys(ALIASES) }, { ...inspectionOptions, platform, path, signal });
  check(signal);
  const found = probe.software.filter(entry => entry.executable && typeof entry.selectedPath === 'string'
    && isAbsolute(entry.selectedPath) && !/[\u0000-\u001f\u007f]/.test(entry.selectedPath));
  if (!found.length) return empty;
  let directory;
  try {
    directory = await mkdtemp(join(temporaryRoot, 'workbench-runtime-cli-'));
    await chmod(directory, 0o700);
    const bin = join(directory, 'bin');
    await mkdir(bin, { mode: 0o700 });
    for (const entry of found) {
      check(signal);
      const home = join(directory, entry.id, 'home'), config = join(home, 'config'), cache = join(home, 'cache');
      await mkdir(config, { recursive: true, mode: 0o700 });
      await mkdir(cache, { recursive: true, mode: 0o700 });
      const freecadTemp = join(home, 'tmp');
      if (entry.id === 'freecad') await mkdir(freecadTemp, { mode: 0o700 });
      const source = entry.candidates.find(candidate => candidate.path === entry.selectedPath)?.source;
      if (!['path', 'macos-app'].includes(source)) throw fail('CODE_ENVIRONMENT', '软件命令来源未确认。');
      const content = '#!/bin/sh\n' + [['HOME', home], ['XDG_CONFIG_HOME', config], ['XDG_CACHE_HOME', cache],
        ...(entry.id === 'freecad' ? [['QT_QPA_PLATFORM', 'offscreen'], ['FREECAD_USER_HOME', home],
          ['FREECAD_USER_DATA', config], ['FREECAD_USER_TEMP', freecadTemp]] : [])]
        .map(([key, value]) => 'export ' + key + '=' + quote(value)).join('\n')
        + '\nexec ' + quote(entry.selectedPath) + ' "$@"\n';
      for (const command of ALIASES[entry.id]) {
        check(signal);
        const target = join(bin, command);
        try { await writeFile(target, content, { flag: 'wx', mode: 0o700 }); }
        catch (error) {
          // macOS volumes may fold case. Only accept our identical regular
          // launcher already written under another fixed casing.
          if (error.code !== 'EEXIST' || !(await lstat(target)).isFile() || await readFile(target, 'utf8') !== content) throw error;
        }
        aliases.push({ software: entry.id, command, source });
      }
    }
    check(signal);
    env.PATH = path ? path + ':' + bin : bin;
    return { env, aliases, directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    check(signal);
    throw fail('CODE_ENVIRONMENT', '无法准备本次执行的软件命令入口。');
  }
}
