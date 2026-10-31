import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { ApplicationSourceRepairs } from '../src/application-source-repairs.mjs';
import { createDocument, createNode } from '../shared/workflow/workflow-model.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(method) { this.calls.push(method); throw Error('This isolated fixture must not call Hermes'); }
  async stop() {}
}
const hash = value => createHash('sha256').update(value).digest('hex');
const taskSource = prompt => JSON.parse(prompt.split('\nSOURCE_JSON=')[1].split('\nTOOL_RESULTS_JSON=')[0]);
async function until(read, accept, label = 'isolated assistant result') {
  for (let index = 0; index < 200; index++) {
    const value = await read(); if (accept(value)) return value;
    await delay(5);
  }
  assert.fail('Timed out waiting for ' + label);
}
const terminal = turn => !['thinking', 'queued'].includes(turn.status);

async function fixture(t, { maxCalls = 8 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'maintenance-broker-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }),
    port: 0, workflowRunRoot: join(directory, 'runs') };
  let app, adapter;
  const calls = [];
  const f = { directory, config, calls, classify: 'diagnose', reply: async () => ({ text: '证据已保存，尚未修复原工作流。' }) };
  const open = () => {
    adapter = new Offline(); app = new Application(config, adapter);
    app.captureModelRoute = async () => ({ provider: 'fixture', model: 'fixture' });
    app.assistantModel = { close: async () => {}, generate: async (prompt, options) => {
      const classification = prompt.startsWith('你是工作台的任务意图分类器');
      const proposal = prompt.includes('\nUSER_SOURCE_JSON=');
      calls.push({ prompt, options, classification, proposal });
      if (classification && f.classificationFailure) throw f.classificationFailure;
      return JSON.stringify(classification ? { intent: f.classify }
        : proposal ? await f.proposalReply(JSON.parse(prompt.split('\nUSER_SOURCE_JSON=')[1]), prompt, options)
          : await f.reply(taskSource(prompt), prompt, options));
    } };
    app.applicationAssistant.maxCalls = maxCalls;
    f.app = app; f.assistant = app.applicationAssistant; f.adapter = adapter;
  };
  open();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const document = createDocument({ schemaVersion: 2, title: '隔离维护现场' });
  document.nodes = [createNode('tool', {}, { id: 'local-node', config: { executionMode: 'code', language: 'javascript', code: 'return input;' } })];
  f.saved = app.workflowLibrary.save({ document, expectedRevision: 0 });
  f.before = JSON.stringify(app.workflowLibrary.get(f.saved.id));
  f.topic = f.assistant.createConversation({ clientConversationId: 'original-maintenance-topic', title: '维护回归' }).conversation.id;
  let sequence = 0;
  f.message = async ({ text = '请排查工作台故障，保留原工作流', context = {}, conversationId = f.topic, ...input } = {}) => {
    const response = await f.assistant.message({ clientMessageId: 'human-' + ++sequence, text,
      context: { workflowId: f.saved.id, ...context }, ...input }, conversationId);
    return until(() => f.assistant.readTurn(response.turn.id, conversationId), terminal);
  };
  f.context = async (turn, { role = 'supervisor', conversationId = f.topic, ...extra } = {}) => ({
    role, workflowId: f.saved.id, sourceConversationId: conversationId, diagnosticTurnId: turn.id, maintenanceAuthorized: true,
    text: turn.user.text, permissionScope: await f.assistant.permissions.bind({ role, workflowId: f.saved.id }), ...extra,
  });
  f.call = async (name, args, turn, extra) => f.assistant.call(name, args, await f.context(turn, extra));
  f.settings = values => {
    const current = f.app.assistantPermissionSettings.get();
    return f.app.assistantPermissionSettings.save({ expectedRevision: current.revision, workflow: current.workflow,
      supervisor: { ...current.supervisor, ...values }, modelExperimentLimits: current.modelExperimentLimits });
  };
  f.unchanged = () => {
    assert.equal(JSON.stringify(f.app.workflowLibrary.get(f.saved.id)), f.before);
    assert.equal(f.app.workflows.list().length, 0); assert.deepEqual(f.adapter.calls, []);
  };
  f.restart = async () => { await app.close(); open(); };
  return f;
}

test('a real human message is classified once and registers its persistent maintenance task without running the workflow', async t => {
  const f = await fixture(t), turn = await f.message();
  assert.equal(turn.status, 'complete'); assert.equal(turn.user.intent, 'diagnose');
  const task = turn.assistant.maintenanceTask;
  assert.equal(task.sourceTurnId, turn.id); assert.equal(task.conversationId, f.topic); assert.equal(task.workflowId, f.saved.id);
  assert.equal(task.status, 'waiting_continue'); assert.equal(task.originalWorkflowModified, false); assert.equal(task.originalWorkflowExecuted, false);
  assert.equal(f.calls.filter(call => call.classification).length, 1);
  assert.equal(taskSource(f.calls.find(call => !call.classification).prompt).maintenanceTask.id, task.id);
  const repeated = await f.call('maintenance.task', { action: 'start', operationId: 'same-human-task', goal: turn.user.text }, turn);
  assert.equal(repeated.replayed, true); assert.equal(repeated.task.id, task.id);
  assert.equal(f.app.assistantPermissionSettings.get().supervisor.sourceRepair, false);
  f.unchanged();
});

