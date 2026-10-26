import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
test('SDK setup and first-run behavior are source-bound without installing or flashing',()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const python=join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
  const result=spawnSync(python,['-I',join(root,'test/python/test_guide_sdk.py')],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
