// The settings UI, keyboard handlers and preference validation share this pure
// catalog. Bindings never name executable code or arbitrary application actions.
export const SHORTCUT_ACTIONS = Object.freeze([
  ['chat.send', '发送消息', 'chat', ['Ctrl+Enter', 'Meta+Enter']],
  ['chat.focus', '聚焦对话输入框', 'global', ['Alt+Shift+M']],
  ['chat.toggle', '展开或收起工作流对话', 'global', ['Alt+Shift+C']],
  ['workflow.save', '保存工作流', 'editor', ['Ctrl+S', 'Meta+S']],
  ['workflow.undo', '撤销', 'editor', ['Ctrl+Z', 'Meta+Z']],
  ['workflow.redo', '重做', 'editor', ['Ctrl+Shift+Z', 'Meta+Shift+Z', 'Ctrl+Y', 'Meta+Y']],
  ['canvas.selectAll', '全选节点', 'canvas', ['Ctrl+A', 'Meta+A']],
  ['canvas.copy', '复制节点', 'canvas', ['Ctrl+C', 'Meta+C']],
  ['canvas.paste', '粘贴节点', 'canvas', ['Ctrl+V', 'Meta+V']],
  ['canvas.duplicate', '创建节点副本', 'canvas', ['Ctrl+D', 'Meta+D']],
  ['canvas.delete', '删除所选节点或连线', 'canvas', ['Delete', 'Backspace']],
  ['canvas.fit', '适应画布', 'canvas', ['F']],
  ['canvas.toggleLibrary', '展开或收起节点库', 'canvas', ['L']],
  ['canvas.toggleProperties', '展开或收起节点属性', 'canvas', ['P']],
  ['canvas.help', '查看快捷键', 'canvas', ['Shift+/']],
].map(([id, label, scope, defaults]) => Object.freeze({ id, label, scope, defaults: Object.freeze(defaults) })));

