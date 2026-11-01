import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApplicationRuntimeTools } from '../src/application-runtime-tools.mjs';
import { LocalToolBroker } from '../src/local-tool-broker.mjs';
import { ApplicationToolApprovals } from '../src/application-tool-approvals.mjs';

const revision = 'sha256:' + '1'.repeat(64), flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'application-runtime-tools-')), workflowFolder = join(root, 'workflow'), supervisorFolder = join(root, 'supervisor');
  await Promise.all([mkdir(workflowFolder), mkdir(supervisorFolder)]);
  const db = new DatabaseSync(':memory:'), calls = [], frames = [], scopes = new WeakSet();
  let permissionRevision = 1, trashed = false, archived = false;
  const snapshotId = randomUUID(), run = { id: 'run-one', workflowId: 'workflow-one', status: 'running', document: { id: 'workflow-one', nodes: [], edges: [] }, nodes: { 'node-one': { status: 'running', attemptId: snapshotId } } };
  function scope(role, readOnly = false) {
    const value = { role, workflowId: role === 'workflow' ? 'workflow-one' : null, readOnly, revision: permissionRevision,
      workingFolder: role === 'workflow' ? workflowFolder : supervisorFolder, permissions: { workflowRead: true, mcpTools: true, desktopControl: true, capture: true } };
    scopes.add(value); return value;
  }
  const permissions = { async current(value) { assert(scopes.has(value), 'host scope required'); if (value.revision !== permissionRevision) throw new Error('permissions changed'); return value; },
    async bind(input) { assert.equal(input.role, 'workflow'); assert.equal(input.workflowId, run.workflowId); assert.equal(input.document, run.document); return scope('workflow'); } };
  const catalog = { revision, servers: [{ id: 'local', enabled: true, status: 'connected', tools: [{ name: 'mcp__local__read', readOnly: true }, { name: 'mcp__local__write', readOnly: false }] }], desktop: { ready: true }, permissions: {} };
  const adapter = { state: 'ready', serverRequests: new Map(), send(frame) { frames.push(frame); }, async request(method, args) { calls.push({ method, args }); return method.endsWith('.catalog') ? structuredClone(catalog) : { success: true }; } };
  const app = { store: { db }, config: { appRoot: join(root, 'source'), hermesHome: join(root, 'hermes'), dataDir: join(root, 'data'), port: 4318 }, adapter,
    applicationAssistant: { permissions, lifecycle: { assertWritable(id) { if (archived || id !== 'supervisor-one') throw new Error('topic unavailable'); } }, listConversations() { return [{ id: 'supervisor-one' }]; }, emit() {} },
    workflowLibrary: { assertRunnable(id) { if (trashed || id !== 'workflow-one') throw new Error('workflow unavailable'); } },
    workflows: { get(id) { if (id !== run.id) throw new Error('run missing'); return run; } }, publish() {}, conversations: { emit() {} } };
  app.toolApprovals = new ApplicationToolApprovals(app);
  app.localTools = new LocalToolBroker(app, { authorize: value => permissions.current(value), readPolicy: () => ({ desktopApps: ['com.figma.Desktop'] }) });
  const tools = new ApplicationRuntimeTools(app);
  t.after(async () => { app.toolApprovals.close(); await tools.close(); await app.localTools.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  const context = role => ({ permissionScope: scope(role), sourceConversationId: role === 'workflow' ? 'workflow-one' : 'supervisor-one', diagnosticTurnId: 'turn-one' });
  const input = { server: 'local', tool: 'mcp__local__read', arguments: { file_path: 'input.txt' }, expectedRevision: revision, operationId: 'operation-one' };
  const bind = async capabilities => tools.bindAttempt({ session: { id: 'session-one', runtimeSessionId: 'runtime-one' }, runId: run.id, nodeId: 'node-one', snapshotId,
    capabilities: capabilities || { requiredToolsets: ['mcp-local', 'computer_use'], toolNames: ['mcp__local__read', 'mcp__local__write', 'computer_use'] } });
  function frame(token, patch = {}) { return { id: 'request-' + randomUUID(), method: 'workbench.local-tools.call', params: { session_id: 'runtime-one', attempt_id: snapshotId,
    capability_token: token, tool: 'mcp__local__read', arguments: { file_path: 'input.txt' }, call_id: 'native-call-one', ...patch } }; }
  async function dispatch(value) { adapter.serverRequests.set(String(value.id), value); await tools.handle(value); return frames.find(row => row.id === value.id); }
  return { root, workflowFolder, supervisorFolder, db, calls, frames, scope, context, input, tools, app, run, snapshotId, catalog, bind, frame, dispatch,
    revoke: () => permissionRevision++, trash: () => { trashed = true; }, archive: () => { archived = true; } };
}

test('both chat roles use the same MCP dispatcher with their actual working folder', async t => {
  const f = await fixture(t);
  for (const role of ['workflow', 'supervisor']) {
    await f.tools.call('mcp.call', { ...f.input, operationId: 'operation-' + role }, f.context(role));
    const native = f.calls.at(-1); assert.equal(native.method, 'workbench.local-tools.mcp');
    assert.equal(native.args.scope.working_folder, role === 'workflow' ? f.workflowFolder : f.supervisorFolder);
  }
});

test('supervisor inventory does not need a selected workflow or a writable archived topic', async t => {
  const f = await fixture(t); f.archive();
  const context = f.context('supervisor'); context.permissionScope.readOnly = true;
  const result = await f.tools.call('mcp.servers', {}, context);
  assert.equal(result.servers[0].id, 'local');
  const desktop = await f.tools.call('desktop.status', {}, context); assert.equal(desktop.desktop.ready, true);
});

test('chat MCP cannot escape its folder and revoked scopes cannot call', async t => {
  const f = await fixture(t), context = f.context('workflow');
  await assert.rejects(f.tools.call('mcp.call', { ...f.input, arguments: { file_path: '../outside' } }, context), /文件参数/);
  f.revoke(); await assert.rejects(f.tools.call('mcp.call', { ...f.input, operationId: 'operation-two' }, context), /permissions changed/);
  assert.equal(f.calls.filter(row => row.method.endsWith('.mcp')).length, 0);
});

test('a workflow callback is tied to live runtime run node attempt and exact capability token', async t => {
  const f = await fixture(t), lease = await f.bind();
  assert.equal((await f.dispatch(f.frame(lease.token))).result.success, true);
  for (const patch of [{ session_id: 'other-runtime' }, { attempt_id: randomUUID() }, { capability_token: randomUUID() }])
    assert((await f.dispatch(f.frame(lease.token, patch))).error);
  f.run.nodes['node-one'].attemptId = randomUUID(); assert((await f.dispatch(f.frame(lease.token))).error);
  f.run.nodes['node-one'].attemptId = f.snapshotId; f.run.status = 'complete'; assert((await f.dispatch(f.frame(lease.token))).error);
  assert.equal(f.calls.filter(row => row.method.endsWith('.mcp')).length, 1);
});

test('workflow frame cannot invent tool grants payload fields or native call IDs', async t => {
  const f = await fixture(t), lease = await f.bind({ requiredToolsets: ['mcp-local'], toolNames: ['mcp__local__read'] });
  for (const patch of [{ tool: 'computer_use', arguments: { action: 'capture', app: 'com.figma.Desktop' } }, { tool: 'manage_connections' },
    { role: 'supervisor' }, { call_id: undefined }, { call_id: '' }, { call_id: 'x'.repeat(257) }, { call_id: { forged: true } }, { arguments: [] }]) {
    const response = await f.dispatch(f.frame(lease.token, patch)); assert(response.error, JSON.stringify(patch));
  }
  assert.equal(f.calls.filter(row => !row.method.endsWith('.catalog')).length, 0);
});

test('missing node, revoked workflow, lease release and restarted runtime reject old callbacks', async t => {
  const f = await fixture(t), lease = await f.bind();
  delete f.run.nodes['node-one']; assert((await f.dispatch(f.frame(lease.token))).error, 'missing node must invalidate attempt');
  f.run.nodes['node-one'] = { status: 'running', attemptId: f.snapshotId }; f.trash(); assert((await f.dispatch(f.frame(lease.token))).error);
  lease.release(); assert((await f.dispatch(f.frame(lease.token))).error);
  const restarted = new ApplicationRuntimeTools(f.app), value = f.frame(lease.token); await restarted.handle(value);
  assert(f.frames.find(row => row.id === value.id).error); await restarted.close();
  assert.equal(f.calls.filter(row => row.method.endsWith('.mcp')).length, 0);
});

test('workflow write approval carries run ownership and permission change before approval prevents dispatch', async t => {
  const f = await fixture(t), lease = await f.bind(), pending = f.dispatch(f.frame(lease.token, { tool: 'mcp__local__write', arguments: { content: 'fixture' } }));
  await flush(); const approvals = f.app.toolApprovals.requests('workflow-one'); assert.equal(approvals.length, 1); assert.equal(approvals[0].runId, f.run.id);
  f.revoke(); await assert.rejects(f.app.toolApprovals.respond('workflow-one', approvals[0].id, { expectedRevision: 1, choice: 'once' }, { human: true }), /permissions changed/);
  assert((await pending).error); assert.equal(f.calls.filter(row => row.method.endsWith('.mcp')).length, 0);
});

test('release during workflow approval cancels the request and never calls MCP', async t => {
  const f = await fixture(t), lease = await f.bind(), pending = f.dispatch(f.frame(lease.token, { tool: 'mcp__local__write', arguments: { content: 'fixture' } }));
  await flush(); const approval = f.app.toolApprovals.requests('workflow-one')[0]; assert(approval);
  lease.release(); assert((await pending).error); assert.equal(f.app.toolApprovals.requests('workflow-one').length, 0);
  await assert.rejects(f.app.toolApprovals.respond('workflow-one', approval.id, { expectedRevision: 1, choice: 'once' }, { human: true }));
  assert.equal(f.calls.filter(row => row.method.endsWith('.mcp')).length, 0);
});
