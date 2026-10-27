import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { ApplicationAssistant } from '../src/application-assistant.mjs';

function fixture(t, replies, options = {}) {
  const app = new EventEmitter(), reads = [], prompts = [];
  app.store = { db: new DatabaseSync(':memory:') }; app.publish = () => {};
  app.diagnostics = {
    tools: () => [{ name: 'workflow.run', description: '读取运行', inputSchema: { type: 'object', properties: { runId: { type: 'string', maxLength: 128 } }, additionalProperties: false } }],
    snapshot: async () => ({}), read: async (tool, args) => { reads.push({ tool, args }); return { id: args.runId }; },
  };
  app.assistantModel = { generate: async prompt => { prompts.push(prompt); return JSON.stringify(replies.shift()); } };
  const assistant = new ApplicationAssistant(app, options);
  t.after(async () => { await assistant.close(); app.store.db.close(); });
  return { app, assistant, reads, prompts };
}

test('batch admission validates every argument before the first read', async t => {
  for (const invalid of [
    { tool: 'workflow.run', arguments: { runId: { injected: true } } },
    { tool: 'workflow.run', arguments: null },
    { tool: 'workflow.run', arguments: { runId: 'x'.repeat(129) } },
    { tool: 'runtime.inspect', arguments: { language: 'ruby' } },
    { tool: 'runtime.inspect', arguments: { language: 'python', modules: ['valid', '../invalid'] } },
  ]) {
    await t.test(JSON.stringify(invalid), async sub => {
      const f = fixture(sub, [{ tools: [{ tool: 'workflow.run', arguments: { runId: 'valid' } }, invalid] }, { text: '已拒绝无效请求。' }]);
      await f.assistant.plan({ text: '检查' }); assert.equal(f.reads.length, 0);
      assert.match(f.prompts[1], /schema|协议/);
    });
  }
});

test('non-object model replies and mixed protocol fields fail without a read', async t => {
  for (const reply of [null, [], 1, { text: 1 }, { text: '答复', tool: 'workflow.run' }, { tools: [], operations: [] }]) {
    const f = fixture(t, [reply]);
    await assert.rejects(f.assistant.plan({ text: '检查' }), /协议/);
    assert.equal(f.reads.length, 0);
  }
});

test('a repeated failing read is not issued again in the same turn', async t => {
  const f = fixture(t, [
    { tool: 'workflow.run', arguments: { runId: 'invalid' } },
    { tool: 'workflow.run', arguments: { runId: 'invalid' } },
    { text: '该运行不可读取。' },
  ]);
  f.app.diagnostics.read = async () => { f.reads.push('attempt'); throw new Error('运行不存在'); };
  const result = await f.assistant.plan({ text: '检查' });
  assert.equal(f.reads.length, 1); assert.equal(result.evidence[1].cached, true);
  assert.match(f.prompts[2], /运行不存在/);
});

test('a late model reply after the whole-turn deadline cannot start a tool or update progress', async t => {
  const f = fixture(t, [], { maxDurationMs: 25 }), phases = [];
  let reply, modelProgress;
  f.app.assistantModel.generate = (prompt, options) => {
    modelProgress = options.onProgress;
    return new Promise(resolve => { reply = resolve; });
  };
  await assert.rejects(f.assistant.plan({ text: '检查', onProgress: label => phases.push(label) }), /总等待/);
  const count = phases.length;
  modelProgress({ stage: 'model-output', label: '不应显示' });
  reply(JSON.stringify({ tool: 'workflow.run', arguments: { runId: 'late' } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.reads.length, 0); assert.equal(phases.length, count);
});

test('the whole-turn deadline includes initial evidence collection', async t => {
  const f = fixture(t, [], { maxDurationMs: 25 }); let checkpoint;
  f.app.diagnostics.snapshot = async () => new Promise(() => {});
  await assert.rejects(f.assistant.plan({ text: '检查', onCheckpoint: value => { checkpoint = value; } }), /总等待/);
  assert.equal(f.prompts.length, 0); assert.equal(checkpoint.steps.at(-1).stage, 'snapshot');
  assert.equal(checkpoint.steps.at(-1).status, 'error');
});

test('proposal model calls contribute to the persisted model count', async t => {
  const f = fixture(t, [{ tool: 'workflow.propose', arguments: { workflowId: 'wf', request: '修改' } }]);
  f.assistant.call = async (tool, args, context) => {
    context.onProgress({ stage: 'generate-proposal', label: '生成候选', modelCall: true });
    context.onProgress({ stage: 'read-result', label: '确认结果' });
    return { proposal: { text: '无需更改', operations: [] } };
  };
  const result = await f.assistant.plan({ text: '修改' });
  assert.equal(result.progress.modelCalls, 2); assert.equal(result.progress.status, 'complete');
});
