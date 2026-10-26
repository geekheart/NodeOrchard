// Browser / Node shared data only: importing a dataset never runs a workflow.
export const WORKFLOW_DATASET_LIMITS = Object.freeze({
  cases: 20, valueBytes: 64 * 1024, datasetBytes: 256 * 1024, nameLength: 120, idLength: 128,
});
const encoder = new TextEncoder();
const bytes = value => encoder.encode(value).length;
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);

function inspectJSON(value, label, depth = 0, ancestors = new Set()) {
  if (depth > 50) fail(label + '嵌套不能超过 50 层。');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if ((!Array.isArray(value) && !record(value)) || Object.getOwnPropertySymbols(value).length) fail(label + '必须是有效 JSON 数据。');
  if (ancestors.has(value)) fail(label + '不能包含循环引用。');
  ancestors.add(value);
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) fail(label + '不能包含稀疏数组或数组额外属性。');
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!own(descriptor, 'value') || !descriptor.enumerable) fail(label + '不能包含访问器或隐藏属性。');
    inspectJSON(descriptor.value, label, depth + 1, ancestors);
  }
  ancestors.delete(value);
}

function cleanValue(value, label) {
  inspectJSON(value, label);
  const serialized = JSON.stringify(value);
  if (bytes(serialized) > WORKFLOW_DATASET_LIMITS.valueBytes) fail(label + '不能超过 64 KiB JSON。', 413);
  return JSON.parse(serialized);
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function textField(value, label, limit) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > limit) fail(label + `必须是 1–${limit} 字符的非空文本。`);
  return value;
}

function checkKeys(value, allowed, label) {
  if (!record(value)) fail(label + '必须是对象。');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(label + '包含未知字段：' + key + '。');
}

function row(value, role, index, flat = false) {
  const label = (role === 'train' ? '训练' : '验证') + '样例 ' + index;
  checkKeys(value, flat ? ['id', 'name', 'input', 'expected', 'split'] : ['id', 'name', 'input', 'expected'], label);
  if (!own(value, 'input') || !own(value, 'expected')) fail(label + '必须同时提供 input 和 expected。');
  return {
    ...(own(value, 'id') ? { id: textField(value.id, label + ' id', WORKFLOW_DATASET_LIMITS.idLength) } : {}),
    name: own(value, 'name') ? textField(value.name, label + '名称', WORKFLOW_DATASET_LIMITS.nameLength) : `${role === 'train' ? '训练' : '验证'}样例 ${index}`,
    input: cleanValue(value.input, label + ' input'), expected: cleanValue(value.expected, label + ' expected'),
  };
}

export function normalizeWorkflowDataset(value, options = {}) {
  checkKeys(options, ['requireTraining'], '数据集校验选项');
  if (own(options, 'requireTraining') && typeof options.requireTraining !== 'boolean') fail('requireTraining 必须是布尔值。');
  inspectJSON(value, '数据集');
  if (bytes(JSON.stringify(value)) > WORKFLOW_DATASET_LIMITS.datasetBytes) fail('整个数据集不能超过 256 KiB。', 413);
  const grouped = { trainingCases: [], validationCases: [] };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!record(item)) fail('每条样例必须是对象。');
      const role = own(item, 'split') ? item.split : 'train';
      if (!['train', 'validation'].includes(role)) fail('样例 split 只支持 train 或 validation。');
      const list = role === 'train' ? grouped.trainingCases : grouped.validationCases;
      list.push(row(item, role, list.length + 1, true));
    }
  } else {
    checkKeys(value, ['trainingCases', 'validationCases'], '数据集');
    if (!Array.isArray(value.trainingCases) || (own(value, 'validationCases') && !Array.isArray(value.validationCases))) fail('数据集需要 trainingCases 数组，validationCases 可为数组。');
    grouped.trainingCases = value.trainingCases.map((item, index) => row(item, 'train', index + 1));
    grouped.validationCases = (value.validationCases || []).map((item, index) => row(item, 'validation', index + 1));
  }
  if (options.requireTraining !== false && !grouped.trainingCases.length) fail('数据集至少需要 1 条训练样例。');
  const all = [...grouped.trainingCases, ...grouped.validationCases];
  if (all.length > WORKFLOW_DATASET_LIMITS.cases) fail('训练和验证样例合计不能超过 20 条。');
  const ids = new Set();
  for (const item of all) if (own(item, 'id')) {
    if (ids.has(item.id)) fail('样例 id 必须全局唯一：' + item.id + '。');
    ids.add(item.id);
  }
  for (const [role, list] of [['train', grouped.trainingCases], ['validation', grouped.validationCases]]) {
    let next = 1;
    for (const item of list) if (!own(item, 'id')) {
      while (ids.has(role + '-' + next)) next++;
      item.id = role + '-' + next++; ids.add(item.id);
    }
  }
  const inputs = new Map();
  for (const item of all) {
    const key = canonical(item.input), previous = inputs.get(key);
    if (previous) {
      if (canonical(previous.expected) !== canonical(item.expected)) fail(`样例 ${previous.id} 与 ${item.id} 使用相同 input，却提供不同答案 expected。`);
      fail(`样例 ${previous.id} 与 ${item.id} 的 input 重复；训练与验证集也不能共享输入。`);
    }
    inputs.set(key, item);
  }
  if (bytes(JSON.stringify(grouped)) > WORKFLOW_DATASET_LIMITS.datasetBytes) fail('规范化后的整个数据集不能超过 256 KiB。', 413);
  return grouped;
}

