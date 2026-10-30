import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { executeOperation, validateOperationNode, OPERATION_LIMITS } from '../src/workflows/workflow-operations.mjs';
import { createDocument, createNode, connectNodes, validateDocument } from '../shared/workflow/workflow-model.mjs';
import { planWorkflow } from '../shared/workflow/workflow-plan.mjs';
import { WORKFLOW_TOOLS, validateWorkflowToolConfig } from '../shared/workflow/workflow-tools.mjs';

const operation = (config = {}) => ({ type: 'tool', config: {
  executionMode: 'code', language: 'javascript', code: 'return input;', toolName: '',
  inputType: 'any', outputType: 'any', timeoutSeconds: 5, ...config,
} });
const tool = (toolName, config = {}) => operation({ executionMode: 'tool', toolName, ...config });

async function workspace(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'workflow-code-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('metadata and pure validator select exactly one active implementation and enforce known ports', () => {
  assert.deepEqual(WORKFLOW_TOOLS.map(item => item.id), ['text.trim', 'text.uppercase', 'json.parse', 'json.stringify', 'json.keys']);
  assert.equal(new Set(WORKFLOW_TOOLS.map(item => item.id)).size, WORKFLOW_TOOLS.length);
  assert.ok(Object.isFrozen(WORKFLOW_TOOLS));
  assert.deepEqual(validateOperationNode(tool('text.trim', { code: 'while(true){}', language: 'ignored inactive language', inputType: 'text', outputType: 'text' })),
    { kind: 'tool', toolName: 'text.trim' });
  assert.deepEqual(validateWorkflowToolConfig(operation({ toolName: 'unavailable.inactive' })), { kind: 'code', language: 'javascript' });
  for (const config of [
    { executionMode: 'both' }, { language: 'shell' }, { code: '' }, { code: 'x'.repeat(100001) },
    { executionMode: 'tool', toolName: 'hermes.terminal' },
    { executionMode: 'tool', toolName: 'text.trim', inputType: 'object' },
    { executionMode: 'tool', toolName: 'json.keys', outputType: 'object' },
    { timeoutSeconds: 0 }, { timeoutSeconds: 1.5 }, { outputType: 'fileRef' },
  ]) assert.throws(() => validateOperationNode(operation(config)));
  assert.doesNotThrow(() => validateOperationNode(tool('json.parse', { inputType: 'any', outputType: 'object' })));
  assert.doesNotThrow(() => validateOperationNode(tool('json.stringify', { inputType: 'boolean', outputType: 'any' })));
});

test('built-in tools execute real transformations with no Hermes runtime or code execution', async () => {
  const run = (toolName, input, extra = {}) => executeOperation({ node: tool(toolName, { code: "throw new Error('inactive code executed');", ...extra }), input });
  assert.equal((await run('text.trim', ' \n sample \t')).output, 'sample');
  assert.equal((await run('text.uppercase', 'hello 世界')).output, 'HELLO 世界');
  assert.deepEqual((await run('json.parse', '{"flag":false,"count":0,"nothing":null}')).output, { flag: false, count: 0, nothing: null });
  assert.equal((await run('json.stringify', { flag: false })).output, '{"flag":false}');
  assert.deepEqual((await run('json.keys', { zero: 0, false: false, nothing: null })).output, ['zero', 'false', 'nothing']);
  const result = await run('text.trim', 'done');
  assert.equal(result.outputText, 'done');
  assert.deepEqual(result.runtime, { kind: 'tool', toolName: 'text.trim', revision: 'builtin:text.trim@1' });
  await assert.rejects(run('text.trim', false), { code: 'TOOL_INPUT_INVALID' });
  await assert.rejects(run('json.keys', []), { code: 'TOOL_INPUT_INVALID' });
  await assert.rejects(run('json.parse', '{invalid'), { code: 'TOOL_INPUT_INVALID' });
});

