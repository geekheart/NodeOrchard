import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat, realpath, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkflowFiles, imageDimensions } from '../src/workflows/workflow-files.mjs';
import { workflowInputFields } from '../shared/workflow/workflow-inputs.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=', 'base64');
const graph = fields => ({ schemaVersion: 2, id: 'files-fixture', title: '资料处理', settings: {},
  nodes: [{ id: 'entry', type: 'input', title: '输入资料', config: { fieldName: 'sources', fields } }] });

async function setup(t, { managed = false, copyArtifact } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-files-'));
  const db = new DatabaseSync(':memory:');
  const opened = [];
  const app = { config: { workspaceRoot: directory, appRoot: directory,
    ...(managed ? { workflowRunRoot: join(directory, 'Library', 'Application Support', 'Workbench', 'runs') } : {}) }, store: { db } };
  const files = new WorkflowFiles(app, { allowedRoots: [directory], openDirectory: async path => opened.push(path), ...(copyArtifact ? { copyArtifact } : {}) });
  t.after(async () => { db.close(); await rm(directory, { force: true, recursive: true }); });
  return { directory, db, files, opened, app, restart: () => new WorkflowFiles(app, { allowedRoots: [directory], openDirectory: async path => opened.push(path) }) };
}

test('structured inputs report every missing material without starting work or creating output directories', async t => {
  const { files, directory, db } = await setup(t);
  const document = graph([{ key: 'project', label: '工程文件', kind: 'file', required: true, extensions: ['.epro2'] },
    { key: 'back', label: '背面照片', kind: 'image', required: true }]);
  const result = await files.preflight({ document, input: { sources: {} } });
  assert.equal(result.ok, false); assert.equal(result.errors.length, 2);
  assert.deepEqual(result.errors.map(item => item.code), ['missing', 'missing']);
  assert.equal(db.prepare('SELECT COUNT(*) as count FROM workflow_file_runs').get().count, 0);
  await assert.rejects(readFile(join(directory, 'outputs', '资料处理', '输入清单.json')));
});

test('input admission binds real readable files, image dimensions and hashes and preserves falsy parameters', async t => {
  const { files, directory } = await setup(t);
  const photo = join(directory, 'front.png'), project = join(directory, 'board.epro2');
  await writeFile(photo, png); await writeFile(project, 'original');
  const document = graph([{ key: 'photo', label: '正面照片', kind: 'image', role: 'front', extensions: ['.PNG'] },
    { key: 'project', label: '工程', kind: 'file', extensions: ['.epro2'] },
    { key: 'count', label: '次数', kind: 'number' }]);
  const result = await files.preflight({ document, input: { photo, project, count: 0 } });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.input, { sources: { photo: await files.permitted(photo), project: await files.permitted(project), count: 0 } });
  assert.deepEqual(result.manifest.entries[0].image, { width: 1, height: 1, format: 'png' });
  assert.match(result.manifest.entries[1].sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.manifest.entries[0].role, 'front');
  assert.deepEqual(imageDimensions(Buffer.from('fake.png')), null);
});

test('file matches require exactly one actual file and fake images fail before execution', async t => {
  const { files, directory } = await setup(t);
  const document = graph([{ key: 'project', label: '工程', kind: 'file', match: '*.epro2', extensions: ['.epro2'] }]);
  assert.equal((await files.preflight({ document, input: directory })).errors[0].code, 'missing');
  await writeFile(join(directory, 'a.epro2'), 'a');
  assert.equal((await files.preflight({ document, input: directory })).ok, true);
  await writeFile(join(directory, 'b.epro2'), 'b');
  assert.equal((await files.preflight({ document, input: directory })).errors[0].code, 'ambiguous');
  const photo = join(directory, 'fake.png'); await writeFile(photo, 'not an image');
  assert.equal((await files.preflight({ document: graph([{ key: 'photo', label: '照片', kind: 'image' }]), input: photo })).ok, false);
});

