import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createDocument, createNode } from '../shared/workflow/workflow-model.mjs';
import { prepareImportedWorkflowRecords } from '../src/workflows/workflow-package-records.mjs';
import { buildConversationContext } from '../src/workflows/workflow-conversation-context.mjs';

const ARTIFACT = '11111111-1111-4111-8111-111111111111', SHA = 'a'.repeat(64), INPUT_SHA = 'b'.repeat(64);
function fixture() {
  const child = createDocument({ schemaVersion: 2, title: '嵌入子图' }); child.id = 'workflow-child';
  const document = createDocument({ schemaVersion: 2, title: '原工作流' }); document.id = 'workflow-source'; document.settings.outputDirectory = '/old/external';
  document.nodes = [createNode('input', {}, { id: 'input', config: { outputType: 'object', fields: [
    { key: 'asset', label: '资料', kind: 'file' }, { key: 'missing', label: '缺失资料', kind: 'file', required: false },
    { key: 'notes', label: '备注', kind: 'text' }], defaultValue: { asset: '/old/input.txt', missing: '/old/missing.txt', notes: '保留 /old/input.txt 原文' } } }),
  createNode('tool', {}, { id: 'worker', config: { executionMode: 'code', code: 'return "/old/input.txt";' } }),
  createNode('subflow', {}, { id: 'child', config: { document: child, workflowRef: child.id } }),
  createNode('human', {}, { id: 'review', config: { reviewTargetNodeId: 'worker', prompt: '保留 /old/input.txt 提示' } })];
  const artifact = { id: ARTIFACT, artifactId: ARTIFACT, runId: 'run-source', nodeId: 'worker', attempt: 1,
    path: '/old/run/worker/poster.svg', sha256: SHA, size: 4, previewUrl: '/api/workflow-v2/artifacts/' + ARTIFACT,
    downloadUrl: '/api/workflow-v2/artifacts/' + ARTIFACT + '?download=1' };
  const run = { schemaVersion: 2, id: 'run-source', workflowId: document.id, document: structuredClone(document), status: 'waiting_review',
    input: { asset: '/old/input.txt' }, outputDirectory: '/old/run', sessionId: 'source-session', modelSessionId: 'source-model-session',
    activeNodeIds: ['review'], currentNodeId: 'review', trigger: { type: 'schedule', scheduleId: 'source-schedule' },
    nodes: { input: { status: 'complete', attempt: 1, attemptId: 'old-input-attempt', output: { path: '/old/input.txt', sha256: INPUT_SHA } },
      worker: { status: 'complete', attempt: 1, attemptId: 'old-worker-attempt', sessionId: 'source-worker-session', outputDirectory: '/old/run/worker',
        artifacts: [artifact], logs: { stdout: 'stdout /old/run stays text', stderr: '' }, history: [] },
      review: { status: 'waiting_review', attempt: 1, attemptId: 'old-review-attempt', artifacts: [artifact],
        review: { decision: 'revision_requested', revisionCount: 3, childRunId: 'run-child', artifactHashes: [{ id: ARTIFACT, sha256: SHA }] } } } };
  const childRun = { schemaVersion: 2, id: 'run-child', parentRunId: run.id, workflowId: child.id, document: child, status: 'complete', nodes: {}, sessionId: 'child-session' };
  const conversation = { version: 1, workflowId: document.id, revision: 2, turns: [{ id: 'turn-source', clientMessageId: 'message-source', workflowId: document.id,
    status: 'proposed', user: { text: '全文 /old/input.txt 不得重写', intent: 'feedback', context: { runId: run.id }, revisionRequest: { runId: run.id } },
    assistant: { text: '完整回复正文', operations: [{ op: 'remove-node', nodeId: 'worker' }], checkpoint: { mutationReceipts: ['do-not-replay'] }, revisionProposals: [{ context: { runId: run.id } }] },
    actions: [{ kind: 'review-approve', context: { runId: run.id } }], outcome: { action: 'mark-applied' }, modelSessionId: 'chat-session',
    privateValue: { document, requestDigest: 'old-digest', readOnly: false }, createdAt: '2026-10-27T01:00:00.000Z', updatedAt: '2026-10-27T01:00:01.000Z' }] };
  return { sourceWorkflowId: document.id, targetWorkflowId: 'workflow-imported', directory: '/new/workflows/workflow-imported', document, conversation,
    runs: [run, childRun], fileRuns: [{ runId: run.id, workflowId: document.id, outputDirectory: '/old/run', input: { asset: '/old/input.txt' },
      manifest: { version: 1, workflowId: document.id, entries: [{ path: '/old/input.txt', sha256: INPUT_SHA, kind: 'file' }] } }], artifacts: [artifact],
    files: { entries: [{ source: '/old/input.txt', path: 'inputs/input.txt', sha256: INPUT_SHA, size: 5, kind: 'input' },
      { source: artifact.path, path: 'runs/run-source/worker/poster.svg', sha256: SHA, size: 4, kind: 'artifact', runId: run.id }],
    directories: [{ source: '/old/run', path: 'runs/run-source' }] } };
}

