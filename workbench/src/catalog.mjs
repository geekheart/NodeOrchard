import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const SOURCES = new Set(['bundled', 'hub', 'local']);

// Optional presentation-only metadata. Never accept paths, revisions, source
// identities or Skill content from this file, and never let a bad label prevent
// an otherwise valid Skill from executing.
export async function readSkillLabels(appRoot) {
  if (typeof appRoot !== 'string' || !appRoot) return {};
  let values;
  try {
    const content = await readFile(join(appRoot, 'skills', 'labels.json'), 'utf8');
    if (Buffer.byteLength(content, 'utf8') > 64 * 1024) return {};
    values = JSON.parse(content);
  } catch { return {}; }
  if (!record(values)) return {};
  return Object.fromEntries(Object.entries(values).filter(([name, value]) =>
    name && name.length <= 256 && !/[\u0000-\u001f\u007f]/.test(name)
      && !['__proto__', 'constructor', 'prototype'].includes(name)
      && record(value) && typeof value.displayName === 'string'
      && value.displayName.trim() && value.displayName.trim().length <= 120
      && !/[\u0000-\u001f\u007f]/.test(value.displayName))
    .map(([name, value]) => [name, { displayName: value.displayName.trim() }]));
}

export function applySkillLabel(skill, labels = {}) {
  const label = Object.hasOwn(labels, skill.name) ? labels[skill.name]
    : typeof skill.baseName === 'string' && Object.hasOwn(labels, skill.baseName) ? labels[skill.baseName] : null;
  return label ? { ...skill, displayName: label.displayName } : skill;
}

export async function readSkillCatalog(adapter) {
  const listed = await adapter.request('skills.manage', { action: 'list' });
  if (!record(listed?.skills)) throw new Error('Hermes 未返回可用的 Skills 清单。');
  let commands = {};
  try {
    const catalog = await adapter.request('commands.catalog', {});
    if (record(catalog)) commands = catalog;
  } catch { /* Metadata is optional. */ }
  const descriptions = new Map((Array.isArray(commands.pairs) ? commands.pairs : [])
    .filter(pair => Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string'));
  const metadata = record(commands.skills) ? commands.skills : {};
  const skills = new Map();
  for (const [category, names] of Object.entries(listed.skills)) {
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) throw new Error('Hermes Skills 清单格式无效。');
    for (const name of names) {
      if (!name || name.length > 256 || name.includes('\0') || name.startsWith('memory:')) continue;
      const key = `/${name}`;
      const entry = Object.hasOwn(metadata, key) && record(metadata[key]) ? metadata[key] : null;
      skills.set(name, { name, description: entry ? descriptions.get(key) || '' : '',
        source: SOURCES.has(entry?.origin) ? entry.origin : 'hermes', enabled: true, category });
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkill(adapter, name) {
  if (typeof name !== 'string' || !name || name.length > 256 || name.includes('\0') || name.startsWith('memory:')) {
    throw Object.assign(new Error('Skill 不存在。'), { httpStatus: 404 });
  }
  const skill = (await readSkillCatalog(adapter)).find(item => item.name === name);
  if (!skill) throw Object.assign(new Error('Skill 不存在或当前未启用。'), { httpStatus: 404 });
  // learning.detail also supports memory nodes. Only a catalog-confirmed skill name
  // can cross this boundary, and its response must independently identify a skill.
  const detail = await adapter.request('learning.detail', { id: name });
  if (detail?.ok !== true || detail.kind !== 'skill' || typeof detail.content !== 'string') {
    throw Object.assign(new Error('此 Skill 的内容当前不可用。'), { httpStatus: 404 });
  }
  return { name, description: skill.description, content: detail.content, source: skill.source,
    revision: `sha256:${createHash('sha256').update(detail.content, 'utf8').digest('hex')}` };
}
