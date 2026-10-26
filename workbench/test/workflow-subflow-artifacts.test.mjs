import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';
import { WorkflowFiles } from '../src/workflows/workflow-files.mjs';
import { WorkflowRuns } from '../src/workflows/workflow-runs.mjs';
import { stageSubflowArtifacts } from '../src/workflows/workflow-subflow-artifacts.mjs';
import { executeOperation } from '../src/workflows/workflow-operations.mjs';

const node = (type, id, config = {}, ports) => createNode(type, {}, { id, config, ...(ports ? { ports } : {}) });
const port = (type, id = 'out') => ({ id, label: id, type });
const wire = (doc, sourceNode, targetNode) => connectNodes(doc, { sourceNode, sourcePort: 'out', targetNode, targetPort: 'in' });
function graph(nodes, pairs, title) {
  let doc = { ...createDocument({ schemaVersion: 2, title }), nodes };
  for (const pair of pairs) doc = wire(doc, ...pair);
  return doc;
}
function childDocument({ review = false, opaque = false } = {}) {
  const input = node('input', 'child-input', { outputType: 'text' });
  const produce = node('tool', 'produce', { inputType: 'text', code:
    `const {writeFile}=await import('node:fs/promises');const path=context.outputDirectory+'/deliver.txt';await writeFile(path,'child bytes: '+input);await writeFile(context.outputDirectory+'/unpublished-cache.txt','private cache');return path;`,
  }, { inputs: [port('text', 'in')], outputs: [port('fileRef')] });
  const rows = [input, produce], pairs = [['child-input', 'produce']]; let previous = 'produce';
  if (review) {
    rows.push(node('human', 'child-review', { reviewTargetNodeId: 'produce' }, { inputs: [port('fileRef', 'in')], outputs: [port('fileRef')] }));
    pairs.push([previous, 'child-review']); previous = 'child-review';
  }
  if (opaque) {
    rows.push(node('tool', 'expose-id', { inputType: 'fileRef', code: 'return input;' }, { inputs: [port('fileRef', 'in')], outputs: [port('artifactRef')] }));
    pairs.push([previous, 'expose-id']); previous = 'expose-id';
  }
  rows.push(node('output', 'child-output')); pairs.push([previous, 'child-output']);
  return graph(rows, pairs, 'Independent child artifact fixture');
}
function parentDocument(child, { each = false, opaque = false } = {}) {
  const type = each ? 'array' : 'text', result = each ? 'artifactBundle' : opaque ? 'artifactRef' : 'fileRef';
  return graph([node('input', 'input', { outputType: type }),
    node(each ? 'foreach' : 'subflow', 'nested', { document: child, ...(each ? { maxIterations: 2 } : {}) }, { inputs: [port(type, 'in')], outputs: [port(result)] }),
    node('output', 'output')], [['input', 'nested'], ['nested', 'output']], 'Independent parent artifact fixture');
}
async function until(manager, id, statuses) {
  for (let index = 0; index < 1500; index++) { const run = manager.get(id); if (statuses.includes(run.status)) return run; await delay(5); }
  throw Error('Timed out waiting for isolated parent/child');
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-child-files-')), db = new DatabaseSync(':memory:');
  const app = new EventEmitter(); app.store = { db }; app.preferences = {};
  app.config = { workspaceRoot: join(directory, 'workflow'), appRoot: directory, dataDir: directory, workflowRunRoot: join(directory, 'private-originals') };
  app.publish = (type, sessionId, payload) => app.emit('event', { type, sessionId, payload });
  app.workflowFiles = new WorkflowFiles(app, { allowedRoots: [directory] }); let productions = 0;
  const execute = async options => {
    if (options.node.id === 'produce') productions++;
    if (options.node.id === 'expose-id') {
      const source = app.workflows.get(options.context.runId).nodes.produce.artifacts.find(item => item.path === options.input);
      return { output: { artifactId: source.artifactId, runId: source.runId, nodeId: source.nodeId, attempt: source.attempt, sha256: source.sha256 } };
    }
    return executeOperation(options);
  };
  const replace = () => { app.workflows = new WorkflowRuns(app, { executeOperation: execute }); return app.workflows; };
  const manager = replace();
  t.after(async () => { await app.workflows.close(); db.close(); await rm(directory, { force: true, recursive: true }); });
  return { app, db, directory, manager, replace, productions: () => productions };
}

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('a real independently stored child file is copied and registered as the current parent producer before final publication', async t => {
  const { app, manager, productions } = await fixture(t);
  const started = await manager.start({ document: parentDocument(childDocument()), input: 'first' });
  const parent = await until(manager, started.id, ['complete', 'error']); assert.equal(parent.status, 'complete', parent.error);
  const record = parent.nodes.nested, child = manager.get(record.subflowProgress.childRunIds[0]);
  assert(relative(parent.outputDirectory, child.outputDirectory).startsWith('..'), 'child canonical root is independent');
  const original = child.nodes.produce.artifacts[0], gathered = record.artifacts.find(item => item.path === parent.output);
  assert(gathered); assert.equal(gathered.runId, parent.id); assert.equal(gathered.nodeId, 'nested'); assert.equal(gathered.attempt, record.attempt);
  assert.notEqual(gathered.artifactId, original.artifactId); assert.equal(gathered.sha256, original.sha256);
  assert.notEqual((await stat(gathered.path)).ino, (await stat(original.path)).ino);
  assert.equal(await readFile(parent.output, 'utf8'), 'child bytes: first');
  const manifest = JSON.parse(await readFile(parent.delivery.manifestPath, 'utf8'));
  assert.equal(manifest.files.length, 2); assert(manifest.files.some(item => item.artifactId === gathered.artifactId));
  assert(!manifest.files.some(item => item.path.includes('unpublished-cache'))); assert.equal(productions(), 1);
  assert.equal((await app.workflowFiles.verifyArtifacts(record.artifacts)).ok, true);
});

