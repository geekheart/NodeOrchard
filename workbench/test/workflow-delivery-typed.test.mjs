import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';
import { WorkflowFiles } from '../src/workflows/workflow-files.mjs';
import { WorkflowRuns } from '../src/workflows/workflow-runs.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-typed-delivery-'));
  const db = new DatabaseSync(':memory:');
  const app = new EventEmitter();
  app.store = { db }; app.config = { appRoot: directory, workspaceRoot: join(directory, 'workflow'),
    dataDir: join(directory, 'state'), workflowRunRoot: join(directory, 'private-originals') };
  app.preferences = {};
  app.publish = (type, sessionId, payload) => app.emit('event', { type, sessionId, payload });
  app.workflowFiles = new WorkflowFiles(app, { allowedRoots: [directory] });
  const manager = new WorkflowRuns(app); app.workflows = manager;
  t.after(async () => { await manager.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  return { manager };
}

function graph(type, body, { projection, review = false, passthrough = false } = {}) {
  let document = createDocument({ schemaVersion: 2, title: 'Typed output delivery fixture' });
  const input = createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: 'text' } });
  const producer = createNode('tool', { x: 200, y: 0 }, { id: 'produce', config: {
    executionMode: 'code', language: 'javascript', inputType: 'text', outputType: 'any', code: body,
  }, ports: { inputs: [{ id: 'in', label: 'Input', type: 'text' }],
    outputs: [{ id: 'file', label: 'Declared result', type, ...(projection ? { valuePath: projection } : {}) }] } });
  const output = createNode('output', { x: 600, y: 0 }, { id: 'output' });
  document.nodes = [input, producer, output];
  document = connectNodes(document, { sourceNode: 'input', sourcePort: 'out', targetNode: 'produce', targetPort: 'in' });
  if (review) {
    const human = createNode('human', { x: 400, y: 0 }, { id: 'review', config: { reviewTargetNodeId: 'produce' },
      ports: { inputs: [{ id: 'in', label: 'Actual image', type: passthrough ? 'any' : type }], outputs: [{ id: 'out', label: 'Approved image', type: passthrough ? 'any' : type }] } });
    document.nodes.push(human);
    document = connectNodes(document, { sourceNode: 'produce', sourcePort: 'file', targetNode: 'review', targetPort: 'in' });
    return connectNodes(document, { sourceNode: 'review', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
  }
  return connectNodes(document, { sourceNode: 'produce', sourcePort: 'file', targetNode: 'output', targetPort: 'in' });
}

async function runUntil(manager, id, statuses) {
  for (let count = 0; count < 1000; count++) {
    const run = manager.get(id);
    if (statuses.includes(run.status)) return run;
    await delay(5);
  }
  throw new Error('Timed out waiting for typed output delivery');
}

const makeText = `const {writeFile}=await import('node:fs/promises');const path=context.outputDirectory+'/result.txt';await writeFile(path,'source-bound result bytes');return path;`;

for (const type of ['fileRef', 'artifactRef', 'image']) {
  test('a declared ' + type + ' string publishes its registered file and saved result through real DAG execution', async t => {
    const { manager } = await fixture(t);
    const review = type === 'image';
    const body = review
      ? `const {writeFile}=await import('node:fs/promises');const path=context.outputDirectory+'/image.svg';await writeFile(path,'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');return path;`
      : makeText;
    const started = await manager.start({ document: graph(type, body, { review }), input: 'fixture' });
    if (review) {
      const waiting = await runUntil(manager, started.id, ['waiting_review', 'error']);
      assert.equal(waiting.status, 'waiting_review', waiting.error);
      await assert.rejects(access(waiting.deliveryDirectory), { code: 'ENOENT' });
      await manager.approve(started.id, { nodeId: 'review', action: 'approve' });
    }
    const run = await runUntil(manager, started.id, ['complete', 'error']);
    assert.equal(run.status, 'complete', run.error);
    const manifest = JSON.parse(await readFile(run.delivery.manifestPath, 'utf8'));
    assert.equal(manifest.files.length, 2);
    const producer = run.nodes.produce.artifacts[0];
    const published = manifest.files.find(item => item.artifactId === producer.id);
    assert(published); assert.equal(published.nodeId, 'produce'); assert.equal(published.attempt, run.nodes.produce.attempt);
    assert.equal(published.sha256, producer.sha256);
    assert.deepEqual(await readFile(join(run.delivery.directory, published.path)), await readFile(producer.path));
    assert(manifest.files.some(item => item.path === relative(run.outputDirectory, run.nodes.output.savedPath)));
  });
}

test('a declared projected artifactBundle publishes its two registered files without copying unrelated producer files', async t => {
  const { manager } = await fixture(t);
  const body = `const {writeFile}=await import('node:fs/promises');const a=context.outputDirectory+'/a.txt',b=context.outputDirectory+'/b.txt';await writeFile(a,'A');await writeFile(b,'B');await writeFile(context.outputDirectory+'/private-cache.txt','not delivered');return {bundle:[{path:a},{path:b}],private:'private-cache.txt'};`;
  const started = await manager.start({ document: graph('artifactBundle', body, { projection: 'bundle' }), input: 'fixture' });
  const run = await runUntil(manager, started.id, ['complete', 'error']);
  assert.equal(run.status, 'complete', run.error);
  const manifest = JSON.parse(await readFile(run.delivery.manifestPath, 'utf8'));
  assert.equal(manifest.files.length, 3);
  assert.equal(manifest.files.filter(item => item.nodeId === 'produce').length, 2);
  assert(!manifest.files.some(item => item.path.endsWith('private-cache.txt')));
  assert.deepEqual(await readFile(join(run.delivery.directory, relative(run.outputDirectory, run.nodes.produce.outputDirectory), 'a.txt')), Buffer.from('A'));
});

test('ordinary text and JSON arrays remain data even when they contain canonical-looking file paths', async t => {
  const { manager } = await fixture(t);
  for (const [type, expression] of [['text', 'path'], ['array', '[1,2,{path}]']]) {
    const body = makeText.replace('return path;', 'return ' + expression + ';');
    const started = await manager.start({ document: graph(type, body), input: 'fixture' });
    const run = await runUntil(manager, started.id, ['complete', 'error']);
    assert.equal(run.status, 'complete', run.error);
    const manifest = JSON.parse(await readFile(run.delivery.manifestPath, 'utf8'));
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].nodeId, 'output');
    assert.equal(run.nodes.produce.artifacts.length, 0);
  }
});

