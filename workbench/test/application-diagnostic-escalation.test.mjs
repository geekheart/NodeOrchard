import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode } from '../shared/workflow/workflow-model.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(method) { this.calls.push(method); throw Error('No native model or business execution in this fixture'); }
  async stop() {}
}
async function settled(read) {
  for (let count = 0; count < 150; count++) {
    const result = read();
    if (!['thinking', 'queued', 'starting', 'started'].includes(result.status)) return result;
    await delay(20);
  }
  assert.fail('isolated assistant did not finish');
}

test('the original workflow chat can inspect, escalate, retrieve and propose using the real broker without changing workflows', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'diagnostic-escalation-loop-')), adapter = new Offline();
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }),
    port: 0, hermesPython: process.env.WORKBENCH_TEST_PYTHON || 'python3', workflowRunRoot: join(directory, 'runs') };
  const app = new Application(config, adapter);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const document = createDocument({ schemaVersion: 2, title: '隔离诊断回归' });
  document.nodes = [createNode('tool', {}, { id: 'script-node', config: { executionMode: 'code', language: 'python',
    code: 'render_script = "import math\\n    print(1)"\nreturn input' } })];
  const first = app.workflowLibrary.save({ document, expectedRevision: 0 });
  const foreign = app.workflowLibrary.save({ document: createDocument({ schemaVersion: 2, title: 'PRIVATE_FOREIGN_WORKFLOW' }), expectedRevision: 0 });
  const before = [first, foreign].map(record => JSON.stringify(app.workflowLibrary.get(record.id)));
  app.captureModelRoute = async () => ({ provider: 'fixture', model: 'fixture' });
  const diagnosticReads = [], originalRead = app.diagnostics.read.bind(app.diagnostics);
  app.diagnostics.read = async (name, args, context) => { diagnosticReads.push({ name, args }); return originalRead(name, args, context); };
  let initial = 0, supervisor = 0, followup = 0, candidateSource;
  app.assistantModel = { close: async () => {}, generate: async prompt => {
    if (prompt.startsWith('你是工作台的任务意图分类器')) return '{"intent":"diagnose"}';
    if (prompt.includes('\nUSER_SOURCE_JSON=')) {
      candidateSource = JSON.parse(prompt.split('\nUSER_SOURCE_JSON=')[1]);
      return JSON.stringify({ text: '语法修改候选，等待应用。', operations: [{ op: 'update-node', nodeId: 'script-node', config: { code: 'return input' } }] });
    }
    const source = JSON.parse(prompt.split('\nSOURCE_JSON=')[1].split('\nTOOL_RESULTS_JSON=')[0]);
    if (source.permissionScope.role === 'supervisor') {
      assert.equal(source.permissionScope.readOnly, true); assert.equal(source.permissionScope.workflowBound, true);
      assert(!prompt.includes('PRIVATE_FOREIGN_WORKFLOW'));
      return JSON.stringify(++supervisor === 1 ? { tool: 'workflow.inspect', arguments: { workflowId: foreign.id } }
        : { text: '静态证据显示子脚本第2行意外缩进；仅建议修改，尚未执行。' });
    }
    if (source.userMessage === '取回总控结论并准备修改候选') {
      return JSON.stringify(++followup === 1 ? { tool: 'conversation.escalation', arguments: {} }
        : { tool: 'workflow.propose', arguments: { request: '依据总控结论修复该脚本的缩进。' } });
    }
    return JSON.stringify(++initial === 1 ? { tool: 'runtime.code.check', arguments: { nodeId: 'script-node', pythonScriptVariables: ['render_script'] } }
      : initial === 2 ? { tool: 'conversation.escalate', arguments: { operationId: 'fixture-escalation', summary: '已静态确认Python子脚本第2行意外缩进，请核对实现。', nodeId: 'script-node', start: true } }
        : { text: '总控只读诊断已登记，请按原聊天继续查询。' });
  } };
  const input = { document: first.document, context: { documentRevision: first.revision } };
  const response = await app.conversations.message(first.id, { ...input, clientMessageId: 'first-question', text: '检查Python脚本的问题' });
  const parent = await settled(() => app.conversations.readTurn(first.id, response.turn.id).turn);
  assert.equal(parent.status, 'complete', JSON.stringify(parent));
  assert.equal(parent.assistant.evidence.find(row => row.tool === 'runtime.code.check').status, 'complete');
  const scope = await app.applicationAssistant.permissions.bind({ role: 'workflow', workflowId: first.id });
  const context = { role: 'workflow', workflowId: first.id, permissionScope: scope };
  const receipt = await app.applicationAssistant.hub.call('conversation.escalation', {}, context);
  await settled(() => app.applicationAssistant.readTurn(receipt.turnId, receipt.conversationId));
  const second = await app.conversations.message(first.id, { ...input, clientMessageId: 'next-question', text: '取回总控结论并准备修改候选' });
  const proposal = await settled(() => app.conversations.readTurn(first.id, second.turn.id).turn);
  assert.equal(proposal.status, 'proposed'); assert.match(candidateSource.supervisorEvidence[0].text, /第2行/);
  assert.equal(candidateSource.supervisorEvidence[0].diagnosisOnly, true);
  assert(!diagnosticReads.some(row => row.args.workflowId === foreign.id));
  assert.deepEqual([first, foreign].map(record => JSON.stringify(app.workflowLibrary.get(record.id))), before);
  assert.deepEqual(adapter.calls, []); assert.equal(app.workflows.list().length, 0);
  assert.equal(app.assistantPermissionSettings.get().supervisor.sourceRepair, false);
});
