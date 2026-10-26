import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
test('DrawIO source-template adapter retains actual layout and verifies source, audit and embedded exports', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = await run('python3', ['-m', 'unittest', 'discover', '-s', 'test/python', '-p', 'test_guide_drawio_template_v2.py'], { cwd: root });
  assert.match(result.stderr, /Ran 23 tests/);
  assert.match(result.stderr, /OK/);
});