test('classification failure cannot register or advance a maintenance task', async t => {
  const f = await fixture(t); f.classificationFailure = Error('fixture classifier unavailable');
  const turn = await f.message();
  assert.equal(turn.status, 'error'); assert.equal(turn.user.intent, 'auto'); assert.equal(turn.assistant.maintenanceTask, undefined);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].classification, true);
  await assert.rejects(f.call('maintenance.task', { action: 'inspect' }, turn), { httpStatus: 404 });
  assert.equal(f.app.assistantPermissionSettings.get().supervisor.sourceRepair, false); f.unchanged();
});

test('a permission request stops model decisions and only an explicit new human message continues after a manual setting change', async t => {
  const f = await fixture(t);
  f.reply = async source => ({ tool: 'maintenance.task', arguments: { action: 'request-source-repair',
    taskId: source.maintenanceTask.id, expectedRevision: source.maintenanceTask.revision, note: '已定位软件实现，需要修改源码。' } });
  const turn = await f.message(), task = turn.assistant.maintenanceTask;
  assert.equal(turn.status, 'complete'); assert.equal(task.status, 'waiting_permission'); assert.equal(task.canContinue, false);
  assert.equal(task.permissionRequest.settingsUrl, '#/settings'); assert.equal(task.permissionRequest.enabled, false);
  assert.equal(f.calls.length, 2, 'classification plus one tool decision; no extra model request after permission is required');
  assert.equal(f.app.assistantPermissionSettings.get().supervisor.sourceRepair, false);
  await assert.rejects(f.call('maintenance.task', { action: 'continue', taskId: task.id, expectedRevision: task.revision }, turn), /手动开启|不可用/);
  f.settings({ sourceRepair: true });
  const projected = f.assistant.get(f.topic).conversation.turns.find(item => item.id === turn.id).assistant.maintenanceTask;
  assert.equal(projected.permissionRequest.enabled, true); assert.equal(projected.canContinue, true); assert.equal(projected.status, 'waiting_permission');
  await delay(10); assert.equal(f.calls.length, 2, 'a settings event alone must not issue another model call or patch');
  f.reply = async () => ({ text: '已明确续接，等待进一步证据；尚未写源码。' });
  const continued = await f.message({ text: '继续维护并修复任务，保留原工作流', context: { maintenanceTaskId: task.id } });
  assert.equal(continued.status, 'complete'); assert.equal(continued.assistant.maintenanceTask.id, task.id);
  assert.equal(continued.assistant.maintenanceTask.status, 'waiting_continue');
  assert.equal(f.calls.filter(call => call.classification).length, 2, 'the new human instruction gets its own classification');
  assert.equal(f.assistant.maintenance.read(task.id).activeTurnId, continued.id);
  f.unchanged();
});

test('the dispatcher enforces role, real diagnostic source, original topic and task CAS', async t => {
  const f = await fixture(t), turn = await f.message(), task = turn.assistant.maintenanceTask;
  const start = { action: 'start', operationId: 'origin-check', goal: turn.user.text };
  await assert.rejects(f.call('maintenance.task', start, turn, { role: 'workflow' }), { httpStatus: 403 });
  await assert.rejects(f.call('maintenance.task', start, turn, { maintenanceAuthorized: false }), { httpStatus: 403 });
  await assert.rejects(f.call('maintenance.task', start, turn, { diagnosticTurnId: 'fabricated-human-turn' }), { httpStatus: 404 });
  await assert.rejects(f.call('maintenance.task', { ...start, goal: '换成另一个目标' }, turn), { httpStatus: 409 });
  const otherTopic = f.assistant.createConversation({ clientConversationId: 'other-topic', title: '其它主题' }).conversation.id;
  await assert.rejects(f.call('maintenance.task', { action: 'checkpoint', taskId: task.id, expectedRevision: task.revision, note: 'foreign' }, turn,
    { conversationId: otherTopic }), { httpStatus: 403 });
  await assert.rejects(f.call('maintenance.task', { action: 'checkpoint', taskId: task.id, expectedRevision: task.revision + 1, note: 'stale' }, turn), { httpStatus: 409 });
  const checkpoint = await f.call('maintenance.task', { action: 'checkpoint', taskId: task.id, expectedRevision: task.revision, note: '已核对当前版本，下一步复现节点。' }, turn);
  assert.equal(checkpoint.task.revision, task.revision + 1); assert.match(checkpoint.task.summary, /下一步复现/);
  f.classify = 'discuss';
  const discussion = await f.message({ text: '只想了解维护任务的含义' });
  assert.equal(discussion.user.intent, 'discuss'); assert.equal(discussion.assistant.maintenanceTask, undefined);
  await assert.rejects(f.call('maintenance.task', start, discussion), { httpStatus: 403 });
  f.settings({ appLogs: false });
  await assert.rejects(f.call('maintenance.task', { action: 'inspect', taskId: task.id }, turn), { httpStatus: 403 });
  f.unchanged();
});

