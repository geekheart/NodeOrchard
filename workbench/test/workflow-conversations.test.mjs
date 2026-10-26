import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Application } from '../src/application.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';
import { applyWorkflowOperations, documentFingerprint } from '../shared/workflow/workflow-conversation-commands.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(method) { this.calls.push(method); throw Error('Unexpected model execution'); }
  async stop() {}
}
const copy = value => JSON.parse(JSON.stringify(value));
async function until(check) { for (let i = 0; i < 400; i++) { const value = check(); if (value) return value; await delay(5); } throw Error('Timeout'); }
function graph(review = false) {
  let doc = createDocument({ schemaVersion: 2, title: '对话功能验收' });
  doc.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: 'text' } }),
    createNode('tool', { x: 300, y: 0 }, { id: 'trim', config: { executionMode: 'tool', toolName: 'text.trim', inputType: 'text', outputType: 'text' } }),
    ...(review ? [createNode('human', { x: 600, y: 0 }, { id: 'review', config: { inputType: 'text', outputType: 'text', reviewTargetNodeId: 'trim' } })] : []),
    createNode('output', { x: 900, y: 0 }, { id: 'output', config: { stage: 'final' } })];
  for (let i = 0; i < doc.nodes.length - 1; i++) doc = connectNodes(doc, { sourceNode: doc.nodes[i].id, sourcePort: 'out', targetNode: doc.nodes[i + 1].id, targetPort: 'in' });
  return doc;
}
async function fixture(t, { http = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-conversation-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), port: 0 };
  const f = { config, directory };
  f.open = async () => {
    f.adapter = new Offline(); f.app = new Application(config, f.adapter);
    if (http) { f.bridge = createWorkbenchServer(config, f.app); f.origin = await f.bridge.listen(); f.token = (await (await fetch(f.origin + '/api/bootstrap')).json()).csrfToken; }
  };
  f.close = async () => { if (f.bridge) { const bridge = f.bridge; f.bridge = null; await bridge.close(); } else if (!f.app.closed) await f.app.close(); };
  f.restart = async () => { await f.close(); await f.open(); };
  f.request = async (path, body, headers = {}) => {
    const response = await fetch(f.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? headers : {
      'Content-Type': 'application/json', 'X-Workbench-Token': f.token, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => { await f.close(); await rm(directory, { force: true, recursive: true }); });
  await f.open(); return f;
}
const message = (document, text, extra = {}) => ({ clientMessageId: 'message-' + crypto.randomUUID(), text, document, ...extra });
const context = (run, nodeId = 'review') => ({ runId: run.id, nodeId, attempt: run.nodes[nodeId].attempt, attemptId: run.nodes[nodeId].attemptId,
  artifactIds: (run.nodes[nodeId].artifacts || []).map(item => item.id), artifactHashes: (run.nodes[nodeId].artifacts || []).map(item => ({ id: item.id, sha256: item.sha256 })) });

test('conversation feedback persists without a model or Skill and never changes workflow documents', async t => {
  const f = await fixture(t), document = graph();
  const saved = f.app.workflowLibrary.save({ document, expectedRevision: 0 });
  const request = message(document, '标题需要再清楚一点', { intent: 'feedback' });
  const response = await f.app.conversations.message(document.id, request);
  assert.equal(response.turn.status, 'awaiting_action');
  const card = response.turn.actions[0]; assert.equal(card.kind, 'record-feedback');
  const applied = await f.app.conversations.action(document.id, response.turn.id, { action: card.kind, actionId: card.id });
  assert.equal(applied.turn.outcome.feedback.scope, 'workflow');
  assert.equal(applied.turn.outcome.feedback.text, request.text);
  const again = await f.app.conversations.message(document.id, request);
  assert.equal(again.turn.id, applied.turn.id); assert.equal(again.conversation.turns.length, 1);
  const duplicate = await f.app.conversations.action(document.id, applied.turn.id, { action: card.kind, actionId: card.id });
  assert.deepEqual(duplicate.turn.outcome, applied.turn.outcome);
  assert.deepEqual(f.app.workflowLibrary.get(document.id), saved); assert.deepEqual(f.app.workflows.list(), []);
  await f.restart(); assert.equal(f.app.conversations.get(document.id).conversation.turns[0].outcome.feedback.text, request.text);
  assert.deepEqual(f.adapter.calls, []);
});

test('exact human review reply executes once; an unbound reply lists candidates without approval', async t => {
  const f = await fixture(t), document = graph(true);
  f.app.workflowLibrary.save({ document, expectedRevision: 0 });
  const started = await f.app.workflows.start({ document, input: '  图片审核案例  ' });
  const waiting = await until(() => { const run = f.app.workflows.get(started.id); return run.status === 'waiting_review' && run; });
  const unbound = await f.app.conversations.message(document.id, message(document, '通过'));
  assert.equal(unbound.turn.status, 'awaiting_action'); assert.equal(unbound.turn.actions.length, 1);
  assert.equal(f.app.workflows.get(started.id).nodes.review.status, 'waiting_review');
  const missingVersion = await f.app.conversations.message(document.id, message(document, '通过', { context: { runId: started.id, nodeId: 'review' } }));
  assert.equal(missingVersion.turn.status, 'awaiting_action');
  assert.equal(f.app.workflows.get(started.id).nodes.review.status, 'waiting_review');
  const req = message(document, '通过，继续汇总验收。', { context: context(waiting) });
  const approved = await f.app.conversations.message(document.id, req);
  assert.equal(approved.turn.outcome.status, 'complete'); assert.equal(approved.turn.outcome.action, 'review-approve');
  const end = await until(() => f.app.workflows.get(started.id).status === 'complete' && f.app.workflows.get(started.id));
  assert.equal(end.output, '图片审核案例'); assert.equal(approved.pending.length, 0);
  const retry = await f.app.conversations.message(document.id, req);
  assert.equal(retry.turn.id, approved.turn.id); assert.equal(retry.turn.outcome.status, 'complete'); assert.equal(f.app.workflows.list().length, 1);
  assert.deepEqual(f.adapter.calls, []);
});

test('review revise freezes old attempt and rejects stale, foreign run and foreign artifact replies', async t => {
  const f = await fixture(t), document = graph(true);
  const started = await f.app.workflows.start({ document, input: '  abc  ' });
  const original = await until(() => { const run = f.app.workflows.get(started.id); return run.status === 'waiting_review' && run; });
  const other = graph(true);
  await assert.rejects(() => f.app.conversations.message(other.id, message(other, '通过', { context: context(original) })), /不属于此工作流/);
  await assert.rejects(() => f.app.conversations.message(document.id, message(document, '通过', { context: { ...context(original), artifactIds: ['foreign-artifact'] } })), /产物不属于/);
  const changed = await f.app.conversations.message(document.id, message(document, '要求修改：保持精简', { context: context(original) }));
  assert.equal(changed.turn.outcome.status, 'complete');
  const second = await until(() => { const run = f.app.workflows.get(started.id); return run.status === 'waiting_review' && run.nodes.review.attempt === 2 && run; });
  await assert.rejects(() => f.app.conversations.message(document.id, message(document, '通过', { context: context(original) })), /新版本/);
  assert.equal(f.app.workflows.get(started.id).nodes.review.status, 'waiting_review');
  const stop = await f.app.conversations.message(document.id, message(document, '停止本次运行', { context: context(second) }));
  assert.equal(stop.turn.outcome.action, 'review-stop');
});

test('freeform planning is asynchronous, proposal only, and exact command receipt is idempotent', async t => {
  const f = await fixture(t), document = graph(); let resolvePlan, captured;
  f.app.conversations.planner = async (app, options) => { captured = options; return new Promise(resolve => { resolvePlan = resolve; }); };
  const req = message(document, '在末尾添加一次非空检查', { intent: 'workflow' });
  const thinking = await f.app.conversations.message(document.id, req);
  assert.equal(thinking.turn.status, 'thinking'); assert.equal(f.app.workflowLibrary.list().length, 0);
  await until(() => resolvePlan);
  resolvePlan({ text: '新增一个待连接校验节点。', operations: [{ op: 'add-node', ref: 'check', type: 'validation' }], baseFingerprint: documentFingerprint(document) });
  const turn = await until(() => f.app.conversations.get(document.id).conversation.turns.find(turn => turn.status === 'proposed'));
  assert.equal(captured.document.id, document.id); assert.equal(captured.context.run, undefined);
  let generated = 0;
  const result = applyWorkflowOperations(document, turn.assistant.operations, { idFactory: prefix => `${prefix}-${turn.id}-${++generated}` });
  const receipt = { action: 'mark-applied', actionId: turn.actions[0].id, planFingerprint: turn.assistant.baseFingerprint, document: result.document };
  const done = await f.app.conversations.action(document.id, turn.id, receipt);
  assert.equal(done.turn.outcome.status, 'complete'); assert.equal(done.turn.outcome.documentFingerprint, documentFingerprint(result.document));
  assert.deepEqual((await f.app.conversations.action(document.id, turn.id, receipt)).turn.outcome, done.turn.outcome);
  assert.equal(f.app.workflowLibrary.list().length, 0); assert.deepEqual(f.app.workflows.list(), []);
});

test('planning excludes learning runs and restart interrupts unfinished turns without replay', async t => {
  const f = await fixture(t), document = graph(); let calls = 0;
  f.app.conversations.planner = async () => { calls++; return new Promise(() => {}); };
  const response = await f.app.conversations.message(document.id, message(document, '增加一个节点'));
  assert.equal(response.turn.status, 'thinking'); await until(() => calls === 1);
  await f.restart();
  const persisted = f.app.conversations.get(document.id).conversation.turns[0];
  assert.equal(persisted.status, 'interrupted'); assert.equal(calls, 1);
  const run = { schemaVersion: 2, id: crypto.randomUUID(), workflowId: document.id, learningId: 'learning-scope', document, status: 'complete', nodes: {} };
  f.app.workflows.write.run(run.id, JSON.stringify(run));
  await assert.rejects(() => f.app.conversations.message(document.id, message(document, '分析', { context: { runId: run.id } })), /学习样例/);
});

test('scoped generic artifact and tool feedback is durable, while Skill learning does not broaden targets', async t => {
  const f = await fixture(t), document = graph();
  const start = await f.app.workflows.start({ document, input: '  abc ' });
  const run = await until(() => { const value = f.app.workflows.get(start.id); return value.status === 'complete' && value; });
  const reply = await f.app.conversations.message(document.id, message(document, '工具输出请保持大小写', { intent: 'feedback', context: context(run, 'trim') }));
  const card = reply.turn.actions[0];
  const done = await f.app.conversations.action(document.id, reply.turn.id, { action: card.kind, actionId: card.id });
  assert.equal(done.turn.outcome.feedback.scope, 'node'); assert.equal(done.turn.outcome.feedback.context.attempt, 1);
  const skill = await f.app.conversations.message(document.id, message(document, '永久修正此节点', { intent: 'skill', context: context(run, 'trim') }));
  const rejected = await f.app.conversations.action(document.id, skill.turn.id, { action: 'learn-feedback', actionId: skill.turn.actions[0].id });
  assert.equal(rejected.turn.outcome.status, 'rejected'); assert.match(rejected.turn.assistant.text, /Skill/); assert.deepEqual(f.app.learning.list(), []);
});

test('conversation HTTP is same-origin, strict, isolated and archived workflow mutation protected', async t => {
  const f = await fixture(t, { http: true }), document = graph();
  const root = '/api/workflow-conversations/' + document.id;
  assert.equal((await f.request(root)).status, 200);
  const req = message(document, '整理输出名称', { intent: 'feedback' });
  assert.equal((await f.request(root + '/messages', req, { 'X-Workbench-Token': 'wrong' })).status, 403);
  assert.equal((await f.request(root + '/messages', { ...req, unknown: true })).status, 400);
  assert.equal((await f.request(root + '?all=1')).status, 400);
  const good = await f.request(root + '/messages', req); assert.equal(good.status, 202);
  assert.equal((await f.request(root + '/messages', { ...req, text: 'different' })).status, 409);
  const other = graph(); assert.deepEqual((await f.request('/api/workflow-conversations/' + other.id)).body.conversation.turns, []);
  const wrong = await f.request('/api/workflow-conversations/' + other.id + '/turns/' + good.body.turn.id + '/action', { action: 'record-feedback' });
  assert.equal(wrong.status, 404);
  const saved = f.app.workflowLibrary.save({ document, expectedRevision: 0 });
  f.app.workflowLibrary.transition(document.id, 'archive', { expectedRevision: saved.revision });
  assert.equal((await f.request(root)).status, 200);
  assert.equal((await f.request(root + '/messages', message(document, '归档后不能修改', { intent: 'feedback' }))).status, 409);
});

test('explicit rerun has exact scope and uncertain outcomes are durable without duplicate effects', async t => {
  const f = await fixture(t), document = graph();
  const start = await f.app.workflows.start({ document, input: '  abc ' });
  const run = await until(() => { const value = f.app.workflows.get(start.id); return value.status === 'complete' && value; });
  const request = message(document, '重新运行此节点', { context: context(run, 'trim') });
  let calls = 0, seen;
  const original = f.app.workflows.rerun.bind(f.app.workflows);
  f.app.workflows.rerun = async (...args) => { calls++; seen = args; return original(...args); };
  const done = await f.app.conversations.message(document.id, request);
  assert.equal(done.turn.outcome.action, 'rerun'); assert.equal(done.turn.outcome.status, 'complete');
  assert.equal(seen[1].expectedNodes[0].attemptId, run.nodes.trim.attemptId);
  await f.app.conversations.message(document.id, request); assert.equal(calls, 1);
  const current = await until(() => { const value = f.app.workflows.get(start.id); return value.status === 'complete' && value.nodes.trim.attempt === 2 && value; });
  f.app.workflows.rerun = async () => { calls++; throw Error('响应丢失，操作结果未知'); };
  const uncertainRequest = message(document, '重做', { context: context(current, 'trim') });
  const uncertain = await f.app.conversations.message(document.id, uncertainRequest);
  assert.equal(uncertain.turn.outcome.status, 'unknown');
  assert.equal((await f.app.conversations.message(document.id, uncertainRequest)).turn.outcome.status, 'unknown');
  const card = uncertain.turn.actions[0];
  assert.equal((await f.app.conversations.action(document.id, uncertain.turn.id, { action: card.kind, actionId: card.id })).turn.outcome.status, 'unknown');
  assert.equal(calls, 2);
  await f.restart();
  const restored = f.app.conversations.get(document.id).conversation.turns.find(item => item.id === uncertain.turn.id);
  assert.equal(restored.outcome.status, 'unknown');
});

test('message and action integrity rejects changed envelopes, stale plan receipts and learning samples', async t => {
  const f = await fixture(t), document = graph();
  const withNull = message(document, 'invalid\0text');
  await assert.rejects(() => f.app.conversations.message(document.id, withNull), /消息/);
  await assert.rejects(() => f.app.conversations.message(document.id, message(document, '反馈', { context: { artifactHashes: [{ id: 'x', sha256: 'bad' }] } })), /哈希/);
  f.app.conversations.planner = async () => ({ text: '更新标题', operations: [{ op: 'set-title', title: '新标题' }], baseFingerprint: documentFingerprint(document) });
  const response = await f.app.conversations.message(document.id, message(document, '更新标题'));
  const turn = await until(() => f.app.conversations.get(document.id).conversation.turns.find(item => item.id === response.turn.id && item.status === 'proposed'));
  const card = turn.actions[0];
  await assert.rejects(() => f.app.conversations.action(document.id, turn.id, { action: 'mark-applied', actionId: card.id, planFingerprint: 'wrong', document }), /计划版本/);
  await assert.rejects(() => f.app.conversations.action(document.id, turn.id, { action: 'mark-applied', actionId: card.id, planFingerprint: turn.assistant.baseFingerprint, document }), /画布内容/);
  assert.equal(f.app.conversations.get(document.id).conversation.turns[0].outcome, undefined);
});

test('root conversation discovers and reviews a real nested human gate, rejecting spoofed child membership', async t => {
  const f = await fixture(t), child = graph(true);
  let document = createDocument({ schemaVersion: 2, title: '带组合审核的父流程' });
  document.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'parent-input', config: { outputType: 'text' } }),
    createNode('subflow', { x: 300, y: 0 }, { id: 'component', title: '文本组合', config: { document: child, inputType: 'text', outputType: 'text' } }),
    createNode('output', { x: 600, y: 0 }, { id: 'parent-output', config: { stage: 'final' } })];
  document = connectNodes(document, { sourceNode: 'parent-input', sourcePort: 'out', targetNode: 'component', targetPort: 'in' });
  document = connectNodes(document, { sourceNode: 'component', sourcePort: 'out', targetNode: 'parent-output', targetPort: 'in' });
  const start = await f.app.workflows.start({ document, input: '  nested  ' });
  const waiting = await until(() => { const value = f.app.workflows.get(start.id); return value.status === 'waiting_review' && value; });
  const pending = f.app.conversations.get(document.id).pending;
  assert.equal(pending.length, 1); assert.match(pending[0].label, /文本组合/); assert.notEqual(pending[0].context.runId, start.id);
  const realChild = f.app.workflows.get(pending[0].context.runId);
  const spoof = { ...copy(realChild), id: crypto.randomUUID() };
  f.app.workflows.write.run(spoof.id, JSON.stringify(spoof));
  await assert.rejects(() => f.app.conversations.message(document.id, message(document, '通过', { context: context(spoof) })), /子运行不属于/);
  const approved = await f.app.conversations.message(document.id, message(document, '通过，纳入 HDK', { context: pending[0].context }));
  assert.equal(approved.turn.outcome.status, 'complete'); assert.equal(approved.turn.outcome.runId, realChild.id);
  const done = await until(() => { const value = f.app.workflows.get(start.id); return value.status === 'complete' && value; });
  assert.equal(done.output, 'nested'); assert.equal(waiting.nodes.component.status, 'waiting_review');
});

