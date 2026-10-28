import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ApplicationAssistantSkills, APPLICATION_ASSISTANT_SKILL_MANIFEST, APPLICATION_ASSISTANT_SKILL_LIMITS } from '../src/application-assistant-skills.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'application-assistant-skills-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const skills = new ApplicationAssistantSkills(directory);
  const source = metadata => `---\nname: ${metadata.name}\ndescription: ${metadata.description}\n---\n\nRead the application capability contract before editing a workflow.\n`;
  for (const metadata of APPLICATION_ASSISTANT_SKILL_MANIFEST) {
    await mkdir(join(directory, 'assistant-skills', metadata.name), { recursive: true });
    await writeFile(join(directory, 'assistant-skills', metadata.name, 'SKILL.md'), source(metadata));
  }
  return { directory, skills, source, path: name => join(directory, 'assistant-skills', name, 'SKILL.md') };
}

test('bundled internal Skills are discoverable without leaking instructions into the catalog', async () => {
  const skills = new ApplicationAssistantSkills(), catalog = await skills.list();
  assert.deepEqual(catalog.map(skill => skill.name), ['diagnose-workflow', 'edit-workflow', 'author-code-node', 'verify-result', 'repair-application']);
  assert(catalog.every(skill => skill.description && /^sha256:[a-f0-9]{64}$/.test(skill.revision)));
  assert(catalog.every(skill => !Object.hasOwn(skill, 'instructions') && !Object.hasOwn(skill, 'path')));
  for (const metadata of catalog) {
    const loaded = await skills.read(metadata.name);
    assert.equal(loaded.revision, metadata.revision); assert.equal(loaded.description, metadata.description);
    assert(loaded.instructions.startsWith('---\nname: ' + metadata.name));
    assert(Buffer.byteLength(loaded.instructions) <= APPLICATION_ASSISTANT_SKILL_LIMITS.instructionsBytes);
  }
});

test('loading a fixed Skill is read-only and its revision hashes the exact content', async t => {
  const f = await fixture(t), metadata = APPLICATION_ASSISTANT_SKILL_MANIFEST[0];
  const original = await readFile(f.path(metadata.name));
  const loaded = await new ApplicationAssistantSkills({ appRoot: f.directory }).read(metadata.name);
  assert.equal(loaded.instructions, original.toString('utf8'));
  assert.equal(loaded.revision, 'sha256:' + createHash('sha256').update(original).digest('hex'));
  assert.deepEqual(await readFile(f.path(metadata.name)), original);
  await writeFile(f.path(metadata.name), original.toString('utf8') + '\nAdditional current guidance.\n');
  assert.notEqual((await f.skills.read(metadata.name)).revision, loaded.revision);
});

test('the fixed manifest rejects arbitrary names, paths, encoded traversal and non-string input', async t => {
  const { skills } = await fixture(t);
  for (const name of ['../skills/xlsx', 'diagnose-workflow/../../secret', '/tmp/secret', 'author-code-node/SKILL.md',
    'diagnose-workflow\\SKILL.md', '%2e%2e%2fsecret', '__proto__', 'constructor', 'not-a-skill', 'diagnose-workflow\0', null, {}, ['diagnose-workflow']]) {
    await assert.rejects(skills.read(name), /内部.*Skill|工作方法/);
  }
});

test('frontmatter identity and description must match the application-owned manifest', async t => {
  const f = await fixture(t), metadata = APPLICATION_ASSISTANT_SKILL_MANIFEST[0], path = f.path(metadata.name);
  for (const content of [f.source({ ...metadata, name: 'xlsx' }), f.source({ ...metadata, description: 'Injected broad instructions' }),
    f.source(metadata).replace('---\n\nRead', 'name: duplicate\n---\n\nRead'),
    '# Missing frontmatter', `---\nname: ${metadata.name}\ndescription: ${metadata.description}\n---\n`]) {
    await writeFile(path, content); await assert.rejects(f.skills.read(metadata.name), /元数据|正文/);
  }
});

test('invalid, missing or oversized internal files fail closed rather than returning a partial Skill', async t => {
  const f = await fixture(t), metadata = APPLICATION_ASSISTANT_SKILL_MANIFEST[0], path = f.path(metadata.name);
  await writeFile(path, f.source(metadata) + '界'.repeat(APPLICATION_ASSISTANT_SKILL_LIMITS.instructionsBytes));
  await assert.rejects(f.skills.read(metadata.name), /大小|上限/);
  await writeFile(path, Buffer.from([0xff, 0xfe, 0xfd])); await assert.rejects(f.skills.read(metadata.name), /UTF-8|元数据/);
  await rm(path); await assert.rejects(f.skills.read(metadata.name), /不可用/);
  await assert.rejects(f.skills.list(), /不可用/);
});

test('symlink files and directories cannot substitute an internal Skill or escape the fixed root', async t => {
  const f = await fixture(t), metadata = APPLICATION_ASSISTANT_SKILL_MANIFEST[0];
  const outside = join(f.directory, 'outside.md'); await writeFile(outside, f.source(metadata));
  await rm(f.path(metadata.name)); await symlink(outside, f.path(metadata.name));
  await assert.rejects(f.skills.read(metadata.name), /固定目录|符号链接/);
  await rm(join(f.directory, 'assistant-skills', metadata.name), { recursive: true });
  const outsideFolder = join(f.directory, 'outside'); await mkdir(outsideFolder); await writeFile(join(outsideFolder, 'SKILL.md'), f.source(metadata));
  await symlink(outsideFolder, join(f.directory, 'assistant-skills', metadata.name));
  await assert.rejects(f.skills.read(metadata.name), /固定目录|符号链接/);
});

test('a symlinked assistant-skills root cannot redirect reads into business Skills', async t => {
  const f = await fixture(t), source = join(f.directory, 'assistant-skills'), business = join(f.directory, 'business-skills');
  await mkdir(business); const metadata = APPLICATION_ASSISTANT_SKILL_MANIFEST[0];
  await mkdir(join(business, metadata.name)); await writeFile(join(business, metadata.name, 'SKILL.md'), f.source(metadata));
  await rm(source, { recursive: true }); await symlink(business, source);
  await assert.rejects(f.skills.read(metadata.name), /固定目录|符号链接/);
});
