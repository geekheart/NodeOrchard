import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { createDocument } from '../shared/workflow/workflow-model.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(method) { this.calls.push(method); throw Error('Unexpected live model or business call: ' + method); }
  async stop() {}
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'statistics-http-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), port: 0, workflowRunRoot: join(directory, 'runs') };
  const adapter = new Offline(), app = new Application(config, adapter), bridge = createWorkbenchServer(config, app), origin = await bridge.listen();
  const documents = ['当前工作流', 'FOREIGN_WORKFLOW_SENTINEL'].map(title => {
    const document = createDocument({ schemaVersion: 2, title }); app.workflowLibrary.save({ document, expectedRevision: 0 }); return document;
  });
  t.after(async () => { await bridge.close(); assert.deepEqual(adapter.calls, []); await rm(directory, { recursive: true, force: true }); });
  return { app, adapter, origin, documents };
}
// Diagnostics can append bounded observations while business and live metering
// rows remain read-only. They are outside the statistics mutation boundary.
const hashes = app => Object.fromEntries(app.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'application_logs' ORDER BY name").all()
  .map(({ name }) => [name, createHash('sha256').update(JSON.stringify(app.store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all())).digest('hex')]));

test('statistics HTTP exposes real empty workflow metrics without running models or mutating records', async t => {
  const f = await fixture(t), before = hashes(f.app);
  for (const days of [7, 30]) {
    const response = await fetch(f.origin + '/api/statistics?days=' + days); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.days, days); assert.equal(result.dashboard.schemaVersion, 1);
    assert.equal(result.dashboard.period.timeZone, 'Asia/Shanghai'); assert.equal(result.dashboard.daily.length, days);
    assert.equal(result.dashboard.workflows.length, 2); assert.equal(result.dashboard.totals.execution.runs, 0);
    assert.equal(result.dashboard.totals.usage.total, null); assert.equal(result.dashboard.workflows[0].context, null);
  }
  assert.equal((await fetch(f.origin + '/api/statistics?days=365')).status, 400);
  assert.deepEqual(hashes(f.app), before);
});

test('history import is an explicit CSRF-protected numeric cache write and never modifies business or live usage records', async t => {
  const f = await fixture(t), start = new Date(Date.now() - 60000).toISOString(), end = new Date(Date.now() - 30000).toISOString();
  const session = f.app.store.create({ title: '历史模型', cwd: f.app.config.workspaceRoot, storedSessionId: 'owned-history-session', runtimeSessionId: null, model: 'fixture', provider: 'fixture' });
  const id = f.app.store.beginRun(session.id); f.app.store.finishRun(session.id, 'complete');
  f.app.store.db.prepare('UPDATE runs SET started_at=?,completed_at=? WHERE id=?').run(start, end, id);
  const before = hashes(f.app), calls = [];
  f.adapter.state = 'ready'; f.app.backend.state = 'ready';
  f.adapter.request = async (name, args) => {
    calls.push({ name, args }); assert.equal(name, 'workbench.usage.history'); assert.deepEqual(args, { stored_session_ids: ['owned-history-session'] });
    return { schemaVersion: 1, sessions: [{ storedSessionId: 'owned-history-session', found: true, source: 'hermes.state-db', tokensRecorded: true,
      usage: { input: 120, output: 30, prompt: 170, completion: 30, total: 200, calls: 1, reasoning: 10, cache_read: 50, cache_write: 0 },
      startedAt: start, endedAt: end, firstMessageAt: start, lastMessageAt: end, parentId: null, hasChildren: false, compressed: false,
      context: { used: 170, max: null, percent: null, estimated: false, historical: true, kind: 'last-request-input', capturedAt: null, source: 'hermes.persisted-usage-anchor' }, modelUsage: [] }] };
  };
  const csrfToken = (await (await fetch(f.origin + '/api/bootstrap')).json()).csrfToken;
  const post = (body, token = csrfToken, query = '') => fetch(f.origin + '/api/statistics/history' + query, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token }, body: JSON.stringify(body) });
  assert.equal((await post({}, 'invalid')).status, 403);
  assert.equal((await post({ stored_session_ids: ['foreign-session'] })).status, 400);
  assert.equal((await post({}, csrfToken, '?profile=foreign')).status, 400); assert.equal(calls.length, 0);
  const imported = await post({}); assert.equal(imported.status, 200); assert.equal((await imported.json()).attributedRuns, 1);
  const again = await post({}); assert.equal(again.status, 200);
  const dashboard = (await (await fetch(f.origin + '/api/statistics')).json()).dashboard;
  assert.equal(dashboard.totals.usage.total, 200); assert.equal(dashboard.totals.usage.historicalRuns, 1);
  const after = hashes(f.app);
  for (const [table, hash] of Object.entries(before)) if (table !== 'hermes_usage_history') assert.equal(after[table], hash, table);
});