export const DEFAULT_SHORTCUTS = Object.freeze(Object.fromEntries(SHORTCUT_ACTIONS.map(action => [action.id, action.defaults])));
const actions = new Map(SHORTCUT_ACTIONS.map(action => [action.id, action]));
const modifiers = ['Ctrl', 'Meta', 'Alt', 'Shift'];
const namedKeys = new Set(['Enter', 'Space', 'Delete', 'Backspace', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`)]);
const shiftedCharacters = { '?': '/', '+': '=', '_': '-', ':': ';', '"': "'", '<': ',', '>': '.', '{': '[', '}': ']', '|': '\\', '~': '`',
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0' };
const fail = message => { throw new Error(message); };

function normalizeKey(key) {
  if (key === ' ') return 'Space';
  if (Object.hasOwn(shiftedCharacters, key)) return shiftedCharacters[key];
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
  if (/^[\-=[\]\\;',./`]$/.test(key) || namedKeys.has(key)) return key;
  return '';
}
function normalizeBinding(binding) {
  if (typeof binding !== 'string' || !binding || binding.length > 80) fail('快捷键组合无效。');
  const parts = binding.split('+'), key = normalizeKey(parts.pop()), held = new Set(parts);
  if (!key || held.size !== parts.length || parts.some(value => !modifiers.includes(value))) fail('快捷键必须由有效修饰键与一个按键组成。');
  // Shifted printable characters represent their base key plus Shift, avoiding
  // platform-dependent KeyboardEvent.key values such as ? versus /.
  if (Object.hasOwn(shiftedCharacters, binding.split('+').at(-1))) held.add('Shift');
  return [...modifiers.filter(value => held.has(value)), key].join('+');
}
function reservedBinding(binding) {
  const parts = binding.split('+'), key = parts.pop(), held = new Set(parts), primary = held.has('Ctrl') || held.has('Meta');
  return key === 'F5' || key === 'F12' || key === 'F4' && held.has('Alt')
    || primary && new Set(['R', 'W', 'T', 'L', 'N', 'Q', 'P', 'O', 'F', 'K', 'H', 'J', 'U']).has(key)
    || primary && held.has('Shift') && ['I', 'C'].includes(key)
    || key === 'Space' && held.has('Meta')
    || key === 'Delete' && held.has('Ctrl') && held.has('Alt');
}
function overlap(left, right) {
  return left === right || left === 'global' || right === 'global'
    || left === 'editor' && right === 'canvas' || right === 'editor' && left === 'canvas';
}
function dataMap(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map) || ![Object.prototype, null].includes(Object.getPrototypeOf(map))
    || Reflect.ownKeys(map).some(key => typeof key !== 'string' || !actions.has(key))
    || Object.values(Object.getOwnPropertyDescriptors(map)).some(field => !Object.hasOwn(field, 'value'))) fail('快捷键设置包含未知操作或无效数据。');
}

export function normalizeShortcuts(map = {}) {
  dataMap(map);
  const result = {};
  for (const action of SHORTCUT_ACTIONS) {
    const bindings = Object.hasOwn(map, action.id) ? map[action.id] : action.defaults;
    if (!Array.isArray(bindings) || Object.getPrototypeOf(bindings) !== Array.prototype || bindings.length > 4
      || Reflect.ownKeys(bindings).length !== bindings.length + 1
      || Object.values(Object.getOwnPropertyDescriptors(bindings)).some(field => !Object.hasOwn(field, 'value'))) fail(`“${action.label}”最多设置4组快捷键，清空请使用空列表。`);
    const normalized = bindings.map(normalizeBinding);
    if (new Set(normalized).size !== normalized.length) fail(`“${action.label}”的快捷键组合重复。`);
    for (const binding of normalized) {
      const parts = binding.split('+'), key = parts.pop();
      if (reservedBinding(binding)) fail(`快捷键 ${formatShortcut(binding)} 为系统或浏览器保留组合。`);
      if (action.scope === 'canvas' && !parts.some(value => ['Ctrl', 'Meta', 'Alt'].includes(value))
        && ['Space', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) fail(`快捷键 ${formatShortcut(binding)} 用于画布固定交互，请添加 Ctrl、⌘ 或 Alt。`);
      if (action.scope === 'global' && !parts.some(value => ['Ctrl', 'Meta', 'Alt'].includes(value)) && !/^F\d{1,2}$/.test(key)) fail(`全局快捷键“${action.label}”需要 Ctrl、⌘ 或 Alt，避免影响常规操作。`);
      if (action.scope !== 'canvas' && key.length === 1 && !parts.some(value => ['Ctrl', 'Meta', 'Alt'].includes(value))) fail(`“${action.label}”的快捷键需要 Ctrl、⌘ 或 Alt，避免影响文字输入。`);
    }
    result[action.id] = normalized;
  }
  for (let index = 0; index < SHORTCUT_ACTIONS.length; index++) {
    const left = SHORTCUT_ACTIONS[index];
    for (const right of SHORTCUT_ACTIONS.slice(index + 1)) if (overlap(left.scope, right.scope)) {
      const repeated = result[left.id].find(binding => result[right.id].includes(binding));
      if (repeated) fail(`快捷键 ${formatShortcut(repeated)} 冲突：“${left.label}”与“${right.label}”不能使用相同组合。`);
    }
  }
  return result;
}

export function shortcutFromEvent(event) {
  if (!event || event.isComposing || event.keyCode === 229 || event.repeat || event.defaultPrevented) return '';
  let key = normalizeKey(event.key);
  // macOS Option changes key to a printable character (e.g. Â or Ç), even for
  // command chords. Recover that physical key without affecting IME handling.
  if (!key && event.altKey && typeof event.key === 'string' && /[^\x00-\x7f]/.test(event.key) && typeof event.code === 'string') {
    key = event.code.match(/^(?:Key([A-Z])|Digit([0-9]))$/)?.slice(1).find(Boolean) || '';
  }
  if (!key) return '';
  const parts = [event.ctrlKey && 'Ctrl', event.metaKey && 'Meta', event.altKey && 'Alt',
    (event.shiftKey || Object.hasOwn(shiftedCharacters, event.key)) && 'Shift', key].filter(Boolean);
  const binding = parts.join('+');
  return reservedBinding(binding) ? '' : binding;
}

export function matchesShortcut(event, actionId, map = DEFAULT_SHORTCUTS) {
  if (!actions.has(actionId)) return false;
  const pressed = shortcutFromEvent(event);
  if (!pressed) return false;
  const bindings = map?.[actionId] ?? DEFAULT_SHORTCUTS[actionId];
  return Array.isArray(bindings) && bindings.some(binding => {
    try { return normalizeBinding(binding) === pressed; } catch { return false; }
  });
}

export function formatShortcut(binding) {
  try { return normalizeBinding(binding).split('+').map(part => part === 'Meta' ? '⌘' : part).join(' + '); }
  catch { return ''; }
}

export function shortcutLabel(actionId, map = DEFAULT_SHORTCUTS) {
  const bindings = map?.[actionId] ?? DEFAULT_SHORTCUTS[actionId] ?? [];
  return bindings.length ? bindings.map(formatShortcut).join(' / ') : '未设置';
}