function csvRecords(text) {
  const rows = [];
  let fields = [], field = '', quoted = false, closed = false, line = 1, rowLine = 1, started = false;
  const error = message => fail(`CSV 第 ${line} 行：${message}`);
  const pushField = () => { fields.push(field); field = ''; closed = false; };
  const pushRow = () => { pushField(); rows.push({ fields, line: rowLine }); fields = []; started = false; };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; }
        else { quoted = false; closed = true; }
      } else {
        field += char;
        if (char === '\r') { if (text[index + 1] === '\n') field += text[++index]; line++; }
        else if (char === '\n') line++;
      }
      continue;
    }
    if (closed && ![',', '\r', '\n'].includes(char)) error('结束引号后只能是逗号或换行。');
    if (char === '"') {
      if (field || closed) error('字段中的引号必须用双引号转义，或放在字段开头。');
      quoted = true; started = true;
    } else if (char === ',') { pushField(); started = true; }
    else if (char === '\r' || char === '\n') {
      pushRow();
      if (char === '\r' && text[index + 1] === '\n') index++;
      line++; rowLine = line;
    } else { field += char; started = true; }
  }
  if (quoted) error(`引号未闭合（记录起于第 ${rowLine} 行）。`);
  if (started || fields.length || field || closed) pushRow();
  return rows;
}

function checkFileRow(item, format, line, previousInputs, previousIds) {
  try { row(item, item.split || 'train', line, true); }
  catch (error) { fail(`${format} 第 ${line} 行：${error.message}`, error.httpStatus); }
  if (own(item, 'id')) {
    if (previousIds.has(item.id)) fail(`${format} 第 ${line} 行：id 与第 ${previousIds.get(item.id)} 行重复，必须全局唯一。`);
    previousIds.set(item.id, line);
  }
  const key = canonical(item.input), previous = previousInputs.get(key);
  if (previous) {
    const conflict = canonical(previous.expected) !== canonical(item.expected);
    fail(`${format} 第 ${line} 行：input 与第 ${previous.line} 行相同${conflict ? '，却提供不同答案 expected' : '；训练与验证集不能共享重复输入'}。`);
  }
  previousInputs.set(key, { line, expected: item.expected });
}

function parseCSV(text) {
  const rows = csvRecords(text);
  if (!rows.length) fail('CSV 第 1 行：缺少表头 input,expected。');
  const headers = rows.shift().fields;
  const allowed = ['input', 'expected', 'split', 'id', 'name', 'input_format', 'expected_format'];
  const seen = new Set();
  for (const key of headers) {
    if (seen.has(key)) fail('CSV 第 1 行：表头重复：' + key + '。');
    if (!allowed.includes(key)) fail('CSV 第 1 行：未知字段：' + key + '。');
    seen.add(key);
  }
  if (!seen.has('input') || !seen.has('expected')) fail('CSV 第 1 行：必须包含 input 和 expected 表头。');
  const previousInputs = new Map(), previousIds = new Map();
  const values = rows.map(({ fields, line }) => {
    if (fields.length !== headers.length) fail(`CSV 第 ${line} 行：列数为 ${fields.length}，应为 ${headers.length}。`);
    const values = Object.fromEntries(headers.map((header, index) => [header, fields[index]]));
    const result = {};
    for (const key of ['input', 'expected']) {
      const format = values[key + '_format'] || 'text';
      if (!['text', 'json'].includes(format)) fail(`CSV 第 ${line} 行：${key}_format 只支持 text 或 json。`);
      if (format === 'json') {
        try { result[key] = JSON.parse(values[key]); }
        catch { fail(`CSV 第 ${line} 行：${key} 不是有效 JSON。`); }
      } else result[key] = values[key];
    }
    for (const key of ['id', 'name', 'split']) if (values[key]) result[key] = values[key];
    if (result.split && !['train', 'validation'].includes(result.split)) fail(`CSV 第 ${line} 行：split 只支持 train 或 validation。`);
    checkFileRow(result, 'CSV', line, previousInputs, previousIds);
    return result;
  });
  return values;
}

