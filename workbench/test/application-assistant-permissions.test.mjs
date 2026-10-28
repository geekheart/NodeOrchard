import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApplicationAssistantPermissions, DEFAULT_ASSISTANT_PERMISSIONS } from '../src/application-assistant-permissions.mjs';

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'assistant-permissions-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, 'workspace'), folder = join(workspace, 'current'), outside = join(directory, 'outside');
  await Promise.all([mkdir(folder, { recursive: true }), mkdir(outside)]);
  const settings = { revision: 1, ...structuredClone(DEFAULT_ASSISTANT_PERMISSIONS) };
  const document = { id: 'workflow-a', nodes: [], edges: [], settings: {} };
  const runs = [{ id: 'run-a', workflowId: 'workflow-a', sessionId: 'session-a', nodes: {} },
    { id: 'run-b', workflowId: 'workflow-b', nodes: { node: { sessionId: 'session-b' } } }];
  const app = { config: { workspaceRoot: workspace }, preferences: { defaultWorkspace: 'current' },
    assistantPermissionSettings: { get: () => structuredClone(settings) },
    workflowLibrary: { get: workflowId => ({ document: { ...document, id: workflowId } }) },
    workflows: { get: runId => { const result = runs.find(run => run.id === runId); if (!result) throw new Error('运行不存在'); return result; },
      list: workflowId => runs.filter(run => !workflowId || run.workflowId === workflowId) },
    workflowFiles: { getArtifact: artifactId => ({ id: artifactId, runId: artifactId === 'artifact-a' ? 'run-a' : 'run-b', nodeId: 'node', path: join(folder, 'result.txt') }) } };
  const policy = new ApplicationAssistantPermissions(app), scope = await policy.bind({ role: 'workflow', workflowId: document.id, document });
  return { directory, workspace, folder, outside, settings, document, runs, app, policy, scope };
}

test('independent candidates cannot reference another workflow or a file as a subflow', async t => {
  const f = await fixture(t);
  for (const type of ['subflow', 'foreach', 'loop']) for (const workflowRef of ['workflow-b', join(f.outside, 'foreign.json')]) {
    const document = { ...f.document, nodes: [{ id: 'nested', type, config: { workflowRef } }] };
    await assert.rejects(f.policy.document(document, f.scope), /当前工作流|工作流范围/);
  }
  const supervisor = await f.policy.bind({ role: 'supervisor' });
  await f.policy.document({ ...f.document, nodes: [{ id: 'nested', type: 'subflow', config: { workflowRef: 'workflow-b' } }] }, supervisor);
});

test('workflow identity and folder are pinned by application callers and cannot be invented by tool context', async t => {
  const f = await fixture(t);
  await assert.rejects(f.policy.bind({ workflowId: 'workflow-a' }), /服务端明确绑定/);
  await assert.rejects(f.policy.bind({ role: 'workflow' }), /绑定当前工作流/);
  await assert.rejects(f.policy.admit('workflow.run', {}, { role: 'supervisor' }), /服务端权限范围/);
  await assert.rejects(f.policy.admit('workflow.run', { role: 'supervisor' }, f.scope), /权限或访问器/);
  await assert.rejects(f.policy.admit('workflow.run', {}, f.scope, { workflowId: 'workflow-b' }), /越过当前/);
  const admitted = await f.policy.admit('workflow.run', {}, f.scope, { role: 'supervisor', workingFolder: f.outside });
  assert.equal(admitted.context.role, 'workflow');
  assert.equal(admitted.context.permissionScope.workingFolder, f.folder);
  assert.equal(admitted.args.workflowId, 'workflow-a');
});

test('workflow hard ceiling excludes global logs, cross-workflow management, source and permission writers', async t => {
  const f = await fixture(t);
  Object.assign(f.settings.workflow, { manageWorkflows: true, appLogs: true, crossWorkflowRead: true });
  const scope = await f.policy.bind({ role: 'workflow', workflowId: 'workflow-a' });
  for (const name of ['app.logs', 'workflow.copy', 'workflow.create-test', 'workflow.delete', 'terminal', 'source.patch', 'assistant.permissions.update']) {
    await assert.rejects(f.policy.admit(name, {}, scope), /未开放/);
  }
  assert(f.policy.tools([{ name: 'workflow.propose' }, { name: 'workflow.run' }, { name: 'app.logs' }], scope)
    .every(tool => tool.name !== 'app.logs'));
});

