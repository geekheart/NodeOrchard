import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { WorkflowRuns } from '../src/workflows/workflow-runs.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

const revision = `sha256:${'a'.repeat(64)}`;
const terminal = new Set(['complete', 'error', 'interrupted', 'unknown']);
const copy = value => JSON.parse(JSON.stringify(value));

function document({ inputType = 'text', outputType = 'text', timeoutSeconds = 120 } = {}) {
  let doc = createDocument({ title: '测试流程' });
  doc.nodes = [
    createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: inputType } }),
    createNode('skill', { x: 300, y: 0 }, { id: 'skill', config: {
      inputType, outputType, skillRef: 'fixture-skill', version: revision, timeoutSeconds,
    } }),
    createNode('output', { x: 600, y: 0 }, { id: 'output' }),
  ];
  doc = connectNodes(doc, { sourceNode: 'input', sourcePort: 'out', targetNode: 'skill', targetPort: 'in' });
  return connectNodes(doc, { sourceNode: 'skill', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
}

function chainDocument(count = 3, { inputType = 'object', outputType = 'object' } = {}) {
  let doc = createDocument({ title: '串联流程' });
  doc.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: inputType } }),
    ...Array.from({ length: count }, (_, index) => createNode('skill', { x: 250 * (index + 1), y: 0 }, {
      id: 'step-' + index, title: '步骤 ' + index, config: {
        inputType: index ? outputType : inputType, outputType, skillRef: 'fixture-' + index, version: revision,
      },
    })), createNode('output', { x: 1000, y: 0 }, { id: 'output' })];
  for (let index = 0; index < doc.nodes.length - 1; index++) {
    doc = connectNodes(doc, { sourceNode: doc.nodes[index].id, sourcePort: 'out', targetNode: doc.nodes[index + 1].id, targetPort: 'in' });
  }
  doc.nodes.reverse(); doc.edges.reverse();
  return doc;
}

function operationDocument(kinds, { inputType = 'object', outputType = 'object', timeoutSeconds = 120 } = {}) {
  let doc = createDocument({ title: '混合流程' });
  const nodes = [createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: inputType } }),
    ...kinds.map((kind, index) => createNode(kind === 'skill' ? 'skill' : 'tool', { x: (index + 1) * 250, y: 0 }, {
      id: 'operation-' + index, title: kind + ' ' + index, config: {
        inputType: index ? outputType : inputType, outputType, timeoutSeconds,
        ...(kind === 'skill' ? { skillRef: 'fixture-' + index, version: revision }
          : { executionMode: kind, language: 'javascript', code: 'return input;', toolName: kind === 'tool' ? 'json.parse' : '',
            ...(kind === 'tool' ? { inputType: 'any' } : {}) }),
      },
    })), createNode('output', { x: (kinds.length + 1) * 250, y: 0 }, { id: 'output' })];
  doc.nodes = nodes;
  for (let index = 0; index < nodes.length - 1; index++) {
    doc = connectNodes(doc, { sourceNode: nodes[index].id, sourcePort: 'out', targetNode: nodes[index + 1].id, targetPort: 'in' });
  }
  doc.nodes.reverse(); doc.edges.reverse();
  return doc;
}

function withLearningBranch(document, { sourceNode = 'output', targetSkillNodeIds = ['skill'] } = {}) {
  let graph = { ...document, nodes: [...document.nodes,
    createNode('evaluation', { x: 1200, y: 200 }, { id: 'compare' }),
    createNode('improvement', { x: 1500, y: 200 }, { id: 'improve', config: { targetSkillNodeIds } }),
  ] };
  graph = connectNodes(graph, { sourceNode, sourcePort: sourceNode === 'output' ? 'learning' : 'out', targetNode: 'compare', targetPort: 'in' });
  return connectNodes(graph, { sourceNode: 'compare', sourcePort: 'out', targetNode: 'improve', targetPort: 'in' });
}

function assertLearningSkipped(run, reason) {
  for (const id of ['compare', 'improve']) {
    const state = run.nodes[id];
    assert.equal(state.status, 'skipped');
    assert.equal(state.reason, reason);
    assert.equal(Object.hasOwn(state, 'input'), false);
    assert.equal(Object.hasOwn(state, 'output'), false);
    assert.equal(Object.hasOwn(state, 'runtime'), false);
    assert.equal(state.outputText, '');
    assert.equal(state.partialText, '');
    assert.equal(state.sessionId, null);
    assert.equal(state.startedAt, null);
    assert.equal(state.completedAt, null);
    assert.equal(state.error, '');
    assert.deepEqual(state.logs, { stdout: '', stderr: '' });
  }
}

function chainPreparation() {
  const prepared = [];
  const bound = [];
  const cleaned = [];
  const prepareSkill = async (_app, session, skill, context) => {
    prepared.push({ sessionId: session.id, skill, context });
    return { text: 'frozen placeholder', skill: { ...skill, bundleHash: context.stepId },
      bindInput: async input => { bound.push({ nodeId: context.nodeId, input: copy(input) }); return { text: JSON.stringify(input) }; },
      cleanup: async () => { cleaned.push(context.nodeId); },
    };
  };
  return { prepared, bound, cleaned, prepareSkill };
}

class FakeApp extends EventEmitter {
  constructor(db) {
    super();
    this.store = { db };
    this.calls = [];
    this.sequence = 0;
    this.messages = new Map();
    this.events = [];
    this.sessions = 0;
  }
  publish(type, sessionId, payload) {
    const event = { id: ++this.sequence, type, sessionId, payload };
    this.events.push(event);
    this.emit('event', event);
    return event;
  }
  async skill(name) {
    this.calls.push(['skill', name]);
    if (this.onSkill) return this.onSkill(name);
    return { name, revision, source: 'local' };
  }
  async createSession(options) {
    this.calls.push(['createSession', copy(options)]);
    const id = `session-${++this.sessions}`;
    this.messages.set(id, []);
    return { id };
  }
  workspace(name) {
    this.calls.push(['workspace', name]);
    return join(this.config.workspaceRoot, name);
  }
  async submit(id, text, options) {
    this.calls.push(['submit', id, text, copy(options)]);
    assert.equal(this.workflows.allowsSubmit(id, options.workflowRunId), true);
    if (this.onSubmit) return this.onSubmit(id, text, options);
    return { status: 'streaming' };
  }
  async history(id) {
    this.calls.push(['history', id]);
    if (this.onHistory) return this.onHistory(id);
    return { messages: copy(this.messages.get(id) || []) };
  }
  async interrupt(id) {
    this.calls.push(['interrupt', id]);
    if (this.onInterrupt) return this.onInterrupt(id);
    return { interrupted: true };
  }
}

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-runs-test-'));
  const db = new DatabaseSync(join(directory, 'workflow.sqlite'));
  const app = new FakeApp(db);
  app.config = { workspaceRoot: directory, hermesPython: 'fixture-python' };
  app.preferences = { defaultWorkspace: 'fixture-workspace' };
  let cleanups = 0;
  const prepared = [];
  const prepareSkill = options.prepareSkill || (async (_app, session, skill, context) => {
    prepared.push({ session, skill, context });
    return { text: 'PRIVATE_SKILL_INSTRUCTIONS', skill: { ...skill, bundleHash: 'bundle-test' }, cleanup: async () => { cleanups++; } };
  });
  const manager = new WorkflowRuns(app, { ...options, prepareSkill });
  app.workflows = manager;
  t.after(async () => {
    try { await app.workflows.close(); db.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  return { app, db, manager, prepared, prepareSkill, get cleanups() { return cleanups; } };
}

function finished(app, manager, id, timeout = 4500) {
  const current = manager.get(id);
  if (terminal.has(current.status)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { app.off('event', listener); reject(new Error(`No terminal event for ${id}`)); }, timeout);
    const listener = event => {
      if (event.type !== 'workflow.run' || event.payload.id !== id || !terminal.has(event.payload.status)) return;
      clearTimeout(timer); app.off('event', listener); resolve(event.payload);
    };
    app.on('event', listener);
  });
}

