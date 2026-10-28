import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { LearnedSkills, skillRevision } from '../src/workflows/learned-skills.mjs';

test('learning versions preserve metadata, source identity and immutable parent lineage', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const base = { name: 'sample', content: '---\nname: sample\n---\nOriginal instructions.\n', source: 'bundled' };
  base.revision = skillRevision(base.content);
  const adapter = { request: async method => method === 'workbench.skills.catalog' ? { skills: [{ name: 'sample', source: 'bundled' }] } : method === 'skills.manage' ? { skills: { general: ['sample'] } }
    : method === 'commands.catalog' ? {} : { ok: true, kind: 'skill', content: base.content } };
  const repo = new LearnedSkills({ store: { db }, adapter });
  const learned = repo.create(base, { content: '---\nname: sample\n---\nImproved instructions.\n', learningId: 'study', nodeId: 'node' });
  assert.notEqual(learned.ref, base.name); assert.equal(learned.baseRevision, base.revision);
  assert.equal((await repo.resolve(learned.ref)).revision, learned.revision);
  assert.deepEqual(repo.list(), []);
  await repo.publish({ nodes: [{ type: 'skill', config: { skillRef: learned.ref, version: learned.revision } }] });
  assert.equal(repo.list().length, 1); assert.equal(Object.hasOwn(repo.list()[0], 'content'), false);
  const second = repo.create(learned, { content: '---\nname: sample\n---\nFurther improvement.\n' });
  assert.equal(second.baseName, base.name); assert.equal(second.baseRevision, base.revision); assert.equal(second.parentRef, learned.ref);
  assert.equal(base.content, '---\nname: sample\n---\nOriginal instructions.\n');
  assert.throws(() => repo.create(base, { content: '---\nname: changed\n---\nChanged metadata.' }), /frontmatter/);
  assert.throws(() => repo.create(base, { content: '---\nname: sample\n---\n' }), /指令正文/);
  assert.throws(() => repo.create(base, { content: 'x'.repeat(65537) }), /64 KiB/);
  assert.throws(() => repo.get('../auth.json'), /引用无效/);
  const spaced = { name: 'spaced', content: '\uFEFF---\nname: spaced\n---  \nOriginal.\n' };
  spaced.revision = skillRevision(spaced.content);
  assert.doesNotThrow(() => repo.create(spaced, { content: '\uFEFF---\nname: spaced\n---  \nImproved.\n' }));
  assert.throws(() => repo.create(spaced, { content: '\uFEFF---\nname: changed\n---  \nImproved.\n' }), /frontmatter/);
  base.content += 'Updated at source.';
  await assert.rejects(repo.resolve(learned.ref), /原 Skill 已变化/);
});
