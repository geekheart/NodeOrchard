import { validateDocument, getPorts } from './workflow-model.mjs';
import { validateWorkflowToolConfig, WORKFLOW_TOOLS } from './workflow-tools.mjs';

const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const REVISION = /^sha256:[a-f0-9]{64}$/;
const LEARNING_TYPES = new Set(['evaluation', 'improvement']);

export function requiresImageReview(node) {
  const capability = node.type === 'tool' && node.config.executionMode === 'tool' ? WORKFLOW_TOOLS.find(tool => tool.id === node.config.toolName) : null;
  return node.config.reviewImages === true || capability?.reviewRequired === true || capability?.defaultConfig?.reviewImages === true;
}

export function assertImageReviewPaths(plan, producerId) {
  const nodes = plan.nodes || plan.document.nodes.filter(node => !LEARNING_TYPES.has(node.type));
  const ids = new Set(nodes.map(node => node.id));
  const edges = (plan.edges || plan.document.edges).filter(edge => ids.has(edge.sourceNode) && ids.has(edge.targetNode));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) outgoing.get(edge.sourceNode).push(edge);
  const producer = byId.get(producerId); let found = false;
  const pending = outgoing.get(producerId).map(edge => edge.targetNode); const visited = new Set();
  while (pending.length) {
    const id = pending.pop(); if (visited.has(id)) continue; visited.add(id);
    const node = byId.get(id);
    if (node.type === 'human') { found = true; continue; }
    // An explicit stage output may save a preview branch. It grants no review
    // approval: every continuing business branch must still reach a human first.
    if (node.type === 'output' && node.config.stage === 'intermediate' && !outgoing.get(id).length) continue;
    if ((node.type === 'output' && node.config.stage === 'final')
      || !['merge', 'output', 'validation'].includes(node.type) || !outgoing.get(id).length) fail(producer.title + ' 的图片必须先经过人工审核，才能交给后续能力或最终输出。');
    pending.push(...outgoing.get(id).map(edge => edge.targetNode));
  }
  if (!found) fail(producer.title + ' 需要连接人工审核节点。');
}

// A learning branch observes one explicit business result. It never changes the
// business topology; improvement is a controller action between learning rounds.
export function learningBranch(document) {
  const clean = validateDocument(document);
  const evaluations = clean.nodes.filter(node => node.type === 'evaluation');
  const improvements = clean.nodes.filter(node => node.type === 'improvement');
  if (!evaluations.length && !improvements.length) return null;
  if (evaluations.length !== 1 || improvements.length !== 1) {
    fail('学习支路需要唯一的产物对比节点和 Skill 改进节点。');
  }
  const evaluationNode = evaluations[0];
  const improvementNode = improvements[0];
  const learningIds = new Set([evaluationNode.id, improvementNode.id]);
  const edges = clean.edges.filter(edge => learningIds.has(edge.sourceNode) || learningIds.has(edge.targetNode));
  const observation = edges.find(edge => edge.targetNode === evaluationNode.id && edge.targetPort === 'in');
  const improvement = edges.find(edge => edge.sourceNode === evaluationNode.id && edge.sourcePort === 'out'
    && edge.targetNode === improvementNode.id && edge.targetPort === 'in');
  if (edges.length !== 2 || !observation || !improvement || learningIds.has(observation.sourceNode)) {
    fail('学习支路必须完整连接：业务产物 → 产物对比 → Skill 改进。');
  }
  return {
    evaluationNode, improvementNode, sourceNodeId: observation.sourceNode, sourcePort: observation.sourcePort,
    edges: [observation, improvement], nodeOrder: [evaluationNode.id, improvementNode.id],
  };
}

