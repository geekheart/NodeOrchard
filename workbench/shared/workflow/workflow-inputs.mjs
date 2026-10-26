const KINDS = new Set(['file', 'folder', 'image', 'text', 'number']);
const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

export function workflowInputFields(node) {
  let fields = node.config?.fields;
  if (!fields?.length && ['file', 'folder', 'image'].includes(node.config?.sourceKind)) {
    fields = [{ key: 'path', label: node.title || '输入资料', kind: node.config.sourceKind,
      required: node.config.required !== false, extensions: node.config.extensions || [], match: node.config.match || '' }];
  }
  if (fields === undefined) return [];
  if (!Array.isArray(fields) || fields.length > 32) throw new Error('输入字段最多为 32 项。');
  const seen = new Set();
  return fields.map(field => {
    if (!field || typeof field !== 'object' || Array.isArray(field)
      || Object.keys(field).some(key => !['key', 'label', 'kind', 'required', 'extensions', 'match', 'role'].includes(key))) throw new Error('输入字段格式不正确。');
    if (!KEY.test(field.key) || FORBIDDEN.has(field.key) || seen.has(field.key)) throw new Error('输入字段标识必须唯一，且为字母开头的英文标识。');
    seen.add(field.key);
    if (!KINDS.has(field.kind)) throw new Error('输入字段类型不受支持。');
    if (typeof field.label !== 'string' || !field.label.trim() || field.label.length > 120) throw new Error('请输入有效的字段名称。');
    if (field.required !== undefined && typeof field.required !== 'boolean') throw new Error('字段必填设置必须为布尔值。');
    const extensions = field.extensions || [];
    if (!Array.isArray(extensions) || extensions.length > 20 || extensions.some(extension => typeof extension !== 'string' || !/^\.[a-zA-Z0-9]{1,12}$/.test(extension))) throw new Error('扩展名请填写 .png 等格式。');
    if (field.match !== undefined && (typeof field.match !== 'string' || field.match.length > 120 || /[\/\\\0]/.test(field.match) || field.match.includes('..'))) throw new Error('文件匹配只能使用当前目录的文件名模式。');
    if (field.role !== undefined && (typeof field.role !== 'string' || field.role.length > 100)) throw new Error('输入角色格式不正确。');
    return { key: field.key, label: field.label.trim(), kind: field.kind, required: field.required !== false,
      ...(extensions.length ? { extensions: extensions.map(value => value.toLowerCase()) } : {}),
      ...(field.match ? { match: field.match } : {}), ...(field.role ? { role: field.role } : {}) };
  });
}

export function workflowInputValue(document, input, node) {
  const nodes = document.nodes.filter(item => item.type === 'input');
  const name = node.config?.fieldName || node.id;
  if (input && typeof input === 'object' && !Array.isArray(input) && Object.hasOwn(input, name)) return input[name];
  return nodes.length === 1 ? input : undefined;
}
