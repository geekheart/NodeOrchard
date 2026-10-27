import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Application } from '../src/application.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

async function fixture(t, { connect = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-workflow-http-'));
  const config = { ...readConfig(), port: 0,
    workflowRunRoot: join(directory, 'runs'),
    dataDir: join(directory, 'data'), workspaceRoot: join(directory, 'workspace'),
    hermesHome: join(directory, 'fake-home'), hermesPython: process.env.WORKBENCH_TEST_PYTHON || 'python3',
    command: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-hermes.mjs', import.meta.url))],
    childEnv: { FAKE_HERMES_STATE_PATH: join(directory, 'hermes.json'), FAKE_APPROVAL_MODE: 'manual',
      FAKE_FALLBACK_PROVIDER: '', FAKE_RESUME_RACE: '' },
  };
  const app = new Application(config);
  let preparations = 0;
  app.workflows.prepareSkill = async (_app, _session, skill, { input }) => {
    preparations++;
    const prompt = value => `Fixture Skill input: ${String(value)}`;
    return { text: prompt(input), skill, cleanup: async () => {},
      bindInput: async value => ({ text: prompt(value) }) };
  };
  const bridge = createWorkbenchServer(config, app);
  const origin = await bridge.listen();
  t.after(async () => { try { await bridge.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  const boot = await (await fetch(`${origin}/api/bootstrap`)).json();
  const api = async (path, body, extra = {}) => {
    const response = await fetch(origin + path, body === undefined ? extra : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': boot.csrfToken, ...extra.headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  if (connect) await app.connect();
  const skill = connect ? await app.skill('fixture-report') : { name: 'fixture-report', revision: 'sha256:' + 'a'.repeat(64) };
  let document = createDocument({ title: 'HTTP Skill fixture' });
  const input = createNode('input', { x: 0, y: 0 }, { config: { outputType: 'text' } });
  const capability = createNode('skill', { x: 320, y: 0 }, { config: {
    inputType: 'text', outputType: 'text', skillRef: skill.name, version: skill.revision,
  } });
  const output = createNode('output', { x: 640, y: 0 });
  document.nodes = [input, capability, output];
  document = connectNodes(document, { sourceNode: input.id, sourcePort: 'out', targetNode: capability.id, targetPort: 'in' });
  document = connectNodes(document, { sourceNode: capability.id, sourcePort: 'out', targetNode: output.id, targetPort: 'in' });
  return { app, api, origin, document, skill, preparations: () => preparations };
}
async function until(read, predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected workflow state was not observed');
}
async function events(t, origin) {
  const controller = new AbortController();
  const response = await fetch(origin + '/api/events', { signal: controller.signal });
  const reader = response.body.getReader(), decoder = new TextDecoder(), frames = []; let buffer = '';
  const reading = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          if (data) frames.push(JSON.parse(data.slice(6)));
        }
      }
    } catch (error) { if (!controller.signal.aborted) throw error; }
  })();
  t.after(async () => { controller.abort(); await reading; });
  return frames;
}
function addSecondSkill(document, skill) {
  const next = structuredClone(document);
  const first = next.nodes.find(node => node.type === 'skill'), output = next.nodes.find(node => node.type === 'output');
  const second = createNode('skill', { x: 640, y: 0 }, { id: 'second-skill', title: '第二个 Skill', config: {
    inputType: 'text', outputType: 'text', skillRef: skill.name, version: skill.revision,
  } });
  next.nodes.push(second);
  next.edges = next.edges.filter(edge => !(edge.sourceNode === first.id && edge.targetNode === output.id));
  const linked = connectNodes(next, { sourceNode: first.id, sourcePort: 'out', targetNode: second.id, targetPort: 'in' });
  return connectNodes(linked, { sourceNode: second.id, sourcePort: 'out', targetNode: output.id, targetPort: 'in' });
}
function operationChain(nodes) {
  let document = createDocument({ title: '混合能力 HTTP 流程' });
  document.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'entry', config: { outputType: 'text' } }),
    ...nodes, createNode('output', { x: 1900, y: 0 }, { id: 'exit' })];
  for (let index = 1; index < document.nodes.length; index++) document = connectNodes(document, {
    sourceNode: document.nodes[index - 1].id, sourcePort: 'out', targetNode: document.nodes[index].id, targetPort: 'in',
  });
  return document;
}
const code = (id, config = {}) => createNode('tool', { x: 640, y: 0 }, { id, config: {
  executionMode: 'code', inputType: 'any', outputType: 'any', code: 'return input;', ...config,
} });
const builtin = (id, toolName, inputType, outputType) => createNode('tool', { x: 320, y: 0 }, { id, config: {
  executionMode: 'tool', toolName, inputType, outputType,
} });

