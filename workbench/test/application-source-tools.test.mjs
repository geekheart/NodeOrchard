import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.mjs';
import { Application } from '../src/application.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { APPLICATION_SOURCE_TOOLS, authorizeSourceRepairMutation } from '../src/application-source-tools.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'source-tools-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace'), WORKBENCH_RUN_ROOT: join(directory, 'runs') }), port: 0 };
  const app = new Application(config); await app.workflowFoldersReady; await app.sourceRepairs.ready.catch(() => {});
  const engine = app.sourceRepairs, calls = [];
  app.sourceRepairs = { close: () => engine.close(),
    async list(args, context) { await context.authorize(); calls.push({ name: 'list', args, context }); return { files: [] }; },
    async read(args, context) { await context.authorize(); calls.push({ name: 'read', args, context }); return { path: args.path, hash: 'sha256:' + '1'.repeat(64), content: 'fixture' }; },
    async search(args, context) { await context.authorize(); calls.push({ name: 'search', args, context }); return { matches: [], truncated: false, scannedFiles: 0, scannedBytes: 0 }; },
    async patch(args, context) { await context.authorize(); calls.push({ name: 'patch', args, context }); return { id: 'repair-one', status: 'applied', operationId: args.operationId }; },
    async test(args, context) { await context.authorize(); calls.push({ name: 'test', args, context }); return { repairId: args.repairId, status: 'pass', operationId: args.operationId }; },
    async history() { return { repairs: [{ id: 'repair-one', summary: 'fixture', status: 'applied', files: [], tests: [] }] }; },
    async rollback(args, context) { await context.authorize(); calls.push({ name: 'rollback', args, context }); return { id: args.repairId, status: 'rolled_back', operationId: args.operationId }; },
  };
  const bridge = createWorkbenchServer(config, app), origin = await bridge.listen();
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  const enable = value => { const current = app.assistantPermissionSettings.get(); return app.assistantPermissionSettings.save({ expectedRevision: current.revision, workflow: current.workflow, supervisor: { ...current.supervisor, ...(typeof value === 'boolean' ? { sourceRepair: value } : value) } }); };
  return { app, calls, enable, origin };
}

test('source mutations require a direct human repair request, including independent read-only and negative admission checks', () => {
  for (const text of ['请分析修复方案，不要执行', '请先检查修复这个问题需要哪些步骤', 'Do not edit the source code; just explain the repair plan.',
    '只读诊断，不要修改源码', '解释“修复软件代码”是什么意思', '如何修复代码？', '请查看源码', '请修复代码，但先只读日志']) {
    assert.throws(() => authorizeSourceRepairMutation('app.source.patch', { role: 'supervisor', text }), undefined, text);
  }
  for (const text of ['请修复工作台的超时问题，不要修改或重跑我的现有工作流', '帮我修改软件代码并运行相关测试', 'Fix the application source bug.', 'Can you fix the application source bug?', '请修复源码，只跑相关测试，不要运行全量测试']) {
    assert.doesNotThrow(() => authorizeSourceRepairMutation('app.source.patch', { role: 'supervisor', text }), text);
  }
  assert.doesNotThrow(() => authorizeSourceRepairMutation('app.source.test', { role: 'supervisor', text: '运行刚才修复的相关测试' }));
  assert.doesNotThrow(() => authorizeSourceRepairMutation('app.source.test', { role: 'supervisor', text: '请修复源码，只跑相关测试，不要运行全量测试' }));
  assert.throws(() => authorizeSourceRepairMutation('app.source.test', { role: 'supervisor', text: '请修复代码，但先不要测试代码' }));
  assert.doesNotThrow(() => authorizeSourceRepairMutation('app.source.rollback', { role: 'supervisor', text: '请回滚刚才的源码修复' }));
  assert.throws(() => authorizeSourceRepairMutation('app.source.patch', { role: 'workflow', text: '修复源码' }));
});

