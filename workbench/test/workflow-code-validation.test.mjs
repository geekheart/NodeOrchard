import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const python = process.env.WORKBENCH_TEST_PYTHON || 'python3';
const validator = fileURLToPath(new URL('../python/workflow_code_validation.py', import.meta.url));
const check = (request, { cwd } = {}) => {
  const result = spawnSync(python, ['-B', validator], {
    input: JSON.stringify(request), encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024, cwd,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
};

test('static Python checker uses the real function-body wrapper and leaves script literal contents intact', () => {
  const result = check({ code: "script = '''import json\nvalue = True\n'''\nreturn script" });
  assert.equal(result.status, 'valid');
  assert.equal(result.analysisOnly, true);
  assert.equal(result.executed, false);
  assert.equal(result.body.valid, true);
  assert.deepEqual(result.wrapper, { kind: 'ast-function', stringConstantsPreserved: true, sourceStringConstants: 1, wrappedStringConstants: 1 });
  assert.deepEqual(result.nestedScripts, []);
});

test('static checker checks only explicitly named literal Python scripts and leaves dynamic templates unexecuted', () => {
  const result = check({ code: [
    "notes = '''Ordinary prose, not Python!'''",
    "conversion = '''import json\nvalue = __ROOT__\n'''.replace('__ROOT__', repr(input))",
    "render_script = '''import math\n    unexpected = True\n'''",
    'return notes',
  ].join('\n'), pythonScriptVariables: ['conversion', 'render_script'] });
  assert.equal(result.body.valid, true);
  assert.equal(result.status, 'invalid');
  assert.deepEqual(result.nestedScripts.map(item => ({ variable: item.variable, status: item.status, kind: item.kind })), [
    { variable: 'conversion', status: 'valid', kind: 'literal-template' },
    { variable: 'render_script', status: 'invalid', kind: 'literal' },
  ]);
  assert.equal(result.nestedScripts[0].substitutionsEvaluated, false);
  assert.equal(result.nestedScripts[1].error.type, 'IndentationError');
  assert.equal(result.nestedScripts[1].error.line, 2);
  assert.equal(JSON.stringify(result).includes('unexpected ='), false);
});

test('static checking never imports dependencies, executes dynamic code, or creates user-code side effects', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'workflow-static-check-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'validation_side_effect_fixture.py'), "from pathlib import Path\nPath('imported.txt').write_text('unexpected')\n");
  const result = check({ code: [
    'import validation_side_effect_fixture',
    "from pathlib import Path",
    "Path('body-ran.txt').write_text('unexpected')",
    "exec(\"Path('dynamic-ran.txt').write_text('unexpected')\")",
    "print('USER CODE MUST NOT PRINT')",
    "script = '''raise RuntimeError('nested must not run')'''",
    'return None',
  ].join('\n'), pythonScriptVariables: ['script'] }, { cwd });
  assert.equal(result.status, 'valid');
  assert.equal(result.nestedScripts[0].status, 'valid');
  for (const name of ['imported.txt', 'body-ran.txt', 'dynamic-ran.txt']) await assert.rejects(access(join(cwd, name)), { code: 'ENOENT' });
  assert.equal((await readFile(join(cwd, 'validation_side_effect_fixture.py'), 'utf8')).includes('unexpected'), true);
});

test('static checking reports invalid bodies without returning a source line or literal contents', () => {
  const result = check({ code: "secret = 'fixture-private-value'\nreturn = secret" });
  assert.equal(result.status, 'invalid');
  assert.equal(result.body.valid, false);
  assert.equal(result.body.error.type, 'SyntaxError');
  assert.equal(result.body.error.line, 2);
  assert.equal(Object.hasOwn(result.body.error, 'text'), false);
  assert.equal(JSON.stringify(result).includes('fixture-private-value'), false);
  assert.equal(JSON.stringify(result).includes('return ='), false);
  for (const code of ['break', 'continue', 'await input']) assert.equal(check({ code }).body.valid, false);
});

test('dynamic or reassigned script sources remain unavailable instead of being executed or guessed', () => {
  const result = check({ code: "dynamic = input\nreassigned = 'pass'\nreassigned = input\nreturn None", pythonScriptVariables: ['dynamic', 'reassigned', 'absent'] });
  assert.equal(result.body.valid, true);
  assert.deepEqual(result.nestedScripts.map(item => item.status), ['unavailable', 'unavailable', 'unavailable']);
  assert.equal(check({ code: "return '''not Python prose!!!'''" }).status, 'valid');
});

test('static checker rejects an empty statement body and enforces fixed request and identifier limits', () => {
  assert.equal(check({ code: '# a comment without a statement' }).body.valid, false);
  for (const code of ['', 'x'.repeat(100001)]) assert.equal(check({ code }).body.valid, false);
  for (const pythonScriptVariables of [['../private'], ['a', 'a'], Array.from({ length: 9 }, (_, i) => 'script' + i), ['__private']]) {
    assert.equal(check({ code: 'return input', pythonScriptVariables }).body.valid, false);
  }
  assert.equal(check({ code: 'return input', path: '/tmp/forbidden' }).status, 'unavailable');
});

test('importing the shared checker does not read stdin, start a worker, or evaluate a request', () => {
  const script = 'import importlib.util,sys\nspec=importlib.util.spec_from_file_location("workflow_validation_fixture",sys.argv[1])\nmodule=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(module)\nprint("import-safe")';
  const result = spawnSync(python, ['-B', '-c', script, validator], { input: '{invalid request', encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'import-safe\n');
  assert.equal(result.stderr, '');
});
