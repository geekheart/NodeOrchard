import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readSkillLabels, applySkillLabel } from '../src/catalog.mjs';
import { Application } from '../src/application.mjs';
import { LearnedSkills, skillRevision } from '../src/workflows/learned-skills.mjs';

async function root(t) {
  const directory = await mkdtemp(join(tmpdir(), 'skill-labels-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'skills'));
  return { directory, save: value => writeFile(join(directory, 'skills', 'labels.json'), typeof value === 'string' ? value : JSON.stringify(value)) };
}

test('optional local labels are validated presentation metadata and cannot replace Skill identity or content', async t => {
  const { directory, save } = await root(t);
  assert.deepEqual(await readSkillLabels(directory), {});
  assert.deepEqual(await readSkillLabels(undefined), {});
  await save(JSON.parse('{"generic-exporter":{"displayName":" 导出与命名 ","name":"replacement","revision":"changed","content":"changed"},"empty":{"displayName":"  "},"control":{"displayName":"line\\nfeed"},"too-long":{"displayName":"' + 'a'.repeat(121) + '"},"not-object":"label","constructor":{"displayName":"bad"},"__proto__":{"displayName":"bad"}}'));
  const labels = await readSkillLabels(directory);
  assert.deepEqual(labels, { 'generic-exporter': { displayName: '导出与命名' } });
  const original = Object.freeze({ name: 'generic-exporter', ref: 'generic-exporter', revision: 'sha256:unchanged', content: 'immutable original body' });
  assert.deepEqual(applySkillLabel(original, labels), { ...original, displayName: '导出与命名' });
  assert.equal(Object.hasOwn(original, 'displayName'), false);
  assert.equal(applySkillLabel(original, {}), original);
});

test('bad or oversized optional metadata falls back without preventing normal Skill access', async t => {
  const { directory, save } = await root(t);
  for (const content of ['invalid json', '[]', 'null', '17', '{"x":{"displayName":"' + 'x'.repeat(70 * 1024) + '"}}']) {
    await save(content);
    assert.deepEqual(await readSkillLabels(directory), {});
  }
});

test('learned variants inherit base labels and allow an explicit canonical reference override', () => {
  const candidate = Object.freeze({ name: 'wb-learn-example', ref: 'wb-learn-example', baseName: 'generic-exporter',
    baseRevision: 'sha256:base', revision: 'sha256:candidate', content: 'unchanged learned body', learningId: 'evidence-id' });
  const labels = { 'generic-exporter': { displayName: '导出与命名' } };
  assert.deepEqual(applySkillLabel(candidate, labels), { ...candidate, displayName: '导出与命名' });
  assert.equal(applySkillLabel(candidate, { ...labels, 'wb-learn-example': { displayName: '另一个能力标签' } }).displayName, '另一个能力标签');
  assert.equal(candidate.learningId, 'evidence-id');
  assert.equal(candidate.content, 'unchanged learned body');
});

test('Application lists and resolves base and published learned Skills with labels without rewriting evidence or hashes', async t => {
  const { directory, save } = await root(t);
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const content = '---\nname: generic-exporter\nallowed-tools: []\n---\nOriginal instructions.\n';
  const base = { name: 'generic-exporter', content, revision: skillRevision(content), source: 'local' };
  const requests = [];
  const adapter = { state: 'ready', request: async (method, params) => {
    requests.push([method, params]);
    if (method === 'skills.manage') return { skills: { local: [base.name] } };
    if (method === 'commands.catalog') return {};
    if (method === 'learning.detail') { assert.equal(params.id, base.name); return { ok: true, kind: 'skill', content }; }
    throw new Error('Labels must not introduce mutating Hermes requests: ' + method);
  } };
  const app = Object.assign(Object.create(Application.prototype), { config: { appRoot: directory }, adapter, store: { db } });
  app.learnedSkills = new LearnedSkills(app);
  const learned = app.learnedSkills.create(base, { content: content.replace('Original instructions.', 'Already learned instructions.'),
    learningId: 'existing-learning-evidence', nodeId: 'export-node' });
  await app.learnedSkills.publish({ nodes: [{ type: 'skill', config: { skillRef: learned.ref, version: learned.revision } }] });
  const storedBefore = db.prepare('SELECT value FROM learned_skills WHERE id=?').get(learned.ref).value;
  await save({ [base.name]: { displayName: '导出与命名' } });
  const listing = await app.skills();
  assert.equal(listing.connected, true);
  assert.deepEqual(listing.skills.map(skill => [skill.name, skill.displayName]), [[base.name, '导出与命名'], [learned.ref, '导出与命名']]);
  const sourceDetail = await app.skill(base.name), learnedDetail = await app.skill(learned.ref);
  assert.equal(sourceDetail.name, base.name); assert.equal(sourceDetail.revision, base.revision); assert.equal(sourceDetail.content, content);
  assert.equal(learnedDetail.name, learned.ref); assert.equal(learnedDetail.ref, learned.ref);
  assert.equal(learnedDetail.displayName, '导出与命名'); assert.equal(learnedDetail.content, learned.content);
  assert.equal(learnedDetail.revision, learned.revision); assert.equal(learnedDetail.baseRevision, learned.baseRevision);
  assert.equal(learnedDetail.learningId, learned.learningId);
  assert.equal(db.prepare('SELECT value FROM learned_skills WHERE id=?').get(learned.ref).value, storedBefore);
  await save({ [base.name]: { displayName: '新的展示名称' } });
  assert.equal((await app.skill(learned.ref)).displayName, '新的展示名称');
  assert.equal((await app.skill(learned.ref)).revision, learned.revision);
  await save('malformed labels');
  assert.equal((await app.skill(learned.ref)).content, learned.content);
  assert.equal(Object.hasOwn(await app.skill(learned.ref), 'displayName'), false);
  assert.ok(requests.every(([method]) => ['workbench.skills.catalog', 'skills.manage', 'commands.catalog', 'learning.detail'].includes(method)));
});