function complete(app, run, text, payload = {}) {
  app.messages.set(run.sessionId, [{ role: 'user', text: 'input' }, { role: 'assistant', text }]);
  app.publish('message.complete', run.sessionId, { status: 'complete', text: 'untrusted terminal text', ...payload });
}

test('streaming stays provisional; terminal result comes from exclusive session history and cleanup', async t => {
  const fixture = await setup(t);
  const { app, manager } = fixture;
  const graph = document();
  const run = await manager.start({ document: graph, input: 'hello' });
  assert.equal(run.status, 'running');
  assert.equal(run.output, null);
  assert.equal(manager.ownsSession(run.sessionId), true);
  assert.equal(manager.allowsSubmit(run.sessionId, 'another-run'), false);
  assert.match(app.calls.find(call => call[0] === 'createSession')[1].title, /^工作流 · 测试流程 · 1\/1 /);
  graph.title = 'edited after submission';
  assert.equal(manager.get(run.id).document.title, '测试流程');
  app.publish('message.delta', run.sessionId, { text: 'preview only' });
  app.publish('tool.complete', run.sessionId, { name: 'not a workflow result' });
  assert.equal(manager.get(run.id).status, 'running');
  assert.equal(manager.get(run.id).partialText, 'preview only');
  const done = finished(app, manager, run.id);
  complete(app, run, 'confirmed final answer');
  const result = await done;
  assert.equal(result.output, 'confirmed final answer');
  assert.equal(result.outputText, 'confirmed final answer');
  assert.equal(result.nodes.output.status, 'complete');
  assert.equal(result.nodes.input.output, 'hello');
  assert.equal(fixture.cleanups, 1);
  assert.equal(manager.allowsSubmit(run.sessionId, run.id), false);
  assert(!JSON.stringify(result).includes('PRIVATE_SKILL_INSTRUCTIONS'));
  assert.equal(result.skill.bundleHash, 'bundle-test');
  app.publish('message.complete', run.sessionId, { status: 'error', error: 'late duplicate' });
  assert.equal(manager.get(run.id).status, 'complete');
  assert.equal(fixture.cleanups, 1);
});

test('mixed execution skips learning controls without preparing or invoking them and completes every business node', async t => {
  const preparation = chainPreparation();
  const calls = [];
  const validated = [];
  const { app, manager } = await setup(t, { ...preparation,
    validateOperationNode: node => { validated.push(node.id); },
    executeOperation: async ({ node, input }) => {
      calls.push({ nodeId: node.id, input: copy(input) });
      return { output: { ...input, [node.id]: true } };
    },
  });
  app.onSubmit = (sessionId, text) => {
    const input = JSON.parse(text);
    app.messages.set(sessionId, [{ role: 'assistant', text: JSON.stringify({ ...input, 'operation-1': true }) }]);
    app.publish('message.complete', sessionId, { status: 'complete' });
    return { status: 'streaming' };
  };
  const graph = withLearningBranch(operationDocument(['code', 'skill', 'code']), {
    sourceNode: 'operation-0', targetSkillNodeIds: ['operation-1'],
  });
  const run = await manager.start({ document: graph, input: { task: 'start' } });
  assertLearningSkipped(run, '执行模式跳过学习支路');
  const result = await finished(app, manager, run.id);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.nodeOrder, ['input', 'operation-0', 'operation-1', 'operation-2', 'output']);
  assert(result.nodeOrder.every(id => result.nodes[id].status === 'complete'));
  assert.deepEqual(result.output, { task: 'start', 'operation-0': true, 'operation-1': true, 'operation-2': true });
  assert.deepEqual(validated, ['operation-0', 'operation-2']);
  assert.deepEqual(calls.map(call => call.nodeId), ['operation-0', 'operation-2']);
  assert.deepEqual(preparation.prepared.map(item => item.context.nodeId), ['operation-1']);
  assert.deepEqual(preparation.bound.map(item => item.nodeId), ['operation-1']);
  assert.deepEqual(preparation.cleaned, ['operation-1']);
  assert.deepEqual(result.skills.map(item => item.nodeId), ['operation-1']);
  assert.equal(app.calls.filter(call => call[0] === 'skill').length, 1);
  assert.equal(app.sessions, 1);
  assert.equal(app.calls.filter(call => call[0] === 'submit').length, 1);
  assert.equal(Object.hasOwn(result, 'memoryPolicy'), false, 'ordinary execution keeps its normal memory behavior');
  assert.equal(Object.hasOwn(preparation.prepared[0].context, 'learningId'), false);
  assert.equal(Object.hasOwn(preparation.prepared[0].context, 'memoryScopeId'), false);
  assertLearningSkipped(result, '执行模式跳过学习支路');
  assertLearningSkipped(manager.get(run.id), '执行模式跳过学习支路');
  assertLearningSkipped(manager.list(graph.id)[0], '执行模式跳过学习支路');
  for (const event of app.events.filter(item => item.type === 'workflow.run')) assertLearningSkipped(event.payload, '执行模式跳过学习支路');
});

test('learning child runs leave comparison and improvement to their controller while retaining business memory isolation', async t => {
  const learningId = '11111111-1111-4111-8111-111111111111';
  const preparation = chainPreparation();
  const { app, manager } = await setup(t, preparation);
  const graph = withLearningBranch(chainDocument(2), { sourceNode: 'step-0', targetSkillNodeIds: ['step-0'] });
  app.learning = { allowsWorkflow: (workflowId, id, scope) => workflowId === graph.id && id === learningId && scope === learningId,
    isLocked: () => true };
  app.onSubmit = (sessionId, text) => {
    app.messages.set(sessionId, [{ role: 'assistant', text }]);
    app.publish('message.complete', sessionId, { status: 'complete' });
    return { status: 'streaming' };
  };
  const created = [];
  const run = await manager.start({ document: graph, input: { sample: 'input' } }, {
    learningId, memoryScopeId: learningId, onCreated: value => created.push(value),
  });
  const result = await finished(app, manager, run.id);
  assert.equal(result.status, 'complete');
  assertLearningSkipped(created[0], '由学习控制器管理');
  assertLearningSkipped(result, '由学习控制器管理');
  assertLearningSkipped(manager.get(run.id), '由学习控制器管理');
  assert.deepEqual(result.skills.map(item => item.nodeId), ['step-0', 'step-1']);
  assert.deepEqual(preparation.prepared.map(item => item.context.nodeId), ['step-0', 'step-1']);
  assert(preparation.prepared.every(item => item.context.learningId === learningId && item.context.memoryScopeId === learningId));
  assert.deepEqual(result.memoryPolicy, { mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false });
  assert.equal(app.sessions, 2);
  assert.equal(app.calls.filter(call => call[0] === 'submit').length, 2);
  assert(result.nodeOrder.every(id => result.nodes[id].status === 'complete'));
});