test('draft operation receipts survive unrelated selected-run attempt advancement', async t => {
  const f = await fixture(t), document = graph();
  const started = await f.app.workflows.start({ document, input: 'text' });
  const run = await until(() => { const value = f.app.workflows.get(started.id); return value.status === 'complete' && value; });
  f.app.conversations.planner = async () => ({ text: '改标题', operations: [{ op: 'set-title', title: '更清晰的标题' }], baseFingerprint: documentFingerprint(document) });
  const response = await f.app.conversations.message(document.id, message(document, '标题改清楚一点', { context: context(run, 'trim') }));
  const turn = await until(() => f.app.conversations.get(document.id).conversation.turns.find(item => item.id === response.turn.id && item.status === 'proposed'));
  await f.app.workflows.rerun(run.id, { nodeIds: ['trim'] });
  await until(() => f.app.workflows.get(run.id).nodes.trim.attempt === 2 && f.app.workflows.get(run.id).status === 'complete');
  const result = applyWorkflowOperations(document, turn.assistant.operations);
  const receipt = await f.app.conversations.action(document.id, turn.id, { action: 'mark-applied', actionId: turn.actions[0].id,
    planFingerprint: turn.assistant.baseFingerprint, document: result.document });
  assert.equal(receipt.turn.outcome.status, 'complete');
});