test('a declared file port cannot publish an unregistered external path', async t => {
  const { manager } = await fixture(t);
  const started = await manager.start({ document: graph('fileRef', 'return "/fixtures/external-unregistered.txt";'), input: 'fixture' });
  const run = await runUntil(manager, started.id, ['complete', 'error']);
  assert.equal(run.nodes.produce.status, 'complete'); assert.equal(run.nodes.output.status, 'complete');
  assert.equal(run.status, 'error'); assert.match(run.delivery.error, /未唯一登记/);
  await assert.rejects(access(run.deliveryDirectory), { code: 'ENOENT' });
});

test('an approved any-valued human node retains its upstream declared file reference', async t => {
  const { manager } = await fixture(t);
  const started = await manager.start({ document: graph('fileRef', makeText, { review: true, passthrough: true }), input: 'fixture' });
  const waiting = await runUntil(manager, started.id, ['waiting_review', 'error']);
  assert.equal(waiting.status, 'waiting_review', waiting.error);
  await manager.approve(started.id, { nodeId: 'review', action: 'approve' });
  const run = await runUntil(manager, started.id, ['complete', 'error']);
  assert.equal(run.status, 'complete', run.error);
  const manifest = JSON.parse(await readFile(run.delivery.manifestPath, 'utf8'));
  assert.equal(manifest.files.length, 2);
  assert(manifest.files.some(item => item.artifactId === run.nodes.produce.artifacts[0].id));
});