test('the real assistant dispatcher limits statistics to a workflow scope and honors permission changes', async t => {
  const f = await fixture(t), assistant = f.app.applicationAssistant, document = f.documents[0];
  const scope = await assistant.permissions.bind({ role: 'workflow', workflowId: document.id, document });
  const own = await assistant.call('workbench.inspect', { section: 'statistics', days: 7 }, { permissionScope: scope, workflowId: document.id, document });
  const output = JSON.stringify(own); assert(output.includes(document.id)); assert.equal(output.includes(f.documents[1].id), false);
  assert.equal(output.includes('FOREIGN_WORKFLOW_SENTINEL'), false); assert.equal(output.includes('supervisor'), false);
  await assert.rejects(assistant.call('workbench.inspect', { section: 'statistics', workflowId: f.documents[1].id }, { permissionScope: scope }), { httpStatus: 403 });
  const supervisor = await assistant.permissions.bind({ role: 'supervisor' });
  const all = await assistant.call('workbench.inspect', { section: 'statistics' }, { permissionScope: supervisor });
  assert.equal(all.workflows.length, 2);
  const settings = f.app.assistantPermissionSettings.get();
  f.app.assistantPermissionSettings.save({ expectedRevision: settings.revision, workflow: { ...settings.workflow, workflowRead: false }, supervisor: settings.supervisor });
  await assert.rejects(assistant.call('workbench.inspect', { section: 'statistics' }, { permissionScope: scope }), { httpStatus: 409 });
  const denied = await assistant.permissions.bind({ role: 'workflow', workflowId: document.id, document });
  await assert.rejects(assistant.call('workbench.inspect', { section: 'statistics' }, { permissionScope: denied }), { httpStatus: 403 });
});

test('supervisor conversation model session ownership is retained for future usage attribution', async t => {
  const f = await fixture(t), assistant = f.app.applicationAssistant;
  f.app.captureModelRoute = async () => ({ provider: 'fixture', model: 'fixture' });
  f.app.assistantModel.generate = async (_prompt, options) => {
    if (options.title === '应用对话 · 任务意图分类') { options.onSession('fixture-classification-session'); return JSON.stringify({ intent: 'diagnose' }); }
    options.onSession('fixture-model-session'); return JSON.stringify({ text: '只读诊断完成。' });
  };
  const id = assistant.createConversation({ clientConversationId: 'statistics-ownership', title: '用量归属' }).conversation.id;
  const result = await assistant.message({ clientMessageId: 'ownership-message', text: '只读检查当前应用状态' }, id);
  for (let index = 0; index < 100; index++) {
    const turn = assistant.get(id).conversation.turns.find(row => row.id === result.turn.id);
    if (turn.status !== 'thinking') { assert.equal(turn.status, 'complete'); assert.deepEqual(turn.modelSessionIds, ['fixture-classification-session', 'fixture-model-session']); return; }
    await delay(5);
  }
  assert.fail('fixture supervisor did not settle');
});
