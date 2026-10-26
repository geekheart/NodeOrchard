import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {homedir} from 'node:os';
test('DAG imports bind completed source attempts and human reviews cover exact current file bytes',()=>{
  execFileSync(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'),
    ['-B',fileURLToPath(new URL('./hdk-dag-import.test.py',import.meta.url))],
    {encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:1048576});
});