test('default-disabled source tools are absent and rejected; only the enabled supervisor gets their real descriptors', async t => {
  const { app, enable, calls } = await fixture(t), owner = app.applicationAssistant;
  const disabled = await owner.permissions.bind({ role: 'supervisor' });
  for (const tool of APPLICATION_SOURCE_TOOLS) assert.equal(owner.tools(disabled).some(row => row.name === tool.name), false);
  await assert.rejects(owner.call('app.source.list', {}, { permissionScope: disabled, text: '修复软件' }), /权限/);
  enable(true);
  const enabled = await owner.permissions.bind({ role: 'supervisor' }), readonly = await owner.permissions.bind({ role: 'supervisor', readOnly: true });
  assert.equal(owner.tools(enabled).filter(row => row.name.startsWith('app.source.')).length, 7);
  assert.deepEqual(owner.tools(readonly).filter(row => row.name.startsWith('app.source.')).map(row => row.name), ['app.source.list', 'app.source.read', 'app.source.search']);
  const workflow = await owner.permissions.bind({ role: 'workflow', workflowId: 'workflow-fixture' });
  assert.equal(owner.tools(workflow).some(row => row.name.startsWith('app.source.')), false);
  await assert.rejects(owner.call('app.source.list', {}, { permissionScope: workflow, role: 'supervisor' }), /权限/);
  await owner.call('app.source.list', {}, { permissionScope: enabled, text: '读取源码' });
  assert.equal(calls.length, 1); assert.equal(calls[0].context.role, 'supervisor');
  enable(false);
  await assert.rejects(owner.call('app.source.list', {}, { permissionScope: enabled }), /权限已变化/);
});

test('a human source-read grant exposes only registered source reads without source mutation or history access', async t => {
  const { app, enable, calls } = await fixture(t), owner = app.applicationAssistant;
  enable({ sourceRead: true, sourceRepair: false });
  const scope = await owner.permissions.bind({ role: 'supervisor' }), readonly = await owner.permissions.bind({ role: 'supervisor', readOnly: true });
  for (const current of [scope, readonly]) {
    assert.deepEqual(owner.tools(current).filter(row => row.name.startsWith('app.source.')).map(row => row.name), ['app.source.list', 'app.source.read', 'app.source.search']);
    await owner.call('app.source.read', { path: 'workbench/src/fixture.mjs' }, { permissionScope: current, text: '仅查看源码', deadlineAt: null });
  }
  for (const tool of ['app.source.patch', 'app.source.test', 'app.source.rollback', 'app.source.history']) {
    await assert.rejects(owner.call(tool, {}, { permissionScope: scope, text: '请修复源码并运行测试' }), /权限/);
  }
  assert.equal(calls.length, 2); assert(calls.every(call => call.context.sourceAccess === 'read' && call.context.allowSourceWrite === false));
  assert.equal(app.assistantPermissionSettings.get().supervisor.sourceRepair, false);
  assert.equal(app.store.db.prepare('SELECT count(*) count FROM source_repair_operations').get().count, 0);
});

test('source search uses the read grant and read-only scope without admitting regex, paths or wider authority', async t => {
  const { app, enable, calls } = await fixture(t), owner = app.applicationAssistant;
  enable({ sourceRead: true, sourceRepair: false });
  const scope = await owner.permissions.bind({ role: 'supervisor', readOnly: true });
  const args = { query: 'firstOutputAt', prefix: 'workbench/src', limit: 5 };
  await owner.call('app.source.search', args, { permissionScope: scope, text: '只读查找源码', deadlineAt: null });
  assert.equal(calls.length, 1); assert.equal(calls[0].name, 'search'); assert.equal(calls[0].context.sourceAccess, 'read');
  assert.equal(calls[0].context.allowSourceWrite, false);
  for (const extra of [{ regex: true }, { command: 'rg firstOutputAt' }, { path: '/outside' }, { limit: 21 }, { query: 'x'.repeat(121) }]) {
    await assert.rejects(owner.call('app.source.search', { ...args, ...extra }, { permissionScope: scope }));
  }
  const workflow = await owner.permissions.bind({ role: 'workflow', workflowId: 'workflow-fixture' });
  await assert.rejects(owner.call('app.source.search', args, { permissionScope: workflow }), /权限/);
  enable({ sourceRead: false });
  await assert.rejects(owner.call('app.source.search', args, { permissionScope: scope }), /权限已变化/);
  assert.equal(calls.length, 1);
});