test('portable records rebuild identities and paths while retaining immutable source objects and opaque text', () => {
  const f = fixture(), before = structuredClone(f), result = prepareImportedWorkflowRecords(f);
  assert.deepEqual(f, before); assert.equal(result.document.id, f.targetWorkflowId); assert.equal(result.document.settings.outputDirectory, '');
  const input = result.document.nodes[0].config.defaultValue;
  assert.equal(input.asset, join(f.directory, 'inputs/input.txt')); assert.equal(input.missing, ''); assert.equal(input.notes, before.document.nodes[0].config.defaultValue.notes);
  assert.equal(result.document.nodes[1].config.code, before.document.nodes[1].config.code); assert.equal(result.document.nodes[3].config.prompt, before.document.nodes[3].config.prompt);
  const embedded = result.document.nodes[2].config.document;
  assert.notEqual(embedded.id, 'workflow-child'); assert.equal(result.document.nodes[2].config.workflowRef, embedded.id);
  const run = result.runs.find(row => row.sourceRunId === 'run-source'), child = result.runs.find(row => row.sourceRunId === 'run-child');
  assert.notEqual(run.id, 'run-source'); assert.equal(run.workflowId, f.targetWorkflowId); assert.equal(child.workflowId, embedded.id); assert.equal(child.parentRunId, run.id);
  assert.equal(run.status, 'interrupted'); assert.equal(run.originalStatus, 'waiting_review'); assert.equal(run.importedArchive, true);
  assert.equal(child.status, 'complete'); assert.equal(run.nodes.review.status, 'interrupted'); assert.equal(run.nodes.review.review.decision, 'imported');
  assert.equal(run.nodes.worker.logs.stdout, before.runs[0].nodes.worker.logs.stdout); assert.notEqual(run.nodes.worker.attemptId, 'old-worker-attempt');
  assert.equal(run.sessionId, undefined); assert.equal(run.nodes.worker.sessionId, undefined); assert.equal(run.trigger, undefined); assert.deepEqual(run.activeNodeIds, []);
  const artifact = result.artifacts[0]; assert.match(artifact.id, /^[a-f0-9-]{36}$/); assert.notEqual(artifact.id, ARTIFACT);
  assert.equal(artifact.runId, run.id); assert.equal(artifact.path, join(f.directory, 'runs/run-source/worker/poster.svg')); assert(artifact.previewUrl.endsWith(artifact.id));
  assert.equal(run.nodes.worker.artifacts[0].id, artifact.id); assert.equal(result.fileRuns[0].runId, run.id); assert.equal(result.fileRuns[0].manifest.workflowId, f.targetWorkflowId);
  assert.equal(result.fileRuns[0].outputDirectory, join(f.directory, 'runs/run-source')); assert(result.warnings.some(text => /输入|资料/.test(text)));
});

test('portable records preserve derived node identity and its pinned parent when rebuilding workflow identities', () => {
  const f = fixture(), origin = { kind: 'preset', id: 'preset-weekly-summary', version: 2, title: '周报摘要', baseType: 'tool',
    parent: { kind: 'preset', id: 'preset-short-summary', version: 1, title: '简洁摘要', baseType: 'tool' } };
  f.document.nodes[1].origin = structuredClone(origin); f.runs[0].document.nodes[1].origin = structuredClone(origin);
  const result = prepareImportedWorkflowRecords(f);
  assert.notEqual(result.document.id, f.document.id);
  assert.deepEqual(result.document.nodes.find(node => node.type === 'tool').origin, origin);
  assert.deepEqual(result.runs[0].document.nodes.find(node => node.type === 'tool').origin, origin);
  assert.deepEqual(f.document.nodes[1].origin, origin);
});