function reviewedV2(producer, inputType = 'object') {
  let document = createDocument({ schemaVersion: 2, title: 'Isolated revision HTTP fixture' });
  document.nodes = [createNode('input', {}, { id: 'input', config: { outputType: inputType } }), producer,
    createNode('human', {}, { id: 'review', config: { inputType, outputType: inputType, reviewTargetNodeId: producer.id } }),
    createNode('output', {}, { id: 'output' })];
  for (let index = 1; index < document.nodes.length; index++) document = connectNodes(document, {
    sourceNode: document.nodes[index - 1].id, sourcePort: 'out', targetNode: document.nodes[index].id, targetPort: 'in' });
  return document;
}

test('HTTP review refuses fixed Python revisions with a public reason and preserves the exact candidate', async t => {
  const f = await fixture(t, { connect: false });
  const document = reviewedV2(code('poster', { inputType: 'object', outputType: 'object', language: 'python',
    code: "return {'poster': 'original', 'private': 'SOURCE_SENTINEL'}" }));
  const started = await f.api('/api/workflow-runs', { document, input: {} });
  assert.equal(started.status, 202);
  const before = (await until(() => f.api('/api/workflow-runs/' + started.body.id), value => value.body.status === 'waiting_review')).body;
  const record = before.nodes.review, path = '/api/workflow-runs/' + before.id + '/review';
  const result = await f.api(path, { nodeId: 'review', action: 'revise', feedback: 'FEEDBACK_SENTINEL',
    expectedAttempt: record.attempt, expectedAttemptId: record.attemptId, expectedArtifactHashes: [] });
  assert.equal(result.status, 409); assert.equal(result.body.code, 'REVISION_REQUIRES_PROPOSAL');
  assert.deepEqual(Object.keys(result.body).sort(), ['code', 'error']);
  assert.match(result.body.error, /候选/); assert.doesNotMatch(JSON.stringify(result.body), /SOURCE_SENTINEL|FEEDBACK_SENTINEL/);
  assert.deepEqual((await f.api('/api/workflow-runs/' + before.id)).body, before);
  const original = f.app.workflows.approve;
  f.app.workflows.approve = async () => { throw Object.assign(new Error('Fixture rejection'), { httpStatus: 409, code: 'PRIVATE_SOURCE_SENTINEL' }); };
  try { assert.deepEqual((await f.api(path, { nodeId: 'review', action: 'approve' })).body, { error: 'Fixture rejection' }); }
  finally { f.app.workflows.approve = original; }
  const stopped = await f.api(path, { nodeId: 'review', action: 'stop' }); assert.equal(stopped.status, 202);
});

test('HTTP human Skill revisions continue beyond the old frozen maximum until explicitly approved', async t => {
  const f = await fixture(t);
  const document = reviewedV2(createNode('skill', {}, { id: 'author', config: { inputType: 'text', outputType: 'text',
    skillRef: f.skill.name, version: f.skill.revision } }), 'text');
  document.nodes.find(node => node.id === 'review').config.maxRevisions = 3;
  const started = await f.api('/api/workflow-runs', { document, input: 'original candidate' });
  assert.equal(started.status, 202);
  const path = '/api/workflow-runs/' + started.body.id;
  await until(() => f.api(path), value => value.body.status === 'waiting_review');
  for (let index = 0; index < 5; index++) {
    assert.equal((await f.api(path + '/review', { nodeId: 'review', action: 'revise', feedback: 'revision-' + index })).status, 202);
    await until(() => f.api(path), value => value.body.status === 'waiting_review' && value.body.nodes.review.attempt === index + 2);
  }
  const candidate = (await f.api(path)).body;
  assert.equal(candidate.nodes.review.review.revisionCount, 5); assert.equal(candidate.nodes.review.attempt, 6);
  assert.equal(candidate.nodes.author.history.length, 5); assert.equal(f.preparations(), 6);
  assert.deepEqual(candidate.document, document);
  assert.equal((await f.api(path + '/review', { nodeId: 'review', action: 'approve' })).status, 202);
  await until(() => f.api(path), value => value.body.status === 'complete');
});

