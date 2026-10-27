import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { ApplicationAssistant } from '../src/application-assistant.mjs';
import { DEFAULT_ASSISTANT_PERMISSIONS } from '../src/application-assistant-permissions.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture(t, replies, options) {
  const app = new EventEmitter(), prompts = [], reads = [];
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'assistant-efficiency-permissions-'));
  app.config = { workspaceRoot }; app.preferences = { defaultWorkspace: '.' };
  app.assistantPermissionSettings = { get: () => ({ revision: 1, ...structuredClone(DEFAULT_ASSISTANT_PERMISSIONS) }) };
  app.workflows = { get: id => ({ id, workflowId: 'wf' }) };
  app.workflowLibrary = { get: id => ({ id, revision: 1, document: { id, schemaVersion: 2, nodes: [], edges: [], settings: { outputDirectory: '' } } }) };
  app.store = { db: new DatabaseSync(':memory:') }; app.publish = () => {};
  app.diagnostics = {
    tools: () => [{ name: 'workflow.run', description: '读取运行', inputSchema: { properties: { runId: {}, nodeId: {} } } }],
    snapshot: async () => ({ run: { id: 'old', status: 'error', completedAt: '2026-01-01' }, latestRun: { id: 'latest', status: 'error' } }),
    read: async (tool, args) => { reads.push({ tool, args }); return { id: args.runId, status: 'error', error: 'FETCH_FAILED', nodes: [] }; },
  };
  app.captureModelRoute = async () => ({ model: 'fixture', provider: 'fixture' });
  app.assistantModel = { generate: async (prompt, opts) => { prompts.push(prompt); return JSON.stringify(await replies.shift()(opts)); } };
  const assistant = new ApplicationAssistant(app, options);
  t.after(async () => { await assistant.close(); app.store.db.close(); rmSync(workspaceRoot, { recursive: true, force: true }); });
  return { app, assistant, prompts, reads };
}

test('one bounded read batch avoids separate model decisions and deduplicates normalized requests', async t => {
  const f = fixture(t, [() => ({ tools: [
    { tool: 'workflow.run', arguments: { runId: 'latest', nodeId: 'node' } },
    { tool: 'workflow.run', arguments: { nodeId: 'node', runId: 'latest' } },
  ] }), () => ({ text: '采集失败。' })]);
  const result = await f.assistant.plan({ text: '检查失败', context: { workflowId: 'wf' } });
  assert.equal(f.reads.length, 1); assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[1], /FETCH_FAILED/); assert.equal(result.evidence[1].cached, true);
});

test('a mixed batch is rejected before any read or proposal executes', async t => {
  const f = fixture(t, [() => ({ tools: [
    { tool: 'workflow.run', arguments: { runId: 'latest' } },
    { tool: 'workflow.propose', arguments: { request: '改节点' } },
  ] }), () => ({ text: '已停止无效批次。' })]);
  await f.assistant.plan({ text: '检查失败' });
  assert.equal(f.reads.length, 0); assert.match(f.prompts[1], /批量/);
});

test('a model failure retains completed diagnostics and continuation reuses fresh scoped reads', async t => {
  const timeout = Object.assign(new Error('模型超时'), { code: 'MODEL_TIMEOUT', phase: 'model-response' });
  const f = fixture(t, [() => ({ tool: 'workflow.run', arguments: { runId: 'latest' } }), () => { throw timeout; }]);
  let checkpoint;
  await assert.rejects(f.assistant.plan({ text: '检查失败', context: { workflowId: 'wf' }, onCheckpoint: value => { checkpoint = value; } }), /模型超时/);
  assert.equal(checkpoint.evidence[0].tool, 'workflow.run');
  assert.equal(checkpoint.steps.at(-1).status, 'error');
  f.app.assistantModel.generate = async prompt => {
    f.prompts.push(prompt);
    return f.prompts.length === 3 ? JSON.stringify({ tool: 'workflow.run', arguments: { runId: 'latest' } }) : JSON.stringify({ text: '继续沿用已查证据。' });
  };
  const result = await f.assistant.plan({ text: '继续检查', context: { workflowId: 'wf' }, checkpoint });
  assert.equal(f.reads.length, 1); assert.ok(result.evidence.some(row => row.cached));
  assert.match(f.prompts[2], /FETCH_FAILED/);
});

