import { createNode, connectNodes, updateNode, removeNodes, removeEdge, validateDocument } from './workflow-model.mjs';
import { WORKFLOW_TOOLS } from './workflow-tools.mjs';

export const WORKFLOW_CONVERSATION_MAX_OPERATIONS = 64;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const fail = message => { throw new Error(message); };

// This is an editor command transport, not a document import or an executor.
// Inspect descriptors before reading them; even rejected commands cannot invoke
// an accessor, mutate the input document, or touch tools/files/model sessions.
function jsonCopy(input, label, maximumBytes = 2 * 1024 * 1024) {
  const seen = new Set(); let count = 0;
  function copy(value, depth) {
    if (++count > 60000 || depth > 40) fail(`${label}过大或嵌套过深。`);
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || !value) fail(`${label}只能包含 JSON 数据。`);
    if (seen.has(value)) fail(`${label}不能包含循环引用。`);
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label}只能包含普通对象。`);
    if (Object.getOwnPropertySymbols(value).length) fail(`${label}不能包含 Symbol。`);
    seen.add(value);
    const result = Array.isArray(value) ? [] : {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (Array.isArray(value) && key === 'length') continue;
      if (forbidden.has(key)) fail(`${label}包含不安全字段 ${key}。`);
      if (!Object.hasOwn(descriptor, 'value')) fail(`${label}不能包含访问器。`);
      if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) fail(`${label}数组不能包含额外字段。`);
      result[key] = copy(descriptor.value, depth + 1);
    }
    seen.delete(value); return result;
  }
  const result = copy(input, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > maximumBytes) fail(`${label}超过大小限制。`);
  return result;
}

function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是对象。`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}不允许字段 ${key}。`);
}
function identifier(value, label) {
  if (typeof value !== 'string' || !identifierPattern.test(value) || forbidden.has(value)) fail(`${label}无效。`);
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

// A synchronous browser/server drift guard, not an authenticity credential.
// Camera movement is deliberately not a logical workflow modification.
export function documentFingerprint(document) {
  const clean = validateDocument(jsonCopy(document, '工作流'));
  const serialized = canonical({ ...clean, viewport: { x: 0, y: 0, zoom: 1 } });
  let first = 0x811c9dc5, second = 0x9e3779b9;
  for (let index = 0; index < serialized.length; index++) {
    const code = serialized.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `wf1:${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}:${serialized.length}`;
}

function safeConfig(config) {
  if (config === undefined) return undefined;
  object(config, Object.keys(config), '节点配置');
  if (Object.hasOwn(config, 'document')) fail('对话不能替换内嵌工作流；请进入组合节点后使用编辑器修改。');
  if (['trigger', 'schedule', 'timezone'].some(key => Object.hasOwn(config, key))) fail('对话编辑不能更改定时触发，请使用工作流定时设置。');
  return config;
}

function configuredTool(config = {}, previous, v2 = true) {
  const merged = { ...(previous?.config || {}), ...config };
  if (merged.executionMode !== 'tool' && !(config.toolName && config.executionMode === undefined)) return { config };
  const metadata = WORKFLOW_TOOLS.find(row => row.id === merged.toolName);
  if (!metadata) fail('对话只能选择已注册的工作台工具。');
  const changed = !previous || previous.config.executionMode !== 'tool' || previous.config.toolName !== metadata.id;
  if ((Object.hasOwn(config, 'inputType') && !['any', metadata.inputType].includes(config.inputType))
    || (Object.hasOwn(config, 'outputType') && !['any', metadata.outputType].includes(config.outputType))) fail('工具配置的端口类型与已注册工具不匹配。');
  return {
    config: { ...(changed ? metadata.defaultConfig || {} : {}), ...config, executionMode: 'tool', toolName: metadata.id,
      inputType: metadata.inputType, outputType: metadata.outputType,
      ...(metadata.resource ? { resource: metadata.resource } : {}),
      ...(metadata.reviewRequired ? { reviewImages: true } : {}) },
    ...(v2 ? { ports: metadata.ports || {
      inputs: [{ id: 'in', label: '输入', type: metadata.inputType, required: true }],
      outputs: [{ id: 'out', label: '输出', type: metadata.outputType }],
    } } : {}),
  };
}

/** Apply the same model primitives as manual editing, as one undoable batch. */
export function applyWorkflowOperations(document, operations, { idFactory } = {}) {
  let next = validateDocument(jsonCopy(document, '工作流'));
  const commands = jsonCopy(operations, '对话编辑操作', 256 * 1024);
  if (!Array.isArray(commands) || commands.length > WORKFLOW_CONVERSATION_MAX_OPERATIONS) fail(`对话编辑操作必须是最多 ${WORKFLOW_CONVERSATION_MAX_OPERATIONS} 项的数组。`);
  const ids = new Map(), createdIds = {}, summary = [];
  const allIds = new Set([...next.nodes, ...next.edges].map(row => row.id));
  const fresh = prefix => {
    const id = identifier(idFactory ? idFactory(prefix) : `${prefix}-${globalThis.crypto.randomUUID()}`, '新对象 ID');
    if (allIds.has(id) || ids.has(id)) fail('新对象 ID 重复或与节点引用冲突。');
    allIds.add(id); return id;
  };
  const resolve = reference => ids.get(identifier(reference, '节点引用')) || reference;
  const resolveConfig = config => {
    const result = safeConfig(config);
    if (!result) return result;
    if (result.reviewTargetNodeId) result.reviewTargetNodeId = resolve(result.reviewTargetNodeId);
    if (Array.isArray(result.targetSkillNodeIds)) result.targetSkillNodeIds = result.targetSkillNodeIds.map(resolve);
    return result;
  };
  for (let index = 0; index < commands.length; index++) {
    try {
      const operation = commands[index];
      object(operation, ['op', 'ref', 'type', 'title', 'config', 'ports', 'x', 'y', 'nodeId', 'edgeId', 'sourceNode', 'sourcePort', 'targetNode', 'targetPort'], '编辑操作');
      switch (operation.op) {
        case 'add-node': {
          object(operation, ['op', 'ref', 'type', 'title', 'config', 'ports', 'x', 'y'], '添加节点');
          const ref = identifier(operation.ref, '新节点引用');
          if (ids.has(ref) || allIds.has(ref)) fail('新节点引用重复或与已有对象 ID 冲突。');
          const config = resolveConfig(operation.config);
          const options = { id: fresh('node'), ...(operation.title !== undefined ? { title: operation.title } : {}),
            ...(config !== undefined ? { config } : {}), ...(operation.ports ? { ports: operation.ports } : {}) };
          if (operation.type === 'tool') Object.assign(options, configuredTool(config, undefined, next.schemaVersion === 2));
          if (operation.type === 'output' && next.schemaVersion === 2) options.config = { stage: 'final', ...(options.config || {}) };
          const node = createNode(operation.type, { x: operation.x ?? 80 + (next.nodes.length % 5) * 330,
            y: operation.y ?? 100 + Math.floor(next.nodes.length / 5) * 240 }, options);
          next = validateDocument({ ...next, nodes: [...next.nodes, node] });
          ids.set(ref, node.id); createdIds[ref] = node.id; summary.push(`添加「${node.title}」`); break;
        }
        case 'update-node': {
          object(operation, ['op', 'nodeId', 'title', 'config', 'ports', 'x', 'y'], '配置节点');
          const id = resolve(operation.nodeId), node = next.nodes.find(row => row.id === id);
          if (!node) fail('要配置的节点不存在。');
          const patch = {};
          for (const key of ['title', 'x', 'y', 'ports']) if (Object.hasOwn(operation, key)) patch[key] = operation[key];
          const config = resolveConfig(operation.config);
          if (config !== undefined) patch.config = config;
          if (node.type === 'tool' && config !== undefined) Object.assign(patch, configuredTool(config, node, next.schemaVersion === 2));
          next = updateNode(next, id, patch); summary.push(`配置「${node.title}」`); break;
        }
        case 'connect': {
          object(operation, ['op', 'sourceNode', 'sourcePort', 'targetNode', 'targetPort'], '连接节点');
          const edge = { id: fresh('edge'), sourceNode: resolve(operation.sourceNode), sourcePort: operation.sourcePort,
            targetNode: resolve(operation.targetNode), targetPort: operation.targetPort };
          next = connectNodes(next, edge);
          const source = next.nodes.find(row => row.id === edge.sourceNode), target = next.nodes.find(row => row.id === edge.targetNode);
          summary.push(`连接「${source.title}」→「${target.title}」`); break;
        }
        case 'remove-edge': {
          object(operation, ['op', 'edgeId'], '移除连线');
          const id = identifier(operation.edgeId, '连线 ID');
          if (!next.edges.some(row => row.id === id)) fail('要移除的连线不存在。');
          next = removeEdge(next, id); summary.push('移除一条连线'); break;
        }
        case 'remove-node': {
          object(operation, ['op', 'nodeId'], '移除节点');
          const id = resolve(operation.nodeId), node = next.nodes.find(row => row.id === id);
          if (!node) fail('要移除的节点不存在。');
          next = removeNodes(next, [id]); summary.push(`移除「${node.title}」及其连线`); break;
        }
        case 'set-title': {
          object(operation, ['op', 'title'], '修改流程名称');
          next = validateDocument({ ...next, title: operation.title }); summary.push(`流程命名为「${next.title}」`); break;
        }
        default: fail('不支持此编辑操作；对话不能替换工作流、执行、审核、训练或删除文件。');
      }
    } catch (error) { throw new Error(`第 ${index + 1} 项操作无效：${error.message}`); }
  }
  return { document: next, summary, createdIds };
}