test('dismissing an old proposal or error is idempotent, retains history and never dismisses human review', async t => {
  const f = await fixture(t), document = graph();
  f.app.conversations.planner = async () => ({ text: '建议保留明确的产物标题。', operations: [{ op: 'set-title', title: '清晰标题' }], baseFingerprint: documentFingerprint(document) });
  const proposed = await f.app.conversations.message(document.id, message(document, '优化流程标题'));
  const original = await until(() => f.app.conversations.get(document.id).conversation.turns.find(turn => turn.id === proposed.turn.id && turn.status === 'proposed'));
  const dismissed = await f.app.conversations.action(document.id, original.id, { action: 'dismiss-turn' });
  assert.equal(dismissed.turn.status, 'dismissed'); assert.equal(dismissed.turn.resolution.previousStatus, 'proposed');
  assert.deepEqual(dismissed.turn.user, original.user); assert.deepEqual(dismissed.turn.assistant, original.assistant); assert.deepEqual(dismissed.turn.actions, original.actions);
  const again = await f.app.conversations.action(document.id, original.id, { action: 'dismiss-turn' });
  assert.deepEqual(again.turn, dismissed.turn);
  await assert.rejects(() => f.app.conversations.action(document.id, original.id, { action: 'mark-applied', actionId: original.actions[0].id }), /事项已结束/);
  f.app.conversations.planner = async () => { throw Error('模拟服务不可用'); };
  const failed = await f.app.conversations.message(document.id, message(document, '再提供一次建议'));
  const failedTurn = await until(() => f.app.conversations.get(document.id).conversation.turns.find(turn => turn.id === failed.turn.id && turn.status === 'error'));
  const endedFailure = await f.app.conversations.action(document.id, failedTurn.id, { action: 'dismiss-turn' });
  assert.equal(endedFailure.turn.status, 'dismissed'); assert.equal(endedFailure.turn.assistant.text, failedTurn.assistant.text);
  assert.deepEqual(f.app.workflows.list(), []); assert.deepEqual(f.app.learning.list(), []);
  const reviewDocument = graph(true), start = await f.app.workflows.start({ document: reviewDocument, input: 'review stays pending' });
  await until(() => f.app.workflows.get(start.id).status === 'waiting_review');
  const unbound = await f.app.conversations.message(reviewDocument.id, message(reviewDocument, '通过'));
  await assert.rejects(() => f.app.conversations.action(reviewDocument.id, unbound.turn.id, { action: 'dismiss-turn' }), /人工审核仍在等待/);
  assert.equal(f.app.conversations.get(reviewDocument.id).pending.length, 1);
  assert.equal(f.app.workflows.get(start.id).nodes.review.status, 'waiting_review');
  await f.restart();
  const restored = f.app.conversations.get(document.id).conversation.turns.find(turn => turn.id === original.id);
  assert.deepEqual(restored, dismissed.turn);
});

