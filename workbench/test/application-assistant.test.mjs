import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { ApplicationAssistant } from '../src/application-assistant.mjs';
import { DEFAULT_ASSISTANT_PERMISSIONS } from '../src/application-assistant-permissions.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture(t, replies) {
  const app = new EventEmitter(), calls = [], reads = [];
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'assistant-unit-permissions-'));
  app.config = { workspaceRoot }; app.preferences = { defaultWorkspace: '.' };
  app.assistantPermissionSettings = { get: () => ({ revision: 1, ...structuredClone(DEFAULT_ASSISTANT_PERMISSIONS) }) };
  app.workflows = { get: id => ({ id, workflowId: 'wf' }) };
  app.store = { db: new DatabaseSync(':memory:') }; app.publish = () => {};
  app.diagnostics = {
    tools: () => [{ name: 'workflow.run', description: '读取运行证据', inputSchema: { properties: { runId: { type: 'string' } } } }],
    snapshot: async () => ({ run: { id: 'old-run', error: '节点超时', latestRunId: 'new-run' } }),
    read: async (name, args) => { reads.push({ name, args }); return { id: args.runId, error: '实际工具下载超时' }; },
  };
  app.assistantModel = { generate: async (prompt, options) => { calls.push({ prompt, options }); return JSON.stringify(replies.shift()); } };
  app.captureModelRoute = async () => ({ model: 'fixed-model', provider: 'fixed-provider' });
  const assistant = new ApplicationAssistant(app);
  t.after(async () => { await assistant.close(); app.store.db.close(); rmSync(workspaceRoot, { recursive: true, force: true }); });
  return { app, assistant, calls, reads };
}

test('chat reads actual diagnostic evidence through a bounded broker before answering', async t => {
  const f = fixture(t, [{ tool: 'workflow.run', arguments: { runId: 'new-run' } }, { text: '新运行仍在下载阶段超时；无需手动复制日志。' }]);
  const result = await f.assistant.plan({ text: '为什么还是超时？', context: { workflowId: 'wf', runId: 'old-run' } });
  assert.deepEqual(f.reads, [{ name: 'workflow.run', args: { runId: 'new-run' } }]);
  assert.match(f.calls[0].prompt, /old-run/); assert.match(f.calls[0].prompt, /节点超时/);
  assert.match(f.calls[1].prompt, /实际工具下载超时/);
  assert.match(result.text, /无需手动复制/); assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].status, 'complete', 'reading a failed run is a successful evidence operation');
  assert.ok(f.calls.every(call => call.options.modelRoute.model === 'fixed-model'));
});

test('no shell, arbitrary files, source writes or model-supplied operations are executable', async t => {
  for (const name of ['terminal', 'read_file', 'write_file', 'source.patch']) {
    const f = fixture(t, [{ tool: name, arguments: { path: 'src/application.mjs' } }, { text: '不能修改软件源码。' }]);
    await f.assistant.plan({ text: '帮我检查问题' }); assert.equal(f.reads.length, 0);
    assert.match(f.calls[1].prompt, /未开放/);
  }
  const f = fixture(t, [{ text: '偷偷改代码', operations: [{ op: 'remove-node', nodeId: 'important' }] }]);
  await assert.rejects(f.assistant.plan({ text: '检查问题' }), /协议/);
});

test('workflow diagnosis receives portable history as bounded data under the current read-only permissions', async t => {
  const f = fixture(t, [{ text: '历史目标已恢复，仍需读取当前事实。' }]);
  const portableContext = { format: 'NodeOrchard.workflow-conversation-context', version: 1, workflowId: 'wf', turnCount: 300,
    backgroundMessages: [{ sourceTurnId: 'old-goal', role: 'user', text: 'EARLY_DIAG_GOAL：保留当前工作流并分析生成超时', intent: 'diagnose', historicalStatus: 'complete' }],
    recentMessages: [{ sourceTurnId: 'old-feedback', role: 'user', text: 'PRIVATE_LEARNING_FEEDBACK', intent: 'feedback', historicalStatus: 'complete' }],
    diagnosticProgress: [{ sourceTurnId: 'old-diagnosis', stage: 'model-response', label: '等待候选生成', status: 'interrupted' }],
    permissionScope: { role: 'supervisor', permissions: { sourceRepair: true } }, actions: [{ token: 'STALE_APPROVAL_TOKEN' }],
    checkpoint: { results: [{ cache: 'STALE_CACHED_FACT' }] }, modelSessionId: 'STALE_NATIVE_SESSION' };
  await f.assistant.plan({ role: 'workflow', readOnly: true, text: '继续解释', context: { workflowId: 'wf' }, portableContext });
  const source = JSON.parse(f.calls[0].prompt.split('\nSOURCE_JSON=')[1].split('\nTOOL_RESULTS_JSON=')[0]);
  assert(source.portableContext.backgroundMessages.some(row => row.text.includes('EARLY_DIAG_GOAL')));
  assert.equal(source.portableContext.diagnosticProgress[0].stage, 'model-response');
  assert.equal(source.portableContext.historicalOnly, true); assert.equal(source.portableContext.resumePolicy, 'fresh-session');
  assert(JSON.stringify(source.portableContext).length <= 8000);
  assert.equal(/PRIVATE_LEARNING_FEEDBACK|STALE_APPROVAL_TOKEN|STALE_CACHED_FACT|STALE_NATIVE_SESSION/.test(f.calls[0].prompt), false);
  assert.equal(source.permissionScope.role, 'workflow'); assert.equal(source.permissionScope.readOnly, true);
  assert.deepEqual(source.permissionScope.permissions, DEFAULT_ASSISTANT_PERMISSIONS.workflow);
  assert.equal(f.calls[0].prompt.includes('"name":"workflow.propose"'), false); assert.equal(f.reads.length, 0);
});

