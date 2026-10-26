import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowStudioUI, deliveryResults } from '../public/workflow-studio-ui.js';

const clone = value => structuredClone(value);
const descendants = item => [item, ...(item.children || []).flatMap(descendants)];
function fixture(operation = 'hdk.full.verify') {
  const directory = '/workspace/run/producer/版本-2';
  const refs = [
    { path: directory + '/BOARD_HDK_V1.0.zip', sha256: 'a'.repeat(64), role: 'full-hdk-delivery', bytes: 306561766 },
    { path: directory + '/验收.json', sha256: 'b'.repeat(64), role: operation === 'hdk.full.verify' ? 'full-hdk-verification' : 'archive-verification', bytes: 26317498 },
  ];
  const token = { kind: 'hdk-node-receipt', runId: 'run', nodeId: 'producer', operation, status: 'complete', qualified: true,
    receiptPath: directory + '/receipt.json', receiptSha256: 'c'.repeat(64), artifacts: refs,
    physicalTestStatus: 'not-run', releaseQualified: false, qualitySummary: { checks: { source: true, files: true } },
    unresolved: [{ detail: '制造商确认叠层与阻抗券' }] };
  if (operation === 'hdk.full.verify') token.packagePath = directory + '/BOARD_HDK_V1.0';
  const artifacts = refs.map((reference, index) => ({ ...reference, id: 'opaque-' + index, artifactId: 'opaque-' + index,
    runId: 'run', nodeId: 'producer', attempt: 2, name: reference.path.split('/').at(-1), label: index ? '验收报告' : '最终交付 ZIP',
    mimeType: index ? 'application/json' : 'application/zip', size: reference.bytes,
    previewUrl: '/api/workflow-v2/artifacts/opaque-' + index, downloadUrl: '/api/workflow-v2/artifacts/opaque-' + index + '?download=1' }));
  const upstream = { ...artifacts[0], id: 'upstream-old', artifactId: 'upstream-old', nodeId: 'upstream', name: 'C61烧录说明.md', path: '/workspace/run/upstream/旧说明.md',
    previewUrl: '/api/workflow-v2/artifacts/upstream-old', downloadUrl: '/api/workflow-v2/artifacts/upstream-old?download=1' };
  const run = { id: 'run', status: 'complete', outputDirectory: '/workspace/run', document: { mode: 'execute', nodes: [
    { id: 'producer', type: 'tool', title: '最终 HDK 验收', config: { executionMode: 'tool', toolName: operation } },
    { id: 'final', type: 'output', title: '最终输出' }], edges: [] }, nodes: {
    producer: { status: 'complete', attempt: 2, attemptId: 'attempt-two', outputDirectory: directory, output: clone(token), artifacts: [...artifacts, upstream] },
    final: { status: 'complete', output: clone(token), artifacts: [...artifacts, upstream] } } };
  return { run, token, artifacts, upstream };
}
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.dataset = {}; this.value = ''; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, handler) { this.listeners[key] = handler; }
}
function dom(t) {
  const previous = globalThis.document; globalThis.document = { activeElement: null, createElement: tag => new Element(tag) };
  t.after(() => { if (previous) globalThis.document = previous; else delete globalThis.document; });
}

test('final HDK card uses only the output receipt direct file references, not inherited artifact lists', () => {
  const { run, artifacts, upstream } = fixture(), before = JSON.stringify(run), result = deliveryResults(run);
  assert.equal(result.length, 1); assert.deepEqual(result[0].artifacts, artifacts);
  assert.equal(result[0].artifacts.includes(upstream), false); assert.equal(JSON.stringify(run), before);
  run.nodes.final.artifacts = [upstream]; assert.deepEqual(deliveryResults(run)[0].artifacts, artifacts, 'Inherited output gallery does not define the final deliverables');
});

test('new archive-delivery receipts are supported without inventing an absent package path', () => {
  const { run } = fixture('hdk.full.archive-delivery'), result = deliveryResults(run);
  assert.equal(result.length, 1); assert.equal(result[0].token.packagePath, undefined);
  assert.equal(result[0].artifacts[1].role, 'archive-verification');
});