test('all explicit workflow, run, session and artifact identities are admitted before reading', async t => {
  const f = await fixture(t);
  await assert.rejects(f.policy.admit('workflow.inspect', { workflowId: 'workflow-b' }, f.scope), /当前工作流/);
  await assert.rejects(f.policy.admit('workflow.run', { runId: 'run-b' }, f.scope), /当前工作流/);
  await assert.rejects(f.policy.admit('session.history', { sessionId: 'session-b' }, f.scope), /不属于/);
  await assert.rejects(f.policy.admit('tools.catalog', { sessionId: 'unowned' }, f.scope), /不属于/);
  await assert.rejects(f.policy.admit('artifact.inspect', { artifactId: 'artifact-b', runId: 'run-a', nodeId: 'node' }, f.scope), /不属于/);
  assert.equal((await f.policy.admit('session.history', { sessionId: 'session-a' }, f.scope)).args.sessionId, 'session-a');
  assert.equal((await f.policy.admit('artifact.inspect', { artifactId: 'artifact-a', runId: 'run-a', nodeId: 'node' }, f.scope)).args.artifactId, 'artifact-a');
});

test('ownership checks use all persisted workflow runs, not only a bounded recent listing', async t => {
  const f = await fixture(t), db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE workflow_runs(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
  db.prepare('INSERT INTO workflow_runs VALUES(?,?)').run('old-run', JSON.stringify({ id: 'old-run', workflowId: 'workflow-a', nodes: { node: { sessionId: 'old-session' } } }));
  f.app.store = { db }; f.app.workflows.list = () => [];
  await f.policy.admit('session.history', { sessionId: 'old-session' }, f.scope);
  db.prepare('INSERT INTO workflow_runs VALUES(?,?)').run('foreign-run', JSON.stringify({ id: 'foreign-run', workflowId: 'workflow-b', sessionId: 'foreign-session' }));
  await assert.rejects(f.policy.admit('session.history', { sessionId: 'foreign-session' }, f.scope), /不属于/);
});

test('nested executions belong only to their verified root workflow for reads and projection', async t => {
  const f = await fixture(t), child = { id: 'child-run', workflowId: 'embedded-document', parentRunId: 'run-a', sessionId: 'child-session', nodes: {} };
  f.runs.push(child, { id: 'foreign-child', workflowId: 'embedded-document', parentRunId: 'run-b', nodes: {} });
  await f.policy.admit('workflow.run', { runId: child.id }, f.scope);
  await f.policy.admit('session.history', { sessionId: 'child-session' }, f.scope);
  await assert.rejects(f.policy.admit('workflow.run', { runId: 'foreign-child' }, f.scope), /当前工作流/);
  const projected = f.policy.project({ run: child, runs: [child, { id: 'foreign-child', workflowId: 'embedded-document' }] }, f.scope);
  assert.equal(projected.run.id, child.id); assert.deepEqual(projected.runs.map(row => row.id), [child.id]);
  f.runs.push({ id: 'cycle-a', workflowId: 'workflow-a', parentRunId: 'cycle-b' }, { id: 'cycle-b', workflowId: 'workflow-a', parentRunId: 'cycle-a' });
  await assert.rejects(f.policy.admit('workflow.run', { runId: 'cycle-a' }, f.scope), /父级归属/);
});

test('canonical folder checks reject traversal, sibling prefixes and symlink escapes', async t => {
  const f = await fixture(t);
  await writeFile(join(f.folder, 'result.txt'), 'ok');
  await symlink(f.outside, join(f.folder, 'escape'));
  assert.equal(await f.policy.path(join(f.folder, 'result.txt'), f.scope), join(f.folder, 'result.txt'));
  assert.equal(await f.policy.path(join(f.folder, 'new', 'result.txt'), f.scope), join(f.folder, 'new', 'result.txt'));
  for (const target of [join(f.folder, '..', 'sibling.txt'), f.folder + '-sibling.txt', join(f.folder, 'escape', 'new.txt')]) {
    await assert.rejects(f.policy.path(target, f.scope), /超出当前/);
  }
  await assert.rejects(f.policy.path(join(f.folder, '.env'), f.scope), /隐藏或凭据/);
  await assert.rejects(f.policy.path(join(f.folder, 'result.txt'), f.scope, { access: 'write' }), /任意文件或源码写/);
});

test('changing default workspace or a symlink cannot place independent assistants outside configured root', async t => {
  const f = await fixture(t);
  f.app.preferences.defaultWorkspace = f.outside;
  await assert.rejects(f.policy.bind({ role: 'workflow', workflowId: 'workflow-a' }), /越过/);
  await symlink(f.outside, join(f.workspace, 'foreign'));
  f.app.preferences.defaultWorkspace = 'foreign';
  await assert.rejects(f.policy.bind({ role: 'workflow', workflowId: 'workflow-a' }), /越过/);
});

test('document paths cannot widen folder scope and code derivation can be disabled separately', async t => {
  const f = await fixture(t);
  const fileNode = { id: 'input', type: 'input', title: '资料', config: { sourceKind: 'file', defaultValue: join(f.outside, 'data.csv') } };
  await assert.rejects(f.policy.document({ ...f.document, nodes: [fileNode] }, f.scope), /超出当前/);
  await assert.rejects(f.policy.document({ ...f.document, settings: { outputDirectory: f.outside } }, f.scope), /超出当前/);
  f.settings.workflow.customNodes = false; f.settings.revision++;
  const scope = await f.policy.bind({ role: 'workflow', workflowId: 'workflow-a', document: f.document });
  await f.policy.document({ ...f.document, title: '普通业务修改' }, scope);
  await assert.rejects(f.policy.document({ ...f.document, nodes: [{ id: 'code', type: 'tool', config: { executionMode: 'code', language: 'python', code: 'return input' } }] }, scope), /业务代码节点/);
});

test('live permission revocation invalidates an in-flight scope and its cached evidence', async t => {
  const f = await fixture(t); f.settings.workflow.workflowEdit = false; f.settings.revision++;
  await assert.rejects(f.policy.admit('workflow.propose', {}, f.scope), /权限已变化/);
  const scope = await f.policy.bind({ role: 'workflow', workflowId: 'workflow-a' });
  await assert.rejects(f.policy.admit('workflow.propose', {}, scope), /未开放/);
  assert(f.policy.tools([{ name: 'workflow.propose' }, { name: 'workflow.run' }], scope).every(tool => tool.name !== 'workflow.propose'));
});

test('snapshot and capability projection hide foreign workflow, session, global logs and forbidden tools', async t => {
  const f = await fixture(t), input = { state: { backend: { state: 'ready' }, sessions: [{ id: 'session-a' }, { id: 'session-b' }], sessionCount: 2,
    pendingRequests: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }], adapterLog: ['private global log'] },
    workflows: { items: [{ id: 'workflow-a', revision: 1 }, { id: 'workflow-b', revision: 1 }], count: 2 },
    tools: [{ name: 'workflow.propose' }, { name: 'app.logs' }], hermesTools: [{ name: 'foreign-tool' }] };
  const result = f.policy.project(input, f.scope);
  assert.equal(result.state.sessions.length, 1); assert.equal(result.state.sessionCount, 1);
  assert.equal(result.state.pendingRequests.length, 1); assert.equal(result.state.adapterLog, undefined);
  assert.deepEqual(result.workflows.items.map(item => item.id), ['workflow-a']); assert.equal(result.workflows.count, 1);
  assert.deepEqual(result.tools.map(tool => tool.name), ['workflow.propose']); assert.deepEqual(result.hermesTools, []);
  assert.equal(input.state.sessions.length, 2);
});

