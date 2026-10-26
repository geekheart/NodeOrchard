import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';

test('four-file pipeline binds phases, runs, private receipts, source/output hashes and pinned converter provenance', () => {
  const python = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
  execFileSync(python, ['-B', fileURLToPath(new URL('./four-files-pipeline.test.py', import.meta.url))],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 1048576 });
});
