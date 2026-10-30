// A component is an ordinary embedded subflow. Boundary input/output nodes and
// typed ports use the same dataflow protocol as manually authored subflows.
import { createDocument, createNode, validateDocument, getPorts } from './workflow-model.mjs';
import { assertImageReviewPaths, requiresImageReview } from './workflow-plan.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const uid = prefix => prefix + '-' + globalThis.crypto.randomUUID();
const fail = message => { throw new Error(message); };
const signature = (node, port) => node + '\0' + port;
const business = edge => edge.sourcePort !== 'learning';
const getNode = (doc, id) => doc.nodes.find(node => node.id === id);
const inputSignature = node => JSON.stringify({ id: node.id, type: node.type, fieldName: node.config.fieldName, required: node.config.required, ports: getPorts(node) });
const outputSignature = node => JSON.stringify({ id: node.id, type: node.type, stage: node.config.stage, ports: getPorts(node) });

export function analyzeSelection(document, ids) {
  const doc = validateDocument(document);
  if (doc.schemaVersion !== 2) fail('请先升级为并行工作流，再封装子流程。');
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) fail('请先选择要封装的节点。');
  const selected = new Set(ids), nodes = doc.nodes.filter(node => selected.has(node.id));
  if (nodes.length !== ids.length) fail('选区中有不存在的节点，请重新选择。');
  if (nodes.some(node => ['input', 'output', 'evaluation', 'improvement'].includes(node.type))) fail('封装时请选择能力、数据、控制或人工节点；输入输出由边界自动生成，学习支线保留在外层。');
  for (const node of doc.nodes) {
    if (node.type === 'improvement' && [...(node.config.targetSkillNodeIds || []), ...(node.config.targetNodeIds || [])].some(id => selected.has(id))) fail('选中的能力已是学习改进目标，请将它保留在外层；学习控制器按外层节点定位。');
    if (selected.has(node.id) && node.type === 'human' && node.config.reviewTargetNodeId && !selected.has(node.config.reviewTargetNodeId)) fail('请将人工审核指定的上游修改目标一并选中。');
  }
  if (doc.edges.some(edge => selected.has(edge.sourceNode) && !selected.has(edge.targetNode) && getNode(doc, edge.targetNode)?.type === 'evaluation')) fail('此能力连接了学习对比支线，请保留在外层，避免改变学习观察目标。');
  // A non-contiguous selection can create parent-level cycles after folding.
  for (const edge of doc.edges.filter(edge => selected.has(edge.sourceNode) && !selected.has(edge.targetNode))) {
    const pending = [edge.targetNode], seen = new Set();
    while (pending.length) {
      const current = pending.pop(); if (seen.has(current)) continue; seen.add(current);
      if (selected.has(current)) fail('选区之间经过了未选中的节点，请把中间节点一起选中再封装。');
      pending.push(...doc.edges.filter(row => row.sourceNode === current).map(row => row.targetNode));
    }
  }
  const inputs = [], outputs = [], byInput = new Map(), byOutput = new Map();
  for (const edge of doc.edges) {
    if (!selected.has(edge.sourceNode) && selected.has(edge.targetNode)) {
      const key = signature(edge.sourceNode, edge.sourcePort); let boundary = byInput.get(key);
      if (!boundary) {
        const port = getPorts(getNode(doc, edge.sourceNode)).outputs.find(port => port.id === edge.sourcePort);
        const targetPort = getPorts(getNode(doc, edge.targetNode)).inputs.find(port => port.id === edge.targetPort);
        boundary = { id: 'arg-' + (inputs.length + 1), label: targetPort.label, type: port.type, sourceNode: edge.sourceNode, sourcePort: edge.sourcePort, targets: [] };
        inputs.push(boundary); byInput.set(key, boundary);
      }
      boundary.targets.push({ nodeId: edge.targetNode, portId: edge.targetPort });
    }
    if (selected.has(edge.sourceNode) && !selected.has(edge.targetNode)) {
      const key = signature(edge.sourceNode, edge.sourcePort); let boundary = byOutput.get(key);
      if (!boundary) {
        const port = getPorts(getNode(doc, edge.sourceNode)).outputs.find(port => port.id === edge.sourcePort);
        boundary = { id: outputs.length ? 'result-' + (outputs.length + 1) : 'out', label: port.label, type: port.type, sourceNode: edge.sourceNode, sourcePort: edge.sourcePort, targets: [] };
        outputs.push(boundary); byOutput.set(key, boundary);
      }
      boundary.targets.push({ nodeId: edge.targetNode, portId: edge.targetPort });
    }
  }
  // Include unconnected required inputs: users can configure a reusable
  // component before connecting it in the parent canvas.
  for (const node of nodes) for (const port of getPorts(node).inputs) {
    if (port.required === false || doc.edges.some(edge => edge.targetNode === node.id && edge.targetPort === port.id)) continue;
    inputs.push({ id: 'arg-' + (inputs.length + 1), label: node.title + ' · ' + port.label, type: port.type, required: port.required !== false, targets: [{ nodeId: node.id, portId: port.id }] });
  }
  for (const node of nodes.filter(node => !doc.edges.some(edge => edge.sourceNode === node.id && business(edge)))) {
    for (const port of getPorts(node).outputs.filter(port => port.id !== 'learning')) {
      const key = signature(node.id, port.id); if (byOutput.has(key)) continue;
      const boundary = { id: outputs.length ? 'result-' + (outputs.length + 1) : 'out', label: node.title + ' · ' + port.label, type: port.type, sourceNode: node.id, sourcePort: port.id, targets: [] };
      outputs.push(boundary); byOutput.set(key, boundary);
    }
  }
  if (!inputs.length || !outputs.length) fail('组合需要至少一个对外输入和输出，请补齐节点端口。');
  if (inputs.length > 32 || outputs.length > 32) fail('组合的输入或输出超过 32 个，请缩小选区。');
  for (const input of inputs.filter(port => port.sourceNode && port.targets.every(target => getPorts(getNode(doc, target.nodeId)).inputs.find(port => port.id === target.portId)?.required === false))) {
    const pending = [input.sourceNode], seen = new Set();
    while (pending.length) {
      const current = pending.pop(); if (seen.has(current)) continue; seen.add(current);
      const node = getNode(doc, current);
      if (node.type === 'merge') continue;
      if (node.type === 'condition') fail('可跳过的条件分支正在连接可选输入，请将分支和汇总一起封装，避免改变缺省值语义。');
      pending.push(...doc.edges.filter(edge => edge.targetNode === current).map(edge => edge.sourceNode));
    }
  }
  // A subflow returns a data value, whereas condition ports select execution
  // paths. Keep conditional routing inside the component until it converges.
  for (const condition of nodes.filter(node => node.type === 'condition')) {
    const pending = [condition.id], seen = new Set();
    while (pending.length) {
      const current = pending.pop(); if (seen.has(current)) continue; seen.add(current);
      if (current !== condition.id && getNode(doc, current)?.type === 'merge') continue;
      if (outputs.some(port => port.sourceNode === current)) fail('请先在选区内汇总条件分支，再封装为子流程；条件分支不能直接作为多个组合输出。');
      pending.push(...doc.edges.filter(edge => edge.sourceNode === current && selected.has(edge.targetNode)).map(edge => edge.targetNode));
    }
  }
  return { inputs, outputs, nodes: nodes.map(node => node.id) };
}