test('supervisor has explicit management/log grants and can be narrowed without promoting workflow scope', async t => {
  const f = await fixture(t), supervisor = await f.policy.bind({ role: 'supervisor' });
  for (const name of ['workflow.copy', 'workflow.create-test', 'workflow.delete', 'app.logs']) await f.policy.admit(name, {}, supervisor);
  await f.policy.admit('workflow.run', { workflowId: 'workflow-b', runId: 'run-b' }, supervisor);
  f.settings.supervisor.manageWorkflows = false; f.settings.supervisor.appLogs = false;
  f.settings.supervisor.crossWorkflowRead = false; f.settings.revision++;
  const narrowed = await f.policy.bind({ role: 'supervisor', workflowId: 'workflow-a' });
  for (const name of ['workflow.copy', 'workflow.create-test', 'workflow.delete', 'app.logs']) await assert.rejects(f.policy.admit(name, {}, narrowed), /未开放/);
  await assert.rejects(f.policy.admit('workflow.run', { runId: 'run-b' }, narrowed), /当前工作流/);
  const projection = f.policy.project({ tools: [{ name: 'workflow.delete' }], adapterLog: ['secret'] }, narrowed);
  assert.deepEqual(projection.tools, []); assert.equal(projection.adapterLog, undefined);
});

