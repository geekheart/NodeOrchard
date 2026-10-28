import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_SKILL_TEMPLATE, SkillAuthoringUI, SkillToolsetsUI, skillIntegrations } from '../public/skill-authoring-ui.js';
import { WorkflowRuntimeUI, mergeSkillToolsetsDraft } from '../public/workflow-runtime-ui.js';
import { createDocument, createNode } from '../shared/workflow/workflow-model.mjs';

const revision = `sha256:${'a'.repeat(64)}`;
const skill = { name: 'my-image-skill', description: '真实图片', content: '指令', revision, source: 'local', requiredToolsets: ['image_gen'] };
const catalog = () => ({ connected: true, toolsets: [
  { id: 'image_gen', label: '图片生成', available: true, enabled: true, tools: ['image_generate'], reason: '' },
  { id: 'browser', label: '浏览器', available: true, enabled: false, tools: ['browser_navigate'], reason: '请在 Hermes 中启用' },
  { id: 'computer_use', label: 'Computer Use', available: false, enabled: false, tools: [], reason: '缺少桌面控制依赖' },
  { id: 'mcp-drawing', label: '已配置绘图 MCP', available: false, enabled: true, tools: ['mcp-drawing-create'], reason: '服务未就绪' },
], imageProviders: [{ id: 'provider-a', label: '图像 A', available: true, reason: '' }, { id: 'provider-b', label: '图像 B', available: true, reason: '' },
  { id: 'missing', label: '待认证服务', available: false, reason: '请在 Hermes 中认证' }], selectedImageProvider: 'provider-a' });

class Element {
  constructor(tagName) { Object.assign(this, { tagName, children: [], attributes: {}, listeners: new Map(), dataset: {}, value: '', textContent: '', hidden: false, disabled: false, checked: false, open: false }); }
  append(...nodes) { for (const item of nodes) { item.parent = this; this.children.push(item); } }
  replaceChildren(...nodes) { for (const item of this.children) item.parent = null; this.children = []; this.textContent = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  dispatchEvent(event) { this.listeners.get(event.type)?.(event); return true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get('close')?.({}); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  focus() { document.activeElement = this; }
  get isConnected() { return this === document.body || Boolean(this.parent?.isConnected); }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const labels = node => descendants(node).map(item => item.textContent).filter(Boolean).join('\n');
const find = (node, text) => descendants(node).find(item => item.textContent === text);
const check = (node, id) => descendants(node).find(item => item.tagName === 'input' && item.type === 'checkbox' && item.value === id);
const tick = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function dom(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const value = { createElement: name => new Element(name), body: new Element('body'), activeElement: null };
  Object.defineProperty(globalThis, 'document', { value, configurable: true });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'document', original); else delete globalThis.document; }); return value;
}
const fill = session => { session.name.value = skill.name; session.description.value = skill.description; session.instructions.value = skill.content; };

test('integration projection uses actual catalog identities and rejects malformed capabilities', () => {
  const data = catalog(); data.apiKey = 'must-not-project'; data.toolsets[0].secret = 'must-not-project';
  const value = skillIntegrations(data); assert.equal(value.apiKey, undefined); assert.equal(value.toolsets[0].secret, undefined);
  assert.deepEqual(value.toolsets.map(row => row.id), ['image_gen', 'browser', 'computer_use', 'mcp-drawing']);
  assert.throws(() => skillIntegrations({ ...data, toolsets: [...data.toolsets, data.toolsets[0]] }), /响应无效/);
  assert.throws(() => skillIntegrations({ ...data, toolsets: [{ ...data.toolsets[0], enabled: undefined }] }), /响应无效/);
});

