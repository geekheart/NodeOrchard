import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Pinout preparation requires source nets, native numbered pad geometry and calibrated image provenance', () => {
  execFileSync('python3', [fileURLToPath(new URL('./python/test_pinout_facts.py', import.meta.url))],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
});
