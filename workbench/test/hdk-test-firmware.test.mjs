import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('HDK test firmware uses native instance pins, rejects guessed targets and protects build evidence',()=>{
 const out=execFileSync('python3',[fileURLToPath(new URL('./hdk-test-firmware.test.py',import.meta.url))],{encoding:'utf8',stdio:['ignore','pipe','pipe']});assert.equal(out.trim(),'');
});