test('unfinished, learning, non-HDK, fake and stale producer outputs have no delivery success card', () => {
  const changes = [
    run => { run.status = 'waiting_review'; }, run => { run.learningId = 'learning'; }, run => { run.document.mode = 'learn'; },
    run => { run.nodes.final.status = 'pending'; }, run => { run.nodes.producer.status = 'running'; },
    run => { run.nodes.final.output.kind = 'hdk-node-receipt-ref'; }, run => { run.nodes.final.output.operation = 'hdk.guide.verify'; },
    run => { run.nodes.final.output.runId = 'foreign-run'; }, run => { run.nodes.final.output.qualified = false; },
    run => { run.document.nodes[0].type = 'skill'; }, run => { run.document.nodes[0].config.executionMode = 'code'; },
    run => { run.document.nodes[0].config.toolName = 'hdk.full.archive-delivery'; },
    run => { run.nodes.producer.attempt = 3; }, run => { run.nodes.producer.attemptId = null; },
    run => { run.nodes.producer.outputDirectory = '/workspace/run/producer/版本-1'; },
    run => { run.nodes.final.output.packagePath = '/forged/path'; }, run => { run.nodes.final.output.artifacts[0].sha256 = 'd'.repeat(64); },
  ];
  for (const change of changes) { const { run } = fixture(); change(run); assert.deepEqual(deliveryResults(run), []); }
});

test('registered artifacts must match run producer current attempt path and complete SHA', () => {
  const changes = [
    item => { item.runId = 'foreign'; }, item => { item.nodeId = 'upstream'; }, item => { item.attempt = 1; },
    item => { item.path = item.path.replace('版本-2', '版本-1'); }, item => { item.sha256 = 'e'.repeat(64); },
    item => { item.previewUrl = 'file:///arbitrary/path'; }, item => { item.downloadUrl = '/api/unbound-path'; },
  ];
  for (const change of changes) { const { run } = fixture(); change(run.nodes.producer.artifacts[0]); assert.deepEqual(deliveryResults(run), []); }
  const { run } = fixture(); run.nodes.producer.artifacts = []; assert.deepEqual(deliveryResults(run), [], 'Output inherited copies cannot substitute for the current producer registration');
});

test('malformed direct references and missing final report never generate partial success links', () => {
  for (const refs of [[], [null, null], [null, {}], [{ path: '/escape.zip', sha256: 'a'.repeat(64) }, {}]]) {
    const { run } = fixture(); run.nodes.final.output.artifacts = refs; run.nodes.producer.output = clone(run.nodes.final.output);
    assert.deepEqual(deliveryResults(run), []);
  }
  const { run } = fixture(); run.nodes.producer.artifacts[1].role = 'upstream-json'; assert.deepEqual(deliveryResults(run), []);
});

test('delivery card shows readonly directory ZIP JSON report size and qualification limits without fetching report bodies', t => {
  dom(t); const { run, token } = fixture(), studio = Object.create(WorkflowStudioUI.prototype);
  studio.api = () => { throw new Error('Rendering must not read the 26MB report or call a filesystem route'); };
  const card = studio.renderDeliveries(run), nodes = descendants(card), input = nodes.find(item => item.tag === 'input');
  assert.equal(input.value, token.packagePath); assert.equal(input.readOnly, true);
  assert.equal(nodes.some(item => item.tag === 'details'), false, 'Final JSON is directly visible, not hidden in advanced artifacts');
  assert.ok(nodes.some(item => item.tag === 'a' && item.href === '/api/workflow-v2/artifacts/opaque-0?download=1'));
  assert.ok(nodes.some(item => item.tag === 'a' && item.href === '/api/workflow-v2/artifacts/opaque-1'));
  assert.ok(nodes.some(item => item.textContent?.includes('application/json') && item.textContent.includes('25701 KB')));
  const text = nodes.map(item => item.textContent || '').join('\n');
  assert.match(text, /固定回执检查 2 \/ 2 通过/); assert.match(text, /未进行实板测试/); assert.match(text, /未发布放行/); assert.match(text, /1 项待确认事项/);
});

test('delivery card is placed after node steps and before the unchanged full artifact gallery', t => {
  dom(t); const { run, upstream } = fixture(), studio = Object.create(WorkflowStudioUI.prototype);
  studio.runSurface = new Element('section'); studio.runtime = { currentRun: () => run }; studio.editor = { selection: new Set(), settings: { propertiesClosed: true } }; studio.renderGraph = () => {};
  studio.renderRuntime(); const children = studio.runSurface.children, steps = children.findIndex(item => item.className === 'wf-studio-run-steps'), delivery = children.findIndex(item => item.className === 'wf-studio-deliveries'), all = children.findIndex(item => item.tag === 'h3' && item.textContent === '全部产物');
  assert.ok(steps < delivery && delivery < all);
  assert.ok(descendants(studio.runSurface).some(item => item.href === upstream.downloadUrl), 'Original all-artifact access remains available');
});
