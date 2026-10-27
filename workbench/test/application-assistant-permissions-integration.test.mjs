import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode } from '../shared/workflow/workflow-model.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(method) { this.calls.push(method); throw new Error('Unexpected Hermes/model/business call: ' + method); }
  async stop() {}
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-permission-broker-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }),
    workflowRunRoot: join(directory, 'runs') };
  const adapter = new Offline(), app = new Application(config, adapter), prompts = [], reads = [];
  app.captureModelRoute = async () => ({ provider: 'fixture', model: 'fixture-model' });
  const originalRead = app.diagnostics.read.bind(app.diagnostics);
  app.diagnostics.read = async (...args) => { reads.push(args.slice(0, 2)); return originalRead(...args); };
  const documents = ['OWN_WORKFLOW_ONLY', 'FOREIGN_WORKFLOW_PRIVATE'].map(title => {
    const document = createDocument({ schemaVersion: 2, title });
    document.nodes = [createNode('input', {}, { id: 'input', config: { outputType: 'text', defaultValue: title + '_INPUT' } })];
    app.workflowLibrary.save({ document, expectedRevision: 0 }); return document;
  });
  const sessions = documents.map((document, index) => app.store.create({ title: index ? 'FOREIGN_SESSION_PRIVATE' : 'OWN_SESSION_ONLY',
    cwd: config.workspaceRoot, storedSessionId: 'stored-' + index, runtimeSessionId: null, provider: 'fixture', model: 'fixture-model' }));
  const runs = documents.map((document, index) => ({ schemaVersion: 2, id: index ? 'foreign-run-private' : 'own-run-only', workflowId: document.id, document,
    status: 'error', startedAt: '2026-10-27T00:00:00Z', completedAt: '2026-10-27T00:00:01Z',
    error: index ? 'FOREIGN_RUN_PRIVATE' : 'OWN_RUN_ONLY', sessionId: sessions[index].id,
    nodes: { input: { status: 'error', attempt: 1, error: index ? 'FOREIGN_NODE_PRIVATE' : 'OWN_NODE_ONLY', sessionId: sessions[index].id } } }));
  for (const run of runs) app.workflows.write.run(run.id, JSON.stringify(run));
  app.adapter.log = ['GLOBAL_SOFTWARE_LOG_PRIVATE'];
  const f = { app, adapter, config, documents, sessions, runs, prompts, reads };
  f.responses = [];
  app.assistantModel.generate = async (prompt, options) => {
    prompts.push(prompt); assert.equal(options.modelRoute.provider, 'fixture');
    assert(f.responses.length, 'fixture response queue exhausted');
    return JSON.stringify(f.responses.shift());
  };
  f.plan = (options = {}) => app.applicationAssistant.plan({ role: 'workflow', text: '只读分析当前工作流', document: documents[0],
    context: { workflowId: documents[0].id, runId: runs[0].id }, page: { route: '#/workflows/' + documents[0].id }, ...options });
  t.after(async () => { await app.close(); assert.deepEqual(adapter.calls, []); await rm(directory, { recursive: true, force: true }); });
  return f;
}