export function planWorkflow(document) {
  const clean = validateDocument(document);
  if (new TextEncoder().encode(JSON.stringify(clean)).length > 2 * 1024 * 1024) fail('工作流不能超过 2MB。', 413);
  if (clean.mode !== 'execute') fail('请通过学习面板启动学习；此接口只接受执行模式快照。');
  if (clean.schemaVersion === 2) return planDAG(clean);
  const branch = learningBranch(clean);
  const branchEdgeIds = new Set(branch?.edges.map(edge => edge.id));
  const nodes = clean.nodes.filter(node => !LEARNING_TYPES.has(node.type));
  const edges = clean.edges.filter(edge => !branchEdgeIds.has(edge.id));
  const inputs = nodes.filter(node => node.type === 'input');
  const outputs = nodes.filter(node => node.type === 'output');
  const operations = nodes.filter(node => ['skill', 'tool'].includes(node.type));
  if (inputs.length !== 1 || outputs.length !== 1 || !operations.length || nodes.length !== operations.length + 2) {
    fail('执行需要一个输入、至少一个 Skill 或工具 / 代码能力、一个输出，当前不支持其它节点。');
  }
  const inputNode = inputs[0];
  const outputNode = outputs[0];
  if (!['manual', 'schedule'].includes(inputNode.config.trigger)) fail('不支持的输入触发方式。');
  if (inputNode.config.outputType === 'fileRef') fail('当前不支持 fileRef 输入或输出，请选择文本或 JSON 类型。');
  for (const operation of operations) {
    if (operation.config.failurePolicy !== 'stop') fail('当前不支持自动重试，请使用停止失败策略。');
    if ([operation.config.inputType, operation.config.outputType].includes('fileRef')) fail('当前不支持 fileRef 输入或输出，请选择文本或 JSON 类型。');
    if (operation.type === 'skill') {
      if (!operation.config.skillRef.trim()) fail('请先选择真实的 Hermes Skill。');
      if (!REVISION.test(operation.config.version)) fail('请先选择 Skill 的有效 sha256 版本。');
    } else validateWorkflowToolConfig(operation);
  }
  if (edges.length !== nodes.length - 1) fail('所有业务节点和连线必须组成一条完整线性链。');
  const incoming = new Map(nodes.map(node => [node.id, []]));
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) {
    incoming.get(edge.targetNode).push(edge);
    outgoing.get(edge.sourceNode).push(edge);
  }
  for (const node of nodes) {
    if (incoming.get(node.id).length !== (node.type === 'input' ? 0 : 1)
      || outgoing.get(node.id).length !== (node.type === 'output' ? 0 : 1)) {
      fail('执行链不能包含分支、汇合或悬空节点。');
    }
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  const nodeOrder = [];
  const seen = new Set();
  let current = inputNode;
  while (current) {
    if (seen.has(current.id)) fail('执行链不能包含循环。');
    seen.add(current.id); nodeOrder.push(current.id);
    const edge = outgoing.get(current.id)[0];
    current = edge ? byId.get(edge.targetNode) : null;
  }
  if (nodeOrder.length !== nodes.length || nodeOrder.at(-1) !== outputNode.id) fail('所有业务节点必须从输入连通到同一个输出。');
  if (branch && !seen.has(branch.sourceNodeId)) fail('学习支路必须观察主执行链中的业务产物。');
  const operationNodes = nodeOrder.slice(1, -1).map(id => byId.get(id));
  return {
    document: clean, inputNode, outputNode, nodeOrder, learningBranch: branch,
    operationNodes, skillNodes: operationNodes.filter(node => node.type === 'skill'),
  };
}

