import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkflowFolders } from '../src/workflows/workflow-folders.mjs';
import { WorkflowLibrary } from '../src/workflows/workflow-library.mjs';
import { WorkflowFiles } from '../src/workflows/workflow-files.mjs';
import { WorkflowPackages } from '../src/workflows/workflow-packages.mjs';
import { decodeZip } from '../src/workflows/workflow-zip.mjs';
import { createDocument, createNode } from '../shared/workflow/workflow-model.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  const root = await mkdtemp('/private/tmp/workflow-folders-'), workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot); const db = new DatabaseSync(':memory:'), app = new EventEmitter();
  Object.assign(app, { config: { workspaceRoot, appRoot: root, dataDir: join(root, 'data'), workflowRunRoot: join(root, 'originals') }, store: { db }, publish() {} });
  db.exec(`CREATE TABLE workflow_runs(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE workflow_learning(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE workflow_conversations(workflow_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
    CREATE TABLE workflow_conversation_turns(id TEXT PRIMARY KEY,workflow_id TEXT,client_message_id TEXT,created_at TEXT,value TEXT,private_value TEXT);`);
  const opened = []; app.workflowFiles = new WorkflowFiles(app, { allowedRoots: [root] });
  app.workflowLibrary = new WorkflowLibrary(app); app.workflowFolders = new WorkflowFolders(app, { openDirectory: async path => opened.push(path) });
  const document = createDocument({ schemaVersion: 2, title: '独立工作流' });
  const save = doc => app.workflowLibrary.save({ document: doc, expectedRevision: 0 });
  const put = (table, value) => db.prepare(`INSERT INTO ${table}(id,value) VALUES(?,?)`).run(value.id, JSON.stringify(value));
  t.after(async () => { await app.workflowFolders.close?.(); db.close(); await rm(root, { recursive: true, force: true }); });
  return { app, db, root, workspaceRoot, opened, document, save, put };
}

test('saving and revising one workflow materializes its own record and stale mirrors cannot overwrite newer revisions', async t => {
  const f = await fixture(t), first = f.save(f.document), folder = f.app.workflowFolders.directory(first.id);
  assert.equal(folder, join(f.workspaceRoot, 'workflows', first.id));
  let saved = JSON.parse(await readFile(join(folder, 'workflow.json'), 'utf8'));
  assert.equal(saved.document.title, '独立工作流'); assert.equal(saved.revision, 1);
  const second = f.app.workflowLibrary.save({ document: { ...first.document, title: '更新名称' }, expectedRevision: 1 });
  f.app.workflowFolders.syncDocument(first);
  saved = JSON.parse(await readFile(join(folder, 'workflow.json'), 'utf8'));
  assert.equal(saved.revision, second.revision); assert.equal(saved.document.title, '更新名称');
  const other = f.save(createDocument({ title: '同名也独立' })); assert.notEqual(f.app.workflowFolders.directory(other.id), folder);
});

test('saving selected inputs collects them before opening, and unrelated or identical saves do not repeat the copy', async t => {
  const f = await fixture(t), source = join(f.root, 'never-run.txt'); await writeFile(source, '未运行也归集');
  f.document.nodes = [createNode('input', {}, { id: 'input', config: { sourceKind: 'file', path: source, defaultValue: source } })];
  const collect = f.app.workflowFolders.collect.bind(f.app.workflowFolders); let calls = 0;
  f.app.workflowFolders.collect = async (...args) => { calls++; assert.deepEqual(args[2].runs, []); return collect(...args); };
  const saved = f.save(f.document); assert.equal(calls, 0);
  await f.app.workflowFolders.open(f.document.id);
  const folder = f.app.workflowFolders.directory(f.document.id), files = JSON.parse(await readFile(join(folder, 'files.json'), 'utf8'));
  assert.equal(await readFile(join(folder, files.entries[0].path), 'utf8'), '未运行也归集');
  assert.equal(calls, 1);
  f.app.workflowLibrary.save({ document: saved.document, expectedRevision: 1 });
  f.app.workflowLibrary.save({ document: { ...saved.document, title: '只改标题' }, expectedRevision: 1 });
  await f.app.workflowFolders.open(f.document.id); assert.equal(calls, 1);
  const status = JSON.parse(await readFile(join(folder, 'history', 'input-sync.json'), 'utf8'));
  assert.equal(status.status, 'complete'); assert.equal(status.files, 1);
  assert.equal(f.app.workflowLibrary.get(f.document.id).document.nodes[0].config.path, source);
  const another = join(f.root, 'new-selection.txt'); await writeFile(another, '新选素材');
  const latest = f.app.workflowLibrary.get(f.document.id);
  latest.document.nodes[0].config.path = another; latest.document.nodes[0].config.defaultValue = another;
  f.app.workflowLibrary.save({ document: latest.document, expectedRevision: latest.revision });
  await f.app.workflowFolders.open(f.document.id); assert.equal(calls, 2);
  const versions = JSON.parse(await readFile(join(folder, 'files.json'), 'utf8'));
  assert(versions.entries.some(item => item.source === source)); assert(versions.entries.some(item => item.source === another));
});

