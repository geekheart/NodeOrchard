import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalToolBroker } from '../src/local-tool-broker.mjs';

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'local-tool-broker-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const workspace = join(folder, 'workflow'); await mkdir(workspace);
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const calls = [], approvals = [];
  const catalog = { revision: 'sha256:' + 'a'.repeat(64), servers: [{ id: 'figma', enabled: true, status: 'connected', tools: [{ name: 'read', readOnly: true }, { name: 'write', readOnly: false }] }], desktop: { ready: true } };
  const app = { store: { db }, config: { appRoot: join(folder, 'source'), hermesHome: join(folder, 'hermes'), dataDir: join(folder, 'data'), port: 4318 },
    adapter: { state: 'ready', async request(method, args) { calls.push({ method, args }); return method.endsWith('catalog') ? structuredClone(catalog) : { ok: true }; } } };
  const scope = { role: 'workflow', workflowId: 'workflow-1', revision: 1, workingFolder: workspace, readOnly: false, permissions: { mcpTools: true, desktopControl: true, capture: true } };
  let valid = true;
  const broker = new LocalToolBroker(app, { authorize: async input => { assert.equal(input, scope); if (!valid) throw new Error('revoked'); }, readPolicy: () => ({ desktopApps: ['com.figma.Desktop'] }) });
  const context = { conversationId: 'conversation-1', turnId: 'turn-1', approve: async row => { approvals.push(row); return true; } };
  const input = { server: 'figma', tool: 'read', arguments: {}, expectedRevision: catalog.revision, operationId: 'operation-1' };
  return { broker, scope, context, input, calls, approvals, catalog, workspace, folder, db, revoke: () => { valid = false; } };
}

test('read-only MCP dispatch uses configured identities without prompting', async t => {
  const f = await fixture(t);
  await f.broker.mcp(f.input, f.scope, f.context);
  assert.equal(f.approvals.length, 0);
  assert.equal(f.calls.at(-1).method, 'workbench.local-tools.mcp');
  assert.equal(f.calls.at(-1).args.scope.working_folder, f.workspace);
  assert.equal(f.calls.at(-1).args.scope.read_only, false);
});
test('write-capable MCP needs one human approval and duplicate request returns receipt', async t => {
  const f = await fixture(t); f.input.tool = 'write';
  await f.broker.mcp(f.input, f.scope, f.context);
  await f.broker.mcp(f.input, f.scope, f.context);
  assert.equal(f.approvals.length, 1);
  assert.equal(f.approvals[0].details.tool, 'write');
  assert.equal(f.calls.filter(row => row.method.endsWith('.mcp')).length, 1);
});
test('MCP denial, missing permission or readonly scope cannot dispatch writes', async t => {
  const f = await fixture(t); f.input.tool = 'write';
  await assert.rejects(f.broker.mcp(f.input, f.scope, { ...f.context, approve: async () => false }), /未获得/);
  f.scope.readOnly = true; f.input.operationId = 'operation-2';
  await assert.rejects(f.broker.mcp(f.input, f.scope, f.context), /只读/);
  f.scope.permissions.mcpTools = false;
  await assert.rejects(f.broker.mcp(f.input, f.scope, f.context), /设置/);
  assert.equal(f.calls.filter(row => row.method.endsWith('.mcp')).length, 0);
});
test('permission revocation while human approval is pending is rechecked', async t => {
  const f = await fixture(t); f.input.tool = 'write';
  await assert.rejects(f.broker.mcp(f.input, f.scope, { ...f.context, approve: async () => { f.revoke(); return true; } }), /revoked/);
  assert.equal(f.calls.filter(row => row.method.endsWith('.mcp')).length, 0);
});
test('ordinary discussion stays read-only even if an approval callback would allow writes', async t => {
  const f = await fixture(t); f.input.tool = 'write';
  await assert.rejects(f.broker.mcp(f.input, f.scope, { ...f.context, readOnlyExternal: true }), /只读/);
  assert.equal(f.approvals.length, 0);
  assert.equal(f.calls.filter(row => row.method.endsWith('.mcp')).length, 0);
  f.input.tool = 'read'; f.input.operationId = 'read-operation';
  await f.broker.mcp(f.input, f.scope, { ...f.context, readOnlyExternal: true });
  assert.equal(f.calls.at(-1).args.scope.read_only, true);
});
test('folder parameters reject traversal, symlinks and protected destinations', async t => {
  const f = await fixture(t); await symlink(f.folder, join(f.workspace, 'outside'));
  for (const path of ['../other', 'outside/other', f.folder, 'http://localhost:4318']) {
    f.input.operationId += 'x'; f.input.arguments = { file_path: path };
    await assert.rejects(f.broker.mcp(f.input, f.scope, f.context), /文件参数/);
  }
  assert.equal(f.calls.filter(row => row.method.endsWith('.mcp')).length, 0);
});
test('changed catalog and same operation ID with different semantic payload are refused', async t => {
  const f = await fixture(t);
  f.input.expectedRevision = 'sha256:' + 'b'.repeat(64);
  await assert.rejects(f.broker.mcp(f.input, f.scope, f.context), /版本已变化/);
  f.input.expectedRevision = f.catalog.revision;
  await assert.rejects(f.broker.mcp(f.input, f.scope, f.context), /身份已用于/);
});
test('transport uncertainty is durable and never replays the MCP tool', async t => {
  const f = await fixture(t);
  const original = f.broker.app.adapter.request;
  f.broker.app.adapter.request = async (method, args) => { if (method.endsWith('.mcp')) { f.calls.push({ method, args }); throw new Error('lost response'); } return original(method, args); };
  await assert.rejects(f.broker.mcp(f.input, f.scope, f.context), /lost response/);
  await assert.rejects(f.broker.mcp(f.input, f.scope, f.context), /结果未知/);
  assert.equal(f.calls.filter(row => row.method.endsWith('.mcp')).length, 1);
});
test('desktop capture needs approved exact app; each mutation shows its text for human approval', async t => {
  const f = await fixture(t);
  await assert.rejects(f.broker.desktop({ action: 'capture', app: 'com.apple.Terminal' }, f.scope, f.context), /目标桌面应用/);
  await f.broker.desktop({ action: 'capture', app: 'com.figma.Desktop' }, f.scope, f.context);
  assert.equal(f.approvals.length, 0);
  await f.broker.desktop({ action: 'type', app: 'com.figma.Desktop', captureId: 'capture-1', text: 'hello', operationId: 'desktop-1' }, f.scope, f.context);
  assert.equal(f.approvals[0].details.text, 'hello');
  assert.equal(f.calls.at(-1).args.scope.allowed_apps[0], 'com.figma.Desktop');
});
test('stop while awaiting approval prevents desktop input', async t => {
  const f = await fixture(t), controller = new AbortController();
  await assert.rejects(f.broker.desktop({ action: 'click', app: 'com.figma.Desktop', captureId: 'capture-1', element: 2, operationId: 'desktop-1' }, f.scope,
    { ...f.context, signal: controller.signal, approve: async () => { controller.abort(); return true; } }), /已停止/);
  assert.equal(f.calls.length, 0);
});
test('broker shutdown asks the native gateway to release private desktop daemons', async t => {
  const f = await fixture(t);
  await f.broker.close();
  assert.equal(f.calls.at(-1).method, 'workbench.local-tools.close');
  await assert.rejects(f.broker.inspect(f.scope), /已停止/);
});