function settings(app, change) {
  const current = app.assistantPermissionSettings.get(), request = { expectedRevision: current.revision,
    workflow: structuredClone(current.workflow), supervisor: structuredClone(current.supervisor) };
  change(request); return app.assistantPermissionSettings.save(request);
}
function business(app) {
  return ['workflow_documents', 'workflow_runs', 'workflow_lifecycle', 'sessions', 'runs'].map(name => [name,
    app.store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);
}
const sourceOf = prompt => JSON.parse(prompt.split('\nSOURCE_JSON=')[1].split('\nTOOL_RESULTS_JSON=')[0]);

test('a real workflow broker prompt contains only its workflow evidence, never foreign sessions or global software logs', async t => {
  const f = await fixture(t), before = business(f.app);
  f.responses = [{ tool: 'app.state', arguments: {} }, { text: '已检查当前流程。' }];
  const result = await f.plan();
  assert.equal(result.text, '已检查当前流程。'); assert.equal(f.reads.length, 1);
  for (const prompt of f.prompts) {
    assert(prompt.includes('OWN_WORKFLOW_ONLY')); assert(prompt.includes('OWN_RUN_ONLY'));
    for (const privateValue of [f.documents[1].id, f.sessions[1].id, f.runs[1].id, 'FOREIGN_WORKFLOW_PRIVATE', 'FOREIGN_SESSION_PRIVATE',
      'FOREIGN_RUN_PRIVATE', 'FOREIGN_NODE_PRIVATE', 'GLOBAL_SOFTWARE_LOG_PRIVATE']) assert.equal(prompt.includes(privateValue), false, privateValue);
    const source = sourceOf(prompt); assert.equal(source.permissionScope.role, 'workflow');
    assert.equal(source.permissionScope.workingFolder, await realpath(f.config.workspaceRoot));
    assert.equal(source.selection.workflowId, f.documents[0].id);
  }
  assert.deepEqual(business(f.app), before);
});

test('model workflow/run/session escalation and injected supervisor roles are rejected before any diagnostic read or write', async t => {
  const f = await fixture(t), before = business(f.app);
  const invalid = [
    { tool: 'workflow.run', arguments: { workflowId: f.documents[1].id, runId: f.runs[1].id } },
    { tool: 'workflow.run', arguments: { runId: f.runs[1].id } },
    { tool: 'workflow.inspect', arguments: { workflowId: f.documents[1].id } },
    { tool: 'session.history', arguments: { sessionId: f.sessions[1].id } },
    { tool: 'app.logs', arguments: {} },
    { tool: 'workflow.delete', arguments: { workflowId: f.documents[1].id, expectedRevision: 1, operationId: 'forbidden-delete' } },
    { tool: 'workflow.run', arguments: { runId: f.runs[0].id, role: 'supervisor' } },
    { tool: 'workflow.run', arguments: { runId: f.runs[1].id }, role: 'supervisor' },
  ];
  for (const reply of invalid) {
    f.responses = [reply, { text: '越权请求已被拒绝。' }];
    const result = await f.plan({ context: { workflowId: f.documents[0].id, role: 'supervisor', runId: f.runs[0].id } });
    assert.equal(result.evidence[0].tool, 'tool.admission');
    assert.equal(f.reads.length, 0, JSON.stringify(reply));
  }
  await assert.rejects(f.app.applicationAssistant.call('workflow.run', { runId: f.runs[1].id },
    { role: 'supervisor', permissionScope: { role: 'supervisor' } }), /服务端权限范围/);
  assert.deepEqual(business(f.app), before);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM application_supervisor_operations').get().count, 0);
});

test('a mixed cross-workflow batch is atomically refused before its valid first read', async t => {
  const f = await fixture(t), before = business(f.app);
  f.responses = [{ tools: [{ tool: 'app.state', arguments: {} },
    { tool: 'workflow.run', arguments: { runId: f.runs[1].id } }] }, { text: '已拒绝整批越权请求。' }];
  const result = await f.plan();
  assert.equal(f.reads.length, 0); assert.deepEqual(result.evidence.map(row => row.tool), ['tool.admission']);
  assert.deepEqual(business(f.app), before);
});

test('supervisor mutations cannot be hidden behind a valid read in a batch', async t => {
  const f = await fixture(t), before = business(f.app);
  f.responses = [{ tools: [{ tool: 'app.state', arguments: {} },
    { tool: 'workflow.copy', arguments: { workflowId: f.documents[0].id, expectedRevision: 1, operationId: 'batch-copy' } }] },
  { text: '已拒绝将写操作混入批量读取。' }];
  const result = await f.plan({ role: 'supervisor', document: undefined, context: {} });
  assert.deepEqual(result.evidence.map(row => row.tool), ['tool.admission']);
  assert.equal(f.reads.length, 0); assert.deepEqual(business(f.app), before);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM application_supervisor_operations').get().count, 0);
});

test('the supervisor broker can copy, create test drafts, read software logs and trash a fixture without running code', async t => {
  const f = await fixture(t), original = f.app.workflowLibrary.get(f.documents[0].id);
  f.responses = [
    { tool: 'workflow.copy', arguments: { workflowId: original.id, expectedRevision: 1, title: '权限复制样例', operationId: 'broker-copy' } },
    { tool: 'workflow.create-test', arguments: { title: '权限最小复现', expectedRevision: 0, operationId: 'broker-create' } },
    { tool: 'app.logs', arguments: { limit: 4 } },
    { tool: 'workflow.delete', arguments: { workflowId: f.documents[1].id, expectedRevision: 1, operationId: 'broker-delete' } },
    { text: '四项管理操作完成，未运行工作流。' },
  ];
  const result = await f.plan({ role: 'supervisor', document: undefined, context: {}, page: { route: '#/projects' },
    text: `复制${original.id}，创建独立测试流程，读软件日志，把${f.documents[1].id}移入回收站；都不运行。` });
  assert.deepEqual(result.evidence.map(row => row.tool), ['workflow.copy', 'workflow.create-test', 'app.logs', 'workflow.delete']);
  const receipts = result.checkpoint.results;
  assert.equal(f.app.workflowLibrary.list({ lifecycle: 'all' }).length, 4);
  assert.equal(f.app.workflowLibrary.get(f.documents[1].id).lifecycle, 'trashed');
  assert.deepEqual(f.app.workflowLibrary.get(original.id), original);
  assert.equal(f.app.workflowLibrary.list().some(row => row.title === '[测试] 权限最小复现'), true);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get().count, 2);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM application_supervisor_operations WHERE status=\'complete\'').get().count, 3);
  assert(f.prompts.some(prompt => prompt.includes('GLOBAL_SOFTWARE_LOG_PRIVATE')));
  assert.equal(receipts.some(row => ['workflow.copy', 'workflow.create-test', 'workflow.delete', 'app.logs'].includes(row.tool)), false,
    'mutations and live log windows are not retained as reusable checkpoint results');
});

