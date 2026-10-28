import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantPermissionsUI } from '../public/assistant-permissions-ui.js';

class Element {
  constructor() { this.listeners = new Map(); this.attributes = {}; this.children = []; this.checked = false; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...children) { this.children.push(...children); }
  change(value) { this.checked = value; this.listeners.get('change')?.(); }
}
function config(revision = 1) {
  const workflow = { workflowRead: true, workflowEdit: true, customNodes: true, workspaceRead: true, capture: true };
  return { revision, workflow, supervisor: { ...workflow, crossWorkflowRead: true, manageWorkflows: true, appLogs: true, sourceRead: false, sourceRepair: false, modelExperiment: false }, modelExperimentLimits: { maxInputCharacters: 50000 } };
}
function fixture(t, api, { readOnly = false } = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document'), nodes = new Map();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new Element(), getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); } } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'document', descriptor) : delete globalThis.document);
  const context = { csrfToken: 'fixture' }, ui = new AssistantPermissionsUI({ api, context: () => context, readOnly });
  return { ui, context };
}

test('permissions remain disabled until a complete versioned configuration is read', async t => {
  const calls = [], { ui } = fixture(t, async (path, options) => { calls.push({ path, options }); return config(); });
  assert.equal(ui.nodes.save.disabled, true); assert.ok([...ui.inputs.values()].every(input => input.disabled));
  await ui.refresh(); assert.deepEqual(calls, [{ path: '/api/assistant-permissions', options: undefined }]);
  assert.equal(ui.inputs.size, 16); assert.equal(ui.inputs.has('workflow.manageWorkflows'), false); assert.equal(ui.inputs.has('workflow.sourceRepair'), false);
  assert.equal(ui.inputs.has('workflow.sourceRead'), false); assert.equal(ui.inputs.has('workflow.modelExperiment'), false);
  assert.equal(ui.nodes.save.disabled, true); assert.ok([...ui.inputs].every(([key, input]) => input.checked === !['supervisor.sourceRead', 'supervisor.sourceRepair', 'supervisor.modelExperiment'].includes(key) && !input.disabled));
  assert.equal(ui.experimentInput.disabled, true); assert.equal(ui.experimentInput.value, '50000');
});

test('experimental source repair is unchecked until a person explicitly selects it and saves the complete permission payload', async t => {
  const calls = [], { ui } = fixture(t, async (path, options) => {
    calls.push({ path, options }); return options ? { revision: 2, workflow: options.body.workflow, supervisor: options.body.supervisor, modelExperimentLimits: options.body.modelExperimentLimits } : config();
  });
  await ui.refresh(); const control = ui.inputs.get('supervisor.sourceRepair'); assert.ok(control); assert.equal(control.checked, false);
  assert.equal(control.attributes['aria-label'], '总控助手：源码自修复（实验性）'); assert.equal(ui.inputs.has('workflow.sourceRepair'), false);
  control.change(true); assert.equal(ui.draft.supervisor.sourceRepair, true); assert.equal(calls.length, 1);
  await ui.save(); assert.equal(calls[1].options.body.supervisor.sourceRepair, true); assert.equal(calls[1].options.body.expectedRevision, 1);
  assert.deepEqual(calls[1].options.body.workflow, config().workflow); assert.equal(ui.data.supervisor.sourceRepair, true);
});

test('a legacy UI response without an explicit source repair flag fails closed', async t => {
  const legacy = config(); delete legacy.supervisor.sourceRepair;
  const { ui } = fixture(t, async () => legacy); await ui.refresh();
  assert.equal(ui.data, null); assert.equal(ui.nodes.save.disabled, true); assert.match(ui.nodes.status.textContent, /权限配置不完整/);
});

test('manual save sends only version and explicitly assigned role flags', async t => {
  const calls = [], { ui } = fixture(t, async (path, options) => { calls.push({ path, options }); return options ? { revision: 2, workflow: options.body.workflow, supervisor: options.body.supervisor, modelExperimentLimits: options.body.modelExperimentLimits, protection: 'human-only' } : { ...config(), workspaceRoot: '/fixture' }; });
  await ui.refresh(); ui.inputs.get('workflow.customNodes').change(false); ui.inputs.get('supervisor.manageWorkflows').change(false);
  assert.equal(ui.nodes.save.disabled, false); await ui.save();
  assert.deepEqual(calls[1], { path: '/api/assistant-permissions', options: { method: 'PUT', body: { expectedRevision: 1, workflow: { ...config().workflow, customNodes: false }, supervisor: { ...config().supervisor, manageWorkflows: false }, modelExperimentLimits: { maxInputCharacters: 50000 } } } });
  assert.equal(ui.data.revision, 2); assert.equal(ui.nodes.save.disabled, true); assert.match(ui.nodes.status.textContent, /权限已保存/);
});

test('the current working folder is displayed as read-only metadata and never submitted', async t => {
  const calls = [], { ui } = fixture(t, async (_path, options) => {
    calls.push(options);
    return { ...config(options ? 2 : 1), workspaceRoot: '/fixture/current-folder' };
  });
  assert.equal(ui.nodes.folder.textContent, '尚未读取'); await ui.refresh();
  assert.equal(ui.data.workspaceRoot, '/fixture/current-folder'); assert.equal(ui.nodes.folder.textContent, '/fixture/current-folder');
  ui.inputs.get('supervisor.capture').change(false); await ui.save();
  assert.equal(Object.hasOwn(calls[1].body, 'workspaceRoot'), false); assert.equal(ui.nodes.folder.textContent, '/fixture/current-folder');
});