test('a failed background input copy retains the saved definition, reports status and still refuses incomplete export', async t => {
  const f = await fixture(t), source = join(f.root, 'missing-new-input.txt');
  f.document.nodes = [createNode('input', {}, { id: 'input', config: { sourceKind: 'file', path: source, defaultValue: source } })];
  assert.doesNotThrow(() => f.save(f.document));
  await f.app.workflowFolders.open(f.document.id);
  assert.equal(f.app.workflowLibrary.get(f.document.id).revision, 1);
  const status = JSON.parse(await readFile(join(f.app.workflowFolders.directory(f.document.id), 'history', 'input-sync.json'), 'utf8'));
  assert.equal(status.status, 'error'); assert.match(status.error, /路径|文件|资料/);
  assert.equal(f.opened.length, 1);
  await assert.rejects(f.app.workflowFolders.sync(f.document.id, { includeFiles: true }), /资料|路径|文件/);
});

test('opening waits only for that workflow input collection and close drains queued copies', { timeout: 2000 }, async t => {
  const f = await fixture(t), source = join(f.root, 'pending.txt'); await writeFile(source, 'pending');
  f.document.nodes = [createNode('input', {}, { id: 'input', config: { sourceKind: 'file', path: source } })];
  const collect = f.app.workflowFolders.collect.bind(f.app.workflowFolders); let started, release;
  const entered = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.app.workflowFolders.collect = async (...args) => { started(); await gate; return collect(...args); };
  f.save(f.document); await entered;
  const opening = f.app.workflowFolders.open(f.document.id), closing = f.app.workflowFolders.close();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.opened.length, 0);
  release(); await Promise.all([opening, closing]); assert.equal(f.opened.length, 1);
  assert.equal(f.app.workflowFolders.pending.size, 0);
});

test('folder conversations contain all owned messages and recovery fields without loading another workflow or topic', async t => {
  const f = await fixture(t); f.save(f.document);
  f.db.prepare('INSERT INTO workflow_conversations VALUES(?,?)').run(f.document.id, 250);
  const insert = f.db.prepare('INSERT INTO workflow_conversation_turns VALUES(?,?,?,?,?,?)');
  for (let index = 0; index < 250; index++) insert.run('turn-' + index, f.document.id, 'message-' + index, '2026-10-27',
    JSON.stringify({ id: 'turn-' + index, workflowId: f.document.id, user: { text: '原文 ' + index }, assistant: { text: '回复 ' + index }, status: 'complete' }), JSON.stringify({ automatic: true, document: f.document }));
  insert.run('foreign', 'another-workflow', 'foreign', '2026-10-27', JSON.stringify({ user: { text: 'PRIVATE_OTHER_WORKFLOW' } }), '{}');
  const before = f.db.prepare('SELECT * FROM workflow_conversation_turns').all();
  f.app.workflowFolders.syncConversation(f.document.id);
  const file = await readFile(join(f.app.workflowFolders.directory(f.document.id), 'conversation.json'), 'utf8'), value = JSON.parse(file);
  assert.equal(value.turns.length, 250); assert.equal(value.turns[0].user.text, '原文 0'); assert.equal(value.turns[249].privateValue.automatic, true);
  assert.equal(file.includes('PRIVATE_OTHER_WORKFLOW'), false); assert.deepEqual(f.db.prepare('SELECT * FROM workflow_conversation_turns').all(), before);
});

