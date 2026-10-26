#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const privateDocs = new Set([
  'verification.md', 'workflow-refactor-log.md', 'pinout-learning-result.md',
  'pinout-learning-evaluation.md', 'user-guide-reference-audit.md',
]);

// Match local data boundaries, not every directory named "workflow": shared/workflow
// and examples/*.workflow.json are intentionally publishable application source.
export function pathBoundaryViolation(path) {
  const name = String(path).replaceAll('\\', '/').replace(/^\.\//, '');
  const appPath = name.replace(/^workbench\//, '');
  const parts = name.toLowerCase().split('/');
  const file = parts.at(-1);
  if (/^(?:workbench\/)?workflow(?:\/|$)/i.test(name)) return 'local-workflow';
  if (/^(?:multica|design)(?:\/|$)/i.test(name)) return 'local-reference-material';
  if (parts.some(part => ['.local', 'workspaces', '.workbench-runs', '.workbench-skills',
    '.workbench-learning-memory', 'workflow-snapshots', 'learned-skills', '.hermes', '.ssh', '.aws'].includes(part))) return 'local-runtime-state';
  if (/^hdk\/learning(?:\/|$)/i.test(appPath)
      && !/^hdk\/learning\/[^/]+\.schema\.json$/i.test(appPath)
      && appPath !== 'hdk/learning/README.md') return 'private-learning-record';
  if (/^hdk\/[^/]+\.json$/i.test(appPath)) return 'private-hardware-case';
  if (appPath === 'skills/labels.json') return 'private-skill-preferences';
  if (/^docs\/refactor-evidence(?:\/|$)/i.test(appPath)
      || /^docs\/[^/]+\.(?:png|jpe?g|webp|gif|json)$/i.test(appPath)
      || (appPath.startsWith('docs/') && privateDocs.has(appPath.slice(5)))) return 'private-verification-evidence';
  if (/^(?:learned[-_]skill|skill[-_](?:learning|candidate))(?:\.|[-_])/i.test(file)
      || /(?:^|\/)skills\/(?:learned|generated|snapshots|candidates)(?:\/|$)/i.test(name)) return 'derived-skill-artifact';
  if (/^\.env(?:\.|$)/i.test(file) && !/^\.env\.(?:example|template|sample)$/i.test(file)) return 'private-environment';
  if (/\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/i.test(file)) return 'local-database';
  if (/^(?:auth|credentials?|tokens?|secrets?)\.(?:json|ya?ml|toml)$/i.test(file)
      || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i.test(file)
      || /\.(?:p12|pfx|key)$/i.test(file)) return 'credential-file';
  if (/\.(?:epro2|oim\.json|opm\.json)$/i.test(file)) return 'private-engineering-artifact';
  return null;
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function outside(root, path) {
  const difference = relative(root, path);
  return difference === '..' || difference.startsWith('..' + sep) || isAbsolute(difference);
}

function personalPathLiteral(text) {
  const literals = text.matchAll(/\/(?:Users|home)\/([^/\s<>"'`]+)\//g);
  return [...literals].some(([, user]) => !/^(?:user|username|example|example-user|your-user|runner|USER|USERNAME|\$\{[^}]+\})$/.test(user));
}

/** Read only publish candidates; private directories are rejected before file reads. */
export async function checkGitBoundary({ repo, personalPaths = false }) {
  const root = await realpath(resolve(repo));
  const paths = [...new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort();
  // A staged link may differ from the worktree. Inspect its target without following it.
  const staged = new Map(git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean)
    .flatMap(entry => { const match = entry.match(/^([0-7]+) ([0-9a-f]+) 0\t([\s\S]+)$/); return match ? [[match[3], { mode: match[1], object: match[2] }]] : []; }));
  const violations = [];
  for (const path of paths) {
    const rule = pathBoundaryViolation(path);
    if (rule) { violations.push({ path, rule }); continue; }
    const absolutePath = resolve(root, path);
    if (outside(root, absolutePath)) { violations.push({ path, rule: 'outside-repository' }); continue; }
    if (staged.get(path)?.mode === '120000') {
      const target = git(root, ['cat-file', 'blob', staged.get(path).object]);
      const destination = resolve(dirname(absolutePath), target);
      if (outside(root, destination) || pathBoundaryViolation(relative(root, destination))) {
        violations.push({ path, rule: 'private-symlink-target' }); continue;
      }
    }
    if (personalPaths && staged.has(path) && staged.get(path).mode !== '120000'
        && /\.(?:[cm]?js|[cm]?ts|jsx|tsx|jsonl?|md|txt|ya?ml|toml|py|sh|css|html|csv)$/i.test(path)
        && Number(git(root, ['cat-file', '-s', staged.get(path).object])) <= 2 * 1024 * 1024) {
      const content = git(root, ['cat-file', 'blob', staged.get(path).object]);
      if (!content.includes('\0') && personalPathLiteral(content)) {
        violations.push({ path, rule: 'personal-home-literal' }); continue;
      }
    }
    let details;
    try { details = await lstat(absolutePath); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (details.isSymbolicLink()) {
      let destination;
      try { destination = await realpath(absolutePath); }
      catch (error) {
        if (!['ENOENT', 'ELOOP'].includes(error.code)) throw error;
        violations.push({ path, rule: 'unresolved-symlink-target' }); continue;
      }
      const rawTarget = resolve(dirname(absolutePath), await readlink(absolutePath));
      if (outside(root, destination) || pathBoundaryViolation(relative(root, rawTarget))
          || pathBoundaryViolation(relative(root, destination))) violations.push({ path, rule: 'private-symlink-target' });
      continue;
    }
    if (personalPaths && details.isFile() && details.size <= 2 * 1024 * 1024
        && /\.(?:[cm]?js|[cm]?ts|jsx|tsx|jsonl?|md|txt|ya?ml|toml|py|sh|css|html|csv)$/i.test(path)) {
      const content = await readFile(absolutePath, 'utf8');
      if (!content.includes('\0') && personalPathLiteral(content)) violations.push({ path, rule: 'personal-home-literal' });
    }
  }
  return { candidateCount: paths.length, violations };
}

async function main(args) {
  let repo = fileURLToPath(new URL('../../', import.meta.url));
  let personalPaths = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--repo' && args[index + 1]) repo = args[++index];
    else if (args[index] === '--personal-paths') personalPaths = true;
    else if (args[index] === '--help') {
      process.stdout.write('Usage: node workbench/scripts/check-git-boundary.mjs [--repo PATH] [--personal-paths]\n'); return;
    } else throw new Error('Unsupported argument. Use --help.');
  }
  const result = await checkGitBoundary({ repo, personalPaths });
  for (const { path, rule } of result.violations) process.stderr.write(`${JSON.stringify(path)}: ${rule}\n`);
  if (result.violations.length) {
    process.stderr.write(`Git boundary check failed: ${result.violations.length} blocked file(s). No files or index entries were changed.\n`);
    process.exitCode = 1;
  } else process.stdout.write(`Git boundary check passed: ${result.candidateCount} publish candidate(s).\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('Git boundary check could not complete. Verify the repository and file permissions; no files or index entries were changed.\n');
    process.exitCode = 2;
  });
}
