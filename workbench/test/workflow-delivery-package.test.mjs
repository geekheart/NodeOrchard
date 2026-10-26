import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { WorkflowFiles } from '../src/workflows/workflow-files.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, mutate = () => {}, { packageAtCwd = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-declared-package-')), db = new DatabaseSync(':memory:');
  const app = { config: { workspaceRoot: directory, appRoot: directory, workflowRunRoot: join(directory, 'local-runs') }, store: { db } };
  const files = new WorkflowFiles(app, { allowedRoots: [directory] });
  const document = { schemaVersion: 2, id: 'package-fixture', title: 'Manifest package fixture', settings: {}, nodes: [
    { id: 'produce', type: 'tool', title: 'Portable package', config: {} }, { id: 'output', type: 'output', title: 'Final output', config: {} },
  ] };
  const id = randomUUID(), prepared = await files.prepareRun({ document, input: {}, runId: id });
  const producerRoot = await files.nodeDirectory({ runId: id, nodeId: 'produce' }), outputRoot = await files.nodeDirectory({ runId: id, nodeId: 'output' });
  const packagePath = packageAtCwd ? producerRoot : join(producerRoot, 'portable-guide'); await mkdir(packagePath, { recursive: true });
  const entries = [ ['guide.zh.md', '[English](guide.en.md)\n![front](img/front.svg)\n[notes](sources/notes.txt)'],
    ['guide.en.md', '[中文](guide.zh.md)\n![front](img/front.svg)'], ['img/front.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'], ['sources/notes.txt', 'frozen attachment bytes'] ];
  for (const [name, bytes] of entries) { const path = join(packagePath, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
  await writeFile(join(packagePath, 'unlisted-cache.txt'), 'not part of the package contract');
  const manifest = { schemaVersion: 1, files: entries.map(([path, bytes]) => ({ source: '/not-readable/external-origin/' + path,
    path, sha256: path.endsWith('.md') ? sha('original pre-relocation text') : sha(bytes), bytes: Buffer.byteLength(bytes),
    ...(path.endsWith('.md') ? { deliveredSha256: sha(bytes) } : {}) })), localLinkClosure: {
    entrypoints: ['guide.zh.md', 'guide.en.md'], documents: ['guide.zh.md', 'guide.en.md'], links: [
      { document: 'guide.zh.md', target: 'guide.en.md' }, { document: 'guide.zh.md', target: 'img/front.svg' },
      { document: 'guide.zh.md', target: 'sources/notes.txt' }, { document: 'guide.en.md', target: 'guide.zh.md' }, { document: 'guide.en.md', target: 'img/front.svg' },
    ],
  } };
  mutate(manifest);
  const manifestPath = join(packagePath, 'package-manifest.json'); await writeFile(manifestPath, JSON.stringify(manifest));
  const registered = [];
  for (const [path, role] of [[join(packagePath, 'guide.zh.md'), 'guide-zh'], [join(packagePath, 'guide.en.md'), 'guide-en'], [manifestPath, 'package-manifest']]) {
    registered.push(await files.registerArtifact({ runId: id, nodeId: 'produce', path, role }));
  }
  const value = { packagePath, artifacts: registered.map(item => ({ path: item.path, sha256: item.sha256, bytes: item.size, role: item.role })) };
  const savedPath = join(outputRoot, 'result.json'); await writeFile(savedPath, JSON.stringify(value));
  const saved = await files.registerArtifact({ runId: id, nodeId: 'output', path: savedPath });
  const run = { ...prepared, id, schemaVersion: 2, document, nodes: {
    produce: { status: 'complete', attempt: 1, outputDirectory: producerRoot, output: value, artifacts: registered },
    output: { status: 'complete', attempt: 1, outputDirectory: outputRoot, output: value, savedPath, artifacts: [...registered, saved] },
  } };
  app.workflows = { get: runId => { assert.equal(runId, id); return structuredClone(run); } };
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, files, run, entries, manifest, manifestPath, packagePath, directory };
}

