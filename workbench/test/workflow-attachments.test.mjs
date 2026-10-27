import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkflowAttachments } from '../src/workflows/workflow-attachments.mjs';
import { WorkflowFolders } from '../src/workflows/workflow-folders.mjs';
import { WorkflowFiles } from '../src/workflows/workflow-files.mjs';
import { WorkflowLibrary } from '../src/workflows/workflow-library.mjs';
import { createDocument } from '../shared/workflow/workflow-model.mjs';

async function fixture(t) {
  const root = await mkdtemp('/private/tmp/workflow-attachments-'), workspaceRoot = join(root, 'workspace'); await mkdir(workspaceRoot);
  const db = new DatabaseSync(':memory:'), app = new EventEmitter();
  Object.assign(app, { config: { workspaceRoot, dataDir: join(root, 'data'), appRoot: join(root, 'application') }, store: { db }, publish() {} });
  app.workflowFiles = new WorkflowFiles(app, { allowedRoots: [root] }); app.workflowFolders = new WorkflowFolders(app);
  app.workflowLibrary = new WorkflowLibrary(app); app.workflowAttachments = new WorkflowAttachments(app);
  const document = createDocument({ schemaVersion: 2 });
  t.after(async () => { await app.workflowFolders.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  return { app, db, root, document, attachments: app.workflowAttachments };
}

test('uploads create content-addressed draft attachments, deduplicate bytes, bind retries and resolve only canonical identities', async t => {
  const f = await fixture(t), operationId = randomUUID(), data = Buffer.from('用户上传的完整原始资料');
  const first = await f.attachments.upload(f.document.id, { name: '需求.md', mimeType: 'text/markdown', operationId }, data);
  assert.equal(f.app.workflowLibrary.list().length, 0); assert.equal(first.workflowId, f.document.id);
  assert(first.path.startsWith(join(f.app.workflowFolders.directory(f.document.id), 'inputs', 'attachments')));
  assert.equal(await readFile(first.path, 'utf8'), data.toString()); assert(first.url.endsWith('/' + first.id + '/content'));
  assert.deepEqual(await f.attachments.upload(f.document.id, { name: '需求.md', mimeType: 'text/markdown', operationId }, data), first);
  const duplicate = await f.attachments.upload(f.document.id, { name: '相同内容.txt', mimeType: 'text/plain', operationId: randomUUID() }, data);
  assert.equal(duplicate.id, first.id); assert.equal(f.attachments.list(f.document.id).length, 1);
  await assert.rejects(f.attachments.upload(f.document.id, { name: '需求.md', mimeType: 'text/markdown', operationId }, Buffer.from('changed')), /相同|身份|重试/);
  const resolved = await f.attachments.resolve(f.document.id, [{ id: first.id, workflowId: f.document.id }]); assert.deepEqual(resolved, [first]);
  await assert.rejects(f.attachments.resolve(f.document.id, [{ ...first }]), /引用|字段/);
  await assert.rejects(f.attachments.resolve(f.document.id, [{ id: first.id, workflowId: 'foreign-workflow' }]), /当前|归属/);
  await assert.rejects(f.attachments.resolve('foreign-workflow', [{ id: first.id, workflowId: 'foreign-workflow' }]), /不存在|登记/);
  const read = await f.attachments.read(f.document.id, first.id, { offset: 0, limit: 8 });
  assert.equal(read.contentAvailable, true); assert.equal(read.truncated, true); assert(Buffer.byteLength(read.text) <= 10);
});

test('references retain owned paths and copy admitted outside files without following links or reading credentials', async t => {
  const f = await fixture(t), folder = f.app.workflowFolders.ensure(f.document.id), owned = join(folder, 'inputs', 'local.txt'); await writeFile(owned, 'own');
  const referenced = await f.attachments.reference(f.document.id, { path: owned, operationId: randomUUID() }); assert.equal(referenced.path, owned);
  const external = join(f.root, 'outside.txt'); await writeFile(external, 'copy'); const operationId = randomUUID();
  const copied = await f.attachments.reference(f.document.id, { path: external, operationId }); assert.notEqual(copied.path, external);
  const sameOwned = join(folder, 'inputs', 'same-bytes.txt'); await writeFile(sameOwned, 'copy');
  assert.equal((await f.attachments.reference(f.document.id, { path: sameOwned, operationId: randomUUID() })).path, sameOwned);
  assert.equal(await readFile(external, 'utf8'), 'copy'); await rm(external);
  assert.deepEqual(await f.attachments.reference(f.document.id, { path: external, operationId }), copied);
  const secret = join(f.root, 'credentials.json'); await writeFile(secret, 'PRIVATE');
  await assert.rejects(f.attachments.reference(f.document.id, { path: secret, operationId: randomUUID() }), /凭据|隐藏/);
  await symlink(owned, join(folder, 'inputs', 'linked.txt'));
  await assert.rejects(f.attachments.reference(f.document.id, { path: join(folder, 'inputs', 'linked.txt'), operationId: randomUUID() }), /符号链接/);
  await writeFile(copied.path, 'tampered'); await assert.rejects(f.attachments.resolve(f.document.id, [{ id: copied.id, workflowId: f.document.id }]), /变化|哈希|大小/);
});

test('attachment uploads enforce file names, limits, image bytes and lifecycle while keeping the registry unchanged on refusal', async t => {
  const f = await fixture(t);
  for (const name of ['../escape.txt', 'a/b.txt', 'bad\r\n.txt', '.env', 'credentials.json']) await assert.rejects(f.attachments.upload(f.document.id, { name, operationId: randomUUID() }, Buffer.from('x')), /名称|凭据|普通/);
  await assert.rejects(f.attachments.upload(f.document.id, { name: 'huge.bin', operationId: randomUUID() }, Buffer.alloc(32 * 1024 * 1024 + 1)), /32|大小/);
  await assert.rejects(f.attachments.upload(f.document.id, { name: 'fake.png', mimeType: 'image/png', operationId: randomUUID() }, Buffer.from('not png')), /图片/);
  assert.deepEqual(f.attachments.list(f.document.id), []);
  f.app.workflowLibrary.save({ document: f.document, expectedRevision: 0 }); f.app.workflowLibrary.transition(f.document.id, 'trash', { expectedRevision: 1 });
  await assert.rejects(f.attachments.upload(f.document.id, { name: 'blocked.txt', operationId: randomUUID() }, Buffer.from('x')), /回收站/);
});

test('portable attachment indices rebase paths and derive identities without reading their old machine paths', async t => {
  const f = await fixture(t), uploaded = await f.attachments.upload(f.document.id, { name: 'portable.txt', operationId: randomUUID() }, Buffer.from('portable'));
  const indexPath = join(f.app.workflowFolders.directory(f.document.id), 'inputs/attachments/index.json'), index = JSON.parse(await readFile(indexPath, 'utf8'));
  assert.equal(JSON.stringify(index).includes(uploaded.path), false);
  const another = createDocument({ schemaVersion: 2 }), folder = f.app.workflowFolders.ensure(another.id);
  await mkdir(join(folder, 'inputs/attachments'), { recursive: true }); await writeFile(join(folder, uploaded.relativePath), 'portable');
  f.app.workflowFolders.json(another.id, 'inputs/attachments/index.json', index);
  const imported = f.attachments.list(another.id)[0]; assert.notEqual(imported.id, uploaded.id); assert.equal(imported.workflowId, another.id);
  assert.equal(imported.path, join(folder, uploaded.relativePath));
  const resolved = await f.attachments.resolve(another.id, [{ id: uploaded.id, workflowId: another.id }]); assert.equal(resolved[0].id, imported.id);
  await f.attachments.upload(another.id, { name: 'new.txt', operationId: randomUUID() }, Buffer.from('new'));
  assert.equal((await f.attachments.resolve(another.id, [{ id: uploaded.id, workflowId: another.id }]))[0].id, imported.id);
});

test('concurrent attachment writes retain both receipts, freeze supplied bytes and drain before folder closure', { timeout: 2000 }, async t => {
  const f = await fixture(t); let release;
  f.app.workflowFolders.pending.set(f.document.id, new Promise(resolve => { release = resolve; }));
  const supplied = Buffer.from('original'), first = f.attachments.upload(f.document.id, { name: 'first.txt', operationId: randomUUID() }, supplied);
  supplied.fill(0);
  const second = f.attachments.upload(f.document.id, { name: 'second.txt', operationId: randomUUID() }, Buffer.from('second'));
  const closing = f.app.workflowFolders.close(); release();
  const [a, b] = await Promise.all([first, second]); await closing;
  assert.equal(f.attachments.list(f.document.id).length, 2); assert.notEqual(a.id, b.id);
  assert.equal(await readFile(a.path, 'utf8'), 'original'); assert.equal(await readFile(b.path, 'utf8'), 'second');
  assert.equal(f.app.workflowFolders.pending.size, 0);
  await assert.rejects(f.attachments.upload(f.document.id, { name: 'late.txt', operationId: randomUUID() }, Buffer.from('late')), /关闭/);
});