test('an unsaved draft conversation can materialize without creating a library record', async t => {
  const f = await fixture(t);
  f.db.prepare('INSERT INTO workflow_conversations VALUES(?,?)').run(f.document.id, 1);
  f.db.prepare('INSERT INTO workflow_conversation_turns VALUES(?,?,?,?,?,?)').run('draft-turn', f.document.id, 'draft-message', '2026-10-27',
    JSON.stringify({ id: 'draft-turn', workflowId: f.document.id, user: { text: '尚未保存的草稿消息' } }), JSON.stringify({ document: f.document }));
  f.app.workflowFolders.syncConversation(f.document.id);
  const result = JSON.parse(await readFile(join(f.app.workflowFolders.directory(f.document.id), 'conversation.json'), 'utf8'));
  assert.equal(result.turns.length, 1); assert.equal(result.turns[0].user.text, '尚未保存的草稿消息');
  assert.equal(f.app.workflowLibrary.list().length, 0);
});

test('complete sync copies declared material, nested-run files and artifacts while preserving all frozen originals', async t => {
  const f = await fixture(t), material = join(f.root, 'input.txt'); await writeFile(material, '输入资料');
  f.document.nodes = [createNode('input', {}, { id: 'input', config: { sourceKind: 'file', path: material } })]; f.save(f.document);
  const runId = randomUUID(), childId = randomUUID(), output = join(f.root, 'originals', runId), childOutput = join(f.root, 'originals', childId);
  await mkdir(output, { recursive: true }); await mkdir(childOutput, { recursive: true });
  const artifactPath = join(childOutput, 'result.txt'); await writeFile(join(output, 'receipt.json'), '{"original":true}'); await writeFile(artifactPath, '原始产物');
  const run = { id: runId, workflowId: f.document.id, document: f.document, status: 'waiting_review', nodes: {}, outputDirectory: output };
  const child = { id: childId, workflowId: 'embedded-workflow', parentRunId: runId, status: 'complete', nodes: {}, outputDirectory: childOutput };
  f.put('workflow_runs', run); f.put('workflow_runs', child);
  f.put('workflow_artifacts', { id: 'artifact-owned', runId: childId, nodeId: 'producer', path: artifactPath, sha256: sha('原始产物') });
  f.put('workflow_file_runs', { id: runId, runId, workflowId: f.document.id, manifest: { entries: [{ nodeId: 'input', key: 'path', kind: 'file', path: material, sha256: sha('输入资料') }] } });
  const before = f.db.prepare('SELECT * FROM workflow_runs').all(), result = await f.app.workflowFolders.sync(f.document.id, { includeFiles: true });
  const mapping = JSON.parse(await readFile(join(result.directory, 'files.json'), 'utf8'));
  const input = mapping.entries.find(item => item.source === material), artifact = mapping.entries.find(item => item.source === artifactPath);
  assert.equal(await readFile(join(result.directory, input.path), 'utf8'), '输入资料'); assert.equal(await readFile(join(result.directory, artifact.path), 'utf8'), '原始产物');
  assert.equal(JSON.parse(await readFile(join(result.directory, 'history', 'runs.json'), 'utf8')).length, 2);
  assert.equal(await readFile(artifactPath, 'utf8'), '原始产物'); assert.deepEqual(f.db.prepare('SELECT * FROM workflow_runs').all(), before);
});

