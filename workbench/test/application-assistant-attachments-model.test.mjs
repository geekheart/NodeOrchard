import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { LearningModel } from '../src/workflows/learning-model.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=', 'base64');
const policy = { toolsAllowed: false, skillMutationBlocked: true, memoryAllowed: false, memoryWriteAllowed: false,
  applicationTools: 'broker-only', sourceMutationBlocked: true };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-attachment-model-')), db = new DatabaseSync(':memory:');
  const app = new EventEmitter(), calls = [], submitted = [];
  app.store = { db }; app.config = { dataDir: join(directory, 'data'), workspaceRoot: join(directory, 'workspace') };
  app.workflowFolders = { directory: id => join(app.config.workspaceRoot, 'workflows', id) };
  const attachmentRoot = app.workflowFolders.directory('workflow-fixture'); await mkdir(join(attachmentRoot, 'inputs'), { recursive: true });
  const image = join(attachmentRoot, 'inputs', 'reference.png'); await writeFile(image, png);
  app.createSession = async () => ({ id: 'local-session', runtimeSessionId: 'runtime-session' });
  app.interrupt = async () => {};
  app.adapter = { request: async (method, args) => { calls.push({ method, args }); return method.endsWith('.images') ? { attached: args.images.length, mode: 'native-content' } : { policy }; } };
  app.history = async () => ({ messages: [{ role: 'assistant', text: '模型回复' }] });
  app.submit = async (...args) => { submitted.push(args); app.emit('event', { type: 'message.complete', sessionId: 'local-session', payload: { status: 'complete' } }); };
  const model = new LearningModel(app, { purpose: 'assistant' });
  t.after(async () => { await model.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, model, calls, submitted, attachmentRoot, image, directory };
}

test('workflow user images reach the existing native-content gate as bounded temporary diagnostic copies', async t => {
  const f = await fixture(t), request = f.app.adapter.request; let staged;
  f.app.adapter.request = async (method, args) => {
    if (method.endsWith('.images')) {
      staged = args.images[0]; assert.notEqual(staged, f.image);
      const part = relative(join(f.app.config.dataDir, 'diagnostics'), staged);
      assert(!part.startsWith('..') && !isAbsolute(part)); assert.deepEqual(await readFile(staged), png);
    }
    return request(method, args);
  };
  assert.equal(await f.model.generate('请看附件图', { userImages: [f.image], attachmentRoot: f.attachmentRoot }), '模型回复');
  assert.deepEqual(f.calls.map(row => row.method), ['workbench.assistant.prepare', 'workbench.assistant.images']);
  assert.equal(f.calls[1].args.session_id, 'runtime-session'); assert.equal(f.submitted.length, 1);
  await assert.rejects(readFile(staged), { code: 'ENOENT' }); assert.deepEqual(await readFile(f.image), png);
  assert.deepEqual(await readdir(join(f.app.config.dataDir, 'diagnostics')), []);
});

test('user references precede unchanged diagnostic paths and the combined batch never exceeds four', async t => {
  const f = await fixture(t), diagnostic = '/private/diagnostics/capture.png';
  await f.model.generate('对照资料和截图', { userImages: [f.image], attachmentRoot: f.attachmentRoot, images: [diagnostic] });
  assert.equal(f.calls[1].args.images.length, 2); assert.equal(f.calls[1].args.images[1], diagnostic);
  const before = f.calls.length;
  await assert.rejects(f.model.generate('不要超限提交', { userImages: [f.image], attachmentRoot: f.attachmentRoot, images: [diagnostic, diagnostic, diagnostic, diagnostic] }), /图像输入无效/);
  assert.equal(f.calls.length, before); assert.equal(f.submitted.length, 1);
});

