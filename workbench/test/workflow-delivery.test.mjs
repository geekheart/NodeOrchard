import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { WorkflowFiles } from '../src/workflows/workflow-files.mjs';
import { selectDeliveryArtifacts } from '../src/workflows/workflow-delivery.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-declared-delivery-'));
  const db = new DatabaseSync(':memory:');
  const app = { store: { db }, config: { workspaceRoot: directory, appRoot: directory, workflowRunRoot: join(directory, 'local-runs') } };
  const files = new WorkflowFiles(app, { allowedRoots: [directory] });
  const document = { schemaVersion: 2, id: 'declared-delivery', title: 'Declared delivery fixture', settings: {}, nodes: [
    { id: 'produce', type: 'tool', title: 'Generate archive', config: {} },
    { id: 'render', type: 'tool', title: 'Render preview', config: {} },
    { id: 'stage', type: 'output', title: 'Reviewed stage preview', config: { stage: 'intermediate' } },
    { id: 'output', type: 'output', title: 'Final archive', config: { stage: 'final' } },
  ] };
  const runId = randomUUID(), prepared = await files.prepareRun({ document, input: {}, runId });
  const run = { ...prepared, schemaVersion: 2, id: runId, document, nodes: {} };
  for (const node of document.nodes) {
    const attempt = node.id === 'produce' ? 2 : 1;
    run.nodes[node.id] = { status: 'complete', attempt, artifacts: [], output: null,
      outputDirectory: await files.nodeDirectory({ runId, nodeId: node.id, attempt }) };
  }
  const artifact = async (nodeId, name, value, attempt = run.nodes[nodeId].attempt) => {
    const path = join(await files.nodeDirectory({ runId, nodeId, attempt }), name);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, value);
    const record = await files.registerArtifact({ runId, nodeId, attempt, path });
    run.nodes[nodeId].artifacts.push(record); return record;
  };
  const zip = await artifact('produce', 'portable.zip', 'synthetic portable archive bytes');
  const verification = await artifact('produce', 'verification.json', '{"qualified":true}');
  const hidden = await artifact('produce', 'intermediate-proof.txt', 'not explicitly delivered');
  const old = await artifact('produce', 'portable.zip', 'old attempt bytes', 1);
  const preview = await artifact('render', 'preview.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const spec = row => ({ path: row.path, sha256: row.sha256, bytes: row.size });
  run.nodes.stage.output = { files: [spec(preview)] };
  run.nodes.stage.artifacts = [preview];
  run.nodes.output.output = { kind: 'synthetic-receipt', artifacts: [spec(zip), spec(verification)],
    cachePath: run.nodes.produce.outputDirectory, sourceFiles: [hidden.path], proofFiles: [old.path] };
  run.nodes.output.artifacts = [zip, verification, hidden, old, preview];
  for (const nodeId of ['stage', 'output']) {
    const saved = await artifact(nodeId, '结果.json', JSON.stringify(run.nodes[nodeId].output));
    run.nodes[nodeId].savedPath = saved.path;
  }
  app.workflows = { get: id => { assert.equal(id, run.id); return structuredClone(run); } };
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, app, files, run, artifact, zip, verification, hidden, old, preview };
}

test('publication copies explicit current final and stage results, preserving bytes and positions without scanning history or SDK caches', async t => {
  const { files, run, zip, verification, hidden, old, preview } = await fixture(t);
  const huge = join(run.nodes.produce.outputDirectory, 'managed_components', 'cache.bin');
  await mkdir(dirname(huge)); await writeFile(huge, ''); await truncate(huge, 512 * 1024 * 1024 + 1);
  // Even a non-delivered symlink must not cause a whole-run scan or publication.
  await symlink(hidden.path, join(run.nodes.produce.outputDirectory, 'unpublished-link'));
  const publication = await files.publishRun(run.id);
  const manifest = JSON.parse(await readFile(publication.manifestPath, 'utf8'));
  const expected = [zip.path, verification.path, preview.path, run.nodes.stage.savedPath, run.nodes.output.savedPath]
    .map(path => relative(run.outputDirectory, path)).sort();
  assert.equal(publication.fileCount, 5);
  assert.deepEqual(manifest.files.map(row => row.path).sort(), expected);
  for (const file of manifest.files) {
    assert.equal(typeof file.artifactId, 'string'); assert.equal(typeof file.attempt, 'number');
    assert.deepEqual(await readFile(join(publication.directory, file.path)), await readFile(join(run.outputDirectory, file.path)));
  }
  for (const file of [hidden.path, old.path, huge]) await assert.rejects(readFile(join(publication.directory, relative(run.outputDirectory, file))), { code: 'ENOENT' });
  assert.equal(await readFile(old.path, 'utf8'), 'old attempt bytes');
  assert.deepEqual(await files.publishRun(run.id), publication, 'an intact copy remains reusable with identical producer bindings');
});

test('modern runs without declared completed outputs fail actionably instead of copying the execution directory', async t => {
  const { files, run } = await fixture(t);
  run.document.nodes = run.document.nodes.filter(node => node.type !== 'output');
  await assert.rejects(files.publishRun(run.id), /没有明确的交付成果.*产物输出节点/);
  await assert.rejects(readFile(join(run.deliveryDirectory, '.workbench-delivery.json')), { code: 'ENOENT' });
  run.document = null;
  await assert.rejects(files.publishRun(run.id), /缺少完整的节点状态/);
  delete run.schemaVersion;
  await assert.rejects(files.publishRun(run.id), /缺少完整的节点状态/);
});