function multiSkillRun() {
  let document = createDocument({ schemaVersion: 2, title: '多个 Skill 的定向反馈' });
  document.nodes = [createNode('input', {}, { id: 'input', config: { outputType: 'text' } }),
    ...[1, 2].flatMap(index => [createNode('skill', {}, { id: 'skill-' + index, config: { skillRef: 'fixture-' + index,
      version: 'sha256:' + String(index).repeat(64), inputType: 'text', outputType: 'text' } }),
      createNode('tool', {}, { id: 'producer-' + index, config: { executionMode: 'code', code: 'return input;', inputType: 'text', outputType: 'text' } })]),
    createNode('output', {}, { id: 'output', config: { stage: 'final' } })];
  for (let i = 0; i < document.nodes.length - 1; i++) document = connectNodes(document, { sourceNode: document.nodes[i].id, sourcePort: 'out', targetNode: document.nodes[i + 1].id, targetPort: 'in' });
  document.nodes.push(createNode('evaluation', {}, { id: 'compare', config: { comparison: 'exact' } }),
    createNode('improvement', {}, { id: 'improve', config: { targetSkillNodeIds: ['skill-1', 'skill-2'] } }));
  document = connectNodes(document, { sourceNode: 'output', sourcePort: 'learning', targetNode: 'compare', targetPort: 'in' });
  document = connectNodes(document, { sourceNode: 'compare', sourcePort: 'out', targetNode: 'improve', targetPort: 'in' });
  return { schemaVersion: 2, id: crypto.randomUUID(), workflowId: document.id, document, status: 'complete', input: 'original', output: 'original final',
    skills: document.nodes.filter(node => node.type === 'skill').map(node => ({ nodeId: node.id, name: node.config.skillRef, revision: node.config.version })),
    nodes: Object.fromEntries(document.nodes.map(node => [node.id, { status: ['evaluation', 'improvement'].includes(node.type) ? 'skipped' : 'complete',
      attempt: 1, attemptId: crypto.randomUUID(), input: 'actual input ' + node.id, output: 'actual output ' + node.id, artifacts: [] }])) };
}

