import { access, mkdir, realpath, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile as callbackExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cadDependenciesStatus, OPENSTEP2DWG_COMMIT } from './openstep2dwg-convert.mjs';
import { checkPinoutDependencies, OPENPINMAP_COMMIT } from './openpinmap-convert.mjs';

const execFile = promisify(callbackExecFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONVERTERS = join(ROOT, '.local/converters');
const REPOSITORIES = [
  { name: 'OpenStep2DWG', commit: OPENSTEP2DWG_COMMIT },
  { name: 'OpenPinMap', commit: OPENPINMAP_COMMIT },
];

async function run(file, args, cwd = ROOT) {
  process.stderr.write(`[converters] ${file} ${args.join(' ')}\n`);
  const result = await execFile(file, args, { cwd, timeout: 600000, maxBuffer: 2 * 1024 * 1024 });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

export async function checkFourFileConverters() {
  const cad = await cadDependenciesStatus(), pinout = await checkPinoutDependencies();
  return { ready: cad.ready && pinout.ready, cad, pinout };
}

export async function prepareFourFileConverters() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Run converter preparation with Node.js 24 or newer');
  const npmLink = (await execFile('which', ['npm'])).stdout.trim();
  if (!npmLink) throw Error('npm is required for locked dependency installation');
  const npmCli = await realpath(npmLink);
  const python = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
  await access(python);
  await mkdir(CONVERTERS, { recursive: true });
  const provenance = { schemaVersion: 1, preparedAt: new Date().toISOString(), node: process.version, converters: [] };
  for (const repository of REPOSITORIES) {
    const directory = join(CONVERTERS, repository.name);
    const exists = await access(directory).then(() => true, () => false);
    if (!exists) await run('git', ['clone', `https://github.com/geekheart/${repository.name}.git`, directory]);
    await run('git', ['diff', '--quiet', 'HEAD', '--'], directory);
    const commitAvailable = await execFile('git', ['cat-file', '-e', repository.commit + '^{commit}'], { cwd: directory }).then(() => true, () => false);
    if (!commitAvailable) await run('git', ['fetch', 'origin', repository.commit], directory);
    await run('git', ['checkout', '--detach', repository.commit], directory);
    await run(process.execPath, [npmCli, 'ci'], directory);
    await run(process.execPath, ['scripts/build.mjs'], directory);
    const lock = await readFile(join(directory, 'package-lock.json'));
    provenance.converters.push({ name: repository.name, repository: `https://github.com/geekheart/${repository.name}`, commit: repository.commit, lockSha256: createHash('sha256').update(lock).digest('hex') });
  }
  const environment = join(CONVERTERS, 'qa-python');
  if (!(await access(join(environment, 'bin/python')).then(() => true, () => false))) await run(python, ['-m', 'venv', environment]);
  await run(join(environment, 'bin/python'), ['-m', 'pip', 'install', '-r', join(ROOT, 'scripts/requirements-cad-qa.txt')]);
  const status = await checkFourFileConverters();
  if (!status.ready) throw Error('Prepared converters did not pass their dependency checks: ' + JSON.stringify(status));
  await writeFile(join(CONVERTERS, 'prepared.json'), JSON.stringify({ ...provenance, checks: status }, null, 2) + '\n');
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2] || '--check';
    if (!['--check', '--install'].includes(mode) || process.argv.length > 3) throw Error('Usage: node scripts/prepare-four-files-converters.mjs [--check|--install]');
    const result = mode === '--install' ? await prepareFourFileConverters() : await checkFourFileConverters();
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.ready) process.exitCode = 1;
  } catch (error) { process.stderr.write(`[converters] ${error.message}\n`); process.exitCode = 1; }
}
