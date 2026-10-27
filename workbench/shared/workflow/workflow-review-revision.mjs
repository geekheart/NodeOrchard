// Read only the frozen run graph. Draft edits and embedded child Skills cannot
// make an existing producer understand a natural-language revision.
const learningTypes = new Set(['evaluation', 'improvement']);
const producerTypes = new Set(['skill', 'tool', 'transform', 'subflow']);

function graph(document) {
  const nodes = (document?.nodes || []).filter(node => !learningTypes.has(node.type));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const incoming = new Map(nodes.map(node => [node.id, []]));
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  for (const edge of document?.edges || []) if (byId.has(edge.sourceNode) && byId.has(edge.targetNode)) {
    incoming.get(edge.targetNode).push(edge.sourceNode); outgoing.get(edge.sourceNode).push(edge.targetNode);
  }
  return { nodes, byId, incoming, outgoing };
}

function reachable(adjacency, seeds) {
  const seen = new Set(), pending = [...seeds];
  while (pending.length) {
    const id = pending.pop(); if (seen.has(id) || !adjacency.has(id)) continue;
    seen.add(id); pending.push(...adjacency.get(id));
  }
  return seen;
}

// Both review-revise and an explicit rerun reset the same descendant scope and
// deliver the request to its selected producers and every directly run Skill.
export function rerunRevisionFeedback(document, nodeIds, { feedback, previousNodes = {} } = {}) {
  const { nodes, byId, outgoing } = graph(document), selected = new Set(nodeIds);
  const affected = reachable(outgoing, nodeIds);
  const affectedNodeIds = nodes.filter(node => affected.has(node.id)).map(node => node.id);
  const skillNodeIds = affectedNodeIds.filter(id => byId.get(id).type === 'skill');
  const feedbackByNode = Object.fromEntries(affectedNodeIds.filter(id => byId.get(id).type === 'skill'
    || selected.has(id) && producerTypes.has(byId.get(id).type))
    .map(id => [id, feedback ?? previousNodes[id]?.reviewFeedback ?? '']));
  return { affectedNodeIds, skillNodeIds, feedbackByNode };
}

export function reviewRevisionPolicy(run, humanNodeId, requestedTargetNodeId) {
  const { byId, incoming } = graph(run?.document), human = byId.get(humanNodeId);
  const recorded = run?.nodes?.[humanNodeId]?.review?.revisionCount;
  const used = Number.isSafeInteger(recorded) && recorded >= 0 ? recorded : 0;
  // Human feedback can continue until accepted. Preserve the response shape for
  // older clients while ignoring historical maxRevisions in frozen documents.
  const limit = null, remaining = null, exhausted = false;
  const targetNodeId = human?.config?.reviewTargetNodeId || requestedTargetNodeId || '';
  const target = byId.get(targetNodeId), ancestors = reachable(incoming, incoming.get(humanNodeId) || []);
  const validTarget = human?.type === 'human' && ancestors.has(targetNodeId) && producerTypes.has(target?.type)
    && (!requestedTargetNodeId || requestedTargetNodeId === targetNodeId);
  const scope = rerunRevisionFeedback(run?.document, validTarget ? [targetNodeId] : []);
  // A Skill behind the review gate cannot change the candidate being reviewed.
  const consumerSkillNodeIds = scope.skillNodeIds.filter(id => ancestors.has(id));
  // Tool edits regenerate the tool's own core code. A successor Skill must not
  // turn that request into a rerun of the unchanged code or registered tool.
  const strategy = !validTarget ? 'unavailable' : target.type === 'tool' ? 'proposal'
    : consumerSkillNodeIds.length ? 'revise' : 'proposal';
  const reasonCode = !validTarget ? 'REVISION_TARGET_UNAVAILABLE'
    : strategy === 'proposal' ? 'REVISION_REQUIRES_PROPOSAL' : '';
  const reason = !validTarget ? '此审核未配置可用的上游修改目标。'
    : target.type === 'tool' ? '工具修改需先由 AI 重新生成该节点的核心代码候选，审阅并应用到草稿后明确新建运行；本次审核与修改次数保持不变。'
      : strategy === 'proposal' ? '该产物由固定代码或工具生成，不能直接按自然语言修改。请先在对话中生成代码或配置修改候选，应用后新建运行；本次审核与修改次数保持不变。' : '';
  return { used, limit, remaining, exhausted, targetNodeId, targetType: target?.type || '', strategy,
    canRevise: strategy === 'revise', reasonCode, reason,
    affectedNodeIds: scope.affectedNodeIds, skillNodeIds: scope.skillNodeIds, consumerSkillNodeIds };
}