test('JavaScript runs an async function body and keeps typed input/output distinct from console logs', async t => {
  const cwd = await workspace(t);
  const logs = [];
  const node = operation({ code: "console.log('hello stdout'); console.error('hello stderr'); return await Promise.resolve({ data: input, ready: false });" });
  const input = { values: [0, false, null], text: '中文' };
  const result = await executeOperation({ node, input, cwd, onLog: log => logs.push(log) });
  assert.deepEqual(result.output, { data: input, ready: false });
  assert.equal(result.outputText, JSON.stringify(result.output));
  assert.match(result.runtime.revision, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.runtime.kind, 'code');
  assert.equal(result.runtime.language, 'javascript');
  assert.ok(logs.some(log => log.stream === 'stdout' && log.text.includes('hello stdout')));
  assert.ok(logs.some(log => log.stream === 'stderr' && log.text.includes('hello stderr')));
});

test('Python executes a real main function body and preserves JSON null/false/zero', async t => {
  const cwd = await workspace(t);
  const logs = [];
  const code = "import sys\nprint('python stdout')\nprint('python stderr', file=sys.stderr)\nreturn {'data': input, 'false': False, 'zero': 0, 'null': None}";
  const result = await executeOperation({ node: operation({ language: 'python', code }), input: [0, false, null], cwd,
    onLog: log => logs.push(log) });
  assert.deepEqual(result.output, { data: [0, false, null], false: false, zero: 0, null: null });
  assert.equal(result.runtime.language, 'python');
  assert.ok(logs.some(log => log.stream === 'stdout' && log.text.includes('python stdout')));
  assert.ok(logs.some(log => log.stream === 'stderr' && log.text.includes('python stderr')));
});

test('Python preserves multiline script literals when executing a function body', async t => {
  const cwd = await workspace(t);
  const code = [
    "script = '''import json",
    "value = {'ready': True}",
    "'''",
    "compile(script, '<generated-fixture>', 'exec')",
    "return {'script': script, 'input': input}",
  ].join('\n');
  const result = await executeOperation({ node: operation({ language: 'python', code }), input: false, cwd });
  assert.deepEqual(result.output, { script: "import json\nvalue = {'ready': True}\n", input: false });
});

test('Python keeps raw, formatted and bytes literal whitespace and accepts an already indented body', async t => {
  const cwd = await workspace(t);
  const code = [
    "raw = r'''first\\n",
    '    keep these spaces',
    "last'''",
    "formatted = f'''hello {input}",
    "world'''",
    "data = b'''alpha",
    "beta'''",
    "return {'raw': raw, 'formatted': formatted, 'bytes': data.decode('ascii')}",
  ].join('\n');
  assert.deepEqual((await executeOperation({ node: operation({ language: 'python', code }), input: 'Ada', cwd })).output,
    { raw: 'first\\n\n    keep these spaces\nlast', formatted: 'hello Ada\nworld', bytes: 'alpha\nbeta' });
  const indented = "  script = '''first\nnot indented\nlast'''\n  return script";
  assert.equal((await executeOperation({ node: operation({ language: 'python', code: indented }), input: null, cwd })).output,
    'first\nnot indented\nlast');
});

test('raw null, false and zero code results are not treated as missing or converted to strings', async t => {
  const cwd = await workspace(t);
  for (const input of [null, false, 0]) {
    const result = await executeOperation({ node: operation(), input, cwd });
    assert.equal(result.output, input);
    assert.equal(result.outputText, JSON.stringify(input));
  }
});

test('worker exceptions retain preceding stdout/stderr logs and report actual execution failures', async t => {
  const cwd = await workspace(t);
  for (const [language, code] of [
    ['javascript', "console.log('before failure'); console.error('failure detail'); throw new Error('intentional JS failure');"],
    ['python', "import sys\nprint('before failure')\nprint('failure detail', file=sys.stderr)\nraise RuntimeError('intentional Python failure')"],
  ]) {
    const logs = [];
    await assert.rejects(executeOperation({ node: operation({ language, code }), input: null, cwd, onLog: log => logs.push(log) }),
      error => error.code === 'CODE_FAILED' && /代码执行失败/.test(error.message) && /intentional/.test(error.message));
    assert.ok(logs.some(log => log.stream === 'stdout' && log.text.includes('before failure')));
    assert.ok(logs.some(log => log.stream === 'stderr' && log.text.includes('failure detail')));
  }
});