test('failed isolated reproduction is not verification and the same experiment is read back without executing twice', async t => {
  const f = await fixture(t), turn = await f.message(), task = turn.assistant.maintenanceTask;
  let executions = 0;
  f.assistant.maintenance.reproduce = async (_app, input) => {
    executions++; assert.deepEqual(input.snapshot.nodeIds, ['local-node']); assert.equal(input.snapshot.workflowId, f.saved.id);
    return { status: 'failed', code: 'FIXTURE_NODE_ERROR', sandbox: { kind: 'fixture-only', status: 'verified' },
      nodeResults: [{ nodeId: 'local-node', status: 'failed', errorCode: 'FIXTURE_NODE_ERROR' }], logs: { stderr: 'token=FIXTURE_SECRET' } };
  };
  const args = { action: 'reproduce', taskId: task.id, expectedRevision: task.revision, operationId: 'first-reproduction', nodeId: 'local-node' };
  const first = await f.call('maintenance.experiment', args, turn);
  assert.equal(first.task.status, 'waiting_continue'); assert.equal(first.experiment.status, 'failed');
  assert(!['verified', 'candidate_verified'].includes(first.task.status));
  const repeated = await f.call('maintenance.experiment', { ...args, expectedRevision: first.task.revision, operationId: 'not-a-second-execution' }, turn);
  assert.equal(repeated.experiment.id, first.experiment.id); assert.equal(repeated.experiment.replayed, true); assert.equal(executions, 1);
  const output = await f.call('maintenance.experiment', { action: 'read-output', taskId: task.id, experimentId: first.experiment.id, stream: 'stderr' }, turn);
  assert.equal(output.text.includes('FIXTURE_SECRET'), false); assert.match(output.text, /REDACTED/);
  assert.equal(f.app.assistantPermissionSettings.get().supervisor.sourceRepair, false);
  f.unchanged();
});

test('related source-copy verification has separate read permission and does not enable source writes', async t => {
  const f = await fixture(t), turn = await f.message(), task = turn.assistant.maintenanceTask;
  let executions = 0;
  f.app.sourceRepairs.verifyReadOnlyTests = async input => {
    executions++; assert.deepEqual(input.files, ['workbench/test/application-maintenance.test.mjs']);
    return { status: 'pass', sourceMatchesSnapshot: true, snapshotHash: 'sha256:' + 'a'.repeat(64),
      sandbox: { kind: 'fixture-only', status: 'verified' }, files: input.files, stdout: 'mock runner only' };
  };
  const args = { action: 'verify', taskId: task.id, expectedRevision: task.revision, operationId: 'readonly-verification',
    files: ['workbench/test/application-maintenance.test.mjs'] };
  await assert.rejects(f.call('maintenance.experiment', args, turn), { httpStatus: 403 });
  assert.equal(executions, 0);
  f.settings({ sourceRead: true });
  const result = await f.call('maintenance.experiment', args, turn);
  assert.equal(result.experiment.status, 'pass'); assert.equal(result.experiment.sourceMatchesSnapshot, true);
  assert.equal(result.task.status, 'verified'); assert.equal(result.task.originalWorkflowExecuted, false);
  assert.equal(result.experiment.scope, 'isolated-source-tests'); assert.equal(executions, 1);
  await assert.rejects(f.call('app.source.patch', { operationId: 'forbidden-patch', files: [] }, turn), { httpStatus: 403 });
  assert.equal(f.app.assistantPermissionSettings.get().supervisor.sourceRepair, false);
  f.unchanged();
});

test('maxCalls one continues a new evidence segment without reclassifying the human message', async t => {
  const f = await fixture(t, { maxCalls: 1 }); let decisions = 0;
  f.reply = async (_source, prompt) => {
    decisions++;
    if (decisions === 1) return { tool: 'page.inspect', arguments: {} };
    if (decisions === 2) { assert.match(prompt, /FINAL_ANSWER_ONLY=true/); return { text: '已取得界面证据，下一段继续判断；尚未修复。' }; }
    assert.equal(decisions, 3); assert.match(prompt, /已取得界面证据/);
    return { text: '续接证据后仍缺复现，原工作流保持不变。' };
  };
  const turn = await f.message({ page: { route: '#/board', diagnosticMarker: 'fixture-page-evidence' } });
  assert.equal(turn.status, 'complete'); assert.equal(decisions, 3);
  assert.equal(f.calls.filter(call => call.classification).length, 1);
  assert.equal(turn.assistant.maintenanceTask.segment, 2);
  assert.equal(turn.assistant.maintenanceTask.evidenceCount, 1);
  assert.equal(turn.assistant.maintenanceTask.status, 'waiting_continue');
  assert.match(turn.assistant.text, /仍缺复现/); f.unchanged();
});