export function parseWorkflowDataset(text, format = 'json', options = {}) {
  if (typeof text !== 'string') fail('导入内容必须是文本。');
  if (bytes(text) > WORKFLOW_DATASET_LIMITS.datasetBytes) fail('整个数据集文件不能超过 256 KiB。', 413);
  if (!['json', 'jsonl', 'csv'].includes(format)) fail('导入格式只支持 json、jsonl 或 csv。');
  text = text.replace(/^\ufeff/, '');
  let value;
  if (format === 'csv') value = parseCSV(text);
  else if (format === 'jsonl') {
    value = [];
    const previousInputs = new Map(), previousIds = new Map();
    for (const [index, line] of text.split(/\r\n|\r|\n/).entries()) {
      if (!line.trim()) continue;
      let item;
      try {
        item = JSON.parse(line);
        if (!record(item)) fail('每行必须是一条样例对象。');
        checkKeys(item, ['id', 'name', 'input', 'expected', 'split'], '样例');
        if (!own(item, 'input') || !own(item, 'expected')) fail('样例需要 input 和 expected。');
        if (own(item, 'split') && !['train', 'validation'].includes(item.split)) fail('split 只支持 train 或 validation。');
      } catch (error) { fail(`JSONL 第 ${index + 1} 行：${error.message}`); }
      checkFileRow(item, 'JSONL', index + 1, previousInputs, previousIds);
      value.push(item);
    }
  } else {
    try { value = JSON.parse(text); }
    catch (error) { fail('JSON 解析失败：' + error.message); }
  }
  return normalizeWorkflowDataset(value, options);
}

function summaryEntries(value, expected = false) {
  if (!Array.isArray(value)) {
    if (!record(value) || !Array.isArray(value.trainingCases) || !Array.isArray(value.validationCases || [])) fail('统计预期样例格式无效。');
    value = [...value.trainingCases.map(item => ({ ...item, role: 'train' })),
      ...(value.validationCases || []).map(item => ({ ...item, role: 'validation' }))];
  }
  const sequence = { train: 0, validation: 0 }, ids = new Set();
  return value.map(item => {
    if (!record(item)) fail('统计样例必须是对象。');
    const role = item.role ?? item.split ?? 'train';
    if (!['train', 'validation'].includes(role)) fail('统计样例 role 只支持 train 或 validation。');
    sequence[role]++;
    const id = own(item, 'id') ? textField(item.id, '统计样例 id', 128) : `${role}-${sequence[role]}`;
    if (ids.has(id)) fail('统计样例 id 重复：' + id + '。');
    ids.add(id);
    return { id, role, ...(expected ? {} : { result: item }) };
  });
}

function outcome(item, targetScore) {
  if (!item) return null;
  if (['error', 'failed'].includes(item.status)) return { passed: false, score: 0 };
  if (item.status !== 'complete') return null;
  if (!own(item, 'output')) return { passed: false, score: 0 };
  try { cleanValue(item.output, '样例 output'); }
  catch { return { passed: false, score: 0 }; }
  if (!Number.isFinite(item.score) || item.score < 0 || item.score > 100) return null;
  return { passed: item.score >= targetScore, score: item.score };
}

function summarize(entries, targetScore) {
  const results = entries.map(entry => outcome(entry.result, targetScore)).filter(Boolean);
  const total = entries.length, evaluated = results.length, passed = results.filter(item => item.passed).length;
  return { total, passed, failed: evaluated - passed, pending: total - evaluated, evaluated,
    passRate: total && evaluated === total ? passed / total : null,
    averageScore: evaluated ? results.reduce((sum, item) => sum + item.score, 0) / evaluated : null,
    minScore: evaluated ? Math.min(...results.map(item => item.score)) : null };
}

export function summarizeRoundCases(cases, targetScore = 90, expectedCases) {
  if (!Array.isArray(cases)) fail('轮次样例必须是数组。');
  if (!Number.isFinite(targetScore) || targetScore < 0 || targetScore > 100) fail('统计目标分数必须为 0–100。');
  const actual = summaryEntries(cases);
  let entries = actual;
  if (expectedCases !== undefined) {
    const expected = summaryEntries(expectedCases, true), byId = new Map(expected.map(item => [item.id, item]));
    const positions = { train: 0, validation: 0 }, assigned = new Set();
    for (const item of actual) {
      const position = positions[item.role]++;
      // Older persisted rounds did not carry IDs. Their per-split position is
      // the only durable identity available; new rounds always match by ID.
      const id = own(item.result, 'id') ? item.id : expected.filter(entry => entry.role === item.role)[position]?.id;
      const match = byId.get(id);
      if (!match || match.role !== item.role) fail('轮次样例不属于预期数据集：' + item.id + '。');
      if (assigned.has(id)) fail('统计样例 id 重复：' + id + '。');
      assigned.add(id);
      match.result = item.result;
    }
    entries = expected;
  }
  return { train: summarize(entries.filter(item => item.role === 'train'), targetScore),
    validation: summarize(entries.filter(item => item.role === 'validation'), targetScore),
    overall: summarize(entries, targetScore) };
}
