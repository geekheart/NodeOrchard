import { workflowInputFields } from './workflow-inputs.mjs';
import { validationRules } from './workflow-validation.mjs';
const freezeRows = rows => Object.freeze(rows.map(row => Object.freeze(row)));

export const NODE_GROUPS = freezeRows([
  { id: 'io', label: '入口与输出', color: '#22D3EE' },
  { id: 'capability', label: '能力', color: '#A78BFA' },
  { id: 'data', label: '数据', color: '#34D399' },
  { id: 'control', label: '控制', color: '#FBBF24' },
  { id: 'human', label: '人工', color: '#FB7185' },
]);

export const NODE_TYPES = freezeRows([
  { type: 'input', label: '输入 / 触发', category: 'io', description: '定义工作流接收的数据。', icon: 'file-input' },
  { type: 'validation', label: '校验', category: 'data', description: '按明确规则检查输入或中间产物，通过后原样传递。', icon: 'check' },
  { type: 'skill', label: 'Skill', category: 'capability', description: '调用指定版本的技能。', icon: 'book' },
  { type: 'tool', label: '工具与代码', category: 'capability', description: '调用工具或执行代码。', icon: 'code' },
  { type: 'subflow', label: '子流程', category: 'capability', description: '调用另一个工作流。', icon: 'layers' },
  { type: 'transform', label: '数据整理', category: 'data', description: '整理、筛选或转换数据。', icon: 'sliders' },
  { type: 'merge', label: '汇总', category: 'data', description: '等待具名输入，汇总多条分支的成果。', icon: 'layers' },
  { type: 'condition', label: '条件判断', category: 'control', description: '根据表达式选择是或否分支。', icon: 'diamond' },
  { type: 'foreach', label: '逐项处理', category: 'control', description: '对数组执行有界迭代并汇总结果。', icon: 'list' },
  { type: 'loop', label: '条件循环', category: 'control', description: '在次数上限内重复子流程。', icon: 'repeat' },
  { type: 'evaluation', label: '产物对比', category: 'control', description: '学习时将业务产物与已知结果对比。', icon: 'sliders' },
  { type: 'improvement', label: '学习改进', category: 'control', description: '根据对比结果改进指定 Skill、工具或整个业务工作流。', icon: 'repeat' },
  { type: 'human', label: '人工审核 / 补充', category: 'human', description: '等待人工审核或补充信息。', icon: 'user' },
  { type: 'output', label: '产物输出', category: 'io', description: '保存、展示阶段产物或最终交付。', icon: 'file-output' },
]);

const TYPES = new Map(NODE_TYPES.map(row => [row.type, row]));
const PORT_TYPES = new Set(['any', 'text', 'number', 'boolean', 'object', 'array', 'fileRef', 'folderRef', 'image', 'artifactRef', 'artifactBundle']);
export const CODE_LANGUAGES = Object.freeze(['javascript', 'python']);
export const TOOL_EXECUTION_MODES = Object.freeze(['code', 'tool']);
const LIMITS = Object.freeze({ nodes: 200, edges: 1000, coordinate: 100000, iterations: 1000 });
const DEFAULTS = {
  input: { outputType: 'fileRef', fieldName: 'input', required: true,
    trigger: 'manual', schedule: '09:00', timezone: 'Asia/Shanghai' },
  validation: { inputType: 'any', outputType: 'any', rules: [{ valuePath: '', check: 'required' }] },
  skill: { inputType: 'fileRef', outputType: 'object', skillRef: '', version: '', timeoutSeconds: 120, failurePolicy: 'stop' },
  tool: { inputType: 'object', outputType: 'object', executionMode: 'code', toolName: '', language: 'javascript', code: '',
    timeoutSeconds: 120, failurePolicy: 'stop' },
  subflow: { inputType: 'object', outputType: 'object', workflowRef: '', version: '', timeoutSeconds: 120, failurePolicy: 'stop' },
  transform: { inputType: 'object', outputType: 'object', language: 'javascript', code: '' },
  merge: { inputType: 'object', outputType: 'object' },
  condition: { inputType: 'object', outputType: 'object', expression: '' },
  foreach: { inputType: 'array', outputType: 'array', workflowRef: '', maxIterations: 100 },
  loop: { inputType: 'object', outputType: 'object', workflowRef: '', expression: '', maxIterations: 10 },
  evaluation: { comparison: 'exact', valuePath: '' },
  improvement: { scope: 'skills', targetSkillNodeIds: [] },
  human: { inputType: 'object', outputType: 'object', prompt: '' },
  output: { inputType: 'any', fileName: '' },
};
const V2_DEFAULTS = { resource: 'default', resourceLimit: 1, sourceKind: 'value', path: '', extensions: [], multiple: false,
  fileRole: '', fields: [], reviewTargetNodeId: '', valuePath: '', value: null,
  document: null, maxDepth: 4, timeoutSeconds: 120, code: '', language: 'javascript', reviewImages: false };

