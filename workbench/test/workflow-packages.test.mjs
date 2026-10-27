import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';
import { encodeZip, decodeZip } from '../src/workflows/workflow-zip.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(name) { this.calls.push(name); throw Error('Package tests never contact Hermes'); }
  async stop() {}
}
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(read) { for (let i = 0; i < 500; i++) { const value = read(); if (value) return value; await pause(); } assert.fail('Package fixture did not settle'); }
async function fixture(t, { run = true } = {}) {
  const directory = await mkdtemp('/private/tmp/workflow-package-');
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), port: 0 };
  const adapter = new Offline(), app = new Application(config, adapter); await app.workflowFoldersReady;
  app.captureModelRoute = async () => ({ provider: 'fixture', model: 'fixture-model' }); app.skills = async () => ({ skills: [] });
  app.assistantModel.generate = async (_prompt, options) => JSON.stringify(options.title === '应用对话 · 任务意图分类' ? { intent: 'discuss' } : { text: '原始完整聊天内容。' });
  t.after(async () => { await app.close(); assert.deepEqual(adapter.calls, []); await rm(directory, { recursive: true, force: true }); });
  const material = join(config.workspaceRoot, 'source.txt'); await writeFile(material, '独立素材内容');
  let document = createDocument({ schemaVersion: 2, title: '便携工作流' });
  document.nodes = [createNode('input', {}, { id: 'input', config: { outputType: 'object', fields: [{ key: 'file', label: '资料', kind: 'file', required: true }], defaultValue: { file: material } } }),
    createNode('tool', {}, { id: 'poster', config: { executionMode: 'code', language: 'javascript', inputType: 'object', outputType: 'object',
      code: "const fs = await import('node:fs/promises'); const content = await fs.readFile(input.file, 'utf8'); const path = context.outputDirectory + '/poster.svg'; await fs.writeFile(path, '<svg xmlns=\"http://www.w3.org/2000/svg\"><text>' + content + '</text></svg>'); return {path};" } }),
    createNode('human', {}, { id: 'review', config: { inputType: 'object', outputType: 'object', reviewTargetNodeId: 'poster' } }), createNode('output', {}, { id: 'output' })];
  for (let i = 1; i < document.nodes.length; i++) document = connectNodes(document, { sourceNode: document.nodes[i - 1].id, sourcePort: 'out', targetNode: document.nodes[i].id, targetPort: 'in' });
  const saved = app.workflowLibrary.save({ document, expectedRevision: 0 });
  const response = await app.conversations.message(document.id, { clientMessageId: crypto.randomUUID(), text: '请保留完整历史。', document, intent: 'auto' });
  await until(() => app.conversations.get(document.id).conversation.turns.find(turn => turn.id === response.turn.id)?.status === 'complete');
  const started = run ? await app.workflows.start({ document }) : null;
  if (started) await until(() => app.workflows.get(started.id).status === 'waiting_review');
  return { app, config, directory, document, saved, material, run: started && app.workflows.get(started.id) };
}

