import { validateDocument } from './workflow-model.mjs';
import { planWorkflow, learningImprovementTargets, requiresImageReview, assertImageReviewPaths } from './workflow-plan.mjs';

const fail = message => { throw new Error(message); };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const copy = value => structuredClone(value);
const protectedTypes = new Set(['input', 'output', 'evaluation', 'improvement', 'human']);
const containerTypes = new Set(['subflow', 'foreach', 'loop']);
const toolKeys = new Set(['code', 'language', 'executionMode', 'toolName']);
const nodeShape = ({ id, type, title, config, ports, origin }) => ({ id, type, title, config, ports, origin });
const topShape = ({ id, title, schemaVersion, settings }) => ({ id, title, schemaVersion, settings });

function dataProperties(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value !== 'object') return;
  if (depth > 50 || seen.has(value) || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length) fail('学习快照不是有效 JSON 数据。');
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value')) fail('学习快照不能包含访问器。');
    dataProperties(descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
}

function optionObject(options, allowed) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    || Reflect.ownKeys(options).some(key => !allowed.includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(options)).some(field => !Object.hasOwn(field, 'value'))) fail('学习候选范围选项无效。');
}

// Moving the camera or nodes is compatible with applying an already reviewed
// result. Identity, provenance, configuration and array order remain a fence.
export function learningSnapshotChanged(before, after) {
  if (!before || !after) return true;
  const relevant = value => ({ ...topShape(value), nodes: (value.nodes || []).map(nodeShape), edges: value.edges || [] });
  try { dataProperties(before); dataProperties(after); return !same(relevant(before), relevant(after)); } catch { return true; }
}

function optionsFor(plan, options) {
  optionObject(options, ['scope', 'trainableNodeIds']);
  const scope = options.scope ?? 'skills', ids = options.trainableNodeIds ?? [];
  if (!['skills', 'tools', 'workflow'].includes(scope) || !Array.isArray(ids) || ids.length > 200) fail('学习候选范围或目标无效。');
  dataProperties(ids);
  if (ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))
    || new Set(ids).size !== ids.length) fail('学习候选范围或目标无效。');
  // Earlier feedback candidates predate graph-owned improvement configuration.
  // Only their original selected Skill references remain compatible.
  if (!plan.learningBranch && scope === 'skills') {
    if (!ids.length || ids.some(id => !plan.skillNodes.some(node => node.id === id))) fail('旧反馈候选缺少有效的原 Skill 目标。');
    return { scope, ids };
  }
  const allowed = learningImprovementTargets(plan);
  const matches = scope === 'skills' ? ids.length > 0 && ids.every(id => allowed.ids.includes(id))
    : scope === 'workflow' && !ids.length || same(ids, allowed.ids);
  if (scope !== allowed.scope || !matches) {
    fail('学习候选不能扩大或更换改进节点已固定的范围。');
  }
  return { scope, ids };
}

function reviewPolicy(basePlan, candidatePlan) {
  for (const node of basePlan.document.nodes.filter(requiresImageReview)) {
    const proposed = candidatePlan.document.nodes.find(item => item.id === node.id);
    if (!proposed || !requiresImageReview(proposed) || node.config.reviewImages === true && proposed.config.reviewImages !== true) {
      fail('学习候选不能移除或关闭已有图片审核要求。');
    }
    assertImageReviewPaths(candidatePlan, proposed.id);
  }
}

function replaceToolCore(target, proposed) {
  for (const key of toolKeys) {
    if (Object.hasOwn(proposed.config, key)) target.config[key] = proposed.config[key];
    else delete target.config[key];
  }
}

function selectedChanges(base, candidate, scope, ids) {
  const expected = copy(base);
  for (const id of ids) {
    const original = expected.nodes.find(node => node.id === id), proposed = candidate.nodes.find(node => node.id === id);
    if (!proposed || proposed.type !== original.type) fail('学习候选缺少原目标节点或改变了节点类型。');
    if (scope === 'skills') {
      original.config.skillRef = proposed.config.skillRef; original.config.version = proposed.config.version;
    } else replaceToolCore(original, proposed);
  }
  if (learningSnapshotChanged(expected, candidate)) {
    fail(scope === 'skills' ? 'Skill 学习候选只能修改所选节点的固定引用与版本。' : '工具学习候选只能修改所选节点的业务代码或工具配置。');
  }
}

