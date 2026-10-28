import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillLibraryUI, skillSource, workflowReferencesSkill, propertyDraftReferencesSkill } from '../public/skill-library-ui.js';

const revision = 'sha256:' + 'a'.repeat(64);
const generated = { name: 'my-image-skill', description: '新建图片能力', content: '实际正文', revision,
  creationId: 'fa010837-b354-4d72-8a62-fab29ea62412',
  source: 'local', origin: { kind: 'generated', canDelete: true }, usage: 'workflow' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const descendants = node => [node, ...node.children.flatMap(descendants)];
class Element {
  constructor(tagName) { Object.assign(this, { tagName, className: '', attributes: {}, dataset: {}, children: [], listeners: new Map(), textContent: '', disabled: false, open: false }); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.get('close')?.(); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  click() { if (!this.disabled) this.listeners.get('click')?.(); }
  focus() {}
}
function fixture(t, options = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'), body = new Element('body');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { body, createElement: name => new Element(name), createElementNS: (_namespace, name) => new Element(name) } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document);
  const list = new Element('section'), detail = new Element('article'), calls = [], removed = [];
  const ui = new SkillLibraryUI({ list, detail, api: async (path, request) => {
    calls.push({ path, request: structuredClone(request) });
    return { deleted: true, name: generated.name, operationId: request.body.operationId };
  }, onDeleted: async result => removed.push(result), ...options });
  const render = (skill = generated, skills = [skill], extra = {}) => ui.render({ skills, selectedName: skill.name, selected: skill, ...extra });
  const removeButton = () => descendants(detail).find(node => node.attributes['aria-label'] === '删除 Skill');
  const dialogButton = text => descendants(body).find(node => node.tagName === 'button' && node.textContent === text);
  return { ui, list, detail, body, calls, removed, render, removeButton, dialogButton };
}

test('Skills are grouped by trusted provenance and builtins or unknown sources never receive delete controls', t => {
  const f = fixture(t), skills = [
    { ...generated, name: 'native', origin: { kind: 'hermes-builtin', canDelete: true } },
    { ...generated, name: 'workbench:assistant:diagnose-workflow', usage: 'assistant', origin: { kind: 'workbench-builtin', canDelete: true } },
    generated, { ...generated, name: 'legacy', source: 'generated', origin: undefined },
  ];
  for (const skill of skills) {
    f.render(skill, skills);
    assert.deepEqual(f.list.children.map(node => node.attributes['aria-label']), ['Hermes 自带', '工作台内置', '后续创建', '其他来源']);
    assert.equal(Boolean(f.removeButton()), skill.name === generated.name);
  }
  assert.equal(skillSource({ ...generated, revision: 'invalid' }).canDelete, false);
  assert.equal(skillSource({ source: 'local' }).kind, 'unknown');
  f.render(generated, skills); assert.equal(f.removeButton().title, '删除 Skill');
});

test('deletion requires confirmation and posts only the selected name, revision and stable operation identity', async t => {
  const f = fixture(t); f.render(); f.removeButton().click(); f.dialogButton('取消').click();
  assert.equal(f.calls.length, 0);
  f.removeButton().click(); f.dialogButton('删除').click(); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, '/api/skills/my-image-skill/delete');
  assert.deepEqual(Object.keys(f.calls[0].request.body).sort(), ['expectedCreationId', 'expectedRevision', 'operationId']);
  assert.equal(f.calls[0].request.body.expectedCreationId, generated.creationId);
  assert.equal(f.calls[0].request.body.expectedRevision, revision); assert.match(f.calls[0].request.body.operationId, /^[a-f0-9-]{36}$/);
  assert.equal(f.removed.length, 1); assert.equal(f.body.children.length, 0);
});

test('local draft references, diagnostic read-only mode and a changed detail prevent a stale deletion', async t => {
  let reason = '';
  const f = fixture(t, { draftReferenceReason: () => reason }); f.render(); f.removeButton().click();
  reason = '当前编辑草稿仍在使用此 Skill'; f.dialogButton('删除').click(); await tick();
  assert.equal(f.calls.length, 0); assert(descendants(f.body).some(node => node.textContent === reason));
  f.render({ ...generated, revision: 'sha256:' + 'b'.repeat(64) }); assert.equal(f.body.children.length, 0);
  f.ui.readOnly = true; f.render(); assert.equal(f.removeButton(), undefined);
  f.ui.readOnly = false; f.render(generated, [generated], { loading: true }); assert.equal(f.removeButton().disabled, true);
});

test('failed delete retries retain one identity and malformed receipts never claim success', async t => {
  const calls = [], f = fixture(t, { api: async (path, request) => { calls.push({ path, request }); throw Error('结果尚未确认'); } });
  f.render(); f.removeButton().click(); f.dialogButton('删除').click(); await tick(); f.dialogButton('删除').click(); await tick();
  assert.equal(calls.length, 2); assert.equal(calls[0].request.body.operationId, calls[1].request.body.operationId); assert.equal(f.removed.length, 0);
  f.ui.api = async () => ({ deleted: true, name: 'another-skill', operationId: 'invalid' }); f.dialogButton('删除').click(); await tick();
  assert.equal(f.removed.length, 0); assert(descendants(f.body).some(node => /尚未确认/.test(node.textContent)));
});

test('same-name same-content replacement closes an old confirmation before a delete can target the new creation', async t => {
  const f = fixture(t); f.render(); f.removeButton().click();
  f.render({ ...generated, creationId: '9d9c653e-d2b5-4bbb-a93d-37585bde9d5a' });
  assert.equal(f.body.children.length, 0); assert.equal(f.calls.length, 0);
  f.removeButton().click(); f.dialogButton('删除').click(); await tick();
  assert.equal(f.calls[0].request.body.expectedCreationId, '9d9c653e-d2b5-4bbb-a93d-37585bde9d5a');
});

test('a confirmed delete is not repeated when only refreshing its list fails', async t => {
  const f = fixture(t, { onDeleted: async () => { throw Error('refresh failed'); } });
  f.render(); f.removeButton().click(); f.dialogButton('删除').click(); await tick();
  assert.equal(f.calls.length, 1); assert(descendants(f.body).some(node => node.textContent === '已删除，列表刷新失败，请手动刷新。'));
  f.dialogButton('删除').click(); await tick(); assert.equal(f.calls.length, 1);
});

test('draft usage checks include nested workflows and cannot be escaped with a recursive graph', () => {
  const root = { nodes: [{ type: 'subflow', config: { document: { nodes: [{ type: 'skill', config: { skillRef: generated.name } }] } } }] };
  assert.equal(workflowReferencesSkill(root, generated.name), true); assert.equal(workflowReferencesSkill(root, 'unused'), false);
  root.nodes[0].config.document = root; assert.equal(workflowReferencesSkill(root, 'unused'), true);
  assert.equal(propertyDraftReferencesSkill(new Map([['pending-node', { config: { skillRef: generated.name } }]]).values(), generated.name), true);
  assert.equal(propertyDraftReferencesSkill([['cached-node', { config: { skillRef: generated.name } }]], generated.name), true);
  assert.equal(propertyDraftReferencesSkill(undefined, generated.name), false);
});
