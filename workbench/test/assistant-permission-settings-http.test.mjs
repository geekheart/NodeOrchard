import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application } from '../src/application.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { readConfig } from '../src/config.mjs';
import { ASSISTANT_PERMISSION_KEYS, AssistantPermissionSettings } from '../src/assistant-permission-settings.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.calls = []; this.serverRequests = new Map(); }
  async request(method) { this.calls.push(method); throw new Error('Unexpected Hermes/model/business call: ' + method); }
  async stop() {}
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-permission-http-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }),
    port: 0, workflowRunRoot: join(directory, 'runs') };
  const f = { directory, config, adapters: [] };
  f.open = async () => {
    f.adapter = new Offline(); f.adapters.push(f.adapter); f.app = new Application(config, f.adapter);
    f.bridge = createWorkbenchServer(config, f.app); f.origin = await f.bridge.listen();
    f.token = (await (await fetch(f.origin + '/api/bootstrap')).json()).csrfToken;
  };
  f.request = async (method = 'GET', body, headers = {}) => {
    const response = await fetch(f.origin + '/api/assistant-permissions', { method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Workbench-Token': f.token }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => {
    if (!f.app.closed) await f.bridge.close();
    for (const adapter of f.adapters) assert.deepEqual(adapter.calls, []);
    await rm(directory, { recursive: true, force: true });
  });
  await f.open();
  return f;
}

const update = value => ({ expectedRevision: value.revision, workflow: structuredClone(value.workflow), supervisor: structuredClone(value.supervisor) });
function businessState(app) {
  return app.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'workflow_%' OR name IN ('sessions','runs')) ORDER BY name").all()
    .map(({ name }) => { assert.match(name, /^[a-z_]+$/); return [name, app.store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]; });
}

test('permission settings GET declares immutable protections and PUT persists exactly across a real Application restart', async t => {
  const f = await fixture(t), before = businessState(f.app);
  assert(f.app.assistantPermissionSettings instanceof AssistantPermissionSettings);
  const read = await f.request(); assert.equal(read.status, 200);
  const original = read.body;
  assert.equal(original.protection, 'human-only'); assert.equal(original.revision, 1);
  assert.equal(original.workspaceRoot, f.config.workspaceRoot);
  assert.deepEqual(original.immutable, { unrestrictedSourceWrite: false, shell: false, permissionWrite: false, workflowCrossScope: false });
  for (const [role, keys] of Object.entries(ASSISTANT_PERMISSION_KEYS)) assert.deepEqual(Object.keys(original[role]).sort(), [...keys].sort());
  const request = update(original); request.workflow.customNodes = false; request.workflow.capture = false;
  request.supervisor.manageWorkflows = false; request.supervisor.appLogs = false;
  const saved = await f.request('PUT', request, { Origin: f.origin });
  assert.equal(saved.status, 200); assert.equal(saved.body.revision, 2);
  assert.deepEqual(saved.body.workflow, request.workflow); assert.deepEqual(saved.body.supervisor, request.supervisor);
  assert.deepEqual(saved.body.immutable, original.immutable);
  assert.equal(f.app.events.filter(event => event.type === 'assistant.permissions.updated').length, 1);
  assert.deepEqual(businessState(f.app), before);
  await f.bridge.close(); await f.open();
  const restored = await f.request(); assert.equal(restored.status, 200); assert.deepEqual(restored.body, saved.body);
  assert.deepEqual(businessState(f.app), before);
});

test('experimental source repair is supervisor-only, disabled by default and persists only after a human versioned save', async t => {
  const f = await fixture(t), before = businessState(f.app), original = (await f.request()).body;
  assert.equal(original.supervisor.sourceRepair, false); assert.equal(Object.hasOwn(original.workflow, 'sourceRepair'), false);
  for (const [role, keys] of Object.entries(ASSISTANT_PERMISSION_KEYS)) for (const key of keys) assert.equal(original[role][key], !['sourceRead', 'sourceRepair', 'modelExperiment'].includes(key));
  const enabled = update(original); enabled.supervisor.sourceRepair = true;
  const saved = await f.request('PUT', enabled); assert.equal(saved.status, 200); assert.equal(saved.body.supervisor.sourceRepair, true);
  assert.equal(saved.body.immutable.unrestrictedSourceWrite, false); assert.equal(saved.body.immutable.permissionWrite, false); assert.equal(saved.body.immutable.shell, false);
  await f.bridge.close(); await f.open(); assert.equal((await f.request()).body.supervisor.sourceRepair, true);
  assert.deepEqual(businessState(f.app), before); assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get().count, 0);
});