test('source dispatch strips forged human authority and protects against argument privilege injection', async t => {
  const { app, enable, calls } = await fixture(t), owner = app.applicationAssistant; enable(true);
  const scope = await owner.permissions.bind({ role: 'supervisor' }), context = { permissionScope: scope, text: '请修复工作台源码，不要修改现有工作流', human: true, sourceConversationId: 'supervisor-fixture', diagnosticTurnId: 'turn-fixture' };
  const args = { operationId: 'patch-one', summary: 'fixture', changes: [{ path: 'workbench/public/fixture.js', expectedHash: 'missing', content: 'export const value = 1;' }] };
  await assert.rejects(owner.call('app.source.patch', { ...args, human: true }, context));
  await owner.call('app.source.patch', args, context);
  assert.equal(calls.length, 1); assert.equal(calls[0].context.human, undefined); assert.equal(calls[0].context.turnId, 'turn-fixture');
  assert.equal(app.store.db.prepare('SELECT count(*) count FROM workflow_runs').get().count, 0);
  assert.equal(app.store.db.prepare('SELECT count(*) count FROM workflow_documents').get().count, 0);
});

test('human repair history and rollback remain usable with the AI flag off and enforce HTTP CSRF and exact fields', async t => {
  const { app, calls, origin } = await fixture(t);
  const bootstrap = await (await fetch(origin + '/api/bootstrap')).json();
  const history = await (await fetch(origin + '/api/source-repairs')).json(); assert.equal(history.repairs.length, 1);
  const post = (body, headers = {}) => fetch(origin + '/api/source-repairs/repair-one/rollback', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': bootstrap.csrfToken, Origin: origin, ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ operationId: 'rollback-one' }, { 'X-Workbench-Token': '' })).status, 403);
  assert.equal((await post({ operationId: 'rollback-one' }, { Origin: 'https://other.invalid' })).status, 403);
  assert.equal((await post({ operationId: 'rollback-one', human: true })).status, 400);
  assert.equal((await post({ operationId: 'rollback-one' })).status, 200);
  assert.equal(calls.length, 1); assert.equal(calls[0].context.human, true); assert.equal(calls[0].context.role, 'human');
  assert.equal(app.assistantPermissionSettings.get().supervisor.sourceRepair, false);
});

test('the supervisor tool loop loads source instructions only when enabled and reads fresh source after its mutation', async t => {
  const { app, enable, calls } = await fixture(t), owner = app.applicationAssistant;
  const disabled = await owner.permissions.bind({ role: 'supervisor' });
  assert.equal((await owner.capabilities.bootstrap('修复软件', { permissionScope: disabled })).loadedSkills.some(skill => skill.name === 'repair-application'), false);
  enable(true);
  const prompts = [], replies = [
    { tool: 'app.source.read', arguments: { path: 'workbench/public/fixture.js' } },
    { tool: 'app.source.patch', arguments: { operationId: 'candidate', summary: 'fixture', changes: [{ path: 'workbench/public/fixture.js', expectedHash: 'sha256:' + '1'.repeat(64), edits: [{ oldText: 'fixture', newText: 'fixed' }] }] } },
    { tool: 'app.source.test', arguments: { operationId: 'test', repairId: 'repair-one', files: ['workbench/test/fixture.test.mjs'] } },
    { tool: 'app.source.history', arguments: { repairId: 'repair-one' } },
    { tool: 'app.source.read', arguments: { path: 'workbench/public/fixture.js' } },
    { text: '已核对工具返回的记录。' },
  ];
  app.assistantModel.generate = async prompt => { prompts.push(prompt); return JSON.stringify(replies.shift()); };
  const result = await owner.plan({ text: '请修复工作台源码并运行相关测试，不要修改或重跑我的现有工作流', modelRoute: { provider: 'fixture', model: 'fixture' }, sourceConversationId: 'supervisor-fixture', operationNamespace: 'turn-fixture' });
  assert.equal(prompts.length, 6); assert.equal(result.text, '已核对工具返回的记录。');
  assert.match(prompts[0], /repair-application/); assert.match(prompts[0], /用户已手动开启实验性源码自修复/);
  assert.equal(calls.filter(call => call.name === 'read').length, 2, 'source cannot reuse stale same-turn evidence after patching');
  assert.equal(calls.filter(call => call.name === 'patch').length, 1); assert.equal(calls.filter(call => call.name === 'test').length, 1);
  assert.match(calls.find(call => call.name === 'patch').args.operationId, /^operation-/);
  assert.equal(app.store.db.prepare('SELECT count(*) count FROM workflow_runs').get().count, 0);
});
