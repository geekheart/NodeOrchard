import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';
import { applyWorkflowOperations, documentFingerprint } from '../shared/workflow/workflow-conversation-commands.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(name) { this.calls.push(name); throw Error('No real Hermes calls in revision validation tests'); }
  async stop() {}
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(read) {
  for (let i = 0; i < 500; i++) { const value = read(); if (value) return value; await tick(); }
  assert.fail('Isolated revision validation did not reach the expected boundary');
}

async function fixture(t) {
  const directory = await mkdtemp('/private/tmp/workbench-revision-validation-');
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), workflowRunRoot: join(directory, 'runs') };
  const adapter = new Offline(), app = new Application(config, adapter);
  t.after(async () => { await app.close(); assert.deepEqual(adapter.calls, []); await rm(directory, { recursive: true, force: true }); });
  app.captureModelRoute = async () => ({ provider: 'fixture', model: 'fixture-model' });
  app.skills = async () => ({ connected: false, skills: [] });
  app.assistantModel.generate = async (prompt, options) => {
    if (options.title === '应用对话 · 任务意图分类') return JSON.stringify({ intent: 'workflow' });
    assert(prompt.includes('\nUSER_SOURCE_JSON='));
    return JSON.stringify({ text: '生成待确认的业务代码修改。', operations: [
      { op: 'update-node', nodeId: 'producer', config: { executionMode: 'code', language: 'javascript', code: 'return String(input).toUpperCase();' } },
    ] });
  };
  let document = createDocument({ schemaVersion: 2, title: '隔离候选确认' });
  document.nodes = [createNode('input', {}, { id: 'input', config: { outputType: 'text' } }),
    createNode('tool', {}, { id: 'producer', config: { executionMode: 'tool', toolName: 'text.trim', inputType: 'text', outputType: 'text' } }),
    createNode('human', {}, { id: 'review', config: { inputType: 'text', outputType: 'text', reviewTargetNodeId: 'producer' } }),
    createNode('output', {}, { id: 'output' })];
  for (let i = 1; i < document.nodes.length; i++) document = connectNodes(document, { sourceNode: document.nodes[i - 1].id, sourcePort: 'out', targetNode: document.nodes[i].id, targetPort: 'in' });
  app.workflowLibrary.save({ document, expectedRevision: 0 });
  const started = await app.workflows.start({ document, input: ' fixture text ' });
  const run = await until(() => { const value = app.workflows.get(started.id); return value.status === 'waiting_review' && value; });
  const gate = run.nodes.review, revisionRequest = { runId: run.id, humanNodeId: 'review', attempt: gate.attempt,
    attemptId: gate.attemptId, artifactHashes: [], targetNodeId: 'producer' };
  const response = await app.conversations.message(document.id, { clientMessageId: crypto.randomUUID(), text: '将输出文字统一改为大写。',
    document, intent: 'auto', revisionRequest });
  const readTurn = () => app.conversations.get(document.id).conversation.turns.find(value => value.id === response.turn.id);
  const turn = await until(() => { const value = readTurn(); return value.status !== 'thinking' && value; });
  assert.equal(turn.status, 'proposed');
  assert.equal((await app.conversations.validateProposal(document.id, turn.id, { planFingerprint: turn.assistant.baseFingerprint })).valid, true);
  const candidate = applyWorkflowOperations(document, turn.assistant.operations).document;
  const input = { action: 'mark-applied', actionId: turn.actions.find(action => action.kind === 'mark-applied').id,
    planFingerprint: turn.assistant.baseFingerprint, document: candidate };
  return { app, document, run, turn, candidate, input, readTurn };
}

// Pause after the real document permission checks and before their final
// awaited return, where permissions or the pending chat item may change.
function holdCandidatePermissionReturn(t, f) {
  let release, entered = false;
  const hold = new Promise(resolve => { release = resolve; });
  const policy = f.app.applicationAssistant.permissions, original = policy.document.bind(policy), fingerprint = documentFingerprint(f.candidate);
  policy.document = async (...args) => {
    const result = await original(...args);
    if (documentFingerprint(args[0]) === fingerprint) { entered = true; await hold; }
    return result;
  };
  t.after(() => release());
  return { release, entered: () => entered };
}

test('revoking edit permission at the final awaited candidate check prevents a successful application receipt', async t => {
  const f = await fixture(t), before = f.app.workflows.get(f.run.id), saved = f.app.workflowLibrary.get(f.document.id);
  const barrier = holdCandidatePermissionReturn(t, f);
  const pending = f.app.conversations.action(f.document.id, f.turn.id, f.input).then(value => ({ value }), error => ({ error }));
  await until(barrier.entered);
  const settings = f.app.assistantPermissionSettings.get();
  f.app.assistantPermissionSettings.save({ expectedRevision: settings.revision,
    workflow: { ...settings.workflow, workflowEdit: false }, supervisor: settings.supervisor });
  barrier.release();
  const result = await pending;
  assert.equal(result.error?.httpStatus, 409);
  assert.match(result.error.message, /权限/);
  assert.equal(f.readTurn().outcome, undefined);
  assert.deepEqual(f.app.workflows.get(f.run.id), before);
  assert.deepEqual(f.app.workflowLibrary.get(f.document.id), saved);
});

test('dismissing a candidate during its awaited application check cannot resurrect the ended chat item', async t => {
  const f = await fixture(t), before = f.app.workflows.get(f.run.id), saved = f.app.workflowLibrary.get(f.document.id);
  const barrier = holdCandidatePermissionReturn(t, f);
  const pending = f.app.conversations.action(f.document.id, f.turn.id, f.input).then(value => ({ value }), error => ({ error }));
  await until(barrier.entered);
  const dismissed = await f.app.conversations.action(f.document.id, f.turn.id, { action: 'dismiss-turn' });
  assert.equal(dismissed.turn.status, 'dismissed');
  const ended = structuredClone(f.readTurn());
  barrier.release();
  const result = await pending;
  assert.equal(result.error?.httpStatus, 409);
  assert.deepEqual(f.readTurn(), ended);
  assert.equal(f.readTurn().outcome, undefined);
  assert.deepEqual(f.app.workflows.get(f.run.id), before);
  assert.deepEqual(f.app.workflowLibrary.get(f.document.id), saved);
});