test('typed dependency failures from the real JavaScript worker remain environment failures', async t => {
  const cwd = await workspace(t);
  await assert.rejects(executeOperation({ node: operation({ code: "await import('nodeorchard_absent_learning_dependency_45fff'); return null;" }), input: null, cwd }),
    error => error.code === 'CODE_ENVIRONMENT' && /nodeorchard_absent_learning_dependency_45fff/.test(error.message));
});

test('typed dependency failures from the real Python worker remain environment failures', async t => {
  const cwd = await workspace(t);
  await assert.rejects(executeOperation({ node: operation({ language: 'python', code: 'import nodeorchard_absent_learning_dependency_45fff\nreturn None' }), input: null, cwd }),
    error => error.code === 'CODE_ENVIRONMENT' && /nodeorchard_absent_learning_dependency_45fff/.test(error.message));
});

test('known filesystem failures and Python environment exception families are kept out of business-code failures', async t => {
  const cwd = await workspace(t);
  const cases = [
    ['javascript', "const fs=await import('node:fs'); return fs.readFileSync('missing-input-fixture.txt','utf8');"],
    ['python', "with open('missing-input-fixture.txt') as source:\n    return source.read()"],
    ['python', "raise ImportError('fixture dependency unavailable')"],
    ['python', "raise PermissionError('fixture permission denied')"],
    ['python', "raise ConnectionError('fixture connection failed')"],
    ['python', "raise OSError('fixture environment failed')"],
    ['python', "raise RuntimeError('wrapped dependency') from ModuleNotFoundError('fixture dependency')"],
  ];
  for (const [language, code] of cases) await assert.rejects(executeOperation({ node: operation({ language, code }), input: null, cwd }), { code: 'CODE_ENVIRONMENT' });
});