test('a restart at delegated review preserves one production and maps an opaque child reference to a parent artifact', async t => {
  const { app, manager, replace, productions } = await fixture(t);
  const started = await manager.start({ document: parentDocument(childDocument({ review: true, opaque: true }), { opaque: true }), input: 'reviewed' });
  const waiting = await until(manager, started.id, ['waiting_review', 'error']); assert.equal(waiting.status, 'waiting_review', waiting.error);
  const childId = waiting.nodes.nested.subflowProgress.childRunId; assert.equal(productions(), 1);
  await manager.close(); const reopened = replace();
  await reopened.approve(childId, { nodeId: 'child-review', action: 'approve', feedback: 'accepted once' });
  const parent = await until(reopened, started.id, ['complete', 'error']); assert.equal(parent.status, 'complete', parent.error);
  const artifact = app.workflowFiles.getArtifact(parent.output.artifactId);
  assert.equal(artifact.runId, parent.id); assert.equal(parent.output.runId, parent.id); assert.equal(parent.output.nodeId, 'nested');
  assert.equal(artifact.attempt, parent.nodes.nested.attempt); assert.equal(productions(), 1);
  const child = reopened.get(childId); assert.equal(child.nodes['child-review'].review.feedback, 'accepted once');
  assert.equal(await readFile(artifact.path, 'utf8'), 'child bytes: reviewed');
});

test('foreach gives equal child filenames distinct parent locations and publishes an explicitly typed artifact bundle', async t => {
  const { manager, productions } = await fixture(t);
  const started = await manager.start({ document: parentDocument(childDocument(), { each: true }), input: ['A', 'B'] });
  const parent = await until(manager, started.id, ['complete', 'error']); assert.equal(parent.status, 'complete', parent.error);
  assert.equal(parent.output.length, 2); assert.notEqual(parent.output[0], parent.output[1]);
  assert.deepEqual(await Promise.all(parent.output.map(path => readFile(path, 'utf8'))), ['child bytes: A', 'child bytes: B']);
  assert.equal(parent.delivery.fileCount, 3); assert.equal(productions(), 2);
  for (const artifact of parent.nodes.nested.artifacts) { assert.equal(artifact.runId, parent.id); assert.equal(artifact.nodeId, 'nested'); }
});

test('reserved same-source files survive an interrupted copy and resume idempotently without overwriting unknown files', async t => {
  const { app, manager, db, productions } = await fixture(t);
  const started = await manager.start({ document: parentDocument(childDocument()), input: 'resume' });
  const final = await until(manager, started.id, ['complete', 'error']); assert.equal(final.status, 'complete', final.error);
  const child = manager.get(final.nodes.nested.subflowProgress.childRunIds[0]);
  // Isolated durable fixture: replay only the file-staging phase at the same
  // admitted child/current parent attempt, never a capability or user review.
  const parent = structuredClone(final), record = parent.nodes.nested;
  record.subflowProgress.childRunId = child.id; record.status = 'running';
  const binding = record.stagedChildArtifacts[0];
  const previous = binding.artifactId; delete binding.artifactId; binding.status = 'reserved';
  record.childArtifacts = record.childArtifacts.filter(item => item.artifactId !== previous);
  let persisted = null;
  const staged = await stageSubflowArtifacts(app.workflowFiles, { parent, nodeId: 'nested', child,
    saveProgress: () => { persisted = structuredClone(parent); db.prepare('UPDATE workflow_runs SET value=? WHERE id=?').run(JSON.stringify(parent), parent.id); } });
  assert.equal(staged.artifacts.length, 2); assert.equal(productions(), 1);
  assert(persisted.nodes.nested.stagedChildArtifacts.every(item => item.status === 'complete'));
  const again = await stageSubflowArtifacts(app.workflowFiles, { parent: persisted, nodeId: 'nested', child });
  assert.deepEqual(again.artifacts, staged.artifacts, 'completed bindings reuse identical registered artifacts');
  const target = persisted.nodes.nested.stagedChildArtifacts[0].path;
  persisted.nodes.nested.stagedChildArtifacts = persisted.nodes.nested.stagedChildArtifacts.filter(item => item.path !== target);
  await assert.rejects(stageSubflowArtifacts(app.workflowFiles, { parent: persisted, nodeId: 'nested', child }), /已有未经登记的文件.*未覆盖/);
  assert.deepEqual(await readFile(target), await readFile(child.nodes['child-output'].savedPath));
});

