import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(name) { this.calls.push(name); throw Error('No real Hermes calls in revision tests'); }
  async stop() {}
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(read) { for (let i = 0; i < 500; i++) { const value = read(); if (value) return value; await tick(); } assert.fail('Fixture did not settle'); }
async function fixture(t) {
  const directory = await mkdtemp('/private/tmp/workbench-revision-request-');
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), workflowRunRoot: join(directory, 'runs') };
  const adapter = new Offline(), app = new Application(config, adapter), f = { app, adapter, prompts: [], intent: 'workflow' };
  app.captureModelRoute = async () => ({ provider: 'fixture', model: 'fixture-model' });
  app.skills = async () => ({ connected: false, skills: [] });
  app.assistantModel.generate = async (prompt, options) => {
    f.prompts.push({ prompt, title: options.title });
    if (options.title === '应用对话 · 任务意图分类') return JSON.stringify({ intent: f.intent });
    await f.beforeProposal?.();
    if (prompt.includes('\nUSER_SOURCE_JSON=')) return JSON.stringify({ text: '仅生成草稿候选。', operations: f.operations || [
      { op: 'update-node', nodeId: 'producer', config: { executionMode: 'code', language: 'javascript', code: 'return String(input).toUpperCase();' } },
    ] });
    return JSON.stringify({ text: '只解释，不生成或执行。' });
  };
  let document = createDocument({ schemaVersion: 2, title: '隔离产物修改' });
  document.nodes = [createNode('input', {}, { id: 'input', config: { outputType: 'text' } }),
    createNode('tool', {}, { id: 'producer', config: { executionMode: 'tool', toolName: 'text.trim', inputType: 'text', outputType: 'text' } }),
    createNode('human', {}, { id: 'review', config: { inputType: 'text', outputType: 'text', reviewTargetNodeId: 'producer', maxRevisions: 3 } }),
    createNode('output', {}, { id: 'output' })];
  for (let i = 1; i < document.nodes.length; i++) document = connectNodes(document, { sourceNode: document.nodes[i - 1].id, sourcePort: 'out', targetNode: document.nodes[i].id, targetPort: 'in' });
  app.workflowLibrary.save({ document, expectedRevision: 0 });
  const started = await app.workflows.start({ document, input: ' original artifact ' });
  const run = await until(() => { const r = app.workflows.get(started.id); return r.status === 'waiting_review' && r; });
  const gate = run.nodes.review;
  Object.assign(f, { document, run, revisionRequest: { runId: run.id, humanNodeId: 'review', attempt: gate.attempt, attemptId: gate.attemptId, artifactHashes: [], targetNodeId: 'producer' } });
  t.after(async () => { await app.close(); assert.deepEqual(adapter.calls, []); await rm(directory, { recursive: true, force: true }); });
  return f;
}
async function send(f, text, extra = {}) {
  const response = await f.app.conversations.message(f.document.id, { clientMessageId: crypto.randomUUID(), text, document: f.document, intent: 'auto', revisionRequest: f.revisionRequest, ...extra });
  return until(() => { const turn = f.app.conversations.get(f.document.id).conversation.turns.find(t => t.id === response.turn.id); return turn.status !== 'thinking' && turn; });
}

test('a version-bound artifact revision is AI classified then generates one protected draft proposal without rerunning', async t => {
  const f = await fixture(t), before = f.app.workflows.get(f.run.id), saved = f.app.workflowLibrary.get(f.document.id), feedback = '改成中文，保留完整的项目链接。';
  const turn = await send(f, feedback);
  assert.equal(turn.status, 'proposed'); assert.equal(turn.user.text, feedback); assert.equal(turn.user.intent, 'workflow');
  assert.deepEqual(turn.user.revisionRequest, f.revisionRequest); assert.equal(f.prompts.length, 2);
  const classification = JSON.parse(f.prompts[0].prompt.split('\nSOURCE_JSON=')[1]);
  assert.equal(classification.context.requestKind, 'artifact-revision-proposal');
  const source = JSON.parse(f.prompts[1].prompt.split('\nUSER_SOURCE_JSON=')[1]);
  assert(source.userMessage.includes(feedback)); assert.match(source.userMessage, /producer/);
  assert.equal(source.userMessage.split(feedback).length - 1, 1);
  const rules = f.prompts[1].prompt.split('FOUNDATION_CATALOG=')[0];
  assert.match(rules, /明确.*(?:修改|生成).*工具.*核心.*代码/);
  assert.equal(rules.includes('不要用改代码替代正式反馈'), false, 'code revision proposals must not receive a blanket prohibition against editing code');
  assert.match(turn.assistant.text, /旧运行|原运行/);
  assert.deepEqual(f.app.workflows.get(f.run.id), before); assert.deepEqual(f.app.workflowLibrary.get(f.document.id), saved);
  assert.equal((await f.app.conversations.validateProposal(f.document.id, turn.id, { planFingerprint: turn.assistant.baseFingerprint })).valid, true);
});