test('proposal timeout ends the turn instead of starting another outer model decision', async t => {
  const f = fixture(t, [() => ({ tool: 'workflow.propose', arguments: { workflowId: 'wf', request: '修复节点' } }), () => ({ text: '不应到达' })]);
  f.assistant.call = async () => { throw Object.assign(new Error('提案生成超时'), { code: 'MODEL_TIMEOUT' }); };
  let checkpoint;
  await assert.rejects(f.assistant.plan({ text: '修复', onCheckpoint: value => { checkpoint = value; } }), /提案生成超时/);
  assert.equal(f.prompts.length, 1); assert.equal(checkpoint.steps.at(-1).status, 'error');
});

test('initial context omits repeated long code and logs with explicit on-demand markers', async t => {
  const f = fixture(t, [() => ({ text: '先检查状态。' })]);
  const doc = { id: 'wf', nodes: [{ id: 'code', type: 'tool', config: { code: 'PRIVATE_LONG_CODE_'.repeat(2000) } }], edges: [] };
  f.app.diagnostics.snapshot = async () => ({ workflow: { document: doc }, run: { id: 'run', document: doc, outputText: 'LONG_OUTPUT_'.repeat(3000), nodes: [{ id: 'code', error: 'FETCH_FAILED', logs: { stderr: 'LONG_LOG_'.repeat(3000) } }] } });
  await f.assistant.plan({ text: '为什么失败', document: doc });
  assert.ok(f.prompts[0].length < 18000, f.prompts[0].length);
  assert.equal(f.prompts[0].includes('PRIVATE_LONG_CODE_'), false);
  assert.match(f.prompts[0], /FETCH_FAILED/); assert.match(f.prompts[0], /按需|省略/);
});

test('whole-turn deadline stops an unresponsive model without starting a late tool', async t => {
  const f = fixture(t, [() => new Promise(() => {})], { maxDurationMs: 25 });
  let checkpoint;
  await assert.rejects(f.assistant.plan({ text: '检查', onCheckpoint: value => { checkpoint = value; } }), /总等待|整轮/);
  assert.equal(f.reads.length, 0); assert.equal(checkpoint.steps.at(-1).status, 'error');
});

test('stale, changed-scope and active-run checkpoints are not reused', async t => {
  for (const reason of ['expired', 'selection', 'active', 'route', 'contract']) {
    const f = fixture(t, [() => ({ tool: 'workflow.run', arguments: { runId: 'latest' } }), () => { throw new Error('fixture timeout'); }]);
    let checkpoint;
    await assert.rejects(f.assistant.plan({ text: '检查失败', context: { workflowId: 'wf' }, onCheckpoint: value => { checkpoint = value; } }));
    if (reason === 'expired') checkpoint.results.forEach(row => { row.collectedAt = '2020-01-01T00:00:00Z'; });
    if (reason === 'active') f.app.diagnostics.snapshot = async () => ({ run: { id: 'old', status: 'running' }, latestRun: { id: 'latest', status: 'running' } });
    if (reason === 'route') f.app.captureModelRoute = async () => ({ model: 'changed', provider: 'fixture' });
    if (reason === 'contract') f.app.diagnostics.tools = () => [{ name: 'workflow.run', description: '新的工具契约', inputSchema: { properties: { runId: {} } } }];
    let calls = 0;
    f.app.assistantModel.generate = async () => JSON.stringify(calls++ === 0 ? { tool: 'workflow.run', arguments: { runId: 'latest' } } : { text: '已重新读取。' });
    await f.assistant.plan({ text: '继续检查', context: { workflowId: reason === 'selection' ? 'different' : 'wf' }, checkpoint });
    assert.equal(f.reads.length, 2, reason);
  }
});

test('an on-demand graph read exposes bounded code and marks truncation instead of hiding it again', async t => {
  const f = fixture(t, [() => ({ tool: 'workflow.run', arguments: { runId: 'latest' } }), () => ({ text: '已看代码。' })]);
  f.app.diagnostics.read = async () => ({ document: { nodes: [{ config: { code: 'return input;'.repeat(500) } }] }, entries: Array.from({ length: 50 }, (_, id) => ({ id })) });
  await f.assistant.plan({ text: '检查代码' });
  assert.match(f.prompts[1], /return input;/); assert.match(f.prompts[1], /已截断/); assert.match(f.prompts[1], /其余条目已省略/);
});