test('typed JavaScript cause codes identify known connection, DNS, certificate and dependency failures without networking', async t => {
  const cwd = await workspace(t), code = "throw new Error('wrapped fixture failure', {cause: Object.assign(new Error('typed cause'), {code: input})});";
  for (const input of ['MODULE_NOT_FOUND', 'EACCES', 'EPERM', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']) {
    await assert.rejects(executeOperation({ node: operation({ code }), input, cwd }), { code: 'CODE_ENVIRONMENT' });
  }
});

test('business syntax, type and value errors stay CODE_FAILED even when their messages resemble environment failures', async t => {
  const cwd = await workspace(t);
  for (const [language, code] of [
    ['javascript', 'const = ;'], ['javascript', "throw new TypeError('fixture business shape');"],
    ['javascript', "throw Object.assign(new Error('ENOENT Cannot find module ECONNREFUSED CERT_HAS_EXPIRED'), {code:'CUSTOM_BUSINESS_FAILURE'});"],
    ['python', 'return ='], ['python', "raise TypeError('fixture business shape')"],
    ['python', "raise ValueError('No module named ENOENT PermissionError ECONNREFUSED')"],
  ]) await assert.rejects(executeOperation({ node: operation({ language, code }), input: null, cwd }), { code: 'CODE_FAILED' });
});

test('cyclic explicit error causes terminate classification and preserve ordinary failure semantics', async t => {
  const cwd = await workspace(t);
  for (const [language, code] of [
    ['javascript', "const failure=new Error('business cause cycle'); failure.cause=failure; throw failure;"],
    ['python', "failure=RuntimeError('business cause cycle')\nfailure.__cause__=failure\nraise failure"],
  ]) await assert.rejects(executeOperation({ node: operation({ language, code }), input: null, cwd }), { code: 'CODE_FAILED' });
});

test('invalid JSON outputs and inputs are rejected instead of silently coerced', async t => {
  const cwd = await workspace(t);
  for (const code of ['return undefined;', 'return NaN;', 'return {value: undefined};', 'return new Date();', 'const x={}; x.self=x; return x;']) {
    await assert.rejects(executeOperation({ node: operation({ code }), input: null, cwd }), { code: 'OUTPUT_INVALID' });
  }
  for (const code of ['return float("nan")', 'return (1, 2)']) {
    await assert.rejects(executeOperation({ node: operation({ language: 'python', code }), input: null, cwd }), { code: 'OUTPUT_INVALID' });
  }
  for (const input of [undefined, NaN, { value: undefined }, new Date()]) {
    await assert.rejects(executeOperation({ node: operation(), input, cwd }), { code: 'JSON_INVALID' });
  }
});

test('JSON input and output limits include UTF-8 and JSON framing overhead', async t => {
  const cwd = await workspace(t);
  await assert.rejects(executeOperation({ node: operation(), input: '界'.repeat(21845), cwd }), { code: 'INPUT_LIMIT' });
  for (const [language, code] of [
    ['javascript', "return '界'.repeat(22000);"], ['python', "return '界' * 22000"],
  ]) await assert.rejects(executeOperation({ node: operation({ language, code }), input: null, cwd }), { code: 'OUTPUT_LIMIT' });
  const exact = 'x'.repeat(64 * 1024 - 2);
  assert.equal((await executeOperation({ node: operation(), input: exact, cwd })).output, exact);
});

test('Python integers beyond JavaScript safe range fail explicitly instead of losing precision', async t => {
  const cwd = await workspace(t);
  for (const code of ['return 9007199254740993', 'return -9007199254740992', "return {'nested': [9007199254740992]}"]) {
    await assert.rejects(executeOperation({ node: operation({ language: 'python', code }), input: null, cwd }),
      error => error.code === 'OUTPUT_INVALID' && /安全整数范围/.test(error.message) && /字符串/.test(error.message));
  }
  assert.equal((await executeOperation({ node: operation({ language: 'python', code: 'return 9007199254740991' }), input: null, cwd })).output, Number.MAX_SAFE_INTEGER);
  assert.equal((await executeOperation({ node: operation({ language: 'python', code: 'return str(9007199254740993)' }), input: null, cwd })).output, '9007199254740993');
});

test('sparse arrays and non-index array properties are rejected in parent inputs and JS outputs', async t => {
  const cwd = await workspace(t);
  const extra = [0]; extra.extra = false;
  const hidden = [false]; Object.defineProperty(hidden, 'hidden', { value: null });
  for (const input of [[0, , false], extra, hidden, [new Array(10)]]) {
    await assert.rejects(executeOperation({ node: operation(), input, cwd }),
      error => error.code === 'JSON_INVALID' && /空位或额外属性/.test(error.message));
  }
  for (const code of ['return [0,,false];', 'const a=[0]; a.extra=false; return a;', "const a=[]; Object.defineProperty(a,'hidden',{value:null}); return {nested:a};"]) {
    await assert.rejects(executeOperation({ node: operation({ code }), input: null, cwd }),
      error => error.code === 'OUTPUT_INVALID' && /空位或额外属性/.test(error.message));
  }
});

test('stdout and stderr are independently byte bounded and truncated once without corrupting results', async t => {
  const cwd = await workspace(t);
  const logs = [];
  const code = "console.log('界'.repeat(30000)); console.error('x'.repeat(90000)); console.log('more output'); return {actual: 0};";
  const result = await executeOperation({ node: operation({ code }), input: null, cwd, onLog: log => logs.push(log) });
  assert.deepEqual(result.output, { actual: 0 });
  for (const stream of ['stdout', 'stderr']) {
    const own = logs.filter(log => log.stream === stream);
    assert.ok(own.length);
    assert.ok(Buffer.byteLength(own.map(log => log.text).join(''), 'utf8') <= OPERATION_LIMITS.logBytesPerStream);
    assert.equal(own.filter(log => log.truncated).length, 1);
    assert.ok(!own.map(log => log.text).join('').includes('\uFFFD'));
  }
});

test('workers use the supplied workspace and do not inherit arbitrary parent credentials', async t => {
  const cwd = await workspace(t);
  const key = 'WORKFLOW_OPERATION_TEST_CREDENTIAL';
  const previous = process.env[key];
  process.env[key] = 'synthetic-test-only';
  t.after(() => previous === undefined ? delete process.env[key] : process.env[key] = previous);
  const javascript = await executeOperation({ node: operation({ code: `return {cwd: process.cwd(), secret: process.env.${key} ?? null};` }), input: null, cwd });
  const python = await executeOperation({ node: operation({ language: 'python', code: `import os\nreturn {'cwd': os.getcwd(), 'secret': os.environ.get('${key}')}` }), input: null, cwd });
  assert.equal(javascript.output.secret, null);
  assert.equal(python.output.secret, null);
  // macOS may canonicalize /var to /private/var in process cwd.
  assert.ok(javascript.output.cwd.endsWith(cwd.replace(/^\/private/, '')));
  assert.ok(python.output.cwd.endsWith(cwd.replace(/^\/private/, '')));
  await assert.rejects(executeOperation({ node: operation(), input: null, cwd: 'relative/workspace' }), { code: 'WORKSPACE_INVALID' });
  await assert.rejects(executeOperation({ node: operation({ language: 'python' }), input: null, cwd, pythonPath: '/no-such-python' }), { code: 'CODE_START_FAILED' });
});

test('AbortSignal stops infinite JS/Python code and retains logs emitted before cancellation', async t => {
  const cwd = await workspace(t);
  for (const [language, code] of [
    ['javascript', "console.log('started'); while (true) {}"], ['python', "print('started', flush=True)\nwhile True:\n    pass"],
  ]) {
    const controller = new AbortController();
    const logs = [];
    const pending = executeOperation({ node: operation({ language, code }), input: null, cwd, signal: controller.signal,
      onLog: log => { logs.push(log); if (log.text.includes('started')) controller.abort(); } });
    await assert.rejects(pending, { code: 'ABORTED' });
    assert.ok(logs.some(log => log.text.includes('started')));
  }
  const already = new AbortController(); already.abort();
  await assert.rejects(executeOperation({ node: tool('text.trim'), input: 'value', signal: already.signal }), { code: 'ABORTED' });
});

test('configured timeout kills infinite code and overgrown result channels fail instead of hanging', async t => {
  const cwd = await workspace(t);
  await assert.rejects(executeOperation({ node: operation({ code: 'while(true) {}', timeoutSeconds: 1 }), input: null, cwd }), { code: 'TIMEOUT' });
  await assert.rejects(executeOperation({ node: operation({ code: "const fs=await import('node:fs'); fs.writeFileSync(3, 'x'.repeat(1000000)); return null;" }), input: null, cwd }), { code: 'OUTPUT_LIMIT' });
});

test('aborting code also terminates its ordinary child process group', { skip: process.platform === 'win32' }, async t => {
  const cwd = await workspace(t);
  const controller = new AbortController();
  let descendant;
  const code = "const {spawn}=await import('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log('DESCENDANT:'+child.pid); await new Promise(()=>{});";
  const pending = executeOperation({ node: operation({ code }), input: null, cwd, signal: controller.signal, onLog: log => {
    const match = log.text.match(/DESCENDANT:(\d+)/);
    if (match) { descendant = Number(match[1]); controller.abort(); }
  } });
  await assert.rejects(pending, { code: 'ABORTED' });
  assert.ok(descendant > 0);
  let running = true;
  for (let attempt = 0; attempt < 20 && running; attempt++) {
    try { running = !execFileSync('ps', ['-o', 'stat=', '-p', String(descendant)], { encoding: 'utf8' }).trim().startsWith('Z'); }
    catch { running = false; }
    if (running) await delay(20);
  }
  assert.equal(running, false);
});

test('an immediate parent exit after abort cannot strand a worker that ignores SIGTERM', { skip: process.platform === 'win32' }, async () => {
  const entry = new URL('../src/workflows/workflow-operations.mjs', import.meta.url).href;
  const code = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); console.log('WORKER_PID:'+process.pid); await new Promise(()=>{});";
  const node = operation({ code, timeoutSeconds: 10 });
  const program = `import {executeOperation} from ${JSON.stringify(entry)};
    import {writeSync} from 'node:fs';
    const controller=new AbortController();
    await executeOperation({node:${JSON.stringify(node)},input:null,cwd:${JSON.stringify(tmpdir())},signal:controller.signal,
      onLog(log){if(log.text.includes('WORKER_PID:')){writeSync(1,log.text);controller.abort();process.exit(0);}}});`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let workerPid;
  parent.stdout.on('data', chunk => { output += chunk; });
  parent.stderr.resume();
  const watchdog = setTimeout(() => parent.kill('SIGKILL'), 5000);
  try {
    const exitCode = await new Promise((resolve, reject) => { parent.once('close', resolve); parent.once('error', reject); });
    assert.equal(exitCode, 0);
    workerPid = Number(output.match(/WORKER_PID:(\d+)/)?.[1]);
    assert.ok(workerPid > 0);
    let running = true;
    for (let attempt = 0; attempt < 20 && running; attempt++) {
      try { running = !execFileSync('ps', ['-o', 'stat=', '-p', String(workerPid)], { encoding: 'utf8' }).trim().startsWith('Z'); }
      catch { running = false; }
      if (running) await delay(20);
    }
    assert.equal(running, false);
  } finally {
    clearTimeout(watchdog);
    // Also cleans up the regression's intentionally detached worker if this
    // assertion is run against a future broken implementation.
    if (workerPid) { try { process.kill(-workerPid, 'SIGKILL'); } catch {} }
    if (parent.exitCode === null) parent.kill('SIGKILL');
  }
});