test('a real workflow folder ZIP roundtrip preserves messages and assets, isolates identities and never resumes imported reviews', async t => {
  const f = await fixture(t), before = structuredClone(f.app.workflows.get(f.run.id)), previous = f.app.workflowLibrary.get(f.document.id);
  const exported = await f.app.workflowPackages.export(f.document.id, { expectedRevision: previous.revision });
  assert.match(exported.filename, /\.workflow$/); assert.equal(exported.data.subarray(0, 4).toString('hex'), '504b0304');
  const names = decodeZip(exported.data).map(row => row.name); assert(names.includes('workflow.json')); assert(names.includes('conversation.json')); assert(names.some(name => name.startsWith('inputs/')));
  await rm(f.material);
  const operationId = crypto.randomUUID(), imported = await f.app.workflowPackages.import(exported.data, { filename: exported.filename, operationId });
  assert.notEqual(imported.workflow.id, f.document.id);
  const folder = f.app.workflowFolders.directory(imported.workflow.id), file = imported.workflow.document.nodes.find(n => n.type === 'input').config.defaultValue.file;
  assert.equal(f.app.workflowFolders.status(imported.workflow.id).inputSync.workflowId, imported.workflow.id);
  assert.equal(f.app.workflowFolders.status(imported.workflow.id).inputSync.status, 'complete');
  assert(file.startsWith(folder + '/')); assert.equal(await readFile(file, 'utf8'), '独立素材内容');
  const turns = f.app.conversations.get(imported.workflow.id).conversation.turns; assert.equal(turns.length, 1);
  assert.equal(turns[0].user.text, '请保留完整历史。'); assert.equal(turns[0].assistant.text, '原始完整聊天内容。'); assert.deepEqual(turns[0].actions, []);
  const history = f.app.workflows.list(imported.workflow.id); assert.equal(history.length, 1); assert.equal(history[0].importedArchive, true);
  const artifact = f.app.workflows.get(history[0].id).nodes.poster.artifacts[0];
  assert.notEqual(artifact.id, before.nodes.poster.artifacts[0].id); assert(artifact.path.startsWith(folder + '/'));
  assert.match((await f.app.workflowFiles.readArtifact(artifact.id)).data.toString(), /独立素材内容/);
  await assert.rejects(f.app.workflows.rerun(history[0].id, { nodeIds: ['poster'] }), /导入.*历史/);
  assert.throws(() => f.app.workflows.publishDelivery(history[0].id), /导入.*历史/);
  const repeated = await f.app.workflowPackages.import(exported.data, { filename: exported.filename, operationId }); assert.equal(repeated.workflow.id, imported.workflow.id);
  const secondPackage = await f.app.workflowPackages.export(imported.workflow.id, { expectedRevision: 1 }); assert(secondPackage.data.length > 0, 'an imported folder can be exported again without its source machine');
  assert.deepEqual(f.app.workflows.get(f.run.id), before); assert.deepEqual(f.app.workflowLibrary.get(f.document.id), previous);
  const fresh = await f.app.workflows.start({ document: imported.workflow.document });
  await until(() => f.app.workflows.get(fresh.id).status === 'waiting_review'); assert.notEqual(fresh.id, history[0].id);
  assert.match((await f.app.workflowFiles.readArtifact(f.app.workflows.get(fresh.id).nodes.poster.artifacts[0].id)).data.toString(), /独立素材内容/);
});

test('invalid packages and conflicting retry identities leave the workflow library and folders unchanged', async t => {
  const f = await fixture(t, { run: false }), exported = await f.app.workflowPackages.export(f.document.id, { expectedRevision: 1 });
  const before = f.app.workflowLibrary.list({ lifecycle: 'all' });
  await assert.rejects(f.app.workflowPackages.import(Buffer.from('not a zip'), { filename: 'bad.workflow', operationId: crypto.randomUUID() }));
  assert.throws(() => f.app.workflowPackages.import(exported.data, { filename: 'bad.zip', operationId: crypto.randomUUID() }), /\.workflow/);
  const broken = decodeZip(exported.data); broken.find(row => row.name === 'conversation.json').data = Buffer.from('{}');
  await assert.rejects(f.app.workflowPackages.import(encodeZip(broken), { filename: 'bad.workflow', operationId: crypto.randomUUID() }), /完整性/);
  assert.deepEqual(f.app.workflowLibrary.list({ lifecycle: 'all' }), before);
  const operationId = crypto.randomUUID(); await f.app.workflowPackages.import(exported.data, { filename: 'ok.workflow', operationId });
  assert.throws(() => f.app.workflowPackages.import(Buffer.from('different'), { filename: 'ok.workflow', operationId }), /相同导入请求/);
});

