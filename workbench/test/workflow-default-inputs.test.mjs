import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode, connectNodes, validateDocument, updateNode } from '../shared/workflow/workflow-model.mjs';
import { planWorkflow } from '../shared/workflow/workflow-plan.mjs';
import { validateWorkflowInput } from '../src/workflows/workflow-runs.mjs';
import { workflowInputDefault, workflowInputValue } from '../shared/workflow/workflow-inputs.mjs';
import { WorkflowRuntimeUI } from '../public/workflow-runtime-ui.js';
import { structuredInput, valuesFromInput } from '../shared/workflow/workflow-studio-utils.mjs';

function graph(config = {}, schemaVersion = 2) {
  let document = createDocument({ schemaVersion, title: '固定任务' });
  document.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: 'text', fieldName: 'requirements', ...config } }),
    createNode('tool', { x: 300, y: 0 }, { id: 'echo', config: { inputType: 'text', outputType: 'text', executionMode: 'tool', toolName: 'text.trim' } }),
    createNode('output', { x: 600, y: 0 }, { id: 'output' })];
  for (let index = 1; index < document.nodes.length; index++) document = connectNodes(document, { sourceNode: document.nodes[index - 1].id, sourcePort: 'out', targetNode: document.nodes[index].id, targetPort: 'in' });
  return document;
}

test('saved fixed task requirements run without repeated form input and retain legacy value', () => {
  for (const config of [{ defaultValue: '获取今日热榜' }, { value: '获取今日热榜' }]) {
    const document = graph(config), entry = document.nodes[0];
    const runtime = { currentDocument: () => document, input: { value: '' } };
    assert.equal(WorkflowRuntimeUI.prototype.parseInput.call(runtime, entry), '获取今日热榜');
    assert.equal(workflowInputValue(document, undefined, entry), '获取今日热榜');
    assert.equal(validateWorkflowInput(undefined, planWorkflow(document)), '获取今日热榜');
    assert.equal(validateWorkflowInput('本次改为周榜', planWorkflow(document)), '本次改为周榜');
  }
});

test('fixed defaults preserve explicit false, zero and null and are bounded JSON data', () => {
  for (const value of [false, 0, null]) {
    const document = graph({ outputType: 'any', required: false, defaultValue: true });
    assert.equal(workflowInputValue(document, value, document.nodes[0]), value);
    assert.equal(validateWorkflowInput(value, planWorkflow(document)), value);
  }
  const document = graph({ defaultValue: '新版默认', value: '旧版默认' });
  assert.equal(workflowInputValue(document, '', document.nodes[0]), '新版默认');
  const structured = createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: 'object', defaultValue: { query: 'trending', count: 20 } } });
  const value = workflowInputValue({ nodes: [structured] }, undefined, structured);
  value.count = 0;
  assert.equal(structured.config.defaultValue.count, 20, 'admitted defaults cannot mutate the workflow snapshot');
  for (const defaultValue of [() => {}, Infinity, 'x'.repeat(65537), { get value() { throw Error('must not access'); } }]) {
    assert.throws(() => validateDocument({ ...document, nodes: [{ ...document.nodes[0], config: { ...document.nodes[0].config, defaultValue } }, ...document.nodes.slice(1)] }));
  }
});

test('required variable tasks still ask for missing input', () => {
  const document = graph();
  assert.throws(() => WorkflowRuntimeUI.prototype.parseInput.call({ currentDocument: () => document, input: { value: '' } }, document.nodes[0]), /请输入本次运行的数据/);
  assert.throws(() => validateWorkflowInput(undefined, planWorkflow(document)), /输入/);
});

test('an explicitly cleared default suppresses legacy instructions while falsey JSON defaults remain valid', () => {
  for (const defaultValue of ['', '  ']) {
    const document = graph({ defaultValue, value: '旧任务不能恢复' });
    assert.equal(workflowInputDefault(document.nodes[0]), undefined);
    assert.throws(() => validateWorkflowInput(undefined, planWorkflow(document)), /输入/);
  }
  for (const defaultValue of [false, 0, null]) {
    const document = graph({ outputType: 'any', required: false, defaultValue });
    assert.equal(workflowInputDefault(document.nodes[0]), defaultValue);
    assert.equal(workflowInputValue(document, undefined, document.nodes[0]), defaultValue);
  }
});