test('failure and historical normalization retain skipped learning controls without inventing their I/O', async t => {
  const { app, manager, db } = await setup(t);
  const graph = withLearningBranch(document());
  const run = await manager.start({ document: graph, input: 'input' });
  const done = finished(app, manager, run.id);
  app.publish('message.complete', run.sessionId, { status: 'error', error: 'business failure' });
  const result = await done;
  assert.equal(result.nodes.skill.status, 'error');
  assert.equal(result.nodes.output.status, 'skipped');
  assertLearningSkipped(result, '执行模式跳过学习支路');
  const old = copy(result);
  old.nodes.compare = { status: 'pending', input: 'wrong inherited input', output: 'wrong inherited output', sessionId: run.sessionId };
  old.nodes.improve = { status: 'pending', runtime: { kind: 'code' }, outputText: 'wrong inherited output' };
  db.prepare('UPDATE workflow_runs SET value=? WHERE id=?').run(JSON.stringify(old), run.id);
  assertLearningSkipped(manager.get(run.id), '执行模式跳过学习支路');
  assert.equal(app.calls.filter(call => call[0] === 'submit').length, 1, 'normalization never replays work');
});

test('invalid execution configurations fail before catalog, preparation, session, or database side effects', async t => {
  const fixture = await setup(t);
  const invalid = [
    graph => { graph.mode = 'learn'; },
    graph => { graph.nodes[0].config.trigger = 'cron'; },
    graph => { graph.nodes[1].config.failurePolicy = 'retry'; },
    graph => { graph.nodes[1].config.version = 'latest'; },
    graph => { graph.nodes[1].config.skillRef = ''; },
    graph => { graph.edges.pop(); },
    graph => { graph.nodes[0].config.outputType = 'fileRef'; graph.nodes[1].config.inputType = 'fileRef'; },
  ];
  for (const change of invalid) {
    const graph = document(); change(graph);
    await assert.rejects(fixture.manager.start({ document: graph, input: 'hello' }));
  }
  await assert.rejects(fixture.manager.start({ document: document(), input: ' ' }));
  await assert.rejects(fixture.manager.start({ document: document(), input: '界'.repeat(22000) }), /64KB/);
  await assert.rejects(fixture.manager.start({ document: document({ inputType: 'number' }), input: '1' }));
  assert.deepEqual(fixture.app.calls, []);
  assert.deepEqual(fixture.prepared, []);
  assert.deepEqual(fixture.manager.list(), []);
});

test('stale Skill revision is rejected before a session or run exists', async t => {
  const { app, manager, prepared } = await setup(t);
  app.onSkill = name => ({ name, revision: `sha256:${'b'.repeat(64)}`, source: 'local' });
  await assert.rejects(manager.start({ document: document(), input: 'hello' }), /版本已变化/);
  assert.deepEqual(app.calls.map(call => call[0]), ['skill']);
  assert.deepEqual(manager.list(), []);
  assert.deepEqual(prepared, []);
});

test('preparation holds the workflow lock and early terminal beats a later submit rejection', async t => {
  const { app, manager } = await setup(t);
  let release;
  app.onSkill = name => new Promise(resolve => { release = () => resolve({ name, revision, source: 'local' }); });
  const graph = document();
  const pending = manager.start({ document: graph, input: 'hello' });
  await assert.rejects(manager.start({ document: graph, input: 'duplicate' }), error => error.httpStatus === 409);
  assert.equal(app.sessions, 0);
  app.onSubmit = id => {
    app.messages.set(id, [{ role: 'assistant', text: 'finished before RPC ACK' }]);
    app.publish('message.complete', id, { status: 'complete' });
    throw new Error('late ACK connection failure');
  };
  release();
  const run = await pending;
  const result = await finished(app, manager, run.id);
  assert.equal(result.status, 'complete');
  assert.equal(result.output, 'finished before RPC ACK');
  assert.equal(app.calls.filter(call => call[0] === 'submit').length, 1);
  assert.equal(manager.list(graph.id).length, 1);
});

test('failure, partial completion and terminal error never produce Output', async t => {
  const fixture = await setup(t);
  for (const payload of [
    { status: 'error', error: 'failed' },
    { status: 'interrupted' },
    { status: 'complete', partial: true },
    { status: 'complete', error: 'not successful' },
    { status: 'unknown' },
  ]) {
    const run = await fixture.manager.start({ document: document(), input: 'hello' });
    const done = finished(fixture.app, fixture.manager, run.id);
    fixture.app.publish('message.complete', run.sessionId, payload);
    const result = await done;
    assert.notEqual(result.status, 'complete');
    assert.equal(result.output, null);
    assert.notEqual(result.nodes.output.status, 'complete');
  }
  assert.equal(fixture.app.calls.filter(call => call[0] === 'history').length, 0);
  assert.equal(fixture.cleanups, 5);
});

test('approvals and clarify wait; interruption ACK waits for the real terminal event', async t => {
  const { app, manager } = await setup(t);
  const run = await manager.start({ document: document(), input: 'hello' });
  app.publish('request.open', run.sessionId, { id: 'approval', method: 'approval' });
  app.publish('request.open', run.sessionId, { id: 'clarify', method: 'clarify' });
  assert.equal(manager.get(run.id).status, 'waiting');
  app.publish('request.cancel', run.sessionId, { id: 'approval' });
  assert.equal(manager.get(run.id).status, 'waiting');
  app.publish('request.cancel', run.sessionId, { id: 'clarify' });
  assert.equal(manager.get(run.id).status, 'running');
  assert.equal((await manager.interrupt(run.id)).status, 'running');
  await manager.interrupt(run.id);
  assert.equal(app.calls.filter(call => call[0] === 'interrupt').length, 1);
  const done = finished(app, manager, run.id);
  app.publish('message.complete', run.sessionId, { status: 'interrupted' });
  assert.equal((await done).status, 'interrupted');
  app.publish('request.cancel', run.sessionId, { id: 'late' });
  assert.equal(manager.get(run.id).status, 'interrupted');
});

test('disconnect becomes unknown without replay and standalone error becomes error', async t => {
  const { app, manager } = await setup(t);
  const run = await manager.start({ document: document(), input: 'hello' });
  app.publish('message.complete', 'unrelated-session', { status: 'complete' });
  assert.equal(manager.get(run.id).status, 'running');
  const done = finished(app, manager, run.id);
  app.publish('backend.status', null, { state: 'disconnected' });
  assert.equal((await done).status, 'unknown');
  assert.equal(app.calls.filter(call => call[0] === 'submit').length, 1);
  const second = await manager.start({ document: document(), input: 'hello' });
  const error = finished(app, manager, second.id);
  app.publish('error', second.sessionId, { message: 'terminal runtime error' });
  assert.equal((await error).status, 'error');
});

test('timeouts request an interrupt and require confirmation; silence becomes unknown', async t => {
  const { app, manager } = await setup(t);
  const run = await manager.start({ document: document({ timeoutSeconds: 1 }), input: 'hello' });
  const result = await finished(app, manager, run.id);
  assert.equal(result.status, 'unknown');
  assert.match(result.error, /超时/);
  assert.equal(app.calls.filter(call => call[0] === 'interrupt').length, 1);
  assert.equal(result.output, null);
  complete(app, run, 'late after unknown');
  assert.equal(manager.get(run.id).status, 'unknown');
});