test('matched folder bindings survive repeated preflight and freeze a unique file only at actual admission', async t => {
  const { files, directory } = await setup(t), sources = join(directory, 'sources'); await mkdir(sources);
  const path = join(sources, 'board.epro2'); await writeFile(path, 'project');
  const document = graph([{ key: 'project', label: '工程', kind: 'file', match: '*.epro2', extensions: ['.epro2'] }]);
  const first = await files.preflight({ document, input: sources });
  assert.equal(first.ok, true); assert.equal(first.input.sources.project, await files.permitted(sources));
  const repeated = await files.preflight({ document, input: first.input });
  assert.equal(repeated.ok, true); assert.deepEqual(repeated.input, first.input);
  const runId = randomUUID(), admitted = await files.prepareRun({ document, input: repeated.input, runId });
  assert.equal(admitted.input.sources.project, await files.permitted(path));
  assert.deepEqual(admitted.bindingInput, repeated.input);
  assert.equal((await files.verifyInputs(runId)).ok, true);
  await writeFile(join(sources, 'duplicate.epro2'), 'second project');
  assert.equal((await files.verifyInputs(runId)).ok, false);
  assert.equal((await files.preflight({ document, input: first.input })).errors[0].code, 'ambiguous');
  const explicit = await files.preflight({ document, input: path });
  assert.equal(explicit.ok, true, 'an explicit selected file is not an ambiguous directory binding');
  assert.equal((await files.preflight({ document, input: explicit.input })).ok, true);
});

test('each run freezes one manifest and source changes invalidate resume instead of silently reusing them', async t => {
  const { files, directory, restart } = await setup(t);
  const path = join(directory, 'input.txt'); await writeFile(path, 'first');
  const document = graph([{ key: 'file', label: '输入', kind: 'file' }]), runId = randomUUID();
  const prepared = await files.prepareRun({ document, input: path, runId });
  assert.equal(prepared.ok, true); assert(prepared.outputDirectory.endsWith(runId));
  assert.deepEqual(JSON.parse(await readFile(join(prepared.outputDirectory, '输入清单.json'), 'utf8')), prepared.manifest);
  assert.equal((await restart().verifyInputs(runId)).ok, true);
  await assert.rejects(files.prepareRun({ document, input: path, runId }), { httpStatus: 409 });
  await writeFile(path, 'second');
  assert.equal((await files.verifyInputs(runId)).ok, false);
});

test('folder inputs record a stable inventory and detect new files or changed files', async t => {
  const { files, directory } = await setup(t);
  const folder = join(directory, 'sources'); await mkdir(folder); await writeFile(join(folder, 'a.txt'), 'one');
  const runId = randomUUID();
  await files.prepareRun({ document: graph([{ key: 'folder', label: '资料', kind: 'folder' }]), input: folder, runId });
  assert.equal((await files.verifyInputs(runId)).ok, true);
  await writeFile(join(folder, 'b.txt'), 'two');
  assert.equal((await files.verifyInputs(runId)).ok, false);
});

test('custom output roots still isolate runs, nodes and revisions and never overwrite prior candidates', async t => {
  const { files, directory, opened } = await setup(t);
  const runId = randomUUID(), document = graph([]), custom = join(directory, '交付');
  const prepared = await files.prepareRun({ document, input: {}, runId, outputDirectory: custom });
  assert(prepared.outputDirectory.includes('交付'));
  const first = await files.nodeDirectory({ runId, nodeId: 'image', attempt: 1 });
  const second = await files.nodeDirectory({ runId, nodeId: 'image', attempt: 2 });
  assert.notEqual(first, second);
  await writeFile(join(first, 'image.png'), png); await writeFile(join(second, 'image.png'), png);
  await files.openRunDirectory({ runId, nodeId: 'image', attempt: 1 });
  assert.deepEqual(opened, [first]);
  await assert.rejects(files.nodeDirectory({ runId, nodeId: '../escape', attempt: 1 }));
});

test('opaque artifact registrations survive restart and hash-bind previews and approvals to their exact version', async t => {
  const { files, directory, restart } = await setup(t);
  const runId = randomUUID(); await files.prepareRun({ document: graph([]), input: {}, runId });
  const folder = await files.nodeDirectory({ runId, nodeId: 'draw', attempt: 1 }), path = join(folder, 'result.png');
  await writeFile(path, png);
  const record = await files.registerArtifact({ runId, nodeId: 'draw', path, role: 'pinout' });
  assert.equal(record.mimeType, 'image/png'); assert.equal(record.role, 'pinout'); assert.match(record.previewUrl, /artifacts\/[a-f0-9-]+$/);
  assert.deepEqual((await restart().readArtifact(record.id)).data, png);
  assert.equal((await files.verifyArtifacts([record])).ok, true);
  await writeFile(path, 'edited after review');
  await assert.rejects(files.readArtifact(record.id), { httpStatus: 409 });
  assert.equal((await files.verifyArtifacts([record])).ok, false);
  await writeFile(join(directory, 'unregistered.txt'), 'outside run');
  await assert.rejects(files.registerArtifact({ runId, nodeId: 'draw', path: join(directory, 'unregistered.txt') }), { httpStatus: 403 });
  await assert.rejects(files.readArtifact(join(directory, 'unregistered.txt')));
});

