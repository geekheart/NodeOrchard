import { isAbsolute, relative, resolve, sep } from 'node:path';
import { getPorts } from '../../shared/workflow/workflow-model.mjs';

const fail = message => Object.assign(new Error(message), { httpStatus: 409 });
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const idOf = value => value?.artifactId || value?.id;
const inside = (root, path) => {
  const part = relative(root, path);
  return part && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep);
};

// Output values are explicit delivery declarations. Inherited record.artifacts
// are only an index for resolving those declarations, never a publication list.
function declarations(value) {
  if (Array.isArray(value)) return [];
  if (!value || typeof value !== 'object') return [];
  const rows = [];
  for (const key of ['artifacts', 'files']) {
    if (value[key] !== undefined && !Array.isArray(value[key])) throw fail('输出节点的 ' + key + ' 必须是明确的产物列表，请修正输出后重试保存副本。');
    rows.push(...(value[key] || []));
  }
  if (typeof value.path === 'string' || value.artifactId) rows.push(value);
  return rows;
}

const FILE_TYPES = new Set(['fileRef', 'image', 'artifactRef', 'artifactBundle']);
const TRANSPARENT = new Set(['human', 'validation', 'output', 'merge']);
const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function projectedShape(shape, path) {
  for (const key of path ? path.split('.') : []) {
    if (!/^[\p{L}\p{N}_$-]+$/u.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) return null;
    shape = shape?.fields?.[key] || (shape?.item && /^(0|[1-9]\d*)$/.test(key) ? shape.item : null);
  }
  return shape;
}

// Preserve declared file semantics through known passthrough operations. A code
// node's any/string/array output never gains semantics from looking like a path.
function inputShape(document, node, records, visited, depth) {
  const inputs = getPorts(node).inputs, fields = Object.create(null);
  for (const input of inputs) {
    const edges = (document.edges || []).filter(edge => edge.targetNode === node.id && edge.targetPort === input.id);
    if (edges.length > 1) throw fail('文件端口存在多个来源，已停止发布。');
    if (!edges.length) continue;
    const edge = edges[0], source = document.nodes.find(item => item.id === edge.sourceNode);
    if (!source) throw fail('输出节点的文件来源缺失，已停止发布。');
    fields[input.id] = portShape(document, source, edge.sourcePort, records, visited, depth + 1);
  }
  return inputs.length === 1 && inputs[0].id === 'in' ? fields.in || null
    : Object.values(fields).some(Boolean) ? { fields } : null;
}

function portShape(document, node, portId, records, visited = new Set(), depth = 0) {
  if (depth > 64 || visited.has(node)) return null;
  const next = new Set(visited).add(node);
  const port = getPorts(node).outputs.find(item => item.id === portId);
  if (!port) return null;
  const record = records?.[node.id];
  let shape;
  if (FILE_TYPES.has(port.type)) shape = { type: port.type };
  else if (['any', 'object', 'array'].includes(port.type) && TRANSPARENT.has(node.type)) {
    shape = projectedShape(inputShape(document, node, records, next, depth), port.valuePath);
    if (shape && record && !sameValue(record.output, record.input)) throw fail('文件透传节点的输入输出已不一致，已停止发布。');
  } else if (['subflow', 'foreach', 'loop'].includes(node.type) && ['any', 'object', 'array'].includes(port.type)) {
    const child = node.config.document;
    const finals = child?.nodes?.filter(item => item.type === 'output' && item.config.stage !== 'intermediate') || [];
    if (finals.length !== 1) return null;
    const result = inputShape(child, finals[0], null, next, depth + 1);
    if (!result) return null;
    shape = projectedShape(node.type === 'foreach' ? { item: result } : result, port.valuePath);
    if (shape && record) {
      const progress = record.subflowProgress;
      if (!progress || progress.childRunId || !Number.isSafeInteger(progress.index) || progress.index < 0
        || !Array.isArray(progress.results) || progress.results.length !== progress.index
        || !Array.isArray(progress.childRunIds) || progress.childRunIds.length !== progress.index
        || !sameValue(record.output, node.type === 'foreach' ? progress.results : progress.current)) {
        throw fail('子流程文件输出与已完成的冻结结果不一致，已停止发布。');
      }
    }
  }
  if (shape && records && record?.status !== 'complete') throw fail('输出节点的文件来源尚未完成，已停止发布。');
  return shape || null;
}

// Only typed leaves of the exact input projection are delivery declarations.
// Plain JSON arrays, named metadata and inherited artifact indexes stay data.
function typedDeclarations(run, output) {
  const shape = inputShape(run.document, output, run.nodes, new Set([output]), 0);
  if (shape && !sameValue(run.nodes[output.id].output, run.nodes[output.id].input)) throw fail('输出节点的文件输入输出已不一致，已停止发布。');
  const rows = [];
  const reference = item => typeof item === 'string' && UUID.test(item) ? { artifactId: item } : item;
  const collect = (current, value) => {
    if (!current) return;
    if (current.item) { if (Array.isArray(value)) value.forEach(item => collect(current.item, item)); return; }
    if (current.fields) { for (const [key, field] of Object.entries(current.fields)) collect(field, value?.[key]); return; }
    if (current.type === 'artifactBundle' && Array.isArray(value)) rows.push(...value.map(reference));
    else if (typeof value === 'string') rows.push(reference(value));
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      rows.push(...declarations(value));
      if (UUID.test(value.id || '') && !value.artifactId && typeof value.path !== 'string') rows.push(value);
    }
  };
  collect(shape, run.nodes[output.id].output);
  return rows;
}