test('workflow HTTP runs bind a real adapter session, confirm history, and protect its fixed transcript', async t => {
  const f = await fixture(t);
  assert.equal(f.skill.revision, `sha256:${createHash('sha256').update(f.skill.content).digest('hex')}`);
  const started = await f.api('/api/workflow-runs', { document: f.document, input: 'HTTP_ROUNDTRIP' });
  assert.equal(started.status, 202);
  const result = await until(() => f.api(`/api/workflow-runs/${started.body.id}`), value => value.body.status === 'complete');
  assert.equal(result.body.output, 'Echo: Fixture Skill input: HTTP_ROUNDTRIP');
  assert.equal(result.body.document.id, f.document.id);
  assert.equal(Object.values(result.body.nodes).filter(node => node.status === 'complete').length, 3);
  assert.equal(f.preparations(), 1);
  const boot = await f.api('/api/bootstrap');
  assert.equal(boot.body.sessions.find(session => session.id === result.body.sessionId).workflowManaged, true);
  const forbidden = await f.api(`/api/sessions/${result.body.sessionId}/messages`, { text: 'bypass fixed skill' });
  assert.equal(forbidden.status, 409);
  assert.equal(f.app.store.runs(result.body.sessionId).length, 1);
  const listed = await f.api(`/api/workflow-runs?workflowId=${f.document.id}`);
  assert.equal(listed.body.runs[0].id, result.body.id);
});