test('explicitly continuing an older task pins source, evidence, result and summary while a newer same-topic task stays unchanged', async t => {
  const f = await fixture(t);
  const first = await f.message({ text: '排查第一个问题，保留原工作流' }), taskA = first.assistant.maintenanceTask;
  const second = await f.message({ text: '排查第二个问题，保留原工作流' }), taskB = second.assistant.maintenanceTask;
  assert.notEqual(taskA.id, taskB.id);
  const contextB = await f.context(second), beforeB = (await f.assistant.call('maintenance.task', { action: 'inspect', taskId: taskB.id }, contextB)).task;
  let decisions = 0;
  f.reply = async source => {
    decisions++; assert.equal(source.maintenanceTask.id, taskA.id, 'SOURCE_JSON must use the explicitly selected task');
    if (decisions === 1) return { tool: 'page.inspect', arguments: {} };
    return { text: 'FIRST_TASK_ONLY：已取得界面证据，第一个问题仍待复现。' };
  };
  const continued = await f.message({ text: '继续维护第一个问题', context: { maintenanceTaskId: taskA.id }, page: { route: '#/board' } });
  assert.equal(continued.status, 'complete'); assert.equal(continued.assistant.maintenanceTask.id, taskA.id);
  assert.equal(continued.assistant.maintenanceTask.sourceTurnId, first.id); assert.equal(continued.assistant.maintenanceTask.evidenceCount, 1);
  assert.match(continued.assistant.maintenanceTask.summary, /FIRST_TASK_ONLY/);
  const afterA = await f.call('maintenance.task', { action: 'inspect', taskId: taskA.id }, continued);
  const afterB = await f.call('maintenance.task', { action: 'inspect', taskId: taskB.id }, second);
  assert.equal(afterA.task.evidenceCount, 1); assert.match(afterA.task.summary, /FIRST_TASK_ONLY/);
  assert.deepEqual(afterB.task, beforeB, 'observe and finishSegment must not update the latest unrelated task');
  const history = f.assistant.get(f.topic).conversation.turns;
  assert.equal(history.find(turn => turn.id === continued.id).assistant.maintenanceTask.id, taskA.id);
  assert.deepEqual(history.find(turn => turn.id === second.id).assistant.maintenanceTask, beforeB);
  assert.equal(decisions, 2); f.unchanged();
});

test('verification readbacks recheck the original receipt after source changes and never rerun the test', async t => {
  for (const action of ['same-admission', 'status', 'read-output']) await t.test(action, async sub => {
    const f = await fixture(sub), sourceRoot = join(f.directory, 'verification-source');
    const tracked = ['workbench/src/feature.mjs', 'workbench/test/feature.test.mjs'];
    await mkdir(join(sourceRoot, 'workbench/src'), { recursive: true }); await mkdir(join(sourceRoot, 'workbench/test'), { recursive: true });
    await writeFile(join(sourceRoot, tracked[0]), 'export const value = 1;\n');
    await writeFile(join(sourceRoot, tracked[1]), "import test from 'node:test'; test('fixture', () => {});\n");
    await f.app.sourceRepairs.close(); f.app.config.projectRoot = sourceRoot; f.app.config.appRoot = join(sourceRoot, 'workbench');
    let executions = 0;
    f.app.sourceRepairs = new ApplicationSourceRepairs(f.app, { readGitState: async () => ({ tracked, dirty: [] }),
      sandboxRunner: async () => { executions++; return { status: 'pass', exitCode: 0, stdout: 'mock sandbox runner only', stderr: '',
        sandbox: { kind: 'macos-seatbelt', status: 'verified', probe: {
          writeInside: true, readOutsideDenied: true, writeOutsideDenied: true, networkDenied: true, nodeChildWorks: true } } }; } });
    const lowerCalls = [], verify = f.app.sourceRepairs.verifyReadOnlyTests.bind(f.app.sourceRepairs);
    f.app.sourceRepairs.verifyReadOnlyTests = async (input, context) => { lowerCalls.push({ operationId: input.operationId, existingOnly: context.existingOnly }); return verify(input, context); };
    f.settings({ sourceRead: true });
    const turn = await f.message(), task = turn.assistant.maintenanceTask;
    const args = { action: 'verify', taskId: task.id, expectedRevision: task.revision, operationId: 'freshness-once', files: [tracked[1]] };
    const passed = await f.call('maintenance.experiment', args, turn);
    assert.equal(passed.task.status, 'verified', JSON.stringify(passed.experiment)); assert.equal(passed.experiment.status, 'pass'); assert.equal(executions, 1);
    await writeFile(join(sourceRoot, tracked[0]), 'export const value = 2; // external edit after verification\n');
    const request = action === 'same-admission' ? { ...args, expectedRevision: passed.task.revision }
      : { action, taskId: task.id, experimentId: passed.experiment.id };
    const stale = await f.call('maintenance.experiment', request, turn);
    assert.equal(stale.experiment.id, passed.experiment.id); assert.equal(stale.experiment.status, 'stale');
    assert.equal(stale.experiment.sourceMatchesSnapshot, false); assert.equal(stale.task.status, 'waiting_continue');
    assert.equal(executions, 1, 'freshness must use the original persisted receipt rather than start another sandbox run');
    assert.equal(lowerCalls.length, 2); assert.equal(lowerCalls[1].existingOnly, true);
    assert.equal(lowerCalls[1].operationId, lowerCalls[0].operationId, 'the engine receives the original lower-layer operation ID');
    assert.equal(f.app.assistantPermissionSettings.get().supervisor.sourceRepair, false); f.unchanged();
  });
});