test('restart marks unfinished records unknown, preserves finished snapshots and never replays', async t => {
  const { app, db, manager, prepareSkill } = await setup(t);
  const completed = await manager.start({ document: document(), input: 'hello' });
  const done = finished(app, manager, completed.id);
  complete(app, completed, 'durable answer');
  await done;
  const pending = await manager.start({ document: withLearningBranch(document()), input: 'pending' });
  await manager.close();
  // Seed the durable image an abrupt process loss leaves, independently of close.
  db.prepare('UPDATE workflow_runs SET value=? WHERE id=?').run(JSON.stringify(pending), pending.id);
  const secondApp = new FakeApp(db);
  const restarted = new WorkflowRuns(secondApp, { prepareSkill });
  secondApp.workflows = restarted;
  t.after(() => restarted.close());
  assert.equal(restarted.get(pending.id).status, 'unknown');
  assertLearningSkipped(restarted.get(pending.id), '执行模式跳过学习支路');
  assert.equal(restarted.get(completed.id).output, 'durable answer');
  assert.equal(restarted.ownsSession(completed.sessionId), true);
  assert.equal(restarted.allowsSubmit(pending.sessionId, pending.id), false);
  assert.deepEqual(secondApp.calls, []);
  assert.equal(restarted.list().length, 2);
});

test('legacy completed records recover known node outputs without inventing failed outputs', async t => {
  const { manager } = await setup(t);
  for (const [index, value] of [null, false, 0, '', { done: true }].entries()) {
    const legacy = { id: 'legacy-' + index, workflowId: 'legacy-workflow', document: document(), status: 'complete',
      input: 'original', output: value, outputText: typeof value === 'string' ? value : JSON.stringify(value),
      sessionId: 'legacy-session', skill: { name: 'fixture-skill', revision }, nodes: {
        input: { status: 'complete' }, skill: { status: 'complete' }, output: { status: 'complete' },
      } };
    manager.write.run(legacy.id, JSON.stringify(legacy));
    const recovered = manager.get(legacy.id);
    for (const id of ['skill', 'output']) {
      assert.equal(Object.hasOwn(recovered.nodes[id], 'output'), true);
      assert.deepEqual(recovered.nodes[id].output, value);
      assert.equal(recovered.nodes[id].outputText, legacy.outputText);
    }
    legacy.id += '-failed'; legacy.status = 'error'; legacy.nodes.skill.status = 'error'; legacy.nodes.output.status = 'pending';
    manager.write.run(legacy.id, JSON.stringify(legacy));
    const failed = manager.get(legacy.id);
    assert.equal(Object.hasOwn(failed.nodes.skill, 'output'), false);
    assert.equal(Object.hasOwn(failed.nodes.output, 'output'), false);
  }
});

test('JSON inputs preserve zero, false and empty collections without coercion', async t => {
  const fixture = await setup(t);
  for (const [type, input] of [['number', 0], ['boolean', false], ['array', []], ['object', {}], ['any', { task: 'hello' }]]) {
    const graph = document({ inputType: type });
    const run = await fixture.manager.start({ document: graph, input });
    assert.deepEqual(run.input, input);
    assert.deepEqual(fixture.prepared.at(-1).context.input, input);
    const done = finished(fixture.app, fixture.manager, run.id);
    complete(fixture.app, run, 'result');
    await done;
  }
  const optional = document(); optional.nodes[0].config.required = false;
  const run = await fixture.manager.start({ document: optional });
  assert.equal(run.input, null);
});

test('typed results are strict JSON while any can retain plain text', async t => {
  const { app, manager } = await setup(t);
  for (const [type, text, expected, status] of [
    ['text', '{not json}', '{not json}', 'complete'],
    ['any', 'plain text', 'plain text', 'complete'],
    ['any', '17', 17, 'complete'],
    ['number', '17', 17, 'complete'],
    ['boolean', 'false', false, 'complete'],
    ['object', '{"ok":true}', { ok: true }, 'complete'],
    ['array', '[1,2]', [1, 2], 'complete'],
    ['number', '"17"', null, 'error'],
    ['object', '```json\n{}\n```', null, 'error'],
    ['number', '1e999', null, 'error'],
  ]) {
    const run = await manager.start({ document: document({ outputType: type }), input: 'hello' });
    const done = finished(app, manager, run.id);
    complete(app, run, text);
    const result = await done;
    assert.equal(result.status, status, `${type}: ${text}`);
    assert.deepEqual(result.output, expected);
  }
});

test('history must contain a final assistant message and cleanup can veto completion', async t => {
  const fixture = await setup(t);
  const run = await fixture.manager.start({ document: document(), input: 'hello' });
  fixture.app.messages.set(run.sessionId, [
    { role: 'assistant', text: 'intermediate text' },
    { role: 'assistant', text: '', tool_calls: [{ id: 'unfinished-tool' }] },
    { role: 'tool', text: 'tool output is not a final answer' },
  ]);
  const done = finished(fixture.app, fixture.manager, run.id);
  fixture.app.publish('message.complete', run.sessionId, { status: 'complete' });
  assert.equal((await done).status, 'error');

  const veto = await setup(t, { prepareSkill: async (_app, _session, skill) => ({
    text: 'prepared', skill, cleanup: async () => { throw new Error('Skill was changed'); },
  }) });
  const candidate = await veto.manager.start({ document: document(), input: 'hello' });
  const rejected = finished(veto.app, veto.manager, candidate.id);
  complete(veto.app, candidate, 'otherwise successful');
  const result = await rejected;
  assert.equal(result.status, 'error');
  assert.equal(result.output, null);
  assert.match(result.error, /收尾校验失败/);
});

test('successful Output waits for asynchronous cleanup and close invalidates pending history', async t => {
  let releaseCleanup;
  const cleanupGate = new Promise(resolve => { releaseCleanup = resolve; });
  const fixture = await setup(t, { prepareSkill: async (_app, _session, skill) => ({
    text: 'prepared', skill, cleanup: () => cleanupGate,
  }) });
  const run = await fixture.manager.start({ document: document(), input: 'hello' });
  const done = finished(fixture.app, fixture.manager, run.id);
  complete(fixture.app, run, 'confirmed');
  await immediate();
  assert.equal(fixture.manager.get(run.id).status, 'running');
  assert.equal(fixture.manager.get(run.id).output, null);
  releaseCleanup();
  assert.equal((await done).status, 'complete');

  const pending = await fixture.manager.start({ document: document(), input: 'pending' });
  let releaseHistory;
  fixture.app.onHistory = () => new Promise(resolve => { releaseHistory = resolve; });
  complete(fixture.app, pending, 'late result');
  await fixture.manager.close();
  assert.equal(fixture.manager.get(pending.id).status, 'unknown');
  releaseHistory({ messages: [{ role: 'assistant', text: 'late history' }] });
  await immediate();
  assert.equal(fixture.manager.get(pending.id).status, 'unknown');
  assert.equal(fixture.manager.get(pending.id).output, null);
});

test('closing during preparation never submits and still cleans a late preparation result', async t => {
  let release;
  let cleanups = 0;
  const fixture = await setup(t, { prepareSkill: (_app, _session, skill) => new Promise(resolve => {
    release = () => resolve({ text: 'must not submit', skill, cleanup: async () => { cleanups++; } });
  }) });
  const starting = fixture.manager.start({ document: document(), input: 'hello' });
  await immediate();
  const prepared = fixture.manager.list()[0];
  assert.equal(prepared.status, 'preparing');
  await fixture.manager.close();
  release();
  assert.equal((await starting).status, 'unknown');
  assert.equal(cleanups, 1);
  assert.equal(fixture.app.calls.filter(call => call[0] === 'submit').length, 0);
});

