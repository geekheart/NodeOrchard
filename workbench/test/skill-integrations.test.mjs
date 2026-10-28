import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillIntegrations, projectSkillIntegrations } from '../src/skill-integrations.mjs';
import { declaredSkillToolsets } from '../shared/workflow/workflow-integrations.mjs';
import { Application } from '../src/application.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { readConfig } from '../src/config.mjs';
import { LearnedSkills } from '../src/workflows/learned-skills.mjs';

const revision = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
class Native extends EventEmitter {
  constructor() { super(); this.state = 'ready'; this.serverRequests = new Map(); this.calls = []; this.created = new Map(); this.provider = ''; }
  catalog() { return { revision: revision(this.provider), toolsets: [{ id: 'image_gen', label: '图片生成', enabled: Boolean(this.provider), available: Boolean(this.provider), tools: this.provider ? ['image_generate'] : [], reason: this.provider ? '' : '请选择图片提供商' }],
    selectedImageProvider: this.provider, imageProviders: [{ id: 'openai-codex', label: 'ChatGPT / Codex', available: true, reason: '' }] }; }
  async request(method, input) {
    this.calls.push([method, input]);
    if (this.override) { const value = this.override(method, input); if (value !== undefined) return value; }
    if (method === 'workbench.tools.catalog') return this.catalog();
    if (method === 'workbench.skills.catalog') return { skills: [...this.created.values()] };
    if (method === 'workbench.image.provider') {
      if (input.expected_provider !== this.provider) throw Object.assign(Error('图片提供商已变化'), { httpStatus: 409 });
      this.provider = input.provider; return { selectedImageProvider: this.provider };
    }
    if (method === 'workbench.skill.create') {
      if (this.created.has(input.name)) throw Object.assign(Error('Skill 已存在'), { httpStatus: 409 });
      const content = `---\nname: ${input.name}\ndescription: ${JSON.stringify(input.description)}\nrequired-toolsets: ${JSON.stringify(input.required_toolsets)}\n---\n\n${input.instructions}\n`;
      const skill = { name: input.name, description: input.description, content, revision: revision(content), bundleRevision: revision(content + 'bundle'), creationId: randomUUID(),
        origin: { kind: 'generated', label: '后续生成', canDelete: true }, source: 'local', requiredToolsets: input.required_toolsets };
      this.created.set(input.name, skill); return { skill };
    }
    if (method === 'workbench.skill.delete') {
      const skill = this.created.get(input.name);
      if (!skill || input.expected_revision !== skill.revision || input.expected_bundle_revision !== skill.bundleRevision || input.creation_id !== skill.creationId) throw Object.assign(Error('stale native skill'), { httpStatus: 409 });
      this.created.delete(input.name); return { deleted: true, name: input.name, creationId: input.creation_id, operationId: input.operation_id, archived: true };
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
  const app = { adapter, store: { db }, checkReady() {}, skill: async name => adapter.created.get(name),
    readSkillForManagement: async name => { const skill = adapter.created.get(name); if (!skill) throw Object.assign(Error('missing skill'), { httpStatus: 404 }); return structuredClone(skill); }, publish: (...event) => events.push(event) };
  const service = new SkillIntegrations(app); t.after(() => db.close());
  app.skillIntegrations = service; app.learnedSkills = new LearnedSkills(app);
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

test('reserved learned Skill names are refused before native creation can leave an unreachable package', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.create({ ...create, name: 'wb-learn-unreachable', operationId: 'reserved-skill-name' }, { human: true }), /前缀.*保留/);
  assert.equal(f.adapter.calls.length, 0); assert.equal(f.adapter.created.size, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM skill_integration_operations').get().count, 0);
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

test('deletion requires trusted native and workbench creation receipts, a current revision, and a human operation', async t => {
  const f = fixture(t), created = await f.service.create(create, { human: true }), skill = created.skill;
  assert.equal(f.service.project(skill).origin.canDelete, true);
  assert.equal(f.service.project({ ...skill, name: 'not-created-here' }).origin.canDelete, false);
  assert.equal(f.service.project({ ...skill, origin: { kind: 'hermes-builtin', canDelete: true } }).origin.canDelete, false);
  const input = { name: skill.name, expectedRevision: skill.revision, expectedCreationId: skill.creationId, operationId: 'delete-created-skill' };
  await assert.rejects(f.service.remove(input), /只能由用户/);
  const { expectedCreationId, ...legacyInput } = input;
  await assert.rejects(f.service.remove(legacyInput, { human: true }), error => error.httpStatus === 400 && error.code === 'SKILL_DELETE_STALE');
  await assert.rejects(f.service.remove({ ...input, expectedRevision: revision('stale'), operationId: 'stale-deletion' }, { human: true }), /版本已变化/);
  assert.equal(f.adapter.calls.some(([name]) => name === 'workbench.skill.delete'), false);
  const result = await f.service.remove(input, { human: true });
  assert.deepEqual(result, { deleted: true, name: skill.name, operationId: input.operationId, archived: true });
  assert.deepEqual(await f.service.remove(input, { human: true }), result);
  assert.equal(f.adapter.calls.filter(([name]) => name === 'workbench.skill.delete').length, 1);
  assert.deepEqual(f.adapter.calls.find(([name]) => name === 'workbench.skill.delete')[1], { name: skill.name, creation_id: skill.creationId,
    expected_revision: skill.revision, expected_bundle_revision: skill.bundleRevision, operation_id: input.operationId });
});

test('nested references block removal without consuming its operation and unknown native outcomes cannot replay', async t => {
  const f = fixture(t), { skill } = await f.service.create(create, { human: true });
  f.db.exec('CREATE TABLE workflow_documents (id TEXT PRIMARY KEY,document TEXT NOT NULL)');
  const nested = { nodes: [{ id: 'subflow', type: 'subflow', config: { document: { nodes: [{ id: 'inner', type: 'skill', config: { skillRef: skill.name } }] } } }] };
  f.db.prepare('INSERT INTO workflow_documents VALUES(?,?)').run('existing-workflow', JSON.stringify(nested));
  const input = { name: skill.name, expectedRevision: skill.revision, expectedCreationId: skill.creationId, operationId: 'remove-after-unlinking' };
  await assert.rejects(f.service.remove(input, { human: true }), /仍被/); assert.equal(f.adapter.created.has(skill.name), true);
  f.db.prepare('DELETE FROM workflow_documents WHERE id=?').run('existing-workflow');
  f.adapter.override = method => { if (method === 'workbench.skill.delete') { assert.throws(() => f.service.assertBindable(skill.name), /正在删除/); throw Error('connection interrupted'); } };
  await assert.rejects(f.service.remove(input, { human: true }), /interrupted/); f.service.assertBindable(skill.name);
  const count = f.adapter.calls.length; await assert.rejects(f.service.remove(input, { human: true }), /尚未确认/); assert.equal(f.adapter.calls.length, count);
});

test('deleting a learned Skill hides it and preserves its immutable content and learning evidence', async t => {
  const f = fixture(t), { skill: base } = await f.service.create(create, { human: true });
  const learned = f.app.learnedSkills.create(base, { content: base.content.replace(create.instructions, 'Improved instructions.'), learningId: 'history-learning', nodeId: 'existing-node' });
  await f.app.learnedSkills.publish({ nodes: [{ type: 'skill', config: { skillRef: learned.name, version: learned.revision } }] });
  await assert.rejects(f.service.remove({ name: base.name, expectedRevision: base.revision, expectedCreationId: base.creationId, operationId: 'dependent-base' }, { human: true }), /仍被/);
  await assert.rejects(f.service.remove({ name: learned.name, expectedRevision: learned.revision, expectedCreationId: base.creationId, operationId: 'wrong-learned-generation' }, { human: true }), error => error.code === 'SKILL_DELETE_STALE');
  const result = await f.service.remove({ name: learned.name, expectedRevision: learned.revision, expectedCreationId: null, operationId: 'delete-learned' }, { human: true });
  assert.equal(result.deleted, true); assert.deepEqual(f.app.learnedSkills.list(), []); assert.throws(() => f.app.learnedSkills.get(learned.name), /已删除/);
  const evidence = JSON.parse(f.db.prepare('SELECT value FROM learned_skills WHERE id=?').get(learned.name).value);
  assert.equal(evidence.content, learned.content); assert.equal(evidence.learningId, 'history-learning'); assert.ok(evidence.deletedAt);
});

test('delete rejection diagnostics use stable codes and safe preflight or native metadata without Skill text or paths', async t => {
  const f = fixture(t), { skill } = await f.service.create(create, { human: true }), logs = [];
  f.app.logEvents = { write: (level, event, context) => logs.push({ level, event, context }) };
  const request = operationId => ({ name: skill.name, expectedRevision: skill.revision, expectedCreationId: skill.creationId, operationId });
  f.adapter.created.set(skill.name, { ...skill, origin: { kind: 'hermes-builtin', canDelete: false } });
  await assert.rejects(f.service.remove(request('protected-skill'), { human: true }), error => error.code === 'SKILL_DELETE_PROTECTED');
  f.adapter.created.set(skill.name, skill);
  await assert.rejects(f.service.remove({ ...request('stale-skill'), expectedRevision: revision('stale') }, { human: true }), error => error.code === 'SKILL_DELETE_STALE');
  f.db.exec('CREATE TABLE workflow_documents(id TEXT,document TEXT)'); f.db.prepare('INSERT INTO workflow_documents VALUES(?,?)').run('using-skill', JSON.stringify({ nodes: [{ type: 'skill', config: { skillRef: skill.name } }] }));
  await assert.rejects(f.service.remove(request('in-use-skill'), { human: true }), error => error.code === 'SKILL_DELETE_IN_USE');
  f.db.prepare('DELETE FROM workflow_documents').run();
  f.service.deleting.add(skill.name); await assert.rejects(f.service.remove(request('busy-skill'), { human: true }), error => error.code === 'SKILL_DELETE_BUSY'); f.service.deleting.delete(skill.name);
  f.adapter.override = method => { if (method === 'workbench.skill.delete') throw Error('PRIVATE_SKILL_BODY /private/sensitive/path'); };
  await assert.rejects(f.service.remove(request('unknown-delete'), { human: true }), error => error.code === 'SKILL_DELETE_UNCONFIRMED');
  await assert.rejects(f.service.remove(request('unknown-delete'), { human: true }), error => error.code === 'SKILL_DELETE_UNCONFIRMED');
  assert.ok(logs.some(row => row.context.code === 'SKILL_DELETE_UNCONFIRMED' && row.context.stage === 'native'));
  assert.ok(logs.some(row => row.context.code === 'SKILL_DELETE_IN_USE' && row.context.stage === 'preflight' && row.context.httpStatus === 409));
  assert.equal(JSON.stringify(logs).includes('PRIVATE_SKILL_BODY'), false); assert.equal(JSON.stringify(logs).includes('/private/sensitive/path'), false); assert.equal(JSON.stringify(logs).includes(create.instructions), false);
});

test('a recreated identical Skill cannot be deleted by an old confirmation or rejected operation from its earlier generation', async t => {
  const f = fixture(t), { skill: original } = await f.service.create(create, { human: true });
  f.db.exec('CREATE TABLE workflow_documents(id TEXT,document TEXT)');
  f.db.prepare('INSERT INTO workflow_documents VALUES(?,?)').run('using-original', JSON.stringify({ nodes: [{ type: 'skill', config: { skillRef: original.name } }] }));
  const rejected = { name: original.name, expectedRevision: original.revision, expectedCreationId: original.creationId, operationId: 'old-rejected-delete' };
  await assert.rejects(f.service.remove(rejected, { human: true }), error => error.code === 'SKILL_DELETE_IN_USE');
  f.db.prepare('DELETE FROM workflow_documents').run();
  const completed = { ...rejected, operationId: 'completed-original-delete' }, receipt = await f.service.remove(completed, { human: true });
  const { skill: recreated } = await f.service.create({ ...create, operationId: 'recreate-identical-skill' }, { human: true });
  assert.equal(recreated.revision, original.revision); assert.notEqual(recreated.creationId, original.creationId);
  const before = f.adapter.calls.filter(([method]) => method === 'workbench.skill.delete').length;
  assert.deepEqual(await f.service.remove(completed, { human: true }), receipt);
  await assert.rejects(f.service.remove({ ...completed, expectedCreationId: recreated.creationId }, { human: true }), error => error.code === 'SKILL_DELETE_STALE');
  for (const old of [rejected, { ...rejected, operationId: 'old-unsubmitted-confirmation' }]) await assert.rejects(f.service.remove(old, { human: true }), error => error.code === 'SKILL_DELETE_STALE');
  assert.equal(f.adapter.calls.filter(([method]) => method === 'workbench.skill.delete').length, before);
  assert.equal(f.adapter.created.get(original.name).creationId, recreated.creationId);
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
  const normal = await (await fetch(origin + '/api/skills')).json(); assert.equal(normal.skills.some(skill => skill.name.startsWith('workbench:')), false);
  assert.equal(normal.skills.find(skill => skill.name === create.name).origin.canDelete, true);
  const management = await (await fetch(origin + '/api/skills?view=management')).json(), internal = management.skills.find(skill => skill.name.startsWith('workbench:assistant:'));
  assert.ok(internal); assert.equal(internal.usage, 'assistant'); assert.equal(internal.assignable, false); assert.equal(internal.origin.canDelete, false);
  const detail = await (await fetch(origin + '/api/skills/' + encodeURIComponent(internal.name) + '?view=management')).json(); assert.equal(detail.revision, internal.revision); assert.ok(detail.content);
  assert.equal((await fetch(origin + '/api/skills/' + encodeURIComponent(internal.name))).status, 404);
  assert.equal((await fetch(origin + '/api/skills?view=management&source=generated')).status, 400);
  const provider = await post('/api/skill-integrations/image-provider', { provider: 'openai-codex', expectedProvider: '', operationId: 'http-image-provider' });
  assert.equal(provider.status, 200); assert.equal((await provider.json()).selectedImageProvider, 'openai-codex');
  const status = await (await fetch(origin + '/api/skill-integrations')).json(); assert.equal(status.connected, true); assert.equal(status.toolsets[0].enabled, true);
  const discovered = await app.applicationAssistant.capabilities.read('workbench.inspect', { section: 'integrations' });
  assert.equal(discovered.selectedImageProvider, 'openai-codex');
  for (const path of ['/skill-authoring-ui.js', '/skill-library-ui.js', '/skill-library-ui.css', '/shared/workflow/workflow-integrations.mjs']) assert.equal((await fetch(origin + path)).status, 200);
  const deletion = { expectedRevision: result.skill.revision, expectedCreationId: result.skill.creationId, operationId: 'http-delete-created' }, deletionPath = '/api/skills/' + create.name + '/delete';
  assert.equal((await post(deletionPath, deletion, '')).status, 403);
  assert.equal((await post(deletionPath, { ...deletion, source: 'generated' })).status, 400);
  const { expectedCreationId, ...legacyDeletion } = deletion; assert.equal((await post(deletionPath, legacyDeletion)).status, 400);
  const deleted = await post(deletionPath, deletion); assert.equal(deleted.status, 200); assert.deepEqual(await deleted.json(), { deleted: true, name: create.name, operationId: deletion.operationId, archived: true });
  assert.equal((await fetch(origin + '/api/skills/' + create.name)).status, 404);
  assert.deepEqual(app.workflows.list(), []); assert.deepEqual(app.store.list(), []);
  assert.equal(adapter.calls.some(([method]) => method === 'prompt.submit' || method === 'session.create'), false);
});
