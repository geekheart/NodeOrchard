import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AppDiagnostics, APP_DIAGNOSTIC_LIMITS, sanitizeDiagnosticEvidence } from '../src/app-diagnostics.mjs';
import { WorkflowFiles } from '../src/workflows/workflow-files.mjs';
import { WorkflowRuns } from '../src/workflows/workflow-runs.mjs';
import { WorkflowLibrary } from '../src/workflows/workflow-library.mjs';
import { createDocument, createNode } from '../shared/workflow/workflow-model.mjs';

const copy = value => structuredClone(value);
function fixture() {
  const calls = [];
  const document = { id: 'workflow-a', title: '诊断流程', schemaVersion: 2, mode: 'execute', nodes: [
    { id: 'skill', type: 'skill', title: '获取 GitHub 数据', config: { timeoutSeconds: 120, skillRef: 'github', version: 'sha256:' + 'a'.repeat(64) } },
    { id: 'output', type: 'output', title: '交付', config: {} },
  ], edges: [{ id: 'edge', sourceNode: 'skill', sourcePort: 'out', targetNode: 'output', targetPort: 'in' }] };
  const run = { id: 'run-old', workflowId: document.id, document: copy(document), status: 'error',
    startedAt: '2026-10-26T01:00:00.000Z', completedAt: '2026-10-26T01:02:00.000Z', error: '节点超过 120 秒',
    nodes: { skill: { status: 'error', attempt: 1, attemptId: 'attempt-old', sessionId: 'session-a',
      startedAt: '2026-10-26T01:00:00.000Z', completedAt: '2026-10-26T01:02:00.000Z', error: '请求超时',
      partialText: '正在读取 API', logs: { stdout: 'API 请求开始', stderr: '网络超时' }, history: [] },
    output: { status: 'blocked', attempt: 0, attemptId: null, error: '' } } };
  const latest = { ...copy(run), id: 'run-latest', startedAt: '2026-10-26T02:00:00.000Z' };
  const runs = [latest, run], sessions = [{ id: 'session-a', runtimeSessionId: 'runtime-a', status: 'idle', title: '获取数据', provider: 'openai-codex', model: 'test' }];
  const app = { backend: { state: 'ready', provider: 'openai-codex', model: 'test', authenticated: true,
    lastError: '', apiKey: 'do-not-project-backend-key' }, closed: false, requests: new Map(), events: [],
    store: { list: () => copy(sessions), get: id => copy(sessions.find(session => session.id === id)),
      runs: () => [{ id: 'session-run', status: 'error', error: '工具执行失败' }] },
    workflowLibrary: { list: () => [{ id: document.id, title: document.title, revision: 2, lifecycle: 'active', state: 'attention' }],
      get: id => { if (id !== document.id) throw Object.assign(Error('工作流不存在'), { httpStatus: 404 }); return { id, document: copy(document), revision: 2 }; } },
    workflows: { list: id => copy(runs.filter(run => !id || run.workflowId === id)),
      get: id => { const run = runs.find(run => run.id === id); if (!run) throw Object.assign(Error('运行不存在'), { httpStatus: 404 }); return copy(run); } },
    sessionInfo: new Map([['runtime-a', { tools: ['terminal', { name: 'browser', description: '浏览器', api_key: 'hidden' }] }]]),
    adapter: { state: 'ready', log: [], request: async (method, params) => { calls.push([method, params]); return { messages: [] }; } },
    history: () => { throw Error('diagnosis must never resume a session'); },
  };
  return { app, document, run, latest, runs, sessions, calls, diagnostics: new AppDiagnostics(app) };
}

test('global diagnostics work without a selected workflow and do not contact Hermes', async () => {
  const f = fixture(), result = await f.diagnostics.snapshot();
  assert.equal(result.selection.workflowId, null);
  assert.equal(result.selection.runSelection, 'latest');
  assert.equal(result.run.id, 'run-latest');
  assert.equal(result.run.selection, 'latest');
  assert.equal(result.run.scope, 'global');
  assert.equal(result.state.backend.state, 'ready');
  assert.equal(result.workflows.items[0].id, 'workflow-a');
  assert.equal(JSON.stringify(result).includes('do-not-project-backend-key'), false);
  assert.deepEqual(f.calls, []);
});