test('a current registered manifest expands the explicit package, honors delivered SHA and closes every local document link', async t => {
  const { files, run, entries, packagePath, manifest } = await fixture(t);
  const publication = await files.publishRun(run.id), portable = join(publication.directory, relative(run.outputDirectory, packagePath));
  assert.equal(publication.fileCount, 6);
  for (const [path, bytes] of entries) assert.equal(await readFile(join(portable, path), 'utf8'), bytes);
  for (const link of manifest.localLinkClosure.links) await readFile(join(portable, link.target));
  await assert.rejects(readFile(join(portable, 'unlisted-cache.txt')), { code: 'ENOENT' });
  const published = JSON.parse(await readFile(publication.manifestPath, 'utf8'));
  const note = published.files.find(item => item.packageEntry === 'sources/notes.txt');
  assert(note.manifestArtifactId); assert.equal(note.manifestSha256, sha(await readFile(join(packagePath, 'package-manifest.json'))));
  assert.deepEqual(await files.publishRun(run.id), publication);
});

test('a producer cwd can be a declared manifest package without permitting the whole run root', async t => {
  const { files, run, packagePath } = await fixture(t, () => {}, { packageAtCwd: true });
  assert.equal(packagePath, run.nodes.produce.outputDirectory);
  assert.equal((await files.publishRun(run.id)).fileCount, 6);
  run.nodes.output.output.packagePath = run.outputDirectory;
  await assert.rejects(files.publishRun(run.id), /packagePath 必须位于本次运行的当前生产目录内/);
});

for (const [name, mutate, message] of [
  ['traversal', m => { m.files[2].path = '../escape.txt'; }, /无效相对路径/],
  ['absolute path', m => { m.files[2].path = '/outside.txt'; }, /无效相对路径/],
  ['duplicate member', m => { m.files.push({ ...m.files[2] }); }, /重复文件路径/],
  ['missing closure target', m => { m.localLinkClosure.links.push({ document: 'guide.zh.md', target: 'not-listed.txt' }); }, /引用目标未包含/],
  ['wrong delivered hash', m => { m.files[0].deliveredSha256 = sha('incorrect final text'); }, /显式登记产物的 SHA/],
  ['wrong member size', m => { m.files[2].bytes++; }, /已登记 SHA 不一致/],
]) {
  test('package publication rejects ' + name + ' without silently falling back to an incomplete loose-file delivery', async t => {
    const { files, run } = await fixture(t, mutate);
    await assert.rejects(files.publishRun(run.id), message);
    await assert.rejects(readFile(join(run.deliveryDirectory, '.workbench-delivery.json')), { code: 'ENOENT' });
  });
}

test('package members reject symlink escapes and changed manifest bytes', async t => {
  const { files, run, packagePath, directory, manifestPath } = await fixture(t);
  const member = join(packagePath, 'sources/notes.txt'), outside = join(directory, 'outside.txt');
  await copyFile(member, outside); await rm(member); await symlink(outside, member);
  await assert.rejects(files.publishRun(run.id), /符号链接/);
  await rm(member); await copyFile(outside, member); await writeFile(manifestPath, '{}');
  await assert.rejects(files.publishRun(run.id), /产物内容已变化/);
});

test('package publication requires a current explicitly registered manifest and rechecks it after copy', async t => {
  const { files, run, manifestPath } = await fixture(t);
  const role = run.nodes.produce.artifacts.at(-1).role;
  const declarations = run.nodes.output.output.artifacts;
  run.nodes.output.output.artifacts = run.nodes.output.output.artifacts.filter(item => item.role !== role);
  await assert.rejects(files.publishRun(run.id), /缺少唯一.*package-manifest/);
  run.nodes.output.output.artifacts = declarations;
  let changed = false;
  files.copyArtifact = async (source, target, flags) => { await copyFile(source, target, flags); if (!changed) { changed = true; await writeFile(manifestPath, '{}'); } };
  await assert.rejects(files.publishRun(run.id), /SHA 不一致|产物内容已变化|已登记 SHA 不一致/);
});
