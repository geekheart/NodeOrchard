import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument } from '../shared/workflow/workflow-model.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(method) { this.calls.push(method); throw Error('Unexpected Hermes or business execution: ' + method); }
  async stop() {}
}
const sourceOf = prompt => JSON.parse(prompt.split('\nSOURCE_JSON=')[1].split('\nTOOL_RESULTS_JSON=')[0]);
const catalogOf = prompt => JSON.parse(prompt.split('\nTOOL_CATALOG=')[1].split('\nSOURCE_JSON=')[0]);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-hub-broker-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }),
    workflowRunRoot: join(directory, 'runs') };
  const adapter = new Offline(), app = new Application(config, adapter), prompts = [], reads = [], businessCalls = [];
  const records = ['OWN_WORKFLOW_EVIDENCE', 'FOREIGN_WORKFLOW_PRIVATE_SENTINEL'].map(title =>
    app.workflowLibrary.save({ document: createDocument({ schemaVersion: 2, title }), expectedRevision: 0 }));
  app.captureModelRoute = async () => ({ provider: 'fixture', model: 'fixture-model' });
  const f = { app, adapter, records, prompts, reads, businessCalls, replies: [], classificationIntent: 'diagnose' };
  // Delegation cases test the read-only broker after an explicit AI decision.
  app.applicationAssistant.intentClassifier.classify = async options => {
    const at = new Date().toISOString(); options.onProgress?.({ stage: 'classify-intent', label: '识别对话任务', modelCall: true });
    return { intent: f.classificationIntent, modelRoute: await app.captureModelRoute(), modelCalls: 1, startedAt: at, completedAt: at, durationMs: 0 };
  };
  const read = app.diagnostics.read.bind(app.diagnostics);
  app.diagnostics.read = (...args) => { reads.push(args[0]); return read(...args); };
  for (const name of ['start', 'rerun', 'approve']) app.workflows[name] = async () => { businessCalls.push(name); throw Error('No business operation allowed'); };
  app.assistantModel.generate = async prompt => {
    prompts.push(prompt);
    return JSON.stringify(f.respond ? await f.respond(prompt) : f.replies.shift() || assert.fail('fixture reply queue exhausted'));
  };
  let operation = 0;
  f.delegate = (request, record = records[0]) => app.applicationAssistant.hub.call('conversation.delegate', {
    workflowId: record.id, expectedRevision: record.revision, request, operationId: 'readonly-op-' + (++operation),
  }, { role: 'supervisor', text: `让 ${record.id} 的工作流助手只读诊断。`, sourceConversationId: 'supervisor-fixture' });
  t.after(async () => { await app.close(); assert.deepEqual(adapter.calls, []); await rm(directory, { recursive: true, force: true }); });
  return f;
}
async function completed(f, receipt) {
  for (let count = 0; count < 200; count++) {
    const turn = f.app.conversations.get(receipt.workflowId).conversation.turns.find(row => row.id === receipt.turnId);
    if (turn && turn.status !== 'thinking') return turn;
    await delay(5);
  }
  assert.fail('actual delegated broker did not finish');
}
function business(f) {
  const tables = f.app.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workflow_%' AND name NOT LIKE 'workflow_conversation%' ORDER BY name").all();
  return tables.map(({ name }) => [name, f.app.store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);
}

test('the actual delegated broker pins workflow read-only identity and removes mutation and cross-scope tools', async t => {
  const f = await fixture(t), before = business(f);
  f.replies = [{ tool: 'workflow.inspect', arguments: {} }, { text: '已读取当前工作流，未做修改。' }];
  const turn = await completed(f, await f.delegate('检查当前工作流配置。'));
  assert.equal(turn.status, 'complete'); assert.deepEqual(turn.actions, []);
  assert.deepEqual(f.reads, ['workflow.inspect']);
  for (const prompt of f.prompts) {
    const source = sourceOf(prompt), catalog = catalogOf(prompt), names = catalog.map(row => row.name);
    assert.equal(source.permissionScope.role, 'workflow'); assert.equal(source.permissionScope.readOnly, true);
    assert.equal(source.selection.workflowId, f.records[0].id);
    for (const name of ['workflow.propose', 'workflow.copy', 'workflow.create-test', 'workflow.delete', 'app.logs', 'conversations.list', 'conversation.inspect', 'conversation.delegate']) assert.equal(names.includes(name), false, name);
    assert(catalog.every(row => row.effect === 'read-only'));
    for (const privateValue of [f.records[1].id, f.records[1].document.title]) assert.equal(prompt.includes(privateValue), false, privateValue);
  }
  assert.deepEqual(business(f), before); assert.deepEqual(f.businessCalls, []);
});

test('every registered mutation plus forged execution and foreign reads is rejected by the real delegated broker', async t => {
  const f = await fixture(t), before = business(f);
  const mutationNames = f.app.applicationAssistant.tools().filter(row => row.effect === 'mutation').map(row => row.name);
  const requests = [...mutationNames.map(tool => ({ tool, arguments: {} })),
    { tool: 'workflow.propose', arguments: { request: '修改工作流' } },
    { tool: 'workflow.start', arguments: { workflowId: f.records[0].id } },
    { tool: 'workflow.review-approve', arguments: {} },
    { tool: 'workflow.inspect', arguments: { workflowId: f.records[1].id } },
    { tool: 'app.state', arguments: { role: 'supervisor', readOnly: false } }];
  for (const request of requests) {
    f.replies = [request, { text: '权限检查拒绝了该操作。' }];
    const turn = await completed(f, await f.delegate('诊断当前流程，不执行任何业务。'));
    assert.equal(turn.status, 'complete', request.tool);
    assert.deepEqual(turn.actions, []);
    assert.deepEqual(turn.assistant.evidence.map(row => row.tool), ['tool.admission']);
    assert.equal(turn.assistant.operations, undefined);
  }
  assert.deepEqual(f.reads, []); assert.deepEqual(f.businessCalls, []); assert.deepEqual(business(f), before);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM application_supervisor_operations').get().n, 0);
});

test('delegated natural-language run, review, learning and issue-close commands reach only the read-only broker', async t => {
  const f = await fixture(t), before = business(f);
  for (const [request, intent] of [['运行', 'run'], ['通过', 'review'], ['以后都按这个规则学习', 'skill'], ['这个问题解决了', 'discuss']]) {
    f.classificationIntent = intent;
    f.replies = [{ text: '当前是只读诊断，不执行此业务指令。' }];
    const turn = await completed(f, await f.delegate(request));
    assert.equal(turn.status, 'complete'); assert.deepEqual(turn.actions, []);
    assert.equal(turn.user.intent, intent);
    assert.equal(turn.resolution, undefined); assert.equal(turn.outcome, undefined);
    assert.equal(sourceOf(f.prompts.at(-1)).permissionScope.readOnly, true);
    await assert.rejects(f.app.conversations.action(f.records[0].id, turn.id, { action: 'rerun' }), { httpStatus: 403 });
  }
  assert.equal(f.prompts.length, 4); assert.deepEqual(f.businessCalls, []); assert.deepEqual(business(f), before);
});

test('revoking permission while a delegated model is waiting prevents its next read', async t => {
  const f = await fixture(t), before = business(f);
  let release, entered;
  const modelEntered = new Promise(resolve => { entered = resolve; });
  f.respond = async () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const receipt = await f.delegate('读取当前工作流状态。');
  await modelEntered;
  const settings = f.app.assistantPermissionSettings.get();
  f.app.assistantPermissionSettings.save({ expectedRevision: settings.revision,
    workflow: { ...settings.workflow, workflowRead: false }, supervisor: settings.supervisor });
  release({ tool: 'app.state', arguments: {} });
  const turn = await completed(f, receipt);
  assert.equal(turn.status, 'error'); assert.match(turn.assistant.text, /权限已变化/);
  assert.equal(f.prompts.length, 1); assert.deepEqual(f.reads, []); assert.deepEqual(business(f), before);
});

test('ordinary workflow messages retain the real proposal path without applying or executing the candidate', async t => {
  const f = await fixture(t), before = business(f);
  f.replies = [{ tool: 'workflow.propose', arguments: { request: '把标题改成候选标题。' } },
    { text: '已准备标题修改候选。', operations: [{ op: 'set-title', title: '候选标题' }] }];
  const response = await f.app.conversations.message(f.records[0].id, { clientMessageId: 'normal-proposal', text: '把标题改成候选标题',
    intent: 'discuss', document: f.records[0].document });
  const turn = await completed(f, { workflowId: f.records[0].id, turnId: response.turn.id });
  assert.equal(turn.status, 'proposed'); assert.equal(turn.assistant.operations[0].op, 'set-title');
  assert(turn.actions.some(action => action.kind === 'mark-applied'));
  assert.equal(sourceOf(f.prompts[0]).permissionScope.readOnly, false);
  assert(catalogOf(f.prompts[0]).some(row => row.name === 'workflow.propose'));
  assert.deepEqual(business(f), before); assert.deepEqual(f.businessCalls, []);
});

test('a supervisor can inspect then explicitly delegate through its real broker without merging child contexts', async t => {
  const f = await fixture(t), before = business(f), managerReplies = [
    { tool: 'conversations.list', arguments: {} },
    { tool: 'conversation.inspect', arguments: { workflowId: f.records[0].id } },
    { tool: 'conversation.delegate', arguments: { workflowId: f.records[0].id, expectedRevision: 1, request: '只读检查当前工作流配置。', operationId: 'manager-delegation' } },
    { text: '已委派只读诊断，尚未修改或运行工作流。' },
  ];
  f.respond = prompt => sourceOf(prompt).permissionScope.role === 'supervisor'
    ? managerReplies.shift() || assert.fail('manager response queue exhausted') : { text: 'CHILD_READONLY_DIAGNOSIS' };
  const result = await f.app.applicationAssistant.plan({ role: 'supervisor', sourceConversationId: 'supervisor-fixture',
    text: `让 ${f.records[0].id} 的工作流助手只读诊断，不要运行或修改工作流。`, page: { route: '#/conversations' } });
  assert.deepEqual(result.evidence.map(row => row.tool), ['conversations.list', 'conversation.inspect', 'conversation.delegate']);
  const receipt = result.checkpoint.mutationReceipts.at(-1);
  assert.equal(receipt.tool, 'conversation.delegate'); assert.equal(receipt.targetWorkflowId, f.records[0].id);
  const child = f.app.conversations.get(f.records[0].id).conversation.turns.at(-1);
  const settled = await completed(f, { workflowId: f.records[0].id, turnId: child.id });
  assert.equal(settled.assistant.text, 'CHILD_READONLY_DIAGNOSIS');
  assert.equal(settled.delegation.sourceConversationId, 'supervisor-fixture');
  for (const prompt of f.prompts.filter(prompt => sourceOf(prompt).permissionScope.role === 'workflow')) {
    assert.equal(sourceOf(prompt).permissionScope.readOnly, true);
    assert.equal(prompt.includes(f.records[1].document.title), false);
  }
  assert.deepEqual(business(f), before); assert.deepEqual(f.businessCalls, []);
});

test('capture requests can read only the current supervisor topic and cannot use the legacy history alias', async t => {
  const f = await fixture(t), assistant = f.app.applicationAssistant;
  const first = assistant.createConversation({ clientConversationId: 'capture-first', title: '第一个截图主题' }).conversation;
  const second = assistant.createConversation({ clientConversationId: 'capture-second', title: '第二个截图主题' }).conversation;
  const supervisor = await assistant.permissions.bind({ role: 'supervisor' });
  const policy = assistant.capturePolicy(supervisor, first.id);
  const url = path => new URL(path, 'http://127.0.0.1:4318');
  for (const path of ['/api/conversation-hub', '/api/app-assistant/conversations', '/api/app-assistant/conversations/' + first.id]) {
    assert.equal(await policy.requestPolicy(url(path)), true, path);
  }
  for (const path of ['/api/app-assistant', '/api/app-assistant/conversations/global-application', '/api/app-assistant/conversations/' + second.id]) {
    assert.equal(await policy.requestPolicy(url(path)), false, path);
  }
  const legacy = assistant.capturePolicy(supervisor, 'global-application');
  assert.equal(await legacy.requestPolicy(url('/api/app-assistant')), true);
  assert.equal(await legacy.requestPolicy(url('/api/app-assistant/conversations/global-application')), true);
  assert.equal(await legacy.requestPolicy(url('/api/app-assistant/conversations/' + first.id)), false);
  const unspecified = assistant.capturePolicy(supervisor);
  assert.equal(await unspecified.requestPolicy(url('/api/app-assistant')), false);
  assert.equal(await unspecified.requestPolicy(url('/api/app-assistant/conversations/' + first.id)), false);
  const workflow = await assistant.permissions.bind({ role: 'workflow', workflowId: f.records[0].id, readOnly: true });
  const child = assistant.capturePolicy(workflow, first.id);
  for (const path of ['/api/conversation-hub', '/api/app-assistant', '/api/app-assistant/conversations', '/api/app-assistant/conversations/' + first.id]) {
    assert.equal(await child.requestPolicy(url(path)), false, path);
  }
});