test('late preparation cleanup failure is retained without reviving an interrupted run', async t => {
  let release;
  const fixture = await setup(t, { prepareSkill: (_app, _session, skill) => new Promise(resolve => {
    release = () => resolve({ text: 'never submit', skill, cleanup: async () => { throw new Error('late snapshot audit failure'); } });
  }) });
  const pending = fixture.manager.start({ document: document(), input: 'hello' });
  await immediate();
  const preparing = fixture.manager.list()[0];
  assert.equal((await fixture.manager.interrupt(preparing.id)).status, 'interrupted');
  release();
  const result = await pending;
  assert.equal(result.status, 'interrupted');
  assert.match(result.error, /late snapshot audit failure/);
  assert.match(result.nodes.skill.error, /late snapshot audit failure/);
  assert.equal(result.nodes.skill.status, 'interrupted');
  assert.equal(result.nodes.output.status, 'skipped');
  assert.equal(Object.hasOwn(result.nodes.skill, 'input'), false);
  assert.equal(fixture.app.calls.filter(call => call[0] === 'submit').length, 0);
  assert.match(fixture.manager.get(result.id).error, /late snapshot audit failure/);
});

test('partial text is byte bounded and read results cannot mutate the frozen execution snapshot', async t => {
  const { app, manager } = await setup(t);
  const run = await manager.start({ document: document(), input: 'hello' });
  app.publish('message.delta', run.sessionId, { text: '界'.repeat(100000) });
  app.publish('message.delta', run.sessionId, { text: 'more' });
  assert(Buffer.byteLength(manager.get(run.id).partialText, 'utf8') <= 256 * 1024);
  run.document.title = 'client mutation';
  run.nodes.input.output = 'changed';
  assert.equal(manager.get(run.id).document.title, '测试流程');
  assert.equal(manager.get(run.id).nodes.input.output, 'hello');
  await immediate();
});

test('three shuffled Skills freeze before inference and pass typed objects in edge order', async t => {
  const preparation = chainPreparation();
  const { app, manager } = await setup(t, preparation);
  const submitted = [];
  app.onSubmit = (id, text) => {
    assert.equal(preparation.prepared.length, 3, 'all snapshots must exist before the first model call');
    const index = submitted.length;
    submitted.push({ id, input: JSON.parse(text) });
    app.publish('message.delta', id, { text: 'preview-' + index });
    app.messages.set(id, [{ role: 'assistant', text: JSON.stringify({ stage: index + 1, received: JSON.parse(text) }) }]);
    app.publish('message.complete', id, { status: 'complete' });
    return { status: 'streaming' };
  };
  const input = { task: 'start', values: [0, false] };
  const run = await manager.start({ document: chainDocument(), input });
  const result = await finished(app, manager, run.id);
  assert.deepEqual(result.nodeOrder, ['input', 'step-0', 'step-1', 'step-2', 'output']);
  assert.deepEqual(result.skills.map(skill => skill.nodeId), ['step-0', 'step-1', 'step-2']);
  assert.equal(new Set(preparation.prepared.map(item => item.context.stepId)).size, 3);
  assert(preparation.prepared.every(item => item.context.runId === run.id));
  assert.deepEqual(preparation.prepared.map(item => item.context.input), [input, null, null]);
  assert.deepEqual(preparation.bound.map(item => item.nodeId), ['step-0', 'step-1', 'step-2']);
  assert.deepEqual(submitted[0].input, input);
  assert.deepEqual(submitted[1].input, result.nodes['step-0'].output);
  assert.deepEqual(submitted[2].input, result.nodes['step-1'].output);
  for (let index = 0; index < 3; index++) {
    const node = result.nodes['step-' + index];
    assert.equal(node.status, 'complete');
    assert.deepEqual(node.input, submitted[index].input);
    assert.equal(node.partialText, 'preview-' + index);
    assert(node.startedAt && node.completedAt);
    assert.equal(manager.ownsSession(node.sessionId), true);
  }
  assert.equal(new Set(submitted.map(item => item.id)).size, 3);
  assert.equal(result.sessionId, submitted[2].id);
  assert.equal(result.skill.name, result.skills[0].name);
  assert.equal(result.partialText, 'preview-2');
  assert.deepEqual(result.nodes.output.input, result.nodes['step-2'].output);
  assert.deepEqual(result.output, result.nodes.output.output);
  assert.deepEqual(preparation.cleaned, ['step-0', 'step-1', 'step-2']);
});

test('every selected Skill revision is checked before any run, session or preparation exists', async t => {
  const preparation = chainPreparation();
  const { app, manager } = await setup(t, preparation);
  app.onSkill = name => ({ name, revision: name === 'fixture-2' ? 'sha256:' + 'b'.repeat(64) : revision, source: 'local' });
  await assert.rejects(manager.start({ document: chainDocument(), input: {} }), /版本已变化/);
  assert.deepEqual(app.calls.map(call => call[0]), ['skill', 'skill', 'skill']);
  assert.equal(app.sessions, 0);
  assert.equal(preparation.prepared.length, 0);
  assert.deepEqual(manager.list(), []);
});

test('a later snapshot preparation failure cleans earlier snapshots without calling a model', async t => {
  const preparation = chainPreparation();
  const prepareSkill = async (...args) => {
    if (args[3].nodeId === 'step-1') throw new Error('cannot freeze the second Skill');
    return preparation.prepareSkill(...args);
  };
  const { app, manager } = await setup(t, { prepareSkill });
  const run = await manager.start({ document: chainDocument(), input: {} });
  assert.equal(run.status, 'error');
  assert.equal(run.nodes['step-0'].status, 'skipped');
  assert.equal(run.nodes['step-1'].status, 'error');
  assert.equal(run.nodes['step-2'].status, 'skipped');
  assert.deepEqual(preparation.cleaned, ['step-0']);
  assert.equal(app.calls.filter(call => call[0] === 'submit').length, 0);
});

test('downstream failure, interruption and disconnect preserve completed upstream and skip future nodes', async t => {
  for (const outcome of ['error', 'interrupted', 'unknown']) {
    const preparation = chainPreparation();
    const { app, manager } = await setup(t, preparation);
    let submissions = 0;
    app.onSubmit = id => {
      if (++submissions === 1) {
        app.publish('message.delta', id, { text: 'first preview' });
        app.messages.set(id, [{ role: 'assistant', text: '{"first":true}' }]);
        app.publish('message.complete', id, { status: 'complete' });
      } else {
        app.publish('message.delta', id, { text: 'second preview' });
        app.publish('request.open', id, { id: 'question', method: 'clarify' });
      }
      return { status: 'streaming' };
    };
    const run = await manager.start({ document: chainDocument(), input: {} });
    await immediate();
    const active = manager.get(run.id);
    assert.equal(active.currentNodeId, 'step-1');
    assert.equal(active.status, 'waiting');
    const upstream = copy(active.nodes['step-0']);
    const done = finished(app, manager, run.id);
    if (outcome === 'unknown') app.publish('backend.status', null, { state: 'disconnected' });
    else {
      if (outcome === 'interrupted') await manager.interrupt(run.id);
      app.publish('message.complete', active.sessionId, { status: outcome });
    }
    const result = await done;
    assert.equal(result.status, outcome);
    assert.deepEqual(result.nodes['step-0'], upstream);
    assert.deepEqual(result.nodes['step-1'].input, { first: true });
    assert.equal(result.nodes['step-1'].partialText, 'second preview');
    assert.equal(result.nodes['step-1'].status, outcome);
    assert.equal(result.nodes['step-2'].status, 'skipped');
    assert.equal(Object.hasOwn(result.nodes['step-2'], 'input'), false);
    assert.equal(Object.hasOwn(result.nodes.output, 'input'), false);
    assert.equal(result.nodes.output.status, 'skipped');
    assert.equal(submissions, 2);
    assert.equal(preparation.cleaned.length, 3);
  }
});

