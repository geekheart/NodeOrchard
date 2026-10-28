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

test('current disabled deadlines are exposed as null and never as zero or the previous defaults', async t => {
  const f = fixture(t), scope = await f.assistant.permissions.bind({ role: 'supervisor' });
  Object.assign(f.app.assistantModel, { timeoutMs: null, outputIdleTimeoutMs: null, maxDurationMs: null });
  const result = await f.assistant.call('assistant.diagnose', { workflowId: 'workflow-a', turnId: 'failed-turn' }, { permissionScope: scope });
  assert.deepEqual(result.currentPolicy, { scope: 'current-defaults', firstResponseTimeoutMs: null, outputIdleTimeoutMs: null,
    maxDurationMs: null, automaticRetry: false, arbitrarySourceMutation: false, businessReplay: false });
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

test('a human-enabled experiment resolves an owned historical call without forwarding any original material', async t => {
  const f = fixture(t), calls = [];
  f.app.store.db.exec('CREATE TABLE application_model_calls(session_id TEXT PRIMARY KEY,value TEXT NOT NULL)');
  f.app.store.db.prepare('INSERT INTO application_model_calls VALUES(?,?)').run('owned-session', JSON.stringify({ version: 1, status: 'timeout',
    startedAt: '2026-10-27T07:00:00.000Z', submittedAt: '2026-10-27T07:00:01.000Z', completedAt: '2026-10-27T07:03:00.000Z',
    promptCharacters: 21204, reasoningEffort: 'medium', reasoningEffortWire: 'medium', prompt: 'PRIVATE_ORIGINAL_CONTROL_PROMPT' }));
  const args = { workflowId: 'workflow-a', turnId: 'failed-turn', callIndex: 1 };
  const disabled = await f.assistant.permissions.bind({ role: 'supervisor' });
  await assert.rejects(f.assistant.call('assistant.experiment', args, { permissionScope: disabled, diagnosticTurnId: 'experiment-turn' }), { httpStatus: 403 });
  f.settings.supervisor.modelExperiment = true; f.settings.revision++;
  const scope = await f.assistant.permissions.bind({ role: 'supervisor' }), context = { permissionScope: scope, diagnosticTurnId: 'experiment-turn', sourceConversationId: 'global-application' };
  f.app.assistantModel.generate = async (...values) => { calls.push(values); return '{"ok":true}'; };
  const result = await f.assistant.call('assistant.experiment', args, context);
  assert.equal(result.success, true, JSON.stringify(result)); assert.equal(calls.length, 1); assert.equal(calls[0][0].length, 21204);
  assert.deepEqual(calls[0][1].modelRoute, { provider: 'fixture', model: 'fixture' });
  assert.equal(calls[0][1].expectedReasoningEffort, 'medium');
  assert.equal(JSON.stringify([calls, result]).includes('PRIVATE_'), false);
  await assert.rejects(f.assistant.call('assistant.experiment', args, context), { code: 'MODEL_EXPERIMENT_QUOTA' });
  for (const invalid of [{ ...args, prompt: 'PRIVATE_OVERRIDE' }, { ...args, provider: 'arbitrary' }, { ...args, callIndex: 0 }, { workflowId: 'workflow-a', callIndex: 1 }]) {
    await assert.rejects(f.assistant.call('assistant.experiment', invalid, context), { httpStatus: 400 });
  }
  const independent = await f.assistant.permissions.bind({ role: 'workflow', workflowId: 'workflow-a' });
  await assert.rejects(f.assistant.call('assistant.experiment', args, { ...context, permissionScope: independent }), { httpStatus: 403 });
  assert.equal(calls.length, 1);
});

test('request trace paging remains scoped to the selected call and accepts no arbitrary session identity', async t => {
  const f = fixture(t), scope = await f.assistant.permissions.bind({ role: 'workflow', workflowId: 'workflow-a' });
  const context = { permissionScope: scope }, args = { workflowId: 'workflow-a', turnId: 'failed-turn', callIndex: 1, afterRequestIndex: 0, limit: 1 };
  const empty = await f.assistant.call('assistant.trace', args, context);
  assert.equal(empty.trace.recorded, false); assert.equal(empty.sessionId, 'owned-session');
  assert.equal(f.requests.length, 0, 'trace paging must not repeat optional native session metadata reads');
  for (const invalid of [{ ...args, sessionId: 'unowned' }, { ...args, callIndex: 0 }, { ...args, afterRequestIndex: -1 }, { ...args, limit: 5 }]) {
    await assert.rejects(f.assistant.call('assistant.trace', invalid, context), error => [400, 403].includes(error.httpStatus));
  }
  await assert.rejects(f.assistant.call('assistant.trace', { ...args, workflowId: 'workflow-other' }, context), { httpStatus: 403 });
  await assert.rejects(f.assistant.call('assistant.trace', { ...args, callIndex: 2 }, context), { httpStatus: 404 });
  assert.equal(JSON.stringify(empty).includes('PRIVATE_'), false);
});

test('a fourteen-call history keeps its true call indexes for trace and experiment selection', async t => {
  const f = fixture(t), db = f.app.store.db, calls = [], ids = ['owned-session', ...Array.from({ length: 13 }, (_, index) => 'owned-session-' + (index + 2))];
  const turn = JSON.parse(db.prepare('SELECT value FROM workflow_conversation_turns WHERE id=?').get('failed-turn').value);
  turn.modelSessionIds = ids; turn.modelSessionId = ids.at(-1);
  db.prepare('UPDATE workflow_conversation_turns SET value=? WHERE id=?').run(JSON.stringify(turn), turn.id);
  db.exec('CREATE TABLE application_model_calls(session_id TEXT PRIMARY KEY,value TEXT NOT NULL)');
  for (const id of ids.slice(1)) {
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(id, 'stored-' + id, 'fixture', 'fixture');
    db.prepare('INSERT INTO application_model_sessions VALUES(?)').run(id);
  }
  f.app.store.get = id => ids.includes(id) ? { id, storedSessionId: 'stored-' + id } : null;
  f.app.adapter.request = async (method, args) => { f.requests.push({ method, args }); return { schemaVersion: 1, sessions: [{
    storedSessionId: args.stored_session_ids[0], found: true, promptCharacters: 21204, source: 'hermes.state-db' }] }; };
  db.prepare('INSERT INTO application_model_calls VALUES(?,?)').run(ids.at(-1), JSON.stringify({ version: 1, status: 'timeout',
    startedAt: '2026-10-27T07:00:00.000Z', completedAt: '2026-10-27T07:03:00.000Z',
    promptCharacters: 21204, reasoningEffort: 'medium', reasoningEffortWire: 'medium' }));
  f.settings.supervisor.modelExperiment = true; f.settings.revision++;
  const scope = await f.assistant.permissions.bind({ role: 'supervisor' }), context = { permissionScope: scope, diagnosticTurnId: 'experiment-turn-14', sourceConversationId: 'global-application' };
  const args = { workflowId: 'workflow-a', turnId: 'failed-turn' };
  const summary = await f.assistant.call('assistant.diagnose', args, context);
  assert.equal(summary.totalModelCalls, 14); assert.deepEqual(summary.calls.map(call => call.index), Array.from({ length: 12 }, (_, index) => index + 3));
  assert.equal(f.requests.length, 12); f.requests.length = 0;
  const trace = await f.assistant.call('assistant.trace', { ...args, callIndex: 14 }, context);
  assert.equal(trace.callIndex, 14); assert.equal(trace.sessionId, ids.at(-1));
  assert.equal(f.requests.length, 0);
  assert.equal((await f.assistant.call('assistant.trace', { ...args, callIndex: 1 }, context)).sessionId, ids[0]);
  assert.equal(f.requests.length, 0, 'an earlier call outside the summary window is still directly selectable');
  f.app.assistantModel.generate = async (...values) => { calls.push(values); return '{"ok":true}'; };
  const result = await f.assistant.call('assistant.experiment', { ...args, callIndex: 14 }, context);
  assert.equal(result.success, true); assert.equal(result.source.callIndex, 14); assert.equal(calls.length, 1);
  assert.deepEqual(f.requests, [{ method: 'workbench.assistant.diagnostics', args: { stored_session_ids: ['stored-' + ids.at(-1)] } }]);
  for (const tool of ['assistant.trace', 'assistant.experiment']) await assert.rejects(f.assistant.call(tool, { ...args, callIndex: 15 }, context), { httpStatus: 404 });
  assert.equal(calls.length, 1);
});
