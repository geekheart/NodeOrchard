import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application } from '../src/application.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';
import { layoutPositions } from '../shared/workflow/workflow-studio-utils.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'ready'; this.serverRequests = new Map(); this.calls = []; }
  async request(method, params) {
    this.calls.push([method, params]);
    if (method === 'session.history') return { messages: [{ role: 'tool', name: 'terminal', text: '请求失败',
      context: { stderr: 'ACTUAL_GITHUB_CONNECTION_TIMEOUT', api_key: 'FIXTURE_PRIVATE_KEY', reasoning: 'PRIVATE_REASONING' }, args: { command: 'curl https://api.github.com' } }] };
    if (method === 'workbench.assistant.history') return { storedSessionId: params.stored_session_id, messages: [
      { role: 'tool', name: 'terminal', text: 'PERSISTED_GITHUB_CONNECTION_TIMEOUT', context: { stderr: 'old stderr', token: 'OLD_SECRET' } }],
      truncated: false, policy: { readOnly: true, agentCreated: false, sessionResumed: false, memoryRead: false, reasoningIncluded: false } };
    throw Error('Unexpected Hermes or business execution: ' + method);
  }
  async stop() {}
}

async function until(read) {
  for (let index = 0; index < 100; index++) { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('expected asynchronous conversation state');
}

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'application-assistant-http-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }),
    port: 0, workflowRunRoot: join(directory, 'runs') };
  const f = { directory, config, prompts: [], classifications: [], classificationIntent: 'diagnose' };
  f.open = async () => {
    f.adapter = new Offline(); f.app = new Application(config, f.adapter);
    f.app.backend.state = 'ready';
    f.app.captureModelRoute = async () => ({ provider: 'fixture-provider', model: 'fixture-model' });
    // These cases exercise the HTTP broker after a controlled classification;
    // the separate intent-routing suite exercises the classifier model seam.
    f.app.applicationAssistant.intentClassifier.classify = async options => {
      const at = new Date().toISOString(); f.classifications.push({ role: options.role, intent: f.classificationIntent });
      options.onProgress?.({ stage: 'classify-intent', label: '识别对话任务', modelCall: true });
      return { intent: f.classificationIntent, modelRoute: await f.app.captureModelRoute(), modelCalls: 1, startedAt: at, completedAt: at, durationMs: 0 };
    };
    f.app.assistantModel.generate = async (prompt, options) => { f.prompts.push({ prompt, options }); return JSON.stringify(await f.respond(prompt, options)); };
    f.bridge = createWorkbenchServer(config, f.app); f.origin = await f.bridge.listen();
    f.token = (await (await fetch(f.origin + '/api/bootstrap')).json()).csrfToken;
  };
  f.request = async (path, body, headers = {}) => {
    const response = await fetch(f.origin + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Workbench-Token': f.token }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  f.finished = path => until(async () => { const result = await f.request(path); const turn = result.body.conversation.turns.at(-1); return turn && turn.status !== 'thinking' && turn; });
  t.after(async () => { if (!f.app.closed) await f.bridge.close(); await rm(directory, { recursive: true, force: true }); });
  f.respond = () => ({ text: '已读取状态。' });
  await f.open();
  return f;
}

function populate(f) {
  let document = createDocument({ schemaVersion: 2, title: 'GitHub 数据测试' });
  document.nodes = [createNode('skill', {}, { id: 'github', config: { skillRef: 'github-test', version: 'sha256:' + 'a'.repeat(64), timeoutSeconds: 120 } }),
    createNode('output', {}, { id: 'output' }), createNode('evaluation', {}, { id: 'evaluation', config: { comparison: 'exact', value: 'TRAINING_ANSWER' } })];
  document = connectNodes(document, { sourceNode: 'github', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
  f.app.workflowLibrary.save({ document, expectedRevision: 0 });
  const session = f.app.store.create({ title: 'GitHub 工具会话', cwd: f.directory, storedSessionId: 'stored-fixture', runtimeSessionId: 'runtime-fixture', provider: 'fixture-provider', model: 'fixture-model' });
  const run = { schemaVersion: 2, id: 'run-old', workflowId: document.id, document: structuredClone(document), status: 'error',
    startedAt: '2026-10-26T01:00:00Z', completedAt: '2026-10-26T01:02:00Z', error: 'FIXTURE_OLD_TIMEOUT',
    nodes: { github: { status: 'error', attempt: 1, attemptId: 'attempt-old', sessionId: session.id,
      startedAt: '2026-10-26T01:00:00Z', completedAt: '2026-10-26T01:02:00Z', error: 'FIXTURE_NODE_TIMEOUT',
      partialText: 'FIXTURE_PARTIAL_NOT_SUCCESS', logs: { stdout: '', stderr: 'FIXTURE_STDERR_NETWORK' } },
    output: { status: 'blocked', attempt: 0, attemptId: null }, evaluation: { status: 'skipped', attempt: 0 } } };
  const latest = { ...structuredClone(run), id: 'run-latest', startedAt: '2026-10-26T02:00:00Z', error: 'FIXTURE_NEW_TIMEOUT' };
  f.app.workflows.write.run(run.id, JSON.stringify(run)); f.app.workflows.write.run(latest.id, JSON.stringify(latest));
  return { document, run, latest, session };
}

function businessState(app) {
  const db = app.store.db;
  const tables = ['workflow_documents', 'workflow_runs', 'workflow_artifacts', 'workflow_file_runs', 'workflow_feedback', 'workflow_learning', 'sessions', 'runs'];
  return tables.filter(table => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]);
}

test('real Application HTTP global chat brokers tool evidence before its final answer without changing business records', async t => {
  const f = await setup(t), { session } = populate(f), before = businessState(f.app);
  let step = 0;
  f.respond = (prompt, options) => {
    assert.equal(options.modelRoute.provider, 'fixture-provider');
    assert.equal(prompt.includes('TRAINING_ANSWER'), false);
    if (step++ === 0) return { tool: 'workflows.list', arguments: {} };
    if (step === 2) return { tool: 'session.history', arguments: { sessionId: session.id } };
    assert(prompt.includes('ACTUAL_GITHUB_CONNECTION_TIMEOUT'));
    assert.equal(prompt.includes('FIXTURE_PRIVATE_KEY'), false); assert.equal(prompt.includes('PRIVATE_REASONING'), false);
    return { text: '现有工具记录显示 GitHub 连接超时，尚未执行重试。' };
  };
  const request = { clientMessageId: 'global-request', text: '帮我检查应用为什么失败', page: { route: '#/board' } };
  const posted = await f.request('/api/app-assistant/messages', request); assert.equal(posted.status, 202);
  const turn = await f.finished('/api/app-assistant'); assert.equal(turn.status, 'complete'); assert.match(turn.assistant.text, /连接超时/);
  assert.equal(turn.assistant.progress.modelCalls, f.prompts.length + 1);
  assert.deepEqual(turn.assistant.evidence.map(item => item.tool), ['workflows.list', 'session.history']);
  assert.deepEqual(f.adapter.calls.map(([method]) => method), ['session.history']);
  assert.deepEqual(businessState(f.app), before);
  const count = f.prompts.length, classifications = f.classifications.length, duplicate = await f.request('/api/app-assistant/messages', request);
  assert.equal(duplicate.body.turn.id, turn.id); assert.equal(f.prompts.length, count);
  assert.equal(f.classifications.length, classifications);
  assert.equal((await f.request('/api/app-assistant/messages', { ...request, text: 'changed' })).status, 409);
  assert.equal((await f.request('/api/app-assistant/messages', { ...request, clientMessageId: 'bad-origin' }, { Origin: 'http://other.invalid' })).status, 403);
});

test('internal application model sessions and protocol frames stay out of user-facing bootstrap and SSE', async t => {
  const f = await setup(t);
  const session = f.app.store.create({ title: 'INTERNAL_CONTROL_SESSION', cwd: f.directory, storedSessionId: 'stored-control', runtimeSessionId: 'runtime-control' });
  f.app.store.db.prepare('INSERT INTO application_model_sessions(id) VALUES(?)').run(session.id);
  f.app.publish('message.complete', session.id, { text: 'PRIVATE_BROKER_PROTOCOL' });
  f.app.publish('diagnostic.public-test', null, { text: 'PUBLIC_SENTINEL' });
  assert.equal((await f.request('/api/bootstrap')).body.sessions.some(row => row.id === session.id), false);
  const controller = new AbortController(), response = await fetch(f.origin + '/api/events?after=0', { signal: controller.signal });
  const reader = response.body.getReader(); let text = '';
  try { while (!text.includes('PUBLIC_SENTINEL')) { const item = await reader.read(); if (item.done) break; text += new TextDecoder().decode(item.value); } }
  finally { controller.abort(); await reader.cancel().catch(() => {}); }
  assert.match(text, /PUBLIC_SENTINEL/); assert.equal(text.includes('PRIVATE_BROKER_PROTOCOL'), false);
});

test('workflow chat preserves explicit old-run/node selection and separates the unsaved current draft', async t => {
  const f = await setup(t), { document, run, session } = populate(f), before = businessState(f.app);
  const draft = structuredClone(document); draft.nodes[0].config.timeoutSeconds = 300;
  let step = 0;
  f.respond = prompt => {
    assert.equal(prompt.includes('TRAINING_ANSWER'), false);
    const source = JSON.parse(prompt.split('SOURCE_JSON=')[1].split('\nTOOL_RESULTS_JSON=')[0]);
    assert.equal(source.evidence.run.id, 'run-old'); assert.equal(source.evidence.run.selection, 'explicit');
    assert.equal(source.evidence.latestRun.id, 'run-latest');
    assert.equal(source.evidence.workflow.document.nodes[0].config.timeoutSeconds, 300);
    assert.equal(source.evidence.run.document.nodes[0].config.timeoutSeconds, 120);
    if (step++ === 0) return { tool: 'workflow.run', arguments: { runId: run.id, nodeId: 'github' } };
    if (step === 2) return { tool: 'session.history', arguments: { sessionId: session.id } };
    assert(prompt.includes('ACTUAL_GITHUB_CONNECTION_TIMEOUT'));
    return { text: '所选旧运行使用120秒，当前草稿已是300秒；尚未验证新草稿。' };
  };
  const path = '/api/workflow-conversations/' + document.id;
  const response = await f.request(path + '/messages', { clientMessageId: 'workflow-request', text: '为什么这条运行超时', intent: 'discuss', document: draft,
    context: { runId: run.id, nodeId: 'github', attempt: 1, attemptId: 'attempt-old' }, page: { route: '#/workflows/' + document.id } });
  assert.equal(response.status, 202);
  const turn = await f.finished(path); assert.equal(turn.status, 'complete'); assert.match(turn.assistant.text, /120秒/);
  assert.deepEqual(turn.assistant.evidence.map(item => item.tool), ['workflow.run', 'session.history']);
  assert.deepEqual(businessState(f.app), before);
});

test('global HTTP honors explicit run context and redacts credentials pasted into a question', async t => {
  const f = await setup(t), { document } = populate(f);
  f.respond = prompt => {
    const source = JSON.parse(prompt.split('SOURCE_JSON=')[1].split('\nTOOL_RESULTS_JSON=')[0]);
    assert.equal(source.evidence.run.id, 'run-old'); assert.equal(source.evidence.run.selection, 'explicit');
    assert.equal(source.evidence.run.nodes.length, 1); assert.equal(source.evidence.run.nodes[0].id, 'github');
    assert.equal(prompt.includes('QUESTION_PRIVATE_TOKEN'), false);
    return { text: '已检查明确选择的旧运行。token=REPLY_PRIVATE_TOKEN' };
  };
  await f.request('/api/app-assistant/messages', { clientMessageId: 'global-explicit', text: '检查这个旧运行 token=QUESTION_PRIVATE_TOKEN',
    context: { workflowId: document.id, runId: 'run-old', nodeId: 'github' } });
  const turn = await f.finished('/api/app-assistant');
  assert.equal(turn.status, 'complete'); assert.equal(turn.assistant.text.includes('REPLY_PRIVATE_TOKEN'), false);
});

test('global diagnosis reads pre-restart Hermes history without resuming or replaying the business session', async t => {
  const f = await setup(t), { session } = populate(f);
  f.app.store.update(session.id, { runtimeSessionId: null, status: 'disconnected' });
  const before = businessState(f.app); let step = 0;
  f.respond = prompt => {
    if (step++ === 0) return { tool: 'session.history', arguments: { sessionId: session.id } };
    assert(prompt.includes('PERSISTED_GITHUB_CONNECTION_TIMEOUT')); assert.equal(prompt.includes('OLD_SECRET'), false);
    return { text: '已直接核对上次工具失败记录，没有恢复或重跑原会话。' };
  };
  await f.request('/api/app-assistant/messages', { clientMessageId: 'old-history', text: '检查上次为什么失败' });
  const turn = await f.finished('/api/app-assistant'); assert.equal(turn.status, 'complete');
  assert.deepEqual(f.adapter.calls.map(([method]) => method), ['workbench.assistant.history']);
  assert.deepEqual(businessState(f.app), before);
});

test('a global workflow repair is a validated proposal until explicitly applied and repeated apply is idempotent', async t => {
  const f = await setup(t), { document, run } = populate(f), original = f.app.workflowLibrary.get(document.id);
  f.classificationIntent = 'workflow';
  let step = 0;
  f.respond = prompt => {
    assert.equal(prompt.includes('TRAINING_ANSWER'), false);
    if (step++ === 0) return { tool: 'workflow.propose', arguments: { workflowId: document.id, request: '将GitHub节点超时设为300秒' } };
    return { text: '把该节点超时调整为300秒，等待应用后再运行。', operations: [{ op: 'update-node', nodeId: 'github', config: { timeoutSeconds: 300 } }] };
  };
  await f.request('/api/app-assistant/messages', { clientMessageId: 'repair-proposal', text: '将GitHub节点超时改为300秒' });
  const turn = await f.finished('/api/app-assistant'); assert.equal(turn.status, 'proposed');
  assert.deepEqual(f.app.workflowLibrary.get(document.id), original);
  const path = `/api/app-assistant/turns/${turn.id}/action`;
  const applied = await f.request(path, { action: 'mark-applied' }); assert.equal(applied.status, 200);
  assert.equal(applied.body.turn.status, 'applied');
  assert.equal(f.app.workflowLibrary.get(document.id).document.nodes[0].config.timeoutSeconds, 300);
  assert.deepEqual(f.app.workflowLibrary.get(document.id).document.nodes.map(({ id, x, y }) => ({ id, x, y })), document.nodes.map(({ id, x, y }) => ({ id, x, y })), 'A property-only supervisor edit preserves the existing layout');
  const revision = f.app.workflowLibrary.get(document.id).revision;
  await f.request(path, { action: 'mark-applied' }); assert.equal(f.app.workflowLibrary.get(document.id).revision, revision);
  assert.deepEqual(f.app.workflows.get(run.id), run);
});

test('supervisor application lays out newly generated nodes once without running the workflow', async t => {
  const f = await setup(t); let document = createDocument({ schemaVersion: 2, title: '总控新增节点布局' });
  document.nodes = [createNode('input', { x: 1700, y: 1300 }, { id: 'input' }), createNode('output', { x: 1900, y: 1300 }, { id: 'output' })];
  document = connectNodes(document, { sourceNode: 'input', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
  const original = f.app.workflowLibrary.save({ document, expectedRevision: 0 }); f.classificationIntent = 'workflow'; f.app.skills = async () => ({ connected: true, skills: [] });
  let step = 0; f.respond = () => step++ === 0 ? { tool: 'workflow.propose', arguments: { workflowId: document.id, request: '添加一个校验节点' } }
    : { text: '添加校验节点。', operations: [{ op: 'add-node', ref: 'check', type: 'validation', x: 5000, y: 4000 }] };
  await f.request('/api/app-assistant/messages', { clientMessageId: 'generated-node-layout', text: '添加一个校验节点' });
  const turn = await f.finished('/api/app-assistant'); assert.equal(turn.status, 'proposed'); assert.deepEqual(f.app.workflowLibrary.get(document.id), original);
  const path = `/api/app-assistant/turns/${turn.id}/action`, applied = await f.request(path, { action: 'mark-applied' }); assert.equal(applied.status, 200);
  const saved = f.app.workflowLibrary.get(document.id), positions = layoutPositions(saved.document);
  assert.equal(saved.document.nodes.length, 3); for (const node of saved.document.nodes) assert.deepEqual({ x: node.x, y: node.y }, positions.get(node.id));
  assert.deepEqual(saved.document.edges, document.edges); assert.equal(saved.revision, original.revision + 1);
  await f.request(path, { action: 'mark-applied' }); assert.deepEqual(f.app.workflowLibrary.get(document.id), saved);
  assert.deepEqual(f.app.workflows.list(), []); assert.deepEqual(f.adapter.calls, []);
});

test('HTTP stop prevents a late model tool request and duplicate delivery cannot replay it', async t => {
  const f = await setup(t); let release;
  f.respond = () => new Promise(resolve => { release = resolve; });
  const body = { clientMessageId: 'stop-request', text: '检查应用' };
  const first = await f.request('/api/app-assistant/messages', body);
  await until(() => release);
  const stopped = await f.request(`/api/app-assistant/turns/${first.body.turn.id}/action`, { action: 'interrupt-turn' });
  assert.equal(stopped.status, 200);
  release({ tool: 'environment.probe', arguments: { target: 'github' } });
  const turn = await f.finished('/api/app-assistant'); assert.equal(turn.status, 'interrupted');
  assert.equal(f.prompts.length, 1); assert.deepEqual(f.adapter.calls, []);
  await f.request('/api/app-assistant/messages', body); assert.equal(f.prompts.length, 1);
});

test('a service restart interrupts pending global analysis and never replays the original message', async t => {
  const f = await setup(t); let release;
  f.respond = () => new Promise(resolve => { release = resolve; });
  const body = { clientMessageId: 'restart-request', text: '检查应用' };
  const first = await f.request('/api/app-assistant/messages', body); await until(() => release);
  await f.bridge.close();
  f.respond = () => { assert.fail('restart must not replay the model request'); };
  await f.open();
  const history = await f.request('/api/app-assistant');
  assert.equal(history.body.conversation.turns[0].status, 'interrupted');
  const duplicate = await f.request('/api/app-assistant/messages', body);
  assert.equal(duplicate.body.turn.id, first.body.turn.id); assert.equal(f.prompts.length, 1);
  release({ text: 'late result' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.request('/api/app-assistant')).body.conversation.turns[0].status, 'interrupted');
});

test('global HTTP retains diagnostic progress on failure and restart, and resumes with fresh server evidence', async t => {
  const f = await setup(t), { document, run } = populate(f), before = businessState(f.app); let step = 0;
  const context = { workflowId: document.id, runId: run.id, nodeId: 'github' };
  f.respond = (_prompt, options) => {
    options.onProgress?.({ stage: 'model-response', label: '等待模型响应' });
    if (step++ === 0) return { tool: 'workflow.run', arguments: { runId: run.id, nodeId: 'github' } };
    throw Object.assign(new Error('fixture model timeout'), { code: 'MODEL_TIMEOUT' });
  };
  await f.request('/api/app-assistant/messages', { clientMessageId: 'checkpoint-failure', text: '检查失败原因', context });
  const failed = await f.finished('/api/app-assistant');
  assert.equal(failed.status, 'error'); assert.equal(failed.assistant.evidence[0].tool, 'workflow.run');
  assert.equal(failed.assistant.checkpoint.steps.at(-1).status, 'error');
  assert.equal(failed.assistant.progress.stage, 'model-response');
  assert.deepEqual(businessState(f.app), before);
  await f.bridge.close(); await f.open();
  const saved = (await f.request('/api/app-assistant')).body.conversation.turns.at(-1);
  assert.deepEqual(saved.assistant.checkpoint, failed.assistant.checkpoint);
  f.respond = prompt => {
    assert.match(prompt, /FIXTURE_STDERR_NETWORK/);
    return { text: '沿用尚未过期的诊断记录，未重跑业务。' };
  };
  await f.request('/api/app-assistant/messages', { clientMessageId: 'checkpoint-continuation', text: '继续检查失败原因', context });
  const resumed = await f.finished('/api/app-assistant'); assert.equal(resumed.status, 'complete');
  assert.deepEqual(f.adapter.calls, [], 'continuation must not resume a model session');
  // Restart intentionally disconnects transport sessions; workflow records and
  // attempts themselves must remain byte-for-byte identical.
  assert.deepEqual(businessState(f.app).filter(([name]) => name !== 'sessions'), before.filter(([name]) => name !== 'sessions'));
});
