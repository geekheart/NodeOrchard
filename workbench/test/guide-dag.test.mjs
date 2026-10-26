import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';

test('guide DAG input/import/attempt/Skill boundaries use isolated real SQLite, Git, native ZIP and image files', t => {
  const python = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
  const result = spawnSync(python, ['-B', fileURLToPath(new URL('./guide-dag.test.py', import.meta.url))], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 1048576,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const summary = result.stderr.match(/Ran \d+ tests[\s\S]*?\n(?:OK[^\n]*)/);
  if (summary) t.diagnostic('Python guide DAG: ' + summary[0].replace(/\s+/g, ' '));
  if (summary?.[0].includes('skipped=')) t.diagnostic('Only optional OpenInterfaceMark core integrations were skipped. Prepare the fixed checkout in docs/openinterfacemark-integration.md and run node scripts/openinterfacemark-convert.mjs --check; source planning, input binding and artifact validators still run.');
});
