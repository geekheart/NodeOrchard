import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application } from '../src/application.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';
import { builtinNodePresets, instantiatePreset, presetDefinitionFromNode } from '../shared/workflow/workflow-presets.mjs';
import { WORKFLOW_TOOLS } from '../shared/workflow/workflow-tools.mjs';

const ROUTE = '/api/workflow-node-presets';
const copy = value => JSON.parse(JSON.stringify(value));
class DisconnectedAdapter extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.starts = 0; this.requests = []; }
  async start() { this.starts++; throw new Error('Node preset HTTP tests must not start Hermes.'); }
  async request(method) { this.requests.push(method); throw new Error('Node preset HTTP tests must not call Hermes.'); }
  async stop() {}
}

function definition(title = '文本清理') {
  return presetDefinitionFromNode(createNode('tool', { x: 0, y: 0 }, { title, config: {
    inputType: 'text', outputType: 'text', executionMode: 'tool', toolName: 'text.trim', timeoutSeconds: 60,
  } }));
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-node-presets-http-'));
  const config = { ...readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace'),
    WORKBENCH_HERMES_ROOT: join(directory, 'unused-hermes'), WORKBENCH_HERMES_HOME: join(directory, 'unused-home') }), port: 0 };
  const f = { directory, config, adapters: [] };
  f.assertNoExecution = () => {
    assert.deepEqual(f.app.workflows.list(), []); assert.deepEqual(f.app.learning.list(), []);
    assert.deepEqual(f.app.schedules.list(), []); assert.deepEqual(f.app.store.list(), []);
    for (const table of ['learned_skills', 'workflow_artifacts', 'workflow_file_runs']) {
      assert.equal(f.app.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    }
    for (const adapter of f.adapters) { assert.equal(adapter.starts, 0); assert.deepEqual(adapter.requests, []); }
  };
  f.open = async () => {
    const adapter = new DisconnectedAdapter(); f.adapters.push(adapter);
    f.app = new Application(config, adapter); f.bridge = createWorkbenchServer(config, f.app);
    f.origin = await f.bridge.listen();
    f.csrfToken = (await (await fetch(f.origin + '/api/bootstrap')).json()).csrfToken;
  };
  f.close = async () => {
    if (!f.bridge) return;
    f.assertNoExecution(); const bridge = f.bridge; f.bridge = null; await bridge.close();
  };
  f.restart = async () => { await f.close(); await f.open(); };
  f.request = async (path = ROUTE, { body, raw, method = body === undefined && raw === undefined ? 'GET' : 'POST', headers = {} } = {}) => {
    const response = await fetch(f.origin + path, { method,
      headers: method === 'POST' ? { 'Content-Type': 'application/json', 'X-Workbench-Token': f.csrfToken, ...headers } : headers,
      ...(body === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  t.after(async () => { try { await f.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  await f.open(); return f;
}

function saved(response, status = 201) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  const record = response.body.preset;
  assert.match(record.id, /^preset-/); assert.equal(record.source, 'user');
  assert.ok(Number.isSafeInteger(record.version) && record.version > 0);
  assert.ok(Number.isSafeInteger(record.revision) && record.revision >= record.version);
  assert.ok(Number.isFinite(Date.parse(record.createdAt))); assert.ok(Number.isFinite(Date.parse(record.updatedAt)));
  return record;
}

test('node preset HTTP persists immutable versions and existing pinned workflow instances across restart', async t => {
  const f = await fixture(t), other = await fixture(t);
  const first = saved(await f.request(ROUTE, { body: { definition: definition(), expectedRevision: 0 } }));
  assert.equal(first.version, 1); assert.equal(first.revision, 1); assert.equal(first.baseType, 'tool');
  const instance = instantiatePreset(first, { x: 300, y: 100 });
  let document = createDocument({ schemaVersion: 2, title: '固定使用预设第一版' });
  document.nodes = [createNode('input', { x: 0, y: 100 }, { config: { outputType: 'text' } }), instance,
    createNode('output', { x: 600, y: 100 })];
  document = connectNodes(document, { sourceNode: document.nodes[0].id, sourcePort: 'out', targetNode: instance.id, targetPort: 'in' });
  document = connectNodes(document, { sourceNode: instance.id, sourcePort: 'out', targetNode: document.nodes[2].id, targetPort: 'in' });
  const workflowResponse = await f.request('/api/workflow-library', { body: { document, expectedRevision: 0 } });
  assert.equal(workflowResponse.status, 200, JSON.stringify(workflowResponse.body));
  const snapshot = workflowResponse.body.workflow;
  const changed = copy(first.definition);
  changed.title = '大写文本'; changed.node.config.toolName = 'text.uppercase'; changed.node.config.timeoutSeconds = 180;
  const second = saved(await f.request(`${ROUTE}/${first.id}`, { body: { definition: changed, expectedRevision: first.revision } }), 200);
  assert.equal(second.version, 2); assert.equal(second.revision, 2); assert.equal(second.createdAt, first.createdAt);
  const old = await f.request(`${ROUTE}/${first.id}?version=1`);
  assert.equal(old.status, 200); assert.deepEqual(old.body.preset.definition, first.definition);
  assert.equal(old.body.preset.version, 1); assert.equal(old.body.preset.revision, 2);
  assert.deepEqual((await f.request(`/api/workflow-library/${document.id}`)).body.workflow, snapshot);
  assert.equal(snapshot.document.nodes[1].origin.version, 1); assert.equal(snapshot.document.nodes[1].config.toolName, 'text.trim');
  assert.equal(instantiatePreset(second).config.toolName, 'text.uppercase');
  assert.equal((await other.request(`${ROUTE}/${first.id}`)).status, 404);
  assert.equal((await other.request()).body.presets.filter(row => row.source === 'user').length, 0);
  const event = f.app.events.filter(event => event.type === 'workflow.node-preset');
  assert.equal(event.length, 2); assert.equal(event[1].payload.preset.version, 2);
  assert.equal(Object.hasOwn(event[1].payload.preset, 'definition'), false);
  await f.restart();
  assert.deepEqual((await f.request(`${ROUTE}/${first.id}`)).body.preset, second);
  assert.deepEqual((await f.request(`${ROUTE}/${first.id}?version=1`)).body.preset.definition, first.definition);
  assert.deepEqual((await f.request(`/api/workflow-library/${document.id}`)).body.workflow, snapshot);
  const summary = (await f.request()).body.presets.find(row => row.id === first.id);
  assert.equal(summary.version, 2); assert.equal(summary.title, '大写文本'); assert.equal(Object.hasOwn(summary, 'definition'), false);
});

test('node preset HTTP protects writes with CSRF, same-origin JSON and strict envelopes without side effects', async t => {
  const f = await fixture(t), body = { definition: definition() };
  for (const headers of [{ 'X-Workbench-Token': '' }, { 'X-Workbench-Token': 'wrong' }, { Origin: 'https://example.invalid' }]) {
    assert.equal((await f.request(ROUTE, { body, headers })).status, 403);
  }
  assert.equal((await f.request(ROUTE, { body, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.request(ROUTE, { raw: '{invalid JSON' })).status, 400);
  for (const invalid of [null, [], {}, { definition: null }, { ...body, unknown: true }, { ...body, id: 'supplied-id' },
    { definition: { ...body.definition, unknown: true } }, { definition: { ...body.definition, title: '' } },
    { definition: { ...body.definition, node: { ...body.definition.node, config: { ...body.definition.node.config, injected: true } } } },
    ...[null, 1, -1, 0.5, '0', true].map(expectedRevision => ({ ...body, expectedRevision }))]) {
    const rejected = await f.request(ROUTE, { body: invalid });
    assert.equal(rejected.status, 400, JSON.stringify({ input: invalid, response: rejected.body }));
    assert.equal(typeof rejected.body.error, 'string');
  }
  assert.equal((await f.request()).body.presets.filter(row => row.source === 'user').length, 0);
  const record = saved(await f.request(ROUTE, { body }));
  const update = { definition: { ...record.definition, title: '被阻止的修改' }, expectedRevision: 1 };
  assert.equal((await f.request(`${ROUTE}/${record.id}`, { body: update, headers: { 'X-Workbench-Token': '' } })).status, 403);
  assert.equal((await f.request(`${ROUTE}/${record.id}`, { body: update, headers: { Origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await f.request(`${ROUTE}/${record.id}`, { headers: { Origin: 'https://example.invalid' } })).status, 403);
  for (const method of ['PUT', 'DELETE', 'PATCH']) assert.equal((await f.request(`${ROUTE}/${record.id}`, { method })).status, 404);
  assert.deepEqual((await f.request(`${ROUTE}/${record.id}`)).body.preset, record);
  assert.equal(f.app.events.filter(event => event.type === 'workflow.node-preset').length, 1);
});

test('node preset HTTP validates identifiers, version queries and builtin read-only behavior', async t => {
  const f = await fixture(t), builtins = builtinNodePresets();
  const listing = await f.request();
  assert.equal(listing.status, 200); assert.equal(listing.body.presets.length, WORKFLOW_TOOLS.length);
  assert.equal(listing.headers.get('cache-control'), 'no-store');
  for (const summary of listing.body.presets) {
    assert.equal(summary.source, 'builtin'); assert.equal(summary.baseType, 'tool'); assert.equal(Object.hasOwn(summary, 'definition'), false);
    const record = (await f.request(`${ROUTE}/${summary.id}?version=1`)).body.preset;
    assert.deepEqual(record, builtins.find(row => row.id === summary.id));
  }
  const first = builtins[0], path = `${ROUTE}/${first.id}`;
  for (const query of ['?version=', '?version=0', '?version=-1', '?version=1.5', '?version=01', '?version=1e0', '?version=9007199254740992',
    '?version=1&version=1', '?unknown=1', '?version=1&other=value']) {
    assert.equal((await f.request(path + query)).status, 400, query);
  }
  for (const rawId of ['__proto__', 'prototype', 'constructor', 'slash%2Fin%2Fid', '%E0%A4%A', 'with%20space']) {
    assert.equal((await f.request(`${ROUTE}/${rawId}`)).status, 400, rawId);
  }
  assert.equal((await f.request(`${ROUTE}/preset-missing`)).status, 404);
  assert.equal((await f.request(path + '?version=2')).status, 404);
  assert.equal((await f.request(path, { body: { definition: definition(), expectedRevision: 1 } })).status, 409);
  assert.equal((await f.request(path + '?version=1', { body: { definition: definition(), expectedRevision: 1 } })).status, 400);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM workflow_node_presets').get().count, 0);
  assert.equal(f.app.events.filter(event => event.type === 'workflow.node-preset').length, 0);
});

test('node preset HTTP concurrent updates admit one version and conflicts leave immutable history intact', async t => {
  const f = await fixture(t);
  const first = saved(await f.request(ROUTE, { body: { definition: definition() } }));
  const neighbor = saved(await f.request(ROUTE, { body: { definition: definition('独立预设') } }));
  const attempts = ['窗口 A', '窗口 B'].map(title => ({ definition: { ...first.definition, title }, expectedRevision: 1 }));
  const responses = await Promise.all(attempts.map(body => f.request(`${ROUTE}/${first.id}`, { body })));
  assert.deepEqual(responses.map(row => row.status).sort(), [200, 409]);
  const winner = saved(responses.find(row => row.status === 200), 200);
  assert.equal(winner.version, 2); assert.equal(winner.revision, 2);
  for (const expectedRevision of [undefined, null, 0, -1, 0.5, '2']) {
    assert.equal((await f.request(`${ROUTE}/${first.id}`, { body: { definition: winner.definition, expectedRevision } })).status, 400);
  }
  assert.equal((await f.request(`${ROUTE}/${first.id}`, { body: { definition: first.definition, expectedRevision: 1 } })).status, 409);
  assert.equal((await f.request(`${ROUTE}/${first.id}`, { body: { definition: first.definition, expectedRevision: 3 } })).status, 409);
  const before = f.app.events.length;
  assert.deepEqual((await f.request(`${ROUTE}/${first.id}`, { body: { definition: winner.definition, expectedRevision: 2 } })).body.preset, winner);
  assert.equal(f.app.events.length, before);
  assert.deepEqual((await f.request(`${ROUTE}/${first.id}?version=1`)).body.preset.definition, first.definition);
  assert.deepEqual((await f.request(`${ROUTE}/${neighbor.id}`)).body.preset, neighbor);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM workflow_node_preset_versions WHERE preset_id=?').get(first.id).count, 2);
});

test('node preset HTTP stores reusable components and keeps their review, Skill pins and outputs independent', async t => {
  const f = await fixture(t);
  let inner = createDocument({ schemaVersion: 2, title: '带审核的组合' });
  inner.settings.outputDirectory = '/private/input-machine/delivery';
  inner.nodes = [
    createNode('input', { x: 0, y: 0 }, { id: 'source', config: { outputType: 'object', sourceKind: 'file', path: '/private/input-machine/source.epro2' } }),
    createNode('skill', { x: 200, y: 0 }, { id: 'skill', config: { inputType: 'object', outputType: 'object', skillRef: 'focused-skill', version: 'fixed-skill-version' } }),
    createNode('human', { x: 400, y: 0 }, { id: 'review', config: { reviewTargetNodeId: 'skill' } }),
    createNode('output', { x: 600, y: 0 }, { id: 'output-image' }),
    createNode('output', { x: 600, y: 200 }, { id: 'output-source' }),
  ];
  for (const [sourceNode, targetNode] of [['source', 'skill'], ['skill', 'review'], ['review', 'output-image'], ['source', 'output-source']]) {
    inner = connectNodes(inner, { sourceNode, sourcePort: 'out', targetNode, targetPort: 'in' });
  }
  const template = createNode('subflow', { x: 0, y: 0 }, { title: '生成并审核图片', config: { document: inner }, ports: {
    inputs: [{ id: 'arg-1', label: '资料', type: 'object', required: true }],
    outputs: [{ id: 'result-1', label: '图片', type: 'any', valuePath: 'output-image' }, { id: 'result-2', label: '来源', type: 'any', valuePath: 'output-source' }],
  } });
  const input = presetDefinitionFromNode(template);
  const record = saved(await f.request(ROUTE, { body: { definition: input } }));
  assert.equal(record.kind, 'component'); assert.equal(record.baseType, 'subflow');
  assert.equal(record.definition.node.config.document.settings.outputDirectory, '');
  assert.equal(record.definition.node.config.document.nodes[0].config.path, '');
  const first = instantiatePreset(record), second = instantiatePreset(record);
  const child = first.config.document;
  assert.equal(child.nodes.find(node => node.type === 'human').config.reviewTargetNodeId, child.nodes.find(node => node.type === 'skill').id);
  assert.equal(child.nodes.find(node => node.type === 'skill').config.version, 'fixed-skill-version');
  assert.equal(first.ports.outputs[0].valuePath, child.nodes.find(node => node.title === '产物输出').id);
  assert.notEqual(first.id, second.id); assert.notEqual(child.id, second.config.document.id);
  first.config.document.nodes[1].config.skillRef = 'local-change';
  assert.deepEqual((await f.request(`${ROUTE}/${record.id}`)).body.preset, record);
  assert.equal(second.config.document.nodes[1].config.skillRef, 'focused-skill');
});

test('node preset HTTP accepts large definitions within budget and rejects oversized writes atomically', async t => {
  const f = await fixture(t);
  const large = count => {
    const inner = createDocument({ schemaVersion: 2, title: '大量代码配置' });
    inner.nodes = Array.from({ length: count }, (_, index) => createNode('tool', { x: index * 10, y: 0 }, { id: `code-${index}`,
      config: { code: '// ' + '中'.repeat(94000), language: 'javascript' } }));
    return { title: '大组合预设', description: '', kind: 'component', node: createNode('subflow', { x: 0, y: 0 }, { config: { document: inner } }) };
  };
  const within = large(6);
  assert.ok(Buffer.byteLength(JSON.stringify(within)) > 1000000 && Buffer.byteLength(JSON.stringify(within)) < 2 * 1024 * 1024);
  const record = saved(await f.request(ROUTE, { body: { definition: within } }));
  assert.equal(record.definition.node.config.document.nodes.length, 6);
  const oversized = large(8);
  assert.equal((await f.request(ROUTE, { body: { definition: oversized }, headers: { Connection: 'close' } })).status, 413);
  assert.equal((await f.request(`${ROUTE}/${record.id}`, { body: { definition: oversized, expectedRevision: 1 }, headers: { Connection: 'close' } })).status, 413);
  assert.deepEqual((await f.request(`${ROUTE}/${record.id}`)).body.preset, record);
  const users = (await f.request()).body.presets.filter(row => row.source === 'user');
  assert.equal(users.length, 1); assert.equal(users[0].revision, 1);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM workflow_node_preset_versions').get().count, 1);
});
