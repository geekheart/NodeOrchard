import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('C61 capability binds the current UART netlist and emits a separate replayable target without flashing', () => {
  const result = execFileSync('python3', [fileURLToPath(new URL('./hdk-companion.test.py', import.meta.url))], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.equal(result.trim(), '');
});
