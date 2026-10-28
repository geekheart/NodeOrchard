import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readSkillCatalog, readSkill } from '../src/catalog.mjs';

const hash = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
test('native Skill provenance is projected consistently into catalog and detail without changing legacy source', async () => {
  const content = '---\nname: generated-one\n---\nInstructions.\n';
  const native = { name: 'generated-one', source: 'local', revision: hash(content), bundleRevision: hash('bundle'), creationId: 'f06bc21d-05cf-4aba-844a-f5df0f38b321',
    origin: { kind: 'generated', label: '后续生成', canDelete: true }, secret: 'not-public' };
  const adapter = { request: async method => method === 'workbench.skills.catalog' ? { skills: [native] } : { ok: true, kind: 'skill', content } };
  const catalog = await readSkillCatalog(adapter), detail = await readSkill(adapter, native.name);
  assert.equal(catalog[0].source, 'local'); assert.deepEqual(detail.origin, catalog[0].origin);
  assert.equal(detail.creationId, native.creationId); assert.equal(detail.bundleRevision, native.bundleRevision);
  assert.equal(JSON.stringify(catalog).includes('not-public'), false);
});

test('legacy local and malformed native provenance remain protected rather than guessing generated ownership', async () => {
  const adapter = { request: async method => {
    if (method === 'workbench.skills.catalog') throw Error('method unavailable');
    if (method === 'skills.manage') return { skills: { local: ['older-local'] } };
    return { skills: { '/older-local': { origin: 'local' } }, pairs: [] };
  } };
  const [skill] = await readSkillCatalog(adapter);
  assert.equal(skill.source, 'local'); assert.equal(skill.origin.kind, 'unknown'); assert.equal(skill.origin.canDelete, false);
});
