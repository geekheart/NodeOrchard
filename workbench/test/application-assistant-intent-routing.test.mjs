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
  assert.equal(f.options[0].deadlineAt, undefined); assert.equal(f.options[1].deadlineAt, undefined);
  assert.deepEqual(turn.modelSessionIds, ['intent-session', 'proposal-session']);
  assert(turn.assistant.checkpoint.steps.some(step => step.modelCall === 1));
  assert(turn.assistant.checkpoint.steps.some(step => step.modelCall === 2));
  assert.deepEqual(f.app.workflowLibrary.get(f.document.id), f.before);
  assert.deepEqual(f.app.workflows.list(), []);
});

test('a workflow conversation keeps waiting beyond six minutes without injecting a hidden planner deadline', async t => {
  const f = await fixture(t); t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  f.app.applicationAssistant.intentClassifier.classify = async () => ({ intent: 'workflow', modelRoute: { provider: 'fixture-provider', model: 'fixture-model' }, modelCalls: 1 });
  let release, reached;
  const gate = new Promise(done => { release = done; }), prepared = new Promise(done => { reached = done; });
  f.beforeReply = async () => { reached(); await gate; };
  const pending = message(f, ORIGINAL); pending.catch(() => {}); await prepared;
  assert.equal(f.options[0].deadlineAt, undefined);
  t.mock.timers.tick(600000); await new Promise(done => setImmediate(done));
  assert.equal(f.app.conversations.get(f.document.id).conversation.turns.at(-1).status, 'thinking');
  release(); assert.equal((await pending).status, 'proposed'); assert.deepEqual(f.app.workflowLibrary.get(f.document.id), f.before); assert.deepEqual(f.app.workflows.list(), []);
});

test('direct workflow proposals receive restored early context without adding it to the lightweight classifier payload', async t => {
  const f = await fixture(t), at = '2026-10-27T01:00:00.000Z';
  const db = f.app.store.db;
  db.prepare('INSERT INTO workflow_conversations(workflow_id,revision) VALUES(?,?)').run(f.document.id, 20);
  const insert = db.prepare('INSERT INTO workflow_conversation_turns(id,workflow_id,client_message_id,created_at,value,private_value) VALUES(?,?,?,?,?,?)');
  for (let index = 0; index < 16; index++) {
    const turn = { id: 'restored-' + index, workflowId: f.document.id, clientMessageId: 'restored-message-' + index, status: 'complete',
      importedArchive: true, sourceTurnId: 'original-' + index, createdAt: at, updatedAt: at, actions: [],
      user: { text: index ? '后续讨论 ' + index : 'EARLY_PROPOSAL_GOAL：无输入，公开 GitHub 数据并生成真实海报。', intent: 'workflow', context: {} },
      assistant: { text: '原有讨论 ' + index, ...(index === 15 ? { historicalProgress: [{ stage: 'proposal', label: 'OLD_PROPOSAL_PROGRESS：等待候选', status: 'interrupted' }] } : {}) } };
    insert.run(turn.id, f.document.id, turn.clientMessageId, at, JSON.stringify(turn), JSON.stringify({ document: f.document, imported: true, automatic: true, requestDigest: 'old-' + index }));
  }
  const turn = await message(f, '按最早的目标创建这个工作流');
  assert.equal(turn.status, 'proposed'); assert.equal(f.prompts.length, 2);
  const classifier = f.prompts[0], proposal = f.prompts[1], source = JSON.parse(proposal.split('\nUSER_SOURCE_JSON=')[1]);
  assert.equal(classifier.includes('EARLY_PROPOSAL_GOAL'), false); assert.equal(classifier.includes('OLD_PROPOSAL_PROGRESS'), false);
  assert.equal(classifier.includes('portableContext'), false);
  assert(source.portableContext.backgroundMessages.some(row => row.text.includes('EARLY_PROPOSAL_GOAL')));
  assert(source.portableContext.diagnosticProgress.some(step => step.label.includes('OLD_PROPOSAL_PROGRESS')));
  assert.equal(source.portableContext.workflowId, f.document.id); assert(JSON.stringify(source.portableContext).length <= 8000);
  assert.deepEqual(f.app.workflowLibrary.get(f.document.id), f.before); assert.deepEqual(f.app.workflows.list(), []);
});

