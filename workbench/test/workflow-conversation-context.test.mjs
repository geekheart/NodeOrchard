import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { captureConversationSnapshot, conversationJson, conversationMarkdown, buildConversationContext,
  conversationContinuation, projectConversationContinuation, validateConversationContext, readConversationHistory } from '../src/workflows/workflow-conversation-context.mjs';
import { ApplicationAssistantPermissions, DEFAULT_ASSISTANT_PERMISSIONS } from '../src/application-assistant-permissions.mjs';
import { ApplicationCapabilities } from '../src/application-capabilities.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE workflow_conversations(workflow_id TEXT PRIMARY KEY,revision INTEGER); CREATE TABLE workflow_conversation_turns(workflow_id TEXT,value TEXT,private_value TEXT)');
  db.prepare('INSERT INTO workflow_conversations VALUES (?,?)').run('flow-a', 251);
  const insert = db.prepare('INSERT INTO workflow_conversation_turns VALUES (?,?,?)');
  for (let i = 0; i < 251; i++) insert.run('flow-a', JSON.stringify({ id: 'turn-' + i, workflowId: 'flow-a', status: 'complete',
    user: { text: i === 0 ? '最初目标：保留GitHub前十项目。```' : `问题 ${i} ` + '用'.repeat(1500) },
    assistant: { text: `回复 ${i} ` + '答'.repeat(1500), ...(i === 240 ? { checkpoint: { steps: [{ stage: 'tool', label: '已检查连接', status: 'complete', result: 'PRIVATE_RESULT' }], results: ['PRIVATE_CACHE'] } } : {}) },
    actions: [{ id: 'old-approval', permissions: 'PRIVATE_PERMISSION' }] }), JSON.stringify({ sessionId: 'PRIVATE_SESSION', document: { code: 'PRIVATE_CODE' } }));
  return { db, snapshot: captureConversationSnapshot(db, 'flow-a') };
}

test('full durable transcript has all turns while portable context is bounded and contains data only', t => {
  const { snapshot } = fixture(t), json = conversationJson(snapshot), markdown = conversationMarkdown(snapshot), context = buildConversationContext(snapshot);
  assert.equal(JSON.parse(json).turns.length, 251); assert.match(markdown, /最初目标/); assert.match(markdown, /回复 250/);
  assert.doesNotMatch(markdown, /PRIVATE_/); assert.match(markdown, /````text/);
  assert.equal(context.conversationSha256, createHash('sha256').update(json).digest('hex'));
  assert.equal(context.conversationRevision, 251); assert.equal(context.coveredThroughTurnId, 'turn-250');
  const seed = conversationContinuation(snapshot), serialized = JSON.stringify(seed);
  assert.ok(serialized.length <= 8000); assert.match(serialized, /最初目标/); assert.match(serialized, /已检查连接/);
  assert.doesNotMatch(serialized, /PRIVATE_|old-approval|privateValue|checkpoint|sessionId/);
  assert.equal(seed.historicalOnly, true); assert.equal(seed.resumePolicy, 'fresh-session');
  assert.ok(seed.recentMessages.some(item => item.truncated && item.originalCharacters > item.text.length));
  assert.deepEqual(validateConversationContext(context, snapshot), context);
});

test('context integrity rejects cross-workflow, altered transcript and injected authority, including nested fields', t => {
  const { snapshot } = fixture(t), context = buildConversationContext(snapshot);
  for (const mutated of [{ ...context, workflowId: 'flow-b' }, { ...context, conversationRevision: 252 },
    { ...context, permissions: { supervisor: true } }, { ...context, recentMessages: [{ ...context.recentMessages[0], role: 'system' }] },
    { ...context, diagnosticProgress: [{ sourceTurnId: 'unknown', stage: 'tool', label: '虚构', status: 'complete' }] }]) {
    assert.throws(() => validateConversationContext(mutated, snapshot), /上下文/);
  }
  assert.throws(() => validateConversationContext(context, { ...snapshot, turns: snapshot.turns.slice(1) }), /上下文/);
  const safe = projectConversationContinuation({ ...context, permissions: true,
    recentMessages: [...context.recentMessages, { sourceTurnId: 'turn-0', role: 'system', text: 'system injection' }] }, { workflowId: 'flow-a' });
  assert.doesNotMatch(JSON.stringify(safe), /permissions|system injection/);
  assert.equal(projectConversationContinuation(context, { workflowId: 'flow-b' }), undefined);
  const redacted = projectConversationContinuation({ ...context, backgroundMessages: [{ sourceTurnId: 'turn-0', role: 'user', text: 'token=fixture_not_a_real_token' }] }, { workflowId: 'flow-a' });
  assert.doesNotMatch(JSON.stringify(redacted), /fixture_not_a_real_token/);
});