test('owned legacy delivery and run trees preserve ordinary hidden controller files without widening generic input admission', async t => {
  const f = await fixture(t), runId = randomUUID(), output = join(f.app.config.workflowRunRoot, runId);
  const delivery = join(f.workspaceRoot, 'outputs', '新工作流', runId);
  await mkdir(output, { recursive: true }); await mkdir(delivery, { recursive: true });
  await writeFile(join(output, '输入清单.json'), '{"entries":[]}');
  const manifest = join(delivery, '.workbench-delivery.json'); await writeFile(manifest, JSON.stringify({ runId, status: 'complete' }));
  f.save(f.document); f.put('workflow_runs', { id: runId, workflowId: f.document.id, status: 'complete', nodes: {}, outputDirectory: output, deliveryDirectory: delivery });
  const before = f.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(runId).value;
  await assert.rejects(f.app.workflowFiles.permitted(manifest), /隐藏|凭据/);
  const synced = await f.app.workflowFolders.sync(f.document.id, { includeFiles: true });
  const copied = synced.files.entries.find(item => item.source === manifest);
  assert.equal(copied.kind, 'delivery'); assert.equal(copied.runId, runId);
  assert.equal(await readFile(join(synced.directory, copied.path), 'utf8'), JSON.stringify({ runId, status: 'complete' }));
  await writeFile(join(output, '.worker-progress.json'), '{"done":true}');
  const pkg = new WorkflowPackages(f.app), exported = await pkg.export(f.document.id, { expectedRevision: 1 }), zip = decodeZip(exported.data);
  assert.equal(zip.find(item => item.name === copied.path).data.toString(), JSON.stringify({ runId, status: 'complete' }));
  assert(zip.some(item => item.name.endsWith('/.worker-progress.json')));
  await assert.rejects(f.app.workflowFiles.permitted(manifest), /隐藏|凭据/);
  await writeFile(manifest, JSON.stringify({ runId: 'another-run', status: 'complete' }));
  await assert.rejects(f.app.workflowFolders.sync(f.document.id, { includeFiles: true }), /归属/);
  assert.equal(f.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(runId).value, before);
});

test('controlled run copies reject credential files, symlinks and an unregistered or foreign run root', async t => {
  const f = await fixture(t), runId = randomUUID(), output = join(f.app.config.workflowRunRoot, runId);
  await mkdir(output, { recursive: true }); f.save(f.document);
  const run = { id: runId, workflowId: f.document.id, status: 'complete', nodes: {}, outputDirectory: output };
  f.put('workflow_runs', run);
  for (const name of ['.env', 'credentials.json', 'auth.json', 'id_rsa']) {
    await writeFile(join(output, name), 'PRIVATE_CREDENTIAL');
    await assert.rejects(f.app.workflowFolders.sync(f.document.id, { includeFiles: true }), /凭据/);
    await rm(join(output, name));
  }
  const external = join(f.root, 'elsewhere.txt'); await writeFile(external, 'OUTSIDE'); await symlink(external, join(output, '.worker-link'));
  await assert.rejects(f.app.workflowFolders.sync(f.document.id, { includeFiles: true }), /符号链接/); await rm(join(output, '.worker-link'));
  const foreign = { ...run, id: randomUUID(), workflowId: 'foreign-workflow' }; f.put('workflow_runs', foreign);
  const empty = { fileRuns: [], artifacts: [], learning: [] };
  await assert.rejects(f.app.workflowFolders.collect(f.document.id, { document: f.document }, { ...empty, runs: [foreign] }), /归属|登记/);
  await assert.rejects(f.app.workflowFolders.collect(f.document.id, { document: f.document }, { ...empty, runs: [{ ...run, id: randomUUID() }] }), /归属|登记/);
  await assert.rejects(f.app.workflowFolders.collect(f.document.id, { document: f.document }, { ...empty, runs: [{ ...run, outputDirectory: f.root }] }), /归属|登记/);
});

test('a successful migration retry clears stale fixed-file migration errors without changing workflow records', async t => {
  const f = await fixture(t), runId = randomUUID(), output = join(f.app.config.workflowRunRoot, runId);
  f.save(f.document); f.put('workflow_runs', { id: runId, workflowId: f.document.id, status: 'complete', nodes: {}, outputDirectory: output });
  const first = await f.app.workflowFolders.migrate(); assert.equal(first.errors.length, 1);
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'result.txt'), 'fixed');
  const before = f.db.prepare('SELECT * FROM workflow_runs').all(), retry = await f.app.workflowFolders.migrate();
  assert.equal(retry.errors.length, 0);
  const status = JSON.parse(await readFile(join(f.app.workflowFolders.directory(f.document.id), 'history', 'migration-errors.json'), 'utf8'));
  assert.deepEqual(status.errors, []); assert.equal(status.status, 'complete'); assert.deepEqual(f.db.prepare('SELECT * FROM workflow_runs').all(), before);
});

