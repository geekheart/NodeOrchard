import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode } from '../shared/workflow/workflow-model.mjs';
import { encodeZip, decodeZip } from '../src/workflows/workflow-zip.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV3sAAAAASUVORK5CYII=', 'base64');
class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(name) { this.calls.push(name); throw Error('Attachment package tests never contact Hermes'); }
  async stop() {}
}
async function fixture(t) {
  const directory = await mkdtemp('/private/tmp/workflow-attachment-package-'), adapter = new Offline();
  const app = new Application(readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), adapter);
  t.after(async () => { await app.close(); assert.deepEqual(adapter.calls, []); await rm(directory, { recursive: true, force: true }); });
  await app.workflowFoldersReady;
  const document = createDocument({ schemaVersion: 2 }), source = join(app.config.workspaceRoot, 'external-note.txt'); await writeFile(source, '独立文件的完整内容。');
  const text = await app.workflowAttachments.reference(document.id, { path: source, operationId: randomUUID() });
  const image = await app.workflowAttachments.upload(document.id, { name: '参考图片.png', mimeType: 'image/png', operationId: randomUUID() }, png);
  document.nodes = [createNode('input', {}, { id: 'input', config: { sourceKind: 'file', defaultValue: text.path } })];
  app.workflowLibrary.save({ document, expectedRevision: 0 });
  app.applicationAssistant.intentClassifier.classify = async () => ({ intent: 'discuss', modelCalls: 0, modelRoute: { provider: 'fixture', model: 'fixture' } });
  app.captureModelRoute = async () => ({ provider: 'fixture', model: 'fixture' }); app.assistantModel.generate = async () => JSON.stringify({ text: '这两份资料已作为参考保留。' });
  await app.conversations.message(document.id, { clientMessageId: randomUUID(), text: '阅读这两份资料。', document,
    attachments: [text, image].map(({ id, workflowId }) => ({ id, workflowId })) });
  for (let count = 0; count < 500; count++) { const turn = app.conversations.get(document.id).conversation.turns.at(-1); if (turn.status !== 'thinking') { assert.equal(turn.status, 'complete'); break; } await new Promise(resolve => setImmediate(resolve)); if (count === 499) assert.fail('Chat fixture did not settle'); }
  return { app, document, text, image, source };
}
function mutate(data, action) {
  const entries = decodeZip(data); action(entries);
  const manifest = entries.find(row => row.name === 'workflow-package.json'), value = JSON.parse(manifest.data);
  value.files = entries.filter(row => !row.name.endsWith('/') && row.name !== manifest.name).map(row => ({ name: row.name, size: row.data.length, sha256: sha(row.data) }));
  manifest.data = Buffer.from(JSON.stringify(value)); return encodeZip(entries);
}
function changeJson(entries, name, action) { const entry = entries.find(row => row.name === name), value = JSON.parse(entry.data); action(value); entry.data = Buffer.from(JSON.stringify(value)); }

test('a real ZIP round trip preserves registered chat images and files, rebases their identities and node defaults, and never restores old operations', async t => {
  const f = await fixture(t), exported = await f.app.workflowPackages.export(f.document.id, { expectedRevision: 1 });
  await rm(f.source); await rm(f.app.workflowFolders.directory(f.document.id), { recursive: true });
  const imported = await f.app.workflowPackages.import(exported.data, { filename: exported.filename, operationId: randomUUID() });
  const folder = f.app.workflowFolders.directory(imported.workflow.id), turn = f.app.conversations.get(imported.workflow.id).conversation.turns[0];
  assert.equal(turn.user.attachments.length, 2); assert.equal(turn.user.text, '阅读这两份资料。'); assert.deepEqual(turn.actions, []);
  assert.equal(turn.user.attachments[0].workflowId, imported.workflow.id); assert.notEqual(turn.user.attachments[0].id, f.text.id);
  assert.equal(turn.user.attachments[1].sha256, f.image.sha256); assert(turn.user.attachments.every(item => item.path.startsWith(folder + '/') && item.url.includes(imported.workflow.id)));
  assert.equal((await f.app.workflowAttachments.read(imported.workflow.id, turn.user.attachments[0].id)).text, '独立文件的完整内容。');
  assert.deepEqual((await f.app.workflowAttachments.content(imported.workflow.id, turn.user.attachments[1].id)).data, png);
  assert.equal(imported.workflow.document.nodes[0].config.defaultValue, turn.user.attachments[0].path);
  const registry = JSON.parse(await readFile(join(folder, 'inputs/attachments/index.json'), 'utf8'));
  assert.equal(registry.workflowId, imported.workflow.id); assert.deepEqual(registry.operations, []);
  const origins = (await readdir(join(folder, 'history'))).filter(name => name.startsWith('import-'));
  assert((await readdir(join(folder, 'history', origins[0]))).includes('inputs-attachments-index.json'));
  const again = await f.app.workflowPackages.export(imported.workflow.id, { expectedRevision: 1 }); assert(again.data.length > 0);
});

test('package attachment validation rejects foreign or unregistered chat refs and unsafe or missing indexed files before registering a workflow', async t => {
  const f = await fixture(t), exported = await f.app.workflowPackages.export(f.document.id, { expectedRevision: 1 });
  const before = f.app.workflowLibrary.list().map(item => item.id);
  const changes = [
    entries => changeJson(entries, 'conversation.json', value => { value.turns[0].user.attachments[0].workflowId = 'workflow-foreign'; }),
    entries => changeJson(entries, 'conversation.json', value => { value.turns[0].user.attachments[0].id = 'attachment-unregistered'; value.turns[0].user.attachments[0].relativePath = f.image.relativePath; }),
    entries => changeJson(entries, 'conversation.json', value => { value.turns[0].user.attachments[0].relativePath = f.image.relativePath; }),
    entries => changeJson(entries, 'inputs/attachments/index.json', value => { value.entries[0].relativePath = '../escape.txt'; }),
    entries => changeJson(entries, 'inputs/attachments/index.json', value => { value.entries[0].relativePath = 'inputs/attachments/absent.txt'; }),
    entries => changeJson(entries, 'inputs/attachments/index.json', value => { value.entries[0].sha256 = 'a'.repeat(64); }),
  ];
  for (const change of changes) await assert.rejects(f.app.workflowPackages.import(mutate(exported.data, change), { filename: 'changed.workflow', operationId: randomUUID() }), /素材|附件|登记|索引|引用|当前工作流/);
  assert.deepEqual(f.app.workflowLibrary.list().map(item => item.id), before);
});

test('export refuses a concurrently incomplete attachment snapshot rather than emitting an unusable package', async t => {
  const f = await fixture(t), entries = f.app.workflowPackages.entries.bind(f.app.workflowPackages);
  f.app.workflowPackages.entries = async folder => (await entries(folder)).filter(entry => entry.name !== f.image.relativePath);
  await assert.rejects(f.app.workflowPackages.export(f.document.id, { expectedRevision: 1 }), /素材|附件|完整/);
});