test('tool choices preserve unavailable dependencies and expose missing Figma without inventing a selectable tool', async t => {
  dom(t); const host = new Element('section'), changes = [];
  const ui = new SkillToolsetsUI(host, { api: async () => catalog(), selected: ['legacy-mcp'], onChange: values => changes.push(values) }); await ui.load();
  assert.match(labels(host), /浏览器 · 未启用/); assert.match(labels(host), /缺少桌面控制依赖/); assert.match(labels(host), /Figma · 未配置 MCP/);
  assert.match(labels(host), /legacy-mcp · 目录未确认，保留原选择/);
  assert.equal(descendants(host).filter(item => item.type === 'checkbox').length, 4);
  const unavailable = check(host, 'computer_use'); assert.equal(unavailable.disabled, false); unavailable.checked = true; unavailable.dispatchEvent(new Event('change'));
  assert.deepEqual(changes, [['computer_use', 'legacy-mcp']]);
  ui.readOnly = true; ui.render(); assert.equal(check(host, 'image_gen').disabled, true);
  check(host, 'image_gen').checked = true; check(host, 'image_gen').dispatchEvent(new Event('change')); assert.equal(changes.length, 1);
});

test('tool dependency choices use canonical sets and refuse a seventeenth declaration', async t => {
  dom(t); const host = new Element('section'), data = catalog(); data.toolsets = Array.from({ length: 17 }, (_, index) => ({ id: 'mcp-' + index.toString().padStart(2, '0'), label: 'MCP ' + index, available: true, enabled: true, tools: ['tool_' + index] }));
  const ui = new SkillToolsetsUI(host, { api: async () => data, selected: data.toolsets.slice(0, 16).map(row => row.id) }); await ui.load();
  const extra = check(host, 'mcp-16'); extra.checked = true; extra.dispatchEvent(new Event('change')); assert.equal(ui.selected.length, 16); assert.equal(check(host, 'mcp-16').checked, false); assert.match(labels(host), /最多选择 16/);
  ui.setSelected(['image_gen', 'browser', 'image_gen']); assert.deepEqual(ui.selected, ['browser', 'image_gen']);
});

test('new Skill reads back the exact version and only then invokes the binding callback', async t => {
  dom(t); const requests = [], created = [], ui = new SkillAuthoringUI({ api: async (path, options) => {
    requests.push({ path, options }); if (path === '/api/skill-integrations') return catalog(); if (options?.method === 'POST') return { skill }; return skill;
  } }); await ui.open({ onCreated: value => created.push(value) }); const session = ui.session;
  assert.equal(requests.length, 1); session.name.value = skill.name; find(session.dialog, '图片生成模板').dispatchEvent(new Event('click'));
  assert.equal(session.instructions.value, IMAGE_SKILL_TEMPLATE); assert.deepEqual(session.integrations.selected, ['image_gen']);
  assert.equal(session.provider.value, 'provider-a'); assert.equal(session.providerApply.disabled, true);
  assert.equal(await ui.create(), true); assert.equal(created.length, 1); assert.equal(created[0].revision, revision); assert.equal(session.dialog.open, false);
  const post = requests.find(item => item.options?.method === 'POST'); assert.equal(post.path, '/api/skills'); assert.deepEqual(post.options.body.requiredToolsets, ['image_gen']);
  assert.match(post.options.body.operationId, /^[a-f0-9-]{36}$/); assert.equal(requests.at(-1).path, '/api/skills/' + skill.name);
});

test('create retries preserve operation identity after unknown results and changed fields receive a new identity', async t => {
  dom(t); const posts = [], ui = new SkillAuthoringUI({ api: async (path, options) => {
    if (path === '/api/skill-integrations') return catalog(); if (options?.method === 'POST') { posts.push(options.body); throw Error('请求超时，结果未知'); } throw Error('unexpected read');
  } }); await ui.open(); fill(ui.session);
  assert.equal(await ui.create(), false); assert.equal(await ui.create(), false); assert.equal(posts[0].operationId, posts[1].operationId);
  ui.session.instructions.value += '修改'; assert.equal(await ui.create(), false); assert.notEqual(posts[2].operationId, posts[0].operationId);
  assert.equal(posts.length, 3, 'only explicit retries may issue another mutation');
});

test('authoring validates UTF-8 byte limits before a mutation', async t => {
  dom(t); let mutations = 0; const ui = new SkillAuthoringUI({ api: async (_path, options) => { if (options?.method) mutations++; return catalog(); } });
  await ui.open(); fill(ui.session); ui.session.description.value = '中'.repeat(667); assert.equal(await ui.create(), false);
  ui.session.description.value = '说明'; ui.session.instructions.value = '中'.repeat(16001); assert.equal(await ui.create(), false); assert.equal(mutations, 0);
  assert.match(ui.session.status.textContent, /48000 字节/);
  fill(ui.session); ui.session.name.value = 'a'.repeat(65); assert.equal(await ui.create(), false); assert.equal(mutations, 0);
});