test('folder status reads only fixed identity-bound diagnostics without creating a folder', async t => {
  const f = await fixture(t), folder = f.app.workflowFolders.directory(f.document.id);
  assert.deepEqual(f.app.workflowFolders.status(f.document.id), { inputSync: null, migration: null });
  await assert.rejects(readdir(folder), { code: 'ENOENT' });
  f.save(f.document);
  f.app.workflowFolders.json(f.document.id, 'history/migration-errors.json', { version: 1, workflowId: f.document.id, status: 'error', errors: [{ message: '资料缺失' }] });
  assert.equal(f.app.workflowFolders.status(f.document.id).migration.errors[0].message, '资料缺失');
  f.app.workflowFolders.json(f.document.id, 'history/input-sync.json', { version: 1, workflowId: 'foreign-workflow', status: 'error' });
  assert.throws(() => f.app.workflowFolders.status(f.document.id), /身份/);
  await rm(join(folder, 'history/input-sync.json'));
  const foreign = join(f.root, 'foreign-status.json'); await writeFile(foreign, '{"value":"PRIVATE"}');
  await symlink(foreign, join(folder, 'history/input-sync.json'));
  assert.throws(() => f.app.workflowFolders.status(f.document.id), /符号链接/);
});

test('complete history includes owned feedback and schedule snapshots while ordinary saves never scan history', async t => {
  const f = await fixture(t), rootId = randomUUID(), childId = randomUUID();
  f.db.exec('CREATE TABLE workflow_feedback(id TEXT PRIMARY KEY,value TEXT); CREATE TABLE workflow_schedules(id TEXT PRIMARY KEY,value TEXT)');
  let scanned = 0; const history = f.app.workflowFolders.history.bind(f.app.workflowFolders);
  f.app.workflowFolders.history = id => { scanned++; return history(id); };
  f.save(f.document); assert.equal(scanned, 0);
  f.put('workflow_runs', { id: rootId, workflowId: f.document.id, status: 'complete', nodes: {} });
  f.put('workflow_runs', { id: childId, workflowId: 'embedded-document', parentRunId: rootId, status: 'complete', nodes: {} });
  const feedback = { id: 'own-feedback', runId: childId, workflowId: 'embedded-document', revision: 2, notes: '原始完整反馈', recovery: { preserved: true } };
  const schedule = { id: 'own-schedule', workflowId: f.document.id, enabled: true, input: { value: '固定输入' }, timing: { hour: 9 } };
  f.put('workflow_feedback', feedback); f.put('workflow_feedback', { id: 'foreign-feedback', workflowId: 'foreign', runId: 'foreign-run', notes: 'PRIVATE' });
  f.put('workflow_schedules', schedule); f.put('workflow_schedules', { id: 'foreign-schedule', workflowId: 'foreign', enabled: true });
  const before = f.db.prepare('SELECT * FROM workflow_schedules').all(), result = await f.app.workflowFolders.sync(f.document.id, { includeFiles: true });
  assert.deepEqual(JSON.parse(await readFile(join(result.directory, 'history/feedback.json'), 'utf8')), [feedback]);
  assert.deepEqual(JSON.parse(await readFile(join(result.directory, 'history/schedules.json'), 'utf8')), [schedule]);
  assert.deepEqual(f.db.prepare('SELECT * FROM workflow_schedules').all(), before); assert.equal(scanned, 1);
});