export function planDAG(clean) {
  const branch = learningBranch(clean);
  const branchIds = new Set(branch?.edges.map(edge => edge.id));
  const nodes = clean.nodes.filter(node => !LEARNING_TYPES.has(node.type));
  const edges = clean.edges.filter(edge => !branchIds.has(edge.id));
  const inputNodes = nodes.filter(node => node.type === 'input');
  const outputNodes = nodes.filter(node => node.type === 'output');
  if (!inputNodes.length || !outputNodes.length) fail('工作流至少需要一个输入和一个成果节点。');
  const finalOutputNodes = outputNodes.filter(node => node.config.stage !== 'intermediate');
  if (!finalOutputNodes.length) fail('工作流至少需要一个最终交付节点；阶段产物可在流程中间保存。');
  const supported = new Set(['input', 'validation', 'skill', 'tool', 'output', 'human', 'transform', 'merge', 'subflow', 'condition', 'foreach', 'loop']);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const incoming = new Map(nodes.map(node => [node.id, []]));
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) { incoming.get(edge.targetNode).push(edge); outgoing.get(edge.sourceNode).push(edge); }
  for (const node of nodes) {
    if (!supported.has(node.type)) fail('此节点尚未实现执行：' + node.title);
    if (node.config.failurePolicy && node.config.failurePolicy !== 'stop') fail('请使用停止失败策略；需要重试时显式重跑节点。');
    if (node.type === 'input' && incoming.get(node.id).length) fail('输入节点不能接收业务连线。');
    if (node.type === 'output' && node.config.fileName && (/[/\\:\x00-\x1f]/.test(node.config.fileName) || node.config.fileName.startsWith('.') || node.config.fileName.length > 200)) fail('保存文件名必须是安全的文件名称，不能包含目录或隐藏路径。');
    if (node.type !== 'input') {
      for (const port of getPorts(node).inputs) if (port.required !== false
        && !incoming.get(node.id).some(edge => edge.targetPort === port.id)) fail(node.title + ' 缺少必填输入：' + port.label);
    }
    if (node.type === 'skill') {
      if (!node.config.skillRef.trim() || !REVISION.test(node.config.version)) fail(node.title + ' 需要真实且固定版本的 Hermes Skill。');
    }
    if (node.type === 'tool') validateWorkflowToolConfig({ ...node, config: { ...node.config,
      inputType: ['fileRef', 'folderRef', 'image', 'artifactRef', 'artifactBundle'].includes(node.config.inputType) ? 'any' : node.config.inputType,
      outputType: ['fileRef', 'folderRef', 'image', 'artifactRef', 'artifactBundle'].includes(node.config.outputType) ? 'any' : node.config.outputType } });
    if (node.type === 'condition' && !node.config.expression.trim()) fail('条件节点需要判断表达式。');
    if (node.type === 'validation' && !node.config.rules.length) fail(node.title + ' 至少需要一条校验规则。');
    if (['subflow', 'foreach', 'loop'].includes(node.type) && !node.config.document && !node.config.workflowRef) fail('请选择子流程。');
  }
  const degree = new Map(nodes.map(node => [node.id, incoming.get(node.id).length]));
  const ready = nodes.filter(node => degree.get(node.id) === 0).map(node => node.id);
  const nodeOrder = [];
  while (ready.length) {
    const id = ready.shift(); nodeOrder.push(id);
    for (const edge of outgoing.get(id)) { degree.set(edge.targetNode, degree.get(edge.targetNode) - 1); if (!degree.get(edge.targetNode)) ready.push(edge.targetNode); }
  }
  if (nodeOrder.length !== nodes.length) fail('工作流不能包含环；请使用有界循环节点。');
  const reachable = new Set(inputNodes.map(node => node.id));
  for (const id of nodeOrder) if (reachable.has(id)) for (const edge of outgoing.get(id)) reachable.add(edge.targetNode);
  if (nodes.some(node => !reachable.has(node.id))) fail('所有业务节点都必须从输入连通。');
  const names = inputNodes.map(node => node.config.fieldName || node.id);
  if (new Set(names).size !== names.length) fail('多个输入节点的字段名称必须唯一。');
  for (const producer of nodes.filter(requiresImageReview)) assertImageReviewPaths({ nodes, edges }, producer.id);
  for (const node of nodes.filter(node => node.type === 'human' && node.config.reviewTargetNodeId)) {
    const ancestors = new Set(); const pending = incoming.get(node.id).map(edge => edge.sourceNode);
    while (pending.length) { const id = pending.pop(); if (ancestors.has(id)) continue; ancestors.add(id); pending.push(...incoming.get(id).map(edge => edge.sourceNode)); }
    if (!ancestors.has(node.config.reviewTargetNodeId) || !['skill', 'tool', 'transform', 'subflow'].includes(byId.get(node.config.reviewTargetNodeId)?.type)) fail('审核修改目标必须是此审核节点的上游生产能力。');
  }
  const operationNodes = nodeOrder.map(id => byId.get(id)).filter(node => node.type !== 'input');
  return { document: clean, inputNode: inputNodes[0], outputNode: finalOutputNodes.at(-1), inputNodes, outputNodes, finalOutputNodes,
    nodeOrder, operationNodes, skillNodes: nodes.filter(node => node.type === 'skill'), learningBranch: branch,
    nodes, edges, incoming, outgoing, byId };
}