test('a successful create with failed readback retries only the read and never declares it bound', async t => {
  dom(t); let posts = 0, reads = 0, callbacks = 0; const ui = new SkillAuthoringUI({ api: async (path, options) => {
    if (path === '/api/skill-integrations') return catalog(); if (options?.method === 'POST') { posts++; return { skill }; }
    reads++; return reads === 1 ? { ...skill, revision: `sha256:${'b'.repeat(64)}` } : skill;
  } }); await ui.open({ onCreated: () => callbacks++ }); fill(ui.session);
  assert.equal(await ui.create(), false); assert.equal(callbacks, 0); assert.match(ui.session.status.textContent, /读回版本不一致/);
  assert.equal(await ui.create(), true); assert.equal(posts, 1); assert.equal(reads, 2); assert.equal(callbacks, 1);
});

test('duplicate submit and a closed dialog cannot bind late Skill creation to another target', async t => {
  dom(t); const pending = gate(); let posts = 0, callbacks = 0; const ui = new SkillAuthoringUI({ api: async (path, options) => {
    if (path === '/api/skill-integrations') return catalog(); if (options?.method === 'POST') { posts++; return pending.promise; } return skill;
  } }); await ui.open({ onCreated: () => callbacks++ }); fill(ui.session);
  const creating = ui.create(); assert.equal(ui.session.submit.disabled, true); assert.equal(await ui.create(), false); ui.session.dialog.close();
  pending.resolve({ skill }); assert.equal(await creating, false); assert.equal(posts, 1); assert.equal(callbacks, 0); assert.equal(document.body.children.length, 0);
});

test('provider choice is explicit, version checked, idempotent on retry and verified by a fresh read', async t => {
  dom(t); let data = catalog(), failures = 1; const posts = [], ui = new SkillAuthoringUI({ api: async (path, options) => {
    if (path === '/api/skill-integrations') return structuredClone(data);
    assert.equal(path, '/api/skill-integrations/image-provider'); posts.push(options.body);
    if (failures--) throw Error('请求超时'); data.selectedImageProvider = options.body.provider; return { provider: options.body.provider };
  } }); await ui.open(); const session = ui.session; session.provider.value = 'provider-b'; session.provider.dispatchEvent(new Event('change'));
  assert.equal(posts.length, 0); assert.equal(session.providerApply.disabled, false); assert.equal(await ui.applyProvider(), false); assert.equal(await ui.applyProvider(), true);
  assert.equal(posts.length, 2); assert.equal(posts[0].expectedProvider, 'provider-a'); assert.equal(posts[0].operationId, posts[1].operationId);
  assert.equal(session.integrations.data.selectedImageProvider, 'provider-b'); assert.equal(session.providerApply.disabled, true); assert.equal(await ui.applyProvider(), false);
});

test('provider failure and disconnected or readonly authoring cannot report success or mutate', async t => {
  dom(t); let mutations = 0; const ui = new SkillAuthoringUI({ api: async (_path, options) => { if (options?.method) { mutations++; return {}; } return catalog(); } });
  await ui.open(); ui.session.provider.value = 'provider-b'; assert.equal(await ui.applyProvider(), false); assert.match(ui.session.status.textContent, /尚未确认/);
  ui.session.integrations.data.connected = false; fill(ui.session); assert.equal(await ui.create(), false); assert.equal(mutations, 1);
  const readonly = new SkillAuthoringUI({ readOnly: true, api: () => { throw Error('must not read or write'); } }); assert.equal(await readonly.open(), false);
});

function picker(t, config = {}) {
  dom(t); const item = createNode('skill', {}, { id: 'skill-node', config }), doc = createDocument(); doc.nodes = [item];
  const runtime = Object.create(WorkflowRuntimeUI.prototype), form = new Element('form'); document.body.append(form);
  Object.assign(runtime, { pickers: new Set(), skills: { connected: true, skills: [skill] }, skillPending: new Set(),
    editor: { doc, propertyDrafts: new Map(), renderHeader() {} }, getBackend: () => ({ state: 'ready' }), updateRunButton() {},
    api: async path => path === '/api/skill-integrations' ? catalog() : skill });
  return { runtime, form, item, doc };
}

