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

test('global conversation is idempotent, survives restart and never repeats an uncertain turn', async t => {
  const f = fixture(t, [{ text: '已读取全局状态。' }]);
  const body = { clientMessageId: 'same-message', text: '检查整个应用' };
  const first = await f.assistant.message(body);
  for (let index = 0; index < 40 && f.assistant.get().conversation.turns[0].status === 'thinking'; index++) await new Promise(resolve => setImmediate(resolve));
  const duplicate = await f.assistant.message(body);
  assert.equal(first.turn.id, duplicate.turn.id); assert.equal(f.calls.length, 1);
  await assert.rejects(f.assistant.message({ ...body, text: '不同内容' }), /相同消息/);
  await f.assistant.close();
  const next = new ApplicationAssistant(f.app); assert.equal(next.get().conversation.turns[0].status, 'complete'); await next.close();
});
