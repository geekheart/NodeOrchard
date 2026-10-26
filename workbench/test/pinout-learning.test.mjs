import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

test('Pinout learning measures actual PNG pixels, SVG geometry and current-source label trace', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const python = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
  const result = spawnSync(python, ['-I', path.join(root, 'test/pinout-learning.test.py')], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
