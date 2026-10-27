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

// Only a complete, explicit user statement is a local command. Questions,
// quoted examples, conditions and negations stay in the normal discussion path.
export function parseConversationIssueResolution(text) {
  if (typeof text !== 'string' || text.length > 120 || /[?？“”"'`「」『』]/.test(text)) return null;
  let value = text.trim().replace(/[。！!]+$/, '').replace(/\s+/g, '');
  const number = word => {
    if (/^\d{1,2}$/.test(word)) return Number(word);
    const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (word === '十') return 10;
    if (Object.hasOwn(digits, word)) return digits[word];
    const match = /^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/.exec(word);
    return match ? (match[1] ? digits[match[1]] : 1) * 10 + (digits[match[2]] || 0) : 0;
  };
  const prefix = /^(?:第)?(\d{1,2}|[一二两三四五六七八九十]{1,3})(?:个|项)(?:问题|事项)?/.exec(value);
  let ordinal;
  if (prefix) { ordinal = number(prefix[1]); if (ordinal < 1 || ordinal > 99) return null; value = value.slice(prefix[0].length); }
  else if (/^\d{1,2}$/.test(value)) { ordinal = number(value); value = ''; }
  if (ordinal && !value) return { ordinal };
  value = value.replace(/^(?:这个问题|这件事|这个事项|这件事情|问题|事项)/, '');
  if (/^(?:(?:已经|已)?解决了?|解决好了|处理好了|处理完了|已处理)$/.test(value)) return { disposition: 'handled', ...(ordinal ? { ordinal } : {}) };
  if (/^(?:不用(?:再)?处理了?|不再处理了?)$/.test(value)) return { disposition: 'dismissed', ...(ordinal ? { ordinal } : {}) };
  return null;
}

export const isConversationIssueCloseable = turn => ['proposed', 'error', 'interrupted', 'awaiting_action'].includes(turn?.status)
  && !turn.outcome?.applied && turn.outcome?.status !== 'complete'
  && !['resolved', 'superseded'].includes(turn.pendingState?.status) && !(turn.actions || []).some(reviewAction);

export function selectConversationIssue(turns = [], { targetTurnId, context = {}, ordinal, candidateIds } = {}) {
  const blocked = turn => {
    if (turn.status === 'dismissed' || ['resolved', 'superseded'].includes(turn.pendingState?.status) || ['complete', 'applied'].includes(turn.status)) return 'already-closed';
    if ((turn.actions || []).some(reviewAction)) return 'protected-review';
    if (['thinking', 'queued'].includes(turn.status)) return 'active';
    return 'target-not-closeable';
  };
  const choose = items => ({ status: 'choose', candidates: items.slice(0, 10) });
  const target = id => {
    const turn = turns.find(item => item.id === id);
    if (!turn) return { status: 'blocked', reason: 'target-missing' };
    return isConversationIssueCloseable(turn) ? { status: 'target', turn } : { status: 'blocked', reason: blocked(turn), turn };
  };
  const candidates = turns.filter(isConversationIssueCloseable);
  if (targetTurnId) return ordinal ? { status: 'blocked', reason: 'ambiguous-target' } : target(targetTurnId);
  if (ordinal !== undefined) {
    // Numbering is meaningful only against a list the server already showed.
    if (!Array.isArray(candidateIds) || !Number.isInteger(ordinal) || ordinal < 1 || ordinal > candidateIds.length) {
      return candidates.length ? choose(candidates) : { status: 'none' };
    }
    return target(candidateIds[ordinal - 1]);
  }
  if (!candidates.length) {
    const unresolved = conversationTurnGroups(turns).unresolved;
    const turn = unresolved.find(item => (item.actions || []).some(reviewAction)) || unresolved.find(item => ['thinking', 'queued'].includes(item.status));
    return turn ? { status: 'blocked', reason: blocked(turn), turn } : { status: 'none' };
  }
  const keys = ['workflowId', 'runId', 'nodeId', 'attempt', 'attemptId', 'artifactIds', 'artifactHashes'].filter(key => context[key] !== undefined && context[key] !== null);
  const matched = keys.length ? candidates.filter(turn => keys.every(key => equal(context[key], turn.user?.context?.[key] ?? (key === 'workflowId' ? turn.workflowId : undefined)))) : candidates;
  if (matched.length === 1) return { status: 'target', turn: matched[0] };
  return choose(matched.length ? matched : candidates);
}