test('independent screenshots and recordings cannot select another route', async t => {
  const f = await fixture(t);
  await assert.rejects(f.policy.admit('browser.capture', { route: '/#/board' }, f.scope), /当前工作流页面/);
  await assert.rejects(f.policy.admit('browser.capture', { route: '/#/workflows/workflow-b' }, f.scope), /当前工作流页面/);
  await assert.rejects(f.policy.admit('browser.capture', { steps: [{ route: '/#/workflows/workflow-b' }] }, f.scope), /其它页面/);
  const admitted = await f.policy.admit('browser.capture', { route: '#/workflows/workflow-a' }, f.scope);
  assert.equal(admitted.args.route, '/#/workflows/workflow-a');
});

test('missing or malformed trusted permission configuration fails closed', async t => {
  const f = await fixture(t);
  for (const value of [undefined, {}, { revision: 1, workflow: {}, supervisor: {} }, { ...f.settings, workflow: { ...f.settings.workflow, workflowEdit: 'true' } }]) {
    const policy = new ApplicationAssistantPermissions(f.app, { readSettings: () => value });
    await assert.rejects(policy.bind({ role: 'workflow', workflowId: 'workflow-a' }), /权限配置/);
  }
});

test('source read is an independent supervisor grant and cannot promote a workflow or permit source mutations', async t => {
  const f = await fixture(t), reads = ['app.source.list', 'app.source.read'], writes = ['app.source.patch', 'app.source.test', 'app.source.rollback', 'app.source.history'];
  f.settings.supervisor.sourceRead = true;
  const scope = await f.policy.bind({ role: 'supervisor' }), readonly = await f.policy.bind({ role: 'supervisor', readOnly: true });
  for (const tool of reads) { assert.equal(f.policy.allowed(tool, scope), true); assert.equal(f.policy.allowed(tool, readonly), true); assert.equal(f.policy.allowed(tool, f.scope), false); }
  for (const tool of writes) { assert.equal(f.policy.allowed(tool, scope), false); assert.equal(f.policy.allowed(tool, readonly), false); }
  f.settings.supervisor.sourceRead = false; f.settings.supervisor.sourceRepair = true; f.settings.revision++;
  const repair = await f.policy.bind({ role: 'supervisor' });
  for (const tool of [...reads, ...writes]) assert.equal(f.policy.allowed(tool, repair), true);
});

test('model experiments require their own human grant and the original diagnostic evidence permissions', async t => {
  const f = await fixture(t);
  f.settings.supervisor.modelExperiment = true;
  let scope = await f.policy.bind({ role: 'supervisor' });
  assert.equal(f.policy.allowed('assistant.experiment', scope), true); assert.equal(f.policy.allowed('assistant.experiment', f.scope), false);
  assert.equal(f.policy.allowed('assistant.experiment', await f.policy.bind({ role: 'supervisor', readOnly: true })), false);
  for (const flag of ['workflowRead', 'appLogs']) {
    f.settings.supervisor[flag] = false; f.settings.revision++; scope = await f.policy.bind({ role: 'supervisor' });
    assert.equal(f.policy.allowed('assistant.experiment', scope), false); f.settings.supervisor[flag] = true;
  }
});