test('failed save retains the draft and its original revision until explicit refresh', async t => {
  let revision = 1; const { ui } = fixture(t, async (_path, options) => { if (options) throw new Error('权限版本已变化'); return config(revision); });
  await ui.refresh(); ui.inputs.get('workflow.workflowEdit').change(false); await ui.save();
  assert.equal(ui.draft.workflow.workflowEdit, false); assert.equal(ui.data.revision, 1); assert.match(ui.nodes.status.textContent, /权限版本已变化/);
  revision = 3; await ui.refresh(); assert.equal(ui.data.revision, 1);
  await ui.refresh({ discardDraft: true }); assert.equal(ui.data.revision, 3); assert.equal(ui.draft.workflow.workflowEdit, true);
});

test('duplicate saves and draft changes are blocked while applying', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }), writes = [];
  const { ui } = fixture(t, async (_path, options) => { if (!options) return config(); writes.push(options); await gate; return { ...options.body, revision: 2 }; });
  await ui.refresh(); ui.inputs.get('supervisor.appLogs').change(false); const pending = ui.save(); await ui.save();
  assert.equal(writes.length, 1); assert.equal(ui.nodes.refresh.disabled, true); assert.ok([...ui.inputs.values()].every(input => input.disabled));
  ui.inputs.get('workflow.capture').change(false); assert.equal(ui.draft.workflow.capture, true);
  release(); await pending; assert.equal(ui.data.supervisor.appLogs, false);
});

test('diagnostic captures and a missing CSRF token cannot save permissions', async t => {
  const calls = [], { ui, context } = fixture(t, async (_path, options) => { calls.push(options); return config(); }, { readOnly: true });
  await ui.refresh(); ui.inputs.get('workflow.capture').change(false); await ui.save();
  assert.equal(ui.draft.workflow.capture, true); assert.deepEqual(calls, [undefined]); assert.ok([...ui.inputs.values()].every(input => input.disabled));
  ui.readOnly = false; context.csrfToken = ''; ui.render(); ui.inputs.get('workflow.capture').change(false); await ui.save();
  assert.equal(calls.length, 1); assert.equal(ui.nodes.save.disabled, true);
});

test('partial or invalid settings fail closed instead of inventing enabled permissions', async t => {
  const { ui } = fixture(t, async () => ({ revision: 1, workflow: {}, supervisor: {} }));
  await ui.refresh(); assert.equal(ui.data, null); assert.ok([...ui.inputs.values()].every(input => input.disabled && !input.checked));
  assert.match(ui.nodes.status.textContent, /权限配置不完整/);
});

test('source read and model experiments are independent human drafts and the input quota saves only with explicit permission save', async t => {
  const calls = [], { ui } = fixture(t, async (_path, options) => {
    calls.push(options); return options ? { ...options.body, revision: 2 } : config();
  });
  await ui.refresh(); const read = ui.inputs.get('supervisor.sourceRead'), experiment = ui.inputs.get('supervisor.modelExperiment');
  assert.equal(read.checked, false); read.change(true); assert.equal(ui.draft.supervisor.sourceRepair, false);
  assert.equal(calls.length, 1); assert.equal(ui.experimentInput.disabled, true);
  experiment.change(true); assert.equal(ui.experimentInput.disabled, false);
  ui.experimentInput.value = '4000'; ui.experimentInput.listeners.get('input')();
  assert.equal(ui.draft.modelExperimentLimits.maxInputCharacters, 4000); assert.equal(calls.length, 1);
  await ui.save(); assert.equal(calls[1].body.supervisor.sourceRead, true); assert.equal(calls[1].body.supervisor.sourceRepair, false);
  assert.equal(calls[1].body.supervisor.modelExperiment, true); assert.deepEqual(calls[1].body.modelExperimentLimits, { maxInputCharacters: 4000 });
  assert.equal(ui.data.modelExperimentLimits.maxInputCharacters, 4000); assert.equal(ui.dirty(), false);
});

test('invalid experiment quotas cannot be saved and disabled experiments retain their last valid input budget', async t => {
  const calls = [], { ui } = fixture(t, async (_path, options) => { calls.push(options); return options ? { ...options.body, revision: 2 } : config(); });
  await ui.refresh(); ui.inputs.get('supervisor.modelExperiment').change(true);
  ui.experimentInput.value = '999'; ui.experimentInput.listeners.get('input')(); await ui.save();
  assert.equal(calls.length, 1); assert.match(ui.nodes.status.textContent, /1000–100000/);
  ui.inputs.get('supervisor.modelExperiment').change(false); await ui.save();
  assert.equal(calls[1].body.supervisor.modelExperiment, false); assert.deepEqual(calls[1].body.modelExperimentLimits, { maxInputCharacters: 50000 });
  assert.equal(ui.experimentInput.disabled, true);
});