test('legacy permission rows project new grants as disabled without migrating settings or business records on read', async t => {
  const f = await fixture(t), legacy = (await f.request()).body, before = businessState(f.app);
  for (const key of ['sourceRead', 'sourceRepair', 'modelExperiment']) delete legacy.supervisor[key];
  const payload = JSON.stringify({ workflow: legacy.workflow, supervisor: legacy.supervisor });
  f.app.store.db.prepare('UPDATE assistant_permission_settings SET revision=17,value=? WHERE id=1').run(payload);
  const stored = () => f.app.store.db.prepare('SELECT revision,value FROM assistant_permission_settings WHERE id=1').get();
  const row = stored(), events = f.app.events.filter(event => event.type === 'assistant.permissions.updated').length;
  for (let index = 0; index < 2; index++) {
    const result = await f.request(); assert.equal(result.status, 200); assert.equal(result.body.revision, 17); assert.equal(result.body.supervisor.sourceRepair, false);
    assert.equal(result.body.supervisor.sourceRead, false); assert.equal(result.body.supervisor.modelExperiment, false);
    assert.deepEqual(result.body.workflow, legacy.workflow); assert.deepEqual(stored(), row);
  }
  await f.bridge.close(); await f.open(); const read = (await f.request()).body;
  assert.equal(read.supervisor.sourceRepair, false); assert.equal(read.revision, 17); assert.deepEqual(stored(), row);
  assert.equal(f.app.events.filter(event => event.type === 'assistant.permissions.updated').length, events); assert.deepEqual(businessState(f.app), before);
  const oldClient = update(read); delete oldClient.supervisor.sourceRepair;
  assert.equal((await f.request('PUT', oldClient)).status, 400); assert.deepEqual(stored(), row);
});

test('permission versions reject stale windows without overwriting a newer human setting', async t => {
  const f = await fixture(t), original = (await f.request()).body, first = update(original);
  first.workflow.workflowEdit = false;
  const saved = await f.request('PUT', first); assert.equal(saved.status, 200);
  const stale = update(original); stale.supervisor.manageWorkflows = false;
  assert.equal((await f.request('PUT', stale)).status, 409);
  assert.deepEqual((await f.request()).body, saved.body);
  assert.equal(f.app.events.filter(event => event.type === 'assistant.permissions.updated').length, 1);
});

test('source read and model experiments are opt-in human grants with a separately bounded input quota', async t => {
  const f = await fixture(t), before = businessState(f.app), original = (await f.request()).body;
  assert.equal(original.supervisor.sourceRead, false); assert.equal(original.supervisor.modelExperiment, false);
  assert.deepEqual(original.modelExperimentLimits, { maxInputCharacters: 50000 });
  const body = update(original); body.supervisor.sourceRead = true; body.supervisor.modelExperiment = true;
  body.modelExperimentLimits = { maxInputCharacters: 4000 };
  const saved = await f.request('PUT', body); assert.equal(saved.status, 200);
  assert.equal(saved.body.supervisor.sourceRead, true); assert.equal(saved.body.supervisor.sourceRepair, false);
  assert.equal(saved.body.supervisor.modelExperiment, true); assert.deepEqual(saved.body.modelExperimentLimits, { maxInputCharacters: 4000 });
  const legacy = update(saved.body); delete legacy.supervisor.sourceRead; delete legacy.supervisor.modelExperiment;
  legacy.workflow.capture = false;
  const preserved = await f.request('PUT', legacy); assert.equal(preserved.status, 200);
  assert.equal(preserved.body.supervisor.sourceRead, true); assert.equal(preserved.body.supervisor.modelExperiment, true);
  assert.deepEqual(preserved.body.modelExperimentLimits, { maxInputCharacters: 4000 });
  await f.bridge.close(); await f.open(); assert.deepEqual((await f.request()).body, preserved.body);
  assert.deepEqual(businessState(f.app), before);
});