test('late events and a rejected old ACK cannot affect the current downstream step', async t => {
  const preparation = chainPreparation();
  const { app, manager } = await setup(t, preparation);
  let rejectOldAck;
  let submissions = 0;
  app.onSubmit = id => {
    const index = submissions++;
    if (index === 0) {
      app.messages.set(id, [{ role: 'assistant', text: '{"first":true}' }]);
      app.publish('message.complete', id, { status: 'complete' });
      return new Promise((_resolve, reject) => { rejectOldAck = reject; });
    }
    if (index === 2) {
      app.messages.set(id, [{ role: 'assistant', text: '{"last":true}' }]);
      app.publish('message.complete', id, { status: 'complete' });
    }
    return { status: 'streaming' };
  };
  const starting = manager.start({ document: chainDocument(), input: {} });
  await immediate();
  const active = manager.list()[0];
  assert.equal(active.currentNodeId, 'step-1');
  const oldSession = active.nodes['step-0'].sessionId;
  assert.equal(manager.ownsSession(oldSession), true);
  assert.equal(manager.allowsSubmit(oldSession, active.id), false);
  assert.equal(manager.allowsSubmit(active.sessionId, active.id), true);
  app.publish('message.delta', oldSession, { text: 'late old preview' });
  app.publish('message.complete', oldSession, { status: 'error', error: 'late old error' });
  app.publish('error', oldSession, { message: 'late event' });
  rejectOldAck(new Error('old ACK failed'));
  const returned = await starting;
  assert.equal(returned.status, 'running');
  assert.equal(returned.currentNodeId, 'step-1');
  assert.equal(returned.nodes['step-1'].partialText, '');
  const done = finished(app, manager, active.id);
  app.messages.set(active.sessionId, [{ role: 'assistant', text: '{"second":true}' }]);
  app.publish('message.complete', active.sessionId, { status: 'complete' });
  assert.equal((await done).status, 'complete');
});

test('intermediate null remains explicit, and oversized or mismatched handoffs stop before downstream submission', async t => {
  for (const [firstType, secondType, text, expected] of [
    ['any', 'any', 'null', 'complete'],
    ['any', 'object', '17', 'error'],
    ['text', 'text', 'x'.repeat(65536), 'error'],
  ]) {
    const preparation = chainPreparation();
    const { app, manager } = await setup(t, preparation);
    let graph = chainDocument(2, { inputType: 'object', outputType: firstType });
    graph.nodes.find(node => node.id === 'step-1').config.inputType = secondType;
    let submissions = 0;
    app.onSubmit = id => {
      app.messages.set(id, [{ role: 'assistant', text: submissions++ === 0 ? text : 'null' }]);
      app.publish('message.complete', id, { status: 'complete' });
      return { status: 'streaming' };
    };
    const run = await manager.start({ document: graph, input: {} });
    const result = await finished(app, manager, run.id);
    assert.equal(result.status, expected);
    assert.equal(result.nodes['step-0'].status, text.length > 65535 ? 'error' : 'complete');
    if (expected === 'complete') {
      assert.equal(Object.hasOwn(result.nodes['step-1'], 'input'), true);
      assert.equal(result.nodes['step-1'].input, null);
      assert.equal(Object.hasOwn(result.nodes.output, 'output'), true);
      assert.equal(result.nodes.output.output, null);
    } else {
      assert.equal(submissions, 1);
      assert.equal(result.nodes['step-1'].status, text.length > 65535 ? 'skipped' : 'error');
      assert.equal(result.nodes.output.status, 'skipped');
    }
  }
});

test('restart in the middle preserves completed node data and owns every historical step session', async t => {
  const preparation = chainPreparation();
  const { app, manager, db } = await setup(t, preparation);
  let submissions = 0;
  app.onSubmit = id => {
    if (++submissions === 1) {
      app.messages.set(id, [{ role: 'assistant', text: '{"done":1}' }]);
      app.publish('message.complete', id, { status: 'complete' });
    }
    return { status: 'streaming' };
  };
  const run = await manager.start({ document: chainDocument(), input: {} });
  await immediate();
  const snapshot = manager.get(run.id);
  assert.equal(snapshot.currentNodeId, 'step-1');
  await manager.close();
  db.prepare('UPDATE workflow_runs SET value=? WHERE id=?').run(JSON.stringify(snapshot), run.id);
  const secondApp = new FakeApp(db);
  const restarted = new WorkflowRuns(secondApp, { prepareSkill: preparation.prepareSkill });
  secondApp.workflows = restarted;
  const recovered = restarted.get(run.id);
  assert.equal(recovered.status, 'unknown');
  assert.deepEqual(recovered.nodes['step-0'], snapshot.nodes['step-0']);
  assert.equal(recovered.nodes['step-1'].status, 'unknown');
  assert.equal(recovered.nodes['step-2'].status, 'skipped');
  for (const node of Object.values(recovered.nodes).filter(node => node.sessionId)) {
    assert.equal(restarted.ownsSession(node.sessionId), true);
    assert.equal(restarted.allowsSubmit(node.sessionId, run.id), false);
  }
  assert.deepEqual(secondApp.calls, []);
  await restarted.close();
});