test('code workers receive controller run identity separately from untrusted input and inherited environment', async t => {
  const cwd = await workspace(t);
  const before = process.env.WORKBENCH_LEARNING_ID;
  process.env.WORKBENCH_LEARNING_ID = 'untrusted-parent-value';
  t.after(() => { if (before === undefined) delete process.env.WORKBENCH_LEARNING_ID; else process.env.WORKBENCH_LEARNING_ID = before; });
  const context = { runId: 'run-A', workflowId: 'flow-A', nodeId: 'export-node' };
  const javascript = operation({ code: 'return [process.env.WORKBENCH_RUN_ID, process.env.WORKBENCH_WORKFLOW_ID, process.env.WORKBENCH_NODE_ID, process.env.WORKBENCH_LEARNING_ID ?? null];' });
  assert.deepEqual((await executeOperation({ node: javascript, input: { runId: 'forged', learningId: 'forged' }, cwd, context })).output, ['run-A', 'flow-A', 'export-node', null]);
  const python = operation({ language: 'python', code: 'import os\nreturn [os.environ.get(name) for name in ["WORKBENCH_RUN_ID", "WORKBENCH_WORKFLOW_ID", "WORKBENCH_NODE_ID", "WORKBENCH_LEARNING_ID"]]' });
  assert.deepEqual((await executeOperation({ node: python, input: {}, cwd, context: { ...context, learningId: 'learning-B' } })).output, ['run-A', 'flow-A', 'export-node', 'learning-B']);
  assert.deepEqual((await executeOperation({ node: python, input: {}, cwd })).output, [null, null, null, null]);
});

