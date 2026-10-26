import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';

test('V2 Pinout namespace policy uses real labels and source numbers while preserving all twelve other legacy checks', () => {
  const python = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
  execFileSync(python, ['-B', fileURLToPath(new URL('./pinout-evaluation-v2.test.py', import.meta.url))],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 1048576 });
});