test('structured revision requests cannot bypass AI classification or approve the review as a local command', async t => {
  const f = await fixture(t); f.intent = 'discuss';
  const before = f.app.workflows.get(f.run.id), turn = await send(f, '通过', { intent: 'workflow' });
  assert.equal(turn.user.intent, 'discuss'); assert.equal(turn.status, 'complete');
  assert.equal(turn.assistant.operations, undefined); assert.equal(turn.outcome, undefined);
  assert(f.prompts[0].title.includes('任务意图分类')); assert.deepEqual(f.app.workflows.get(f.run.id), before);
});

test('stale or foreign revision bindings and revoked permissions admit no model call or review mutation', async t => {
  const f = await fixture(t), before = f.app.workflows.get(f.run.id);
  for (const revisionRequest of [{ ...f.revisionRequest, attempt: 99 }, { ...f.revisionRequest, targetNodeId: 'other' }, { ...f.revisionRequest, extra: true }]) {
    await assert.rejects(send(f, '改成中文', { revisionRequest }));
  }
  const permissions = f.app.assistantPermissionSettings.get();
  f.app.assistantPermissionSettings.save({ expectedRevision: permissions.revision, workflow: { ...permissions.workflow, workflowRead: false }, supervisor: permissions.supervisor });
  await assert.rejects(send(f, '改成中文'), /权限/);
  assert.equal(f.prompts.length, 0); assert.deepEqual(f.app.workflows.get(f.run.id), before);
});

test('review changes before applying a proposal reject stale revision candidates', async t => {
  const f = await fixture(t);
  const turn = await send(f, '改成中文'); assert.equal(turn.status, 'proposed');
  await f.app.workflows.approve(f.run.id, { nodeId: 'review', action: 'approve', expectedAttempt: f.revisionRequest.attempt,
    expectedAttemptId: f.revisionRequest.attemptId, expectedArtifactHashes: [] });
  await assert.rejects(f.app.conversations.validateProposal(f.document.id, turn.id, { planFingerprint: turn.assistant.baseFingerprint }), /审核|版本/);
});

test('a review settled while the candidate model is running cannot publish a stale proposal', async t => {
  const f = await fixture(t);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let entered = false;
  f.beforeProposal = async () => { entered = true; await blocked; };
  const pending = send(f, '改成中文');
  await until(() => entered);
  await f.app.workflows.approve(f.run.id, { nodeId: 'review', action: 'approve', expectedAttempt: f.revisionRequest.attempt,
    expectedAttemptId: f.revisionRequest.attemptId, expectedArtifactHashes: [] });
  release();
  const turn = await pending;
  assert.equal(turn.status, 'error'); assert.match(turn.assistant.text, /审核|版本/);
  assert.equal(turn.assistant.operations, undefined); assert.deepEqual(turn.actions, []);
});

test('concurrent delivery of one revision request returns the same turn and generates only one candidate', async t => {
  const f = await fixture(t), input = { clientMessageId: crypto.randomUUID(), text: '改成中文', document: f.document,
    intent: 'auto', revisionRequest: f.revisionRequest };
  const [first, second] = await Promise.all([f.app.conversations.message(f.document.id, input), f.app.conversations.message(f.document.id, input)]);
  assert.equal(first.turn.id, second.turn.id);
  const turn = await until(() => { const value = f.app.conversations.get(f.document.id).conversation.turns[0]; return value?.status !== 'thinking' && value; });
  assert.equal(turn.status, 'proposed'); assert.equal(f.app.conversations.get(f.document.id).conversation.turns.length, 1);
  assert.equal(f.prompts.length, 2);
});

test('an artifact revision cannot claim success by only renaming a tool or retaining its registered implementation', async t => {
  const f = await fixture(t), before = f.app.workflows.get(f.run.id);
  f.operations = [{ op: 'update-node', nodeId: 'producer', title: '中文海报' }];
  const turn = await send(f, '重新生成这里面的核心代码');
  assert.equal(turn.status, 'error'); assert.match(turn.assistant.text, /未生成实际.*代码修改/);
  assert.equal(turn.assistant.operations, undefined); assert.deepEqual(turn.actions, []);
  assert.deepEqual(f.app.workflows.get(f.run.id), before);
});