test('an old artifact reused as the current input retains separate role metadata and stays inside its run output mapping', async t => {
  const f = await fixture(t), runId = randomUUID(), output = join(f.root, 'originals', runId), artifactPath = join(output, 'result.txt');
  await mkdir(output, { recursive: true }); await writeFile(artifactPath, '上次产物也是本次输入');
  f.document.nodes = [createNode('input', {}, { id: 'input', config: { sourceKind: 'file', path: artifactPath } })]; f.save(f.document);
  f.put('workflow_runs', { id: runId, workflowId: f.document.id, document: f.document, status: 'complete', nodes: {}, outputDirectory: output });
  f.put('workflow_artifacts', { id: 'shared-artifact', runId, nodeId: 'producer', path: artifactPath, sha256: sha('上次产物也是本次输入') });
  const result = await f.app.workflowFolders.sync(f.document.id, { includeFiles: true }), mapping = JSON.parse(await readFile(join(result.directory, 'files.json'), 'utf8'));
  const input = mapping.entries.find(item => item.source === artifactPath && item.kind === 'input');
  const artifact = mapping.entries.find(item => item.source === artifactPath && item.kind === 'artifact');
  const run = mapping.entries.find(item => item.source === artifactPath && item.kind === 'run');
  const runDirectory = mapping.directories.find(item => item.source === output && item.kind === 'run' && item.runId === runId);
  assert(input); assert(artifact); assert(run); assert.notEqual(input.path, artifact.path);
  assert.equal(artifact.runId, runId); assert.equal(artifact.artifactId, 'shared-artifact');
  assert.equal(artifact.path, runDirectory.path + '/result.txt'); assert.equal(run.path, artifact.path);
  await f.app.workflowFolders.sync(f.document.id, { includeFiles: true });
  const again = JSON.parse(await readFile(join(result.directory, 'files.json'), 'utf8'));
  assert.equal(again.entries.filter(item => item.source === artifactPath).length, 3);
});

test('updated run logs replace obsolete mapping hashes and a complete copy survives removal of the old run root', async t => {
  const f = await fixture(t), runId = randomUUID(), output = join(f.root, 'old-run-root', runId), log = join(output, 'stdout.log');
  f.save(f.document); await mkdir(output, { recursive: true }); await writeFile(log, '第一条日志');
  f.put('workflow_runs', { id: runId, workflowId: f.document.id, document: f.document, status: 'complete', nodes: {}, outputDirectory: output });
  await f.app.workflowFolders.sync(f.document.id, { includeFiles: true }); await writeFile(log, '第一条日志\n第二条日志');
  const changed = await f.app.workflowFolders.sync(f.document.id, { includeFiles: true });
  let mapping = JSON.parse(await readFile(join(changed.directory, 'files.json'), 'utf8'));
  assert.equal(mapping.entries.filter(item => item.source === log).length, 1);
  assert.equal(mapping.entries.find(item => item.source === log).sha256, sha('第一条日志\n第二条日志'));
  await rm(output, { recursive: true });
  const recovered = await f.app.workflowFolders.sync(f.document.id, { includeFiles: true });
  assert(recovered.files.entries.some(item => item.source === log && item.sourceUnavailable));
  mapping = JSON.parse(await readFile(join(changed.directory, 'files.json'), 'utf8'));
  await rm(join(changed.directory, mapping.entries.find(item => item.source === log).path));
  await assert.rejects(f.app.workflowFolders.sync(f.document.id, { includeFiles: true }), /资料|归集|不存在/);
});

test('missing or changed registered material rejects a complete package, while migration keeps definitions and records the problem', async t => {
  const f = await fixture(t); f.save(f.document);
  const input = join(f.root, 'gone.txt'), runId = randomUUID();
  f.put('workflow_file_runs', { id: runId, runId, workflowId: f.document.id, manifest: { entries: [{ path: input, kind: 'file', sha256: sha('old') }] } });
  await assert.rejects(f.app.workflowFolders.sync(f.document.id, { includeFiles: true }), /资料|归集|文件/);
  const migrated = await f.app.workflowFolders.migrate(); assert.equal(migrated.errors.length, 1);
  const path = f.app.workflowFolders.directory(f.document.id);
  assert.equal(JSON.parse(await readFile(join(path, 'workflow.json'), 'utf8')).id, f.document.id);
  assert.equal(JSON.parse(await readFile(join(path, 'history', 'migration-errors.json'), 'utf8')).errors.length, 1);
  await f.app.workflowFolders.open(f.document.id); assert.deepEqual(f.opened, [path]);
  await writeFile(input, 'changed'); await assert.rejects(f.app.workflowFolders.sync(f.document.id, { includeFiles: true }), /变化|哈希/);
});