for (const action of ['close', 'interrupt']) {
  test(action + ' waits for an in-progress child copy, prevents late registration, and preserves its source-bound reservation', async t => {
    const { app, manager, db, replace, productions } = await fixture(t);
    const entered = deferred(), release = deferred(); const reads = new Map();
    const read = app.workflowFiles.readArtifact.bind(app.workflowFiles); let held = false;
    app.workflowFiles.readArtifact = async id => {
      const result = await read(id), source = manager.get(result.record.runId);
      if (source.parentRunId && source.status === 'complete') {
        const count = (reads.get(id) || 0) + 1; reads.set(id, count);
        if (!held && count === 2) { held = true; entered.resolve(); await release.promise; }
      }
      return result;
    };
    const started = await manager.start({ document: parentDocument(childDocument()), input: action });
    let stopping;
    try {
      await entered.promise;
      let stopped = false;
      stopping = (action === 'close' ? manager.close() : manager.interrupt(started.id)).then(value => { stopped = true; return value; });
      await delay(15); assert.equal(stopped, false, 'shutdown must wait for outstanding file I/O');
      release.resolve(); await stopping;
      await delay(10);
      const count = db.prepare("SELECT COUNT(*) AS total FROM workflow_artifacts WHERE json_extract(value,'$.runId')=?").get(started.id).total;
      assert.equal(count, 0, 'cancelled staging must not register artifacts after shutdown/interrupt');
      const persisted = manager.get(started.id), record = persisted.nodes.nested;
      assert.equal(record.stagedChildArtifacts[0].status, 'reserved');
      assert.equal((await stat(record.stagedChildArtifacts[0].path)).isFile(), true); assert.equal(productions(), 1);
      if (action === 'close') {
        const reopened = replace(), restored = reopened.get(started.id), child = reopened.get(record.subflowProgress.childRunId);
        app.workflowFiles.readArtifact = read;
        // Exercise only the interrupted staging phase after manager recreation;
        // no capability, approval or whole workflow is replayed by this recovery.
        const recovered = await stageSubflowArtifacts(app.workflowFiles, { parent: restored, nodeId: 'nested', child,
          saveProgress: () => db.prepare('UPDATE workflow_runs SET value=? WHERE id=?').run(JSON.stringify(restored), restored.id) });
        assert.equal(recovered.artifacts.length, 2); assert.equal(productions(), 1);
        assert(restored.nodes.nested.stagedChildArtifacts.every(item => item.status === 'complete'));
      }
    } finally { release.resolve(); await stopping; }
  });
}

test('same-path altered bytes or source identity, foreign parents and child-version changes are rejected', async t => {
  const { app, manager } = await fixture(t);
  const started = await manager.start({ document: parentDocument(childDocument()), input: 'bound' });
  const final = await until(manager, started.id, ['complete', 'error']); assert.equal(final.status, 'complete', final.error);
  const child = manager.get(final.nodes.nested.subflowProgress.childRunIds[0]);
  const parent = structuredClone(final); parent.nodes.nested.subflowProgress.childRunId = child.id;
  await assert.rejects(stageSubflowArtifacts(app.workflowFiles, { parent, nodeId: 'nested', child: { ...child, parentRunId: 'foreign' } }), /父节点当前运行版本不一致/);
  const binding = parent.nodes.nested.stagedChildArtifacts[0], original = await readFile(binding.path);
  const sourceId = binding.sourceArtifactId; binding.sourceArtifactId = 'different-source';
  await assert.rejects(stageSubflowArtifacts(app.workflowFiles, { parent, nodeId: 'nested', child }), /绑定其它来源或版本/);
  binding.sourceArtifactId = sourceId; await writeFile(binding.path, 'tampered');
  await assert.rejects(stageSubflowArtifacts(app.workflowFiles, { parent, nodeId: 'nested', child }), /SHA 不一致/);
  await writeFile(binding.path, original);
  const get = app.workflows.get.bind(app.workflows); app.workflows.get = id => id === child.id ? { ...get(id), status: 'running' } : get(id);
  await assert.rejects(stageSubflowArtifacts(app.workflowFiles, { parent, nodeId: 'nested', child }), /当前输出在归集期间发生变化/);
});