function namedMappings(original, supplied, label) {
  if (supplied === undefined) return copy(original);
  if (!Array.isArray(supplied) || supplied.length !== original.length) fail(label + '端口数量已变化，请重新封装。');
  const names = new Map(supplied.map(port => [port.id, port.label]));
  if (names.size !== original.length || original.some(port => !names.has(port.id))) fail(label + '端口不匹配。');
  return original.map(port => {
    const name = names.get(port.id);
    if (typeof name !== 'string' || !name.trim() || name.length > 120 || name.includes('\0')) fail(label + '名称必须为 1–120 个字符。');
    return { ...copy(port), label: name.trim() };
  });
}

export function extractSelection(document, ids, options = {}) {
  const doc = validateDocument(document), analysis = analyzeSelection(doc, ids), selected = new Set(ids);
  const title = options.title ?? '新的组合节点';
  const inputs = namedMappings(analysis.inputs, options.inputs, '输入'), outputs = namedMappings(analysis.outputs, options.outputs, '输出');
  const chosen = doc.nodes.filter(node => selected.has(node.id)), left = Math.min(...chosen.map(node => node.x)), top = Math.min(...chosen.map(node => node.y));
  const width = Math.max(...chosen.map(node => node.x)) - left;
  const child = createDocument({ schemaVersion: 2, title });
  child.settings.maxConcurrency = doc.settings.maxConcurrency;
  child.nodes = chosen.map(node => ({ ...copy(node), x: node.x - left + 340, y: node.y - top + 60 }));
  child.edges = copy(doc.edges.filter(edge => selected.has(edge.sourceNode) && selected.has(edge.targetNode)));
  for (const [index, boundary] of inputs.entries()) {
    const required = boundary.required ?? boundary.targets.some(target => getPorts(getNode(doc, target.nodeId)).inputs.find(port => port.id === target.portId)?.required !== false);
    const input = createNode('input', { x: 20, y: 60 + index * 190 }, { title: boundary.label, config: { fieldName: boundary.id, sourceKind: 'value', outputType: boundary.type, required } });
    child.nodes.push(input);
    for (const target of boundary.targets) child.edges.push({ id: uid('edge'), sourceNode: input.id, sourcePort: 'out', targetNode: target.nodeId, targetPort: target.portId });
    boundary.required = required;
  }
  for (const [index, boundary] of outputs.entries()) {
    const output = createNode('output', { x: width + 680, y: 60 + index * 190 }, { title: boundary.label, config: { stage: 'final' } });
    child.nodes.push(output); boundary.outputNodeId = output.id;
    child.edges.push({ id: uid('edge'), sourceNode: boundary.sourceNode, sourcePort: boundary.sourcePort, targetNode: output.id, targetPort: 'in' });
  }
  const workflow = validateDocument(child);
  for (const producer of workflow.nodes.filter(requiresImageReview)) assertImageReviewPaths({ document: workflow }, producer.id);
  const node = createNode('subflow', { x: left, y: top }, { title, config: { document: workflow, inputType: 'object', outputType: 'any' }, ports: {
    inputs: inputs.map(port => ({ id: port.id, label: port.label, type: port.type, required: port.required })),
    outputs: outputs.map(port => ({ id: port.id, label: port.label, type: port.type, ...(outputs.length > 1 ? { valuePath: port.outputNodeId } : {}) })),
  } });
  const edges = copy(doc.edges.filter(edge => !selected.has(edge.sourceNode) && !selected.has(edge.targetNode)));
  for (const boundary of inputs.filter(port => port.sourceNode)) edges.push({ id: uid('edge'), sourceNode: boundary.sourceNode, sourcePort: boundary.sourcePort, targetNode: node.id, targetPort: boundary.id });
  for (const boundary of outputs) for (const target of boundary.targets) edges.push({ id: uid('edge'), sourceNode: node.id, sourcePort: boundary.id, targetNode: target.nodeId, targetPort: target.portId });
  const nodes = doc.nodes.filter(node => !selected.has(node.id)).map(item => item.type === 'human' && selected.has(item.config.reviewTargetNodeId)
    ? { ...item, config: { ...item.config, reviewTargetNodeId: node.id } } : item);
  return { document: validateDocument({ ...doc, nodes: [...nodes, node], edges }), node, workflow };
}