test('chat preserves full text but cannot revive source candidate, review, retry or native session authority', () => {
  const f = fixture(), result = prepareImportedWorkflowRecords(f), { turn, privateValue } = result.turns[0];
  assert.notEqual(turn.id, 'turn-source'); assert.notEqual(turn.clientMessageId, 'message-source'); assert.equal(turn.workflowId, f.targetWorkflowId);
  assert.equal(turn.user.text, f.conversation.turns[0].user.text); assert.equal(turn.assistant.text, f.conversation.turns[0].assistant.text);
  assert.equal(turn.status, 'complete'); assert.deepEqual(turn.actions, []); assert.equal(turn.outcome, undefined); assert.deepEqual(turn.user.context, {});
  for (const key of ['operations', 'checkpoint', 'revisionProposals']) assert.equal(turn.assistant[key], undefined);
  assert.equal(turn.user.revisionRequest, undefined); assert.equal(turn.modelSessionId, undefined);
  assert.deepEqual(privateValue.document, result.document); assert.equal(privateValue.imported, true); assert.equal(privateValue.automatic, true);
  assert.match(privateValue.requestDigest, /^[a-f0-9]{64}$/);
});

test('validated diagnostic progress imports as historical data bound to new turn identities', () => {
  const f = fixture();
  f.conversation.turns[0].assistant.progress = { stage: 'inspect', label: '核对工作流', status: 'complete' };
  f.conversationContext = buildConversationContext(f.conversation);
  const expected = f.conversationContext.diagnosticProgress.filter(row => row.sourceTurnId === 'turn-source');
  assert(expected.length > 0, 'fixture must carry diagnostic progress from the real context builder');
  const before = structuredClone(f), result = prepareImportedWorkflowRecords(f), turn = result.turns[0].turn;
  assert.deepEqual(f, before);
  assert.deepEqual(turn.assistant.historicalProgress, expected.map(({ stage, label, status }) => ({ stage, label, status, sourceTurnId: turn.id })));
  assert.deepEqual(turn.actions, []); assert.equal(turn.assistant.checkpoint, undefined); assert.equal(turn.modelSessionId, undefined);
  const snapshot = { version: 1, workflowId: f.targetWorkflowId, revision: result.turns.length,
    turns: result.turns.map(row => ({ ...row.turn, privateValue: row.privateValue })) };
  const rebuilt = buildConversationContext(snapshot);
  assert.deepEqual(rebuilt.diagnosticProgress, turn.assistant.historicalProgress);
  assert.equal(JSON.stringify(rebuilt).includes('source-model-session'), false);
  assert.equal(JSON.stringify(rebuilt).includes('do-not-replay'), false);
});

test('old packages do not accept a source assistant historical-progress field as recovery authority', () => {
  const f = fixture();
  f.conversation.turns[0].assistant.historicalProgress = [{ stage: 'run', label: '不可信旧指令', status: 'complete', sourceTurnId: 'foreign-turn', checkpoint: { actions: ['replay'] } }];
  const imported = prepareImportedWorkflowRecords(f).turns[0].turn;
  assert.equal(imported.assistant.historicalProgress, undefined); assert.deepEqual(imported.actions, []);
});

