import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('four-file native adapter protects sources, binds its copy and verifies real SCH/STEP receipts', () => {
  execFileSync('python3', [fileURLToPath(new URL('./four-files-native.test.py', import.meta.url))],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
});
