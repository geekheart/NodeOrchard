import test from 'node:test';
import assert from 'node:assert/strict';
import { bindArtifactRevisionProposal, assertArtifactRevisionCodeChange } from '../src/workflows/workflow-review-proposals.mjs';

const copy = value => structuredClone(value);
function fixture() {
  const document = { id: 'workflow-fixture', mode: 'execute', nodes: [
    { id: 'producer', title: '生成示例文件', type: 'tool', config: { executionMode: 'code', language: 'javascript', code: 'return input;', timeoutSeconds: 30 } },
    { id: 'review', title: '审核示例文件', type: 'human', config: { reviewTargetNodeId: 'producer', maxRevisions: 3 } },
  ], edges: [{ sourceNode: 'producer', targetNode: 'review' }] };
  const hashes = [{ id: 'artifact-a', sha256: 'a'.repeat(64) }, { id: 'artifact-b', sha256: 'b'.repeat(64) }];
  const run = { id: 'run-fixture', workflowId: document.id, status: 'waiting_review', document: copy(document), nodes: {
    producer: { status: 'complete', attempt: 4, attemptId: 'producer-attempt-4', input: 'private input', output: 'private output', logs: { stdout: 'private log' } },
    review: { status: 'waiting_review', attempt: 4, attemptId: 'review-attempt-4', review: { revisionCount: 3 },
      artifacts: hashes.map(item => ({ ...item, path: '/private/fixture/' + item.id, nodeId: 'producer', attempt: 4 })) },
  } };
  const request = { runId: run.id, humanNodeId: 'review', attempt: 4, attemptId: 'review-attempt-4', artifactHashes: copy(hashes), targetNodeId: 'producer' };
  const app = { workflows: { get(id) { assert.equal(id, run.id); return run; } } };
  return { app, document, run, request, hashes };
}

test('a repeatedly revised fixed-code review binds a complete proposal without changing the run, draft or request', () => {
  const f = fixture(), before = copy({ run: f.run, document: f.document, request: f.request });
  const bound = bindArtifactRevisionProposal(f.app, f.document.id, f.document, f.request);
  assert.deepEqual(bound, { request: f.request,
    context: { runId: 'run-fixture', nodeId: 'review', attempt: 4, attemptId: 'review-attempt-4', artifactIds: ['artifact-a', 'artifact-b'], artifactHashes: f.hashes },
    target: { id: 'producer', title: '生成示例文件', type: 'tool' }, sourceAttempt: { attempt: 4, attemptId: 'producer-attempt-4' } });
  assert.deepEqual({ run: f.run, document: f.document, request: f.request }, before);
  bound.request.artifactHashes[0].sha256 = 'c'.repeat(64);
  bound.context.artifactHashes[1].sha256 = 'd'.repeat(64);
  assert.deepEqual({ run: f.run, document: f.document, request: f.request }, before);
});

test('tool revisions require changed executable code rather than a rename, timeout edit or identical source', () => {
  const f = fixture();
  for (const mutate of [
    node => { node.title = '新标题'; },
    node => { node.config.timeoutSeconds = 60; },
    node => { node.config.code = '\r\nreturn input;\r\n'; },
    node => { node.config.executionMode = 'tool'; node.config.toolName = 'text.trim'; },
  ]) {
    const candidate = copy(f.document); mutate(candidate.nodes[0]);
    assert.throws(() => assertArtifactRevisionCodeChange(f.document, candidate, 'producer'), /未生成实际.*代码修改/);
  }
  const candidate = copy(f.document); candidate.nodes[0].config.code = 'return String(input).toUpperCase();';
  assert.doesNotThrow(() => assertArtifactRevisionCodeChange(f.document, candidate, 'producer'));
});

