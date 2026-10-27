import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewRevisionPolicy, rerunRevisionFeedback } from '../shared/workflow/workflow-review-revision.mjs';

function run({ skillBefore = false, skillAfter = false, used = 0, limit = 3 } = {}) {
  const nodes = [{ id: 'input', type: 'input', config: {} },
    { id: 'poster', type: 'tool', config: { executionMode: 'code', language: 'python', code: "# reviewFeedback is a comment, not a supported revision contract\nreturn input" } },
    ...(skillBefore ? [{ id: 'author', type: 'skill', config: {} }] : []),
    { id: 'review', type: 'human', config: { reviewTargetNodeId: 'poster', maxRevisions: limit } },
    ...(skillAfter ? [{ id: 'later', type: 'skill', config: {} }] : []), { id: 'output', type: 'output', config: {} }];
  return { document: { nodes, edges: nodes.slice(1).map((node, index) => ({ sourceNode: nodes[index].id, targetNode: node.id })) },
    nodes: { review: { status: 'waiting_review', review: { revisionCount: used } } } };
}

test('revision policy preserves the count and code proposal route without a human revision quota', () => {
  const candidate = run({ used: 3 }), before = structuredClone(candidate), policy = reviewRevisionPolicy(candidate, 'review');
  assert.deepEqual({ used: policy.used, limit: policy.limit, remaining: policy.remaining, exhausted: policy.exhausted,
    targetNodeId: policy.targetNodeId, targetType: policy.targetType, strategy: policy.strategy, canRevise: policy.canRevise, reasonCode: policy.reasonCode },
  { used: 3, limit: null, remaining: null, exhausted: false, targetNodeId: 'poster', targetType: 'tool', strategy: 'proposal', canRevise: false, reasonCode: 'REVISION_REQUIRES_PROPOSAL' });
  assert.deepEqual(policy.consumerSkillNodeIds, []); assert.deepEqual(candidate, before);
  candidate.nodes.review.review.revisionCount = 0;
  assert.equal(reviewRevisionPolicy(candidate, 'review').reasonCode, 'REVISION_REQUIRES_PROPOSAL');
});

test('only a directly executed Skill before this review can consume its prose revision', () => {
  const later = reviewRevisionPolicy(run({ skillAfter: true }), 'review');
  assert.deepEqual(later.skillNodeIds, ['later']); assert.deepEqual(later.consumerSkillNodeIds, []);
  assert.equal(later.strategy, 'proposal'); assert.equal(later.canRevise, false);
  const candidate = run({ skillBefore: true, skillAfter: true, used: 1, limit: 2 });
  candidate.document.nodes.find(node => node.id === 'review').config.reviewTargetNodeId = 'author';
  const policy = reviewRevisionPolicy(candidate, 'review');
  assert.deepEqual(policy.consumerSkillNodeIds, ['author']); assert.deepEqual(policy.skillNodeIds, ['author', 'later']);
  assert.equal(policy.strategy, 'revise'); assert.equal(policy.canRevise, true); assert.equal(policy.remaining, null);
  candidate.document.nodes.find(node => node.id === 'author').type = 'subflow';
  candidate.document.nodes.find(node => node.id === 'author').config = { document: { nodes: [{ id: 'embedded', type: 'skill' }] } };
  assert.equal(reviewRevisionPolicy(candidate, 'review').strategy, 'proposal', 'Child-run Skills do not receive the parent revision contract.');
});

test('every tool review requires a core-code proposal even when successor Skills could receive prose', () => {
  for (const executionMode of ['code', 'tool']) {
    const candidate = run({ skillBefore: true, skillAfter: true, used: 12 });
    candidate.document.nodes.find(node => node.id === 'poster').config.executionMode = executionMode;
    const before = structuredClone(candidate), policy = reviewRevisionPolicy(candidate, 'review');
    assert.deepEqual(policy.consumerSkillNodeIds, ['author']);
    assert.equal(policy.strategy, 'proposal'); assert.equal(policy.canRevise, false);
    assert.equal(policy.reasonCode, 'REVISION_REQUIRES_PROPOSAL'); assert.match(policy.reason, /核心代码候选/);
    assert.deepEqual(candidate, before);
  }
});

test('legacy frozen maxRevisions values never stop further human revisions', () => {
  for (const limit of [1, 3, 99]) {
    const candidate = run({ skillBefore: true, used: 10, limit });
    candidate.document.nodes.find(node => node.id === 'review').config.reviewTargetNodeId = 'author';
    const policy = reviewRevisionPolicy(candidate, 'review');
    assert.equal(policy.used, 10); assert.equal(policy.limit, null); assert.equal(policy.remaining, null);
    assert.equal(policy.exhausted, false); assert.equal(policy.canRevise, true); assert.equal(policy.reasonCode, '');
  }
  const invalid = run({ skillBefore: true }); invalid.document.nodes.find(node => node.id === 'review').config.reviewTargetNodeId = 'later';
  assert.equal(reviewRevisionPolicy(invalid, 'review').strategy, 'unavailable');
});

test('rerun feedback preserves omitted requests and clears an explicit empty request for all affected Skills', () => {
  const candidate = run({ skillBefore: true, skillAfter: true });
  const previousNodes = { poster: { reviewFeedback: 'producer request' }, author: { reviewFeedback: 'author request' }, later: { reviewFeedback: 'later request' } };
  assert.deepEqual(rerunRevisionFeedback(candidate.document, ['poster'], { previousNodes }).feedbackByNode,
    { poster: 'producer request', author: 'author request', later: 'later request' });
  assert.deepEqual(rerunRevisionFeedback(candidate.document, ['poster'], { previousNodes, feedback: '' }).feedbackByNode,
    { poster: '', author: '', later: '' });
});
