import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const [name, script] of [
  ['manufacturing workbook retains native controls and readable snapshots', 'test_process_requirements.py'],
  ['firmware constraint learning binds real inputs and cannot replace validation', 'hdk-profile-learning.test.py'],
  ['manufacturing constraint learning checks source nets and held-out requirements', 'hdk-process-profile-learning.test.py'],
]) {
  test(`HDK ${name}`, () => {
    const output = execFileSync('python3', [fileURLToPath(new URL('./' + script, import.meta.url))], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
    });
    assert.equal(output.trim(), '');
  });
}
