import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readManagedBuiltin, listManagedBuiltins } from '../src/skill-management.mjs';
import { APPLICATION_ASSISTANT_SKILL_MANIFEST } from '../src/application-assistant-skills.mjs';

test('management exposes only application assistant instructions and never promotes workflow packages to builtins', async t => {
  const root = await mkdtemp(join(tmpdir(), 'managed-skills-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const item of APPLICATION_ASSISTANT_SKILL_MANIFEST) {
    const directory = join(root, 'assistant-skills', item.name); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${item.name}\ndescription: ${item.description}\n---\nInstructions.\n`);
  }
  await mkdir(join(root, 'skills', 'external-business'), { recursive: true });
  await writeFile(join(root, 'skills', 'external-business', 'SKILL.md'), '---\nname: external-business\n---\nBusiness instructions.\n');
  const skills = await listManagedBuiltins(root);
  assert.equal(skills.length, APPLICATION_ASSISTANT_SKILL_MANIFEST.length);
  for (const skill of skills) {
    assert.ok(skill.name.startsWith('workbench:assistant:')); assert.equal(skill.assignable, false);
    assert.equal(skill.origin.canDelete, false); assert.equal(skill.usage, 'assistant');
    assert.ok((await readManagedBuiltin(root, skill.name)).content.endsWith('Instructions.\n'));
  }
  await assert.rejects(readManagedBuiltin(root, 'workbench:bundled:../../private'), /不存在|不可读取/);
  await assert.rejects(readManagedBuiltin(root, 'workbench:bundled:external-business'), /不存在|不可读取/);
  await assert.rejects(readManagedBuiltin(root, 'workbench:assistant:not-in-fixed-manifest'), /不存在|不可读取/);
});

test('workflow packages remain external regardless of copied, symbolic or hard linked files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'managed-skill-links-')); t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'external.md'); await writeFile(target, '---\nname: external-business\n---\nExternal.\n');
  const directory = join(root, 'skills', 'external-business'); await mkdir(directory, { recursive: true }); const path = join(directory, 'SKILL.md');
  await symlink(target, path); await assert.rejects(readManagedBuiltin(root, 'workbench:bundled:external-business'), /不可读取/);
  await rm(path); await link(target, path); await assert.rejects(readManagedBuiltin(root, 'workbench:bundled:external-business'), /不可读取/);
  assert.deepEqual(await listManagedBuiltins(root), []);
});