function workflowChanges(basePlan, candidatePlan) {
  const base = basePlan.document, candidate = candidatePlan.document;
  const byId = new Map(candidate.nodes.map(node => [node.id, node]));
  const baseById = new Map(base.nodes.map(node => [node.id, node]));
  const fixed = new Set(base.nodes.filter(node => protectedTypes.has(node.type)).map(node => node.id));
  fixed.add(basePlan.learningBranch.sourceNodeId);
  for (const id of fixed) {
    const original = baseById.get(id), proposed = byId.get(id);
    if (!proposed) fail('工作流学习不能删除输入、产物、比较目标、学习支路或人工审核节点。');
    const expected = copy(original);
    // Directly observing a tool's output is a valid learning objective. Keep its
    // identity and data contract fixed while allowing its business code to learn.
    if (id === basePlan.learningBranch.sourceNodeId && ['tool', 'transform'].includes(original.type)) replaceToolCore(expected, proposed);
    if (!same(nodeShape(expected), nodeShape(proposed))) fail('工作流学习不能修改输入、产物、比较接口、学习支路或人工审核节点。');
  }
  const humanIds = new Set(base.nodes.filter(node => node.type === 'human').map(node => node.id));
  const branchIds = new Set([basePlan.learningBranch.evaluationNode.id, basePlan.learningBranch.improvementNode.id]);
  const frozenEdge = edge => humanIds.has(edge.sourceNode) || humanIds.has(edge.targetNode)
    || branchIds.has(edge.sourceNode) || branchIds.has(edge.targetNode);
  if (!same(base.edges.filter(frozenEdge), candidate.edges.filter(frozenEdge))) fail('工作流学习不能改变学习支路或既有人工审核的连接。');
  const skillPairs = new Set(base.nodes.filter(node => node.type === 'skill').map(node => JSON.stringify([node.config.skillRef, node.config.version])));
  const containerReference = node => ({ workflowRef: node.config.workflowRef || '', version: node.config.version || '', document: node.config.document || null });
  const containers = new Set(base.nodes.filter(node => containerTypes.has(node.type)).map(node => JSON.stringify(containerReference(node))));
  for (const node of candidate.nodes) {
    const original = baseById.get(node.id);
    if (original) {
      if (node.type !== original.type || !same(node.origin, original.origin)) fail('工作流学习不能改变已有节点类型或派生来源。');
      if (node.type === 'skill' && (node.config.skillRef !== original.config.skillRef || node.config.version !== original.config.version)) fail('工作流学习不能改写已有 Skill 的固定引用或版本。');
      if (!same(node.config.document, original.config.document)) fail('工作流学习不能改写内嵌流程快照。');
      if (containerTypes.has(node.type) && !same(containerReference(node), containerReference(original))) fail('工作流学习不能更换已固定的子流程来源。');
    } else {
      if (protectedTypes.has(node.type) && node.type !== 'human') fail('工作流学习不能新增输入、产物或学习控制边界。');
      if (node.origin) fail('新增业务节点不能伪造派生来源。');
      if (node.config.document && !containerTypes.has(node.type)) fail('新增业务节点不能携带内嵌流程。');
      if (containerTypes.has(node.type) && !containers.has(JSON.stringify(containerReference(node)))) fail('新增子流程只能复用原图已固定的来源。');
    }
    if (node.type === 'skill' && !skillPairs.has(JSON.stringify([node.config.skillRef, node.config.version]))) fail('新增 Skill 只能复用原图真实且固定的引用与版本。');
  }
}

// A candidate is still data. This validates graph edits and their authority; it
// neither runs business code nor provides an operating-system sandbox.
export function validateLearningCandidate(base, candidate, options = {}) {
  const original = validateDocument(base), proposed = validateDocument(candidate);
  const basePlan = planWorkflow({ ...original, mode: 'execute' });
  const { scope, ids } = optionsFor(basePlan, options);
  if (!same(topShape(original), topShape(proposed))) fail('学习候选不能改变工作流身份、标题、设置或 schema。');
  const candidatePlan = planWorkflow({ ...proposed, mode: 'execute' });
  if (scope === 'workflow') workflowChanges(basePlan, candidatePlan);
  else selectedChanges(basePlan.document, candidatePlan.document, scope, ids);
  reviewPolicy(basePlan, candidatePlan);
  return candidatePlan.document;
}

export function mergeLearningCandidate(current, candidate, options = {}) {
  optionObject(options, ['baseDocument', 'scope', 'trainableNodeIds']);
  const { baseDocument, scope = 'skills', trainableNodeIds = [] } = options;
  if (learningSnapshotChanged(baseDocument, current)) fail('草稿已变化，请恢复对应学习快照后再应用候选。');
  const proposed = validateLearningCandidate(baseDocument, candidate, { scope, trainableNodeIds });
  const present = validateDocument(current), positions = new Map(present.nodes.map(node => [node.id, { x: node.x, y: node.y }]));
  const document = { ...proposed, viewport: present.viewport, nodes: proposed.nodes.map(node => positions.has(node.id) ? { ...node, ...positions.get(node.id) } : node) };
  return validateDocument(document);
}