test('new Skill binding preserves the latest unrelated inspector draft and reads canonical requirements', async t => {
  const { runtime, form, item, doc } = picker(t); let onCreated;
  runtime.skillAuthoring = { open(options) { onCreated = options.onCreated; } }; runtime.loadSkills = async () => runtime.skills;
  runtime.mountSkillPicker(form, item); await tick(); find(form, '新建 Skill').dispatchEvent(new Event('click'));
  const draft = { title: '仍在编辑的标题', config: { ...item.config, instructions: '仍在编辑的指令', timeoutSeconds: 77 }, ports: [{ id: 'unchanged' }] };
  runtime.editor.propertyDrafts.set(item.id, draft); await onCreated(skill);
  const saved = runtime.editor.propertyDrafts.get(item.id); assert.equal(saved.title, draft.title); assert.equal(saved.config.instructions, draft.config.instructions); assert.equal(saved.config.timeoutSeconds, 77);
  assert.deepEqual(saved.ports, draft.ports); assert.equal(saved.config.skillRef, skill.name); assert.equal(saved.config.version, revision); assert.deepEqual(saved.config.requiredToolsets, ['image_gen']);
  assert.equal(form.children[0].children[4].value, skill.name, 'the visible picker must reflect the newly created reference');
  const before = structuredClone(saved); runtime.editor.doc = { ...doc, id: 'another-workflow' }; await assert.rejects(onCreated(skill), /原工作流或节点已变化/);
  assert.deepEqual(runtime.editor.propertyDrafts.get(item.id), before);
  runtime.editor.doc = doc; await assert.rejects(onCreated(skill, { isCurrent: () => false }), /原工作流或节点已变化/); assert.deepEqual(runtime.editor.propertyDrafts.get(item.id), before);
});

test('refreshing a pinned Skill retains saved requirements while user selection of another Skill adopts its declarations', async t => {
  const { runtime, form, item } = picker(t, { skillRef: skill.name, version: revision, requiredToolsets: ['browser'] });
  runtime.mountSkillPicker(form, item); await tick(); const wrapper = form.children[0];
  find(form, '更新内容指纹').dispatchEvent(new Event('click')); await tick();
  assert.deepEqual(runtime.editor.propertyDrafts.get(item.id).config.requiredToolsets, ['browser'], 'same-version refresh must not silently replace saved selection');
  assert.equal(wrapper.children.find(child => child.name === 'requiredToolsets').value, '["browser"]');
  runtime.api = async path => path === '/api/skill-integrations' ? catalog() : { ...skill, name: 'new-skill' };
  const select = wrapper.children[4]; select.value = 'new-skill'; select.dispatchEvent(new Event('change')); await tick();
  assert.deepEqual(runtime.editor.propertyDrafts.get(item.id).config.requiredToolsets, ['image_gen']);
});

test('dependency changes while Skill details are pending win over returned defaults and refuse cross-scope changes', async t => {
  const { runtime, form, item, doc } = picker(t); const pending = gate();
  runtime.api = async path => path === '/api/skill-integrations' ? catalog() : pending.promise; runtime.mountSkillPicker(form, item); await tick();
  const select = form.children[0].children[4]; select.value = skill.name; select.dispatchEvent(new Event('change'));
  check(form, 'browser').checked = true; check(form, 'browser').dispatchEvent(new Event('change'));
  pending.resolve(skill); await tick(); assert.deepEqual(runtime.editor.propertyDrafts.get(item.id).config.requiredToolsets, ['browser']);
  const snapshot = structuredClone(runtime.editor.propertyDrafts.get(item.id)); runtime.editor.doc = { ...doc, id: 'other' };
  assert.equal(mergeSkillToolsetsDraft(runtime.editor, doc.id, item.id, ['image_gen']), false); assert.deepEqual(runtime.editor.propertyDrafts.get(item.id), snapshot);
});
