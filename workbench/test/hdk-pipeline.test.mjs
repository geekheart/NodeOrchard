import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('HDK full pipeline gates real training proof and keeps fixed capability routes and run artifacts isolated', () => {
  const result = execFileSync('python3', [fileURLToPath(new URL('./hdk-pipeline.test.py', import.meta.url))], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.trim(), '');
});