test('workflow HTTP rejects CSRF, foreign origins, learning and changed Skill fingerprints before creating runs', async t => {
  const f = await fixture(t);
  const before = f.app.store.list().length;
  assert.equal((await f.api('/api/workflow-runs', { document: f.document, input: 'x' }, { headers: { 'X-Workbench-Token': 'wrong' } })).status, 403);
  assert.equal((await f.api('/api/workflow-runs', { document: f.document, input: 'x' }, { headers: { Origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await f.api('/api/workflow-runs', { document: { ...f.document, mode: 'learn' }, input: 'x' })).status, 400);
  const stale = structuredClone(f.document);
  stale.nodes.find(node => node.type === 'skill').config.version = `sha256:${'0'.repeat(64)}`;
  assert.equal((await f.api('/api/workflow-runs', { document: stale, input: 'x' })).status, 409);
  assert.equal(f.app.store.list().length, before);
  assert.equal(f.app.workflows.list().length, 0);
  assert.equal(f.preparations(), 0);
});

test('workflow waiting approval can be interrupted, and terminal requests cannot revive it', async t => {
  const f = await fixture(t);
  const streamed = await events(t, f.origin);
  const started = await f.api('/api/workflow-runs', { document: f.document, input: 'approval' });
  const waiting = await until(() => f.api(`/api/workflow-runs/${started.body.id}`), value => value.body.status === 'waiting');
  const pending = [...f.app.requests.values()].find(request => request.sessionId === waiting.body.sessionId);
  assert(pending);
  await f.api(`/api/workflow-runs/${started.body.id}/interrupt`, {});
  const ended = await until(() => f.api(`/api/workflow-runs/${started.body.id}`), value => value.body.status === 'interrupted');
  assert.equal(ended.body.output, null);
  assert.equal(f.app.requests.has(pending.id), false);
  assert.equal((await f.api(`/api/requests/${encodeURIComponent(pending.id)}/reply`, { result: { choice: 'once' } })).status, 409);
  assert.equal(f.app.session(waiting.body.sessionId).status, 'interrupted');
  await until(() => Promise.resolve(streamed), frames => frames.some(event => event.type === 'request.cancel' && event.payload.id === pending.id));
  let cursor = 0; const accepted = [];
  for (const event of streamed) if (event.id > cursor) { accepted.push(event); cursor = event.id; }
  assert.equal(accepted.length, streamed.length, 'SSE frames must arrive in increasing cursor order');
  assert(accepted.some(event => event.type === 'request.open' && event.payload.id === pending.id), 'approval controls survive cursor deduplication');
  assert(accepted.some(event => event.type === 'request.cancel' && event.payload.id === pending.id), 'terminal approval cleanup survives cursor deduplication');
});

test('a terminal event before a lost submit ACK stays authoritative in Application and the workflow', async t => {
  const f = await fixture(t);
  const request = f.app.adapter.request.bind(f.app.adapter);
  f.app.adapter.request = async (method, ...args) => {
    const result = await request(method, ...args);
    if (method === 'prompt.submit') {
      await until(() => Promise.resolve(f.app.store.list()[0]), value => value.status === 'complete');
      throw new Error('Fixture lost submit ACK after confirmed completion');
    }
    return result;
  };
  const started = await f.api('/api/workflow-runs', { document: f.document, input: 'early-complete' });
  assert.equal(started.status, 202);
  const ended = await until(() => f.api(`/api/workflow-runs/${started.body.id}`), value => value.body.status === 'complete');
  assert.equal(f.app.session(ended.body.sessionId).status, 'complete');
  assert.equal(f.app.store.runs(ended.body.sessionId)[0].status, 'complete');
});

test('HTTP multi-Skill execution follows edges and persists each exact handoff and protected session', async t => {
  const f = await fixture(t);
  const document = addSecondSkill(f.document, f.skill);
  const first = document.nodes.find(node => node.type === 'skill'), second = document.nodes.find(node => node.id === 'second-skill');
  const input = document.nodes.find(node => node.type === 'input'), output = document.nodes.find(node => node.type === 'output');
  document.nodes.reverse();
  const started = await f.api('/api/workflow-runs', { document, input: 'CHAIN_ROUNDTRIP' });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const result = (await until(() => f.api(`/api/workflow-runs/${started.body.id}`), value => value.body.status === 'complete')).body;
  assert.deepEqual(result.nodeOrder, [input.id, first.id, second.id, output.id]);
  assert.equal(result.nodes[first.id].input, 'CHAIN_ROUNDTRIP');
  assert.equal(result.nodes[first.id].output, result.nodes[second.id].input);
  assert.equal(result.nodes[second.id].output, result.nodes[output.id].input);
  assert.equal(result.output, 'Echo: Fixture Skill input: Echo: Fixture Skill input: CHAIN_ROUNDTRIP');
  assert.equal(result.nodes[output.id].output, result.output);
  assert.notEqual(result.nodes[first.id].sessionId, result.nodes[second.id].sessionId);
  for (const node of [first, second]) {
    const step = result.nodes[node.id];
    assert.equal(step.status, 'complete');
    assert(step.startedAt && step.completedAt);
    assert.equal((await f.api(`/api/sessions/${step.sessionId}/messages`, { text: 'bypass chain' })).status, 409);
  }
  assert.equal(f.preparations(), 2);
  const restored = await f.api(`/api/workflow-runs/${result.id}`);
  assert.deepEqual(restored.body.nodes, result.nodes);
});

test('stale downstream Skill is rejected before any HTTP run or session is created', async t => {
  const f = await fixture(t);
  const document = addSecondSkill(f.document, f.skill);
  document.nodes.find(node => node.id === 'second-skill').config.version = `sha256:${'0'.repeat(64)}`;
  const before = f.app.store.list().length;
  assert.equal((await f.api('/api/workflow-runs', { document, input: 'must not execute first' })).status, 409);
  assert.equal(f.app.store.list().length, before);
  assert.equal(f.app.workflows.list().length, 0);
  assert.equal(f.preparations(), 0);
});

test('interrupting a downstream approval preserves completed upstream input and output', async t => {
  const f = await fixture(t);
  const document = addSecondSkill(f.document, f.skill);
  const first = document.nodes.find(node => node.type === 'skill'), output = document.nodes.find(node => node.type === 'output');
  f.app.workflows.prepareSkill = async (_app, _session, skill, { input, skillNode }) => {
    const prompt = value => skillNode.id === 'second-skill' ? `approval for ${String(value)}` : `first ${String(value)}`;
    return { text: prompt(input), skill, cleanup: async () => {},
      bindInput: async value => ({ text: prompt(value) }) };
  };
  const started = await f.api('/api/workflow-runs', { document, input: 'preserve me' });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const waiting = (await until(() => f.api(`/api/workflow-runs/${started.body.id}`),
    value => value.body.status === 'waiting' && value.body.currentNodeId === 'second-skill')).body;
  assert.equal(waiting.nodes[first.id].status, 'complete');
  const firstSnapshot = structuredClone(waiting.nodes[first.id]);
  assert.equal(waiting.nodes['second-skill'].input, firstSnapshot.output);
  await f.api(`/api/workflow-runs/${started.body.id}/interrupt`, {});
  const ended = (await until(() => f.api(`/api/workflow-runs/${started.body.id}`), value => value.body.status === 'interrupted')).body;
  assert.deepEqual(ended.nodes[first.id], firstSnapshot);
  assert.equal(ended.nodes['second-skill'].status, 'interrupted');
  assert.equal(ended.nodes[output.id].status, 'skipped');
  assert.equal(ended.output, null);
});

test('offline HTTP execution runs real builtin, JavaScript and Python nodes with typed I/O and logs', async t => {
  const f = await fixture(t, { connect: false });
  const document = operationChain([
    builtin('trim', 'text.trim', 'text', 'text'),
    builtin('parse', 'json.parse', 'text', 'any'),
    code('javascript', { outputType: 'object', code: 'console.log("JavaScript received", input.count); return {...input, checked: true};' }),
    code('python', { inputType: 'object', outputType: 'object', language: 'python', code: 'print("Python received")\nreturn {**input, "count": input["count"] + 1}' }),
  ]);
  const started = await f.api('/api/workflow-runs', { document, input: '  {"count":0,"enabled":false,"items":[]}  ' });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const result = (await until(() => f.api('/api/workflow-runs/' + started.body.id), value => value.body.status === 'complete', 10000)).body;
  assert.deepEqual(result.output, { count: 1, enabled: false, items: [], checked: true });
  assert.deepEqual(result.nodes.parse.output, result.nodes.javascript.input);
  assert.deepEqual(result.nodes.javascript.output, result.nodes.python.input);
  assert.match(result.nodes.javascript.logs.stdout, /JavaScript received 0/);
  assert.match(result.nodes.python.logs.stdout, /Python received/);
  assert.equal(result.nodes.javascript.runtime.kind, 'code');
  assert.equal(result.nodes.python.runtime.language, 'python');
  assert.equal(result.nodes.trim.runtime.toolName, 'text.trim');
  assert(result.nodeOrder.every(id => result.nodes[id].status === 'complete'));
  assert(result.nodeOrder.every(id => result.nodes[id].sessionId === null));
  assert.equal(f.app.store.list().length, 0);
  assert.equal(f.app.backend.state, 'stopped');
  assert.equal(f.preparations(), 0);
  assert.equal((await f.api('/api/workflow-runs/' + result.id)).body.nodes.python.output.count, 1);
});

test('HTTP mixed chains pass true outputs between builtin, Skill, code and another Skill', async t => {
  const f = await fixture(t);
  const skillNode = (id, inputType) => createNode('skill', { x: 900, y: 0 }, { id, config: {
    inputType, outputType: 'text', skillRef: f.skill.name, version: f.skill.revision,
  } });
  const document = operationChain([
    builtin('trim', 'text.trim', 'text', 'text'), skillNode('first-skill', 'text'),
    code('javascript', { inputType: 'text', outputType: 'object', code: 'return {text: input.toUpperCase(), original: input, ok: false};' }),
    builtin('keys', 'json.keys', 'object', 'array'), skillNode('last-skill', 'array'),
  ]);
  document.nodes.reverse(); document.edges.reverse();
  const started = await f.api('/api/workflow-runs', { document, input: '  mixed roundtrip  ' });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const result = (await until(() => f.api('/api/workflow-runs/' + started.body.id), value => value.body.status === 'complete', 10000)).body;
  assert.equal(result.nodes['first-skill'].input, 'mixed roundtrip');
  assert.equal(result.nodes.javascript.input, result.nodes['first-skill'].output);
  assert.equal(result.nodes.javascript.output.text, result.nodes.javascript.input.toUpperCase());
  assert.deepEqual(result.nodes.keys.output, ['text', 'original', 'ok']);
  assert.deepEqual(result.nodes['last-skill'].input, result.nodes.keys.output);
  assert.equal(result.output, result.nodes['last-skill'].output);
  assert.equal(result.skills.length, 2);
  assert.equal(f.preparations(), 2);
  assert.equal(f.app.store.list().length, 2);
  assert.equal(result.nodes.javascript.sessionId, null);
  for (const id of ['first-skill', 'last-skill']) assert.equal((await f.api('/api/sessions/' + result.nodes[id].sessionId + '/messages', { text: 'bypass' })).status, 409);
});

test('local code failures retain diagnostics and upstream results while skipping downstream', async t => {
  const f = await fixture(t, { connect: false });
  const document = operationChain([builtin('trim', 'text.trim', 'text', 'text'),
    code('broken', { inputType: 'text', outputType: 'text', code: 'console.error("failure diagnostic"); throw new Error("EXPECTED_CODE_FAILURE");' }),
    builtin('future', 'text.uppercase', 'text', 'text')]);
  const started = await f.api('/api/workflow-runs', { document, input: '  preserve upstream  ' });
  const result = (await until(() => f.api('/api/workflow-runs/' + started.body.id), value => value.body.status === 'error')).body;
  assert.equal(result.nodes.trim.status, 'complete');
  assert.equal(result.nodes.trim.output, 'preserve upstream');
  assert.equal(result.nodes.broken.input, result.nodes.trim.output);
  assert.match(result.nodes.broken.error, /EXPECTED_CODE_FAILURE/);
  assert.match(result.nodes.broken.logs.stderr, /failure diagnostic/);
  assert.equal(result.nodes.future.status, 'skipped');
  assert.equal(Object.hasOwn(result.nodes.future, 'input'), false);
  assert.equal(result.nodes.exit.status, 'skipped');
  assert.equal(result.output, null);
});

test('stopping HTTP code execution terminates the worker and never launches its downstream node', async t => {
  const f = await fixture(t, { connect: false });
  const document = operationChain([code('slow', { inputType: 'text', outputType: 'text', code: 'console.log("worker started"); await new Promise(resolve => setTimeout(resolve, 60000)); return input;' }),
    builtin('future', 'text.uppercase', 'text', 'text')]);
  const started = await f.api('/api/workflow-runs', { document, input: 'stop me' });
  assert.equal(started.status, 202);
  await until(() => f.api('/api/workflow-runs/' + started.body.id), value => value.body.nodes.slow.logs?.stdout?.includes('worker started'));
  await f.api('/api/workflow-runs/' + started.body.id + '/interrupt', {});
  const result = (await until(() => f.api('/api/workflow-runs/' + started.body.id), value => value.body.status === 'interrupted')).body;
  assert.equal(result.nodes.slow.status, 'interrupted');
  assert.equal(result.nodes.future.status, 'skipped');
  assert.equal(result.nodes.exit.status, 'skipped');
  assert.equal(result.nodes.slow.input, 'stop me');
  assert.match(result.nodes.slow.logs.stdout, /worker started/);
  assert.equal(f.app.store.list().length, 0);
});
