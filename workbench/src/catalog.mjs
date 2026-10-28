import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { declaredSkillToolsets } from '../shared/workflow/workflow-integrations.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const SOURCES = new Set(['bundled', 'hub', 'local']);
const REVISION = /^sha256:[a-f0-9]{64}$/;
const CREATION = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ORIGINS = new Map([['hermes-builtin', 'Hermes 自带'], ['workbench-builtin', '工作台自带'], ['generated', '后续生成'], ['unknown', '来源未确认']]);
export function skillOrigin(value) {
  const kind = ORIGINS.has(value?.kind) ? value.kind : 'unknown';
  return { kind, label: ORIGINS.get(kind), canDelete: kind === 'generated' && value?.canDelete === true,
    ...(typeof value?.reason === 'string' && value.reason ? { reason: value.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 400) }
      : kind === 'unknown' ? { reason: '来源未确认，保留保护。' } : {}) };
}

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
  let native;
  try { native = await adapter.request('workbench.skills.catalog', {}); } catch { /* Older gateways only support the protected legacy catalog. */ }
  if (native !== undefined) {
    if (!record(native) || !Array.isArray(native.skills) || native.skills.length > 5000) throw new Error('Hermes Skills 来源清单格式无效。');
    const names = new Set();
    return native.skills.map(row => {
      if (!record(row) || typeof row.name !== 'string' || !row.name || row.name.length > 256 || /[\u0000-\u001f\u007f]/.test(row.name)
        || row.name.startsWith('memory:') || names.has(row.name)) throw new Error('Hermes Skills 来源身份无效。');
      names.add(row.name); const origin = skillOrigin(row.origin);
      const generation = CREATION.test(row.creationId || '') && REVISION.test(row.bundleRevision || '');
      if (origin.canDelete && !generation) { origin.canDelete = false; origin.reason = '生成来源回执未确认，保留保护。'; }
      return { name: row.name, description: typeof row.description === 'string' ? row.description.slice(0, 2000) : '',
        source: SOURCES.has(row.source) ? row.source : 'hermes', enabled: row.enabled !== false,
        category: typeof row.category === 'string' ? row.category.slice(0, 120) : '', origin,
        ...(REVISION.test(row.revision || '') ? { revision: row.revision } : {}),
        ...(generation ? { creationId: row.creationId, bundleRevision: row.bundleRevision } : {}) };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }
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
        source: SOURCES.has(entry?.origin) ? entry.origin : 'hermes', enabled: true, category, origin: skillOrigin() });
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkill(adapter, name, { includeDisabled = false } = {}) {
  if (typeof name !== 'string' || !name || name.length > 256 || name.includes('\0') || name.startsWith('memory:')) {
    throw Object.assign(new Error('Skill 不存在。'), { httpStatus: 404 });
  }
  const skill = (await readSkillCatalog(adapter)).find(item => item.name === name);
  if (!skill || !includeDisabled && skill.enabled === false) throw Object.assign(new Error('Skill 不存在或当前未启用。'), { httpStatus: 404 });
  // learning.detail also supports memory nodes. Only a catalog-confirmed skill name
  // can cross this boundary, and its response must independently identify a skill.
  const detail = await adapter.request('learning.detail', { id: name });
  if (detail?.ok !== true || detail.kind !== 'skill' || typeof detail.content !== 'string') {
    throw Object.assign(new Error('此 Skill 的内容当前不可用。'), { httpStatus: 404 });
  }
  const requiredToolsets = declaredSkillToolsets(detail.content);
  const revision = `sha256:${createHash('sha256').update(detail.content, 'utf8').digest('hex')}`;
  if (skill.revision && skill.revision !== revision) throw Object.assign(new Error('Skill 内容版本已变化，请刷新目录。'), { httpStatus: 409 });
  return { name, description: skill.description, content: detail.content, source: skill.source,
    enabled: skill.enabled, origin: skill.origin, ...(skill.creationId ? { creationId: skill.creationId, bundleRevision: skill.bundleRevision } : {}),
    ...(requiredToolsets.length ? { requiredToolsets } : {}),
    revision };
}