test('model traces follow diagnostic read permissions while workflow callers remain bound to their own conversation', async t => {
  const f = await fixture(t), readOnly = await f.policy.bind({ role: 'workflow', workflowId: 'workflow-a', readOnly: true });
  assert.equal(f.policy.allowed('assistant.trace', readOnly), true); assert.equal(f.policy.allowed('assistant.probe', readOnly), false);
  const admitted = await f.policy.admit('assistant.trace', {}, readOnly);
  assert.equal(admitted.args.workflowId, 'workflow-a');
  await assert.rejects(f.policy.admit('assistant.trace', { workflowId: 'workflow-b' }, readOnly), /当前工作流/);
  await assert.rejects(f.policy.admit('assistant.trace', { conversationId: 'supervisor-other' }, readOnly), /总控会话/);
  f.settings.supervisor.appLogs = false;
  assert.equal(f.policy.allowed('assistant.trace', await f.policy.bind({ role: 'supervisor' })), false);
});

test('permission projection marks denied feature descriptions unavailable and filters page evidence', async t => {
  const f = await fixture(t), projected = f.policy.project({
    run: { id: 'run-b', workflowId: 'workflow-b', outputText: 'foreign result' },
    latestRun: { id: 'run-a', workflowId: 'workflow-a' },
    page: { source: 'current-application-page', route: '#/workflows/workflow-a',
      runs: [{ id: 'run-a' }, { id: 'run-b' }], requests: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }],
      events: [{ route: '#/workflows/workflow-a', message: 'current' }, { route: '#/board', message: 'foreign' }] },
    features: [{ id: 'management', status: 'available', tools: ['workflow.delete', 'workflow.copy'] },
      { id: 'diagnostics', status: 'available', tools: ['workflow.run', 'app.logs'] }],
  }, f.scope);
  assert.equal(projected.run.restricted, true); assert.equal(projected.run.outputText, undefined);
  assert.equal(projected.latestRun.id, 'run-a');
  assert.deepEqual(projected.page.runs.map(run => run.id), ['run-a']);
  assert.equal(projected.page.requests.length, 1); assert.equal(projected.page.events.length, 1);
  assert.equal(projected.features[0].status, 'unavailable'); assert.deepEqual(projected.features[0].tools, []);
  assert.deepEqual(projected.features[1].tools, ['workflow.run']);
  assert.equal(f.policy.project({ source: 'current-application-page', route: '#/board', message: 'foreign' }, f.scope).message, undefined);
});

test('all nested business-code slots and nested document paths honor the same grants', async t => {
  const f = await fixture(t); f.settings.workflow.customNodes = false;
  const scope = await f.policy.bind({ role: 'workflow', workflowId: 'workflow-a', document: f.document });
  for (const type of ['tool', 'transform', 'evaluation', 'improvement', 'condition', 'loop']) {
    const node = { id: type, type, config: type === 'condition' || type === 'loop' ? { expression: 'input.ok' } : { code: 'return input', language: 'python' } };
    await assert.rejects(f.policy.document({ ...f.document, nodes: [node] }, scope), /业务代码节点/);
    await assert.rejects(f.policy.document({ ...f.document, nodes: [{ id: 'nested', type: 'subflow', config: { document: { id: 'nested-doc', nodes: [node] } } }] }, scope), /业务代码节点/);
  }
  const input = { id: 'nested-input', type: 'input', title: '资料', config: { sourceKind: 'file', path: join(f.outside, 'data.csv') } };
  await assert.rejects(f.policy.document({ ...f.document, nodes: [{ id: 'sub', type: 'subflow', config: { document: { id: 'nested-doc', nodes: [input] } } }] }, scope), /超出当前/);
});