function portSet(value) {
  object(value, '节点端口', ['inputs', 'outputs']);
  const result = {};
  for (const direction of ['inputs', 'outputs']) {
    if (!Array.isArray(value[direction]) || value[direction].length > 32) fail('每侧端口必须是最多 32 项的数组。');
    const ids = new Set();
    result[direction] = value[direction].map(row => {
      object(row, '端口', direction === 'inputs' ? ['id', 'label', 'type', 'required'] : ['id', 'label', 'type', 'valuePath']);
      const id = identifier(row.id, '端口 ID');
      if (ids.has(id)) fail('同侧端口 ID 不能重复。'); ids.add(id);
      if (!PORT_TYPES.has(row.type)) fail('端口类型不受支持。');
      const port = { id, label: text(row.label ?? id, '端口名称', 120), type: row.type };
      if (direction === 'inputs') {
        if (row.required !== undefined && typeof row.required !== 'boolean') fail('端口 required 必须是布尔值。');
        port.required = row.required !== false;
      } else if (row.valuePath !== undefined) port.valuePath = text(row.valuePath, '端口字段路径', 4000);
      return port;
    });
  }
  return result;
}
const STRING_LIMITS = {
  fieldName: 128, skillRef: 1024, version: 128, toolName: 256,
  workflowRef: 1024, code: 100000, expression: 4000, prompt: 8000, fileName: 256,
  valuePath: 4000,
};
const has = (object, key) => Object.hasOwn(object, key);
const newId = prefix => `${prefix}-${globalThis.crypto.randomUUID()}`;

function cleanSettings(value = {}) {
  object(value, '工作流设置', ['maxConcurrency', 'outputDirectory']);
  return { maxConcurrency: number(value.maxConcurrency ?? 4, '最大并发数', 1, 16, true),
    outputDirectory: text(value.outputDirectory ?? '', '输出目录', 4000) };
}

function fail(message) { throw new Error(message); }