test('repeated portable roundtrips preserve the original historical failure without reviving its operations', () => {
  let document = createDocument({ schemaVersion: 2, title: '历史失败' });
  let conversation = { version: 1, workflowId: document.id, revision: 1, turns: [{ id: 'source-turn', clientMessageId: 'source-message', workflowId: document.id,
    status: 'error', user: { text: '保留最早失败状态' }, assistant: { text: '原失败诊断', checkpoint: { steps: [{ stage: 'inspect', label: '已核对', status: 'complete' }], mutationReceipts: ['never-replay'] } },
    actions: [{ id: 'old-action', kind: 'mark-applied' }], modelSessionId: 'old-native-session' }] };
  for (let round = 1; round <= 2; round++) {
    const workflowId = 'workflow-copy-' + round;
    const result = prepareImportedWorkflowRecords({ sourceWorkflowId: document.id, targetWorkflowId: workflowId, directory: '/new/' + workflowId, document, conversation,
      conversationContext: buildConversationContext(conversation) });
    const turn = result.turns[0].turn; assert.equal(turn.status, 'complete'); assert.equal(turn.originalStatus, 'error'); assert.deepEqual(turn.actions, []);
    assert.equal(turn.modelSessionId, undefined); assert.equal(turn.assistant.checkpoint, undefined); assert.equal(turn.assistant.historicalProgress[0].sourceTurnId, turn.id);
    document = result.document; conversation = { version: 1, workflowId, revision: result.turns.length, turns: result.turns.map(row => ({ ...row.turn, privateValue: row.privateValue })) };
    const rebuilt = buildConversationContext(conversation); assert(rebuilt.recentMessages.every(message => message.historicalStatus === 'error')); assert.equal(rebuilt.resumePolicy, 'fresh-session');
  }
});

test('context revision, hash, turn scope and extra authority fields are rejected before progress import', () => {
  for (const mutate of [
    f => { f.conversationContext.workflowId = 'foreign-workflow'; },
    f => { f.conversationContext.conversationRevision++; },
    f => { f.conversationContext.conversationSha256 = '0'.repeat(64); },
    f => { f.conversationContext.diagnosticProgress[0].sourceTurnId = 'foreign-turn'; },
    f => { f.conversationContext.diagnosticProgress[0].sessionId = 'old-native-session'; },
    f => { f.conversationContext.permissionScope = { sourceRepair: true }; },
    f => { delete f.conversation.revision; },
  ]) {
    const f = fixture(); f.conversation.turns[0].assistant.progress = { stage: 'inspect', label: '核对工作流', status: 'complete' };
    f.conversationContext = buildConversationContext(f.conversation); mutate(f);
    assert.throws(() => prepareImportedWorkflowRecords(f), error => [400, 409, 413].includes(error.httpStatus));
  }
});

test('unknown ownership, incomplete artifact mappings, bad paths and aliasing metadata reject rather than cross workflows', () => {
  for (const mutate of [
    f => { f.runs[1].parentRunId = 'external-run'; }, f => { f.runs[1].workflowId = 'external-workflow'; },
    f => { f.artifacts[0].runId = 'external-run'; }, f => { f.artifacts[0].sha256 = 'c'.repeat(64); },
    f => { f.files.entries.pop(); }, f => { f.files.entries[0].path = '../outside'; },
    f => { f.files.entries[0].path = '/absolute'; }, f => { f.files.directories[0].path = 'C:/outside'; },
    f => { f.conversation.workflowId = 'external-workflow'; }, f => { f.conversation.turns[0].workflowId = 'external-workflow'; },
    f => { f.runs[1].parentRunId = f.runs[1].id; }, f => { f.runs.push(structuredClone(f.runs[0])); },
  ]) {
    const f = fixture(); mutate(f); assert.throws(() => prepareImportedWorkflowRecords(f), error => error.httpStatus === 400 || error.httpStatus === 413);
  }
});

test('learning sample runs and their descendants remain file-only and cannot enter execution indexes', () => {
  const f = fixture(); f.runs[0].learningId = 'learning-source';
  const result = prepareImportedWorkflowRecords(f);
  assert.deepEqual(result.runs, []); assert.deepEqual(result.fileRuns, []); assert.deepEqual(result.artifacts, []); assert(result.warnings.some(text => /学习/.test(text)));
});

test('foreign-machine Windows paths are mapped as data and callers can pin generated IDs without mutating a document', () => {
  const f = fixture(); f.document.nodes[0].config.defaultValue.asset = 'C:\\Users\\person\\input.txt'; f.files.entries[0].source = 'C:\\Users\\person\\input.txt';
  let counter = 0;
  const idFactory = prefix => prefix === 'artifact' ? '22222222-2222-4222-8222-222222222222' : `${prefix}-new-${++counter}`;
  const result = prepareImportedWorkflowRecords(f, { idFactory }); assert.equal(result.document.nodes[0].config.defaultValue.asset, join(f.directory, 'inputs/input.txt'));
  assert.equal(result.artifacts[0].id, '22222222-2222-4222-8222-222222222222');
  assert.throws(() => prepareImportedWorkflowRecords(f, { idFactory: () => 'same-id' }), /ID|编号|标识/);
});