test('in-flight scope rejects trusted folder preference and symlink changes', async t => {
  const f = await fixture(t);
  await mkdir(join(f.workspace, 'second'));
  f.app.preferences.defaultWorkspace = 'second';
  await assert.rejects(f.policy.current(f.scope), /工作文件夹已变化/);
  f.app.preferences.defaultWorkspace = 'link';
  await symlink(f.folder, join(f.workspace, 'link'));
  const scope = await f.policy.bind({ role: 'workflow', workflowId: 'workflow-a' });
  await rm(join(f.workspace, 'link')); await symlink(join(f.workspace, 'second'), join(f.workspace, 'link'));
  await assert.rejects(f.policy.current(scope), /工作文件夹已变化/);
});

test('a workspace configured at the repository cannot expose application source through document file fields', async t => {
  const f = await fixture(t);
  f.app.config.appRoot = join(f.workspace, 'workbench'); f.app.config.projectRoot = f.workspace;
  await mkdir(f.app.config.appRoot);
  await writeFile(join(f.app.config.appRoot, 'source.mjs'), 'protected application code');
  f.app.preferences.defaultWorkspace = '.';
  const scope = await f.policy.bind({ role: 'workflow', workflowId: 'workflow-a' });
  await assert.rejects(f.policy.path(f.workspace, scope), /源码或配置/);
  await assert.rejects(f.policy.path(join(f.app.config.appRoot, 'source.mjs'), scope), /源码或配置/);
  assert.equal(await f.policy.path(join(f.folder, 'normal-data.csv'), scope), join(f.folder, 'normal-data.csv'));
});

test('new workflow document admission is a server-only management option', async t => {
  const f = await fixture(t); f.settings.supervisor.crossWorkflowRead = false;
  const scope = await f.policy.bind({ role: 'supervisor', workflowId: 'workflow-a' });
  const document = { ...f.document, id: 'new-test-workflow' };
  await assert.rejects(f.policy.document(document, scope), /当前工作流/);
  await f.policy.document(document, scope, { allowNewWorkflow: true, baseDocument: { nodes: [] } });
  await assert.rejects(f.policy.document(document, f.scope, { allowNewWorkflow: true }), /新建工作流/);
});

test('supervisor workflow-read denial still filters evidence and tool advertising when global grants stay enabled', async t => {
  const f = await fixture(t); f.settings.supervisor.workflowRead = false;
  const scope = await f.policy.bind({ role: 'supervisor' });
  assert.equal(scope.permissions.crossWorkflowRead, true); assert.equal(scope.permissions.appLogs, true);
  await assert.rejects(f.policy.admit('workflow.propose', { workflowId: 'workflow-a' }, scope), /未开放/);
  const result = f.policy.project({ workflow: { document: f.document }, run: f.runs[0], latestRun: f.runs[1],
    workflows: { items: [{ id: 'workflow-a', revision: 1 }], count: 1 },
    state: { sessions: [{ id: 'session-a' }], sessionCount: 1, requests: [{ sessionId: 'session-a' }], adapterLog: ['allowed app log'] },
    page: { source: 'current-application-page', route: '#/workflows/workflow-a', document: f.document, runs: f.runs, events: [{ message: 'private workflow event' }] },
    tools: [{ name: 'workflow.propose' }, { name: 'workflow.run' }, { name: 'app.logs' }],
    features: [{ id: 'workflow-editing', status: 'proposal-only', tools: ['workflow.propose'], apply: 'apply candidate' }] }, scope);
  for (const key of ['workflow', 'workflows', 'run', 'latestRun']) assert.equal(result[key], undefined);
  assert.equal(result.state.sessions, undefined); assert.equal(result.state.sessionCount, undefined); assert.equal(result.state.requests, undefined);
  assert.deepEqual(result.state.adapterLog, ['allowed app log']);
  assert.equal(result.page.document, undefined); assert.equal(result.page.events, undefined); assert.equal(result.page.restricted, true);
  assert.deepEqual(result.tools.map(tool => tool.name), ['app.logs']);
  assert.equal(result.features[0].status, 'unavailable'); assert.equal(result.features[0].apply, undefined);
});