test('workflow materials reject another workflow, symlinks, wrong formats and oversized images before submission', async t => {
  for (const kind of ['outside', 'symlink', 'directory-symlink', 'invalid', 'oversized', 'unbound-root']) {
    await t.test(kind, async sub => {
      const f = await fixture(sub); let image = f.image, attachmentRoot = f.attachmentRoot;
      if (kind === 'outside') { image = join(f.directory, 'outside.png'); await writeFile(image, png); }
      if (kind === 'symlink') { image = join(f.attachmentRoot, 'linked.png'); await symlink(f.image, image); }
      if (kind === 'directory-symlink') { const link = join(f.attachmentRoot, 'linked'); await symlink(join(f.attachmentRoot, 'inputs'), link); image = join(link, 'reference.png'); }
      if (kind === 'invalid') await writeFile(image, 'not image bytes');
      if (kind === 'oversized') await writeFile(image, Buffer.alloc(8 * 1024 * 1024 + 1));
      if (kind === 'unbound-root') attachmentRoot = join(f.attachmentRoot, 'inputs');
      await assert.rejects(f.model.generate('检查附件', { userImages: [image], attachmentRoot }), /附件|图像/);
      assert.deepEqual(f.submitted, []); assert.equal(f.calls.some(call => call.method.endsWith('.images')), false);
    });
  }
});

test('native image rejection cleans temporary material without falling back to a path-only prompt', async t => {
  const f = await fixture(t), request = f.app.adapter.request; let staged;
  f.app.adapter.request = async (method, args) => {
    if (!method.endsWith('.images')) return request(method, args);
    staged = args.images[0]; assert.deepEqual(await readFile(staged), png); return { attached: 0, mode: 'text-path' };
  };
  await assert.rejects(f.model.generate('看图', { userImages: [f.image], attachmentRoot: f.attachmentRoot }), /未确认接收附件图像/);
  await assert.rejects(readFile(staged), { code: 'ENOENT' }); assert.deepEqual(f.submitted, []);
  assert.deepEqual(await readFile(f.image), png);
});

test('cancel during image admission cleans staged copies after a late ACK and never submits inference', async t => {
  const f = await fixture(t), request = f.app.adapter.request, controller = new AbortController(); let staged, release;
  let entered; const admission = new Promise(resolve => { entered = resolve; });
  f.app.adapter.request = async (method, args) => {
    if (!method.endsWith('.images')) return request(method, args);
    staged = args.images[0]; entered(); return new Promise(resolve => { release = () => resolve({ attached: 1, mode: 'native-content' }); });
  };
  const pending = f.model.generate('取消看图', { userImages: [f.image], attachmentRoot: f.attachmentRoot, signal: controller.signal });
  pending.catch(() => {}); await admission; controller.abort(); await assert.rejects(pending, /停止/); release();
  for (let index = 0; index < 100 && (await readdir(join(f.app.config.dataDir, 'diagnostics'))).length; index++) await new Promise(resolve => setTimeout(resolve, 2));
  await assert.rejects(readFile(staged), { code: 'ENOENT' }); assert.deepEqual(f.submitted, []);
});

test('JPEG, WebP and GIF references use the same staging gate while learning calls remain image-free', async t => {
  const f = await fixture(t);
  for (const bytes of [Buffer.from([255, 216, 255, 0]), Buffer.from('RIFF0000WEBPdata'), Buffer.from('GIF89asingle-image')]) {
    await writeFile(f.image, bytes); await f.model.generate('查看参考', { userImages: [f.image], attachmentRoot: f.attachmentRoot });
  }
  assert.equal(f.submitted.length, 3);
  const learning = new LearningModel(f.app); t.after(() => learning.close());
  await assert.rejects(learning.generate('评价', { userImages: [f.image], attachmentRoot: f.attachmentRoot }), /图像输入无效/);
});

test('source snapshots obey a cumulative byte limit and a linked workflow parent cannot redirect material reads', async t => {
  const f = await fixture(t), large = Buffer.alloc(8 * 1024 * 1024); png.copy(large);
  await writeFile(f.image, large);
  await assert.rejects(f.model.generate('超过附件累计大小', { userImages: [f.image, f.image, f.image], attachmentRoot: f.attachmentRoot }), /16 MiB/);
  assert.deepEqual(f.submitted, []); assert.equal(f.calls.some(call => call.method.endsWith('.images')), false);
  const redirected = join(f.directory, 'redirected'); await mkdir(join(redirected, 'workflow-fixture', 'inputs'), { recursive: true });
  await writeFile(join(redirected, 'workflow-fixture', 'inputs', 'reference.png'), png);
  await rm(join(f.app.config.workspaceRoot, 'workflows'), { recursive: true });
  await symlink(redirected, join(f.app.config.workspaceRoot, 'workflows'));
  await assert.rejects(f.model.generate('不读取链接目录', { userImages: [f.image], attachmentRoot: f.attachmentRoot }), /链接|目录/);
  assert.deepEqual(f.submitted, []);
});
