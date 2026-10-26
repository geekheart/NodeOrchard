import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('HDK documents match exact current parts and retain verifiable sources with explicit gaps', () => {
  const result = execFileSync('python3', [fileURLToPath(new URL('./hdk-datasheets.test.py', import.meta.url))], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.equal(result.trim(), '');
});