test('HTTP exports real ZIP bytes and imports only csrf-protected .workflow payloads, with a fixed folder opener', async t => {
  const f = await fixture(t, { run: false }), bridge = createWorkbenchServer(f.config, f.app), origin = await bridge.listen(); t.after(() => bridge.close());
  const bootstrap = await (await fetch(origin + '/api/bootstrap')).json(), headers = { 'X-Workbench-Token': bootstrap.csrfToken };
  const response = await fetch(origin + `/api/workflow-library/${f.document.id}/export?expectedRevision=1`);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /application\/zip/); assert.match(response.headers.get('content-disposition'), /\.workflow/);
  const data = Buffer.from(await response.arrayBuffer());
  let imported = await fetch(origin + '/api/workflow-packages/import?filename=test.workflow', { method: 'POST', body: data }); assert.equal(imported.status, 403);
  imported = await fetch(origin + '/api/workflow-packages/import?filename=test.workflow', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Workflow-Import-Id': crypto.randomUUID() }, body: data });
  assert.equal(imported.status, 201, JSON.stringify(await imported.clone().json()));
  const result = await imported.json(), opened = []; f.app.workflowFolders.openDirectory = async path => opened.push(path);
  const metadata = await (await fetch(origin + `/api/workflow-library/${result.workflow.id}/folder`)).json();
  assert.equal(metadata.inputSync.workflowId, result.workflow.id); assert.equal(metadata.inputSync.status, 'complete');
  const open = await fetch(origin + `/api/workflow-library/${result.workflow.id}/folder/open`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(open.status, 200); assert.deepEqual(opened, [f.app.workflowFolders.directory(result.workflow.id)]);
  assert.equal(f.app.workflows.list(result.workflow.id).length, 0);
});

test('a failed import rolls back the new index and extracted folder, and a concurrent retry registers one copy', async t => {
  const f = await fixture(t, { run: false }), exported = await f.app.workflowPackages.export(f.document.id, { expectedRevision: 1 });
  const before = f.app.workflowLibrary.list({ lifecycle: 'all' }), root = f.app.workflowFolders.root(), directories = await readdir(root), operationId = crypto.randomUUID();
  f.app.store.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON workflow_conversations BEGIN SELECT RAISE(ABORT,'isolated import failure'); END");
  await assert.rejects(f.app.workflowPackages.import(exported.data, { filename: exported.filename, operationId }), /isolated import failure/);
  assert.deepEqual(f.app.workflowLibrary.list({ lifecycle: 'all' }), before); assert.deepEqual(await readdir(root), directories);
  f.app.store.db.exec('DROP TRIGGER fail_import');
  const [first, repeated] = await Promise.all([f.app.workflowPackages.import(exported.data, { filename: exported.filename, operationId }), f.app.workflowPackages.import(exported.data, { filename: exported.filename, operationId })]);
  assert.equal(first.workflow.id, repeated.workflow.id); assert.equal(f.app.workflowLibrary.list({ lifecycle: 'all' }).length, before.length + 1);
});

test('the assistant discovers only its workflow folder and a download link without opening or exporting it', async t => {
  const f = await fixture(t, { run: false });
  const scope = await f.app.applicationAssistant.permissions.bind({ role: 'workflow', workflowId: f.document.id, document: f.document });
  const context = { permissionScope: scope, workflowId: f.document.id, document: f.document };
  f.app.workflowPackages.export = () => assert.fail('A discovery read must not package files');
  f.app.workflowFolders.openDirectory = () => assert.fail('A model must not open a native window');
  const result = await f.app.applicationAssistant.call('workflow.folder', {}, context);
  assert.equal(result.inputSync.workflowId, f.document.id);
  assert.equal(result.directory, f.app.workflowFolders.directory(f.document.id)); assert.match(result.export.url, /expectedRevision=1$/);
  await assert.rejects(f.app.applicationAssistant.call('workflow.folder', { workflowId: 'workflow-other' }, context), /当前工作流/);
  await assert.rejects(f.app.applicationAssistant.call('workflow.folder', { path: '/etc' }, context), /未知|字段/);
});