test('stopping the originating turn cancels only its isolated experiment and keeps a stopped receipt', async t => {
  const f = await fixture(t); let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.assistant.maintenance.reproduce = async (_app, _input, { signal }) => {
    entered(); await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    return { status: 'cancelled', sandbox: { kind: 'fixture-only', status: 'verified' } };
  };
  f.reply = async source => ({ tool: 'maintenance.experiment', arguments: { action: 'reproduce', taskId: source.maintenanceTask.id,
    expectedRevision: source.maintenanceTask.revision, operationId: 'stop-in-flight', nodeId: 'local-node' } });
  const response = await f.assistant.message({ clientMessageId: 'human-stop', text: '请排查故障并保留原工作流', context: { workflowId: f.saved.id } }, f.topic);
  await started;
  const sourceTurn = f.assistant.readTurn(response.turn.id, f.topic);
  const { task } = await f.call('maintenance.task', { action: 'inspect' }, sourceTurn);
  assert.equal(task.status, 'running');
  await assert.rejects(f.assistant.action(sourceTurn.id, { action: 'stop-maintenance', taskId: task.id, expectedRevision: task.revision + 1 }, f.topic), { httpStatus: 409 });
  const otherTopic = f.assistant.createConversation({ clientConversationId: 'stop-foreign', title: '其它停止入口' }).conversation.id;
  await assert.rejects(f.assistant.action(sourceTurn.id, { action: 'stop-maintenance', taskId: task.id, expectedRevision: task.revision }, otherTopic), { httpStatus: 404 });
  await f.assistant.action(sourceTurn.id, { action: 'stop-maintenance', taskId: task.id, expectedRevision: task.revision }, f.topic);
  const stopped = await until(() => f.assistant.readTurn(sourceTurn.id, f.topic), terminal);
  assert.equal(stopped.status, 'interrupted');
  assert.equal(stopped.assistant.maintenanceTask?.status, 'stopped', 'the original chat must retain its stopped maintenance card');
  const receipt = await f.call('maintenance.experiment', { action: 'status', taskId: task.id }, stopped);
  assert.equal(receipt.task.status, 'stopped'); assert.equal(receipt.experiment.status, 'cancelled');
  assert.equal(f.app.assistantPermissionSettings.get().supervisor.sourceRepair, false); f.unchanged();
});

test('a persisted in-flight crash becomes unknown on restart and cannot replay or continue its execution', async t => {
  const f = await fixture(t), turn = await f.message(), task = turn.assistant.maintenanceTask;
  f.assistant.maintenance.reproduce = async () => ({ status: 'unknown', sandbox: { kind: 'fixture-only', status: 'verified' } });
  const result = await f.call('maintenance.experiment', { action: 'reproduce', taskId: task.id, expectedRevision: task.revision,
    operationId: 'crash-admission', nodeId: 'local-node' }, turn);
  // Fault injection represents a process crash after durable admission but
  // before a terminal receipt; assertions below use the real public broker.
  const db = f.app.store.db;
  const experimentRow = JSON.parse(db.prepare('SELECT value FROM assistant_maintenance_experiments WHERE id=?').get(result.experiment.id).value);
  experimentRow.status = 'running'; experimentRow.result = null;
  db.prepare('UPDATE assistant_maintenance_experiments SET value=? WHERE id=?').run(JSON.stringify(experimentRow), experimentRow.id);
  const taskRow = JSON.parse(db.prepare('SELECT value FROM assistant_maintenance_tasks WHERE id=?').get(task.id).value);
  taskRow.status = 'running'; db.prepare('UPDATE assistant_maintenance_tasks SET value=? WHERE id=?').run(JSON.stringify(taskRow), task.id);
  await f.restart(); let reruns = 0;
  f.assistant.maintenance.reproduce = async () => { reruns++; throw Error('must never replay an unknown admission'); };
  const readback = await f.call('maintenance.experiment', { action: 'status', taskId: task.id }, turn);
  assert.equal(readback.task.status, 'unknown'); assert.equal(readback.experiment.status, 'unknown');
  await assert.rejects(f.call('maintenance.experiment', { action: 'reproduce', taskId: task.id, expectedRevision: readback.task.revision,
    operationId: 'do-not-replay', nodeId: 'local-node' }, turn), { httpStatus: 409 });
  await assert.rejects(f.call('maintenance.task', { action: 'continue', taskId: task.id, expectedRevision: readback.task.revision }, turn), { httpStatus: 409 });
  const callsBefore = f.calls.length;
  const followup = await f.message({ text: '继续这个未知任务并核对原回执', context: { maintenanceTaskId: task.id } });
  assert.equal(followup.status, 'error'); assert.match(followup.assistant.text, /结果未确认|不能重放/);
  assert.equal(f.calls.length, callsBefore + 1); assert.equal(f.calls.at(-1).classification, true);
  assert.equal(reruns, 0); f.unchanged();
});

