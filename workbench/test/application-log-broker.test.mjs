import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { createDocument } from '../shared/workflow/workflow-model.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.log = []; this.calls = []; }
  async request(method) { this.calls.push(method); throw Error('Unexpected Hermes or business operation'); }
  async stop() {}
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'application-log-broker-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), port: 0, workflowRunRoot: join(directory, 'runs') };
  const f = { config, adapter: new Offline() };
  f.open = async () => { f.app = new Application(config, f.adapter); f.bridge = createWorkbenchServer(config, f.app); f.origin = await f.bridge.listen(); };
  await f.open();
  t.after(async () => { if (!f.app.closed) await f.bridge.close(); assert.deepEqual(f.adapter.calls, []); await rm(directory, { recursive: true, force: true }); });
  return f;
}

test('an HTTP failure is correlated with a durable global log and remains readable after restart', async t => {
  const f = await fixture(t), document = createDocument({ schemaVersion: 2, title: '日志关联验收' });
  f.app.workflowLibrary.save({ document, expectedRevision: 0 });
  const response = await fetch(f.origin + '/api/PRIVATE_PATH?token=PRIVATE_QUERY', { headers: { 'X-Request-Id': 'PRIVATE_CALLER_ID' } });
  await response.text(); assert.equal(response.status, 404);
  const requestId = response.headers.get('x-request-id'); assert.match(requestId, /^[a-f0-9-]{36}$/i);
  const assistant = f.app.applicationAssistant, scope = await assistant.permissions.bind({ role: 'supervisor' });
  const logs = await assistant.call('app.logs', { minLevel: 'warn', requestId, afterId: 0 }, { permissionScope: scope });
  assert.equal(logs.persistentHistory, true); assert.equal(logs.structured.entries.length, 1);
  const entry = logs.structured.entries[0]; assert.equal(entry.context.requestId, requestId); assert.equal(entry.context.httpStatus, 404);
  assert.equal(JSON.stringify(logs).includes('PRIVATE_'), false);
  const beforeDocument = f.app.workflowLibrary.get(document.id);
  await f.bridge.close(); await f.open();
  const nextScope = await f.app.applicationAssistant.permissions.bind({ role: 'supervisor' });
  const restored = await f.app.applicationAssistant.call('app.logs', { requestId, afterId: 0 }, { permissionScope: nextScope });
  assert.deepEqual(restored.structured.entries, [entry]); assert.deepEqual(f.app.workflowLibrary.get(document.id), beforeDocument);
});

test('persistent application logs keep the supervisor permission boundary and reject arbitrary file access', async t => {
  const f = await fixture(t), assistant = f.app.applicationAssistant, document = createDocument({ schemaVersion: 2, title: '日志权限验收' });
  f.app.workflowLibrary.save({ document, expectedRevision: 0 });
  const workflow = await assistant.permissions.bind({ role: 'workflow', workflowId: document.id, document });
  await assert.rejects(assistant.call('app.logs', {}, { permissionScope: workflow }), { httpStatus: 403 });
  const supervisor = await assistant.permissions.bind({ role: 'supervisor' });
  await assert.rejects(assistant.call('app.logs', { path: '/private/logs' }, { permissionScope: supervisor }), { httpStatus: 400 });
  const settings = f.app.assistantPermissionSettings.get();
  f.app.assistantPermissionSettings.save({ expectedRevision: settings.revision, workflow: settings.workflow, supervisor: { ...settings.supervisor, appLogs: false } });
  await assert.rejects(assistant.call('app.logs', {}, { permissionScope: supervisor }), { httpStatus: 409 });
  const revoked = await assistant.permissions.bind({ role: 'supervisor' });
  await assert.rejects(assistant.call('app.logs', {}, { permissionScope: revoked }), { httpStatus: 403 });
});