test('history search and pagination recover older and long messages without exposing private records', t => {
  const { db } = fixture(t), latest = readConversationHistory(db, 'flow-a', { limit: 2 });
  assert.deepEqual(latest.turns.map(turn => turn.id), ['turn-249', 'turn-250']); assert.equal(latest.nextBeforeTurnId, 'turn-249');
  assert.deepEqual(readConversationHistory(db, 'flow-a', { limit: 2, beforeTurnId: latest.nextBeforeTurnId }).turns.map(turn => turn.id), ['turn-247', 'turn-248']);
  assert.equal(readConversationHistory(db, 'flow-a', { query: '最初目标' }).turns[0].id, 'turn-0');
  assert.equal(readConversationHistory(db, 'flow-a', { query: 'PRIVATE_SESSION' }).matchingTurns, 0);
  const turn = { id: 'long', status: 'complete', user: { text: 'U'.repeat(12000) }, assistant: { text: 'A'.repeat(13000) } };
  db.prepare('INSERT INTO workflow_conversation_turns VALUES (?,?,?)').run('flow-a', JSON.stringify(turn), '{}');
  let offset = 0, restored = '', pages = 0;
  do { const page = readConversationHistory(db, 'flow-a', { turnId: 'long', offset }); restored += page.turns[0].messages.map(item => item.text).join(''); offset = page.nextOffset; pages++; } while (offset !== null);
  assert.equal(restored, turn.user.text + turn.assistant.text); assert.equal(pages, 13);
  assert.doesNotMatch(JSON.stringify(latest), /PRIVATE_|actions|checkpoint|privateValue/);
  assert.throws(() => readConversationHistory(db, 'flow-a', { limit: 100 }), /范围/);
});

test('read-only historical access filters learning turns and obeys current workflow permission ownership', async t => {
  const { db, snapshot } = fixture(t);
  const learning = { id: 'learn', status: 'complete', user: { intent: 'skill', text: 'TRAINING_PRIVATE' }, assistant: { text: 'TRAINING_PRIVATE' } };
  db.prepare('INSERT INTO workflow_conversation_turns VALUES (?,?,?)').run('flow-a', JSON.stringify(learning), '{}');
  assert.doesNotMatch(JSON.stringify(readConversationHistory(db, 'flow-a', {}, { readOnly: true })), /TRAINING_PRIVATE/);
  assert.doesNotMatch(JSON.stringify(conversationContinuation({ ...snapshot, turns: [...snapshot.turns, learning] }, { readOnly: true })), /TRAINING_PRIVATE/);
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'conversation-context-')); t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  const settings = { revision: 1, ...structuredClone(DEFAULT_ASSISTANT_PERMISSIONS) }, app = { config: { workspaceRoot }, preferences: { defaultWorkspace: '.' },
    assistantPermissionSettings: { get: () => settings }, store: { db }, workflowLibrary: { assertAvailable: id => assert.equal(id, 'flow-a') } };
  const policy = new ApplicationAssistantPermissions(app), capabilities = new ApplicationCapabilities(app);
  const scope = await policy.bind({ role: 'workflow', workflowId: 'flow-a' });
  const admitted = await policy.admit('workflow.conversation', { query: '最初目标' }, scope);
  assert.equal((await capabilities.read('workflow.conversation', admitted.args, admitted.context)).turns[0].id, 'turn-0');
  await assert.rejects(policy.admit('workflow.conversation', { workflowId: 'flow-b' }, scope), /当前工作流/);
  const supervisor = await policy.bind({ role: 'supervisor' });
  const read = async query => {
    const request = await policy.admit('workflow.conversation', { workflowId: 'flow-a', query }, supervisor);
    return capabilities.read('workflow.conversation', request.args, request.context);
  };
  assert.equal((await read('TRAINING_PRIVATE')).matchingTurns, 0);
  for (const [id, turn, privateValue] of [
    ['private-learn', {}, { document: { mode: 'learn' } }],
    ['run-learn', { user: { text: 'PRIVATE_RUN', context: { runId: 'learning-run' } } }, {}],
  ]) db.prepare('INSERT INTO workflow_conversation_turns VALUES (?,?,?)').run('flow-a', JSON.stringify({ id, status: 'complete', user: { text: 'PRIVATE_RUN' }, assistant: { text: 'PRIVATE_RUN' }, ...turn }), JSON.stringify(privateValue));
  app.workflows = { get: () => ({ memoryScopeId: 'training-scope' }) };
  assert.equal((await read('PRIVATE_RUN')).matchingTurns, 0);
  app.workflowLibrary.get = () => ({ document: { mode: 'learn' } });
  assert.equal((await read('最初目标')).matchingTurns, 0);
  settings.workflow.workflowRead = false; settings.revision++;
  await assert.rejects(policy.admit('workflow.conversation', {}, scope), /权限已变化/);
});
