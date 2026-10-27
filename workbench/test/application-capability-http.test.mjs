import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application } from '../src/application.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode } from '../shared/workflow/workflow-model.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.calls = []; this.serverRequests = new Map(); }
  async request(method) { this.calls.push(method); throw Error('Unexpected Hermes/model/business call: ' + method); }
  async stop() {}
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'application-capability-http-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }),
    port: 0, hermesPython: process.env.WORKBENCH_TEST_PYTHON || 'python3', workflowRunRoot: join(directory, 'runs') };
  const adapter = new Offline(), app = new Application(config, adapter), bridge = createWorkbenchServer(config, app);
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = await bridge.listen(), token = (await (await fetch(origin + '/api/bootstrap')).json()).csrfToken;
  const request = async (path, body, headers = {}) => {
    const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Workbench-Token': token }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const document = createDocument({ schemaVersion: 2, title: '保留不动的隔离工作流' });
  document.nodes = [createNode('skill', {}, { id: 'export', config: { skillRef: 'xlsx-fixture', version: 'sha256:' + 'a'.repeat(64) } })];
  app.workflowLibrary.save({ document, expectedRevision: 0 });
  const run = { id: 'fixture-old-run', schemaVersion: 2, workflowId: document.id, document, status: 'error', error: 'FIXTURE_ERROR',
    startedAt: '2026-10-27T01:00:00Z', nodes: { export: { status: 'error', attempt: 1, attemptId: 'fixture-attempt', error: 'FIXTURE_NODE_ERROR' } } };
  app.workflows.write.run(run.id, JSON.stringify(run));
  return { app, adapter, request, document, run };
}

function businessSnapshot(app) {
  const conversationTables = new Set(['application_conversation_turns', 'workflow_conversations', 'workflow_conversation_turns', 'application_logs']);
  const tables = app.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => row.name).filter(name => !conversationTables.has(name));
  return tables.map(name => {
    assert.match(name, /^[a-z_]+$/);
    return [name, app.store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()];
  });
}

async function finished(f) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { body } = await f.request('/api/app-assistant'), turn = body.conversation.turns.at(-1);
    if (turn && turn.status !== 'thinking') return turn;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('capability conversation did not finish');
}

test('capability GET exposes real nodes, interfaces and internal Skill metadata without changing business state', async t => {
  const f = await fixture(t), before = businessSnapshot(f.app);
  const nodes = await f.request('/api/app-capabilities?section=nodes&schemaVersion=2');
  assert.equal(nodes.status, 200);
  const tool = nodes.body.nodes.find(node => node.type === 'tool');
  assert.equal(tool.modes.find(mode => mode.mode === 'code').registrationRequired, false);
  assert.equal(tool.runtime.python.wrapper, 'def main(input, context=None):');
  assert.equal(tool.runtime.policy.automaticExecutionAvailable, false);
  const interfaces = await f.request('/api/app-capabilities?section=interfaces'); assert.equal(interfaces.status, 200);
  assert.equal(interfaces.body.protocol.externalMcpServerAvailable, false);
  assert.equal(interfaces.body.features.find(feature => feature.id === 'execution').status, 'ui-only');
  assert.deepEqual(interfaces.body.tools.map(tool => tool.name), f.app.applicationAssistant.tools().map(tool => tool.name));
  const names = interfaces.body.tools.map(tool => tool.name);
  for (const name of ['node.describe', 'runtime.inspect', 'assistant.skills.list', 'assistant.skills.read', 'workflow.propose', 'workflow.run']) assert(names.includes(name));
  for (const name of ['workflow.start', 'workflow.retry', 'replace-node', 'terminal', 'source.patch']) assert.equal(names.includes(name), false);
  const skills = await f.request('/api/app-capabilities?section=skills'); assert.equal(skills.body.skills.length, 4);
  assert(skills.body.skills.every(skill => /^sha256:[a-f0-9]{64}$/.test(skill.revision) && !Object.hasOwn(skill, 'instructions')));
  for (const query of ['section=source', 'section=nodes&section=skills', 'schemaVersion=3', 'path=../skills']) assert.equal((await f.request('/api/app-capabilities?' + query)).status, 400);
  assert.equal((await f.request('/api/app-capabilities', undefined, { Origin: 'http://untrusted.invalid' })).status, 403);
  assert.deepEqual(businessSnapshot(f.app), before); assert.deepEqual(f.adapter.calls, []);
});

test('global HTTP discovers a code contract, checks only a fixed runtime probe and reads an internal Skill before answering', async t => {
  const f = await fixture(t), before = businessSnapshot(f.app), prompts = [];
  const replies = [
    { tool: 'node.describe', arguments: { type: 'tool', schemaVersion: 2 } },
    { tool: 'runtime.inspect', arguments: { language: 'python', modules: ['json'] } },
    { tool: 'assistant.skills.read', arguments: { name: 'author-code-node' } },
    { text: '代码节点支持Python，不需注册新工具；已只读检查运行环境和内部方法，实际工作流保持不动。' },
  ];
  f.app.captureModelRoute = async () => ({ provider: 'fixture', model: 'fixture-model' });
  f.app.assistantModel.generate = async (prompt, options) => {
    prompts.push(prompt); assert.equal(options.modelRoute.provider, 'fixture');
    const source = JSON.parse(prompt.split('SOURCE_JSON=')[1].split('\nTOOL_RESULTS_JSON=')[0]);
    assert(source.capabilities.loadedSkills.some(skill => skill.name === 'author-code-node'));
    assert.equal(source.capabilities.features.find(feature => feature.id === 'execution').status, 'ui-only');
    if (prompts.length === 4) {
      const results = JSON.parse(prompt.split('\nTOOL_RESULTS_JSON=')[1]);
      assert.equal(results[0].result.runtime.policy.mayModifyApplicationSource, false);
      assert.equal(results[1].result.available, true);
      assert.equal(results[1].result.modules.find(module => module.name === 'json').available, true);
      assert.equal(results[1].result.libraryProbe, 'spec-only');
      assert.equal(results[2].result.name, 'author-code-node');
      assert.match(results[2].result.instructions, /workflow.propose/);
    }
    return JSON.stringify(replies.shift());
  };
  const posted = await f.request('/api/app-assistant/messages', { clientMessageId: 'readonly-capabilities',
    text: '只读检查Python工具节点和导出能力，保持当前工作流不动，不要修改、应用或运行。',
    context: { workflowId: f.document.id, runId: f.run.id }, page: { route: '#/board' } });
  assert.equal(posted.status, 202);
  const turn = await finished(f); assert.equal(turn.status, 'complete', turn.assistant.text);
  assert.deepEqual(turn.assistant.evidence.map(item => item.tool), ['node.describe', 'runtime.inspect', 'assistant.skills.read']);
  assert(turn.assistant.evidence.every(item => item.status === 'complete'));
  assert.equal(prompts.length, 4); assert.deepEqual(f.adapter.calls, []);
  assert.deepEqual(businessSnapshot(f.app), before);
  assert.deepEqual(f.app.workflows.get(f.run.id), f.run);
});