test('chat Skill learning keeps selected scope on multi-Skill runs and resolves only a unique upstream producer', async t => {
  const f = await fixture(t), run = multiSkillRun(), document = run.document;
  f.app.workflows.write.run(run.id, JSON.stringify(run));
  const original = JSON.stringify(f.app.workflows.get(run.id)); const learningRequests = [];
  f.app.learning.startFeedback = async request => {
    const feedback = f.app.feedback.learningRequest(request.runId, { feedbackRevision: request.feedbackRevision });
    learningRequests.push(feedback);
    return { id: 'isolated-learning-' + learningRequests.length, config: { trainableNodeIds: feedback.targets.map(target => target.nodeId) } };
  };
  const selected = await f.app.conversations.message(document.id, message(document, '只改善第一个 Skill 的提取方法', { intent: 'skill', context: context(run, 'skill-1') }));
  const first = await f.app.conversations.action(document.id, selected.turn.id, { action: 'learn-feedback', actionId: selected.turn.actions[0].id });
  assert.equal(first.turn.outcome.status, 'complete'); assert.deepEqual(first.turn.outcome.targetNodeIds, ['skill-1']);
  assert.equal(learningRequests[0].schemaVersion, 3); assert.deepEqual(learningRequests[0].targets.map(target => target.nodeId), ['skill-1']);
  assert.equal(learningRequests[0].targets[0].version, run.skills[0].revision);
  const producer = await f.app.conversations.message(document.id, message(document, '改进此产物对应的方法', { intent: 'skill', context: context(run, 'producer-2') }));
  const second = await f.app.conversations.action(document.id, producer.turn.id, { action: 'learn-feedback', actionId: producer.turn.actions[0].id });
  assert.equal(second.turn.outcome.status, 'complete'); assert.deepEqual(second.turn.outcome.targetNodeIds, ['skill-2']);
  assert.deepEqual(learningRequests[1].targets.map(target => target.nodeId), ['skill-2']);
  assert.equal(JSON.stringify(f.app.workflows.get(run.id)), original); assert.deepEqual(f.adapter.calls, []);
  assert.deepEqual(f.app.learnedSkills.list(), []);
});