test('workflow directories and material cannot traverse symbolic links or accept foreign identifiers', async t => {
  const f = await fixture(t); f.save(f.document);
  for (const id of ['../outside', '', '__proto__']) assert.throws(() => f.app.workflowFolders.directory(id));
  const target = join(f.root, 'outside'); await mkdir(target);
  await rm(join(f.app.workflowFolders.directory(f.document.id), 'inputs'), { recursive: true });
  await symlink(target, join(f.app.workflowFolders.directory(f.document.id), 'inputs'));
  await assert.rejects(f.app.workflowFolders.sync(f.document.id, { includeFiles: true }), /符号链接/);
  assert.deepEqual(await readdir(target), []);
  await assert.rejects(f.app.workflowFolders.open('unknown-workflow'), /不存在/);
});

test('captured inputs use immutable local copies and remain portable after external originals disappear', async t => {
  const f = await fixture(t), source = join(f.root, 'selected.txt'); await writeFile(source, '素材第一版');
  f.document.nodes = [createNode('input', {}, { id: 'input', config: { sourceKind: 'file', path: source } })]; f.save(f.document);
  const first = await f.app.workflowFolders.captureInputs(f.document.id, [{ path: source, sha256: sha('素材第一版'), kind: 'file', nodeId: 'input', key: 'path' }]);
  assert.notEqual(first.entries[0].path, source); assert.equal(await readFile(first.entries[0].path, 'utf8'), '素材第一版');
  await writeFile(source, '素材第二版');
  const second = await f.app.workflowFolders.captureInputs(f.document.id, [{ path: source, sha256: sha('素材第二版'), kind: 'file', nodeId: 'input', key: 'path' }]);
  assert.notEqual(second.entries[0].path, first.entries[0].path); assert.equal(await readFile(first.entries[0].path, 'utf8'), '素材第一版');
  await rm(source);
  await f.app.workflowFolders.sync(f.document.id, { includeFiles: true });
  const mapping = JSON.parse(await readFile(join(f.app.workflowFolders.directory(f.document.id), 'files.json'), 'utf8'));
  assert(mapping.entries.some(item => item.source === source && item.sourceUnavailable));
});

test('material parent symlinks are refused and owned Skill snapshots may be copied from the private data directory', async t => {
  const f = await fixture(t), actual = join(f.root, 'actual'), link = join(f.root, 'link');
  await mkdir(actual); await writeFile(join(actual, 'input.txt'), 'file'); await symlink(actual, link);
  await assert.rejects(f.app.workflowFolders.captureInputs(f.document.id, [{ path: join(link, 'input.txt'), kind: 'file' }]), /符号链接/);
  f.save(f.document);
  const runId = randomUUID(); f.put('workflow_runs', { id: runId, workflowId: f.document.id, status: 'complete', nodes: {} });
  const snapshot = join(f.app.config.dataDir, 'workflow-snapshots', runId); await mkdir(snapshot, { recursive: true }); await writeFile(join(snapshot, 'skill.json'), '{"revision":"fixed"}');
  const result = await f.app.workflowFolders.sync(f.document.id, { includeFiles: true });
  assert.equal(await readFile(join(result.directory, 'skills', runId, 'skill.json'), 'utf8'), '{"revision":"fixed"}');
});