function embedded(document, nodeId) {
  const parent = validateDocument(document), node = getNode(parent, nodeId);
  if (!['subflow', 'foreach', 'loop'].includes(node?.type) || !node.config.document) fail('请选择有固定内部快照的子流程。');
  return { parent, node, child: validateDocument(node.config.document) };
}

export function updateEmbeddedWorkflow(document, nodeId, childDocument) {
  const { parent, node, child: original } = embedded(document, nodeId), child = validateDocument(childDocument);
  if (child.id !== original.id || child.schemaVersion !== 2) fail('内部流程与当前组合不匹配。');
  for (const [type, describe] of [['input', inputSignature], ['output', outputSignature]]) {
    const before = original.nodes.filter(node => node.type === type).map(describe).sort();
    const after = child.nodes.filter(node => node.type === type).map(describe).sort();
    if (JSON.stringify(before) !== JSON.stringify(after)) fail('组合的边界输入输出保持固定；请保留边界节点、端口类型和字段名，重新封装可调整接口。');
  }
  for (const producer of child.nodes.filter(requiresImageReview)) assertImageReviewPaths({ document: child }, producer.id);
  return validateDocument({ ...parent, nodes: parent.nodes.map(item => item.id === nodeId ? { ...item, config: { ...item.config, document: child } } : item) });
}