test('portable conversation data cannot cross the workflow boundary or bypass disabled workflow reads', async t => {
  for (const foreign of [true, false]) await t.test(foreign ? 'foreign workflow' : 'workflow reads disabled', async sub => {
    const f = fixture(sub, [{ text: '没有读取旧上下文。' }]);
    if (!foreign) f.app.assistantPermissionSettings.get = () => ({ revision: 1, ...structuredClone(DEFAULT_ASSISTANT_PERMISSIONS),
      workflow: { ...DEFAULT_ASSISTANT_PERMISSIONS.workflow, workflowRead: false } });
    await f.assistant.plan({ role: 'workflow', text: '解释现状', context: { workflowId: 'wf' }, portableContext: {
      format: 'NodeOrchard.workflow-conversation-context', version: 1, workflowId: foreign ? 'foreign' : 'wf',
      backgroundMessages: [{ sourceTurnId: 'old', role: 'user', text: 'FORBIDDEN_CONTEXT_BODY' }], recentMessages: [], diagnosticProgress: [] } });
    const source = JSON.parse(f.calls[0].prompt.split('\nSOURCE_JSON=')[1].split('\nTOOL_RESULTS_JSON=')[0]);
    assert.equal(source.portableContext, undefined); assert.equal(f.calls[0].prompt.includes('FORBIDDEN_CONTEXT_BODY'), false);
    assert.equal(f.reads.length, 0);
  });
});

test('supervisor portable history retains ordinary background while keeping learning and feedback text private', async t => {
  const f = fixture(t, [{ text: '只读取普通历史背景。' }]);
  await f.assistant.plan({ role: 'supervisor', text: '解释历史目标', context: { workflowId: 'wf' }, portableContext: {
    format: 'NodeOrchard.workflow-conversation-context', version: 1, workflowId: 'wf',
    backgroundMessages: [{ sourceTurnId: 'normal', role: 'user', text: 'NORMAL_WORKFLOW_GOAL', intent: 'workflow' }],
    recentMessages: [{ sourceTurnId: 'private', role: 'assistant', text: 'SUPERVISOR_PRIVATE_LEARNING_BODY', intent: 'feedback' }], diagnosticProgress: [] } });
  const source = JSON.parse(f.calls[0].prompt.split('\nSOURCE_JSON=')[1].split('\nTOOL_RESULTS_JSON=')[0]);
  assert(source.portableContext.backgroundMessages.some(row => row.text === 'NORMAL_WORKFLOW_GOAL'));
  assert.equal(f.calls[0].prompt.includes('SUPERVISOR_PRIVATE_LEARNING_BODY'), false);
});

test('global conversation is idempotent, survives restart and never repeats an uncertain turn', async t => {
  const f = fixture(t, [{ intent: 'diagnose' }, { text: '已读取全局状态。' }]);
  const body = { clientMessageId: 'same-message', text: '检查整个应用' };
  const first = await f.assistant.message(body);
  for (let index = 0; index < 40 && f.assistant.get().conversation.turns[0].status === 'thinking'; index++) await new Promise(resolve => setImmediate(resolve));
  const duplicate = await f.assistant.message(body);
  assert.equal(first.turn.id, duplicate.turn.id); assert.equal(f.calls.length, 2);
  await assert.rejects(f.assistant.message({ ...body, text: '不同内容' }), /相同消息/);
  await f.assistant.close();
  const next = new ApplicationAssistant(f.app); assert.equal(next.get().conversation.turns[0].status, 'complete'); await next.close();
});