test('a captured input folder remains complete when its external source tree is moved away', async t => {
  const f = await fixture(t), source = join(f.root, 'materials'); await mkdir(join(source, 'sub'), { recursive: true });
  await writeFile(join(source, 'a.txt'), 'a'); await writeFile(join(source, 'sub', 'b.txt'), 'b');
  f.document.nodes = [createNode('input', {}, { id: 'input', config: { sourceKind: 'folder', path: source } })]; f.save(f.document);
  const inventory = await f.app.workflowFiles.inventory(source), original = { ...inventory, kind: 'folder', nodeId: 'input', key: 'path' };
  const captured = await f.app.workflowFolders.captureInputs(f.document.id, [original]);
  assert.equal(await readFile(join(captured.entries[0].path, 'sub', 'b.txt'), 'utf8'), 'b');
  await rm(source, { recursive: true });
  await f.app.workflowFolders.sync(f.document.id, { includeFiles: true });
  assert.equal(await readFile(join(captured.entries[0].path, 'a.txt'), 'utf8'), 'a');
});

test('a matched directory input remains exportable from its verified copies after the original directory disappears', async t => {
  const f = await fixture(t), sources = join(f.root, 'matched-sources'), source = join(sources, 'board.epro2');
  await mkdir(sources); await writeFile(source, '工程副本');
  f.document.nodes = [createNode('input', {}, { id: 'input', config: { fields: [{ key: 'project', label: '工程', kind: 'file', match: '*.epro2', extensions: ['.epro2'] }], defaultValue: sources } })];
  f.save(f.document);
  const preflight = await f.app.workflowFiles.preflight({ document: f.document });
  assert.equal(preflight.ok, true);
  const runId = randomUUID(); f.put('workflow_file_runs', { id: runId, workflowId: f.document.id, runId, manifest: preflight.manifest });
  await f.app.workflowFolders.sync(f.document.id, { includeFiles: true }); await rm(sources, { recursive: true });
  const result = await f.app.workflowFolders.sync(f.document.id, { includeFiles: true });
  assert(result.files.entries.some(item => item.source === source && item.sourceUnavailable));
  assert(result.files.directories.some(item => item.source === sources && item.sourceUnavailable));
});

test('run updates materialize in the root workflow folder without saving a draft or replaying child work', async t => {
  const f = await fixture(t), runId = randomUUID(), childId = randomUUID();
  const run = { id: runId, workflowId: f.document.id, document: f.document, status: 'waiting_review', nodes: {} };
  f.put('workflow_runs', run);
  const child = { id: childId, workflowId: 'embedded-workflow', folderWorkflowId: f.document.id, parentRunId: runId, status: 'running', nodes: { task: { status: 'running', logs: { stdout: 'owned log' } } } };
  f.put('workflow_runs', child);
  const before = f.db.prepare('SELECT * FROM workflow_runs').all();
  const result = f.app.workflowFolders.syncRun(child);
  assert.equal(result.workflowId, f.document.id); assert.equal(f.app.workflowLibrary.list().length, 0);
  const file = join(result.directory, 'runs', childId, 'record.json');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).nodes.task.logs.stdout, 'owned log');
  f.app.workflowFolders.syncRun({ ...child, status: 'complete' }); assert.equal(JSON.parse(await readFile(file, 'utf8')).status, 'complete');
  assert.deepEqual(f.db.prepare('SELECT * FROM workflow_runs').all(), before);
  assert.throws(() => f.app.workflowFolders.syncRun({ ...child, folderWorkflowId: 'another-workflow' }), /归属/);
  const metadata = JSON.stringify({ deletedAt: '2026-10-27' }); f.db.prepare('INSERT INTO workflow_library_meta VALUES(?,?)').run('deleted:' + f.document.id, metadata);
  assert.equal(f.app.workflowFolders.syncRun({ ...child, status: 'error' }).skipped, true);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).status, 'complete');
});

test('opening the workflow folder does not wait for a large material collection already in progress', async t => {
  const f = await fixture(t); f.save(f.document); let release;
  f.app.workflowFolders.pending.set(f.document.id, new Promise(resolve => { release = resolve; }));
  const opening = f.app.workflowFolders.open(f.document.id);
  const openedPromptly = await Promise.race([opening.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 50))]);
  release(); await opening; f.app.workflowFolders.pending.delete(f.document.id);
  assert.equal(openedPromptly, true); assert.deepEqual(f.opened, [f.app.workflowFolders.directory(f.document.id)]);
});