test('invalid controller context fails before any local code executes', async t => {
  const cwd = await workspace(t);
  const node = operation({ code: 'throw new Error("code must not run");' });
  for (const context of [null, [], { runId: '../escape' }, { learningId: false }, { nodeId: 'space id' }]) {
    await assert.rejects(executeOperation({ node, input: {}, cwd, context }), { code: 'CONTEXT_INVALID' });
  }
});


test('missing external tools preserve historical documents but block execution before any operation runs', () => {
  let document = { ...createDocument({ schemaVersion: 2 }), nodes: [
    createNode('input', {}, { id: 'input', config: { outputType: 'object' } }),
    createNode('tool', {}, { id: 'external', title: 'My external operation', config: { executionMode: 'tool', toolName: 'external.removed', inputType: 'object', outputType: 'object' } }),
    createNode('output', {}, { id: 'output' }),
  ] };
  for (const [sourceNode, targetNode] of [['input', 'external'], ['external', 'output']]) {
    document = connectNodes(document, { sourceNode, sourcePort: 'out', targetNode, targetPort: 'in' });
  }
  const frozen = JSON.stringify(document), restored = validateDocument(JSON.parse(frozen));
  assert.equal(JSON.stringify(restored), frozen);
  assert.equal(restored.nodes[1].config.toolName, 'external.removed');
  assert.throws(() => planWorkflow(restored), /所需工具未安装或已移除：external\.removed/);
  assert.equal(JSON.stringify(document), frozen);
});
