import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ApplicationAssistantSkills, APPLICATION_ASSISTANT_SKILL_MANIFEST } from './application-assistant-skills.mjs';

const BUNDLED = new Set(['board-interface-annotation', 'board-pinout', 'board-user-guide', 'hdk-package-planner', 'hdk-process-requirements', 'hdk-test-firmware', 'hdk-test-sop']);
const protectedOrigin = { kind: 'workbench-builtin', label: '工作台自带', canDelete: false, reason: '工作台内置技能不可删除。' };
const fail = () => { throw Object.assign(new Error('此工作台内置 Skill 不存在或不可读取。'), { httpStatus: 404 }); };

export async function readManagedBuiltin(appRoot, id) {
  const match = /^workbench:(assistant|bundled):([a-z0-9-]+)$/.exec(id || ''); if (!match) return fail();
  const [, usage, name] = match; let skill;
  if (usage === 'assistant') {
    if (!APPLICATION_ASSISTANT_SKILL_MANIFEST.some(item => item.name === name)) return fail();
    const value = await new ApplicationAssistantSkills(appRoot).read(name);
    skill = { description: value.description, content: value.instructions, revision: value.revision };
  } else {
    if (!BUNDLED.has(name)) return fail(); let file;
    try {
      const root = await realpath(appRoot), path = join(root, 'skills', name, 'SKILL.md');
      if (await realpath(path) !== path) return fail();
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await file.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) return fail();
      const buffer = Buffer.alloc(64 * 1024 + 1); let length = 0;
      while (length < buffer.length) { const read = await file.read(buffer, length, buffer.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
      const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
      if (Buffer.byteLength(content) > 64 * 1024 || content.includes('\0')) return fail();
      const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1]; if (header === undefined) return fail();
      const declared = /^name:[ \t]*(.+)$/m.exec(header)?.[1]?.trim();
      if (declared !== name) return fail();
      skill = { content, description: /^description:[ \t]*(.+)$/m.exec(header)?.[1]?.trim() || '', revision: 'sha256:' + createHash('sha256').update(content).digest('hex') };
    } catch { return fail(); } finally { await file?.close(); }
  }
  return { ...skill, id, name: id, displayName: name, source: 'workbench', origin: { ...protectedOrigin }, enabled: true,
    usage: usage === 'assistant' ? 'assistant' : 'workflow', assignable: false, installed: false };
}

export async function listManagedBuiltins(appRoot, installed = []) {
  const installedNames = new Set(installed.filter(skill => skill.origin?.kind === 'workbench-builtin').map(skill => skill.name));
  const ids = [...APPLICATION_ASSISTANT_SKILL_MANIFEST.map(item => 'workbench:assistant:' + item.name),
    ...[...BUNDLED].filter(name => !installedNames.has(name)).map(name => 'workbench:bundled:' + name)];
  const values = await Promise.allSettled(ids.map(id => readManagedBuiltin(appRoot, id)));
  return values.filter(result => result.status === 'fulfilled').map(({ value: { content, ...metadata } }) => metadata);
}