/**
 * Select only current, explicitly exposed output files. A null result is reserved
 * for legacy runs without DAG state. Modern runs must never fall back to copying
 * the execution directory, which also contains history and compiler dependencies.
 * File bytes and canonical filesystem containment are verified by WorkflowFiles.
 */
export function selectDeliveryArtifacts(run, getArtifact) {
  const dagState = run?.nodes && typeof run.nodes === 'object'
    && Object.values(run.nodes).some(state => state && ['attempt', 'savedPath', 'outputDirectory'].some(key => Object.hasOwn(state, key)));
  if (!run) return null;
  if (run.schemaVersion !== 2 && run.document?.schemaVersion !== 2 && !dagState) {
    if (run.schemaVersion === 1 || run.document?.schemaVersion === 1) return null;
    throw fail('运行记录缺少可确认的工作流版本，不能确定交付范围；请恢复运行记录后重试保存副本。');
  }
  if (!Array.isArray(run.document?.nodes) || !run.nodes || typeof run.nodes !== 'object'
    || typeof run.id !== 'string' || !isAbsolute(run.outputDirectory || '')) {
    throw fail('工作流运行缺少完整的节点状态，不能确定交付范围；请恢复运行记录后重试保存副本。');
  }
  const root = resolve(run.outputDirectory), selected = new Map();
  const definitions = new Map(run.document.nodes.map(node => [node.id, node]));
  const add = (declaration, output, ownResult = false) => {
    const row = typeof declaration === 'string' ? { path: declaration } : declaration;
    const declaredId = row?.artifactId || (UUID.test(row?.id || '') ? row.id : null);
    if (!row || typeof row !== 'object' || (!declaredId && typeof row.path !== 'string')) {
      throw fail('输出节点「' + output.title + '」包含无法识别的产物，请显式输出已登记的文件引用后重试保存副本。');
    }
    const matches = (run.nodes[output.id].artifacts || []).filter(item => declaredId ? idOf(item) === declaredId : item.path === row.path);
    if (matches.length !== 1) throw fail('输出节点「' + output.title + '」的交付文件未唯一登记，请先由产物节点生成本次运行内的文件后重试保存副本。');
    const reference = matches[0], artifact = getArtifact(idOf(reference));
    const producer = run.nodes[artifact.nodeId];
    if (artifact.runId !== run.id) throw fail('输出节点引用了其它运行的文件，请先通过本运行的产物节点归集文件后重试保存副本。');
    if (!definitions.has(artifact.nodeId) || !producer || producer.status !== 'complete'
      || !Number.isSafeInteger(artifact.attempt) || artifact.attempt < 1 || artifact.attempt !== producer.attempt) {
      throw fail('交付文件不是生产节点当前已完成版本，请查看当前产物后重试保存副本。');
    }
    if (!SHA.test(artifact.sha256 || '') || !Number.isSafeInteger(artifact.size) || artifact.size < 0
      || !isAbsolute(artifact.path || '') || resolve(artifact.path) !== artifact.path || !inside(root, artifact.path)
      || !isAbsolute(producer.outputDirectory || '') || resolve(producer.outputDirectory) !== producer.outputDirectory
      || !inside(root, producer.outputDirectory) || !inside(producer.outputDirectory, artifact.path)) {
      throw fail('交付文件缺少有效 SHA 或已超出当前生产节点目录，请修正产物引用后重试保存副本。');
    }
    if (ownResult && artifact.nodeId !== output.id) throw fail('输出节点的保存结果不属于本节点当前版本，已停止发布。');
    const bound = (producer.artifacts || []).find(item => idOf(item) === idOf(artifact));
    for (const source of [reference, bound]) {
      if (!source || ['runId', 'nodeId', 'attempt', 'path', 'sha256', 'size'].some(key => source[key] !== artifact[key])) {
        throw fail('交付文件登记与当前节点的产物版本不一致，已停止发布。');
      }
    }
    if ((row.path !== undefined && row.path !== artifact.path)
      || (row.sha256 !== undefined && row.sha256 !== artifact.sha256)
      || (row.bytes !== undefined && row.bytes !== artifact.size)
      || (row.size !== undefined && row.size !== artifact.size)) {
      throw fail('输出节点声明的文件位置、大小或 SHA 与登记产物不一致，已停止发布。');
    }
    const previous = selected.get(artifact.path);
    if (previous && idOf(previous) !== idOf(artifact)) throw fail('同一交付路径引用了不同产物版本，已停止发布。');
    selected.set(artifact.path, { ...artifact });
  };
  for (const node of run.document.nodes.filter(node => node.type === 'output')) {
    const state = run.nodes[node.id];
    if (state?.status !== 'complete') continue;
    if (!Number.isSafeInteger(state.attempt) || state.attempt < 1) throw fail('输出节点缺少当前完成版本，已停止发布。');
    for (const row of [...declarations(state.output), ...typedDeclarations(run, node)]) add(row, node);
    if (state.savedPath) add({ path: state.savedPath }, node, true);
  }
  if (!selected.size) throw fail('本次运行没有明确的交付成果；请连接并完成产物输出节点，再重试保存副本。不会复制整个运行目录。');
  return [...selected.values()].sort((a, b) => a.path.localeCompare(b.path));
}