test('a plain text output publishes its own registered result without requiring file-valued input', async t => {
  const { files, run } = await fixture(t);
  run.document.nodes = run.document.nodes.filter(node => node.id === 'output');
  run.nodes.output.output = 'A useful final answer';
  const publication = await files.publishRun(run.id);
  assert.equal(publication.fileCount, 1);
  assert.deepEqual(await readFile(join(publication.directory, relative(run.outputDirectory, run.nodes.output.savedPath))), await readFile(run.nodes.output.savedPath));
  run.nodes.output.output = [1, 2, { description: 'ordinary JSON list' }];
  assert.deepEqual(await files.publishRun(run.id), publication, 'plain array data is not guessed to be a file declaration');
});

test('an explicitly declared old attempt is rejected even when inherited artifact metadata still contains it', async t => {
  const { files, run, old } = await fixture(t);
  run.nodes.output.output.artifacts = [{ path: old.path, sha256: old.sha256 }];
  await assert.rejects(files.publishRun(run.id), /不是生产节点当前已完成版本/);
});

test('declared hashes and byte sizes must match authoritative registration and current producer binding', async t => {
  const { files, run, zip } = await fixture(t);
  run.nodes.output.output.artifacts[0].sha256 = '0'.repeat(64);
  await assert.rejects(files.publishRun(run.id), /SHA 与登记产物不一致/);
  run.nodes.output.output.artifacts[0].sha256 = zip.sha256;
  run.nodes.output.output.artifacts[0].bytes = zip.size + 1;
  await assert.rejects(files.publishRun(run.id), /SHA 与登记产物不一致/);
  run.nodes.output.output.artifacts[0].bytes = zip.size;
  run.nodes.produce.artifacts = run.nodes.produce.artifacts.filter(item => item.id !== zip.id);
  await assert.rejects(files.publishRun(run.id), /当前节点的产物版本不一致/);
});

test('current artifact bytes are verified against registered SHA before any delivery directory is created', async t => {
  const { files, run, zip } = await fixture(t);
  await writeFile(zip.path, 'changed bytes');
  await assert.rejects(files.publishRun(run.id), /与已登记 SHA 不一致/);
  await assert.rejects(readFile(join(run.deliveryDirectory, '.workbench-delivery.json')), { code: 'ENOENT' });
});

test('registered artifacts cannot escape the run or be replaced through a file or ancestor symlink', async t => {
  const { files, run, zip, directory } = await fixture(t);
  const outside = join(directory, 'outside.zip'); await copyFile(zip.path, outside);
  await rm(zip.path); await symlink(outside, zip.path);
  await assert.rejects(files.publishRun(run.id), /符号链接/);
  await rm(zip.path); await copyFile(outside, zip.path);
  const sourceDirectory = run.nodes.produce.outputDirectory, moved = sourceDirectory + '-retained';
  await rename(sourceDirectory, moved); await symlink(moved, sourceDirectory);
  await assert.rejects(files.publishRun(run.id), /符号链接/);
  const forged = structuredClone(run), record = forged.nodes.output.artifacts.find(item => item.id === zip.id);
  record.path = outside; forged.nodes.output.output.artifacts = [{ path: outside }];
  assert.throws(() => selectDeliveryArtifacts(forged, id => id === zip.id ? { ...zip, path: outside } : files.getArtifact(id)), /超出当前生产节点目录/);
});

test('cross-run child references fail with guidance instead of copying files from an unrelated canonical root', async t => {
  const { files, run, zip } = await fixture(t);
  const other = { ...zip, runId: randomUUID() };
  run.nodes.output.output.artifacts = [{ artifactId: zip.id }];
  assert.throws(() => selectDeliveryArtifacts(run, id => id === zip.id ? other : files.getArtifact(id)), /其它运行.*本运行的产物节点归集/);
});

test('publication rechecks current output declarations and producer identity after copying', async t => {
  const { files, run } = await fixture(t);
  let changed = false;
  files.copyArtifact = async (source, target, flags) => {
    await copyFile(source, target, flags);
    if (!changed) { changed = true; run.nodes.output.output.artifacts.pop(); }
  };
  await assert.rejects(files.publishRun(run.id), /发布期间发生变化/);
  const failed = JSON.parse(await readFile(join(run.deliveryDirectory, '.workbench-delivery.json'), 'utf8'));
  assert.equal(failed.status, 'failed');
});

test('same-byte replacement registration cannot change producer binding unnoticed during publication', async t => {
  const { files, run, zip } = await fixture(t);
  let changed = false;
  files.copyArtifact = async (source, target, flags) => {
    await copyFile(source, target, flags);
    if (!changed) {
      changed = true;
      const replacement = await files.registerArtifact({ runId: run.id, nodeId: zip.nodeId, attempt: zip.attempt, path: zip.path });
      for (const state of Object.values(run.nodes)) state.artifacts = state.artifacts.map(item => item.id === zip.id ? replacement : item);
    }
  };
  await assert.rejects(files.publishRun(run.id), /发布期间发生变化/);
});