function foreachGraph(child) {
  let document = createDocument({ schemaVersion: 2, title: 'Typed foreach delivery fixture' });
  document.nodes = [
    createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: 'array' } }),
    createNode('foreach', { x: 200, y: 0 }, { id: 'each', config: { document: child, maxIterations: 3 } }),
    createNode('output', { x: 400, y: 0 }, { id: 'output' }),
  ];
  document = connectNodes(document, { sourceNode: 'input', sourcePort: 'out', targetNode: 'each', targetPort: 'in' });
  return connectNodes(document, { sourceNode: 'each', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
}

test('foreach retains the frozen child final file type and publishes only its staged file references', async t => {
  const { manager } = await fixture(t);
  const started = await manager.start({ document: foreachGraph(graph('fileRef', makeText)), input: ['first', 'second'] });
  const run = await runUntil(manager, started.id, ['complete', 'error']);
  assert.equal(run.status, 'complete', run.error);
  assert.equal(run.output.length, 2);
  const manifest = JSON.parse(await readFile(run.delivery.manifestPath, 'utf8'));
  assert.equal(manifest.files.length, 3);
  const staged = manifest.files.filter(item => item.nodeId === 'each');
  assert.equal(staged.length, 2);
  for (const item of staged) {
    assert(run.output.some(path => path === join(run.outputDirectory, item.path)));
    assert.equal(item.attempt, run.nodes.each.attempt);
    assert.equal(await readFile(join(run.delivery.directory, item.path), 'utf8'), 'source-bound result bytes');
  }
});

function withUntypedCode(document, code, outputType = 'any') {
  const edge = document.edges.find(item => item.targetNode === 'output');
  document.edges = document.edges.filter(item => item !== edge);
  document.nodes.push(createNode('tool', { x: 400, y: 0 }, { id: 'untyped', config: {
    executionMode: 'code', inputType: 'any', outputType, code,
  } }));
  document = connectNodes(document, { sourceNode: edge.sourceNode, sourcePort: edge.sourcePort, targetNode: 'untyped', targetPort: 'in' });
  return connectNodes(document, { sourceNode: 'untyped', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
}

test('arbitrary any-valued code does not inherit file semantics merely by returning the same registered path', async t => {
  const { manager } = await fixture(t);
  const started = await manager.start({ document: withUntypedCode(graph('fileRef', makeText), 'return input;'), input: 'fixture' });
  const run = await runUntil(manager, started.id, ['complete', 'error']);
  assert.equal(run.status, 'complete', run.error);
  assert.equal(run.nodes.produce.artifacts.length, 1);
  assert.equal(run.nodes.untyped.artifacts.length, 1, 'an inherited registry index is not a delivery declaration');
  const manifest = JSON.parse(await readFile(run.delivery.manifestPath, 'utf8'));
  assert.deepEqual(manifest.files.map(item => item.nodeId), ['output']);
});

test('foreach leaves a child ordinary JSON array as data despite an inherited registered file', async t => {
  const { manager } = await fixture(t);
  const child = withUntypedCode(graph('fileRef', makeText), 'return [input];', 'array');
  const started = await manager.start({ document: foreachGraph(child), input: ['fixture'] });
  const run = await runUntil(manager, started.id, ['complete', 'error']);
  assert.equal(run.status, 'complete', run.error);
  assert.equal(run.output.length, 1);
  assert(Array.isArray(run.output[0]));
  const manifest = JSON.parse(await readFile(run.delivery.manifestPath, 'utf8'));
  assert.deepEqual(manifest.files.map(item => item.nodeId), ['output']);
});

test('a named merge preserves only the declared file field across an exact output projection', async t => {
  const { manager } = await fixture(t);
  let document = graph('fileRef', makeText);
  document.edges = document.edges.filter(item => item.targetNode !== 'output');
  document.nodes.push(createNode('merge', { x: 400, y: 0 }, { id: 'named', ports: {
    inputs: [{ id: 'document', label: 'File', type: 'any' }, { id: 'comment', label: 'Comment', type: 'text' }],
    outputs: [{ id: 'file', label: 'File only', type: 'any', valuePath: 'document' }],
  } }));
  document = connectNodes(document, { sourceNode: 'produce', sourcePort: 'file', targetNode: 'named', targetPort: 'document' });
  document = connectNodes(document, { sourceNode: 'input', sourcePort: 'out', targetNode: 'named', targetPort: 'comment' });
  document = connectNodes(document, { sourceNode: 'named', sourcePort: 'file', targetNode: 'output', targetPort: 'in' });
  const started = await manager.start({ document, input: 'not a file reference' });
  const run = await runUntil(manager, started.id, ['complete', 'error']);
  assert.equal(run.status, 'complete', run.error);
  const manifest = JSON.parse(await readFile(run.delivery.manifestPath, 'utf8'));
  assert.equal(manifest.files.length, 2);
  assert(manifest.files.some(item => item.artifactId === run.nodes.produce.artifacts[0].id));
});