test('ambiguous artifact ancestry asks for one Skill instead of broadening feedback learning', async t => {
  const f = await fixture(t), run = multiSkillRun();
  let document = run.document;
  document.edges = document.edges.filter(edge => edge.targetNode !== 'output');
  document.nodes.push(createNode('merge', {}, { id: 'combined', ports: { inputs: [{ id: 'a', label: 'a', type: 'text' }, { id: 'b', label: 'b', type: 'text' }], outputs: [{ id: 'out', label: 'out', type: 'object' }] } }));
  document = connectNodes(document, { sourceNode: 'skill-1', sourcePort: 'out', targetNode: 'combined', targetPort: 'a' });
  document = connectNodes(document, { sourceNode: 'producer-2', sourcePort: 'out', targetNode: 'combined', targetPort: 'b' });
  document = connectNodes(document, { sourceNode: 'combined', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
  run.document = document; run.nodes.combined = { status: 'complete', attempt: 1, attemptId: crypto.randomUUID(), input: {}, output: {}, artifacts: [] };
  f.app.workflows.write.run(run.id, JSON.stringify(run));
  const reply = await f.app.conversations.message(document.id, message(document, '优化这些产物的方法', { intent: 'skill', context: context(run, 'combined') }));
  const rejected = await f.app.conversations.action(document.id, reply.turn.id, { action: 'learn-feedback', actionId: reply.turn.actions[0].id });
  assert.equal(rejected.turn.outcome.status, 'rejected'); assert.match(rejected.turn.assistant.text, /多个.*Skill.*选择/);
  assert.equal(f.app.feedback.current(run.id), null); assert.deepEqual(f.app.learning.list(), []);
});