test('version one tasks use the same saved default and explicit input precedence', () => {
  const document = graph({ defaultValue: '固定任务' }, 1), plan = planWorkflow(document);
  assert.equal(validateWorkflowInput(undefined, plan), '固定任务');
  assert.equal(validateWorkflowInput('本次任务', plan), '本次任务');
});

test('editing an existing input can save its fixed task default without recreating nodes', () => {
  const document = graph();
  const updated = updateNode(document, 'input', { config: { defaultValue: '固定任务' } });
  assert.equal(validateWorkflowInput(undefined, planWorkflow(updated)), '固定任务');
  assert.deepEqual(updated.edges, document.edges);
  assert.throws(() => updateNode(document, 'echo', { config: { defaultValue: 'unexpected' } }), /未知字段/);
});

function fieldDocument(count = 1) {
  const document = createDocument({ schemaVersion: 2 });
  document.nodes = Array.from({ length: count }, (_, index) => createNode('input', { x: 0, y: 0 }, { id: `input-${index}`, config: {
    outputType: 'object', fieldName: `source${index}`, defaultValue: { query: 'trending', limit: 20, note: '默认说明' },
    fields: [{ key: 'query', label: '检索条件', kind: 'text' }, { key: 'limit', label: '数量', kind: 'number' }, { key: 'note', label: '备注', kind: 'text', required: false }],
  } }));
  return document;
}

test('structured defaults fill missing fields across single and multiple entries while explicit values win', () => {
  for (const count of [1, 2]) {
    const document = fieldDocument(count), empty = structuredInput(document, {});
    const expected = { query: 'trending', limit: 20, note: '默认说明' };
    assert.deepEqual(empty, count === 1 ? expected : { source0: expected, source1: expected });
    const values = { 'input-0': { query: '', limit: 0, note: null, explicitFalse: false } };
    const input = structuredInput(document, values), first = workflowInputValue(document, input, document.nodes[0]);
    assert.deepEqual(first, { query: 'trending', limit: 0, note: null, explicitFalse: false });
    assert.deepEqual(values['input-0'], { query: '', limit: 0, note: null, explicitFalse: false });
    assert.deepEqual(valuesFromInput(document, input)['input-0'], first);
  }
});

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); }
  async stop() {}
  async request() { throw Error('No model execution is allowed in this fixture'); }
}

test('fixed defaults flow through preflight, execution and a frozen schedule snapshot', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-default-input-'));
  const app = new Application(readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), new Offline());
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const document = graph({ defaultValue: '  今日热榜  ' });
  const prepared = await app.workflowFiles.preflight({ document });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.errors));
  assert.deepEqual(prepared.input, { requirements: '  今日热榜  ' });
  const started = await app.workflows.start({ document });
  let run = started;
  for (let index = 0; index < 200 && !['complete', 'error'].includes(run.status); index++) {
    await new Promise(resolve => setTimeout(resolve, 5)); run = app.workflows.get(started.id);
  }
  assert.equal(run.status, 'complete', run.error);
  assert.equal(run.output, '今日热榜');
  const schedule = app.schedules.create({ name: '固定任务', document, timing: { kind: 'daily', time: '09:00', timezone: 'Asia/Shanghai' } });
  assert.equal(schedule.input, '  今日热榜  ');
  document.nodes[0].config.defaultValue = 'later';
  assert.equal(app.schedules.get(schedule.id).input, '  今日热榜  ');
  for (const count of [1, 2]) {
    const fields = fieldDocument(count);
    const input = structuredInput(fields, { 'input-0': { limit: 0 } });
    const fromForm = await app.workflowFiles.preflight({ document: fields, input });
    assert.equal(fromForm.ok, true, JSON.stringify(fromForm.errors));
    assert.equal(fromForm.input.source0.query, 'trending');
    assert.equal(fromForm.input.source0.limit, 0);
    if (count === 2) assert.equal(fromForm.input.source1.limit, 20);
  }
});
