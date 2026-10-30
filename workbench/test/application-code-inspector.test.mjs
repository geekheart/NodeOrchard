import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, access, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectWorkflowCode, CODE_INSPECTION_LIMITS } from '../src/application-code-inspector.mjs';

function fixture(code = 'return input') {
  const document = { id: 'workflow-a', mode: 'execute', nodes: [{ id: 'python-node', type: 'tool', config: { executionMode: 'code', language: 'python', code } }] };
  const runs = { 'run-a': { id: 'run-a', workflowId: document.id, document: structuredClone(document) } };
  const app = { config: {}, workflowLibrary: {
    assertAvailable: id => assert.equal(id, document.id), get: id => { assert.equal(id, document.id); return { document, revision: 3 }; },
  }, workflows: { get: id => runs[id] } };
  return { app, document, runs, args: { workflowId: document.id, nodeId: 'python-node' } };
}

test('static check uses real executor wrapping without running code, imports or nested scripts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'code-inspector-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sentinel = join(directory, 'must-not-exist');
  const f = fixture(`import missing_private_package\nopen(${JSON.stringify(sentinel)}, 'w').write('unsafe')\nscript = "import json\\nprint(json.dumps({'ok': True}))\\n"\nexec(script)\nreturn input`);
  const result = await inspectWorkflowCode(f.app, { ...f.args, pythonScriptVariables: ['script'] });
  assert.equal(result.status, 'valid'); assert.equal(result.body.valid, true); assert.equal(result.executed, false);
  assert.equal(result.source, 'saved-workflow'); assert.equal(result.revision, 3); assert.match(result.codeSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.nestedScripts[0].status, 'valid'); assert.equal(result.wrapper.stringConstantsPreserved, true);
  assert(!JSON.stringify(result).includes('missing_private_package')); assert(!JSON.stringify(result).includes(sentinel));
  await assert.rejects(access(sentinel), { code: 'ENOENT' });
});

test('syntax failures remain useful findings and only declared nested scripts are checked', async () => {
  const f = fixture('return (');
  const invalid = await inspectWorkflowCode(f.app, f.args);
  assert.equal(invalid.status, 'invalid'); assert.equal(invalid.body.valid, false); assert.equal(invalid.wrapper, null);
  f.document.nodes[0].config.code = 'poster = "This is not Python."\nscript = "import os\\n    print(1)"\nreturn poster';
  assert.equal((await inspectWorkflowCode(f.app, f.args)).status, 'valid');
  const nested = await inspectWorkflowCode(f.app, { ...f.args, pythonScriptVariables: ['script'] });
  assert.equal(nested.status, 'invalid'); assert.equal(nested.body.valid, true); assert.equal(nested.nestedScripts[0].error.line, 2);
});

test('current drafts and frozen runs have distinct code identities without changing either', async () => {
  const f = fixture('return 1'); f.document.nodes[0].config.code = 'return 2';
  const frozen = JSON.stringify(f.runs), draft = JSON.stringify(f.document);
  const a = await inspectWorkflowCode(f.app, { ...f.args, runId: 'run-a' });
  const b = await inspectWorkflowCode(f.app, f.args, { document: f.document });
  assert.equal(a.source, 'frozen-run'); assert.equal(b.source, 'current-draft'); assert.notEqual(a.codeSha256, b.codeSha256);
  assert.equal(JSON.stringify(f.runs), frozen); assert.equal(JSON.stringify(f.document), draft);
  for (const extra of [{ workflowId: 'foreign' }, { learningId: 'learning-private' }, { parentRunId: 'parent-private' }]) {
    Object.assign(f.runs['run-a'], extra);
    await assert.rejects(inspectWorkflowCode(f.app, { ...f.args, runId: 'run-a' }), { code: 'CODE_CHECK_SCOPE_INVALID' });
    f.runs['run-a'] = { id: 'run-a', workflowId: f.document.id, document: f.document };
  }
});

test('checker rejects arbitrary code, paths, languages, oversized input and malformed parameters', async () => {
  const f = fixture();
  for (const args of [{ ...f.args, code: 'return 1' }, { ...f.args, path: '/tmp/code.py' }, { ...f.args, pythonScriptVariables: ['a.b'] },
    { ...f.args, pythonScriptVariables: ['__private'] }, { ...f.args, pythonScriptVariables: new Array(1) }, { ...f.args, nodeId: '../node' }]) {
    await assert.rejects(inspectWorkflowCode(f.app, args), { code: 'CODE_CHECK_ARGUMENT_INVALID' });
  }
  f.document.nodes[0].config.language = 'javascript';
  await assert.rejects(inspectWorkflowCode(f.app, f.args), { code: 'CODE_CHECK_NODE_INVALID' });
  f.document.nodes[0].config.language = 'python'; f.document.nodes[0].config.code = 'x'.repeat(CODE_INSPECTION_LIMITS.codeCharacters + 1);
  await assert.rejects(inspectWorkflowCode(f.app, f.args), { code: 'CODE_CHECK_TOO_LARGE' });
});

test('validator output is a whitelist projection and cannot replace server-owned source identity', async () => {
  const f = fixture(), privateValue = 'PRIVATE_VALIDATOR_FIELD';
  const normal = await inspectWorkflowCode(f.app, f.args);
  const forged = { ...normal, workflowId: 'foreign', nodeId: 'foreign-node', source: privateValue, codeSha256: privateValue,
    code: privateValue, secret: privateValue, body: { valid: true, source: privateValue },
    wrapper: { kind: 'ast-function', stringConstantsPreserved: true, sourceStringConstants: 0, wrappedStringConstants: 0, code: privateValue } };
  const result = await inspectWorkflowCode(f.app, f.args, { runner: async () => ({ stdout: JSON.stringify(forged) }) });
  assert.equal(result.workflowId, f.document.id); assert.equal(result.nodeId, f.args.nodeId); assert.equal(result.source, 'saved-workflow');
  assert.equal(result.codeSha256, normal.codeSha256); assert(!JSON.stringify(result).includes(privateValue));
});

test('checker cancellation and runner failures expose no command output or credentials', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(inspectWorkflowCode(f.app, f.args, { signal: controller.signal }), { code: 'ABORTED' });
  const secret = 'PRIVATE_STDERR_TOKEN';
  await assert.rejects(inspectWorkflowCode(f.app, f.args, { runner: async () => { throw new Error(secret); } }), error => error.code === 'CODE_CHECK_UNAVAILABLE' && !error.message.includes(secret));
  await assert.rejects(inspectWorkflowCode(f.app, f.args, { runner: async () => ({ stdout: secret }) }), { code: 'CODE_CHECK_PROTOCOL_INVALID' });
  const late = new AbortController();
  await assert.rejects(inspectWorkflowCode(f.app, f.args, { signal: late.signal, runner: async () => { late.abort(); return { stdout: '{}' }; } }), { code: 'ABORTED' });
});

test('the real validator subprocess honors in-flight cancellation and its fixed timeout', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'code-inspector-cancel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'fixture-python');
  await writeFile(binary, '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o700 });
  const f = fixture(); f.app.config.hermesPython = binary;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(inspectWorkflowCode(f.app, f.args, { signal: controller.signal }), { code: 'ABORTED' }); }
  finally { clearTimeout(timer); }
  const started = Date.now();
  await assert.rejects(inspectWorkflowCode(f.app, f.args), { code: 'CODE_CHECK_UNAVAILABLE' });
  assert(Date.now() - started >= CODE_INSPECTION_LIMITS.timeoutMs - 100);
  assert(Date.now() - started < CODE_INSPECTION_LIMITS.timeoutMs + 5000);
});
