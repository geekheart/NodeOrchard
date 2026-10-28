import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode } from '../shared/workflow/workflow-model.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(name) { this.calls.push(name); throw Error('Folder conversation tests never invoke Hermes'); }
  async stop() {}
}

test('an actual Application accepts a first message before its draft is saved and mirrors the complete conversation without creating a library entry', async t => {
  const directory = await mkdtemp('/private/tmp/folder-conversation-application-'), adapter = new Offline();
  const app = new Application(readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), adapter);
  t.after(async () => { await app.close(); assert.deepEqual(adapter.calls, []); await rm(directory, { recursive: true, force: true }); });
  app.applicationAssistant.intentClassifier.classify = async () => ({ intent: 'discuss', modelCalls: 1, modelRoute: { provider: 'fixture', model: 'fixture' } });
  app.conversations.planner = async () => ({ text: '尚未保存的草稿也可对话。', operations: [] });
  const document = createDocument({ schemaVersion: 2, title: '尚未保存草稿' });
  const response = await app.conversations.message(document.id, { clientMessageId: randomUUID(), text: '先讨论流程', document, intent: 'auto' });
  for (let index = 0; index < 500; index++) {
    const turn = app.conversations.get(document.id).conversation.turns.find(item => item.id === response.turn.id);
    if (turn.status !== 'thinking') { assert.equal(turn.status, 'complete'); break; }
    await new Promise(resolve => setImmediate(resolve));
    if (index === 499) assert.fail('Draft conversation did not settle');
  }
  assert.equal(app.workflowLibrary.list().length, 0);
  const saved = JSON.parse(await readFile(join(app.workflowFolders.directory(document.id), 'conversation.json'), 'utf8'));
  assert.equal(saved.turns.length, 1); assert.equal(saved.turns[0].user.text, '先讨论流程');
  assert.equal(saved.turns[0].assistant.text, '尚未保存的草稿也可对话。');
});

test('Application close waits for saved input copies before closing its database', { timeout: 2000 }, async t => {
  const directory = await mkdtemp('/private/tmp/folder-close-application-'), adapter = new Offline();
  const app = new Application(readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), adapter);
  t.after(async () => { if (!app.closed) await app.close(); assert.deepEqual(adapter.calls, []); await rm(directory, { recursive: true, force: true }); });
  await app.workflowFoldersReady;
  const source = join(app.config.workspaceRoot, 'source.txt'); await writeFile(source, '关闭前归集');
  const document = createDocument({ schemaVersion: 2 }); document.nodes = [createNode('input', {}, { id: 'input', config: { sourceKind: 'file', path: source } })];
  const collect = app.workflowFolders.collect.bind(app.workflowFolders); let entered, release, copied = false, closed = false;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  app.workflowFolders.collect = async (...args) => { entered(); await gate; assert.equal(app.store.db.prepare('SELECT 1 AS available').get().available, 1); const files = await collect(...args); copied = true; return files; };
  app.workflowLibrary.save({ document, expectedRevision: 0 }); await started;
  const closing = app.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release(); await closing; assert.equal(copied, true); assert.equal(app.closed, true);
  const status = JSON.parse(await readFile(join(app.workflowFolders.directory(document.id), 'history', 'input-sync.json'), 'utf8'));
  assert.equal(status.status, 'complete');
});

test('conversation mirror failures preserve committed messages and model results and file-only retry does not rerun the model', async t => {
  const directory = await mkdtemp('/private/tmp/folder-conversation-failure-'), adapter = new Offline();
  const app = new Application(readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), adapter);
  t.after(async () => { await app.close(); assert.deepEqual(adapter.calls, []); await rm(directory, { recursive: true, force: true }); });
  await app.workflowFoldersReady;
  let modelCalls = 0; app.applicationAssistant.intentClassifier.classify = async () => ({ intent: 'discuss', modelCalls: 1, modelRoute: { provider: 'fixture', model: 'fixture' } });
  app.conversations.planner = async () => { modelCalls++; return { text: '模型已经完成，不能因磁盘错误覆盖。', operations: [] }; };
  const write = app.workflowFolders.writeText.bind(app.workflowFolders);
  app.workflowFolders.writeText = (workflowId, name, serialized) => { if (name === 'conversation.md') throw Object.assign(Error('isolated disk full'), { code: 'ENOSPC' }); return write(workflowId, name, serialized); };
  const document = createDocument({ schemaVersion: 2, title: '刷写故障隔离流程' });
  const input = { clientMessageId: randomUUID(), text: '保留本轮结果', document, intent: 'auto' };
  const response = await app.conversations.message(document.id, input);
  for (let index = 0; index < 500 && app.conversations.get(document.id).conversation.turns[0].status === 'thinking'; index++) await new Promise(resolve => setImmediate(resolve));
  const turn = app.conversations.get(document.id).conversation.turns[0]; assert.equal(turn.id, response.turn.id); assert.equal(turn.status, 'complete'); assert.equal(turn.assistant.text, '模型已经完成，不能因磁盘错误覆盖。');
  assert.equal(app.workflowFolders.conversationStatus(document.id).status, 'error'); assert.equal(app.workflowFolders.conversationStatus(document.id).dirty, true);
  assert.throws(() => app.workflowFolders.flushConversation(document.id), /未导出|尚未完整保存/);
  const replay = await app.conversations.message(document.id, input); assert.equal(replay.turn.id, turn.id); assert.equal(modelCalls, 1);
  app.workflowFolders.writeText = write; const synced = app.workflowFolders.flushConversation(document.id); assert.equal(synced.dirty, false);
  const snapshot = JSON.parse(await readFile(join(app.workflowFolders.directory(document.id), 'conversation.json'), 'utf8'));
  assert.equal(snapshot.turns[0].status, 'complete'); assert.equal(snapshot.turns[0].assistant.text, turn.assistant.text); assert.equal(modelCalls, 1);
  assert.match(await readFile(join(app.workflowFolders.directory(document.id), 'conversation.md'), 'utf8'), /模型已经完成/);
});
