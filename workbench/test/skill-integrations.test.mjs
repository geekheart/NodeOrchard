import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillIntegrations, projectSkillIntegrations } from '../src/skill-integrations.mjs';
import { declaredSkillToolsets } from '../shared/workflow/workflow-integrations.mjs';
import { Application } from '../src/application.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { readConfig } from '../src/config.mjs';

const revision = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
class Native extends EventEmitter {
  constructor() { super(); this.state = 'ready'; this.serverRequests = new Map(); this.calls = []; this.created = new Map(); this.provider = ''; }
  catalog() { return { revision: revision(this.provider), toolsets: [{ id: 'image_gen', label: '图片生成', enabled: Boolean(this.provider), available: Boolean(this.provider), tools: this.provider ? ['image_generate'] : [], reason: this.provider ? '' : '请选择图片提供商' }],
    selectedImageProvider: this.provider, imageProviders: [{ id: 'openai-codex', label: 'ChatGPT / Codex', available: true, reason: '' }] }; }
  async request(method, input) {
    this.calls.push([method, input]);
    if (this.override) { const value = this.override(method, input); if (value !== undefined) return value; }
    if (method === 'workbench.tools.catalog') return this.catalog();
    if (method === 'workbench.image.provider') {
      if (input.expected_provider !== this.provider) throw Object.assign(Error('图片提供商已变化'), { httpStatus: 409 });
      this.provider = input.provider; return { selectedImageProvider: this.provider };
    }
    if (method === 'workbench.skill.create') {
      if (this.created.has(input.name)) throw Object.assign(Error('Skill 已存在'), { httpStatus: 409 });
      const content = `---\nname: ${input.name}\ndescription: ${JSON.stringify(input.description)}\nrequired-toolsets: ${JSON.stringify(input.required_toolsets)}\n---\n\n${input.instructions}\n`;
      const skill = { name: input.name, description: input.description, content, revision: revision(content), source: 'local', requiredToolsets: input.required_toolsets };
      this.created.set(input.name, skill); return { skill };
    }
    if (method === 'skills.manage') return { skills: { local: [...this.created.keys()] } };
    if (method === 'commands.catalog') return { skills: Object.fromEntries([...this.created.keys()].map(name => ['/' + name, { origin: 'local' }])), pairs: [...this.created].map(([name, skill]) => ['/' + name, skill.description]) };
    if (method === 'learning.detail') return { ok: true, kind: 'skill', content: this.created.get(input.id)?.content };
    throw Error('Unexpected native/model/business request: ' + method);
  }
  async stop() { this.state = 'stopped'; }
}
function fixture(t) {
  const adapter = new Native(), db = new DatabaseSync(':memory:'), events = [];
  const app = { adapter, store: { db }, checkReady() {}, skill: async name => adapter.created.get(name), publish: (...event) => events.push(event) };
  const service = new SkillIntegrations(app); t.after(() => db.close());
  return { adapter, app, service, events, db };
}
const create = { name: 'poster-generator', description: '生成真实图片', instructions: 'Call image_generate and return its real image.', requiredToolsets: ['image_gen'], operationId: 'create-poster-one' };

test('catalog projects only dependency metadata and coalesces reads without exposing native configuration', async t => {
  const f = fixture(t), raw = { ...f.adapter.catalog(), token: 'private-value', config: { key: 'private-value' } };
  raw.imageProviders[0].apiKey = 'private-value';
  const projected = projectSkillIntegrations(raw); assert.equal(JSON.stringify(projected).includes('private-value'), false);
  const [first, second] = await Promise.all([f.service.inspect(), f.service.inspect()]);
  assert.deepEqual(first, second); assert.equal(f.adapter.calls.length, 1); assert.equal(first.toolsets[0].available, false);
  first.toolsets[0].tools.push('untrusted'); assert.deepEqual((await f.service.inspect()).toolsets[0].tools, []);
  assert.throws(() => projectSkillIntegrations({ toolsets: [{ id: 'all', tools: [] }] }), /工具集/);
});

test('human creation reads back the fixed Skill and identical operation retries cannot duplicate it', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.create(create), /只能由用户/); assert.equal(f.adapter.calls.length, 0);
  const result = await f.service.create(create, { human: true });
  assert.equal(result.skill.name, create.name); assert.deepEqual(declaredSkillToolsets(result.skill.content), ['image_gen']);
  assert.deepEqual(await f.service.create({ ...create }, { human: true }), result);
  assert.equal(f.adapter.calls.filter(([name]) => name === 'workbench.skill.create').length, 1);
  await assert.rejects(f.service.create({ ...create, instructions: 'different' }, { human: true }), /其它内容/);
  assert.equal(f.events.length, 1);
});