test('Skill, code, tool and Skill execute in edge order after every Skill snapshot is frozen', async t => {
  const preparation = chainPreparation();
  const localCalls = [];
  const validations = [];
  const { app, manager } = await setup(t, { ...preparation,
    validateOperationNode: node => { validations.push(node.id); },
    executeOperation: async options => {
      localCalls.push(options);
      assert.equal(preparation.prepared.length, 2);
      assert.equal(options.pythonPath, 'fixture-python');
      assert.equal(options.cwd, join(app.config.workspaceRoot, 'fixture-workspace'));
      assert.equal(options.signal.aborted, false);
      const active = manager.list()[0];
      assert.equal(active.sessionId, null);
      assert.equal(active.currentNodeId, options.node.id);
      options.onLog({ stream: 'stdout', text: 'log-' + options.node.id });
      options.onLog({ stream: 'stderr', text: 'diagnostic', truncated: true });
      return { output: options.node.config.executionMode === 'code'
        ? JSON.stringify({ ...options.input, code: true }) : { ...JSON.parse(options.input), tool: true },
        runtime: { kind: options.node.config.executionMode, revision: 'fixture-runtime' } };
    },
  });
  let submitted = 0;
  app.onSubmit = (id, text) => {
    assert.equal(preparation.prepared.length, 2);
    const input = JSON.parse(text);
    const output = submitted++ ? { ...input, final: true } : { ...input, first: true };
    app.messages.set(id, [{ role: 'assistant', text: JSON.stringify(output) }]);
    app.publish('message.complete', id, { status: 'complete' });
    return { status: 'streaming' };
  };
  const graph = operationDocument(['skill', 'code', 'tool', 'skill']);
  graph.nodes.find(node => node.id === 'operation-1').config.outputType = 'text';
  graph.nodes.find(node => node.id === 'operation-2').config.inputType = 'text';
  const run = await manager.start({ document: graph, input: { n: 0, flag: false } });
  const result = await finished(app, manager, run.id);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.nodeOrder, ['input', 'operation-0', 'operation-1', 'operation-2', 'operation-3', 'output']);
  assert.deepEqual(result.skills.map(skill => skill.nodeId), ['operation-0', 'operation-3']);
  assert.deepEqual(validations, ['operation-1', 'operation-2']);
  assert.deepEqual(preparation.prepared.map(item => item.context.input), [{ n: 0, flag: false }, null]);
  assert.equal(app.sessions, 2);
  assert.equal(submitted, 2);
  assert.equal(localCalls.length, 2);
  for (let index = 1; index < 4; index++) {
    assert.deepEqual(result.nodes['operation-' + index].input, result.nodes['operation-' + (index - 1)].output);
  }
  for (const index of [1, 2]) {
    const node = result.nodes['operation-' + index];
    assert.equal(node.sessionId, null);
    assert.equal(node.status, 'complete');
    assert.equal(node.logs.stdout, 'log-operation-' + index);
    assert.equal(node.logs.stderrTruncated, true);
    assert.equal(node.runtime.revision, 'fixture-runtime');
  }
  for (const index of [0, 3]) assert.equal(manager.ownsSession(result.nodes['operation-' + index].sessionId), true);
  assert.equal(result.sessionId, result.nodes['operation-3'].sessionId);
  assert.equal(result.skill.name, 'fixture-0');
  assert.deepEqual(result.output, { n: 0, flag: false, first: true, code: true, tool: true, final: true });
});

test('code-only returns an immediate acknowledgment, survives Hermes disconnect and creates no sessions', async t => {
  let finishFirst;
  let firstLog;
  let executions = 0;
  const { app, manager, prepared } = await setup(t, {
    validateOperationNode: () => {},
    executeOperation: options => {
      if (++executions === 1) {
        firstLog = options.onLog;
        return new Promise(resolve => { finishFirst = resolve; });
      }
      return { output: options.input, runtime: { kind: 'code', language: 'javascript' } };
    },
  });
  const run = await manager.start({ document: operationDocument(['code', 'code']), input: { typed: [false, 0, null] } });
  assert.equal(run.status, 'running');
  assert.equal(run.sessionId, null);
  assert.equal(run.skill, null);
  assert.deepEqual(run.skills, []);
  assert.equal(app.sessions, 0);
  assert.deepEqual(prepared, []);
  await assert.rejects(manager.start({ document: run.document, input: {} }), error => error.httpStatus === 409);
  app.publish('backend.status', null, { state: 'disconnected' });
  app.publish('message.complete', null, { status: 'error', error: 'not a local worker event' });
  assert.equal(manager.get(run.id).status, 'running');
  firstLog({ stream: 'stdout', text: '界'.repeat(20000) });
  firstLog({ stream: 'stderr', text: 'failure detail survives normal completion' });
  finishFirst({ output: { result: [false, 0, null] }, runtime: { kind: 'code', language: 'javascript' } });
  const result = await finished(app, manager, run.id);
  assert.equal(result.status, 'complete');
  assert.equal(result.sessionId, null);
  assert.equal(executions, 2);
  assert.deepEqual(result.output, { result: [false, 0, null] });
  assert(Buffer.byteLength(result.nodes['operation-0'].logs.stdout, 'utf8') <= 32 * 1024);
  assert.equal(result.nodes['operation-0'].logs.stdoutTruncated, true);
  const snapshot = copy(result);
  firstLog({ stream: 'stdout', text: 'late logging must be ignored' });
  assert.deepEqual(manager.get(run.id), snapshot);
  assert.deepEqual(app.calls.map(call => call[0]), ['workspace']);
});

test('all code/tool validation and all Skill versions are checked before local execution or records', async t => {
  let operations = 0;
  const validation = await setup(t, { validateOperationNode: node => {
    if (node.id === 'operation-2') throw new Error('unavailable builtin');
  }, executeOperation: async () => { operations++; return { output: {} }; } });
  await assert.rejects(validation.manager.start({ document: operationDocument(['skill', 'code', 'tool']), input: {} }), /unavailable builtin/);
  assert.deepEqual(validation.app.calls, []);
  assert.deepEqual(validation.manager.list(), []);

  const stale = await setup(t, { validateOperationNode: () => {}, executeOperation: async () => { operations++; return { output: {} }; } });
  stale.app.onSkill = name => ({ name, revision: 'sha256:' + 'b'.repeat(64), source: 'local' });
  await assert.rejects(stale.manager.start({ document: operationDocument(['code', 'skill']), input: {} }), /版本已变化/);
  assert.equal(stale.app.sessions, 0);
  assert.deepEqual(stale.manager.list(), []);
  assert.deepEqual(stale.prepared, []);
  assert.equal(operations, 0);
});

test('code at the start waits for later Skill snapshots, then binds the actual typed local result', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const preparation = chainPreparation();
  let executions = 0;
  const { app, manager } = await setup(t, { ...preparation,
    prepareSkill: async (...args) => { await gate; return preparation.prepareSkill(...args); },
    validateOperationNode: () => {}, executeOperation: async () => {
      executions++;
      assert.equal(preparation.prepared.length, 1);
      return { output: { local: [false, 0, null] } };
    },
  });
  app.onSubmit = (id, text) => {
    app.messages.set(id, [{ role: 'assistant', text }]);
    app.publish('message.complete', id, { status: 'complete' });
    return { status: 'streaming' };
  };
  const pending = manager.start({ document: operationDocument(['code', 'skill']), input: {} });
  await immediate();
  assert.equal(manager.list()[0].status, 'preparing');
  assert.equal(executions, 0);
  assert.equal(app.calls.filter(call => call[0] === 'submit').length, 0);
  release();
  const run = await pending;
  const result = await finished(app, manager, run.id);
  assert.equal(result.status, 'complete');
  assert.equal(preparation.prepared[0].context.input, null);
  assert.deepEqual(preparation.bound[0].input, { local: [false, 0, null] });
  assert.deepEqual(result.output, { local: [false, 0, null] });
});

test('local failure preserves upstream Skill output and logs while skipping every downstream operation', async t => {
  const preparation = chainPreparation();
  let executions = 0;
  const { app, manager } = await setup(t, { ...preparation, validateOperationNode: () => {},
    executeOperation: async ({ onLog }) => {
      executions++;
      onLog({ stream: 'stderr', text: 'worker failed after this diagnostic' });
      throw Object.assign(new Error('code process failed'), { code: 'CODE_FAILED' });
    },
  });
  app.onSubmit = id => {
    app.messages.set(id, [{ role: 'assistant', text: '{"upstream":true}' }]);
    app.publish('message.complete', id, { status: 'complete' });
    return { status: 'streaming' };
  };
  const run = await manager.start({ document: operationDocument(['skill', 'code', 'tool', 'skill']), input: {} });
  const result = await finished(app, manager, run.id);
  assert.equal(result.status, 'error');
  assert.equal(result.nodes['operation-0'].status, 'complete');
  assert.deepEqual(result.nodes['operation-0'].output, { upstream: true });
  assert.equal(result.nodes['operation-1'].status, 'error');
  assert.equal(result.nodes['operation-1'].logs.stderr, 'worker failed after this diagnostic');
  assert.match(result.nodes['operation-1'].error, /code process failed/);
  for (const id of ['operation-2', 'operation-3', 'output']) {
    assert.equal(result.nodes[id].status, 'skipped');
    assert.equal(Object.hasOwn(result.nodes[id], 'input'), false);
  }
  assert.equal(executions, 1);
  assert.equal(app.calls.filter(call => call[0] === 'submit').length, 1);
  assert.equal(preparation.cleaned.length, 2);
});

