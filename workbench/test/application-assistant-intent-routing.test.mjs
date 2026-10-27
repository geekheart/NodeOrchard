import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument } from '../shared/workflow/workflow-model.mjs';

const ORIGINAL = '无输入，帮我完成AI获取github每日热门前10项目，并生成一张图看完github前十项目的海报';
class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(name) { this.calls.push(name); throw new Error('Unexpected real Hermes call'); }
  async stop() {}
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-generation-path-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }),
    workflowRunRoot: join(directory, 'runs') };
  const adapter = new Offline(), app = new Application(config, adapter);
  app.captureModelRoute = async () => ({ provider: 'fixture-provider', model: 'fixture-model' });
  app.skills = async () => ({ connected: false, skills: [] });
  app.learningModel.generate = async () => { throw new Error('A workflow proposal must use the protected assistant controller'); };
  const document = createDocument({ schemaVersion: 2, title: '隔离的新工作流' });
  app.workflowLibrary.save({ document, expectedRevision: 0 });
  const prompts = [], options = [], before = app.workflowLibrary.get(document.id), f = { app, adapter, document, prompts, options, before, intent: 'workflow' };
  app.assistantModel.generate = async (prompt, opts) => {
    prompts.push(prompt); options.push(opts);
    if (opts.title === '应用对话 · 任务意图分类') { opts.onSession?.('intent-session'); return f.classificationRaw ?? JSON.stringify({ intent: f.intent }); }
    if (f.beforeReply) await f.beforeReply(prompt, opts);
    opts.onSession?.('proposal-session');
    if (prompt.includes('\nUSER_SOURCE_JSON=')) return JSON.stringify({ text: '已生成待审候选。', operations: [
      { op: 'add-node', ref: 'input', type: 'input', config: { outputType: 'text', defaultValue: '固定任务' } },
      { op: 'add-node', ref: 'output', type: 'output' },
      { op: 'connect', sourceNode: 'input', sourcePort: 'out', targetNode: 'output', targetPort: 'in' },
    ] });
    return JSON.stringify({ text: '只解释已有状态，不修改或运行。' });
  };
  t.after(async () => { await app.close(); assert.deepEqual(adapter.calls, []); await rm(directory, { recursive: true, force: true }); });
  return f;
}
async function message(f, text, extra = {}) {
  const response = await f.app.conversations.message(f.document.id, { clientMessageId: randomUUID(), text, document: f.document, ...extra });
  for (let i = 0; i < 300; i++) {
    const turn = f.app.conversations.get(f.document.id).conversation.turns.find(row => row.id === response.turn.id);
    if (turn.status !== 'thinking') return turn;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('isolated conversation did not finish');
}
const settings = (app, patch) => {
  const current = app.assistantPermissionSettings.get();
  app.assistantPermissionSettings.save({ expectedRevision: current.revision, workflow: { ...current.workflow, ...patch }, supervisor: current.supervisor });
};

test('the original no-input GitHub poster request is AI-classified before one protected proposal generation', async t => {
  const f = await fixture(t), turn = await message(f, ORIGINAL);
  assert.equal(turn.user.intent, 'workflow');
  assert.equal(turn.status, 'proposed');
  assert.equal(f.prompts.length, 2, 'classification plus proposal, without discovery model decisions');
  assert(f.prompts[0].length < 4000);
  assert.match(f.options[0].title, /任务意图分类/);
  const proposalPrompt = f.prompts[1];
  assert(proposalPrompt.includes('\nUSER_SOURCE_JSON='));
  assert(!proposalPrompt.includes('\nTOOL_RESULTS_JSON='));
  const source = JSON.parse(proposalPrompt.split('\nUSER_SOURCE_JSON=')[1]);
  assert.equal(source.userMessage, ORIGINAL);
  assert.equal(proposalPrompt.split(ORIGINAL).length - 1, 1, 'the original task is sent once');
  assert.equal(turn.assistant.progress.modelCalls, 2);
  assert.deepEqual(f.options[0].modelRoute, { provider: 'fixture-provider', model: 'fixture-model' });
  assert(f.options[1].deadlineAt > f.options[0].deadlineAt);
  assert.deepEqual(turn.modelSessionIds, ['intent-session', 'proposal-session']);
  assert(turn.assistant.checkpoint.steps.some(step => step.modelCall === 1));
  assert(turn.assistant.checkpoint.steps.some(step => step.modelCall === 2));
  assert.deepEqual(f.app.workflowLibrary.get(f.document.id), f.before);
  assert.deepEqual(f.app.workflows.list(), []);
});

test('questions, quoted edit requests and diagnostic instructions stay in the ordinary read-only decision path', async t => {
  for (const text of ['无输入，能不能解释这个工作流怎么运行？', '解释这句话：“帮我创建海报工作流”', '帮我检查为什么失败，不要修改工作流', '请分析这个节点配置是否合理']) {
    const f = await fixture(t); f.intent = 'discuss';
    const turn = await message(f, text);
    assert.equal(turn.user.intent, 'discuss', text);
    assert.equal(turn.status, 'complete', text);
    assert.equal(f.prompts.length, 2, text);
    assert(f.prompts[1].includes('\nTOOL_RESULTS_JSON='), text);
    assert.equal(turn.assistant.operations, undefined);
    assert.deepEqual(f.app.workflowLibrary.get(f.document.id), f.before);
  }
});

test('explicit discussion, local run and feedback requests are not converted into edit generation', async t => {
  for (const request of [{ text: ORIGINAL, intent: 'discuss' }, { text: '运行' }, { text: '这次结果需要修改' }]) {
    const f = await fixture(t); f.intent = 'discuss';
    const { text, ...extra } = request, turn = await message(f, text, extra);
    assert.notEqual(turn.status, 'proposed');
    assert(f.prompts.every(prompt => !prompt.includes('\nUSER_SOURCE_JSON=')));
    assert.deepEqual(f.app.workflowLibrary.get(f.document.id), f.before);
    assert.deepEqual(f.app.workflows.list(), []);
  }
});

test('a delegated read-only instruction cannot enter direct proposal generation', async t => {
  const f = await fixture(t); f.intent = 'discuss';
  const response = await f.app.conversations.messageReadOnly(f.document.id, { clientMessageId: randomUUID(), text: ORIGINAL, document: f.document },
    { operationId: 'delegation-test', sourceConversationId: 'global-application' });
  for (let i = 0; i < 300; i++) {
    const turn = f.app.conversations.get(f.document.id).conversation.turns.find(row => row.id === response.turn.id);
    if (turn.status !== 'thinking') { assert.equal(turn.status, 'complete'); assert.equal(turn.assistant.operations, undefined); break; }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(f.prompts.length, 2);
  assert(f.prompts[1].includes('\nTOOL_RESULTS_JSON='));
  assert.deepEqual(f.app.workflowLibrary.get(f.document.id), f.before);
});

test('disabled editing is rejected after AI classification and before proposal generation', async t => {
  const f = await fixture(t); settings(f.app, { workflowEdit: false });
  const turn = await message(f, ORIGINAL);
  assert.equal(turn.status, 'error');
  assert.equal(f.prompts.length, 1);
  assert.match(f.options[0].title, /任务意图分类/);
  assert.match(turn.assistant.text, /权限|未开放/);
  assert.deepEqual(f.app.workflowLibrary.get(f.document.id), f.before);
});

test('permission changes during direct generation invalidate the candidate without applying or running it', async t => {
  const f = await fixture(t); f.beforeReply = async () => settings(f.app, { workflowEdit: false });
  const turn = await message(f, ORIGINAL);
  assert.equal(turn.status, 'error');
  assert.match(turn.assistant.text, /权限/);
  assert.equal(turn.assistant.operations, undefined);
  assert.deepEqual(f.app.workflowLibrary.get(f.document.id), f.before);
  assert.deepEqual(f.app.workflows.list(), []);
});

test('AI can classify an edit request without a local command prefix', async t => {
  const f = await fixture(t), turn = await message(f, '我需要一套每天自动产出图文结果的流程');
  assert.equal(turn.user.intent, 'workflow'); assert.equal(turn.status, 'proposed');
  assert.equal(f.prompts.length, 2); assert.match(f.options[0].title, /任务意图分类/);
  assert(f.prompts[1].includes('\nUSER_SOURCE_JSON='));
});

test('automatic feedback and reusable-skill requests are AI-classified before their existing action preparation', async t => {
  for (const [intent, text] of [['feedback', '这一版不合适'], ['skill', '把这个习惯留到下次']]) {
    const f = await fixture(t); f.intent = intent;
    const turn = await message(f, text);
    assert.equal(turn.user.intent, intent); assert.equal(turn.status, 'complete');
    assert.equal(f.prompts.length, 1); assert.match(f.options[0].title, /任务意图分类/);
    assert.equal(turn.assistant.progress.modelCalls, 1);
    assert.deepEqual(f.app.workflows.list(), []); assert.deepEqual(f.app.learning.list(), []);
    assert.deepEqual(f.app.workflowLibrary.get(f.document.id), f.before);
  }
});

test('invalid AI classification ends the turn without silently entering diagnosis or proposal generation', async t => {
  for (const raw of ['not-json', '{"intent":"other"}', '{"intent":"workflow","tool":"workflow.propose"}']) {
    const f = await fixture(t); f.classificationRaw = raw;
    const turn = await message(f, ORIGINAL);
    assert.equal(turn.status, 'error'); assert.match(turn.assistant.text, /分类.*无效协议/);
    assert.equal(f.prompts.length, 1);
    assert(!f.prompts[0].includes('\nTOOL_RESULTS_JSON='));
    assert.equal(turn.assistant.operations, undefined);
    assert.deepEqual(f.app.workflowLibrary.get(f.document.id), f.before);
  }
});

test('AI run and review labels prepare no execution, approval or learning operation', async t => {
  for (const intent of ['run', 'review']) {
    const f = await fixture(t); f.intent = intent;
    const turn = await message(f, '接下来请处理当前任务');
    assert.equal(turn.user.intent, intent); assert.equal(turn.status, 'complete');
    assert.equal(f.prompts.length, 1); assert.deepEqual(turn.actions, []);
    assert.deepEqual(f.app.workflows.list(), []); assert.deepEqual(f.app.learning.list(), []);
    assert.deepEqual(f.app.workflowLibrary.get(f.document.id), f.before);
  }
});
