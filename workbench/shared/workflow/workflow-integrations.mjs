// Requirements select real, human-configured Hermes integrations. They do not
// install tools, change credentials or grant application-assistant permissions.
export const SKILL_TOOLSETS = Object.freeze(['image_gen', 'browser', 'computer_use']);

export function validateSkillToolsets(value = []) {
  if (!Array.isArray(value) || value.length > 16 || value.some(id => typeof id !== 'string'
    || !(SKILL_TOOLSETS.includes(id) || /^mcp-[A-Za-z0-9_.-]{1,96}$/.test(id)))
    || new Set(value).size !== value.length) throw new Error('Skill 工具依赖须为不重复的图片、浏览器、桌面操作或已配置 MCP 工具集。');
  return [...value].sort();
}

export function declaredSkillToolsets(content) {
  const normalized = String(content).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n')) return [];
  const closing = /\n---[ \t]*(?:\n|$)/.exec(normalized.slice(3)); if (!closing) return [];
  const end = closing.index + 3;
  const declarations = normalized.slice(4, end).split('\n').filter(line => /^required-toolsets\s*:/.test(line));
  if (!declarations.length) return [];
  if (declarations.length !== 1) throw new Error('Skill 工具依赖声明重复。');
  let value;
  try { value = JSON.parse(declarations[0].slice(declarations[0].indexOf(':') + 1).trim()); }
  catch { throw new Error('Skill required-toolsets 须使用 JSON 数组格式。'); }
  return validateSkillToolsets(value);
}
