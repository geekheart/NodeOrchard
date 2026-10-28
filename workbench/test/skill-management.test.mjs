import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readManagedBuiltin, listManagedBuiltins } from '../src/skill-management.mjs';

test('management exposes only fixed repo Skill identities as unassignable protected entries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'managed-skills-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'skills', 'board-pinout'), { recursive: true });
  const content = '---\nname: board-pinout\ndescription: Builtin fixture\n---\nInstructions.\n';
  await writeFile(join(root, 'skills', 'board-pinout', 'SKILL.md'), content);
  const [skill] = await listManagedBuiltins(root); assert.equal(skill.name, 'workbench:bundled:board-pinout'); assert.equal(skill.assignable, false); assert.equal(skill.origin.canDelete, false); assert.equal(skill.usage, 'workflow');
  assert.equal((await readManagedBuiltin(root, skill.name)).content, content);
  await assert.rejects(readManagedBuiltin(root, 'workbench:bundled:../../private'), /不存在|不可读取/);
  await assert.rejects(readManagedBuiltin(root, 'workbench:bundled:not-in-fixed-manifest'), /不存在|不可读取/);
});

test('managed builtins reject linked files rather than granting repository provenance to an external target', async t => {
  const root = await mkdtemp(join(tmpdir(), 'managed-skill-links-')); t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'external.md'); await writeFile(target, '---\nname: board-pinout\n---\nExternal.\n');
  const directory = join(root, 'skills', 'board-pinout'); await mkdir(directory, { recursive: true }); const path = join(directory, 'SKILL.md');
  await symlink(target, path); await assert.rejects(readManagedBuiltin(root, 'workbench:bundled:board-pinout'), /不可读取/);
  await rm(path); await link(target, path); await assert.rejects(readManagedBuiltin(root, 'workbench:bundled:board-pinout'), /不可读取/);
});