test('missing generated artifacts identify the output filename without registering a phantom artifact', async t => {
  const { files, db } = await setup(t);
  const runId = randomUUID(); await files.prepareRun({ document: graph([]), input: {}, runId });
  const folder = await files.nodeDirectory({ runId, nodeId: 'draw', attempt: 1 });
  await assert.rejects(files.registerArtifact({ runId, nodeId: 'draw', path: join(folder, 'interface_back.oim.json') }), error => {
    assert.equal(error.message, '登记产物「interface_back.oim.json」失败：路径不存在或无法访问。');
    assert.equal(error.httpStatus, 400);
    assert(!error.message.includes(folder));
    return true;
  });
  assert.equal(db.prepare('SELECT COUNT(*) as count FROM workflow_artifacts').get().count, 0);
});

test('artifact registration diagnostics preserve forbidden-path boundaries and sanitize filenames', async t => {
  const { files, directory, db } = await setup(t);
  const runId = randomUUID(); await files.prepareRun({ document: graph([]), input: {}, runId });
  const name = 'outside\n「injected」\u202e.json', path = join(directory, name);
  await writeFile(path, 'outside the current run');
  await assert.rejects(files.registerArtifact({ runId, nodeId: 'draw', path }), error => {
    assert.equal(error.httpStatus, 403);
    assert.equal(error.message, '登记产物「outside��injected��.json」失败：产物必须保存在本次运行的输出目录中。');
    assert(!error.message.includes(directory));
    assert(!/[\n\u202e]/u.test(error.message));
    return true;
  });
  assert.equal(db.prepare('SELECT COUNT(*) as count FROM workflow_artifacts').get().count, 0);
});

test('browser only lists allowed visible material directories and rejects hidden paths, symlinks and outside roots', async t => {
  const { files, directory } = await setup(t);
  await mkdir(join(directory, 'photos')); await mkdir(join(directory, '.secrets'));
  await writeFile(join(directory, 'photo.png'), png); await writeFile(join(directory, 'document.txt'), 'text');
  await writeFile(join(directory, '.env'), 'secret');
  await symlink(join(directory, '.secrets'), join(directory, 'alias'));
  const view = await files.browse({ directory, kind: 'image' });
  assert(view.entries.some(item => item.name === 'photos' && item.kind === 'folder'));
  assert.equal(view.entries.find(item => item.name === 'photo.png').selectable, true);
  assert.equal(view.entries.find(item => item.name === 'document.txt').selectable, false);
  assert(!view.entries.some(item => ['.env', '.secrets', 'alias'].includes(item.name)));
  await assert.rejects(files.browse({ directory: join(directory, 'alias') }), { httpStatus: 403 });
  await assert.rejects(files.browse({ directory: '/etc' }), { httpStatus: 403 });
  assert.equal((await files.browse()).entries.length, 0);
});

test('field schema excludes unsafe keys and retains legacy file source selectors', () => {
  assert.throws(() => workflowInputFields({ config: { fields: [{ key: '__proto__', label: 'bad', kind: 'file' }] } }));
  assert.throws(() => workflowInputFields({ config: { fields: [{ key: 'ok', label: 'bad', kind: 'file', match: '../*.txt' }] } }));
  assert.equal(workflowInputFields({ config: { sourceKind: 'image' } })[0].key, 'path');
});

test('managed runs freeze local originals separately from delivery folders and remain reusable as receipt inputs', async t => {
  const { files, directory, app, restart } = await setup(t, { managed: true });
  const runId = randomUUID(), deliveryRoot = join(directory, 'synced-deliveries');
  const prepared = await files.prepareRun({ document: graph([]), input: {}, runId, outputDirectory: deliveryRoot });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.errors));
  assert(prepared.outputDirectory.startsWith(await realpath(app.config.workflowRunRoot) + '/'));
  assert.equal(prepared.outputRoot, await files.permitted(deliveryRoot, { existing: false }));
  assert.notEqual(prepared.outputDirectory, prepared.deliveryDirectory);
  const folder = await files.nodeDirectory({ runId, nodeId: 'facts' }), receipt = join(folder, 'receipt.json');
  await writeFile(receipt, '{"source":"local-original"}');
  const next = await restart().preflight({ document: graph([{ key: 'receipt', label: '上次回执', kind: 'file', extensions: ['.json'] }]), input: receipt });
  assert.equal(next.ok, true, JSON.stringify(next.errors));
  assert.equal(next.input.sources.receipt, receipt);
  assert.equal((await restart().browse({ directory: folder })).entries.find(item => item.name === 'receipt.json').selectable, true);
  assert.deepEqual(restart().run(runId).outputDirectory, prepared.outputDirectory);
});