test('human-disabled management and global logging are omitted and rejected by the real supervisor broker', async t => {
  const f = await fixture(t), before = business(f.app);
  settings(f.app, value => { value.supervisor.manageWorkflows = false; value.supervisor.appLogs = false; });
  f.responses = [
    { tool: 'workflow.copy', arguments: { workflowId: f.documents[0].id, expectedRevision: 1, operationId: 'disabled-copy' } },
    { tool: 'app.logs', arguments: {} }, { text: '管理与全局日志权限已关闭。' },
  ];
  const result = await f.plan({ role: 'supervisor', document: undefined, context: {} });
  assert.deepEqual(result.evidence.map(row => row.tool), ['tool.admission', 'tool.admission']);
  const catalog = JSON.parse(f.prompts[0].split('TOOL_CATALOG=')[1].split('\nSOURCE_JSON=')[0]);
  for (const tool of ['workflow.copy', 'workflow.create-test', 'workflow.delete', 'app.logs']) assert.equal(catalog.some(row => row.name === tool), false);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM application_supervisor_operations').get().count, 0);
  assert.equal(f.reads.length, 0); assert.deepEqual(business(f.app), before);
});

test('a supervisor model cannot turn a read-only human diagnosis into deletion, copying or test creation', async t => {
  const f = await fixture(t), before = business(f.app);
  f.responses = [
    { tool: 'workflow.delete', arguments: { workflowId: f.documents[1].id, expectedRevision: 1, operationId: 'unauthorized-delete' } },
    { tool: 'workflow.copy', arguments: { workflowId: f.documents[0].id, expectedRevision: 1, operationId: 'unauthorized-copy' } },
    { tool: 'workflow.create-test', arguments: { title: '擅自创建', expectedRevision: 0, operationId: 'unauthorized-create' } },
    { text: '已保留现场，只读诊断。' },
  ];
  const result = await f.plan({ role: 'supervisor', document: undefined, context: {}, text: '只读诊断当前错误，保留现场，不要修改工作流。' });
  assert.deepEqual(result.evidence.map(row => row.tool), ['tool.admission', 'tool.admission', 'tool.admission']);
  assert.deepEqual(business(f.app), before);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM application_supervisor_operations').get().count, 0);
});

test('a human permission revision change while the model awaits rejects its next tool without stale-scope execution', async t => {
  const f = await fixture(t), before = business(f.app);
  let resolveModel, entered;
  const enteredModel = new Promise(resolve => { entered = resolve; });
  f.app.assistantModel.generate = async () => { entered(); return new Promise(resolve => { resolveModel = resolve; }); };
  const pending = f.plan(); await enteredModel;
  settings(f.app, value => { value.workflow.workflowRead = false; });
  resolveModel(JSON.stringify({ tool: 'workflow.run', arguments: { runId: f.runs[0].id } }));
  await assert.rejects(pending, /权限已变化/);
  assert.equal(f.reads.length, 0); assert.deepEqual(business(f.app), before);
});

test('a model cannot smuggle business code operations through workflow.propose after custom nodes are disabled', async t => {
  const f = await fixture(t), before = business(f.app);
  settings(f.app, value => { value.workflow.customNodes = false; });
  f.responses = [
    { tool: 'workflow.propose', arguments: { workflowId: f.documents[0].id, request: '添加Python业务节点' } },
    { text: '添加业务代码候选', operations: [{ op: 'add-node', ref: 'forbidden-code', type: 'tool',
      config: { executionMode: 'code', language: 'python', code: 'return {"attempt": "forbidden"}' } }] },
  ];
  await assert.rejects(f.plan({ text: '添加Python节点' }), /未获准.*业务代码节点/);
  assert.equal(f.prompts.length, 2); assert.deepEqual(business(f.app), before);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM application_supervisor_operations').get().count, 0);
});
