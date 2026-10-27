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