function object(value, label, allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(`${label}必须是普通对象。`);
  }
  if (Object.getOwnPropertySymbols(value).length) fail(`${label}不允许 Symbol 字段。`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${label}不允许字段 ${key}。`);
    if (!has(descriptor, 'value')) fail(`${label}不允许访问器字段 ${key}。`);
    if (!allowed.includes(key)) fail(`${label}包含未知字段 ${key}。`);
  }
  return value;
}

function text(value, label, limit, { empty = true } = {}) {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0')) {
    fail(`${label}必须是最多 ${limit} 个字符的字符串，且不能包含空字符。`);
  }
  if (!empty && !value.trim()) fail(`${label}不能为空。`);
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
      || ['__proto__', 'constructor', 'prototype'].includes(value)) {
    fail(`${label}必须是 1–128 位字母、数字、连字符或下划线。`);
  }
  return value;
}

function number(value, label, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
      || (integer && !Number.isInteger(value))) fail(`${label}必须是 ${min}–${max} 范围内的${integer ? '整数' : '数值'}。`);
  return value;
}

function nodeType(type) {
  if (typeof type !== 'string' || !TYPES.has(type)) fail('未知节点类型。');
  return type;
}

function inputDefault(value) {
  const seen = new Set();
  function visit(item, depth = 0) {
    if (depth > 50) fail('默认输入嵌套过深。');
    if (item === null || ['string', 'boolean'].includes(typeof item) || typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item)) || seen.has(item)
      || Object.getOwnPropertySymbols(item).length) fail('默认输入必须是有效 JSON 数据。');
    seen.add(item);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === 'length') continue;
      if (!Object.hasOwn(descriptor, 'value')) fail('默认输入不能包含访问器。');
      visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
  }
  visit(value);
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).length > 65536) fail('默认输入不能超过 64KB JSON。');
  return JSON.parse(encoded);
}

function configFor(type, input = {}, v2 = true) {
  const defaults = DEFAULTS[nodeType(type)];
  object(input, '节点配置', [...Object.keys(defaults), ...(type === 'input' ? ['defaultValue'] : []), ...(type === 'improvement' ? ['targetNodeIds'] : []), ...(v2 ? [...Object.keys(V2_DEFAULTS), 'maxRevisions', ...(type === 'output' ? ['stage'] : [])] : [])]);
  const result = { ...defaults };
  if (type === 'validation') result.rules = validationRules(defaults.rules);
  if (type === 'improvement') result.targetSkillNodeIds = [...defaults.targetSkillNodeIds];
  // Older drafts used the presence of toolName to distinguish tools from code.
  if (type === 'tool' && !has(input, 'executionMode')) result.executionMode = typeof input.toolName === 'string' && input.toolName.trim() ? 'tool' : 'code';
  for (const [key, value] of Object.entries(input)) {
    if (type === 'input' && key === 'defaultValue') {
      result.defaultValue = inputDefault(value);
    } else if (type === 'validation' && key === 'rules') {
      result.rules = validationRules(value);
    } else if (v2 && type === 'output' && key === 'stage') {
      if (!['final', 'intermediate'].includes(value)) fail('产物用途仅支持 final 或 intermediate。'); result.stage = value;
    } else if (v2 && key === 'fields') {
      result.fields = workflowInputFields({ config: { fields: value } });
    } else if (v2 && key === 'extensions') {
      if (!Array.isArray(value) || value.length > 30 || value.some(ext => typeof ext !== 'string' || !/^\.[A-Za-z0-9]+$/.test(ext))) fail('扩展名无效。');
      result[key] = [...value];
    } else if (v2 && ['multiple', 'reviewImages'].includes(key)) {
      if (typeof value !== 'boolean') fail('multiple 必须是布尔值。'); result[key] = value;
    } else if (v2 && key === 'value') {
      if (value !== null && (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)))) fail('常量只支持文本、有效数字、布尔值。'); result[key] = value;
    } else if (v2 && key === 'document') {
      result[key] = value === null ? null : validateDocument(value);
    } else if (v2 && key === 'maxRevisions') {
      // Preserve obsolete fields when reading old drafts and frozen runs. Human
      // revision policy ignores this value; new configuration never emits it.
      result[key] = number(value, key, 1, Number.MAX_SAFE_INTEGER, true);
    } else if (v2 && ['resourceLimit', 'maxDepth'].includes(key)) {
      result[key] = number(value, key, 1, key === 'maxDepth' ? 8 : 16, true);
    } else if (v2 && key === 'resource') {
      if (!['default', 'model', 'eda', 'browser', 'drawio', 'memory', 'build'].includes(value)) fail('资源类型无效。'); result[key] = value;
    } else if (v2 && key === 'sourceKind') {
      if (!['value', 'file', 'folder', 'image'].includes(value)) fail('输入来源类型无效。'); result[key] = value;
    } else if (v2 && ['path', 'fileRole', 'reviewTargetNodeId'].includes(key)) {
      result[key] = text(value, key, 4000);
    } else if (key === 'inputType' || key === 'outputType') {
      if (!PORT_TYPES.has(value)) fail(`${key} 不是支持的端口类型。`);
      if ((type === 'foreach' && value !== 'array') || (type === 'output' && value !== 'any')) {
        fail(`${type} 的 ${key} 固定为 ${type === 'foreach' ? 'array' : 'any'}。`);
      }
      result[key] = value;
    } else if (key === 'maxIterations') {
      result[key] = number(value, '最大迭代次数', 1, LIMITS.iterations, true);
    } else if (key === 'timeoutSeconds') {
      result[key] = number(value, '超时秒数', 1, 86400, true);
    } else if (key === 'failurePolicy') {
      if (!['stop', 'retry'].includes(value)) fail('失败策略仅支持 stop 或 retry。');
      result[key] = value;
    } else if (key === 'trigger') {
      if (!['manual', 'schedule'].includes(value)) fail('触发方式仅支持 manual 或 schedule。');
      result[key] = value;
    } else if (key === 'schedule') {
      if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('定时时间必须是 HH:MM 格式的有效时间。');
      result[key] = value;
    } else if (key === 'timezone') {
      result[key] = text(value, '时区', 128, { empty: false });
    } else if (key === 'required') {
      if (typeof value !== 'boolean') fail('required 必须是布尔值。');
      result[key] = value;
    } else if (key === 'executionMode') {
      if (!TOOL_EXECUTION_MODES.includes(value)) fail('执行方式仅支持 code 或 tool。');
      result[key] = value;
    } else if (key === 'language') {
      if (!CODE_LANGUAGES.includes(value)) fail('代码语言仅支持 javascript 或 python。');
      result[key] = value;
    } else if (key === 'comparison') {
      if (!['exact', 'model'].includes(value)) fail('产物对比方式仅支持 exact 或 model。');
      result[key] = value;
    } else if (key === 'scope') {
      if (!['skills', 'tools', 'workflow'].includes(value)) fail('改进范围仅支持 skills、tools 或 workflow。');
      result[key] = value;
    } else if (key === 'targetSkillNodeIds' || key === 'targetNodeIds') {
      if (!Array.isArray(value) || value.length > LIMITS.nodes) fail('改进目标必须是最多 200 个节点 ID 的数组。');
      const ids = value.map(id => identifier(id, '改进目标节点 ID'));
      if (new Set(ids).size !== ids.length) fail('改进目标节点 ID 不能重复。');
      result[key] = ids;
    } else {
      result[key] = text(value, key, STRING_LIMITS[key]);
    }
  }
  return result;
}

export function createDocument(options = {}) {
  object(options, '工作流选项', ['title', 'schemaVersion', 'settings']);
  const version = options.schemaVersion ?? 1;
  if (![1, 2].includes(version)) fail('仅支持 schemaVersion 1 或 2。');
  return {
    schemaVersion: version, id: newId('workflow'),
    title: text(has(options, 'title') ? options.title : '未命名工作流', '工作流名称', 120, { empty: false }),
    mode: 'execute', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    ...(version === 2 ? { settings: cleanSettings(options.settings) } : {}),
  };
}

// The editor, assistant and adapters derive configuration discovery from the
// same current defaults and keys as configFor. Compatibility-only historical
// fields are accepted on read without being advertised for new configuration.
export function nodeConfigurationContract(type, { schemaVersion = 2 } = {}) {
  nodeType(type);
  if (![1, 2].includes(schemaVersion)) fail('仅支持 schemaVersion 1 或 2。');
  const defaults = configFor(type, {}, schemaVersion === 2);
  const allowedConfigKeys = [...new Set([...Object.keys(DEFAULTS[type]), ...(type === 'input' ? ['defaultValue'] : []),
    ...(type === 'improvement' ? ['targetNodeIds'] : []),
    ...(schemaVersion === 2 ? [...Object.keys(V2_DEFAULTS), ...(type === 'output' ? ['stage'] : [])] : [])])];
  const enums = { language: [...CODE_LANGUAGES], executionMode: [...TOOL_EXECUTION_MODES], inputType: [...PORT_TYPES], outputType: [...PORT_TYPES],
    failurePolicy: ['stop', 'retry'], trigger: ['manual', 'schedule'], comparison: ['exact', 'model'], scope: ['skills', 'tools', 'workflow'], stage: ['final', 'intermediate'],
    resource: ['default', 'model', 'eda', 'browser', 'drawio', 'memory', 'build'], sourceKind: ['value', 'file', 'folder', 'image'] };
  return { type, schemaVersion, defaults, allowedConfigKeys,
    enums: Object.fromEntries(Object.entries(enums).filter(([key]) => allowedConfigKeys.includes(key))) };
}

export function createNode(type, position = { x: 0, y: 0 }, options = {}) {
  nodeType(type);
  object(position, '节点位置', ['x', 'y']);
  object(options, '节点选项', ['id', 'title', 'config', 'ports', 'origin']);
  return {
    id: identifier(has(options, 'id') ? options.id : newId('node'), '节点 ID'), type,
    title: text(has(options, 'title') ? options.title : TYPES.get(type).label, '节点名称', 120, { empty: false }),
    x: number(has(position, 'x') ? position.x : 0, '节点 x 坐标', -LIMITS.coordinate, LIMITS.coordinate),
    y: number(has(position, 'y') ? position.y : 0, '节点 y 坐标', -LIMITS.coordinate, LIMITS.coordinate),
    config: configFor(type, has(options, 'config') ? options.config : {}),
    ...(options.ports ? { ports: portSet(options.ports) } : {}),
    ...(has(options, 'origin') ? { origin: cleanOrigin(options.origin, type) } : {}),
  };
}

export function foundationNodeParent(type) {
  nodeType(type);
  return { kind: 'foundation', baseType: type, title: TYPES.get(type).label };
}

// A direct parent is a bounded identity snapshot, never a recursive ancestry.
// Unknown is reserved for old records whose parent was not recorded.
export function validateNodeParent(value, type) {
  nodeType(type);
  const kind = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'kind')?.value : undefined;
  object(value, '派生父级', kind === 'unknown' ? ['kind', 'baseType']
    : kind === 'foundation' ? ['kind', 'baseType', 'title'] : ['kind', 'id', 'version', 'title', 'baseType']);
  if (nodeType(value.baseType) !== type) fail('派生父级的基础类型必须与当前节点一致。');
  if (value.kind === 'unknown') return { kind: 'unknown', baseType: type };
  if (value.kind === 'foundation') {
    const parent = foundationNodeParent(type);
    // A renamed foundation keeps the already frozen label in historical origins.
    const legacyImprovement = type === 'improvement' && value.title === 'Skill 改进';
    if (value.title !== parent.title && !legacyImprovement) fail('基础父级名称必须与基础节点一致。');
    return { ...parent, title: value.title };
  }
  if (!['preset', 'component'].includes(value.kind)) fail('派生父级种类无效。');
  return { kind: value.kind, id: identifier(value.id, '派生父级 ID'),
    version: number(value.version, '派生父级版本', 1, Number.MAX_SAFE_INTEGER, true),
    title: text(value.title, '派生父级名称', 120, { empty: false }), baseType: type };
}

function cleanOrigin(value, type) {
  object(value, '节点来源', ['kind', 'id', 'version', 'title', 'baseType', 'parent']);
  if (!['preset', 'component'].includes(value.kind)) fail('节点来源必须是 preset 或 component。');
  if (nodeType(value.baseType) !== type) fail('节点来源的基础类型必须与当前节点一致。');
  const parent = has(value, 'parent') ? validateNodeParent(value.parent, type) : undefined;
  if (parent && has(parent, 'id') && parent.id === value.id) fail('派生节点不能以自身作为父级。');
  return { kind: value.kind, id: identifier(value.id, '节点来源 ID'),
    version: number(value.version, '节点来源版本', 1, Number.MAX_SAFE_INTEGER, true),
    title: text(value.title, '节点来源名称', 120, { empty: false }), baseType: type,
    ...(parent ? { parent } : {}) };
}

export function getPorts(node) {
  nodeType(node?.type);
  if (node.ports) return portSet(node.ports);
  const config = configFor(node.type, has(node, 'config') ? node.config : {});
  if (node.type === 'output') return {
    inputs: [{ id: 'in', label: '输入', type: 'any' }],
    outputs: [{ id: 'learning', label: '学习产物', type: 'any' }],
  };
  if (node.type === 'evaluation') return {
    inputs: [{ id: 'in', label: '实际产物', type: 'any' }],
    outputs: [{ id: 'out', label: '对比结果', type: 'object' }],
  };
  if (node.type === 'improvement') return {
    inputs: [{ id: 'in', label: '对比结果', type: 'object' }], outputs: [],
  };
  return {
    inputs: node.type === 'input' ? [] : [{ id: 'in', label: '输入', type: config.inputType }],
    outputs: node.type === 'condition'
      ? [{ id: 'yes', label: '是', type: config.outputType }, { id: 'no', label: '否', type: config.outputType }]
      : [{ id: 'out', label: node.type === 'foreach' ? '结果数组' : '输出', type: config.outputType }],
  };
}

function cleanNode(input, v2 = false) {
  object(input, '节点', ['id', 'type', 'title', 'x', 'y', 'config', ...(v2 ? ['ports', 'origin'] : [])]);
  identifier(input.id, '节点 ID');
  number(input.x, '节点 x 坐标', -LIMITS.coordinate, LIMITS.coordinate);
  number(input.y, '节点 y 坐标', -LIMITS.coordinate, LIMITS.coordinate);
  text(input.title, '节点名称', 120, { empty: false });
  configFor(input.type, input.config || {}, v2);
  const ports = input.ports || (v2 && input.type === 'output' ? {
    inputs: [{ id: 'in', label: '输入', type: 'any', required: true }],
    outputs: [{ id: 'out', label: '成果', type: 'any' }, { id: 'learning', label: '学习产物', type: 'any' }],
  } : null);
  return createNode(input.type, { x: input.x, y: input.y }, {
    id: input.id, title: input.title, config: has(input, 'config') ? input.config : {}, ...(ports ? { ports } : {}),
    ...(v2 && has(input, 'origin') ? { origin: input.origin } : {}),
  });
}

function cleanConnection(input, { requireId = false } = {}) {
  object(input, '连线', ['id', 'sourceNode', 'sourcePort', 'targetNode', 'targetPort']);
  const result = {
    sourceNode: identifier(input.sourceNode, '来源节点 ID'),
    sourcePort: identifier(input.sourcePort, '来源端口 ID'),
    targetNode: identifier(input.targetNode, '目标节点 ID'),
    targetPort: identifier(input.targetPort, '目标端口 ID'),
  };
  if (requireId || has(input, 'id')) result.id = identifier(input.id, '连线 ID');
  return result;
}

function checkConnection(doc, edge) {
  const source = doc.nodes.find(node => node.id === edge.sourceNode);
  const target = doc.nodes.find(node => node.id === edge.targetNode);
  if (!source || !target) fail('连线包含不存在的节点。');
  if (source.id === target.id) fail('节点不能连接自身。');
  const output = getPorts(source).outputs.find(port => port.id === edge.sourcePort);
  const input = getPorts(target).inputs.find(port => port.id === edge.targetPort);
  if (!output || !input) fail('连线方向或端口不存在：必须从输出端口连接输入端口。');
  // Learning has dedicated roles, so dropping its branch during execution cannot
  // hide a business edge or feed an improvement result back into the main chain.
  const learningSource = (source.type === 'output' && (doc.schemaVersion !== 2 || edge.sourcePort === 'learning')) || ['evaluation', 'improvement'].includes(source.type);
  const learningTarget = ['evaluation', 'improvement'].includes(target.type);
  if (learningSource || learningTarget) {
    const evaluationSource = (source.type === 'output' && edge.sourcePort === 'learning')
      || (['skill', 'tool', 'transform', 'subflow'].includes(source.type) && edge.sourcePort === 'out');
    const evaluationEdge = evaluationSource && target.type === 'evaluation' && edge.targetPort === 'in';
    const improvementEdge = source.type === 'evaluation' && edge.sourcePort === 'out' && target.type === 'improvement' && edge.targetPort === 'in';
    if (!evaluationEdge && !improvementEdge) fail('学习连线只允许业务能力或最终输出 → 产物对比 → 学习改进。');
  }
  if (output.type !== input.type && output.type !== 'any' && input.type !== 'any') {
    fail(`端口类型不兼容：${output.type} → ${input.type}。`);
  }
  if (doc.edges.some(other => other.sourceNode === edge.sourceNode && other.sourcePort === edge.sourcePort
      && other.targetNode === edge.targetNode && other.targetPort === edge.targetPort)) fail('该连线已存在。');
  if (doc.edges.some(other => other.targetNode === edge.targetNode && other.targetPort === edge.targetPort)) {
    fail('目标输入端口已有连线，请先移除原连线再替换。');
  }
  if (edge.id && doc.edges.some(other => other.id === edge.id)) fail('连线 ID 重复。');
  const visited = new Set();
  const pending = [target.id];
  while (pending.length) {
    const id = pending.pop();
    if (id === source.id) fail('该连线会形成环；请使用有界遍历或循环节点。');
    if (visited.has(id)) continue;
    visited.add(id);
    for (const other of doc.edges) if (other.sourceNode === id) pending.push(other.targetNode);
  }
}

export function validateConnection(doc, connection) {
  try {
    const clean = validateDocument(doc);
    if (clean.edges.length >= LIMITS.edges) fail(`连线最多 ${LIMITS.edges} 条。`);
    checkConnection(clean, cleanConnection(connection));
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

export function connectNodes(doc, connection) {
  const clean = validateDocument(doc);
  const edge = cleanConnection(connection);
  if (clean.edges.length >= LIMITS.edges) fail(`连线最多 ${LIMITS.edges} 条。`);
  checkConnection(clean, edge);
  return { ...clean, edges: [...clean.edges, { id: edge.id ?? newId('edge'), ...edge }] };
}

export function updateNode(doc, id, patch) {
  const clean = validateDocument(doc);
  identifier(id, '节点 ID');
  object(patch, '节点更新', ['title', 'config', 'x', 'y', ...(clean.schemaVersion === 2 ? ['ports', 'origin'] : [])]);
  const existing = clean.nodes.find(node => node.id === id);
  if (!existing) fail('要更新的节点不存在。');
  const next = { ...existing, ...patch };
  if (has(patch, 'config')) {
    object(patch.config, '节点配置', [...Object.keys(DEFAULTS[existing.type]), ...(existing.type === 'input' ? ['defaultValue'] : []), ...(clean.schemaVersion === 2 ? [...Object.keys(V2_DEFAULTS), ...(existing.type === 'output' ? ['stage'] : [])] : [])]);
    next.config = { ...existing.config, ...patch.config };
  }
  // Validate every retained edge against the proposed port types before returning anything.
  return validateDocument({ ...clean, nodes: clean.nodes.map(node => node.id === id ? next : node) });
}

export function removeNodes(doc, ids) {
  const clean = validateDocument(doc);
  if (!Array.isArray(ids) || ids.length > LIMITS.nodes) fail('待删除节点必须是有效 ID 数组。');
  const removed = new Set(ids.map(id => identifier(id, '节点 ID')));
  return { ...clean, nodes: clean.nodes.filter(node => !removed.has(node.id)),
    edges: clean.edges.filter(edge => !removed.has(edge.sourceNode) && !removed.has(edge.targetNode)) };
}

export function removeEdge(doc, id) {
  const clean = validateDocument(doc);
  identifier(id, '连线 ID');
  return { ...clean, edges: clean.edges.filter(edge => edge.id !== id) };
}

export function validateDocument(input) {
  object(input, '工作流', ['schemaVersion', 'id', 'title', 'mode', 'nodes', 'edges', 'viewport', ...(input.schemaVersion === 2 ? ['settings'] : [])]);
  if (![1, 2].includes(input.schemaVersion)) fail('仅支持 schemaVersion 1 或 2。');
  identifier(input.id, '工作流 ID');
  text(input.title, '工作流名称', 120, { empty: false });
  if (!['execute', 'learn'].includes(input.mode)) fail('工作流模式必须是 execute 或 learn。');
  if (!Array.isArray(input.nodes) || input.nodes.length > LIMITS.nodes) fail(`节点必须是数组，且最多 ${LIMITS.nodes} 个。`);
  if (!Array.isArray(input.edges) || input.edges.length > LIMITS.edges) fail(`连线必须是数组，且最多 ${LIMITS.edges} 条。`);
  object(input.viewport, '视口', ['x', 'y', 'zoom']);
  const clean = {
    schemaVersion: input.schemaVersion, id: input.id, title: input.title, mode: input.mode,
    ...(input.schemaVersion === 2 ? { settings: cleanSettings(input.settings) } : {}),
    nodes: [], edges: [], viewport: {
      x: number(input.viewport.x, '视口 x 坐标', -LIMITS.coordinate, LIMITS.coordinate),
      y: number(input.viewport.y, '视口 y 坐标', -LIMITS.coordinate, LIMITS.coordinate),
      zoom: number(input.viewport.zoom, '视口缩放', 0.1, 4),
    },
  };
  const ids = new Set();
  for (const node of input.nodes) {
    const normalized = cleanNode(node, input.schemaVersion === 2);
    if (ids.has(normalized.id)) fail('节点 ID 重复。');
    ids.add(normalized.id);
    clean.nodes.push(normalized);
  }
  for (const edge of input.edges) {
    const normalized = cleanConnection(edge, { requireId: true });
    checkConnection(clean, normalized);
    clean.edges.push({ id: normalized.id, sourceNode: normalized.sourceNode, sourcePort: normalized.sourcePort,
      targetNode: normalized.targetNode, targetPort: normalized.targetPort });
  }
  return clean;
}

export function serializeDocument(doc) {
  return JSON.stringify(validateDocument(doc), null, 2);
}
