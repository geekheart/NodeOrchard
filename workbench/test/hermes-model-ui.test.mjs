import test from 'node:test';
import assert from 'node:assert/strict';
import { HermesModelUI, hermesModelLabel } from '../public/hermes-model-ui.js';

class Element {
  constructor() { this.listeners = new Map(); this.attributes = {}; this.children = []; this.value = ''; this.open = false; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  setAttribute(name, value) { this.attributes[name] = value; }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get('close')?.(); }
  change(value) { this.value = value; this.listeners.get('change')?.(); }
  input(value) { this.value = value; this.listeners.get('input')?.(); }
}
function catalog(current = { provider: 'subscription', model: 'model-a' }) {
  return { connected: true, current, providers: [
    { id: 'subscription', label: '订阅服务', authenticated: true, models: ['model-a', 'model-b'] },
    { id: 'local', label: '本地端点', authenticated: true, models: ['local-model'] },
    { id: 'unknown', label: '未确认端点', authenticated: null, models: ['unknown-model'] },
    { id: 'unconfigured', label: '未认证服务', authenticated: false, models: ['locked-model'] },
  ] };
}
function fixture(t, api, overrides = {}) {
  const nodes = new Map(), descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); }, createElement() { return new Element(); } } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'document', descriptor) : delete globalThis.document);
  const context = { backend: { state: 'ready', provider: 'subscription', model: 'model-a' }, csrfToken: 'local-session-token', connecting: false, ...overrides };
  const changes = [], ui = new HermesModelUI({ api, context: () => context, connect: async () => {}, changed: (...args) => changes.push(args) });
  return { ui, context, changes };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('global selector displays provider and model; disconnected state offers Hermes connection', async t => {
  const { ui } = fixture(t, async () => ({ ...catalog(), connected: false }), { backend: { state: 'stopped' } });
  await ui.open();
  assert.equal(ui.nodes.dialog.open, true);
  assert.equal(ui.nodes.label.textContent, 'subscription / model-a');
  assert.equal(ui.nodes.button.attributes['aria-expanded'], 'true');
  assert.match(ui.nodes.button.title, /subscription \/ model-a/);
  assert.equal(ui.nodes.connect.hidden, false);
  ui.nodes.model.input('model-b'); assert.equal(ui.nodes.apply.disabled, true);
  ui.nodes.dialog.close(); assert.equal(ui.nodes.button.attributes['aria-expanded'], 'false');
  assert.equal(hermesModelLabel({}), 'Hermes 模型');
});

test('applies explicit provider/model only, without credentials or a local preference override', async t => {
  const requests = [], { ui, changes } = fixture(t, async (path, options) => {
    requests.push({ path, options }); return options?.method === 'POST' ? catalog(options.body) : catalog();
  });
  await ui.refresh(); assert.equal(ui.nodes.apply.disabled, true);
  ui.nodes.provider.change('local'); ui.nodes.model.input('custom/local-model');
  assert.equal(ui.nodes.apply.disabled, false);
  await ui.apply();
  assert.deepEqual(requests.at(-1), { path: '/api/models', options: { method: 'POST', body: { provider: 'local', model: 'custom/local-model' } } });
  assert.equal(ui.nodes.label.textContent, 'local / custom/local-model');
  assert.match(ui.nodes.status.textContent, /已更新 Hermes 默认模型/);
  assert.equal(ui.nodes.apply.disabled, true);
  assert.deepEqual(changes.at(-1)[1], { applied: true });
});

test('failed application retains the chosen provider/model and preserves the actual current model', async t => {
  let reject = true;
  const { ui } = fixture(t, async (_path, options) => {
    if (options?.method === 'POST' && reject) throw new Error('模型不可用');
    return options ? catalog(options.body) : catalog();
  });
  await ui.refresh(); ui.nodes.provider.change('local'); ui.nodes.model.input('custom-model');
  await ui.apply();
  assert.deepEqual(ui.selection, { provider: 'local', model: 'custom-model' });
  assert.equal(ui.nodes.model.value, 'custom-model'); assert.equal(ui.current().model, 'model-a');
  assert.match(ui.nodes.status.textContent, /模型不可用/); assert.equal(ui.nodes.status.attributes.role, 'alert');
  assert.equal(ui.nodes.apply.disabled, false);
  reject = false; await ui.apply(); assert.equal(ui.current().model, 'custom-model');
});

