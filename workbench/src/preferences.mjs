import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_SHORTCUTS, normalizeShortcuts } from '../shared/keyboard-shortcuts.mjs';
import { WORKFLOW_AUTOSAVE_DEFAULTS } from '../shared/workflow/workflow-autosave.mjs';

export const DEFAULT_PREFERENCES = Object.freeze({
  theme: 'system', density: 'comfortable', defaultModel: '', defaultWorkspace: '.', shortcuts: DEFAULT_SHORTCUTS,
  workflowAutosaveEnabled: WORKFLOW_AUTOSAVE_DEFAULTS.enabled,
  workflowAutosaveIntervalMinutes: WORKFLOW_AUTOSAVE_DEFAULTS.intervalMinutes,
});

const KEYS = new Set(Object.keys(DEFAULT_PREFERENCES));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = path => path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);

export function workspacePreference(value, workspaceRoot) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')) {
    throw new Error('默认工作目录必须是工作区内的有效路径。');
  }
  const configuredRoot = resolve(workspaceRoot);
  const canonicalRoot = realpathSync(configuredRoot);
  const target = resolve(isAbsolute(value) ? value : join(configuredRoot, value));
  if (!inside(relative(configuredRoot, target)) && !inside(relative(canonicalRoot, target))) {
    throw new Error('默认工作目录必须位于已配置的工作区内。');
  }
  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const canonicalAncestor = realpathSync(ancestor);
  if (!statSync(canonicalAncestor).isDirectory() || !inside(relative(canonicalRoot, canonicalAncestor))) {
    throw new Error('默认工作目录不能通过符号链接越过工作区。');
  }
  const canonicalTarget = resolve(canonicalAncestor, relative(ancestor, target));
  return relative(canonicalRoot, canonicalTarget).split(sep).join('/') || '.';
}

export function validatePreferences(patch, current, { workspaceRoot } = {}) {
  if (!record(patch)) throw new Error('preferences 必须是对象。');
  if (Object.keys(patch).some(key => !KEYS.has(key))) throw new Error('包含不支持的工作台设置。');
  const next = { ...current };
  if (Object.hasOwn(patch, 'theme')) {
    if (!['system', 'light', 'dark'].includes(patch.theme)) throw new Error('无效的主题。');
    next.theme = patch.theme;
  }
  if (Object.hasOwn(patch, 'density')) {
    if (!['comfortable', 'compact'].includes(patch.density)) throw new Error('无效的显示密度。');
    next.density = patch.density;
  }
  if (Object.hasOwn(patch, 'workflowAutosaveEnabled')) {
    if (typeof patch.workflowAutosaveEnabled !== 'boolean') throw new Error('自动保存开关必须是布尔值。');
    next.workflowAutosaveEnabled = patch.workflowAutosaveEnabled;
  }
  if (Object.hasOwn(patch, 'workflowAutosaveIntervalMinutes')) {
    const interval = patch.workflowAutosaveIntervalMinutes;
    if (!Number.isInteger(interval) || interval < 1 || interval > 1440) throw new Error('自动保存间隔必须是 1–1440 分钟的整数。');
    next.workflowAutosaveIntervalMinutes = interval;
  }
  if (Object.hasOwn(patch, 'defaultWorkspace')) next.defaultWorkspace = workspacePreference(patch.defaultWorkspace, workspaceRoot);
  if (Object.hasOwn(patch, 'shortcuts')) {
    const changes = patch.shortcuts;
    if (!record(changes) || ![Object.prototype, null].includes(Object.getPrototypeOf(changes))
      || Reflect.ownKeys(changes).some(key => typeof key !== 'string')
      || Object.values(Object.getOwnPropertyDescriptors(changes)).some(field => !Object.hasOwn(field, 'value'))) {
      throw new Error('快捷键设置必须是操作与组合列表组成的数据对象。');
    }
    next.shortcuts = normalizeShortcuts({ ...(current.shortcuts || {}), ...changes });
  }
  if (Object.hasOwn(patch, 'defaultModel')) {
    if (patch.defaultModel !== '') throw new Error('模型选择已交给 Hermes，请使用顶部的模型切换入口。');
    next.defaultModel = '';
  }
  return next;
}

export function loadPreferences(saved, workspaceRoot) {
  const result = { ...DEFAULT_PREFERENCES, shortcuts: normalizeShortcuts() };
  if (!record(saved)) return result;
  for (const key of KEYS) {
    if (!Object.hasOwn(saved, key)) continue;
    try {
      // Retire the local override instead of shadowing Hermes's own default.
      if (key === 'defaultModel') continue;
      Object.assign(result, validatePreferences({ [key]: saved[key] }, result, { workspaceRoot }));
    } catch { /* Ignore invalid persisted fields without blocking application startup. */ }
  }
  return result;
}