test('a new managed root outside ordinary browse roots is canonicalized before its first directory exists', async t => {
  const { directory, app } = await setup(t);
  const workspace = join(directory, 'workspace'); await mkdir(workspace);
  app.config.workflowRunRoot = join(directory, 'new-data', 'runs');
  app.config.workspaceRoot = workspace;
  const files = new WorkflowFiles(app, { allowedRoots: [workspace] });
  const prepared = await files.prepareRun({ document: graph([]), input: {}, runId: randomUUID() });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.errors));
  assert(prepared.outputDirectory.startsWith(await realpath(app.config.workflowRunRoot) + '/'));
});

test('managed Library root permission never opens sibling Library data, hidden children, credentials or symlink escapes', async t => {
  const { files, directory, app } = await setup(t, { managed: true });
  const runId = randomUUID(), prepared = await files.prepareRun({ document: graph([]), input: {}, runId });
  const hidden = join(prepared.outputDirectory, '.private'); await mkdir(hidden);
  await writeFile(join(prepared.outputDirectory, '.env'), 'credential');
  await writeFile(join(prepared.outputDirectory, 'credentials.json'), 'credential');
  const sibling = join(directory, 'Library', 'Other Application'); await mkdir(sibling, { recursive: true });
  const outside = join(directory, 'ordinary-source.txt'); await writeFile(outside, 'outside managed namespace');
  await symlink(outside, join(prepared.outputDirectory, 'escape.txt'));
  await symlink(hidden, join(prepared.outputDirectory, 'hidden-alias'));
  for (const path of [hidden, join(prepared.outputDirectory, '.env'), join(prepared.outputDirectory, 'credentials.json'), sibling,
    join(prepared.outputDirectory, 'escape.txt'), join(prepared.outputDirectory, 'hidden-alias')]) {
    await assert.rejects(files.permitted(path), { httpStatus: 403 });
  }
  await assert.rejects(files.permitted(join(app.config.workflowRunRoot, '..')), { httpStatus: 403 });
});

test('delivery copies have independent files and deletion cannot invalidate original previews, review hashes or restart reads', async t => {
  const { files, directory, restart, opened } = await setup(t, { managed: true });
  const runId = randomUUID(), prepared = await files.prepareRun({ document: graph([]), input: {}, runId, outputDirectory: join(directory, 'deliveries') });
  const folder = await files.nodeDirectory({ runId, nodeId: 'image' }), path = join(folder, 'image.png');
  await mkdir(join(folder, 'empty-template-directory'));
  await writeFile(path, png);
  await writeFile(join(folder, 'receipt.json'), JSON.stringify({ projectPath: path }));
  const record = await files.registerArtifact({ runId, nodeId: 'image', path });
  const publication = await files.publishRun(runId), delivered = join(publication.directory, 'image', '版本-1', 'image.png');
  assert.equal(publication.directory, prepared.deliveryDirectory);
  assert.notEqual((await stat(path)).ino, (await stat(delivered)).ino, 'delivery must not share a hard link with its original');
  assert.deepEqual(await readFile(delivered), png);
  assert.equal(JSON.parse(await readFile(join(publication.directory, 'image', '版本-1', 'receipt.json'), 'utf8')).projectPath, path);
  assert.equal((await stat(join(publication.directory, 'image', '版本-1', 'empty-template-directory'))).isDirectory(), true);
  assert.equal(JSON.parse(await readFile(publication.manifestPath, 'utf8')).status, 'complete');
  await files.openRunDirectory({ runId }); assert.equal(opened.at(-1), publication.directory);
  await files.openRunDirectory({ runId, kind: 'original' }); assert.equal(opened.at(-1), prepared.outputDirectory);
  await rm(publication.directory, { recursive: true });
  assert.deepEqual((await restart().readArtifact(record.id)).data, png);
  assert.equal((await restart().verifyArtifacts([record])).ok, true);
  assert.equal(restart().getArtifact(record.id).sha256, record.sha256);
  await restart().openRunDirectory({ runId }); assert.equal(opened.at(-1), prepared.outputDirectory);
  await restart().openRunDirectory({ runId, nodeId: 'image' }); assert.equal(opened.at(-1), folder);
});