test('isolated artifact readback verifies its registered identity and refuses changed bytes or symlink escape', async t => {
  const f = await fixture(t), turn = await f.message(), task = turn.assistant.maintenanceTask;
  const bytes = Buffer.from('fixture-result\n'); let artifactPath;
  f.assistant.maintenance.reproduce = async (_app, _input, { directory }) => {
    await mkdir(directory, { recursive: true }); artifactPath = join(directory, 'result.txt'); await writeFile(artifactPath, bytes);
    return { status: 'passed', snapshotHash: 'sha256:' + 'b'.repeat(64), sandbox: { kind: 'fixture-only', status: 'verified' },
      artifacts: [{ name: 'result.txt', relativePath: 'result.txt', size: bytes.length, sha256: hash(bytes) }] };
  };
  const result = await f.call('maintenance.experiment', { action: 'reproduce', taskId: task.id, expectedRevision: task.revision,
    operationId: 'artifact-fixture', nodeId: 'local-node' }, turn);
  const artifact = result.experiment.artifacts[0];
  const readback = await f.assistant.maintenance.artifact(result.experiment.id, artifact.id);
  assert.deepEqual(readback.bytes, bytes); assert.equal(readback.name, 'result.txt');
  await assert.rejects(f.assistant.maintenance.artifact(result.experiment.id, 'not-registered'), { httpStatus: 404 });
  await writeFile(artifactPath, Buffer.alloc(bytes.length, 120));
  await assert.rejects(f.assistant.maintenance.artifact(result.experiment.id, artifact.id), { httpStatus: 409 });
  const outside = join(f.directory, 'outside.txt'); await writeFile(outside, bytes); await rm(artifactPath); await symlink(outside, artifactPath);
  await assert.rejects(f.assistant.maintenance.artifact(result.experiment.id, artifact.id), { httpStatus: 403 });
  assert.deepEqual(await readFile(outside), bytes); f.unchanged();
});

test('revoking permission during artifact readback rejects the broker result before any image can be returned', async t => {
  const f = await fixture(t), turn = await f.message(), task = turn.assistant.maintenanceTask;
  const bytes = Buffer.from('fixture image bytes, not a visual acceptance');
  f.assistant.maintenance.reproduce = async (_app, _input, { directory }) => {
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'poster.png'), bytes);
    return { status: 'passed', sandbox: { kind: 'fixture-only', status: 'verified' },
      artifacts: [{ name: 'poster.png', relativePath: 'poster.png', size: bytes.length, sha256: hash(bytes) }] };
  };
  const result = await f.call('maintenance.experiment', { action: 'reproduce', taskId: task.id, expectedRevision: task.revision,
    operationId: 'image-readback-permission', nodeId: 'local-node' }, turn);
  const artifact = result.experiment.artifacts[0], original = f.assistant.maintenance.artifact.bind(f.assistant.maintenance);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.assistant.maintenance.artifact = async (...args) => { entered(); await gate; return original(...args); };
  const pending = f.call('maintenance.experiment', { action: 'read-output', taskId: task.id, experimentId: result.experiment.id, artifactId: artifact.id }, turn);
  await started; f.settings({ workspaceRead: false }); release();
  let returned = false;
  await assert.rejects(pending.then(value => { returned = true; return value; }), { httpStatus: 409 });
  assert.equal(returned, false, 'even an already-read image must not escape a revoked permission scope');
  assert.equal(f.app.assistantPermissionSettings.get().supervisor.sourceRepair, false); f.unchanged();
});

