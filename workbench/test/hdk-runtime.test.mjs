import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('HDK workflow executes the same graph for learning in isolated directories and grades real artifact evidence without hiding invalid plans', () => {
  const result=execFileSync('python3',[fileURLToPath(new URL('./hdk-runtime.test.py',import.meta.url))],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.equal(result.trim(),'');
});