export function unpackSubflow(document, nodeId) {
  const { parent, node, child } = embedded(document, nodeId);
  if (node.type !== 'subflow') fail('逐项处理和条件循环需要保留控制语义，请进入内部编辑。');
  const inputs = child.nodes.filter(node => node.type === 'input'), outputs = child.nodes.filter(node => node.type === 'output' && node.config.stage !== 'intermediate');
  if (!inputs.length || !outputs.length) fail('内部流程缺少可映射的输入输出。');
  if (child.nodes.some(node => ['evaluation', 'improvement'].includes(node.type))) fail('含学习控制支线的子流程暂不能直接展开，请先在内部编辑学习目标。');
  // Keep child output nodes as explicit stage saves. Unpacking must preserve
  // their file-writing and preview behavior, not only their returned values.
  const normal = child.nodes.filter(node => node.type !== 'input');
  if (!normal.length) fail('组合没有可展开的内部能力节点。');
  const idMap = new Map(normal.map(item => [item.id, uid('node')]));
  const inputPorts = getPorts(node).inputs, outputPorts = getPorts(node).outputs;
  const inputSources = new Map();
  for (const input of inputs) {
    const port = inputPorts.find(port => port.id === input.config.fieldName) || (inputs.length === 1 && inputPorts.length === 1 ? inputPorts[0] : null);
    if (!port) fail('输入接口无法直接展开，请进入子流程检查字段映射。');
    inputSources.set(input.id, parent.edges.find(edge => edge.targetNode === nodeId && edge.targetPort === port.id));
  }
  const resolveSource = (sourceNode, sourcePort, seen = new Set()) => {
    if (seen.has(sourceNode)) fail('内部边界映射包含循环。'); seen.add(sourceNode);
    const source = getNode(child, sourceNode);
    if (source.type === 'input') {
      const edge = inputSources.get(sourceNode); return edge ? { sourceNode: edge.sourceNode, sourcePort: edge.sourcePort } : null;
    }
    if (source.type === 'output') {
      return { sourceNode: idMap.get(sourceNode), sourcePort: 'out' };
    }
    return { sourceNode: idMap.get(sourceNode), sourcePort };
  };
  const outputSources = new Map(), reviewSources = new Map();
  const reviewSource = (id, seen = new Set()) => {
    if (seen.has(id)) fail('审核目标映射包含循环。'); seen.add(id);
    const current = getNode(child, id);
    if (current.type === 'input') return inputSources.get(id)?.sourceNode || null;
    if (['tool', 'skill', 'transform', 'subflow'].includes(current.type)) return idMap.get(id);
    if (current.type === 'human' && current.config.reviewTargetNodeId) return reviewSource(current.config.reviewTargetNodeId, new Set(seen));
    const candidates = new Set(child.edges.filter(edge => edge.targetNode === id).map(edge => reviewSource(edge.sourceNode, new Set(seen))).filter(Boolean));
    return candidates.size === 1 ? [...candidates][0] : null;
  };
  for (const port of outputPorts.filter(port => port.id !== 'learning')) {
    let target;
    if (outputs.length === 1 && !port.valuePath) target = outputs[0];
    else if (port.valuePath && !port.valuePath.includes('.')) target = outputs.find(output => output.id === port.valuePath);
    if (!target) fail('输出包含额外字段投影，暂不能直接展开；可继续进入内部编辑。');
    outputSources.set(port.id, resolveSource(target.id, 'out'));
    reviewSources.set(port.id, reviewSource(target.id));
  }
  const left = Math.min(...normal.map(item => item.x)), top = Math.min(...normal.map(item => item.y));
  const nodes = normal.map(item => {
    const config = copy(item.config);
    if (item.type === 'output') config.stage = 'intermediate';
    if (config.reviewTargetNodeId) config.reviewTargetNodeId = idMap.get(config.reviewTargetNodeId) || config.reviewTargetNodeId;
    return { ...copy(item), id: idMap.get(item.id), x: node.x + item.x - left, y: node.y + item.y - top, config };
  });
  const edges = copy(parent.edges.filter(edge => edge.sourceNode !== nodeId && edge.targetNode !== nodeId));
  for (const edge of child.edges.filter(edge => idMap.has(edge.targetNode))) {
    const source = resolveSource(edge.sourceNode, edge.sourcePort);
    if (source) edges.push({ id: uid('edge'), ...source, targetNode: idMap.get(edge.targetNode), targetPort: edge.targetPort });
  }
  for (const edge of parent.edges.filter(edge => edge.sourceNode === nodeId)) {
    if (edge.sourcePort === 'learning') fail('此组合被学习支线观察，请先保留组合，避免改变学习目标。');
    const source = outputSources.get(edge.sourcePort); if (source) edges.push({ ...edge, ...source });
  }
  const retained = parent.nodes.filter(item => item.id !== nodeId).map(item => {
    if (item.type !== 'human' || item.config.reviewTargetNodeId !== nodeId) return item;
    const candidates = new Set(parent.edges.filter(edge => edge.targetNode === item.id && edge.sourceNode === nodeId).map(edge => reviewSources.get(edge.sourcePort)).filter(Boolean));
    if (candidates.size !== 1) fail('外部审核修改目标无法唯一映射，请先调整审核目标再展开。');
    return { ...item, config: { ...item.config, reviewTargetNodeId: [...candidates][0] } };
  });
  return validateDocument({ ...parent, nodes: [...retained, ...nodes], edges });
}
