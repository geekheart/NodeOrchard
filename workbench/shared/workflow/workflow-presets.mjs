import { createNode, validateDocument } from './workflow-model.mjs';
import { WORKFLOW_TOOLS } from './workflow-tools.mjs';

export const NODE_PRESET_MAX_BYTES = 2 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const fail = message => { throw new Error(message); };
const has = (value, key) => Object.hasOwn(value, key);

// Keep the browser and server on the same bounded JSON format. Inspect property
// descriptors before reading values so validation never invokes user accessors.
function copyJson(input) {
  const seen = new Set(); let count = 0;
  function visit(value, depth) {
    if (++count > 50000 || depth > 40) fail('节点预设结构过大或嵌套过深。');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object') fail('节点预设只能包含 JSON 数据。');
    if (seen.has(value)) fail('节点预设不能包含循环引用。');
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('节点预设只能包含普通对象。');
    if (Object.getOwnPropertySymbols(value).length) fail('节点预设不允许 Symbol 字段。');
    seen.add(value);
    const result = Array.isArray(value) ? [] : {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (Array.isArray(value) && key === 'length') continue;
      if (FORBIDDEN.has(key)) fail('节点预设包含不安全字段。');
      if (!has(descriptor, 'value')) fail('节点预设不允许访问器字段。');
      if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) fail('节点预设数组不能包含额外字段。');
      result[key] = visit(descriptor.value, depth + 1);
    }
    seen.delete(value);
    return result;
  }
  const result = visit(input, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > NODE_PRESET_MAX_BYTES) fail('节点预设不能超过 2MB。');
  return result;
}

function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象。`);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${label}包含未知字段。`);
  return value;
}

function text(value, label, maximum, empty = false) {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || (!empty && !value.trim())) fail(`${label}必须是${empty ? '' : '非空'}文本，最多 ${maximum} 个字符。`);
  return value.trim();
}

function identifier(value, label = '节点预设 ID') {
  if (typeof value !== 'string' || !IDENTIFIER.test(value) || FORBIDDEN.has(value)) fail(`${label}无效。`);
  return value;
}

function nodeDocument(node) {
  return { schemaVersion: 2, id: 'preset-validation', title: '节点预设', mode: 'execute',
    nodes: [node], edges: [], settings: { maxConcurrency: 4, outputDirectory: '' }, viewport: { x: 0, y: 0, zoom: 1 } };
}

export function validatePresetDefinition(input) {
  const value = copyJson(input);
  object(value, ['title', 'description', 'kind', 'node'], '节点预设');
  const title = text(value.title, '预设名称', 120);
  const description = text(value.description ?? '', '预设说明', 2000, true);
  const kind = value.kind ?? 'preset';
  if (!['preset', 'component'].includes(kind)) fail('预设种类必须是 preset 或 component。');
  const node = validateDocument(nodeDocument(value.node)).nodes[0];
  if (kind === 'component' && (node.type !== 'subflow' || !node.config.document)) fail('组合节点需要包含内嵌工作流的子流程节点。');
  if (kind === 'preset' && node.type === 'subflow' && node.config.document) fail('包含内嵌工作流的节点请保存为组合节点。');
  // The instance position belongs to its canvas, never to the reusable template.
  node.x = 0; node.y = 0;
  return { title, description, kind, node };
}

const absolutePath = value => typeof value === 'string' && (/^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\)/.test(value));

function removePrivatePaths(node) {
  const config = node.config;
  if (absolutePath(config.path)) config.path = '';
  if (node.type === 'input' && absolutePath(config.value)) config.value = null;
  if (node.type === 'output' && absolutePath(config.fileName)) config.fileName = '';
  if (config.document) {
    if (config.document.settings) config.document.settings.outputDirectory = '';
    for (const child of config.document.nodes) removePrivatePaths(child);
  }
}

// Code, tool settings and the pinned Skill version are intentionally retained.
// Absolute paths in code are not rewritten, because that would change behavior.
export function presetDefinitionFromNode(input, options = {}) {
  const safeOptions = copyJson(options);
  object(safeOptions, ['title', 'description', 'includePaths'], '保存预设选项');
  if (safeOptions.includePaths !== undefined && typeof safeOptions.includePaths !== 'boolean') fail('includePaths 必须是布尔值。');
  const node = copyJson(input);
  delete node.origin;
  // A single reusable node cannot keep references to nodes outside its scope.
  if (node.config?.reviewTargetNodeId) node.config.reviewTargetNodeId = '';
  if (node.config?.targetSkillNodeIds) node.config.targetSkillNodeIds = [];
  if (!safeOptions.includePaths) removePrivatePaths(node);
  return validatePresetDefinition({ title: safeOptions.title ?? node.title, description: safeOptions.description ?? '',
    kind: node.type === 'subflow' && node.config?.document ? 'component' : 'preset', node });
}