test('stopping local code aborts immediately and ignores late output, logs and old Hermes events', async t => {
  const preparation = chainPreparation();
  let release;
  let log;
  let signal;
  let executions = 0;
  const { app, manager } = await setup(t, { ...preparation, validateOperationNode: () => {},
    executeOperation: options => {
      executions++; signal = options.signal; log = options.onLog;
      return new Promise(resolve => { release = resolve; });
    },
  });
  app.onSubmit = id => {
    app.messages.set(id, [{ role: 'assistant', text: '{"kept":true}' }]);
    app.publish('message.complete', id, { status: 'complete' });
    return { status: 'streaming' };
  };
  const run = await manager.start({ document: operationDocument(['skill', 'code', 'tool', 'skill']), input: {} });
  await immediate();
  const active = manager.get(run.id);
  assert.equal(active.currentNodeId, 'operation-1');
  assert.equal(active.sessionId, null);
  const upstream = copy(active.nodes['operation-0']);
  const oldSession = upstream.sessionId;
  app.publish('message.delta', oldSession, { text: 'old Skill cannot mutate local node' });
  app.publish('error', oldSession, { message: 'late old Skill failure' });
  assert.equal(manager.get(run.id).status, 'running');
  const result = await manager.interrupt(run.id);
  assert.equal(signal.aborted, true);
  assert.equal(result.status, 'interrupted');
  assert.deepEqual(result.nodes['operation-0'], upstream);
  assert.equal(result.nodes['operation-1'].status, 'interrupted');
  assert.equal(result.nodes['operation-2'].status, 'skipped');
  assert.equal(result.nodes['operation-3'].status, 'skipped');
  assert.equal(app.calls.filter(call => call[0] === 'interrupt').length, 0);
  log({ stream: 'stdout', text: 'late log' });
  release({ output: { must: 'not continue' } });
  await immediate();
  assert.deepEqual(manager.get(run.id), result);
  assert.equal(executions, 1);
  assert.equal(manager.ownsSession(oldSession), true);
  assert.equal(manager.allowsSubmit(oldSession, run.id), false);
});

test('local timeouts and close abort workers without waiting for late executor settlement', async t => {
  for (const outcome of ['timeout', 'close']) {
    let signal;
    let release;
    const { app, manager } = await setup(t, { validateOperationNode: () => {}, executeOperation: options => {
      signal = options.signal;
      return new Promise(resolve => { release = resolve; });
    } });
    const run = await manager.start({ document: operationDocument(['code', 'tool'], { timeoutSeconds: 1 }), input: {} });
    if (outcome === 'close') await manager.close();
    const result = await finished(app, manager, run.id);
    assert.equal(signal.aborted, true);
    assert.equal(result.status, outcome === 'close' ? 'unknown' : 'error');
    assert.equal(result.nodes['operation-0'].status, result.status);
    assert.equal(result.nodes['operation-1'].status, 'skipped');
    assert.equal(result.output, null);
    release({ output: { late: true } });
    await immediate();
    assert.deepEqual(manager.get(run.id), result);
  }
});

test('Hermes disconnect aborts a mixed local step and prevents its frozen downstream Skill from running', async t => {
  const preparation = chainPreparation();
  let signal;
  let release;
  const { app, manager } = await setup(t, { ...preparation, validateOperationNode: () => {}, executeOperation: options => {
    signal = options.signal;
    return new Promise(resolve => { release = resolve; });
  } });
  const run = await manager.start({ document: operationDocument(['code', 'skill']), input: {} });
  const done = finished(app, manager, run.id);
  app.publish('backend.status', null, { state: 'disconnected' });
  const result = await done;
  assert.equal(signal.aborted, true);
  assert.equal(result.status, 'unknown');
  assert.equal(result.nodes['operation-0'].status, 'unknown');
  assert.equal(result.nodes['operation-1'].status, 'skipped');
  assert.equal(app.calls.filter(call => call[0] === 'submit').length, 0);
  assert.equal(preparation.cleaned.length, 1);
  release({ output: { late: true } });
  await immediate();
  assert.deepEqual(manager.get(run.id), result);
});

test('local outputs retain exact JSON values and reject mismatches, undefined and oversized results', async t => {
  for (const [type, value, expected] of [
    ['text', 'result', 'complete'], ['any', null, 'complete'], ['number', 0, 'complete'], ['boolean', false, 'complete'],
    ['object', { nested: [false, null] }, 'complete'], ['array', [], 'complete'],
    ['object', 'not an object', 'error'], ['number', Infinity, 'error'], ['any', undefined, 'error'],
    ['text', 'x'.repeat(65536), 'error'],
  ]) {
    const { app, manager } = await setup(t, { validateOperationNode: () => {}, executeOperation: async () => ({ output: value }) });
    const run = await manager.start({ document: operationDocument(['code'], { outputType: type }), input: {} });
    const result = await finished(app, manager, run.id);
    assert.equal(result.status, expected, type + ': ' + String(value).slice(0, 20));
    if (expected === 'complete') {
      assert.equal(Object.hasOwn(result.nodes['operation-0'], 'output'), true);
      assert.deepEqual(result.output, value);
      assert.deepEqual(result.nodes.output.input, value);
    } else {
      assert.equal(Object.hasOwn(result.nodes['operation-0'], 'output'), false);
      assert.equal(result.nodes.output.status, 'skipped');
      assert.equal(result.output, null);
    }
    assert.equal(app.sessions, 0);
  }
});

test('restarting an active local step preserves prior results and never replays code', async t => {
  let executions = 0;
  const options = { validateOperationNode: () => {}, executeOperation: async ({ input }) => {
    if (++executions === 1) return { output: { ...input, retained: true } };
    return new Promise(() => {});
  } };
  const { app, manager, db } = await setup(t, options);
  const run = await manager.start({ document: operationDocument(['code', 'tool', 'code']), input: { original: true } });
  await immediate();
  const snapshot = manager.get(run.id);
  assert.equal(snapshot.currentNodeId, 'operation-1');
  await manager.close();
  manager.write.run(run.id, JSON.stringify(snapshot));
  const nextApp = new FakeApp(db);
  const restarted = new WorkflowRuns(nextApp, options);
  nextApp.workflows = restarted;
  const recovered = restarted.get(run.id);
  assert.equal(recovered.status, 'unknown');
  assert.deepEqual(recovered.nodes['operation-0'], snapshot.nodes['operation-0']);
  assert.equal(recovered.nodes['operation-1'].status, 'unknown');
  assert.equal(recovered.nodes['operation-2'].status, 'skipped');
  assert.equal(recovered.sessionId, null);
  assert.deepEqual(nextApp.calls, []);
  assert.equal(executions, 2);
  assert.equal(app.sessions, 0);
  await restarted.close();
});