test('a new applied source epoch invalidates a prior verified task until fresh verification', async t => {
  const f = await fixture(t), turn = await f.message(), task = turn.assistant.maintenanceTask;
  f.settings({ sourceRead: true });
  f.app.sourceRepairs.verifyReadOnlyTests = async () => ({ status: 'pass', sourceMatchesSnapshot: true,
    snapshotHash: 'sha256:' + 'c'.repeat(64), sandbox: { kind: 'fixture-only', status: 'verified' } });
  const verified = await f.call('maintenance.experiment', { action: 'verify', taskId: task.id, expectedRevision: task.revision,
    operationId: 'verify-before-patch', files: ['workbench/test/application-maintenance.test.mjs'] }, turn);
  assert.equal(verified.task.status, 'verified');
  // Inject the trusted dispatcher receipt; this fixture does not write source
  // or acquire sourceRepair merely to test how maintenance consumes a receipt.
  const context = { ...await f.context(turn), maintenanceTaskId: task.id };
  f.assistant.maintenance.observe(context, 'app.source.patch', { operationId: 'new-source-epoch' }, {
    status: 'applied', operationId: 'new-source-epoch', files: [{ path: 'workbench/src/fixture.mjs', afterHash: 'sha256:' + 'd'.repeat(64) }] });
  const invalidated = await f.call('maintenance.task', { action: 'inspect', taskId: task.id }, turn);
  assert.equal(invalidated.task.status, 'ready'); assert.equal(invalidated.task.stage, 'verify');
  assert(invalidated.task.revision > verified.task.revision); assert.match(invalidated.task.note, /重新验证/);
  assert.equal(f.assistant.get(f.topic).conversation.turns.find(item => item.id === turn.id).assistant.maintenanceTask.status, 'ready');
  assert.equal(f.app.assistantPermissionSettings.get().supervisor.sourceRepair, false); f.unchanged();
});

test('current workflow or application-log read revocation disables continue while the human stop action remains available', async t => {
  for (const permission of ['workflowRead', 'appLogs']) await t.test(permission, async sub => {
    const f = await fixture(sub), turn = await f.message(), task = turn.assistant.maintenanceTask;
    assert.equal(task.canContinue, true); f.settings({ [permission]: false });
    const projected = f.assistant.get(f.topic).conversation.turns.find(item => item.id === turn.id).assistant.maintenanceTask;
    assert.equal(projected.canContinue, false); assert.equal(projected.canStop, true);
    await f.assistant.action(turn.id, { action: 'stop-maintenance', taskId: task.id, expectedRevision: projected.revision }, f.topic);
    const stopped = f.assistant.get(f.topic).conversation.turns.find(item => item.id === turn.id).assistant.maintenanceTask;
    assert.equal(stopped.status, 'stopped'); assert.equal(stopped.canStop, false);
    assert.equal(f.app.assistantPermissionSettings.get().supervisor.sourceRepair, false); f.unchanged();
  });
});

test('a new evidence key still advances progress at the forty-entry cap and starts the next bounded segment', async t => {
  const f = await fixture(t, { maxCalls: 1 }), first = await f.message(), task = first.assistant.maintenanceTask;
  const context = { ...await f.context(first), maintenanceTaskId: task.id };
  // Seed forty prior read-only receipt identities without executing logs or
  // loading their bodies into the fixture's model context.
  for (let afterId = 0; afterId < 40; afterId++) f.assistant.maintenance.observe(context, 'app.logs', { afterId, limit: 1 }, { status: 'observed' });
  const before = f.assistant.maintenance.read(task.id);
  assert.equal(before.evidence.length, 40); assert.equal(before.evidenceVersion, 40);
  let decisions = 0;
  f.reply = async () => {
    decisions++;
    return decisions === 1 ? { tool: 'page.inspect', arguments: {} }
      : { text: decisions === 2 ? '新增界面证据，继续下一段核对。' : '已保留新增证据，仍未证明修复。' };
  };
  const continued = await f.message({ text: '继续该维护任务', context: { maintenanceTaskId: task.id }, page: { route: '#/board' } });
  assert.equal(continued.status, 'complete'); assert.equal(decisions, 3);
  assert.equal(continued.assistant.maintenanceTask.segment, 2); assert.equal(continued.assistant.maintenanceTask.evidenceCount, 40);
  const after = f.assistant.maintenance.read(task.id);
  assert.equal(after.evidence.length, 40); assert.equal(after.evidenceVersion, 41); assert.equal(after.evidence.at(-1).tool, 'page.inspect');
  assert.equal(f.calls.filter(call => call.classification).length, 2); f.unchanged();
});