test('explicit run stays distinct from latest and from the current draft', async () => {
  const f = fixture(), document = copy(f.document); document.nodes[0].config.timeoutSeconds = 300;
  const result = await f.diagnostics.snapshot({ workflowId: document.id, document, runId: 'run-old' });
  assert.equal(result.run.selection, 'explicit'); assert.equal(result.run.id, 'run-old');
  assert.equal(result.latestRun.id, 'run-latest'); assert.equal(result.latestRun.sameAsSelected, false);
  assert.equal(result.workflow.source, 'current-draft');
  assert.equal(result.workflow.document.nodes[0].config.timeoutSeconds, 300);
  assert.equal(result.run.document.nodes[0].config.timeoutSeconds, 120);
  assert.equal(result.run.nodes[0].durationMs, 120000);
  assert.equal(result.run.nodes[0].logs.stderr, '网络超时');
  assert.equal(result.run.nodes[0].partialText, '正在读取 API');
  assert(result.run.timeline.some(event => event.nodeId === 'skill' && event.kind === 'completed' && event.error === '请求超时'));
  await assert.rejects(f.diagnostics.snapshot({ workflowId: document.id, runId: 'missing' }), /运行不存在/);
  await assert.rejects(f.diagnostics.snapshot({ workflowId: 'other-workflow', runId: 'run-old' }), /工作流/);
  assert.equal(f.run.document.nodes[0].config.timeoutSeconds, 120);
});

test('tool dispatch has an explicit allowlist and rejects accessors and unknown arguments', async () => {
  const f = fixture();
  assert.deepEqual(f.diagnostics.tools().map(tool => tool.name), ['app.state', 'workflows.list', 'workflow.inspect', 'workflow.run', 'session.history', 'tools.catalog', 'artifact.inspect']);
  await assert.rejects(f.diagnostics.read('terminal', { command: 'id' }), /诊断工具/);
  await assert.rejects(f.diagnostics.read('app.state', { apiKey: 'secret' }), /未知字段/);
  await assert.rejects(f.diagnostics.read('workflow.run', { runSelection: 'explicit' }), /runId/);
  await assert.rejects(f.diagnostics.read('workflow.run', { runId: 0 }), /runId/);
  await assert.rejects(f.diagnostics.read('workflow.run', { runSelection: 0 }), /runSelection/);
  let accessed = false;
  await assert.rejects(f.diagnostics.read('workflow.run', { get runId() { accessed = true; return 'run-old'; } }), /访问器/);
  assert.equal(accessed, false); assert.deepEqual(f.calls, []);
});

test('session history exposes visible messages and tool evidence without reasoning or secrets', async () => {
  const f = fixture();
  f.app.adapter.request = async (method, params) => { f.calls.push([method, params]); return { messages: [
    { role: 'system', content: 'INTERNAL_SYSTEM' },
    { role: 'user', content: '读取 GitHub' },
    { role: 'assistant', reasoning_content: 'PRIVATE_REASONING', content: [
      { type: 'reasoning', text: 'PRIVATE_BLOCK' }, { type: 'text', text: '准备请求' }],
      tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'terminal', arguments: JSON.stringify({ command: 'curl https://api.github.com', api_key: 'KEY_IN_ARGUMENTS' }) } }] },
    { role: 'tool', tool_call_id: 'call-a', name: 'terminal', content: JSON.stringify({ error: 'API timeout', access_token: 'TOKEN_IN_OUTPUT', reasoning_content: 'PRIVATE_JSON_REASONING' }) },
    { role: 'assistant', content: '<think>PRIVATE_TAGGED</think>连接超时，token=TOKEN_IN_TEXT', analysis: 'PRIVATE_ANALYSIS' },
  ], info: { token: 'PRIVATE_INFO' } }; };
  const result = await f.diagnostics.read('session.history', { sessionId: 'session-a' });
  assert.equal(result.available, true); assert.equal(result.messages.length, 4);
  assert.equal(result.messages[1].toolCalls[0].name, 'terminal');
  const encoded = JSON.stringify(result);
  for (const value of ['PRIVATE_REASONING', 'PRIVATE_BLOCK', 'PRIVATE_TAGGED', 'PRIVATE_ANALYSIS', 'PRIVATE_JSON_REASONING', 'PRIVATE_INFO', 'INTERNAL_SYSTEM', 'KEY_IN_ARGUMENTS', 'TOKEN_IN_OUTPUT', 'TOKEN_IN_TEXT']) assert.equal(encoded.includes(value), false, value);
  assert(encoded.includes('API timeout')); assert(encoded.includes('curl https://api.github.com'));
  assert.deepEqual(f.calls, [['session.history', { session_id: 'runtime-a' }]]);
});

