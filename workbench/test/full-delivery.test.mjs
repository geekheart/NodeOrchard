import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKFLOW_TOOLS } from '../shared/workflow/workflow-tools.mjs';

const python = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
test('HDK assembly, delivery verification and archive expose separate registered stages', () => {
  const get = suffix => WORKFLOW_TOOLS.find(tool => tool.id === 'hdk.full.' + suffix);
  assert.deepEqual(get('assemble').ports.inputs, get('verify').ports.inputs);
  for (const suffix of ['verify-delivery', 'archive-delivery']) {
    assert.deepEqual(get(suffix).ports.inputs.map(port => [port.id, port.type, port.required]), [['in', 'object', true]]);
  }
});
test('HDK delivery stages enforce current reviews, file integrity and portable inventories', () => {
  execFileSync(python, ['-B', fileURLToPath(new URL('./full-delivery.test.py', import.meta.url))],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 1048576 });
});
test('SOP runtime correction preserves compiled binaries and updates bound operator documents', () => {
  execFileSync(python, ['-B', fileURLToPath(new URL('./full-sop-runtime.test.py', import.meta.url))],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 1048576 });
});