test('archive terminalization covers queued resources, nested histories and delivery publishing', () => {
  const f = fixture(); f.runs[0].folderWorkflowId = f.sourceWorkflowId;
  f.runs[0].delivery = { status: 'publishing', directory: '/old/run' };
  f.runs[0].nodes.worker.status = 'waiting_resource';
  f.runs[0].nodes.worker.history = [{ status: 'ready', attempt: 1, outputDirectory: '/unpacked/history' }];
  const result = prepareImportedWorkflowRecords(f), run = result.runs[0];
  assert.equal(run.folderWorkflowId, f.targetWorkflowId); assert.equal(result.runs[1].folderWorkflowId, f.targetWorkflowId);
  assert.equal(run.nodes.worker.status, 'interrupted'); assert.equal(run.nodes.worker.history[0].status, 'interrupted');
  assert.equal(run.delivery.status, 'interrupted');
  assert.equal(run.nodes.worker.history[0].outputDirectory, join(run.outputDirectory, 'worker', '版本-1'));
  f.runs[0].folderWorkflowId = 'workflow-external'; assert.throws(() => prepareImportedWorkflowRecords(f), /归属|跨越/);
});

test('missing historical output mapping falls back to its own run files without admitting loose artifacts', () => {
  const f = fixture(); f.artifacts = []; f.files.directories = []; f.files.entries = f.files.entries.slice(0, 1);
  f.runs[0].nodes.worker.artifacts = []; f.runs[0].nodes.review.artifacts = []; delete f.runs[0].nodes.review.review.artifactHashes;
  const result = prepareImportedWorkflowRecords(f), run = result.runs[0];
  assert.equal(run.outputDirectory, join(f.directory, 'runs', run.id, 'files'));
  assert.equal(result.fileRuns[0].outputDirectory, run.outputDirectory);
  assert.equal(run.nodes.worker.outputDirectory, join(run.outputDirectory, 'worker', '版本-1'));
  const withLooseArtifact = fixture(); withLooseArtifact.files.directories = [];
  assert.throws(() => prepareImportedWorkflowRecords(withLooseArtifact), /运行目录映射/);
});

test('child scope is declared by its actual frozen parent and generated identities cannot reuse future source IDs', () => {
  const f = fixture(); f.runs[0].document.nodes = f.runs[0].document.nodes.filter(node => node.id !== 'child');
  assert.throws(() => prepareImportedWorkflowRecords(f), /父|子运行|嵌入/);
  const aliased = fixture();
  assert.throws(() => prepareImportedWorkflowRecords(aliased, { idFactory: () => 'turn-source' }), /编号|ID/);
  aliased.targetWorkflowId = 'workflow-child'; assert.throws(() => prepareImportedWorkflowRecords(aliased), /编号|ID/);
});

test('conversation import accepts more than 5000 turns and rejects excessive nesting', () => {
  const document = createDocument({ schemaVersion: 2, title: '长期会话' }); document.id = 'workflow-source';
  const source = { sourceWorkflowId: document.id, targetWorkflowId: 'workflow-new', directory: '/new/workflow-new', document,
    conversation: { version: 1, workflowId: document.id, turns: Array.from({ length: 5001 }, (_, index) => ({
      id: 'turn-' + index, clientMessageId: 'message-' + index, user: { text: '你好' }, assistant: { text: '收到' } })) } };
  const result = prepareImportedWorkflowRecords(source); assert.equal(result.turns.length, 5001);
  let nested = {}; for (let index = 0; index < 65; index++) nested = { nested };
  source.conversation.turns[0].privateValue = nested;
  assert.throws(() => prepareImportedWorkflowRecords(source), error => error.httpStatus === 413);
});

test('malformed record containers produce reviewable package errors', () => {
  for (const source of [null, [], 'invalid']) assert.throws(() => prepareImportedWorkflowRecords(source), error => error.httpStatus === 400);
  for (const key of ['runs', 'fileRuns', 'artifacts']) {
    const source = fixture(); source[key] = [null];
    assert.throws(() => prepareImportedWorkflowRecords(source), error => error.httpStatus === 400);
  }
});