test('disconnected session history preserves local evidence without activating or resuming Hermes', async () => {
  const f = fixture(); f.sessions[0].runtimeSessionId = null;
  const result = await f.diagnostics.read('session.history', { sessionId: 'session-a' });
  assert.equal(result.available, false); assert.match(result.reason, /恢复|连接/);
  assert.equal(result.runs[0].error, '工具执行失败'); assert.deepEqual(f.calls, []);
});

test('old sessions use the dedicated read-only persistent-history RPC without restoring an agent', async () => {
  const f = fixture(); f.sessions[0].runtimeSessionId = null; f.sessions[0].storedSessionId = 'stored-a';
  f.app.adapter.request = async (method, args) => { f.calls.push([method, args]); return { storedSessionId: 'stored-a',
    messages: [{ role: 'tool', text: 'PERSISTED_TOOL_FAILURE', context: { error: 'timeout', apiKey: 'PERSISTED_SECRET', reasoning: 'PERSISTED_REASONING' } }],
    policy: { readOnly: true, agentCreated: false, sessionResumed: false, memoryRead: false, reasoningIncluded: false } }; };
  const result = await f.diagnostics.read('session.history', { sessionId: 'session-a' });
  assert.equal(result.available, true); assert.equal(result.source, 'readonly-stored-session');
  assert.equal(result.messages[0].text, 'PERSISTED_TOOL_FAILURE');
  assert.deepEqual(f.calls, [['workbench.assistant.history', { stored_session_id: 'stored-a' }]]);
  assert.equal(JSON.stringify(result).includes('PERSISTED_SECRET'), false); assert.equal(JSON.stringify(result).includes('PERSISTED_REASONING'), false);
  f.app.adapter.request = async () => ({ storedSessionId: 'stored-a', messages: [{ role: 'assistant', text: 'UNCONFIRMED_HISTORY' }], policy: { readOnly: true } });
  const rejected = await f.diagnostics.read('session.history', { sessionId: 'session-a' });
  assert.equal(rejected.available, false); assert.equal(JSON.stringify(rejected).includes('UNCONFIRMED_HISTORY'), false);
});

test('Hermes UI history retains text, tool context and args under the same redaction policy', async () => {
  const f = fixture();
  f.app.adapter.request = async () => ({ messages: [
    { role: 'user', text: '为什么失败' },
    { role: 'tool', name: 'terminal', text: 'Exit code 1', args: { command: 'curl github.com', token: 'UI_ARGUMENT_SECRET' },
      context: { stdout: '', stderr: 'Failed to connect', reasoning: 'UI_PRIVATE_REASONING', apiKey: 'UI_CONTEXT_SECRET' } },
    { role: 'assistant', text: '请求失败', context: 'ASSISTANT_PRIVATE_CONTEXT', reasoning: 'PRIVATE' },
  ] });
  const result = await f.diagnostics.read('session.history', { sessionId: 'session-a' });
  assert.equal(result.messages[0].text, '为什么失败');
  assert.equal(result.messages[1].context.stderr, 'Failed to connect');
  assert.equal(result.messages[1].args.command, 'curl github.com');
  const encoded = JSON.stringify(result);
  for (const value of ['UI_ARGUMENT_SECRET', 'UI_PRIVATE_REASONING', 'UI_CONTEXT_SECRET', 'ASSISTANT_PRIVATE_CONTEXT', 'PRIVATE']) assert.equal(encoded.includes(value), false, value);
});

