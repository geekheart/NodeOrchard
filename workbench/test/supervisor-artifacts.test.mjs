import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, link, lstat, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SupervisorArtifacts } from '../src/supervisor-artifacts.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV5sAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'supervisor-artifact-'))), profile = { work: join(root, 'native', 'work'), profile: join(root, 'native', 'profile') }, dataDir = join(root, 'data'), topic = 'supervisor-one', turnId = 'turn-one';
  for (const path of [dataDir, join(profile.work, topic), join(profile.work, 'supervisor-other'), join(profile.profile, 'cache', 'images')]) await mkdir(path, { recursive: true });
  const turns = new Map([[topic + ':' + turnId, { id: turnId, conversationId: topic, status: 'thinking', assistant: { nativeArtifacts: [] } }]]); let lifecycle = 'active';
  const owner = { readTurn(id, conversationId) { const value = turns.get(conversationId + ':' + id); if (!value) throw Object.assign(Error('not owned'), { httpStatus: 404 }); return value; }, lifecycle: { project() { return { lifecycle }; } } };
  const service = new SupervisorArtifacts({ config: { dataDir } }, owner, { profile: () => profile });
  const publish = async path => { const value = await service.publish({ conversationId: topic, turnId, path }); turns.get(topic + ':' + turnId).assistant.nativeArtifacts.push(value); return value; };
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, profile, dataDir, topic, turnId, turns, owner, service, publish, archive() { lifecycle = 'archived'; }, current: () => turns.get(topic + ':' + turnId) };
}

test('published images are turn-bound immutable copies with public metadata and survive source edits and chat archival', async t => {
  const f = await fixture(t), path = join(f.profile.work, f.topic, 'poster.png'); await writeFile(path, png);
  const artifact = await f.publish(path);
  assert.equal(artifact.mimeType, 'image/png'); assert.equal(artifact.name, 'poster.png'); assert.equal(artifact.size, png.length);
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/); assert(!JSON.stringify(artifact).includes(f.root));
  assert.equal(artifact.url, `/api/app-assistant/conversations/${f.topic}/turns/${f.turnId}/artifacts/${artifact.id}`);
  await writeFile(path, 'source later changed'); f.archive(); f.current().status = 'complete';
  const read = await f.service.read(f.topic, f.turnId, artifact.id); assert.equal(read.mimeType, 'image/png'); assert.deepEqual(read.bytes, png); assert.equal(read.name, 'poster.png');
});

test('publishing the same source/hash is idempotent and never rewrites an existing delivered file', async t => {
  const f = await fixture(t), path = join(f.profile.profile, 'cache', 'images', 'generated.png'); await writeFile(path, png);
  const first = await f.publish(path), destination = join(f.dataDir, 'supervisor-deliveries', f.topic, f.turnId, first.id + '.blob'), before = await lstat(destination);
  const again = await f.publish(path), after = await lstat(destination);
  assert.deepEqual(again, first); assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
  await writeFile(path, 'new source bytes'); const changed = await f.publish(path); assert.notEqual(changed.id, first.id);
});

test('cross-topic paths, outside files, symlinks, hardlinks and oversized files cannot be published', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside.png'), foreign = join(f.profile.work, 'supervisor-other', 'foreign.png');
  await writeFile(outside, png); await writeFile(foreign, png);
  for (const path of [outside, foreign, join(f.profile.work, f.topic, '..', 'supervisor-other', 'foreign.png')]) await assert.rejects(f.service.publish({ conversationId: f.topic, turnId: f.turnId, path }));
  const linked = join(f.profile.work, f.topic, 'linked.png'); await symlink(outside, linked); await assert.rejects(f.publish(linked));
  const hard = join(f.profile.work, f.topic, 'hard.png'); await link(outside, hard); await assert.rejects(f.publish(hard));
  const large = join(f.profile.work, f.topic, 'large.bin'), file = await open(large, 'w'); await file.truncate(25 * 1024 * 1024 + 1); await file.close();
  await assert.rejects(f.publish(large), error => error.httpStatus === 413); assert.deepEqual(await readFile(outside), png);
});

test('only visible descriptors owned by the requested turn can be read and delivered bytes are hash checked', async t => {
  const f = await fixture(t), path = join(f.profile.work, f.topic, 'poster.png'); await writeFile(path, png); const artifact = await f.publish(path);
  await assert.rejects(f.service.read('supervisor-other', f.turnId, artifact.id));
  await assert.rejects(f.service.read(f.topic, 'foreign-turn', artifact.id));
  await assert.rejects(f.service.read(f.topic, f.turnId, 'artifact-' + '0'.repeat(64)), error => error.httpStatus === 404);
  const destination = join(f.dataDir, 'supervisor-deliveries', f.topic, f.turnId, artifact.id + '.blob'); await writeFile(destination, Buffer.alloc(png.length, 0));
  await assert.rejects(f.service.read(f.topic, f.turnId, artifact.id), error => error.httpStatus === 409);
});

test('file extensions never grant inline image content and HTML or SVG remain downloads', async t => {
  const f = await fixture(t);
  for (const [filename, content] of [['fake.png', '<script>alert(1)</script>'], ['drawing.svg', '<svg onload="alert(1)"></svg>'], ['result.txt', 'plain result']]) {
    const path = join(f.profile.work, f.topic, filename); await writeFile(path, content); const artifact = await f.publish(path);
    assert.equal(artifact.mimeType, 'application/octet-stream'); assert.equal((await f.service.read(f.topic, f.turnId, artifact.id)).mimeType, 'application/octet-stream');
  }
});

test('new publication requires an active writable turn while existing deliveries remain readable', async t => {
  const f = await fixture(t), path = join(f.profile.work, f.topic, 'poster.png'); await writeFile(path, png); const artifact = await f.publish(path);
  f.current().status = 'interrupted'; await assert.rejects(f.publish(path), error => error.httpStatus === 409);
  assert.deepEqual((await f.service.read(f.topic, f.turnId, artifact.id)).bytes, png);
  f.current().status = 'thinking'; f.archive(); await assert.rejects(f.publish(path), error => error.httpStatus === 409);
});

test('a forged descriptor URL or symlinked delivered blob cannot become an arbitrary file reader', async t => {
  const f = await fixture(t), path = join(f.profile.work, f.topic, 'poster.png'); await writeFile(path, png); const artifact = await f.publish(path), descriptor = f.current().assistant.nativeArtifacts[0];
  descriptor.url = 'https://example.invalid/file'; await assert.rejects(f.service.read(f.topic, f.turnId, artifact.id), error => error.httpStatus === 404);
  descriptor.url = artifact.url; const destination = join(f.dataDir, 'supervisor-deliveries', f.topic, f.turnId, artifact.id + '.blob'); await rm(destination); await symlink(path, destination);
  await assert.rejects(f.service.read(f.topic, f.turnId, artifact.id));
});