function fresh(prefix, idFactory) {
  return identifier(idFactory ? idFactory(prefix) : `${prefix}-${globalThis.crypto.randomUUID()}`, '新节点 ID');
}

function cloneDocument(document, idFactory) {
  document.id = fresh('workflow', idFactory);
  const mapping = new Map(document.nodes.map(node => [node.id, fresh('node', idFactory)]));
  for (const node of document.nodes) {
    node.id = mapping.get(node.id);
    remapNodeReferences(node, mapping, idFactory);
  }
  for (const edge of document.edges) {
    edge.id = fresh('edge', idFactory);
    edge.sourceNode = mapping.get(edge.sourceNode);
    edge.targetNode = mapping.get(edge.targetNode);
  }
  return mapping;
}

function remapNodeReferences(node, mapping, idFactory) {
  const config = node.config;
  if (config.reviewTargetNodeId) config.reviewTargetNodeId = mapping.get(config.reviewTargetNodeId) || '';
  if (config.targetSkillNodeIds) config.targetSkillNodeIds = config.targetSkillNodeIds.map(id => mapping.get(id)).filter(Boolean);
  if (config.document) {
    const children = cloneDocument(config.document, idFactory);
    // Multi-output components project child output values by node ID. Port IDs
    // are the public interface and stay stable while those internal paths move.
    for (const port of node.ports?.outputs || []) {
      if (typeof port.valuePath !== 'string') continue;
      const [head, ...tail] = port.valuePath.split('.');
      if (children.has(head)) port.valuePath = [children.get(head), ...tail].join('.');
    }
    // A component snapshot is authoritative. Do not retain a reference to the
    // original editable workflow that could be archived or changed elsewhere.
    config.workflowRef = '';
  }
}

export function instantiatePreset(record, position = { x: 0, y: 0 }, { idFactory } = {}) {
  if (!record || typeof record !== 'object') fail('节点预设记录无效。');
  const id = identifier(record.id);
  if (!Number.isSafeInteger(record.version) || record.version < 1) fail('节点预设版本必须是正整数。');
  const definition = validatePresetDefinition(record.definition);
  const node = definition.node;
  const previousId = node.id;
  node.id = fresh('node', idFactory);
  remapNodeReferences(node, new Map([[previousId, node.id]]), idFactory);
  // Reuse primitive validation for positions and configuration, then attach the
  // immutable version pin. Updating the preset library never touches this copy.
  const instance = createNode(node.type, position, { id: node.id, title: definition.title,
    config: node.config, ...(node.ports ? { ports: node.ports } : {}) });
  instance.origin = { kind: definition.kind, id, version: record.version, title: definition.title, baseType: node.type };
  return instance;
}

export function builtinNodePresets() {
  return WORKFLOW_TOOLS.map(tool => {
    const node = createNode('tool', { x: 0, y: 0 }, { title: tool.label,
      config: { ...(tool.defaultConfig || {}), executionMode: 'tool', toolName: tool.id,
        inputType: tool.inputType, outputType: tool.outputType,
        ...(tool.resource ? { resource: tool.resource } : {}),
        reviewImages: tool.reviewRequired === true || tool.defaultConfig?.reviewImages === true },
      ...(tool.ports ? { ports: tool.ports } : {}) });
    // A stable template ID avoids an unrelated random value on every refresh.
    node.id = 'template-' + tool.id.replace(/[^A-Za-z0-9_-]/g, '-');
    const definition = validatePresetDefinition({ title: tool.label, description: tool.description, kind: 'preset', node });
    return { id: 'builtin-tool-' + tool.id.replace(/[^A-Za-z0-9_-]/g, '-'), title: definition.title,
      description: definition.description, kind: definition.kind, baseType: 'tool', source: 'builtin',
      version: 1, revision: 1, createdAt: null, updatedAt: null,
      toolName: tool.id, reviewRequired: tool.reviewRequired === true, definition };
  });
}
