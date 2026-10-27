import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationLogEvents, applicationHttpRoute, applicationErrorLocation } from '../src/application-log-events.mjs';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { createDocument } from '../shared/workflow/workflow-model.mjs';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.log = []; this.calls = []; }
  async request(method) { this.calls.push(method); throw Error('Unexpected model or business call'); }
  async stop() {}
}
async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'application-log-integration-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), port: 0,
    workflowRunRoot: join(directory, 'runs'), ...extra };
  const adapter = new Offline(), app = new Application(config, adapter), bridge = createWorkbenchServer(config, app);
  t.after(async () => { await bridge.close(); assert.deepEqual(adapter.calls, []); await rm(directory, { recursive: true, force: true }); });
  return { app, bridge, config, adapter };
}

test('state observations log changed run and node identities without streaming payloads or duplicates', () => {
  const records = [], recorder = new ApplicationLogEvents({ write: (...args) => records.push(args) });
  const payload = { id: 'run-a', workflowId: 'workflow-a', parentRunId: 'parent-run-a', learningId: 'learning-a', status: 'running', document: { code: 'BUSINESS_CODE_SENTINEL' }, input: 'USER_INPUT_SENTINEL',
    nodes: { skill: { status: 'running', attempt: 1, attemptId: 'attempt-a', sessionId: 'session-a', partialText: 'PRIVATE_OUTPUT_SENTINEL' } } };
  for (let index = 0; index < 100; index++) { payload.nodes.skill.partialText += '.'; recorder.handle({ type: 'workflow.run', payload }); }
  assert.equal(records.length, 2);
  payload.nodes.skill.status = 'error'; payload.status = 'error'; payload.error = 'password=SECRET'; recorder.handle({ type: 'workflow.run', payload });
  assert.equal(records.length, 4); assert.equal(records[2][0], 'error'); assert.equal(records[3][2].attemptId, 'attempt-a');
  assert.equal(records[3][2].sessionId, 'session-a');
  assert.equal(records[2][2].parentRunId, 'parent-run-a'); assert.equal(records[3][2].learningId, 'learning-a');
  assert.doesNotMatch(JSON.stringify(records), /SENTINEL|password|SECRET|partialText|document|input/);
  recorder.handle({ type: 'message.delta', sessionId: 'session-a', payload: { text: 'PRIVATE_STREAM_SENTINEL' } });
  recorder.handle({ type: 'session.usage', payload: { usage: { total: 1 } } }); assert.equal(records.length, 4);
});

test('assistant phases and tool failures retain correlation while excluding chat text and arguments', () => {
  const records = [], recorder = new ApplicationLogEvents({ write: (...args) => records.push(args) }, { maxKeys: 5 });
  const turn = { id: 'turn-a', workflowId: 'workflow-a', modelSessionId: 'model-a', status: 'thinking', user: { text: 'PROMPT_SENTINEL', context: { runId: 'run-a' } },
    assistant: { text: 'REPLY_SENTINEL', progress: { stage: 'model-response', label: 'PRIVATE_PHASE_LABEL', modelCalls: 1, toolCalls: 0, elapsedMs: 1 }, evidence: [] } };
  const event = { type: 'workflow.conversation', payload: { workflowId: 'workflow-a', conversation: { turns: [turn] } } };
  recorder.handle(event); turn.assistant.progress.elapsedMs = 500; recorder.handle(event); assert.equal(records.length, 1);
  turn.assistant.evidence.push({ tool: 'workflow.inspect', status: 'error', at: '2026-10-27T01:00:00Z', cached: true, arguments: { password: 'SECRET' } });
  turn.assistant.progress.toolCalls = 1; turn.status = 'error'; recorder.handle(event);
  assert.equal(records.length, 3); assert.equal(records[1][2].stage, 'model-response'); assert.equal(records[1][2].turnId, 'turn-a');
  assert.equal(records[2][0], 'error'); assert.equal(records[2][2].tool, 'workflow.inspect');
  assert.equal(records[2][2].cacheHit, true); assert.equal(records[2][2].cached, undefined);
  assert.doesNotMatch(JSON.stringify(records), /SENTINEL|PRIVATE_PHASE|SECRET|arguments|password/);
  for (let index = 0; index < 20; index++) recorder.handle({ type: 'workflow.run', payload: { id: 'run-' + index, workflowId: 'workflow-a', status: 'complete' } });
  assert.equal(recorder.states.size, 5);
});

test('log observer faults and getter-shaped metadata cannot change event delivery', () => {
  let reads = 0;
  const recorder = new ApplicationLogEvents({ write: () => { throw Error('storage failed'); } });
  const payload = { get nodes() { reads++; throw Error('should not inspect getter'); }, id: 'run-a', status: 'error' };
  assert.doesNotThrow(() => recorder.handle({ type: 'workflow.run', payload })); assert.equal(reads, 0);
  recorder.close(); assert.doesNotThrow(() => recorder.handle({ type: 'backend.error', payload: {} }));
});

