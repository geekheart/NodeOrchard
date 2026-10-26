import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Application } from '../src/application.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

class DisconnectedAdapter extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.starts = 0; this.requests = []; }
  async start() { this.starts++; throw new Error('Schedule HTTP fixture must never start Hermes.'); }
  async request(method) { this.requests.push(method); throw new Error('Schedule HTTP fixture must never call Hermes.'); }
  async stop() {}
}

function localToolDocument({ title = '定时内置工具', inputType = 'text', toolName = 'text.trim', outputType = 'text' } = {}) {
  let document = createDocument({ title });
  document.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'entry', config: { outputType: inputType } }),
    createNode('tool', { x: 320, y: 0 }, { id: 'trim', config: {
      executionMode: 'tool', toolName, inputType, outputType,
    } }), createNode('output', { x: 640, y: 0 }, { id: 'exit' })];
  for (let index = 1; index < document.nodes.length; index++) document = connectNodes(document, {
    sourceNode: document.nodes[index - 1].id, sourcePort: 'out', targetNode: document.nodes[index].id, targetPort: 'in',
  });
  return document;
}

function once() { return { kind: 'once', localDateTime: '2099-12-20T14:30', timezone: 'Asia/Shanghai' }; }
function payload(document = localToolDocument(), overrides = {}) {
  return { name: '固定快照任务', document, input: '  scheduled input  ', timing: once(), enabled: true, ...overrides };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-schedules-http-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'),
    WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace'), WORKBENCH_HERMES_ROOT: join(directory, 'unused-hermes'),
    WORKBENCH_HERMES_HOME: join(directory, 'unused-home') }), port: 0 };
  const f = { config, directory, adapters: [] };
  f.open = async () => {
    const adapter = new DisconnectedAdapter(), app = new Application(config, adapter);
    const bridge = createWorkbenchServer(config, app); f.adapters.push(adapter);
    f.app = app; f.bridge = bridge; f.origin = await bridge.listen();
    const boot = await (await fetch(f.origin + '/api/bootstrap')).json(); f.csrfToken = boot.csrfToken;
  };
  f.close = async () => { if (f.bridge) { const bridge = f.bridge; f.bridge = null; await bridge.close(); } };
  f.restart = async () => { await f.close(); await f.open(); };
  f.request = async (path, { body, method = body === undefined ? 'GET' : 'POST', headers = {}, raw } = {}) => {
    const response = await fetch(f.origin + path, { method,
      headers: method === 'POST' ? { 'Content-Type': 'application/json', 'X-Workbench-Token': f.csrfToken, ...headers } : headers,
      ...(raw === undefined && body === undefined ? {} : { body: raw ?? JSON.stringify(body) }),
    });
    const result = await response.json();
    return { status: response.status, body: result, schedule: result.schedule, headers: response.headers };
  };
  f.api = (path, body, headers = {}) => f.request(path, { body, headers });
  t.after(async () => {
    try { await f.close(); }
    finally {
      try { for (const adapter of f.adapters) { assert.equal(adapter.starts, 0); assert.deepEqual(adapter.requests, []); } }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
  await f.open(); return f;
}

async function until(read, predicate, timeout = 4000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    last = await read(); if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected schedule HTTP state was not observed: ' + JSON.stringify(last));
}

test('schedule HTTP CRUD freezes snapshots without running Hermes or deleting existing workflow history', async t => {
  const f = await fixture(t), document = localToolDocument();
  const started = await f.api('/api/workflow-runs', { document, input: '  preserved result  ' });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const completed = (await until(() => f.api(`/api/workflow-runs/${started.body.id}`), value => value.body.status === 'complete')).body;
  assert.equal(completed.output, 'preserved result');
  const input = payload(document), snapshot = structuredClone(input);
  const created = await f.api('/api/workflow-schedules', input);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.schedule.id, /^[a-f0-9-]{36}$/);
  const id = created.schedule.id;
  assert.equal(created.schedule.workflowId, document.id); assert.equal(created.schedule.enabled, true);
  assert.deepEqual(created.schedule.document, snapshot.document); assert.equal(created.schedule.input, snapshot.input);
  input.document.title = '未提交的草稿'; input.document.nodes[1].config.toolName = 'text.uppercase'; input.input = 'changed local draft';
  const saved = await f.api(`/api/workflow-schedules/${id}`);
  assert.equal(saved.status, 200); assert.deepEqual(saved.schedule.document, snapshot.document); assert.equal(saved.schedule.input, snapshot.input);
  assert.deepEqual((await f.api(`/api/workflow-schedules?workflowId=${document.id}`)).body.schedules.map(item => item.id), [id]);
  assert.deepEqual((await f.api(`/api/workflow-schedules?workflowId=${randomUUID()}`)).body.schedules, []);
  assert.equal((await f.api(`/api/workflow-schedules/${id}/enabled`, { enabled: false })).schedule.enabled, false);
  assert.equal((await f.api(`/api/workflow-schedules/${id}/enabled`, { enabled: true })).schedule.enabled, true);
  const replacement = payload(localToolDocument({ title: '更新后的固定快照', toolName: 'text.uppercase' }), {
    name: '每日新快照', input: 'replacement', timing: { kind: 'daily', time: '18:45', timezone: 'Asia/Shanghai' }, enabled: false,
  });
  replacement.document.id = document.id;
  replacement.document.nodes[0].config.trigger = 'schedule';
  const updated = await f.api(`/api/workflow-schedules/${id}`, replacement);
  assert.equal(updated.status, 200, JSON.stringify(updated.body)); assert.equal(updated.schedule.id, id);
  assert.equal(updated.schedule.name, replacement.name); assert.equal(updated.schedule.enabled, false);
  assert.deepEqual(updated.schedule.document, replacement.document); assert.equal(updated.schedule.input, 'replacement');
  assert.deepEqual(updated.schedule.timing, replacement.timing);
  assert.equal((await f.api(`/api/workflow-schedules/${id}/delete`, {})).status, 200);
  assert.equal((await f.api(`/api/workflow-schedules/${id}`)).status, 404);
  assert.deepEqual((await f.api('/api/workflow-schedules')).body.schedules, []);
  assert.deepEqual((await f.api(`/api/workflow-runs/${completed.id}`)).body, completed);
  assert.equal(f.app.workflows.list().length, 1); assert.deepEqual(f.app.store.list(), []);
});

test('schedule HTTP mutations enforce CSRF, same origin, content type and valid JSON without side effects', async t => {
  const f = await fixture(t), input = payload();
  for (const headers of [{ 'X-Workbench-Token': '' }, { 'X-Workbench-Token': 'incorrect' }, { Origin: 'https://example.invalid' }]) {
    const rejected = await f.api('/api/workflow-schedules', input, headers); assert.equal(rejected.status, 403);
  }
  assert.equal((await f.api('/api/workflow-schedules', input, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.request('/api/workflow-schedules', { method: 'POST', raw: '{invalid' })).status, 400);
  assert.deepEqual((await f.api('/api/workflow-schedules')).body.schedules, []);
  const created = await f.api('/api/workflow-schedules', input);
  assert.equal(created.status, 201, JSON.stringify(created.body)); const id = created.schedule.id;
  for (const [path, body] of [[`/${id}`, { ...input, name: 'blocked update' }], [`/${id}/enabled`, { enabled: false }], [`/${id}/delete`, {}]]) {
    assert.equal((await f.api('/api/workflow-schedules' + path, body, { 'X-Workbench-Token': 'wrong' })).status, 403);
    assert.equal((await f.api('/api/workflow-schedules' + path, body, { Origin: 'https://example.invalid' })).status, 403);
  }
  const saved = await f.api(`/api/workflow-schedules/${id}`);
  assert.equal(saved.schedule.enabled, true); assert.equal(saved.schedule.name, input.name);
  assert.equal((await f.request(`/api/workflow-schedules/${id}/delete`)).status, 404);
  assert.equal((await f.request(`/api/workflow-schedules/${id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await f.api(`/api/workflow-schedules/${id}`)).status, 200);
  assert.deepEqual(f.app.workflows.list(), []); assert.deepEqual(f.app.store.list(), []);
});

test('schedule HTTP rejects invalid bodies, graphs, values, modes and calendar times before persisting a task', async t => {
  const f = await fixture(t), valid = payload();
  const learning = structuredClone(valid); learning.document.mode = 'learn';
  const unsupported = structuredClone(valid); unsupported.document.nodes.push(createNode('condition', { x: 0, y: 200 }));
  const fileReference = structuredClone(valid); fileReference.document.nodes[0].config.outputType = 'fileRef';
  const dangling = structuredClone(valid); dangling.document.edges.pop();
  const retries = structuredClone(valid); retries.document.nodes[1].config.failurePolicy = 'retry';
  const arbitraryTool = structuredClone(valid); arbitraryTool.document.nodes[1].config.toolName = 'terminal.execute';
  const oversized = { ...valid, input: 'x'.repeat(64 * 1024 + 1) };
  const invalid = [null, [], {}, { ...valid, document: null }, { ...valid, enabled: 'true' },
    { ...valid, name: '' }, { ...valid, name: 'x'.repeat(121) }, learning, unsupported, fileReference, dangling, retries, arbitraryTool,
    { ...valid, input: { unexpected: 'text input required' } }, oversized,
    { ...valid, timing: { kind: 'cron', expression: '* * * * *', timezone: 'Asia/Shanghai' } },
    { ...valid, timing: { kind: 'daily', time: '25:00', timezone: 'Asia/Shanghai' } },
    { ...valid, timing: { kind: 'daily', time: '09:60', timezone: 'Asia/Shanghai' } },
    { ...valid, timing: { kind: 'daily', time: '09:00', timezone: 'not/a-zone' } },
    { ...valid, timing: { kind: 'once', localDateTime: '2099-02-30T09:00', timezone: 'Asia/Shanghai' } },
    { ...valid, timing: { kind: 'once', localDateTime: '2000-01-01T09:00', timezone: 'Asia/Shanghai' } }];
  for (const body of invalid) {
    const rejected = await f.api('/api/workflow-schedules', body);
    assert([400, 413].includes(rejected.status), `Rejected invalid schedule before persistence: ${JSON.stringify({ body, response: rejected.body, status: rejected.status }).slice(0, 1000)}`);
    assert.equal(typeof rejected.body.error, 'string');
  }
  assert.deepEqual((await f.api('/api/workflow-schedules')).body.schedules, []);
  assert.deepEqual(f.app.workflows.list(), []); assert.deepEqual(f.app.store.list(), []);
});

test('schedule HTTP reports invalid or missing identifiers and rejects bad mutations without changing the snapshot', async t => {
  const f = await fixture(t), input = payload(), created = await f.api('/api/workflow-schedules', input);
  assert.equal(created.status, 201, JSON.stringify(created.body)); const id = created.schedule.id;
  const missing = randomUUID();
  for (const [path, body] of [[`/${missing}`, undefined], [`/${missing}`, input], [`/${missing}/enabled`, { enabled: false }], [`/${missing}/delete`, {}]]) {
    assert.equal((await f.api('/api/workflow-schedules' + path, body)).status, 404);
  }
  for (const raw of ['invalid-id', '%2e%2e%2foutside', '%E0%A4%A']) {
    const response = await f.api('/api/workflow-schedules/' + raw);
    assert([400, 404].includes(response.status), 'malformed identifiers cannot resolve a task');
  }
  for (const body of [null, {}, { enabled: 'false' }, { enabled: 0 }, { enabled: false, document: input.document }]) {
    assert.equal((await f.api(`/api/workflow-schedules/${id}/enabled`, body)).status, 400);
  }
  for (const body of [null, {}, { ...input, timing: { kind: 'daily', time: 'invalid', timezone: 'Asia/Shanghai' } }, { ...input, document: { ...input.document, mode: 'learn' } }]) {
    assert.equal((await f.api(`/api/workflow-schedules/${id}`, body)).status, 400);
  }
  assert.equal((await f.api(`/api/workflow-schedules/${id}/delete`, { id })).status, 400);
  const saved = await f.api(`/api/workflow-schedules/${id}`);
  assert.deepEqual(saved.schedule.document, input.document); assert.equal(saved.schedule.enabled, true); assert.deepEqual(saved.schedule.timing, input.timing);
  assert.deepEqual(f.app.workflows.list(), []); assert.deepEqual(f.app.store.list(), []);
});

test('schedules survive an isolated server restart while deleted tasks and other data roots stay absent', async t => {
  const f = await fixture(t), other = await fixture(t);
  const first = await f.api('/api/workflow-schedules', payload());
  const second = await f.api('/api/workflow-schedules', payload(localToolDocument({ title: '保持暂停', inputType: 'any', toolName: 'json.stringify' }), { name: '暂停的每日任务', input: false, timing: { kind: 'daily', time: '07:15', timezone: 'Asia/Shanghai' }, enabled: false }));
  const removed = await f.api('/api/workflow-schedules', payload(localToolDocument({ title: '已删除' })));
  for (const result of [first, second, removed]) assert.equal(result.status, 201, JSON.stringify(result.body));
  await f.api(`/api/workflow-schedules/${removed.schedule.id}/delete`, {});
  assert.deepEqual((await other.api('/api/workflow-schedules')).body.schedules, []);
  assert.equal((await other.api(`/api/workflow-schedules/${first.schedule.id}`)).status, 404);
  const oldToken = f.csrfToken; await f.restart();
  assert.notEqual(f.csrfToken, oldToken);
  const listed = await f.api('/api/workflow-schedules');
  assert.deepEqual(new Set(listed.body.schedules.map(item => item.id)), new Set([first.schedule.id, second.schedule.id]));
  for (const previous of [first.schedule, second.schedule]) {
    const restored = (await f.api(`/api/workflow-schedules/${previous.id}`)).schedule;
    assert.equal(restored.id, previous.id); assert.equal(restored.name, previous.name); assert.equal(restored.enabled, previous.enabled);
    assert.deepEqual(restored.document, previous.document); assert.deepEqual(restored.input, previous.input); assert.deepEqual(restored.timing, previous.timing);
  }
  assert.equal((await f.api(`/api/workflow-schedules/${removed.schedule.id}`)).status, 404);
  assert.deepEqual(f.app.workflows.list(), []); assert.deepEqual(f.app.store.list(), []);
});