test('learning runs and evaluation answers are excluded from diagnostic evidence', async () => {
  const f = fixture();
  f.document.nodes.push({ id: 'evaluation', type: 'evaluation', config: { comparison: 'exact', valuePath: 'score', value: 'TRAINING_ANSWER', path: 'TRAINING_FILE', fields: ['TRAINING_FIELDS'] } });
  const draft = await f.diagnostics.read('workflow.inspect', {}, { document: f.document });
  assert.deepEqual(draft.document.nodes[2].config, { comparison: 'exact', valuePath: 'score' });
  f.runs[0].learningId = 'learning-batch'; f.runs[0].nodes.skill.partialText = 'TRAINING_SAMPLE_OUTPUT';
  f.runs[0].error = 'TRAINING_ERROR_SAMPLE';
  const run = await f.diagnostics.read('workflow.run');
  assert.equal(run.restricted, true); assert.equal(JSON.stringify(run).includes('TRAINING_SAMPLE_OUTPUT'), false);
  const snapshot = await f.diagnostics.snapshot();
  assert.equal(JSON.stringify(snapshot).includes('TRAINING_ERROR_SAMPLE'), false);
});

test('artifact inspection checks run/node ownership and verifies registered text without arbitrary file access', async t => {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), 'app-diagnostics-'));
  const db = new DatabaseSync(':memory:');
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  f.app.config = { workspaceRoot: directory, appRoot: directory }; f.app.store.db = db;
  f.app.workflowFiles = new WorkflowFiles(f.app, { allowedRoots: [directory] });
  const run = f.runs[0]; run.id = randomUUID();
  const root = join(directory, 'artifacts'); await mkdir(root);
  db.prepare('INSERT INTO workflow_file_runs(id,value) VALUES(?,?)').run(run.id, JSON.stringify({ runId: run.id, outputDirectory: root }));
  const path = join(root, 'result.json'); await writeFile(path, JSON.stringify({ error: 'API failed', token: 'ARTIFACT_SECRET', reasoning: 'ARTIFACT_REASONING' }));
  const artifact = await f.app.workflowFiles.registerArtifact({ runId: run.id, nodeId: 'skill', attempt: 1, path });
  run.nodes.skill.artifacts = [artifact];
  const args = { runId: run.id, nodeId: 'skill', artifactId: artifact.id };
  const result = await f.diagnostics.read('artifact.inspect', args);
  assert.equal(result.verified, true); assert.equal(result.metadata.sha256, artifact.sha256);
  assert.equal(result.content.error, 'API failed');
  assert.equal(JSON.stringify(result).includes('ARTIFACT_SECRET'), false); assert.equal(JSON.stringify(result).includes('ARTIFACT_REASONING'), false);
  await assert.rejects(f.diagnostics.read('artifact.inspect', { ...args, path }), /未知字段/);
  await assert.rejects(f.diagnostics.read('artifact.inspect', { ...args, nodeId: 'output' }), /产物/);
  run.learningId = 'learning';
  await assert.rejects(f.diagnostics.read('artifact.inspect', args), /学习|训练/);
  delete run.learningId;
  await writeFile(path, 'changed');
  await assert.rejects(f.diagnostics.read('artifact.inspect', args), /变化/);
});

test('tool catalog projects static workflow capabilities and cached Hermes names only', async () => {
  const f = fixture(), result = await f.diagnostics.read('tools.catalog');
  assert(result.workflowTools.some(tool => tool.id === 'text.trim'));
  assert(result.hermesTools.some(tool => tool.name === 'browser'));
  assert.equal(JSON.stringify(result).includes('api_key'), false); assert.deepEqual(f.calls, []);
});