test('HTTP permissions reject unknown fields, role escalation, incomplete scopes and non-boolean values', async t => {
  const f = await fixture(t), original = (await f.request()).body, before = businessState(f.app);
  const cases = [
    { ...update(original), role: 'supervisor' },
    { ...update(original), immutable: { applicationSourceWrite: true } },
    { ...update(original), applicationSourceWrite: true },
    { ...update(original), admin: { shell: true } },
    { ...update(original), workflow: { ...original.workflow, crossWorkflowRead: true } },
    { ...update(original), workflow: { ...original.workflow, manageWorkflows: true } },
    { ...update(original), workflow: { ...original.workflow, permissionWrite: true } },
    { ...update(original), workflow: { ...original.workflow, sourceRepair: true } },
    { ...update(original), workflow: { ...original.workflow, sourceRead: true } },
    { ...update(original), workflow: { ...original.workflow, modelExperiment: true } },
    { ...update(original), supervisor: { ...original.supervisor, shell: true } },
    { ...update(original), supervisor: { ...original.supervisor, applicationSourceWrite: true } },
    { ...update(original), supervisor: { ...original.supervisor, role: 'root' } },
    { ...update(original), workflow: { ...original.workflow, customNodes: 'true' } },
    { ...update(original), supervisor: { ...original.supervisor, appLogs: 1 } },
    { ...update(original), supervisor: { ...original.supervisor, sourceRepair: 'true' } },
    { ...update(original), supervisor: { ...original.supervisor, sourceRead: 1 } },
    { ...update(original), supervisor: { ...original.supervisor, modelExperiment: 'true' } },
    ...[{}, { maxInputCharacters: 999 }, { maxInputCharacters: 100001 }, { maxInputCharacters: 2000.5 }, { maxInputCharacters: '50000' },
      { maxInputCharacters: 50000, maxCallsPerTurn: 3 }, null].map(modelExperimentLimits => ({ ...update(original), modelExperimentLimits })),
    { ...update(original), workflow: { ...original.workflow, workflowRead: null } },
    { ...update(original), supervisor: [] },
    { expectedRevision: original.revision, workflow: original.workflow },
    { ...update(original), workflow: { workflowRead: true } },
    { ...update(original), expectedRevision: 0 },
    { ...update(original), expectedRevision: '1' },
  ];
  const legacyClient = update(original); delete legacyClient.supervisor.sourceRepair; cases.push(legacyClient);
  for (const body of cases) assert.equal((await f.request('PUT', body)).status, 400, JSON.stringify(body));
  assert.deepEqual((await f.request()).body, original);
  assert.deepEqual(businessState(f.app), before);
  assert.equal(f.app.events.filter(event => event.type === 'assistant.permissions.updated').length, 0);
});

test('permission PUT enforces CSRF and same-origin checks before any save', async t => {
  const f = await fixture(t), original = (await f.request()).body, body = update(original);
  body.supervisor.manageWorkflows = false;
  assert.equal((await f.request('PUT', body, { 'X-Workbench-Token': '' })).status, 403);
  assert.equal((await f.request('PUT', body, { 'X-Workbench-Token': 'wrong-token' })).status, 403);
  assert.equal((await f.request('PUT', body, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await f.request('PUT', body, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.request('GET', undefined, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.deepEqual((await f.request()).body, original);
});

test('AI tool discovery and dispatcher have no permission-write, arbitrary source or shell capability', async t => {
  const f = await fixture(t), before = (await f.request()).body, business = businessState(f.app);
  const forbidden = ['assistant.permissions.update', 'assistant.permissions.save', 'permissions.write', 'settings.save',
    'app.permissions', 'source.patch', 'source.write', 'file.write', 'terminal', 'shell', 'exec'];
  const tools = f.app.applicationAssistant.tools(), names = tools.map(tool => tool.name);
  for (const name of forbidden) {
    assert.equal(names.includes(name), false, name);
    await assert.rejects(f.app.applicationAssistant.call(name, {}, { role: 'supervisor' }));
  }
  assert.deepEqual((await f.request()).body, before);
  assert.deepEqual(businessState(f.app), business);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get().count, 0);
});