test('child-source escapes and parent-target symlinks cannot be accepted as resumable files', async t => {
  const { app, manager, directory } = await fixture(t);
  const started = await manager.start({ document: parentDocument(childDocument()), input: 'links' });
  const final = await until(manager, started.id, ['complete', 'error']); assert.equal(final.status, 'complete', final.error);
  const child = manager.get(final.nodes.nested.subflowProgress.childRunIds[0]);
  const parent = structuredClone(final); parent.nodes.nested.subflowProgress.childRunId = child.id;
  const source = child.nodes.produce.artifacts[0], original = await readFile(source.path), outside = join(directory, 'outside.txt');
  await writeFile(outside, original); await rm(source.path); await symlink(outside, source.path);
  await assert.rejects(stageSubflowArtifacts(app.workflowFiles, { parent, nodeId: 'nested', child }), /产物位置已变化|不能通过符号链接访问其它目录/);
  await rm(source.path); await writeFile(source.path, original);
  const target = parent.nodes.nested.stagedChildArtifacts[0].path;
  await rm(target); await symlink(source.path, target);
  await assert.rejects(stageSubflowArtifacts(app.workflowFiles, { parent, nodeId: 'nested', child }), /符号链接.*未覆盖/);
});

test('a manifest-backed child package is gathered to the parent root with portable local links and unchanged file bytes', async t => {
  const { app, manager } = await fixture(t);
  const body = `const {mkdir,writeFile}=await import('node:fs/promises');const {createHash}=await import('node:crypto');
    const packagePath=context.outputDirectory+'/portable';await mkdir(packagePath+'/img',{recursive:true});
    const text='![image](img/front.svg)',image='<svg xmlns="http://www.w3.org/2000/svg"/>';
    await writeFile(packagePath+'/guide.md',text);await writeFile(packagePath+'/img/front.svg',image);
    const hash=s=>createHash('sha256').update(s).digest('hex');
    const manifest={schemaVersion:1,files:[{source:'/outside/source.md',path:'guide.md',sha256:hash('old input'),deliveredSha256:hash(text),bytes:Buffer.byteLength(text)},
      {source:'/outside/photo',path:'img/front.svg',sha256:hash(image),bytes:Buffer.byteLength(image)}],
      localLinkClosure:{entrypoints:['guide.md'],documents:['guide.md'],links:[{document:'guide.md',target:'img/front.svg'}]}};
    const path=packagePath+'/package-manifest.json';await writeFile(path,JSON.stringify(manifest));
    await writeFile(packagePath+'/unlisted-cache.txt','not delivered');
    return {packagePath,artifacts:[{path,role:'package-manifest'}]};`;
  const child = graph([node('input', 'child-input', { outputType: 'text' }),
    node('tool', 'package', { inputType: 'text', outputType: 'object', code: body }), node('output', 'child-output')],
    [['child-input', 'package'], ['package', 'child-output']], 'Manifest-backed child fixture');
  const parent = parentDocument(child);
  parent.nodes = parent.nodes.map(item => item.id === 'nested' ? { ...item, ports: { inputs: [port('text', 'in')], outputs: [port('object')] } } : item);
  const started = await manager.start({ document: parent, input: 'package' });
  const result = await until(manager, started.id, ['complete', 'error']); assert.equal(result.status, 'complete', result.error);
  assert(result.output.packagePath.startsWith(result.nodes.nested.outputDirectory));
  assert.equal(result.delivery.fileCount, 4, 'manifest, two declared members and final saved result');
  const packageCopy = join(result.delivery.directory, relative(result.outputDirectory, result.output.packagePath));
  assert.equal(await readFile(join(packageCopy, 'guide.md'), 'utf8'), '![image](img/front.svg)');
  assert.equal(await readFile(join(packageCopy, 'img/front.svg'), 'utf8'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await assert.rejects(readFile(join(packageCopy, 'unlisted-cache.txt')), { code: 'ENOENT' });
  assert.equal(result.nodes.nested.stagedChildPackages.length, 1); assert.equal(result.nodes.nested.stagedChildPackages[0].status, 'complete');
  assert.equal(result.nodes.nested.childArtifacts.length, 2, 'only manifest and child result are individually registered; members are manifest-bound');
  const manifest = result.output.artifacts[0], registered = result.nodes.nested.artifacts.find(item => item.path === manifest.path);
  assert.equal(registered.runId, result.id); assert.equal(registered.role, 'package-manifest');
  assert.equal((await app.workflowFiles.verifyArtifacts(result.nodes.nested.artifacts)).ok, true);
});