test('proposal binding rejects stale reviews, incomplete hashes and a different workflow or draft target', () => {
  for (const change of [
    f => { f.request.attempt = 3; },
    f => { f.request.attemptId = 'old-review-attempt'; },
    f => { f.request.artifactHashes[0].sha256 = 'c'.repeat(64); },
    f => { f.request.artifactHashes.pop(); },
    f => { f.request.artifactHashes.push({ id: 'artifact-c', sha256: 'c'.repeat(64) }); },
    f => { f.run.workflowId = 'different-workflow'; },
    f => { f.run.document.id = 'different-workflow'; },
    f => { f.document.id = 'different-workflow'; },
    f => { f.run.parentRunId = 'parent-run'; },
    f => { f.run.learningId = 'learning-batch'; },
    f => { f.run.memoryScopeId = 'learning-memory'; },
    f => { f.run.importedArchive = true; },
    f => { f.run.document.mode = 'learn'; },
    f => { f.document.mode = 'learn'; },
    f => { f.run.nodes.review.status = 'complete'; },
    f => { f.run.document.nodes[1].type = 'output'; },
    f => { f.request.targetNodeId = 'review'; },
    f => { f.document.nodes.shift(); },
    f => { f.document.nodes[0].type = 'transform'; },
    f => { f.document.nodes[0].config.code = 'return "changed draft";'; },
    f => { f.run.document.edges = []; },
    f => { f.run.document.nodes[0].type = 'skill'; },
  ]) {
    const f = fixture(); change(f);
    const before = copy({ run: f.run, document: f.document, request: f.request });
    assert.throws(() => bindArtifactRevisionProposal(f.app, 'workflow-fixture', f.document, f.request), error => error.httpStatus === 409);
    assert.deepEqual({ run: f.run, document: f.document, request: f.request }, before);
  }
});

test('proposal requests reject unknown fields, prototypes, accessors and malformed identities before reading a run', () => {
  let getterReads = 0;
  const changes = [
    request => ({ ...request, feedback: 'this belongs in message.text' }),
    request => ({ ...request, role: 'supervisor' }),
    request => { delete request.attemptId; return request; },
    request => Object.assign(Object.create({ inherited: true }), request),
    request => { request[Symbol('hidden')] = true; return request; },
    request => Object.defineProperty(request, 'runId', { get() { getterReads++; return 'run-fixture'; } }),
    request => ({ ...request, runId: '../different-run' }),
    request => ({ ...request, humanNodeId: 'constructor' }),
    request => ({ ...request, targetNodeId: '' }),
    request => ({ ...request, attemptId: null }),
    request => ({ ...request, attempt: 0 }),
    request => ({ ...request, attempt: 1.5 }),
    request => ({ ...request, artifactHashes: null }),
    request => { request.artifactHashes[0].sha256 = 'BAD'; return request; },
    request => { request.artifactHashes[0].sha256 = { toString() { getterReads++; return 'a'.repeat(64); } }; return request; },
    request => { request.artifactHashes[0].id = 'prototype'; return request; },
    request => { request.artifactHashes[0].path = '/private/path'; return request; },
    request => { request.artifactHashes[0] = Object.assign(Object.create({ inherited: true }), request.artifactHashes[0]); return request; },
    request => { Object.defineProperty(request.artifactHashes[0], 'sha256', { get() { getterReads++; return 'a'.repeat(64); } }); return request; },
    request => { request.artifactHashes[1] = copy(request.artifactHashes[0]); return request; },
    request => { request.artifactHashes.extra = 'unknown'; return request; },
    request => { delete request.artifactHashes[0]; return request; },
    request => { Object.defineProperty(request.artifactHashes, '0', { get() { getterReads++; return { id: 'artifact-a', sha256: 'a'.repeat(64) }; } }); return request; },
  ];
  for (const change of changes) {
    const f = fixture(), request = change(f.request);
    f.app.workflows.get = () => assert.fail('Malformed metadata must not read a run');
    assert.throws(() => bindArtifactRevisionProposal(f.app, f.document.id, f.document, request), error => error.httpStatus === 400);
  }
  assert.equal(getterReads, 0);
});
