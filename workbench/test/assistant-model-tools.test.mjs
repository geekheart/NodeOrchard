import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationAssistant } from '../src/application-assistant.mjs';
import { DEFAULT_ASSISTANT_PERMISSIONS } from '../src/application-assistant-permissions.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:'), workspaceRoot = mkdtempSync(join(tmpdir(), 'assistant-model-tools-'));
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,stored_session_id TEXT,model TEXT,provider TEXT);
    CREATE TABLE application_model_sessions(id TEXT PRIMARY KEY);
    CREATE TABLE workflow_conversation_turns(id TEXT PRIMARY KEY,workflow_id TEXT,value TEXT,private_value TEXT);`);
  const turn = { id: 'failed-turn', workflowId: 'workflow-a', status: 'error', createdAt: '2026-10-27T07:00:00.000Z',
    updatedAt: '2026-10-27T07:03:00.000Z', modelSessionId: 'owned-session', modelSessionIds: ['owned-session'],
    user: { text: 'PRIVATE_USER_MESSAGE' }, assistant: { text: 'PRIVATE_ASSISTANT_OUTPUT', checkpoint: { steps: [] } } };
  db.prepare('INSERT INTO workflow_conversation_turns VALUES(?,?,?,?)').run(turn.id, turn.workflowId, JSON.stringify(turn), '{}');
  db.exec("INSERT INTO sessions VALUES('owned-session','stored-owned','fixture','fixture'); INSERT INTO application_model_sessions VALUES('owned-session')");
  const settings = { revision: 1, ...structuredClone(DEFAULT_ASSISTANT_PERMISSIONS) }, requests = [];
  const app = { store: { db, get: id => id === 'owned-session' ? { id, storedSessionId: 'stored-owned' } : null },
    config: { workspaceRoot }, preferences: { defaultWorkspace: '.' }, publish() {},
    assistantPermissionSettings: { get: () => structuredClone(settings) },
    workflowLibrary: { get: id => ({ id, revision: 1, document: { id, schemaVersion: 2, nodes: [], edges: [] } }) },
    workflows: { get: () => { throw new Error('no run'); }, list: () => [] },
    diagnostics: { tools: () => [], snapshot: async () => ({}) },
    adapter: { request: async (method, args) => { requests.push({ method, args }); return { schemaVersion: 1, sessions: [{
      storedSessionId: 'stored-owned', found: true, promptCharacters: 48262, outputCharacters: 136, partial: true, complete: false,
      tokensRecorded: false, usage: { input: 0, output: 0, total: 0 }, source: 'hermes.state-db', text: 'PRIVATE_HERMES_BODY' }] }; } },
    assistantModel: { timeoutMs: 180000, outputIdleTimeoutMs: 60000, maxDurationMs: 360000,
      generate: async () => '{"ok":true}' }, captureModelRoute: async () => ({ provider: 'fixture', model: 'fixture' }) };
  const assistant = new ApplicationAssistant(app); app.applicationAssistant = assistant;
  t.after(async () => { await assistant.close(); db.close(); rmSync(workspaceRoot, { recursive: true, force: true }); });
  return { app, assistant, requests, settings };
}

test('diagnostic broker reads only turn-owned numeric model metadata without restoring a session', async t => {
  const f = fixture(t), scope = await f.assistant.permissions.bind({ role: 'supervisor' });
  const result = await f.assistant.call('assistant.diagnose', { workflowId: 'workflow-a', turnId: 'failed-turn' }, { permissionScope: scope });
  assert.equal(result.calls[0].promptCharacters, 48262);
  assert.equal(result.calls[0].outputCharacters, 136);
  assert.equal(result.calls[0].partial, true);
  assert(!JSON.stringify(result).includes('PRIVATE_'));
  assert.deepEqual(f.requests, [{ method: 'workbench.assistant.diagnostics', args: { stored_session_ids: ['stored-owned'] } }]);
  assert.equal(result.currentPolicy.outputIdleTimeoutMs, 60000);
});

test('model diagnostics enforce workflow ownership, protected log permission and exact tool schema', async t => {
  const f = fixture(t), independent = await f.assistant.permissions.bind({ role: 'workflow', workflowId: 'workflow-a' });
  await f.assistant.call('assistant.diagnose', {}, { permissionScope: independent });
  await assert.rejects(f.assistant.call('assistant.diagnose', { workflowId: 'workflow-b' }, { permissionScope: independent }), /当前工作流/);
  await assert.rejects(f.assistant.call('assistant.diagnose', { conversationId: 'global-application' }, { permissionScope: independent }), /总控|当前工作流/);
  const supervisor = await f.assistant.permissions.bind({ role: 'supervisor' });
  for (const args of [{ sessionId: 'owned-session' }, { path: '/tmp/private' }, { workflowId: 'workflow-a', conversationId: 'global-application' }]) {
    await assert.rejects(f.assistant.call('assistant.diagnose', args, { permissionScope: supervisor }), /参数|只能|目标/);
  }
  f.settings.supervisor.appLogs = false; f.settings.revision++;
  const disabled = await f.assistant.permissions.bind({ role: 'supervisor' });
  await assert.rejects(f.assistant.call('assistant.diagnose', { workflowId: 'workflow-a' }, { permissionScope: disabled }), /未开放/);
});

test('fixed model probe is admitted once per diagnostic turn and accepts no model parameters', async t => {
  const f = fixture(t), scope = await f.assistant.permissions.bind({ role: 'supervisor' });
  const context = { permissionScope: scope, diagnosticTurnId: 'diagnostic-turn', sourceConversationId: 'global-application' };
  let calls = 0; f.app.assistantModel.generate = async () => { calls++; return '{"ok":true}'; };
  assert.equal((await f.assistant.call('assistant.probe', {}, context)).success, true);
  await assert.rejects(f.assistant.call('assistant.probe', {}, context), /一次/);
  for (const args of [{ prompt: 'secret' }, { model: 'other' }, { path: '/tmp' }]) {
    await assert.rejects(f.assistant.call('assistant.probe', args, context), /参数/);
  }
  assert.equal(calls, 1);
});

test('a retried diagnosis selects the original failed turn and never the in-flight retry', async t => {
  const f = fixture(t), scope = await f.assistant.permissions.bind({ role: 'workflow', workflowId: 'workflow-a' });
  const retry = { id: 'retry-now', workflowId: 'workflow-a', status: 'thinking', assistant: {}, modelSessionIds: [] };
  f.app.store.db.prepare('INSERT INTO workflow_conversation_turns VALUES(?,?,?,?)').run(retry.id, retry.workflowId, JSON.stringify(retry), '{}');
  const result = await f.assistant.call('assistant.diagnose', {}, { permissionScope: scope, diagnosticTurnId: retry.id });
  assert.equal(result.target.turnId, 'failed-turn');
  f.app.store.db.prepare('DELETE FROM workflow_conversation_turns WHERE id=?').run('failed-turn');
  await assert.rejects(f.assistant.call('assistant.diagnose', {}, { permissionScope: scope, diagnosticTurnId: retry.id }), { httpStatus: 404 });
});

test('a supervisor without cross-workflow access can diagnose only its own conversation', async t => {
  const f = fixture(t); f.settings.supervisor.crossWorkflowRead = false;
  f.app.store.db.prepare('INSERT INTO application_conversation_turns VALUES(?,?,?,?)').run('supervisor-failure', 'message', 'digest', JSON.stringify({
    id: 'supervisor-failure', status: 'error', modelSessionIds: ['owned-session'], assistant: {} }));
  const scope = await f.assistant.permissions.bind({ role: 'supervisor' });
  const result = await f.assistant.call('assistant.diagnose', { conversationId: 'global-application' }, { permissionScope: scope, sourceConversationId: 'global-application' });
  assert.equal(result.target.turnId, 'supervisor-failure');
  await assert.rejects(f.assistant.call('assistant.diagnose', { conversationId: 'another-conversation' }, { permissionScope: scope, sourceConversationId: 'global-application' }), /跨会话/);
});