test('a failed isolated candidate feeds the next real planner and only a corrected candidate passing isolation is delivered', async t => {
  const f = await fixture(t), errorCode = 'FIXTURE_FIRST_CANDIDATE_FAILURE';
  const candidateCodes = [`throw new Error('${errorCode}');`, 'return { repaired: input };'];
  let decisions = 0, proposals = 0, workflowSaves = 0, workflowRuns = 0;
  const experiments = [], plannerSources = [];
  const save = f.app.workflowLibrary.save.bind(f.app.workflowLibrary);
  f.app.workflowLibrary.save = (...args) => { workflowSaves++; return save(...args); };
  f.app.workflows.start = async () => { workflowRuns++; throw Error('candidate validation must never start the original workflow'); };
  f.reply = async (_source, prompt) => {
    decisions++;
    assert(decisions <= 2, 'the corrected candidate should be delivered immediately after its successful isolated verification');
    if (decisions === 2) assert.match(prompt, new RegExp(errorCode), 'the next model decision must see the real first experiment failure');
    return { tool: 'workflow.propose', arguments: { workflowId: f.saved.id,
      request: decisions === 1 ? '准备最小节点代码修复候选，保留原工作流' : '根据刚才的隔离失败修正核心代码，保留原工作流' } };
  };
  f.proposalReply = async source => {
    plannerSources.push(source); proposals++;
    if (proposals === 2) {
      const failure = source.diagnosticEvidence.find(row => row.tool === 'maintenance.experiment');
      assert(failure, 'the real proposeWorkflow must forward isolated experiment evidence into the actual planner');
      assert.match(failure.summary, new RegExp(errorCode));
    }
    return { text: proposals === 1 ? '第一版代码候选，等待隔离验证。' : '已依据隔离错误准备第二版代码候选。',
      operations: [{ op: 'update-node', nodeId: 'local-node', config: { code: candidateCodes[proposals - 1] } }] };
  };
  f.assistant.maintenance.reproduce = async (_app, input, { directory, trustedCandidate }) => {
    assert.equal(input.snapshot.workflowId, f.saved.id); assert.deepEqual(input.snapshot.nodeIds, ['local-node']);
    assert(trustedCandidate?.document, 'candidate validation must use the real recordCandidate document');
    const index = experiments.length, candidate = trustedCandidate.document;
    assert.equal(candidate.nodes.find(node => node.id === 'local-node').config.code, candidateCodes[index]);
    const candidateHash = 'sha256:' + hash(JSON.stringify(candidate));
    experiments.push({ id: basename(directory), candidateHash });
    return { status: index === 0 ? 'failed' : 'passed', candidateHash,
      sandbox: { kind: 'fixture-only', status: 'verified' },
      ...(index === 0 ? { code: errorCode } : {}),
      nodeResults: [{ nodeId: 'local-node', status: index === 0 ? 'failed' : 'passed', ...(index === 0 ? { errorCode } : {}) }],
      logs: { stderr: index === 0 ? 'Synthetic first-candidate execution error: ' + errorCode : '' } };
  };
  const turn = await f.message({ text: '请诊断并修复这个节点，先隔离验证候选，保留原工作流' });
  assert.equal(turn.status, 'proposed', JSON.stringify({ status: turn.status, text: turn.assistant.text }));
  assert.equal(decisions, 2); assert.equal(proposals, 2); assert.equal(experiments.length, 2);
  assert.notEqual(experiments[0].id, experiments[1].id); assert.notEqual(experiments[0].candidateHash, experiments[1].candidateHash);
  for (const experiment of experiments) assert.equal(f.assistant.maintenance.readExperiment(experiment.id).result.candidateHash, experiment.candidateHash);
  assert.equal(turn.assistant.operations[0].config.code, candidateCodes[1]);
  assert.equal(turn.assistant.validation.isolated.status, 'passed'); assert.equal(turn.assistant.validation.isolated.id, experiments[1].id);
  assert.equal(turn.assistant.maintenanceTask.status, 'candidate_verified');
  assert.equal(plannerSources[1].diagnosticEvidence.some(row => row.tool === 'maintenance.experiment' && row.summary.includes(errorCode)), true);
  assert.equal(f.calls.filter(call => call.classification).length, 1); assert.equal(f.calls.filter(call => call.proposal).length, 2);
  assert.equal(workflowSaves, 0); assert.equal(workflowRuns, 0);
  assert.equal(f.app.assistantPermissionSettings.get().supervisor.sourceRepair, false); f.unchanged();
});

test('interrupt-turn also stops its linked maintenance experiment without approving or running the source workflow', async t => {
  const f = await fixture(t); let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.assistant.maintenance.reproduce = async (_app, _input, { signal }) => {
    entered(); await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true }));
    return { status: 'cancelled', sandbox: { kind: 'fixture-only', status: 'verified' } };
  };
  f.reply = async source => ({ tool: 'maintenance.experiment', arguments: { action: 'reproduce', taskId: source.maintenanceTask.id,
    expectedRevision: source.maintenanceTask.revision, operationId: 'interrupt-linked-experiment', nodeId: 'local-node' } });
  const response = await f.assistant.message({ clientMessageId: 'human-interrupt', text: '请排查故障，保留原工作流', context: { workflowId: f.saved.id } }, f.topic);
  await started;
  await f.assistant.action(response.turn.id, { action: 'interrupt-turn' }, f.topic);
  const turn = await until(() => f.assistant.readTurn(response.turn.id, f.topic), terminal);
  assert.equal(turn.status, 'interrupted'); assert.equal(turn.assistant.maintenanceTask.status, 'stopped');
  const result = await f.call('maintenance.experiment', { action: 'status', taskId: turn.assistant.maintenanceTask.id }, turn);
  assert.equal(result.experiment.status, 'cancelled'); assert.equal(result.task.canContinue, false);
  assert.equal(f.app.assistantPermissionSettings.get().supervisor.sourceRepair, false); f.unchanged();
});