test('publication reuses only intact matching copies and creates immutable revisions for reruns or removed copies', async t => {
  const { files, restart } = await setup(t, { managed: true });
  const runId = randomUUID(); await files.prepareRun({ document: graph([]), input: {}, runId });
  const first = await files.nodeDirectory({ runId, nodeId: 'render' }); await writeFile(join(first, 'result.txt'), 'first approved candidate');
  const one = await files.publishRun(runId);
  assert.deepEqual(await restart().publishRun(runId), one);
  const second = await files.nodeDirectory({ runId, nodeId: 'render', attempt: 2 }); await writeFile(join(second, 'result.txt'), 'second candidate');
  const two = await restart().publishRun(runId);
  assert.equal(two.revision, 2); assert.notEqual(two.directory, one.directory); assert.notEqual(two.fingerprint, one.fingerprint);
  assert.equal(await readFile(join(one.directory, 'render', '版本-1', 'result.txt'), 'utf8'), 'first approved candidate');
  await writeFile(join(two.directory, 'render', '版本-2', 'result.txt'), 'remote modification');
  const three = await restart().publishRun(runId);
  assert.equal(three.revision, 3); assert.notEqual(three.directory, two.directory);
  assert.equal(await readFile(join(three.directory, 'render', '版本-2', 'result.txt'), 'utf8'), 'second candidate');
  assert.equal(await readFile(join(two.directory, 'render', '版本-2', 'result.txt'), 'utf8'), 'remote modification');
  await rm(three.directory, { recursive: true });
  const four = await restart().publishRun(runId);
  assert.equal(four.revision, 4); assert.notEqual(four.directory, three.directory);
});

test('existing delivery conflicts preserve existing files and originals while explicit retry creates another revision', async t => {
  const { files, restart } = await setup(t, { managed: true });
  const runId = randomUUID(), prepared = await files.prepareRun({ document: graph([]), input: {}, runId });
  const source = join(await files.nodeDirectory({ runId, nodeId: 'draw' }), 'result.txt'); await writeFile(source, 'original');
  await mkdir(prepared.deliveryDirectory, { recursive: true });
  const existing = join(prepared.deliveryDirectory, 'existing.txt'); await writeFile(existing, 'do not overwrite');
  await assert.rejects(files.publishRun(runId), error => error.httpStatus === 409 && /未覆盖/.test(error.message));
  assert.equal(await readFile(existing, 'utf8'), 'do not overwrite'); assert.equal(await readFile(source, 'utf8'), 'original');
  await assert.rejects(readFile(join(prepared.deliveryDirectory, '.workbench-delivery.json')));
  const recovered = await restart().publishRun(runId);
  assert.equal(recovered.revision, 2); assert.equal(await readFile(existing, 'utf8'), 'do not overwrite');
});

test('a failed copy is explicitly marked incomplete and retry publishes safely without rerunning or changing originals', async t => {
  let fail = true;
  const { files, restart } = await setup(t, { managed: true, copyArtifact: async (source, target, flags) => {
    if (fail && source.endsWith('result.txt')) { fail = false; throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' }); }
    await copyFile(source, target, flags);
  } });
  const runId = randomUUID(), prepared = await files.prepareRun({ document: graph([]), input: {}, runId });
  const source = join(await files.nodeDirectory({ runId, nodeId: 'draw' }), 'result.txt'); await writeFile(source, 'original');
  await assert.rejects(files.publishRun(runId), /本机原件已保留.*simulated disk failure/);
  const failed = JSON.parse(await readFile(join(prepared.deliveryDirectory, '.workbench-delivery.json'), 'utf8'));
  assert.equal(failed.status, 'failed'); assert.equal(files.run(runId).publicationAttempts[0].status, 'failed');
  assert.equal(await readFile(source, 'utf8'), 'original');
  const result = await restart().publishRun(runId);
  assert.equal(result.revision, 2);
  assert.equal(await readFile(join(result.directory, 'draw', '版本-1', 'result.txt'), 'utf8'), 'original');
  assert.equal(JSON.parse(await readFile(join(prepared.deliveryDirectory, '.workbench-delivery.json'), 'utf8')).status, 'failed');
});

test('legacy runs without a managed store keep their original paths and do not publish another copy', async t => {
  const { files } = await setup(t); const runId = randomUUID();
  const prepared = await files.prepareRun({ document: graph([]), input: {}, runId });
  assert.equal(prepared.outputDirectory, prepared.deliveryDirectory);
  assert.equal(await files.publishRun(runId), null);
});
