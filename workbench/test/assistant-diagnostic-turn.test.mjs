import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantDiagnosticTurn, diagnosticScope, diagnosticRequestKey } from '../src/assistant-diagnostic-turn.mjs';

const document = { id: 'workflow-current', schemaVersion: 2, nodes: [{ id: 'input', type: 'input', config: { defaultValue: 'current' } }], edges: [] };
const completedAt = '2026-10-27T00:01:00.000Z';
function evidence() {
  return { workflow: { available: true, workflowId: document.id, savedRevision: 3, source: 'current-draft', document: structuredClone(document) },
    run: { available: true, id: 'run-selected', workflowId: document.id, status: 'error', completedAt },
    latestRun: { id: 'run-latest', workflowId: document.id, status: 'complete', completedAt } };
}
function scope(value) {
  return diagnosticScope({ selection: { workflowId: document.id }, evidence: value, modelRoute: { model: 'fixture-model' }, capabilities: {}, tools: [] });
}
function resume(tool, args, result, { current = evidence(), collectedAt = new Date().toISOString(), savedScope = scope(current) } = {}) {
  const requestKey = diagnosticRequestKey(tool, args);
  const checkpoint = { version: 1, scope: savedScope, results: [{ tool, arguments: args, result, requestKey, collectedAt }] };
  return new AssistantDiagnosticTurn({ scope: scope(current), checkpoint, evidence: current }).transcript();
}

test('cross-turn workflow evidence cannot restore a different target absent from the current snapshot', () => {
  const args = { workflowId: 'workflow-other' };
  const result = { available: true, workflowId: 'workflow-other', savedRevision: 1, document: { ...document, id: 'workflow-other' } };
  assert.deepEqual(resume('workflow.inspect', args, result), []);
  assert.deepEqual(resume('workflow.run', { runId: 'run-other' }, { id: 'run-other', workflowId: document.id, status: 'error', completedAt }), []);
});

test('the current workflow can be reused only while its saved version and graph agree with the snapshot', () => {
  const current = evidence(), args = { workflowId: document.id };
  assert.equal(resume('workflow.inspect', args, current.workflow).length, 1);
  assert.deepEqual(resume('workflow.inspect', args, { ...current.workflow, savedRevision: 2 }), []);
  const changed = structuredClone(current.workflow); changed.document.nodes[0].config.defaultValue = 'stale draft';
  assert.deepEqual(resume('workflow.inspect', args, changed), []);
});

test('run reuse preserves explicit versus latest identity and verifies terminal completion metadata', () => {
  const current = evidence();
  assert.equal(resume('workflow.run', { runId: current.run.id }, current.run).length, 1);
  assert.equal(resume('workflow.run', { runSelection: 'latest' }, current.latestRun).length, 1);
  assert.deepEqual(resume('workflow.run', { runSelection: 'latest' }, current.run), []);
  assert.deepEqual(resume('workflow.run', { runId: current.run.id }, { ...current.run, completedAt: '2026-10-27T00:02:00.000Z' }), []);
  assert.deepEqual(resume('workflow.run', { runId: current.run.id }, { ...current.run, status: 'running' }), []);
});

test('session histories and native cached catalogs are read anew in the next turn', () => {
  assert.deepEqual(resume('session.history', { sessionId: 'ordinary-session' }, { available: true, sessionId: 'ordinary-session', messages: [] }), []);
  assert.deepEqual(resume('tools.catalog', {}, { hermesTools: [{ name: 'changed-tool' }] }), []);
});

test('static contracts and fixed runtime observations keep their own TTL and strict scope', () => {
  assert.equal(resume('node.describe', { type: 'tool' }, { type: 'tool' }).length, 1);
  assert.equal(resume('runtime.inspect', { language: 'python' }, { language: 'python', available: true }).length, 1);
  const expired = new Date(Date.now() - 61000).toISOString();
  assert.deepEqual(resume('runtime.inspect', { language: 'python' }, { language: 'python', available: true }, { collectedAt: expired }), []);
  assert.equal(resume('node.describe', { type: 'tool' }, { type: 'tool' }, { collectedAt: expired }).length, 1);
  assert.deepEqual(resume('node.describe', { type: 'tool' }, { type: 'tool' }, { savedScope: 'other-scope' }), []);
});

test('a changed current draft invalidates an older checkpoint even before target admission', () => {
  const before = evidence(), after = evidence(); after.workflow.document.nodes[0].config.defaultValue = 'changed by user';
  assert.deepEqual(resume('workflow.inspect', { workflowId: document.id }, before.workflow, { current: after, savedScope: scope(before) }), []);
});
