import { ApplicationAssistantSkills, APPLICATION_ASSISTANT_SKILL_MANIFEST } from './application-assistant-skills.mjs';

const protectedOrigin = { kind: 'workbench-builtin', label: '工作台自带', canDelete: false, reason: '工作台内置技能不可删除。' };
const fail = () => { throw Object.assign(new Error('此工作台内置 Skill 不存在或不可读取。'), { httpStatus: 404 }); };

export async function readManagedBuiltin(appRoot, id) {
  const match = /^workbench:assistant:([a-z0-9-]+)$/.exec(id || ''); if (!match) return fail();
  const [, name] = match;
  if (!APPLICATION_ASSISTANT_SKILL_MANIFEST.some(item => item.name === name)) return fail();
  const value = await new ApplicationAssistantSkills(appRoot).read(name);
  return { description: value.description, content: value.instructions, revision: value.revision,
    id, name: id, displayName: name, source: 'workbench', origin: { ...protectedOrigin }, enabled: true,
    usage: 'assistant', assignable: false, installed: false };
}

export async function listManagedBuiltins(appRoot) {
  const ids = APPLICATION_ASSISTANT_SKILL_MANIFEST.map(item => 'workbench:assistant:' + item.name);
  const values = await Promise.allSettled(ids.map(id => readManagedBuiltin(appRoot, id)));
  return values.filter(result => result.status === 'fulfilled').map(({ value: { content, ...metadata } }) => metadata);
}
