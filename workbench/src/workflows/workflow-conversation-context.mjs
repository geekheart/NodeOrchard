import { createHash } from 'node:crypto';
import { sanitizeDiagnosticText } from '../app-diagnostics.mjs';

const FORMAT = 'NodeOrchard.workflow-conversation-context';
const fail = message => { throw Object.assign(new Error(message), { httpStatus: 400 }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, limit) => typeof value === 'string' ? value.replaceAll('\0', '').slice(0, limit) : '';
export const eligibleConversationTurn = (turn, restricted, { document, readRun } = {}) => {
  if (!restricted) return true;
  if (document?.mode === 'learn' || turn.privateValue?.document?.mode === 'learn' || ['skill', 'feedback'].includes(turn.user?.intent)
    || (turn.actions || []).some(action => /learn|feedback/.test(action?.kind || action?.type || action?.id || '')) || turn.outcome?.learningId) return false;
  if (turn.user?.context?.runId && readRun) {
    try { const run = readRun(turn.user.context.runId); if (!run || run.learningId || run.memoryScopeId || run.document?.mode === 'learn') return false; }
    catch { return false; }
  }
  return true;
};
const message = (turn, role) => ({ sourceTurnId: turn.id, role, text: turn[role]?.text || '',
  ...(typeof turn.user?.intent === 'string' ? { intent: turn.user.intent } : {}), historicalStatus: turn.originalStatus || turn.status || 'unknown' });

// Files are durable history. The native model session and its authority are never
// serialized into the portable continuation used for the next model call.
export function captureConversationSnapshot(db, workflowId) {
  const exists = name => db?.prepare?.("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const revision = exists('workflow_conversations') ? db.prepare('SELECT revision FROM workflow_conversations WHERE workflow_id=?').get(workflowId)?.revision || 0 : 0;
  const rows = exists('workflow_conversation_turns') ? db.prepare('SELECT value,private_value FROM workflow_conversation_turns WHERE workflow_id=? ORDER BY rowid').all(workflowId) : [];
  return { version: 1, workflowId, revision, turns: rows.map(row => ({ ...JSON.parse(row.value), privateValue: JSON.parse(row.private_value || '{}') })) };
}

export const conversationJson = snapshot => JSON.stringify(snapshot, null, 2) + '\n';

export function conversationMarkdown(snapshot) {
  const lines = ['# 工作流对话', '', `工作流：${snapshot.workflowId}`, `会话版本：${snapshot.revision}`, ''];
  const block = text => {
    const longest = (text.match(/`+/g) || []).reduce((length, value) => Math.max(length, value.length), 2);
    const fence = '`'.repeat(longest + 1);
    return `${fence}text\n${text}\n${fence}`;
  };
  for (const turn of snapshot.turns || []) {
    lines.push(`## ${turn.createdAt || ''} · ${turn.id}`, '');
    for (const [role, label] of [['user', '用户'], ['assistant', '助手']]) {
      const text = turn[role]?.text;
      if (typeof text === 'string' && text.length) lines.push(`### ${label}`, '', block(text), '');
    }
  }
  return lines.join('\n') + '\n';
}

function progress(turn) {
  const steps = [...(Array.isArray(turn.assistant?.checkpoint?.steps) ? turn.assistant.checkpoint.steps : []),
    ...(Array.isArray(turn.assistant?.historicalProgress) ? turn.assistant.historicalProgress : [])];
  if (!steps.length && plain(turn.assistant?.progress)) steps.push(turn.assistant.progress);
  return steps.filter(plain).map(step => ({ sourceTurnId: turn.id, stage: bounded(step.stage, 80),
    label: bounded(step.label, 160), status: bounded(step.status, 40) })).filter(step => step.stage || step.label);
}

function projectMessage(value, known) {
  if (!plain(value) || !['user', 'assistant'].includes(value.role) || typeof value.sourceTurnId !== 'string'
    || typeof value.text !== 'string'
    || known && !known.has(value.sourceTurnId)) return undefined;
  const originalCharacters = Number.isSafeInteger(value.originalCharacters) && value.originalCharacters >= 0 ? value.originalCharacters : value.text?.length || 0;
  const text = bounded(sanitizeDiagnosticText(value.text || ''), 900);
  if (!text) return undefined;
  return { sourceTurnId: bounded(value.sourceTurnId, 128), role: value.role, text, originalCharacters,
    truncated: value.truncated === true || originalCharacters > text.length,
    ...(typeof value.intent === 'string' ? { intent: bounded(value.intent, 24) } : {}), historicalStatus: bounded(value.historicalStatus, 40) || 'unknown' };
}

export function projectConversationContinuation(seed, { workflowId, readOnly = false } = {}) {
  if (!plain(seed) || seed.format !== FORMAT || seed.version !== 1 || seed.workflowId !== workflowId) return undefined;
  const project = values => (Array.isArray(values) ? values : []).filter(value => !readOnly || !['skill', 'feedback'].includes(value?.intent))
    .map(value => projectMessage(value)).filter(Boolean);
  const value = { format: FORMAT, version: 1, workflowId, historicalOnly: true, resumePolicy: 'fresh-session',
    turnCount: Number.isSafeInteger(seed.turnCount) && seed.turnCount >= 0 ? seed.turnCount : 0,
    backgroundMessages: project(seed.backgroundMessages).slice(0, 3).map(item => ({ ...item, text: item.text.slice(0, 500), truncated: item.truncated || item.text.length > 500 })),
    recentMessages: project(seed.recentMessages).slice(-6),
    diagnosticProgress: (Array.isArray(seed.diagnosticProgress) ? seed.diagnosticProgress : []).filter(plain).slice(-8)
      .map(step => ({ sourceTurnId: bounded(step.sourceTurnId, 128), stage: bounded(step.stage, 80), label: bounded(step.label, 160), status: bounded(step.status, 40) })),
    historyTool: 'workflow.conversation' };
  while (JSON.stringify(value).length > 8000) {
    if (value.recentMessages.length > 2) value.recentMessages.shift();
    else if (value.backgroundMessages.length > 1) value.backgroundMessages.pop();
    else if (value.diagnosticProgress.length > 1) value.diagnosticProgress.shift();
    else break;
  }
  return value;
}

export function buildConversationContext(snapshot) {
  const turns = (snapshot.turns || []).filter(turn => turn.status !== 'thinking');
  const seed = projectConversationContinuation({ format: FORMAT, version: 1, workflowId: snapshot.workflowId, turnCount: snapshot.turns.length,
    backgroundMessages: turns.filter(turn => turn.user?.text).slice(0, 3).map(turn => message(turn, 'user')),
    recentMessages: turns.slice(-3).flatMap(turn => ['user', 'assistant'].map(role => message(turn, role))),
    diagnosticProgress: turns.flatMap(progress) }, { workflowId: snapshot.workflowId });
  return { ...seed, conversationRevision: snapshot.revision, conversationSha256: createHash('sha256').update(conversationJson(snapshot)).digest('hex'),
    coveredThroughTurnId: snapshot.turns.at(-1)?.id || null };
}

export function conversationContinuation(snapshot, { readOnly = false, document, readRun } = {}) {
  const filtered = { ...snapshot, turns: snapshot.turns.filter(turn => eligibleConversationTurn(turn, readOnly, { document, readRun })) };
  return projectConversationContinuation(buildConversationContext(filtered), { workflowId: snapshot.workflowId, readOnly });
}

export function validateConversationContext(value, snapshot) {
  if (!plain(value)) fail('对话上下文格式无效。');
  const expected = buildConversationContext(snapshot);
  if (Object.keys(value).some(key => !Object.hasOwn(expected, key)) || Object.keys(expected).some(key => !Object.hasOwn(value, key))) fail('对话上下文字段无效。');
  // A context is an extract of the bound transcript, never a free-form system
  // prompt imported from another machine. Compare parsed data, not key order.
  const canonical = item => Array.isArray(item) ? item.map(canonical) : plain(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  if (JSON.stringify(canonical(value)) !== JSON.stringify(canonical(expected))) fail('对话上下文与会话文件的身份、版本或内容不一致。');
  return expected;
}

export function readConversationHistory(db, workflowId, { query = '', beforeTurnId, turnId, offset = 0, limit = 4 } = {}, { readOnly = false, document, readRun } = {}) {
  if (typeof query !== 'string' || query.length > 200 || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 8) fail('会话历史查询范围无效。');
  const snapshot = captureConversationSnapshot(db, workflowId);
  if (turnId && (query || beforeTurnId)) fail('单条消息读取不能同时使用查询或分页起点。');
  let turns = snapshot.turns.filter(turn => eligibleConversationTurn(turn, readOnly, { document, readRun }));
  if (turnId) {
    const turn = turns.find(value => value.id === turnId);
    if (!turn) fail('会话消息不存在。');
    const content = ['user', 'assistant'].map(role => ({ role, text: turn[role]?.text || '' }));
    // Stay below the diagnostic broker's per-string projection limit so its
    // cursor never skips characters hidden by a second truncation layer.
    const total = content.reduce((sum, item) => sum + item.text.length, 0), size = 2000;
    let start = 0;
    const messages = content.map(item => {
      const end = start + item.text.length, text = item.text.slice(Math.max(0, offset - start), Math.max(0, Math.min(item.text.length, offset + size - start)));
      start = end; return { role: item.role, text };
    }).filter(item => item.text);
    return { workflowId, revision: snapshot.revision, historicalOnly: true, turns: [{ id: turn.id, historicalStatus: turn.originalStatus || turn.status, messages }],
      totalCharacters: total, offset, nextOffset: offset + size < total ? offset + size : null, hasMore: offset + size < total };
  }
  if (offset) fail('读取单条消息时才可以使用 offset。');
  if (beforeTurnId) {
    const index = turns.findIndex(turn => turn.id === beforeTurnId);
    if (index < 0) fail('会话分页起点不存在。');
    turns = turns.slice(0, index);
  }
  if (query) turns = turns.filter(turn => [turn.user?.text, turn.assistant?.text].some(text => text?.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  const selected = turns.slice(-limit), maxText = Math.min(1800, Math.floor(9000 / Math.max(1, selected.length * 2)));
  return { workflowId, revision: snapshot.revision, historicalOnly: true, totalTurns: snapshot.turns.length, matchingTurns: turns.length,
    turns: selected.map(turn => ({ id: turn.id, historicalStatus: turn.originalStatus || turn.status,
      messages: ['user', 'assistant'].map(role => ({ role, text: bounded(turn[role]?.text, maxText),
        truncated: (turn[role]?.text?.length || 0) > maxText })).filter(item => item.text) })),
    nextBeforeTurnId: turns.length > selected.length ? selected[0].id : null, hasMore: turns.length > selected.length };
}
