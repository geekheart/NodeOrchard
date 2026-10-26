import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode, getPorts } from '../shared/workflow/workflow-model.mjs';
import { WorkflowDAGRuns } from '../src/workflows/workflow-dag-runs.mjs';

function fixture() {
  const producer = createNode('tool', { x: 0, y: 0 }, { id: 'author-input', config: {
    executionMode: 'tool', toolName: 'hdk.guide.author-input' }, ports: { inputs: [], outputs: [
    { id: 'out', label: 'receipt', type: 'object' },
    { id: 'skill-input', label: 'author data', type: 'object', valuePath: 'skillInput' }] } });
  const author = createNode('skill', { x: 0, y: 0 }, { id: 'author', config: { outputType: 'object' } });
  const assemble = createNode('tool', { x: 0, y: 0 }, { id: 'assemble', config: {
    executionMode: 'tool', toolName: 'hdk.guide.assemble' }, ports: { inputs: [
    { id: 'author', label: 'receipt', type: 'object', required: true },
    { id: 'plan', label: 'prose', type: 'object', required: true }], outputs: [] } });
  const outputDirectory = '/tmp/current-guide';
  const source = { status: 'complete', attempt: 1, attemptId: 'current-attempt',
    outputDirectory: outputDirectory + '/author-input/版本-1', output: {
      kind: 'hdk-node-receipt', runId: 'current-run', nodeId: producer.id,
      operation: 'hdk.guide.author-input', receiptPath: outputDirectory + '/author-input/版本-1/receipt.json',
      receiptSha256: 'a'.repeat(64), artifacts: [], skillInput: { technicalEvidence: 'a'.repeat(52500) } } };
  const plan = { sections: 'b'.repeat(17000) };
  const state = { run: { id: 'current-run', outputDirectory, nodes: {
    [producer.id]: source, [author.id]: { status: 'complete', output: plan } } },
    plan: { byId: new Map([[producer.id, producer], [author.id, author]]), incoming: new Map([
      [assemble.id, [{ sourceNode: producer.id, sourcePort: 'out', targetPort: 'author' },
        { sourceNode: author.id, sourcePort: getPorts(author).outputs[0].id, targetPort: 'plan' }]]]) } };
  return { state, producer, author, assemble, source, plan };
}
const input = ({ state, assemble }) => WorkflowDAGRuns.prototype.inputValue.call({}, state, assemble);

test('large guide join uses an attempt-bound receipt reference and preserves prose and full producer output', () => {
  const f = fixture(); const before = structuredClone(f.source.output); const value = input(f);
  assert.equal(value.author.kind, 'hdk-node-receipt-ref');
  assert.equal(value.author.attempt, 1); assert.equal(value.author.attemptId, 'current-attempt');
  assert.equal(value.author.receiptSha256, f.source.output.receiptSha256);
  assert.deepEqual(value.plan, f.plan); assert.deepEqual(f.source.output, before);
  assert(Buffer.byteLength(JSON.stringify(value)) < 65536);
  // The model still gets the entire explicit technical projection.
  const skill = createNode('skill', { x: 0, y: 0 }, { id: 'reader', config: { inputType: 'object' } });
  f.state.plan.incoming.set(skill.id, [{ sourceNode: f.producer.id, sourcePort: 'skill-input', targetPort: 'in' }]);
  assert.deepEqual(WorkflowDAGRuns.prototype.inputValue.call({}, f.state, skill), before.skillInput);
});

test('small joins keep their existing full receipt shape', () => {
  const f = fixture(); f.source.output.skillInput.technicalEvidence = 'short';
  assert.deepEqual(input(f).author, f.source.output);
});

test('oversized ordinary data, fake receipts, and unregistered or code producers stay rejected', () => {
  for (const change of [
    f => { f.assemble.config.executionMode = 'code'; },
    f => { f.assemble.config.toolName = 'hdk.unknown'; },
    f => { f.producer.config.executionMode = 'code'; },
    f => { f.producer.config.toolName = 'hdk.unknown'; },
    f => { f.source.output.runId = 'other-run'; },
    f => { f.source.output.nodeId = 'other-producer'; },
    f => { f.source.output.kind = 'ordinary-json'; },
    f => { f.source.output.receiptPath = '/tmp/another/receipt.json'; },
    f => { f.source.outputDirectory = '/tmp/another'; },
    f => { f.source.attemptId = null; },
  ]) { const f = fixture(); change(f); assert.throws(() => input(f), /64KB/); }
});

test('receipt references do not bypass the combined data limit', () => {
  const f = fixture(); f.plan.sections = 'b'.repeat(65000);
  // Each port is individually within the limit, but reference plus prose is not.
  f.source.output.receiptPath += 'x'.repeat(1000);
  f.source.outputDirectory += 'x'.repeat(1000);
  assert.throws(() => input(f), /64KB/);
  const g = fixture(); g.plan.sections = 'b'.repeat(65500);
  assert.throws(() => input(g), /64KB/);
});