test('diagnostic payloads are bounded, redact nested config, and preserve the end of logs', async () => {
  const f = fixture();
  f.runs[0].nodes.skill.logs.stderr = 'x'.repeat(200000) + '\napi_key=DO_NOT_LEAK\nlast diagnostic line';
  f.runs[0].nodes.skill.partialText = '中'.repeat(200000);
  f.runs[0].document.nodes[0].config.credentials = { secret: 'CONFIG_SECRET' };
  const result = await f.diagnostics.read('workflow.run', { workflowId: 'workflow-a', runSelection: 'latest' });
  const encoded = JSON.stringify(result);
  assert(Buffer.byteLength(encoded) <= APP_DIAGNOSTIC_LIMITS.payloadBytes);
  assert.equal(result.diagnosticLimits.truncated, true);
  assert.equal(encoded.includes('DO_NOT_LEAK'), false); assert.equal(encoded.includes('CONFIG_SECRET'), false);
  assert(result.nodes[0].logs.stderr.endsWith('last diagnostic line'));
  assert.equal(f.runs[0].document.nodes[0].config.credentials.secret, 'CONFIG_SECRET');
  const secretHeavy = sanitizeDiagnosticEvidence({ values: Array.from({ length: 2000 }, () => ({ apiKey: '密钥'.repeat(1000), token: 'token'.repeat(1000) })) });
  assert(Buffer.byteLength(JSON.stringify(secretHeavy)) <= APP_DIAGNOSTIC_LIMITS.payloadBytes);
});

test('real workflow managers expose evidence without updating their isolated SQLite records', async t => {
  const db = new DatabaseSync(':memory:'), app = new EventEmitter();
  Object.assign(app, { store: { db, list: () => [] }, config: {}, backend: { state: 'stopped' }, adapter: { state: 'stopped', log: [] },
    publish() { throw Error('diagnostic reads must not publish mutations'); }, requests: new Map(), sessionInfo: new Map() });
  app.workflows = new WorkflowRuns(app); app.workflowLibrary = new WorkflowLibrary(app);
  t.after(async () => { await app.workflows.close(); db.close(); });
  const document = createDocument({ schemaVersion: 2, title: '隔离诊断' });
  document.nodes = [createNode('tool', {}, { id: 'tool', config: { executionMode: 'tool', toolName: 'text.trim' } })];
  // Constructing an isolated persisted fixture is not a business execution.
  db.prepare('INSERT INTO workflow_documents(id,revision,created_at,updated_at,document,origin) VALUES(?,1,?,?,?,?)')
    .run(document.id, '2026-10-26T01:00:00Z', '2026-10-26T01:00:00Z', JSON.stringify(document), 'saved');
  const run = { id: 'persisted-run', schemaVersion: 2, workflowId: document.id, document, status: 'error', startedAt: '2026-10-26T01:00:00Z',
    nodes: { tool: { status: 'error', attempt: 1, attemptId: 'persisted-attempt', error: '实际持久错误', logs: { stdout: '', stderr: 'stderr evidence' } } } };
  app.workflows.write.run(run.id, JSON.stringify(run));
  const changes = db.prepare('SELECT total_changes() AS count').get().count;
  const result = await new AppDiagnostics(app).snapshot({ workflowId: document.id, runId: run.id });
  assert.equal(result.run.nodes[0].error, '实际持久错误'); assert.equal(result.workflow.savedRevision, 1);
  assert.equal(db.prepare('SELECT total_changes() AS count').get().count, changes);
  assert.equal(app.workflows.get(run.id).nodes.tool.logs.stderr, 'stderr evidence');
});

test('an old persisted learning session cannot bypass the run restriction through history', async t => {
  const f = fixture(), db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE workflow_runs(id TEXT PRIMARY KEY,value TEXT NOT NULL)'); f.app.store.db = db;
  const old = { id: 'old-learning-run', learningId: 'old-learning', nodes: { skill: { sessionId: 'session-a' } } };
  db.prepare('INSERT INTO workflow_runs(id,value) VALUES(?,?)').run(old.id, JSON.stringify(old));
  const result = await f.diagnostics.read('session.history', { sessionId: 'session-a' });
  assert.equal(result.restricted, true); assert.deepEqual(f.calls, []);
});

test('application control sessions cannot disclose internal prompts through diagnostic history', async () => {
  const f = fixture(); f.app.assistantModel = { ownsSession: sessionId => sessionId === 'session-a' };
  f.sessions[0].runtimeSessionId = null; f.sessions[0].storedSessionId = 'stored-control';
  const result = await f.diagnostics.read('session.history', { sessionId: 'session-a' });
  assert.equal(result.restricted, true); assert.deepEqual(f.calls, []);
});
