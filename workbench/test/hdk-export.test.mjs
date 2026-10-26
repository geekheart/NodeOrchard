import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('HDK native exporter: isolated preflight, source integrity, complete native columns, safe ZIPs and independent disk verification', () => {
  const result = execFileSync('python3', [fileURLToPath(new URL('./hdk-export.test.py', import.meta.url))], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  assert.equal(result.trim(), '');
});