test('HTTP route templates never retain a query, unknown path, or dynamic secret', () => {
  for (const url of ['/api/workflow-library/SECRET?token=SECRET', '/api/workflow-conversations/SECRET/turns/SECRET/action', '/api/sessions/SECRET/history']) {
    const route = applicationHttpRoute(url); assert.doesNotMatch(route, /SECRET|token|\?/); assert.match(route, /^\/api\//);
  }
  assert.equal(applicationHttpRoute('/api/private/SECRET?password=SECRET'), '/api/[unmatched]');
  assert.equal(applicationHttpRoute('/private/SECRET.txt'), '/[asset]');
});

test('error locations only expose existing source files within the application root', () => {
  const root = readConfig({}).appRoot, error = new Error('PRIVATE_ERROR_SENTINEL');
  error.stack = `Error: PRIVATE_ERROR_SENTINEL\n    at businessCode (/private/tmp/PRIVATE_WORKFLOW_SECRET.py:12:4)\n    at handler (file://${root}/src/server.mjs:44:3)`;
  assert.deepEqual(applicationErrorLocation(error, root), { file: 'src/server.mjs', line: 44, column: 3, functionName: 'handler' });
  error.stack = 'Error: PRIVATE_ERROR_SENTINEL\n    at handler (/private/tmp/PRIVATE_WORKFLOW_SECRET.py:12:4)';
  assert.deepEqual(applicationErrorLocation(error, root), {});
  let reads = 0; Object.defineProperty(error, 'stack', { get() { reads++; return `Error\n at handler (file://${root}/src/server.mjs:1:1)`; } });
  assert.deepEqual(applicationErrorLocation(error, root), {}); assert.equal(reads, 0);
});

test('HTTP generated request IDs join successful operations and safe error metadata without request bodies', async t => {
  const f = await fixture(t, { logLevel: 'debug' }), origin = await f.bridge.listen();
  const boot = await (await fetch(origin + '/api/bootstrap')).json();
  const document = createDocument({ schemaVersion: 2, title: 'PRIVATE_TITLE_SENTINEL' });
  const response = await fetch(origin + '/api/workflow-library', { method: 'POST', headers: { 'Content-Type': 'application/json',
    'X-Workbench-Token': boot.csrfToken, 'X-Request-Id': 'CLIENT_SPOOFED_TRACE_SECRET' }, body: JSON.stringify({ document, expectedRevision: 0 }) });
  assert.equal(response.status, 200); const requestId = response.headers.get('x-request-id'); assert.match(requestId, /^[a-f0-9-]{36}$/);
  const records = f.app.logger.read({ component: 'http', requestId }).entries;
  assert.equal(records.length, 2); assert.equal(records[0].event, 'http.request.started');
  assert.equal(records[1].context.workflowId, document.id); assert.equal(records[1].context.route, '/api/workflow-library');
  assert.equal(records[1].context.httpStatus, 200); assert.equal(typeof records[1].context.durationMs, 'number');
  const denied = await fetch(origin + '/api/no-such-endpoint/PRIVATE_SECRET?token=PRIVATE_SECRET');
  assert.equal(denied.status, 404); const failure = f.app.logger.read({ requestId: denied.headers.get('x-request-id') }).entries;
  const completed = failure.find(row => row.event === 'http.request.completed');
  assert.equal(completed.level, 'warn'); assert.equal(completed.context.route, '/api/[unmatched]');
  const serialized = JSON.stringify(f.app.logger.read({ limit: 100 }));
  assert.doesNotMatch(serialized, /PRIVATE_TITLE_SENTINEL|CLIENT_SPOOFED_TRACE_SECRET|PRIVATE_SECRET|csrfToken/);
});

test('existing application behavior stays authoritative when persistent logging becomes unavailable', async t => {
  const f = await fixture(t), delivered = []; f.app.on('event', event => delivered.push(event.type));
  f.app.logger.write = () => { throw Error('logger unavailable'); };
  assert.doesNotThrow(() => f.app.publish('backend.error', null, { message: 'PRIVATE_MESSAGE_SENTINEL' }));
  assert.deepEqual(delivered, ['backend.error']);
  const origin = await f.bridge.listen(); const result = await fetch(origin + '/api/bootstrap'); assert.equal(result.status, 200);
});

test('configured log levels are explicit and invalid levels never silently enable debug', () => {
  assert.equal(readConfig({}).logLevel, 'info'); assert.equal(readConfig({ WORKBENCH_LOG_LEVEL: 'DEBUG' }).logLevel, 'debug');
  assert.throws(() => readConfig({ WORKBENCH_LOG_LEVEL: 'include-everything' }), { code: 'INVALID_LOG_LEVEL' });
});

test('a failed CLI listen records a fatal classification without private config or exception text', async t => {
  const f = await fixture(t), origin = await f.bridge.listen();
  const childRoot = await mkdtemp(join(tmpdir(), 'application-log-startup-'));
  t.after(() => rm(childRoot, { recursive: true, force: true }));
  const result = await new Promise(resolve => execFile(process.execPath, [fileURLToPath(new URL('../src/main.mjs', import.meta.url))], {
    env: { ...process.env, WORKBENCH_DATA_DIR: join(childRoot, 'data'), WORKBENCH_WORKSPACE_ROOT: join(childRoot, 'workspace'),
      WORKBENCH_PORT: new URL(origin).port, WORKBENCH_LOG_LEVEL: 'info' }, timeout: 5000,
  }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
  assert.equal(result.error?.code, 1); assert.match(result.stderr, /启动失败/); assert.doesNotMatch(result.stderr, /EADDRINUSE|PRIVATE|state\.db/);
  const db = new DatabaseSync(join(childRoot, 'data', 'workbench.sqlite'), { readOnly: true });
  try {
    const records = db.prepare("SELECT event,context FROM application_logs WHERE level='fatal'").all();
    assert.equal(records.length, 1); assert.equal(records[0].event, 'application.start.failed');
    assert.equal(JSON.parse(records[0].context).errorCode, 'EADDRINUSE');
  } finally { db.close(); }
});
