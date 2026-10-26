// Shared declarative checks: these never evaluate code, call a model, or read files.
const TYPES = new Set(['text', 'number', 'boolean', 'object', 'array']);
const CHECKS = new Set(['required', 'nonempty', 'type', 'equals']);
const dangerous = new Set(['__proto__', 'constructor', 'prototype']);
const fail = message => { throw new Error(message); };

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(label + '必须是普通对象。');
  if (Object.getOwnPropertySymbols(value).length) fail(label + '不允许 Symbol 字段。');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (dangerous.has(key) || !Object.hasOwn(descriptor, 'value')) fail(label + '包含不安全字段。');
  }
}

function expectedJSON(value, depth = 0) {
  if (depth > 20) fail('校验期望值嵌套过深。');
  if (value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, descriptor]) => key !== 'length'
      && (!/^(0|[1-9]\d*)$/.test(key) || !Object.hasOwn(descriptor, 'value')))) fail('校验期望值包含不安全数组字段。');
    if (Object.keys(value).length !== value.length) fail('校验期望值不能包含稀疏数组。');
    return value.map(item => expectedJSON(item, depth + 1));
  }
  plain(value, '校验期望值');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expectedJSON(item, depth + 1)]));
}

export function validationRules(value) {
  if (!Array.isArray(value) || value.length > 32) fail('校验规则必须是最多 32 项的数组。');
  return value.map((rule, index) => {
    const label = '第 ' + (index + 1) + ' 条校验规则'; plain(rule, label);
    for (const key of Object.keys(rule)) if (!['valuePath', 'check', 'expectedType', 'expected', 'message'].includes(key)) fail(label + '包含未知字段 ' + key + '。');
    const valuePath = rule.valuePath ?? '';
    if (typeof valuePath !== 'string' || valuePath.length > 4000
      || (valuePath && (valuePath.split('.').length > 50 || valuePath.split('.').some(key => !/^[\p{L}\p{N}_$-]+$/u.test(key) || dangerous.has(key))))) fail(label + '的字段路径无效。');
    if (!CHECKS.has(rule.check)) fail(label + '的检查方式无效。');
    const result = { valuePath, check: rule.check };
    if (rule.check === 'type') {
      if (!TYPES.has(rule.expectedType)) fail(label + '需要有效的 expectedType。');
      result.expectedType = rule.expectedType;
    } else if (Object.hasOwn(rule, 'expectedType')) fail(label + '只有 type 检查可以设置 expectedType。');
    if (rule.check === 'equals') {
      if (!Object.hasOwn(rule, 'expected')) fail(label + '需要 expected 期望值。');
      result.expected = expectedJSON(rule.expected);
      if (JSON.stringify(result.expected).length > 4096) fail(label + '的期望值不能超过 4KB。');
    } else if (Object.hasOwn(rule, 'expected')) fail(label + '只有 equals 检查可以设置 expected。');
    if (Object.hasOwn(rule, 'message')) {
      if (typeof rule.message !== 'string' || rule.message.length > 1000 || rule.message.includes('\0')) fail(label + '的提示必须是最多 1000 字的文本。');
      result.message = rule.message;
    }
    return result;
  });
}

function select(value, path) {
  for (const key of path ? path.split('.') : []) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const nonempty = value => value !== undefined && value !== null && (typeof value === 'string' ? !!value.trim()
  : Array.isArray(value) ? value.length > 0 : typeof value === 'object' ? Object.keys(value).length > 0 : true);

export function validateNodeValue(input, rules, title = '校验') {
  const clean = validationRules(rules);
  if (!clean.length) fail(title + ' 至少需要一条校验规则。');
  const results = clean.map((rule, index) => {
    const value = select(input, rule.valuePath); let passed;
    if (rule.check === 'required') passed = value !== undefined && value !== null;
    else if (rule.check === 'nonempty') passed = nonempty(value);
    else if (rule.check === 'type') passed = rule.expectedType === 'array' ? Array.isArray(value)
      : rule.expectedType === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value)
        : rule.expectedType === 'text' ? typeof value === 'string'
          : rule.expectedType === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === rule.expectedType;
    else passed = value !== undefined && canonical(value) === canonical(rule.expected);
    return { index: index + 1, valuePath: rule.valuePath, check: rule.check, passed,
      message: passed ? '' : rule.message || ((rule.valuePath || '输入') + ({ required: ' 为必填项。', nonempty: ' 不能为空。', type: ' 类型应为 ' + rule.expectedType + '。', equals: ' 与期望值不一致。' }[rule.check])) };
  });
  const failures = results.filter(result => !result.passed);
  if (failures.length) throw Object.assign(new Error(title + ' 未通过：' + failures.map(row => row.message).join(' ')), { validation: { passed: false, results } });
  return { passed: true, results };
}