test('unknown creation results and concurrent retries are never automatically replayed', async t => {
  const f = fixture(t); let release;
  f.adapter.override = method => method === 'workbench.skill.create' ? new Promise(resolve => { release = resolve; }) : undefined;
  const first = f.service.create(create, { human: true }), second = f.service.create(create, { human: true });
  f.adapter.created.set(create.name, { ...create, content: create.instructions, revision: revision(create.instructions), requiredToolsets: create.requiredToolsets });
  release({ skill: { name: create.name, revision: revision(create.instructions) } });
  assert.deepEqual(await first, await second); assert.equal(f.adapter.calls.length, 1);
  const next = { ...create, name: 'unconfirmed', operationId: 'unknown-creation' };
  f.adapter.override = method => { if (method === 'workbench.skill.create') throw Error('connection interrupted'); };
  await assert.rejects(f.service.create(next, { human: true }), /interrupted/);
  const count = f.adapter.calls.length; await assert.rejects(f.service.create(next, { human: true }), /尚未确认/);
  assert.equal(f.adapter.calls.length, count);
});

test('provider selection is human-only, compare-and-set and verified by native readback', async t => {
  const f = fixture(t), input = { provider: 'openai-codex', expectedProvider: '', operationId: 'select-image-provider' };
  await assert.rejects(f.service.selectImageProvider(input), /只能由用户/); assert.equal(f.adapter.calls.length, 0);
  const result = await f.service.selectImageProvider(input, { human: true }); assert.equal(result.selectedImageProvider, 'openai-codex');
  assert.equal(result.toolsets[0].available, true);
  assert.deepEqual(await f.service.selectImageProvider(input, { human: true }), result);
  assert.equal(f.adapter.calls.filter(([name]) => name === 'workbench.image.provider').length, 1);
  await assert.rejects(f.service.selectImageProvider({ ...input, operationId: 'stale-provider-choice' }, { human: true }), /已变化/);
});

test('a late pre-change catalog response cannot replace the selected provider cache', async t => {
  const f = fixture(t); let release, first = true;
  f.adapter.override = method => {
    if (method === 'workbench.tools.catalog' && first) { first = false; const old = f.adapter.catalog(); return new Promise(resolve => { release = () => resolve(old); }); }
  };
  const old = f.service.inspect(); await Promise.resolve();
  const result = await f.service.selectImageProvider({ provider: 'openai-codex', expectedProvider: '', operationId: 'provider-during-old-read' }, { human: true });
  release(); await old;
  assert.equal(result.selectedImageProvider, 'openai-codex'); assert.equal((await f.service.inspect()).selectedImageProvider, 'openai-codex');
});

test('HTTP authoring and provider writes require CSRF, use the actual service and never start business execution', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'skill-integrations-http-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), port: 0 };
  const adapter = new Native(), app = new Application(config, adapter); app.backend.state = 'ready';
  const bridge = createWorkbenchServer(config, app); t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = await bridge.listen(), token = (await (await fetch(origin + '/api/bootstrap')).json()).csrfToken;
  const post = (path, body, csrf = token) => fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': csrf }, body: JSON.stringify(body) });
  assert.equal((await post('/api/skills', create, '')).status, 403);
  const response = await post('/api/skills', create); assert.equal(response.status, 201); const result = await response.json();
  assert.equal(result.skill.name, create.name); assert.equal(result.skill.revision, adapter.created.get(create.name).revision);
  const provider = await post('/api/skill-integrations/image-provider', { provider: 'openai-codex', expectedProvider: '', operationId: 'http-image-provider' });
  assert.equal(provider.status, 200); assert.equal((await provider.json()).selectedImageProvider, 'openai-codex');
  const status = await (await fetch(origin + '/api/skill-integrations')).json(); assert.equal(status.connected, true); assert.equal(status.toolsets[0].enabled, true);
  const discovered = await app.applicationAssistant.capabilities.read('workbench.inspect', { section: 'integrations' });
  assert.equal(discovered.selectedImageProvider, 'openai-codex');
  for (const path of ['/skill-authoring-ui.js', '/shared/workflow/workflow-integrations.mjs']) assert.equal((await fetch(origin + path)).status, 200);
  assert.deepEqual(app.workflows.list(), []); assert.deepEqual(app.store.list(), []);
  assert.equal(adapter.calls.some(([method]) => method === 'prompt.submit' || method === 'session.create'), false);
});
