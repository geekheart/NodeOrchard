// A conversation attempt, a human gate and a business run have independent
// lifecycles. These read-only projections never rewrite their source records.
const unresolvedStatuses = new Set(['thinking', 'queued', 'proposed', 'awaiting_action', 'error', 'interrupted']);
const succeeded = new Set(['complete', 'proposed', 'applied']);
const reviewAction = action => typeof action?.kind === 'string' && action.kind.startsWith('review-');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

export const canRetryConversationTurn = turn => ['error', 'interrupted'].includes(turn?.status)
  && !turn.outcome && !(turn.actions || []).some(reviewAction);

export function isConversationRetry(child, parent) {
  return !!child?.id && child.id !== parent?.id && child.retryOfTurnId === parent?.id && canRetryConversationTurn(parent)
    && (!child.workflowId || !parent.workflowId || child.workflowId === parent.workflowId)
    && typeof child.user?.text === 'string' && child.user.text === parent.user?.text
    && equal(child.user?.context || {}, parent.user?.context || {});
}

const exactReview = context => typeof context?.runId === 'string' && !!context.runId
  && typeof context.nodeId === 'string' && !!context.nodeId && Number.isInteger(context.attempt) && context.attempt > 0
  && typeof context.attemptId === 'string' && !!context.attemptId;

export function projectConversationIssues(turns = [], { reviewState } = {}) {
  const projected = turns.map(turn => { const { pendingState: _previousProjection, ...copy } = turn; return copy; });
  const entries = new Map(projected.map((turn, index) => [turn.id, { turn, index }]));
  for (const turn of projected) {
    if (unresolvedStatuses.has(turn.status) && (turn.outcome?.applied || turn.outcome?.status === 'complete')) {
      turn.pendingState = { status: 'resolved', label: '此对话操作已完成' }; continue;
    }
    if (turn.status !== 'awaiting_action' || !turn.actions?.length || !turn.actions.every(reviewAction)) continue;
    const states = turn.actions.map(action => {
      if (!exactReview(action.context) || typeof reviewState !== 'function') return 'unknown';
      try { const state = reviewState(action.context); return ['pending', 'resolved'].includes(state) ? state : 'unknown'; }
      catch { return 'unknown'; }
    });
    if (states.every(state => state === 'resolved')) turn.pendingState = { status: 'resolved', label: '此版本审核已处理或由新尝试替代' };
    else if (states.includes('unknown')) turn.pendingState = { status: 'unknown', label: '审核状态尚未确认，请查看当前审核卡' };
  }
  // Only a validated explicit link can close an earlier failed model attempt.
  // Following the chain closes failures A -> B -> successful C without guessing
  // that unrelated successful messages resolved A, or claiming the run succeeded.
  for (let index = projected.length - 1; index >= 0; index--) {
    const successor = projected[index]; if (!succeeded.has(successor.status)) continue;
    let child = successor, childIndex = index;
    while (child.retryOfTurnId) {
      const entry = entries.get(child.retryOfTurnId);
      if (!entry || entry.index >= childIndex || !isConversationRetry(child, entry.turn)) break;
      if (!entry.turn.pendingState) entry.turn.pendingState = { status: 'superseded', label: '已由后续重试接续', byTurnId: successor.id };
      child = entry.turn; childIndex = entry.index;
    }
  }
  return projected;
}

export function conversationTurnGroups(turns = []) {
  return { latest: turns.at(-1) || null, history: turns.slice(0, -1), unresolved: turns.filter(turn => unresolvedStatuses.has(turn.status)
    && !turn.outcome?.applied && !['resolved', 'superseded'].includes(turn.pendingState?.status)) };
}
