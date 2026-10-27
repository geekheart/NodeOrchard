const KINDS = new Set(['file', 'folder', 'image', 'text', 'number']);
const KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

// Fixed task instructions belong to the workflow snapshot. A blank form means
// "use the saved default"; explicit JSON values such as false/0/null remain data.
export function workflowInputDefault(node) {
  if (node?.type !== 'input') return undefined;
  const config = node.config || {};
  if (Object.hasOwn(config, 'defaultValue')) return typeof config.defaultValue === 'string' && !config.defaultValue.trim() ? undefined : config.defaultValue;
  if ((!config.sourceKind || config.sourceKind === 'value') && Object.hasOwn(config, 'value') && config.value !== null) return config.value;
  return undefined;
}

function withInputDefault(node, value) {
  const saved = workflowInputDefault(node);
  const missing = item => item === undefined || typeof item === 'string' && !item.trim();
  if (missing(value)) return saved === undefined ? value : JSON.parse(JSON.stringify(saved));
  // A preparation form is a partial object: untouched fields keep the fixed
  // task values. This is a shallow field merge, never a merge inside user data.
  const fields = workflowInputFields(node);
  if (fields.length && value && typeof value === 'object' && !Array.isArray(value) && saved !== undefined) {
    const defaults = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : fields.length === 1 ? { [fields[0].key]: saved } : {};
    let result = value;
    for (const field of fields) {
      if (missing(value[field.key]) && Object.hasOwn(defaults, field.key)) {
        if (result === value) result = { ...value };
        result[field.key] = JSON.parse(JSON.stringify(defaults[field.key]));
      }
    }
    return result;
  }
  return value;
}

export function withWorkflowInputDefaults(document, input) {
  const nodes = document.nodes.filter(item => item.type === 'input');
  if (nodes.length === 1) {
    const name = nodes[0].config?.fieldName || nodes[0].id;
    if (input && typeof input === 'object' && !Array.isArray(input) && Object.hasOwn(input, name)) {
      const value = withInputDefault(nodes[0], input[name]);
      return value === input[name] ? input : { ...input, [name]: value };
    }
    return withInputDefault(nodes[0], input);
  }
  let values = input;
  for (const node of nodes) {
    const name = node.config?.fieldName || node.id;
    const current = input && typeof input === 'object' && !Array.isArray(input) ? input[name] : undefined;
    const value = withInputDefault(node, current);
    if (value !== current) values = { ...(values && typeof values === 'object' && !Array.isArray(values) ? values : {}), [name]: value };
  }
  return values;
}

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
  if (input && typeof input === 'object' && !Array.isArray(input) && Object.hasOwn(input, name)) return withInputDefault(node, input[name]);
  return withInputDefault(node, nodes.length === 1 ? input : undefined);
}