test('refresh keeps an unsaved selection while updating Hermes current configuration and catalogue', async t => {
  let data = catalog(); const { ui } = fixture(t, async () => data);
  await ui.refresh(); ui.nodes.model.input('model-b');
  data = catalog({ provider: 'local', model: 'changed-outside-workbench' });
  await ui.refresh({ preserveSelection: true });
  assert.equal(ui.current().model, 'changed-outside-workbench');
  assert.deepEqual(ui.selection, { provider: 'subscription', model: 'model-b' });
  await ui.open(); assert.equal(ui.selection.model, 'changed-outside-workbench');
});

test('mutation controls wait for configuration and prevent duplicate application or closing during a save', async t => {
  const gate = deferred(), requests = [], { ui } = fixture(t, async (_path, options) => {
    if (options) { requests.push(options); await gate.promise; return catalog(options.body); }
    return catalog();
  });
  await ui.refresh(); ui.nodes.model.input('model-b'); const saving = ui.apply();
  assert.equal(ui.nodes.apply.disabled, true); assert.equal(ui.nodes.refresh.disabled, true);
  assert.equal(ui.nodes.model.disabled, true); assert.equal(ui.nodes.close.disabled, true);
  let prevented = false; ui.nodes.dialog.listeners.get('cancel')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  await ui.apply(); assert.equal(requests.length, 1);
  gate.resolve(); await saving; assert.equal(ui.nodes.close.disabled, false);
});

test('unconfigured providers, unknown authentication and a missing CSRF token cannot apply', async t => {
  const { ui, context } = fixture(t, async () => catalog()); await ui.refresh();
  ui.nodes.provider.change('unconfigured'); assert.equal(ui.nodes.apply.disabled, true); assert.equal(ui.nodes.model.disabled, true);
  assert.match(ui.nodes.authentication.textContent, /在 Hermes 中完成认证/);
  ui.nodes.provider.change('unknown'); assert.equal(ui.nodes.apply.disabled, true); assert.equal(ui.nodes.model.disabled, true);
  assert.match(ui.nodes.authentication.textContent, /尚未确认/);
  ui.nodes.provider.change('local'); assert.equal(ui.nodes.apply.disabled, false);
  context.csrfToken = ''; ui.render(); assert.equal(ui.nodes.apply.disabled, true);
});

test('a refresh failure keeps a previous draft and a disappeared provider cannot be silently applied', async t => {
  let mode = 'ok'; const { ui } = fixture(t, async () => {
    if (mode === 'fail') throw new Error('连接中断');
    return mode === 'empty' ? { ...catalog(), providers: [] } : catalog();
  });
  await ui.refresh(); ui.nodes.provider.change('local'); ui.nodes.model.input('custom-model');
  mode = 'fail'; await ui.refresh({ preserveSelection: true });
  assert.equal(ui.nodes.model.value, 'custom-model'); assert.match(ui.nodes.status.textContent, /连接中断/);
  mode = 'empty'; await ui.refresh({ preserveSelection: true });
  assert.equal(ui.selection.provider, 'local'); assert.equal(ui.nodes.apply.disabled, true);
  assert.equal(ui.nodes.model.disabled, true);
});

test('a failed Hermes connection reports the failure inside the dialog without clearing the draft', async t => {
  const { ui } = fixture(t, async () => ({ ...catalog(), connected: false }), { backend: { state: 'stopped' } });
  await ui.refresh(); ui.nodes.provider.change('local'); ui.nodes.model.input('custom-model');
  ui.connect = async () => false;
  await ui.nodes.connect.listeners.get('click')();
  assert.equal(ui.nodes.status.attributes.role, 'alert');
  assert.match(ui.nodes.status.textContent, /连接失败/);
  assert.deepEqual(ui.selection, { provider: 'local', model: 'custom-model' });
  assert.equal(ui.nodes.connect.disabled, false);
});