test('ordinary discussion can retrieve omitted middle conversation text through the scoped read-only history tool', async t => {
  const f = await fixture(t), at = '2026-10-27T01:00:00.000Z';
  const db = f.app.store.db;
  db.prepare('INSERT INTO workflow_conversations(workflow_id,revision) VALUES(?,?)').run(f.document.id, 10);
  const insert = db.prepare('INSERT INTO workflow_conversation_turns(id,workflow_id,client_message_id,created_at,value,private_value) VALUES(?,?,?,?,?,?)');
  for (let index = 0; index < 10; index++) {
    const turn = { id: 'middle-' + index, workflowId: f.document.id, clientMessageId: 'middle-message-' + index, status: 'complete', actions: [], createdAt: at, updatedAt: at,
      user: { text: index === 4 ? 'MIDDLE_DETAIL：海报需要保留项目的许可证。' : '一般讨论 ' + index, intent: 'discuss', context: {} }, assistant: { text: '已记录 ' + index } };
    insert.run(turn.id, f.document.id, turn.clientMessageId, at, JSON.stringify(turn), JSON.stringify({ document: f.document, automatic: true, requestDigest: 'middle-' + index }));
  }
  f.app.assistantModel.generate = async (prompt, options) => {
    f.prompts.push(prompt);
    if (options.title === '应用对话 · 任务意图分类') return '{"intent":"discuss"}';
    const tools = JSON.parse(prompt.split('\nTOOL_CATALOG=')[1].split('\nSOURCE_JSON=')[0]);
    assert(tools.some(row => row.name === 'workflow.conversation'));
    if (f.prompts.length === 2) return '{"tool":"workflow.conversation","arguments":{"query":"MIDDLE_DETAIL","limit":1}}';
    assert(prompt.split('\nTOOL_RESULTS_JSON=')[1].includes('MIDDLE_DETAIL'));
    return '{"text":"之前要求海报保留项目许可证；历史资料已读取，未修改工作流。"}';
  };
  const turn = await message(f, '解释之前讨论过的海报要求');
  assert.equal(turn.status, 'complete'); assert.match(turn.assistant.text, /许可证/);
  assert.deepEqual(turn.assistant.evidence.map(row => row.tool), ['workflow.conversation']);
  assert.deepEqual(f.app.workflowLibrary.get(f.document.id), f.before); assert.deepEqual(f.app.workflows.list(), []);
});

test('long conversation text is complete across the real diagnostic broker pagination and projection boundary', async t => {
  const f = await fixture(t), at = '2026-10-27T01:00:00.000Z';
  const expected = 'U'.repeat(1999) + '😀' + '中'.repeat(2500) + 'A'.repeat(3999), userText = expected.slice(0, 4501), assistantText = expected.slice(4501);
  const db = f.app.store.db, source = { id: 'long-history-turn', workflowId: f.document.id, clientMessageId: 'long-history-message', status: 'complete', actions: [],
    createdAt: at, updatedAt: at, user: { text: userText, intent: 'discuss', context: {} }, assistant: { text: assistantText } };
  db.prepare('INSERT INTO workflow_conversations(workflow_id,revision) VALUES(?,1)').run(f.document.id);
  db.prepare('INSERT INTO workflow_conversation_turns(id,workflow_id,client_message_id,created_at,value,private_value) VALUES(?,?,?,?,?,?)')
    .run(source.id, f.document.id, source.clientMessageId, at, JSON.stringify(source), JSON.stringify({ document: f.document, requestDigest: 'long-history' }));
  let restored = '', pages = 0;
  f.app.assistantModel.generate = async (prompt, options) => {
    f.prompts.push(prompt);
    if (options.title === '应用对话 · 任务意图分类') return '{"intent":"discuss"}';
    const transcript = JSON.parse(prompt.split('\nTOOL_RESULTS_JSON=')[1]), page = transcript.filter(row => row.tool === 'workflow.conversation').at(-1)?.result;
    let offset = 0;
    if (page) {
      assert.equal(page.offset, restored.length);
      const text = page.turns[0].messages.map(item => item.text).join('');
      assert(text.length <= 2000); assert.equal(text.includes('[已截断'), false);
      restored += text; pages++;
      if (page.nextOffset === null) return '{"text":"完整历史已逐页读取，未恢复旧操作。"}';
      offset = page.nextOffset;
    }
    return JSON.stringify({ tool: 'workflow.conversation', arguments: { turnId: source.id, offset } });
  };
  const turn = await message(f, '只读核对之前完整的长说明');
  assert.equal(turn.status, 'complete'); assert.equal(restored, expected); assert.equal(pages, 5);
  assert.equal(turn.assistant.evidence.filter(row => row.tool === 'workflow.conversation').length, pages);
  assert.deepEqual(f.app.workflowLibrary.get(f.document.id), f.before); assert.deepEqual(f.app.workflows.list(), []);
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
