import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowLearning } from '../src/workflows/workflow-learning.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const revision = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const CONTENT = '---\nname: fixture\ndescription: Generic fixture\n---\nUse the old generic method.';
const TERMINAL = new Set(['complete', 'exhausted', 'error', 'interrupted', 'unknown']);

function graph(count = 1, mixed = true, comparison = 'exact') {
  let doc = createDocument({ title: '学习测试' }); doc.mode = 'learn';
  doc.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: 'text', trigger: 'manual' } }),
    ...Array.from({ length: count }, (_, index) => createNode('skill', { x: 250, y: index * 100 }, { id: 'skill-' + index,
      config: { inputType: 'text', outputType: 'text', skillRef: 'fixture-' + index, version: revision(CONTENT) } })),
    ...(mixed ? [createNode('tool', { x: 500, y: 0 }, { id: 'code', config: {
      inputType: 'text', outputType: 'text', executionMode: 'code', language: 'javascript', code: 'return input;',
    } }), createNode('tool', { x: 750, y: 0 }, { id: 'tool', config: {
      inputType: 'text', outputType: 'text', executionMode: 'tool', toolName: 'text.trim',
    } })] : []), createNode('output', { x: 1000, y: 0 }, { id: 'output' })];
  const order = doc.nodes.map(node => node.id);
  for (let index = 0; index < order.length - 1; index++) {
    doc = connectNodes(doc, { sourceNode: order[index], sourcePort: 'out', targetNode: order[index + 1], targetPort: 'in' });
  }
  doc.nodes.push(createNode('evaluation', {x: 1100, y: 200}, {id:'evaluation', config:{comparison}}),
    createNode('improvement', {x:1400,y:200}, {id:'improvement', config:{targetSkillNodeIds:Array.from({length:count},(_,i)=>'skill-'+i)}}));
  doc = connectNodes(doc,{sourceNode:'output',sourcePort:'learning',targetNode:'evaluation',targetPort:'in'});
  doc = connectNodes(doc,{sourceNode:'evaluation',sourcePort:'out',targetNode:'improvement',targetPort:'in'});
  doc.nodes.reverse(); doc.edges.reverse();
  return doc;
}

class FakeApp extends EventEmitter {
  constructor(db) {
    super(); this.store = { db }; this.events = []; this.skillCalls = []; this.created = []; this.prompts = [];
    this.memoryScopeRequests = []; this.memoryScopeReleases = []; this.memoryScopes = new Map(); this.generationScopes = [];
    this.skills = new Map([0, 1, 2].map(index => ['fixture-' + index, {
      name: 'fixture-' + index, content: CONTENT, revision: revision(CONTENT), source: 'local',
    }]));
    this.workflows = {
      locks: new Map(), runs: new Map(), calls: [], interrupts: [], scopeIds: [],
      start: (payload, options) => {
        const scope = this.memoryScopes.get(options.memoryScopeId);
        assert(scope && scope.mode === 'batch-snapshot' && scope.memoryWriteAllowed === false && scope.externalMemoryAllowed === false,
          'a complete batch memory scope is required before every sample');
        assert.equal(this.learning.allowsWorkflow(payload.document.id, options.learningId, options.memoryScopeId), true);
        this.workflows.scopeIds.push(options.memoryScopeId);
        this.workflows.calls.push(copy(payload));
        const run = { id: randomUUID(), workflowId: payload.document.id, learningId: options.learningId,
          status: 'running', document: copy(payload.document), input: copy(payload.input), output: null };
        options.onCreated(run);
        this.workflows.runs.set(run.id, run); this.workflows.locks.set(run.workflowId, run.id);
        this.publish('workflow.run', null, copy(run));
        if (this.onStart) return this.onStart(run, payload);
        queueMicrotask(() => this.complete(run.id, this.outputFor ? this.outputFor(payload) : 'target'));
        return Promise.resolve(copy(run));
      },
      interrupt: async id => {
        this.workflows.interrupts.push(id);
        const run = this.workflows.runs.get(id);
        if (run && !['complete', 'error', 'unknown', 'interrupted'].includes(run.status)) this.complete(id, null, 'interrupted');
        return copy(run || { id, status: 'unknown' });
      },
    };
    this.learnedSkills = { create: (base, options) => {
      const name = 'candidate-' + (this.created.length + 1);
      const candidate = { name, ref: name, content: options.content, revision: revision(options.content), source: 'learned' };
      this.created.push({ base: copy(base), options: copy(options), candidate }); this.skills.set(name, candidate);
      return copy(candidate);
    } };
    const sessions = new Set();
    this.learningModel = {
      createMemoryScope: async options => {
        this.memoryScopeRequests.push(options);
        const sessionId = 'scope-session-' + this.memoryScopeRequests.length; sessions.add(sessionId); options.onSession?.(sessionId);
        const scope = this.onCreateMemoryScope ? await this.onCreateMemoryScope(options)
          : { id: options.id, mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false };
        this.memoryScopes.set(options.id, scope);
        return scope;
      },
      releaseMemoryScope: async id => {
        this.memoryScopeReleases.push(id);
        if (this.onReleaseMemoryScope) return this.onReleaseMemoryScope(id);
        this.memoryScopes.delete(id);
      },
      generate: async (prompt, options) => {
        const scope = this.memoryScopes.get(options.memoryScopeId);
        assert(scope && scope.mode === 'batch-snapshot' && scope.memoryWriteAllowed === false && scope.externalMemoryAllowed === false,
          'evaluation, diagnosis and optimization must use the confirmed batch scope');
        this.generationScopes.push(options.memoryScopeId);
        this.prompts.push(prompt);
        const id = 'model-' + this.prompts.length; sessions.add(id); options.onSession(id);
        if (this.onGenerate) return this.onGenerate(prompt, options);
        return JSON.stringify({ content: CONTENT.replace('old', 'good'), summary: 'Improve the generic method.' });
      },
      ownsSession: id => sessions.has(id), allowsSubmit: (id, token) => sessions.has(id) && token === 'allowed',
    };
  }
  async skill(name) {
    this.skillCalls.push(name);
    if (this.onSkill) return this.onSkill(name);
    const result = this.skills.get(name);
    if (!result) throw new Error('unknown fixture Skill');
    return copy(result);
  }
  publish(type, sessionId, payload) {
    const event = { type, sessionId, payload }; this.events.push(event); this.emit('event', event); return event;
  }
  complete(id, output, status = 'complete', extra = {}) {
    const run = this.workflows.runs.get(id);
    Object.assign(run, { output, status, ...extra }); this.workflows.locks.delete(run.workflowId);
    this.publish('workflow.run', null, copy(run));
  }
}

function setup(t) {
  const db = new DatabaseSync(':memory:'); const app = new FakeApp(db); const manager = new WorkflowLearning(app);
  app.learning = manager;
  t.after(async () => { await app.learning.close(); db.close(); });
  return { app, manager, db };
}

test('a persistent human review resumes its original run and immutable batch after controller restart without replay or validation leakage', async t => {
  const { app, manager } = setup(t), directory = await mkdtemp(join(tmpdir(), 'learning-review-restart-'));
  t.after(async () => rm(directory, { force: true, recursive: true }));
  let document = graph(1, false); document.schemaVersion = 2; document.settings = { maxConcurrency: 4, outputDirectory: '' };
  document.edges = document.edges.filter(edge => !(edge.sourceNode === 'skill-0' && edge.targetNode === 'output'));
  document.nodes.push(createNode('human', { x: 700, y: 0 }, { id: 'review', config: { inputType: 'text', outputType: 'text', reviewTargetNodeId: 'skill-0' } }));
  document = connectNodes(document, { sourceNode: 'skill-0', sourcePort: 'out', targetNode: 'review', targetPort: 'in' });
  document = connectNodes(document, { sourceNode: 'review', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
  app.backend = { state: 'ready' }; app.workflows.get = id => copy(app.workflows.runs.get(id));
  const snapshotPath = join(directory, 'original-memory.json'), restores = [];
  app.onCreateMemoryScope = async options => {
    assert.equal(options.persist, true);
    const data = JSON.stringify({ memory: 'MEMORY_BEFORE_TRAINING', user: 'BASELINE_USER_PROFILE' });
    await writeFile(snapshotPath, data, { flag: 'wx' });
    return { id: options.id, mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false,
      snapshot: { version: 1, scopeId: options.id, digest: revision(data) } };
  };
  app.learningModel.suspendMemoryScope = id => app.memoryScopes.delete(id);
  app.learningModel.restoreMemoryScope = async ({ id, snapshot }) => {
    const bytes = await readFile(snapshotPath, 'utf8');
    assert.equal(revision(bytes), snapshot.digest); assert(!bytes.includes('PRIVATE_VALIDATION'));
    const scope = { id, mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false, snapshot };
    app.memoryScopes.set(id, scope); restores.push({ id, observedMemory: JSON.parse(bytes).memory }); return scope;
  };
  let held;
  const completedNodes = (run, output) => ({
    'skill-0': { status: 'complete', input: run.input, output }, review: { status: 'complete', input: output, output },
    output: { status: 'complete', input: output, output },
  });
  app.onStart = run => {
    run.memoryScopeId = run.learningId;
    const baseline = run.document.nodes.find(node => node.id === 'skill-0').config.skillRef === 'fixture-0';
    const output = baseline && run.input !== 'PRIVATE_VALIDATION_INPUT' ? 'old result' : 'target';
    if (baseline && run.input === 'second training input') {
      held = run;
      run.status = 'waiting_review'; run.nodes = { 'skill-0': { status: 'complete', input: run.input, output }, review: { status: 'waiting_review' }, output: { status: 'pending' } };
      app.publish('workflow.run', null, copy(run)); return Promise.resolve(copy(run));
    }
    queueMicrotask(() => app.complete(run.id, output, 'complete', { nodes: completedNodes(run, output) }));
    return Promise.resolve(copy(run));
  };
  app.onGenerate = prompt => { assert(!prompt.includes('PRIVATE_VALIDATION_INPUT')); return JSON.stringify({ content: CONTENT.replace('old', 'good'), summary: 'Improve generic method.' }); };
  const started = await manager.start({ document, trainingCases: [{ id: 'first', input: 'first training input', expected: 'target' },
    { id: 'second', input: 'second training input', expected: 'target' }],
    validationCases: [{ id: 'validation', input: 'PRIVATE_VALIDATION_INPUT', expected: 'target' }], maxRounds: 2 });
  for (let index = 0; index < 100 && manager.get(started.id).phase !== 'waiting-review'; index++) await immediate();
  assert.equal(manager.get(started.id).phase, 'waiting-review'); assert.equal(app.workflows.calls.length, 2);
  const originalRunId = held.id;
  await manager.close();
  assert.equal(manager.get(started.id).status, 'waiting'); assert.equal(app.workflows.interrupts.length, 0);
  assert.equal(app.memoryScopeReleases.length, 0);
  app.memoryScopes.clear(); app.backend.state = 'stopped';
  const restarted = new WorkflowLearning(app); app.learning = restarted;
  assert.equal(restarted.get(started.id).recovery.state, 'awaiting-backend');
  assert.equal(restarted.get(started.id).activeRunId, originalRunId); assert.equal(app.workflows.calls.length, 2);
  assert.equal(restarted.allowsWorkflow(document.id, started.id, started.id), false);
  await assert.rejects(restarted.prepareReviewResume(started.id), /连接 Hermes/);
  app.backend.state = 'ready'; app.publish('backend.status', null, { state: 'ready' });
  for (let index = 0; index < 100 && restarted.get(started.id).recovery.state !== 'restored'; index++) await immediate();
  assert.equal(restarted.get(started.id).recovery.state, 'restored'); assert.equal(app.workflows.calls.length, 2);
  assert.deepEqual(restores, [{ id: started.id, observedMemory: 'MEMORY_BEFORE_TRAINING' }]);
  app.complete(originalRunId, 'old result', 'complete', { nodes: completedNodes(held, 'old result') });
  for (let index = 0; index < 200 && !TERMINAL.has(restarted.get(started.id).status); index++) await immediate();
  const result = restarted.get(started.id);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.equal(result.rounds[0].cases[1].runId, originalRunId);
  assert.equal(app.workflows.calls.length, 6, 'completed training and pending review are never replayed');
  assert.equal(app.memoryScopeRequests.length, 1, 'restart must not capture current memory');
  assert.equal(app.created.length, 1); assert.equal(app.prompts.length, 1);
  assert(!app.prompts[0].includes('PRIVATE_VALIDATION_INPUT'));
  assert(app.generationScopes.every(id => id === started.id));
  assert.equal(app.memoryScopeReleases.at(-1), started.id);
});

test('a business-specific code rejection cannot widen Skill-only learning into repairing downstream code', async t => {
  const { app, manager } = setup(t);
  let document = createDocument({ schemaVersion: 2, title: '受控计划拒绝' }); document.mode = 'learn';
  document.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: 'object' } }),
    createNode('skill', { x: 200, y: 0 }, { id: 'skill-0', config: { inputType: 'object', outputType: 'object', skillRef: 'fixture-0', version: revision(CONTENT) } }),
    createNode('tool', { x: 400, y: 0 }, { id: 'render', config: { executionMode: 'code', language: 'javascript', code: 'return input;', inputType: 'object', outputType: 'object' } }),
    createNode('human', { x: 500, y: 0 }, { id: 'review', config: { inputType: 'object', outputType: 'object', reviewTargetNodeId: 'skill-0' } }),
    createNode('output', { x: 600, y: 0 }, { id: 'output' }),
    createNode('evaluation', { x: 700, y: 200 }, { id: 'evaluation', config: { comparison: 'exact' } }),
    createNode('improvement', { x: 900, y: 200 }, { id: 'improvement', config: { targetSkillNodeIds: ['skill-0'] } })];
  for (const [sourceNode, sourcePort, targetNode] of [['input', 'out', 'skill-0'], ['skill-0', 'out', 'render'],
    ['render', 'out', 'review'], ['review', 'out', 'output'], ['output', 'learning', 'evaluation'], ['evaluation', 'out', 'improvement']]) {
    document = connectNodes(document, { sourceNode, sourcePort, targetNode, targetPort: 'in' });
  }
  app.onCreateMemoryScope = async options => ({ id: options.id, mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false,
    snapshot: { version: 1, scopeId: options.id, digest: 'sha256:' + 'a'.repeat(64) } });
  app.onStart = run => {
    const skill = run.document.nodes.find(node => node.id === 'skill-0');
    if (skill.config.skillRef === 'fixture-0') queueMicrotask(() => app.complete(run.id, null, 'error', {
      failedNodeIds: ['render'], currentNodeId: 'render', error: 'Business constraint rejected the generated plan',
      nodes: { 'skill-0': { status: 'complete', input: { allowedValues: ['option-a'] }, output: { fontSize: 18 } },
        render: { status: 'error', errorCode: 'CUSTOM_PLAN_REJECTED', learningRecoverable: true, error: 'Business constraint rejected the generated plan' },
        output: { status: 'blocked' } },
    }));
    else queueMicrotask(() => app.complete(run.id, { valid: true }, 'complete', { nodes: { 'skill-0': { status: 'complete', input: {}, output: {} }, output: { status: 'complete', output: { valid: true } } } }));
    return Promise.resolve(copy(run));
  };
  const started = await manager.start({ document, input: { rawFile: 'test-only.json' }, expected: { valid: true }, maxRounds: 2 });
  for (let index = 0; index < 200 && !TERMINAL.has(manager.get(started.id).status); index++) await immediate();
  const result = manager.get(started.id);
  assert.equal(result.status, 'error', JSON.stringify(result));
  assert.equal(app.prompts.length, 0, 'Skill-only learning cannot repair an unrelated business code rejection.');
  assert.equal(app.created.length, 0);
});

function finished(app, manager, id) {
  const current = manager.get(id);
  if (TERMINAL.has(current.status)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { app.off('event', listener); reject(new Error('learning did not finish')); }, 3000);
    const listener = event => {
      if (event.type !== 'learning.run' || event.payload.id !== id || !TERMINAL.has(event.payload.status)) return;
      clearTimeout(timer); app.off('event', listener); resolve(event.payload);
    };
    app.on('event', listener);
  });
}

test('exact baseline compares normalized text and typed JSON without invoking an optimizer', async t => {
  for (const [actual, expected] of [['  target\r\nline\r\n', 'target\nline'], ['', ''], [{ b: [0, false], a: null }, { a: null, b: [0, false] }]]) {
    const { app, manager } = setup(t); app.outputFor = () => actual;
    const document = graph(1, false);
    document.nodes.find(node => node.id === 'skill-0').config.outputType = 'any';
    const started = await manager.start({ document, input: 'sample', expected });
    const result = await finished(app, manager, started.id);
    assert.equal(result.status, 'complete'); assert.equal(result.reason, 'target');
    assert.equal(result.bestScore, 100); assert.equal(result.bestRound, 0); assert.equal(result.rounds.length, 1);
    assert.equal(result.rounds[0].document.mode, 'execute'); assert.equal(result.document.mode, 'learn');
    assert.equal(app.prompts.length, 0); assert.equal(app.created.length, 0);
    assert.equal(app.workflows.calls.length, 1); assert.equal(manager.isLocked(result.workflowId), false);
    assert.equal(manager.get(result.id).activeRunId, null);
  }
});

test('preflight rejects invalid settings, pure code learning and stale references without runs or models', async t => {
  const { app, manager } = setup(t);
  const good = { document: graph(), input: 'sample', expected: 'target' };
  const invalid = [
    { maxRounds: 0 }, { maxRounds: 11 }, { targetScore: 0 }, { targetScore: 101 }, { comparison: 'anything' },
    { rubric: 'x'.repeat(8001) }, { trainableNodeIds: [] }, { trainableNodeIds: ['code'] },
    { trainableNodeIds: ['skill-0', 'skill-0'] }, { validationCases: [{ expected: 'x', input: 17 }] },
    { validationCases: Array.from({ length: 20 }, (_, index) => ({ input: 'x-' + index, expected: 'y' })) },
    { input: 17 }, { expected: '界'.repeat(22000) }, { unexpected: true },
  ];
  for (const fields of invalid) await assert.rejects(manager.start({ ...good, ...fields }));
  const missing = { ...good }; delete missing.expected; await assert.rejects(manager.start(missing));
  const noSkill = graph(); noSkill.nodes = noSkill.nodes.filter(node => node.id !== 'skill-0');
  noSkill.edges = noSkill.edges.filter(edge => edge.sourceNode !== 'skill-0' && edge.targetNode !== 'skill-0');
  noSkill.edges.push({ id: 'replacement', sourceNode: 'input', sourcePort: 'out', targetNode: 'code', targetPort: 'in' });
  await assert.rejects(manager.start({ ...good, document: noSkill }), /Skill/);
  assert.deepEqual(app.skillCalls, []); assert.deepEqual(manager.list(), []);
  app.skills.get('fixture-0').content += 'changed';
  await assert.rejects(manager.start(good), /版本/);
  assert.deepEqual(manager.list(), []); assert.deepEqual(app.workflows.calls, []); assert.deepEqual(app.prompts, []);
});

test('two exact rounds run every full mixed case and retain isolated candidates with original metadata', async t => {
  const { app, manager } = setup(t);
  app.outputFor = ({ document, input }) => document.nodes.find(node => node.id === 'skill-0').config.skillRef.startsWith('candidate-')
    ? (input === 'train' ? 'target' : 'PRIVATE_VALIDATION_EXPECTED') : 'old';
  app.onGenerate = () => JSON.stringify({ content: CONTENT.replace('name: fixture', 'name: forbidden-new-name').replace('old', 'good'), summary: 'General improvement.' });
  const source = graph();
  const started = await manager.start({ document: source, input: 'train', expected: 'target',
    validationCases: [{ input: 'PRIVATE_VALIDATION_INPUT', expected: 'PRIVATE_VALIDATION_EXPECTED' }] });
  source.nodes.find(node => node.id === 'code').config.code = 'throw new Error("edited later");';
  const result = await finished(app, manager, started.id);
  assert.equal(result.status, 'complete'); assert.deepEqual(result.rounds.map(round => round.index), [0, 1]);
  assert.deepEqual(result.rounds.map(round => round.score), [0, 100]); assert.equal(result.bestRound, 1);
  assert.equal(app.workflows.calls.length, 4); assert.equal(app.created.length, 1);
  assert(!app.prompts[0].includes('PRIVATE_VALIDATION_INPUT')); assert(!app.prompts[0].includes('PRIVATE_VALIDATION_EXPECTED'));
  assert(app.prompts[0].includes('不会额外收到 rubric 或已知答案'));
  assert(app.prompts[0].includes('可以重写、精简或替换与目标冲突的旧正文'));
  assert(app.created[0].candidate.content.startsWith('---\nname: fixture\n'));
  assert.equal(app.skills.get('fixture-0').content, CONTENT);
  assert.equal(result.rounds[1].changes[0].nodeId, 'skill-0'); assert.equal(result.rounds[1].changes[0].summary, 'General improvement.');
  assert.equal(result.rounds[1].changes[0].before.ref, 'fixture-0'); assert.equal(result.rounds[1].changes[0].after.ref, 'candidate-1');
  for (const call of app.workflows.calls) {
    assert.equal(call.document.nodes.find(node => node.id === 'code').config.code, 'return input;');
    assert.deepEqual(call.document.edges, result.rounds[0].document.edges);
  }
  const modelId = 'model-1'; assert.equal(manager.ownsSession(modelId), true);
  assert.equal(manager.allowsSubmit(modelId, 'allowed'), true); assert.equal(manager.allowsSubmit(modelId, 'wrong'), false);
});

test('model scoring uses minimum case score, rolls back regressions and rotates editable Skills', async t => {
  const { app, manager } = setup(t);
  let evaluations = 0; let proposals = 0;
  const scores = [80, 85, 70, 75, 96, 95];
  app.onGenerate = prompt => {
    if (prompt.includes('独立结果评估器')) return JSON.stringify({ scores: [{ score: scores[evaluations++], feedback: 'grade' }], feedback: 'aggregate' });
    proposals++;
    return JSON.stringify({ content: CONTENT.replace('old', 'better-' + proposals), summary: 'change-' + proposals });
  };
  const started = await manager.start({ document: graph(2, true, 'model'), input: 'train', expected: 'target', comparison: 'model',
    maxRounds: 3, targetScore: 90, validationCases: [{ input: 'held-out', expected: 'held-out-answer' }] });
  const result = await finished(app, manager, started.id);
  assert.equal(result.status, 'complete'); assert.deepEqual(result.rounds.map(round => round.score), [80, 70, 95]);
  assert.equal(result.bestRound, 2); assert.equal(result.bestScore, 95);
  assert.equal(result.rounds[1].changes[0].nodeId, 'skill-0'); assert.equal(result.rounds[2].changes[0].nodeId, 'skill-1');
  assert.equal(result.rounds[2].document.nodes.find(node => node.id === 'skill-0').config.skillRef, 'fixture-0');
  assert.equal(app.created[1].base.name, 'fixture-1');
  assert.equal(app.workflows.calls.length, 6);
  for (const prompt of app.prompts.filter(prompt => prompt.includes('Skill 正文编辑器'))) assert(!prompt.includes('held-out'));
  const optimizerPrompts = app.prompts.filter(prompt => prompt.includes('Skill 正文编辑器'));
  assert(optimizerPrompts[1].includes('change-1'));
  assert(optimizerPrompts[1].includes('better-1'));
  assert(optimizerPrompts[1].includes('"score":70'));
});

test('maximum rounds includes baseline and never silently publishes below-target candidates', async t => {
  const { app, manager } = setup(t); app.outputFor = () => 'wrong';
  const started = await manager.start({ document: graph(), input: 'train', expected: 'target', maxRounds: 1 });
  const result = await finished(app, manager, started.id);
  assert.equal(result.status, 'exhausted'); assert.equal(result.reason, 'maxRounds');
  assert.equal(result.rounds.length, 1); assert.equal(result.bestScore, 0); assert.equal(result.bestRound, 0);
  assert.equal(app.prompts.length, 0); assert.equal(app.created.length, 0);
});

test('unchanged or already attempted candidates exhaust the search while preserving the best version', async t => {
  for (const unchanged of [true, false]) {
    const { app, manager } = setup(t); app.outputFor = () => 'wrong';
    if (unchanged) app.onGenerate = () => JSON.stringify({ content: CONTENT, summary: 'No useful change.' });
    const started = await manager.start({ document: graph(), input: 'train', expected: 'target', maxRounds: 5 });
    const result = await finished(app, manager, started.id);
    assert.equal(result.status, 'exhausted'); assert.equal(result.reason, 'unchanged');
    assert.equal(result.bestRound, 0); assert.equal(result.bestScore, 0);
    assert.equal(result.error, ''); assert.equal(app.created.length, unchanged ? 0 : 1);
    assert.equal(result.rounds.length, unchanged ? 1 : 2);
  }
});

test('malformed or out-of-range model grades never update best or create a candidate', async t => {
  for (const response of ['not JSON', JSON.stringify({ scores: [], feedback: '' }), JSON.stringify({ scores: [{ score: 101, feedback: '' }], feedback: '' })]) {
    const { app, manager } = setup(t); app.onGenerate = () => response;
    const started = await manager.start({ document: graph(1, true, 'model'), input: 'train', expected: 'target', comparison: 'model' });
    const result = await finished(app, manager, started.id);
    assert.equal(result.status, 'error'); assert.equal(result.bestRound, null); assert.equal(result.bestDocument, null);
    assert.equal(app.created.length, 0);
  }
});

test('only selected Skill format errors are learnable and failed rounds can never become best', async t => {
  const { app, manager } = setup(t);
  app.onStart = run => {
    queueMicrotask(() => {
      const skill = run.document.nodes.find(node => node.id === 'skill-0');
      if (skill.config.skillRef.startsWith('candidate-')) app.complete(run.id, 'target');
      else app.complete(run.id, null, 'error', { currentNodeId: 'skill-0', error: 'Skill 最终结果不是有效的 object JSON。',
        nodes: { 'skill-0': { partialText: 'not JSON; untrusted preview' } } });
    });
    return copy(run);
  };
  const started = await manager.start({ document: graph(), input: 'train', expected: 'target' });
  const result = await finished(app, manager, started.id);
  assert.equal(result.status, 'complete'); assert.equal(result.rounds[0].score, 0);
  assert.equal(result.rounds[0].status, 'error'); assert.equal(result.rounds[0].cases[0].recoverable, true);
  assert.equal(Object.hasOwn(result.rounds[0].cases[0], 'output'), false);
  assert.equal(result.bestRound, 1); assert.equal(result.bestScore, 100);
  assert(app.prompts[0].includes('not JSON; untrusted preview'));
  for (const [status, nodeId, error] of [['unknown', 'skill-0', 'lost connection'], ['interrupted', 'skill-0', 'stopped'],
    ['error', 'code', '输入必须是 object 类型。'], ['error', 'skill-0', 'Skill 收尾校验失败：Skill 最终结果必须是 object 类型。']]) {
    const fixture = setup(t);
    fixture.app.onStart = run => { queueMicrotask(() => fixture.app.complete(run.id, null, status, { currentNodeId: nodeId, error })); return run; };
    const candidate = await fixture.manager.start({ document: graph(), input: 'train', expected: 'target' });
    const rejected = await finished(fixture.app, fixture.manager, candidate.id);
    assert.equal(rejected.status, status); assert.equal(rejected.bestRound, null); assert.equal(fixture.app.created.length, 0);
  }
});

test('stop during child preparation is retained, stops the child and ignores late success', async t => {
  const { app, manager } = setup(t);
  app.onStart = run => copy(run);
  const started = await manager.start({ document: graph(), input: 'train', expected: 'target' });
  await immediate();
  const active = manager.get(started.id); assert(active.activeRunId);
  app.publish('workflow.run', null, { ...app.workflows.runs.get(active.activeRunId), status: 'waiting' });
  assert.equal(manager.get(started.id).status, 'waiting');
  assert.equal(manager.isLocked(active.workflowId), true); assert.equal(manager.allowsWorkflow(active.workflowId, active.id, active.memoryScopeId), true);
  await assert.rejects(manager.start({ document: active.document, input: 'other', expected: 'target' }), error => error.httpStatus === 409);
  const waiting = finished(app, manager, started.id);
  await manager.interrupt(started.id);
  const result = await waiting;
  assert.equal(result.status, 'interrupted'); assert.equal(manager.allowsWorkflow(active.workflowId, active.id), false);
  assert(app.workflows.interrupts.includes(active.activeRunId));
  app.complete(active.activeRunId, 'target'); await immediate();
  assert.equal(manager.get(started.id).status, 'interrupted'); assert.equal(app.prompts.length, 0);
});

test('stop during model work aborts its signal and never persists a late candidate', async t => {
  const { app, manager } = setup(t); app.outputFor = () => 'wrong';
  let release; let signal;
  app.onGenerate = (_prompt, options) => { signal = options.signal; return new Promise(resolve => { release = resolve; }); };
  const started = await manager.start({ document: graph(), input: 'train', expected: 'target' });
  await immediate(); assert.equal(manager.get(started.id).phase, 'optimizing');
  await manager.interrupt(started.id); assert.equal(signal.aborted, true);
  release(JSON.stringify({ content: CONTENT.replace('old', 'late'), summary: 'late' }));
  const result = await finished(app, manager, started.id);
  assert.equal(result.status, 'interrupted'); assert.equal(app.created.length, 0);
  assert.equal(app.workflows.calls.length, 1);
});

test('source drift during an optimizer call rejects the proposal without creating a candidate', async t => {
  for (const unchanged of [false, true]) {
    const { app, manager } = setup(t); app.outputFor = () => 'wrong';
    app.onGenerate = () => {
      app.skills.get('fixture-0').content += '\nchanged externally';
      return JSON.stringify({ content: unchanged ? CONTENT : CONTENT.replace('old', 'new'), summary: 'new' });
    };
    const started = await manager.start({ document: graph(), input: 'train', expected: 'target' });
    const result = await finished(app, manager, started.id);
    assert.equal(result.status, 'error'); assert.match(result.error, /版本/); assert.equal(app.created.length, 0);
  }
});

test('disconnect, close and restart keep every round and never replay learning', async t => {
  const { app, manager, db } = setup(t); app.onStart = run => run;
  const started = await manager.start({ document: graph(), input: 'train', expected: 'target' });
  await immediate(); const snapshot = manager.get(started.id);
  app.publish('backend.status', null, { state: 'disconnected' });
  assert.equal(manager.get(started.id).status, 'unknown');
  const before = app.workflows.calls.length;
  await manager.close();
  manager.write.run(snapshot.id, JSON.stringify(snapshot));
  const restarted = new WorkflowLearning(app); app.learning = restarted;
  const recovered = restarted.get(snapshot.id);
  assert.equal(recovered.status, 'unknown'); assert.equal(recovered.reason, 'restart');
  assert.equal(recovered.rounds.length, snapshot.rounds.length); assert.equal(recovered.rounds[0].cases[0].runId, snapshot.rounds[0].cases[0].runId);
  assert.equal(app.workflows.calls.length, before); assert.equal(app.prompts.length, 0);
  assert.equal(restarted.isLocked(snapshot.workflowId), false);
});

test('an old child start rejection cannot replace a later case result', async t => {
  const { app, manager } = setup(t);
  let rejectOld; let secondId;
  app.onStart = run => {
    if (app.workflows.calls.length === 1) {
      queueMicrotask(() => app.complete(run.id, 'target'));
      return new Promise((_resolve, reject) => { rejectOld = reject; });
    }
    secondId = run.id; return run;
  };
  const started = await manager.start({ document: graph(), input: 'train', expected: 'target', maxRounds: 1,
    validationCases: [{ input: 'validation', expected: 'target' }] });
  await immediate(); assert(secondId);
  rejectOld(new Error('late old ACK')); await immediate();
  assert.equal(manager.get(started.id).status, 'running');
  app.complete(secondId, 'target');
  const result = await finished(app, manager, started.id);
  assert.equal(result.status, 'complete'); assert.equal(result.rounds[0].cases.length, 2);
});

test('closing before a child is created interrupts the late child without touching the closed manager', async t => {
  const { app, manager } = setup(t);
  const originalStart = app.workflows.start;
  let release;
  app.workflows.start = (payload, options) => new Promise((resolve, reject) => { release = () => {
    try { resolve(originalStart(payload, options)); } catch (error) { reject(error); }
  }; });
  app.onStart = run => run;
  const started = await manager.start({ document: graph(), input: 'train', expected: 'target' });
  await immediate(); assert.equal(manager.get(started.id).activeRunId, null);
  await manager.close();
  release(); await immediate();
  assert.equal(manager.get(started.id).status, 'unknown');
  assert.equal(app.workflows.interrupts.length, 0);
  assert.equal(app.workflows.calls.length, 0);
  assert.equal(app.prompts.length, 0); assert.equal(app.created.length, 0);
});

test('CRLF source metadata remains unchanged while candidate storage uses canonical LF', async t => {
  for (const content of [CONTENT.replace(/\n/g, '\r\n'),
    '\uFEFF' + CONTENT.replace('\n---\nUse', '\n---  \nUse').replace(/\n/g, '\r\n')]) {
    const { app, manager } = setup(t);
    app.skills.set('fixture-0', { name: 'fixture-0', content, revision: revision(content), source: 'local' });
    const document = graph(); document.nodes.find(node => node.id === 'skill-0').config.version = revision(content);
    app.outputFor = ({ document }) => document.nodes.find(node => node.id === 'skill-0').config.skillRef === 'fixture-0' ? 'old' : 'target';
    const started = await manager.start({ document, input: 'train', expected: 'target' });
    const result = await finished(app, manager, started.id);
    assert.equal(result.status, 'complete'); assert.equal(app.created.length, 1);
    assert(!app.created[0].candidate.content.includes('\r'));
    assert.equal(app.created[0].candidate.content.split('Use the')[0], content.replace(/\r\n?/g, '\n').split('Use the')[0]);
    assert.equal(result.rounds[1].changes[0].before.content, content);
    assert.equal(app.skills.get('fixture-0').content, content);
  }
});

test('multiple training samples all drive improvement, preserve identities and exclude validation evidence', async t => {
  const { app, manager } = setup(t);
  const trainingCases = [{ id: 'first', name: '第一例', input: 'train-first', expected: 'answer-first' },
    { id: 'second', name: '非首例失败', input: 'train-NON_FIRST', expected: 'answer-NON_FIRST' }];
  const validationCases = [{ id: 'held', name: '验证', input: 'VAL_INPUT_SENTINEL', expected: 'VAL_EXPECTED_SENTINEL' }];
  const answers = new Map([...trainingCases, ...validationCases].map(item => [item.input, item.expected]));
  app.outputFor = ({ document, input }) => input === trainingCases[1].input
    && document.nodes.find(node => node.id === 'skill-0').config.skillRef === 'fixture-0' ? 'wrong second answer' : answers.get(input);
  const started = await manager.start({ document: graph(), trainingCases, validationCases });
  const result = await finished(app, manager, started.id);
  assert.equal(result.status, 'complete'); assert.equal(result.rounds.length, 2); assert.equal(app.workflows.calls.length, 6);
  assert.deepEqual(result.config.trainingCases, trainingCases);
  assert.deepEqual(result.rounds[0].cases.map(({ id, name, role }) => ({ id, name, role })), [
    { id: 'first', name: '第一例', role: 'train' }, { id: 'second', name: '非首例失败', role: 'train' }, { id: 'held', name: '验证', role: 'validation' },
  ]);
  assert.equal(result.rounds[0].metrics.train.passRate, 0.5); assert.equal(result.rounds[0].metrics.validation.passRate, 1);
  assert.equal(result.rounds[0].metrics.overall.passRate, 2 / 3); assert.equal(result.rounds[1].metrics.overall.passRate, 1);
  assert(app.prompts[0].includes('train-NON_FIRST')); assert(app.prompts[0].includes('answer-NON_FIRST'));
  assert(app.prompts[0].includes('wrong second answer'));
  for (const prompt of app.prompts) { assert(!prompt.includes('VAL_INPUT_SENTINEL')); assert(!prompt.includes('VAL_EXPECTED_SENTINEL')); }
});

test('new dataset API rejects ambiguity and invalid totals before any Skill or model work', async t => {
  const { app, manager } = setup(t);
  const document = graph();
  const trainingCases = [{ input: 'a', expected: 'target' }];
  for (const fields of [{ trainingCases, input: 'old' }, { trainingCases, expected: 'old' }, { trainingCases: [] },
    { trainingCases, validationCases: [{ input: 'a', expected: 'target' }] },
    { trainingCases: Array.from({ length: 21 }, (_, index) => ({ input: 'x' + index, expected: 'target' })) },
    { trainingCases: Array.from({ length: 5 }, (_, index) => ({ input: 'x'.repeat(30000) + index, expected: 'y'.repeat(30000) })) },
  ]) await assert.rejects(manager.start({ document, ...fields }));
  assert.deepEqual(app.skillCalls, []); assert.deepEqual(app.workflows.calls, []); assert.deepEqual(manager.list(), []);
});

test('equal minimum score can still promote a round with more passing samples, balanced with validation', async t => {
  const { app, manager } = setup(t);
  const trainingCases = Array.from({ length: 3 }, (_, index) => ({ input: 'train-' + index, expected: 'answer-' + index }));
  const validationCases = [{ input: 'VAL_HIDDEN_INPUT', expected: 'VAL_HIDDEN_ANSWER' }];
  const grades = [0, 80, 95, 100, 0, 95, 95, 100]; let graded = 0;
  app.onGenerate = prompt => prompt.includes('独立结果评估器')
    ? JSON.stringify({ scores: [{ score: grades[graded++], feedback: 'grade' }], feedback: 'one case' })
    : JSON.stringify({ content: CONTENT.replace('old', 'good'), summary: 'more cases pass' });
  const started = await manager.start({ document: graph(1, true, 'model'), trainingCases, validationCases, comparison: 'model', maxRounds: 2 });
  const result = await finished(app, manager, started.id);
  assert.equal(result.status, 'exhausted'); assert.deepEqual(result.rounds.map(round => round.score), [0, 0]);
  assert.equal(result.bestRound, 1); assert.equal(result.bestScore, 0);
  assert.equal(result.rounds[0].metrics.train.passRate, 1 / 3); assert.equal(result.rounds[1].metrics.train.passRate, 2 / 3);
  assert.equal(result.rounds[1].metrics.overall.passed, 3); assert.equal(result.rounds[1].metrics.overall.total, 4);
  const optimizer = app.prompts.find(prompt => prompt.includes('Skill 正文编辑器'));
  assert(!optimizer.includes('VAL_HIDDEN_INPUT')); assert(!optimizer.includes('VAL_HIDDEN_ANSWER'));
});

test('a large training improvement cannot promote a version that loses its validation group', async t => {
  const { app, manager } = setup(t);
  const trainingCases = [0, 1, 2].map(index => ({ input: 'train-' + index, expected: 'answer-' + index }));
  const grades = [95, 0, 0, 100, 95, 95, 95, 0]; let graded = 0;
  app.onGenerate = prompt => prompt.includes('独立结果评估器')
    ? JSON.stringify({ scores: [{ score: grades[graded++], feedback: 'grade' }], feedback: 'one example' })
    : JSON.stringify({ content: CONTENT.replace('old', 'different'), summary: 'training-only attempt' });
  const started = await manager.start({ document: graph(1, true, 'model'), trainingCases,
    validationCases: [{ input: 'validation', expected: 'validation-answer' }], comparison: 'model', maxRounds: 2 });
  const result = await finished(app, manager, started.id);
  assert.equal(result.status, 'exhausted'); assert.equal(result.bestRound, 0);
  assert.equal(result.rounds[1].metrics.train.passRate, 1); assert.equal(result.rounds[1].metrics.validation.passRate, 0);
  assert(result.rounds[1].metrics.overall.passRate > result.rounds[0].metrics.overall.passRate);
});

test('twenty model-evaluated samples use complete per-case prompts and retain the full denominator', async t => {
  const { app, manager } = setup(t);
  const trainingCases = Array.from({ length: 20 }, (_, index) => ({ id: 'sample-' + index, name: '样例 ' + index,
    input: 'INPUT_NOT_NEEDED_FOR_GRADING_' + index, expected: 'answer-' + index }));
  const answers = new Map(trainingCases.map(item => [item.input, item.expected]));
  app.outputFor = ({ input }) => answers.get(input);
  app.onGenerate = prompt => {
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    assert.equal(payload.cases.length, 1); assert.equal(payload.cases[0].expected, payload.cases[0].output);
    assert(!prompt.includes('INPUT_NOT_NEEDED_FOR_GRADING_'));
    return JSON.stringify({ scores: [{ score: 100, feedback: 'matches' }], feedback: 'one complete example' });
  };
  const started = await manager.start({ document: graph(1, true, 'model'), trainingCases, comparison: 'model', maxRounds: 1 });
  const result = await finished(app, manager, started.id);
  assert.equal(result.status, 'complete'); assert.equal(app.workflows.calls.length, 20); assert.equal(app.prompts.length, 20);
  assert.equal(result.rounds[0].metrics.overall.total, 20); assert.equal(result.rounds[0].metrics.overall.evaluated, 20);
  assert.equal(result.rounds[0].metrics.overall.passRate, 1); assert.equal(result.rounds[0].metrics.validation.total, 0);
  assert.equal(result.rounds[0].metrics.validation.passRate, null);
});

test('stopping execution or partial grading retains missing samples and never reports a partial 100% pass rate', async t => {
  for (const phase of ['executing', 'evaluating']) {
    const { app, manager } = setup(t);
    const trainingCases = Array.from({ length: 3 }, (_, index) => ({ input: 'train-' + index, expected: 'target' }));
    let release; let evaluations = 0;
    if (phase === 'executing') app.onStart = run => run;
    else app.onGenerate = () => ++evaluations === 1 ? JSON.stringify({ scores: [{ score: 100, feedback: 'first passed' }], feedback: 'first' })
      : new Promise(resolve => { release = resolve; });
    const started = await manager.start({ document: graph(1, true, phase === 'evaluating' ? 'model' : 'exact'), trainingCases, comparison: phase === 'evaluating' ? 'model' : 'exact' });
    await immediate();
    const active = manager.get(started.id); assert.equal(active.phase, phase);
    assert.equal(active.rounds[0].cases.length, 3); assert.equal(active.rounds[0].metrics.overall.total, 3);
    assert.equal(active.rounds[0].metrics.overall.passRate, null);
    const terminal = finished(app, manager, started.id);
    await manager.interrupt(started.id);
    if (release) release(JSON.stringify({ scores: [{ score: 100, feedback: 'late' }], feedback: 'late' }));
    const result = await terminal;
    assert.equal(result.status, 'interrupted'); assert.equal(result.rounds[0].cases.length, 3);
    assert.equal(result.rounds[0].metrics.overall.passRate, null); assert.equal(result.bestRound, null);
    assert.equal(result.rounds[0].metrics.overall.passed, phase === 'evaluating' ? 1 : 0);
    assert(result.rounds[0].metrics.overall.pending >= 2);
  }
});

test('legacy records gain read-only derived metrics without enforcing new dataset constraints or changing the stored best', async t => {
  const { manager, db } = setup(t);
  const legacy = { id: 'legacy', workflowId: 'legacy-workflow', status: 'complete', document: graph(),
    input: 'x'.repeat(300000), expected: 'target', config: { comparison: 'exact', targetScore: 90,
      validationCases: [{ input: 'x'.repeat(300000), expected: 'target' }] }, bestRound: 0, bestScore: 100,
    rounds: [{ index: 0, status: 'complete', score: 100, cases: [
      { role: 'train', status: 'complete', output: 'target', score: 100 },
      { role: 'validation', status: 'complete', output: 'target', score: 100 },
    ] }] };
  const stored = JSON.stringify(legacy); manager.write.run(legacy.id, stored);
  for (const job of [manager.get(legacy.id), manager.list(legacy.workflowId)[0]]) {
    assert.equal(job.bestRound, 0); assert.equal(job.rounds[0].metrics.overall.passRate, 1);
    assert.equal(job.rounds[0].cases[0].id, 'train-1'); assert.equal(job.rounds[0].cases[1].id, 'validation-1');
    assert.equal(job.config.trainingCases[0].input.length, 300000);
    assert.deepEqual(job.memoryPolicy, { mode: 'legacy', memoryWriteAllowed: null, externalMemoryAllowed: null });
    assert.equal(job.memoryScopeId, null);
  }
  assert.equal(db.prepare('SELECT value FROM workflow_learning WHERE id=?').get(legacy.id).value, stored);
});

test('restart preserves the fixed dataset and pending denominator without executing another case', async t => {
  const { app, manager, db } = setup(t);
  app.onStart = run => {
    if (app.workflows.calls.length === 1) queueMicrotask(() => app.complete(run.id, 'target'));
    return run;
  };
  const started = await manager.start({ document: graph(), trainingCases: [
    { id: 'a', input: 'first', expected: 'target' }, { id: 'b', input: 'second', expected: 'target' },
  ], validationCases: [{ id: 'c', input: 'third', expected: 'target' }] });
  await immediate(); const snapshot = manager.get(started.id);
  assert.equal(snapshot.rounds[0].cases[0].status, 'complete'); assert.equal(snapshot.rounds[0].cases[1].status, 'running');
  await manager.close(); manager.write.run(started.id, JSON.stringify(snapshot));
  const runs = app.workflows.calls.length; const restarted = new WorkflowLearning(app); app.learning = restarted;
  const recovered = restarted.get(started.id);
  assert.equal(recovered.status, 'unknown'); assert.deepEqual(recovered.rounds[0].cases.map(item => item.id), ['a', 'b', 'c']);
  assert.equal(recovered.rounds[0].cases[0].status, 'complete'); assert.equal(recovered.rounds[0].cases[0].output, 'target');
  assert.equal(recovered.rounds[0].cases[1].status, 'unknown'); assert.equal(recovered.rounds[0].cases[2].status, 'pending');
  assert.equal(recovered.rounds[0].metrics.overall.total, 3); assert.equal(recovered.rounds[0].metrics.overall.pending, 3);
  assert.equal(recovered.rounds[0].metrics.overall.passRate, null); assert.equal(app.workflows.calls.length, runs);
});

test('large optimizer context diagnoses all training evidence without truncation or validation leakage', async t => {
  const { app, manager } = setup(t);
  const trainingCases = [0, 1].map(index => ({ id: 'large-' + index, input: 'FULL_INPUT_' + index + 'i'.repeat(50000),
    expected: 'FULL_EXPECTED_' + index + 'e'.repeat(30000) }));
  const validationCases = [{ input: 'VALIDATION_DO_NOT_DIAGNOSE', expected: 'VALIDATION_DO_NOT_REWRITE' }];
  const output = 'FULL_OUTPUT_' + 'o'.repeat(50000); app.outputFor = () => output;
  let diagnosticCalls = 0;
  app.onGenerate = prompt => {
    assert(prompt.length <= 190000);
    assert(!prompt.includes('VALIDATION_DO_NOT_DIAGNOSE')); assert(!prompt.includes('VALIDATION_DO_NOT_REWRITE'));
    if (prompt.startsWith('你是训练样例诊断器')) {
      diagnosticCalls++;
      const evidence = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
      if (Object.hasOwn(evidence, 'output')) assert.equal(evidence.output, output);
      if (Object.hasOwn(evidence, 'input')) assert.equal(evidence.input, trainingCases.find(item => item.id === evidence.id).input);
      assert.equal(evidence.expected, trainingCases.find(item => item.id === evidence.id).expected);
      return JSON.stringify({ diagnosis: 'Use a general consistent transformation for ' + evidence.id });
    }
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    assert.equal(payload.trainingCases.length, 2); assert(payload.trainingCases.every(item => typeof item.diagnosis === 'string'));
    return JSON.stringify({ content: CONTENT.replace('old', 'good'), summary: 'general correction' });
  };
  const started = await manager.start({ document: graph(), trainingCases, validationCases, maxRounds: 2 });
  const result = await finished(app, manager, started.id);
  assert.equal(result.status, 'exhausted'); assert.equal(result.rounds[0].optimizerContext, 'diagnostics');
  assert.equal(diagnosticCalls, 6); assert.equal(result.rounds[0].diagnostics.length, 2);
  for (const entry of result.rounds[0].diagnostics) assert(entry.attempts.best && entry.attempts.latest && entry.summary);
  assert.equal(result.rounds[0].metrics.overall.total, 3); assert.equal(app.created.length, 1);
  assert.equal(app.memoryScopeRequests.length, 1);
  assert(app.workflows.scopeIds.every(id => id === result.id));
  assert(app.generationScopes.every(id => id === result.id));
  assert.equal(result.memoryScopeId, result.id);
  assert.deepEqual(result.memoryPolicy, { mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false });
});

test('diagnosis is abortable and malformed or oversized diagnostic output is rejected without a candidate', async t => {
  for (const mode of ['stop', 'malformed', 'oversized']) {
    const { app, manager } = setup(t);
    const trainingCases = [{ input: 'i'.repeat(60000), expected: 'e'.repeat(60000) }];
    app.outputFor = () => 'o'.repeat(60000);
    let release;
    app.onGenerate = () => mode === 'stop' ? new Promise(resolve => { release = resolve; })
      : JSON.stringify(mode === 'malformed' ? { other: 'bad' } : { diagnosis: '界'.repeat(1000) });
    const started = await manager.start({ document: graph(), trainingCases });
    if (mode === 'stop') {
      await immediate(); assert.equal(manager.get(started.id).phase, 'diagnosing');
      await manager.interrupt(started.id); release(JSON.stringify({ diagnosis: 'late' }));
    }
    const result = await finished(app, manager, started.id);
    assert.equal(result.status, mode === 'stop' ? 'interrupted' : 'error'); assert.equal(app.created.length, 0);
    assert.equal(result.rounds[0].optimizerContext, 'diagnostics');
    assert.equal(result.rounds[0].cases.length, 1); assert.equal(result.rounds[0].metrics.overall.total, 1);
  }
});

test('repeated child streaming snapshots do not republish an entire learning job', async t => {
  const { app, manager } = setup(t); app.onStart = run => run;
  const started = await manager.start({ document: graph(), trainingCases: [{ input: 'one', expected: 'target' }, { input: 'two', expected: 'target' }] });
  await immediate(); const job = manager.get(started.id); const child = app.workflows.runs.get(job.activeRunId);
  const count = () => app.events.filter(event => event.type === 'learning.run').length;
  const before = count();
  for (let index = 0; index < 50; index++) app.publish('workflow.run', null, { ...child, partialText: 'chunk-' + index });
  assert.equal(count(), before);
  app.publish('workflow.run', null, { ...child, status: 'waiting' }); assert.equal(count(), before + 1);
  app.publish('workflow.run', null, { ...child, status: 'waiting' }); assert.equal(count(), before + 1);
  await manager.interrupt(started.id); await finished(app, manager, started.id);
});

test('the first sample waits for explicit batch memory confirmation and records only policy metadata', async t => {
  const { app, manager } = setup(t);
  let release; let requested;
  app.onCreateMemoryScope = options => {
    requested = options;
    return new Promise(resolve => { release = () => resolve({ id: options.id, mode: 'batch-snapshot',
      memoryWriteAllowed: false, externalMemoryAllowed: false, builtinSnapshot: 'PRIVATE_MEMORY_MUST_NOT_BE_RECORDED' }); });
  };
  const started = await manager.start({ document: graph(), input: 'sample', expected: 'target' });
  await immediate();
  const pending = manager.get(started.id);
  assert.equal(pending.phase, 'preparing-memory'); assert.equal(pending.memoryScopeId, null);
  assert.deepEqual(pending.memoryPolicy, { mode: 'pending', memoryWriteAllowed: null, externalMemoryAllowed: null });
  assert.equal(pending.rounds.length, 0); assert.equal(app.workflows.calls.length, 0); assert.equal(app.prompts.length, 0);
  assert.equal(manager.allowsWorkflow(pending.workflowId, pending.id, pending.id), false);
  assert.equal(requested.id, started.id); assert.equal(requested.signal.aborted, false);
  release();
  const result = await finished(app, manager, started.id); await immediate();
  assert.equal(result.status, 'complete'); assert.equal(result.memoryScopeId, result.id);
  assert.deepEqual(result.memoryPolicy, { mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false });
  assert(!JSON.stringify(result).includes('PRIVATE_MEMORY_MUST_NOT_BE_RECORDED'));
  assert.equal(app.memoryScopeRequests.length, 1); assert.deepEqual(app.workflows.scopeIds, [result.id]);
  assert.deepEqual(app.memoryScopeReleases, [result.id]); assert.equal(app.memoryScopes.size, 0);
});

test('missing or partial scope policies fail closed before any sample, evaluation or candidate call', async t => {
  const policies = [undefined, { mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false },
    { mode: 'other', memoryWriteAllowed: false, externalMemoryAllowed: false },
    { mode: 'batch-snapshot', memoryWriteAllowed: true, externalMemoryAllowed: false },
    { mode: 'batch-snapshot', memoryWriteAllowed: false },
    { mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: true }];
  for (const policy of policies) {
    const { app, manager } = setup(t);
    app.onCreateMemoryScope = options => policy === undefined ? undefined : { ...policy,
      ...(policies.indexOf(policy) !== 1 ? { id: options.id } : { id: 'wrong-batch' }) };
    const started = await manager.start({ document: graph(), input: 'sample', expected: 'target' });
    const result = await finished(app, manager, started.id); await immediate();
    assert.equal(result.status, 'error'); assert.match(result.error, /只读记忆快照/);
    assert.equal(result.memoryScopeId, null); assert.equal(result.memoryPolicy.mode, 'pending');
    assert.equal(app.workflows.calls.length, 0); assert.equal(app.prompts.length, 0); assert.equal(app.created.length, 0);
    assert.deepEqual(app.memoryScopeReleases, [result.id]); assert.equal(app.memoryScopes.size, 0);
  }
  const { app, manager } = setup(t); delete app.learningModel.createMemoryScope;
  await assert.rejects(manager.start({ document: graph(), input: 'sample', expected: 'target' }), /批次只读记忆快照/);
  assert.deepEqual(app.skillCalls, []); assert.deepEqual(manager.list(), []);
});

test('stopping or disconnecting during non-cooperative scope capture releases both pending and late scopes', async t => {
  for (const outcome of ['stop', 'stop-reject', 'disconnect']) {
    const { app, manager } = setup(t);
    let release; let options;
    app.onCreateMemoryScope = current => {
      options = current;
      return new Promise((resolve, reject) => { release = () => outcome === 'stop-reject'
        ? reject(new Error('late capture transport failure'))
        : resolve({ id: current.id, mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false }); });
    };
    const started = await manager.start({ document: graph(), input: 'sample', expected: 'target' });
    await immediate();
    const done = finished(app, manager, started.id);
    if (outcome.startsWith('stop')) await manager.interrupt(started.id);
    else app.publish('backend.status', null, { state: 'disconnected' });
    const result = await done; await immediate();
    assert.equal(result.status, outcome.startsWith('stop') ? 'interrupted' : 'unknown'); assert.equal(options.signal.aborted, true);
    assert.equal(result.memoryScopeId, null); assert.equal(result.memoryPolicy.mode, 'pending');
    assert(app.memoryScopeReleases.length >= 1); assert.equal(app.workflows.calls.length, 0);
    const stable = manager.get(started.id);
    release(); options.onSession('late-scope-session'); await immediate();
    assert.deepEqual(manager.get(started.id), stable); assert.equal(app.workflows.calls.length, 0);
    assert.equal(app.prompts.length, 0); assert.equal(app.created.length, 0);
    assert(app.memoryScopeReleases.length >= 2); assert.equal(app.memoryScopes.size, 0);
  }
});

test('a scope returned after manager and database close is released without new writes or execution', async t => {
  const db = new DatabaseSync(':memory:'); const app = new FakeApp(db); const manager = new WorkflowLearning(app); app.learning = manager;
  let closed = false;
  t.after(async () => { await manager.close(); if (!closed) db.close(); });
  let release; let captureOptions;
  app.onCreateMemoryScope = options => {
    captureOptions = options;
    return new Promise(resolve => { release = () => resolve({ id: options.id, mode: 'batch-snapshot',
      memoryWriteAllowed: false, externalMemoryAllowed: false }); });
  };
  const started = await manager.start({ document: graph(), input: 'sample', expected: 'target' });
  await immediate(); await manager.close(); await immediate();
  assert.equal(manager.get(started.id).status, 'unknown');
  db.close(); closed = true;
  release(); captureOptions.onSession('late-session'); await immediate();
  assert.equal(captureOptions.signal.aborted, true); assert.equal(app.workflows.calls.length, 0);
  assert.equal(app.prompts.length, 0); assert.equal(app.created.length, 0);
  assert(app.memoryScopeReleases.length >= 2); assert.equal(app.memoryScopes.size, 0);
});

test('scope release is best effort, and all model roles plus sample cases carry the same batch identity', async t => {
  const { app, manager } = setup(t);
  const grades = [0, 0, 100, 100]; let index = 0;
  app.onGenerate = prompt => prompt.includes('独立结果评估器')
    ? JSON.stringify({ scores: [{ score: grades[index++], feedback: 'one sample' }], feedback: 'grade' })
    : JSON.stringify({ content: CONTENT.replace('old', 'good'), summary: 'improve' });
  app.onReleaseMemoryScope = () => { throw new Error('transport already closed'); };
  const started = await manager.start({ document: graph(1, true, 'model'), trainingCases: [{ input: 'training', expected: 'target' }],
    validationCases: [{ input: 'validation', expected: 'target' }], comparison: 'model' });
  const result = await finished(app, manager, started.id); await immediate();
  assert.equal(result.status, 'complete'); assert.equal(app.memoryScopeRequests.length, 1);
  assert.equal(app.workflows.scopeIds.length, 4); assert(app.workflows.scopeIds.every(id => id === result.id));
  assert.equal(app.generationScopes.length, 5); assert(app.generationScopes.every(id => id === result.id));
  assert.deepEqual(app.memoryScopeReleases, [result.id]); assert.equal(manager.get(result.id).status, 'complete');
  assert.equal(manager.allowsWorkflow(result.workflowId, result.id, result.id), false);
});

test('learning requires explicit nodes and never widens the Skill targets from a request', async t => {
  const {app,manager}=setup(t);
  const missing=graph(); missing.nodes=missing.nodes.filter(n=>!['evaluation','improvement'].includes(n.type));
  missing.edges=missing.edges.filter(e=>!['evaluation','improvement'].includes(e.sourceNode)&&!['evaluation','improvement'].includes(e.targetNode));
  await assert.rejects(manager.start({document:missing,input:'sample',expected:'target'}),/学习.*支路/);
  const document=graph(2); document.nodes.find(n=>n.id==='improvement').config.targetSkillNodeIds=['skill-1'];
  await assert.rejects(manager.start({document,input:'sample',expected:'target',trainableNodeIds:['skill-0','skill-1']}),/扩大修改范围/);
  await assert.rejects(manager.start({document,input:'sample',expected:'target',comparison:'model'}),/以产物对比节点为准/);
  document.nodes.find(n=>n.id==='improvement').config.targetSkillNodeIds=[];
  await assert.rejects(manager.start({document,input:'sample',expected:'target'}),/可调整 Skill/);
  assert.equal(app.memoryScopeRequests.length,0); assert.equal(app.workflows.calls.length,0);
});

test('a learning branch compares only the connected intermediate result and selected field', async t => {
  const {app,manager}=setup(t),document=graph(2);
  const observation=document.edges.find(e=>e.targetNode==='evaluation'); observation.sourceNode='skill-0';observation.sourcePort='out';
  const evaluation=document.nodes.find(n=>n.id==='evaluation');evaluation.config.valuePath='artifact.values.0';
  app.onStart=run=>{queueMicrotask(()=>app.complete(run.id,'different final business result','complete',{
    nodes:{'skill-0':{status:'complete',input:'upstream input',output:{artifact:{values:[false]}}}}
  }));return run;};
  const started=await manager.start({document,input:'sample',expected:false});
  const result=await finished(app,manager,started.id);
  assert.equal(result.status,'complete');assert.equal(result.bestScore,100);assert.equal(result.rounds[0].cases[0].output,false);
  assert.equal(result.rounds[0].cases[0].skillInputs['skill-0'],'upstream input');
  assert.deepEqual(result.config.comparisonSource,{nodeId:'skill-0',port:'out',valuePath:'artifact.values.0'});
  assert.equal(app.prompts.length,0);
});

test('the explicit improvement node limits edits while the entire business graph is replayed', async t => {
  const {app,manager}=setup(t),document=graph(2);
  document.nodes.find(n=>n.id==='improvement').config.targetSkillNodeIds=['skill-1'];
  app.outputFor=({document})=>document.nodes.find(n=>n.id==='skill-1').config.skillRef.startsWith('candidate-')?'target':'old';
  const started=await manager.start({document,input:'sample',expected:'target',maxRounds:2});
  const result=await finished(app,manager,started.id);
  assert.equal(result.status,'complete');assert.equal(app.created.length,1);assert.equal(app.created[0].base.name,'fixture-1');
  assert.equal(result.rounds[1].changes[0].nodeId,'skill-1');
  assert.equal(result.bestDocument.nodes.find(n=>n.id==='skill-0').config.skillRef,'fixture-0');
  assert.deepEqual(app.workflows.calls.map(c=>c.document.nodes.filter(n=>n.type==='tool').length),[2,2]);
});

test('invalid or absent comparison fields fail closed without rewriting a Skill', async t => {
  for(const path of ['__proto__.x','result..value','result.notThere']) {
    const {app,manager}=setup(t),document=graph();
    document.nodes.find(n=>n.id==='evaluation').config.valuePath=path;
    if(path!=='result.notThere') await assert.rejects(manager.start({document,input:'sample',expected:'target'}),/对比字段/);
    else {
      app.outputFor=()=>({result:{value:'target'}});
      const started=await manager.start({document,input:'sample',expected:'target'});
      const result=await finished(app,manager,started.id); assert.equal(result.status,'error');assert.match(result.error,/对比字段不存在/);
    }
    assert.equal(app.created.length,0);assert.equal(app.prompts.length,0);
  }
});

test('exact JSON learning retains partial training progress until two Skills jointly pass the unchanged answer', async t => {
  const {app,manager}=setup(t),document=graph(2,false);
  for(const node of document.nodes.filter(n=>n.type==='skill')) node.config.outputType='any';
  const expected={steps:[{done:true},{done:true}],metadata:{count:2,empty:[]},note:null};
  const validationExpected={...copy(expected),private:'VALIDATION_EXPECTED_DO_NOT_OPTIMIZE'};
  app.outputFor=({document,input})=>({steps:[0,1].map(i=>({done:document.nodes.find(n=>n.id==='skill-'+i).config.skillRef.startsWith('candidate-')})),
    metadata:{count:2,empty:[]},note:null,...(input==='VALIDATION_INPUT_DO_NOT_OPTIMIZE'?{private:validationExpected.private}:{})});
  const started=await manager.start({document,input:'training',expected,maxRounds:3,
    validationCases:[{input:'VALIDATION_INPUT_DO_NOT_OPTIMIZE',expected:validationExpected}]});
  const result=await finished(app,manager,started.id);
  assert.equal(result.status,'complete');assert.equal(result.bestScore,100);assert.equal(result.bestRound,2);
  assert.deepEqual(result.rounds.map(r=>r.score),[0,0,100]);
  assert.equal(result.rounds[1].metrics.overall.passRate,0);
  assert.equal(result.rounds[2].document.nodes.find(n=>n.id==='skill-0').config.skillRef,'candidate-1');
  assert.equal(result.rounds[2].document.nodes.find(n=>n.id==='skill-1').config.skillRef,'candidate-2');
  assert.deepEqual(result.rounds[2].cases[0].output,expected);
  assert.equal(app.workflows.calls.length,6);
  for(const prompt of app.prompts){
    assert(!prompt.includes('VALIDATION_INPUT_DO_NOT_OPTIMIZE'));
    assert(!prompt.includes('VALIDATION_EXPECTED_DO_NOT_OPTIMIZE'));
  }
  assert.equal(app.skills.get('fixture-0').content,CONTENT);assert.equal(app.skills.get('fixture-1').content,CONTENT);
});

test('matching every expected JSON leaf cannot pass while an unexpected result field remains', async t => {
  const {app,manager}=setup(t),document=graph(1,false);
  document.nodes.find(n=>n.type==='skill').config.outputType='any';
  let proposals=0;
  app.onGenerate=()=>JSON.stringify({content:CONTENT.replace('old','progress-'+(++proposals)),summary:'Refine a typed JSON result.'});
  const expected={items:[1,false],none:null,empty:[]};
  app.outputFor=({document})=>{
    const ref=document.nodes.find(n=>n.type==='skill').config.skillRef;
    if(ref==='candidate-2')return {...copy(expected),unexpected:'still not exact'};
    return {items:['1',0],empty:{},...(ref==='candidate-1'?{none:null}:{})};
  };
  const started=await manager.start({document,input:'training',expected,maxRounds:3});
  const result=await finished(app,manager,started.id);
  assert.equal(result.status,'exhausted');assert.equal(result.reason,'maxRounds');
  assert.equal(result.bestScore,0);assert.equal(result.bestRound,2);
  assert.deepEqual(result.rounds.map(r=>r.score),[0,0,0]);
  assert(result.rounds.every(r=>r.metrics.overall.passRate===0));
  assert.equal(result.rounds[2].changes[0].before.ref,'candidate-1');
});

test('exact JSON tie-break uses strict training leaves and never validation-only partial gains', async t => {
  for(const validationOnly of [false,true]) {
    const {app,manager}=setup(t),document=graph(1,false);
    document.nodes.find(n=>n.type==='skill').config.outputType='any';
    const expected={a:1,b:null,c:[]};
    app.outputFor=({document,input})=>{
      const candidate=document.nodes.find(n=>n.type==='skill').config.skillRef.startsWith('candidate-');
      if(validationOnly)return input==='HIDDEN_VALIDATION_INPUT'&&candidate?{a:1,b:'HIDDEN_VALIDATION_EXPECTED',c:{}}:{a:false,b:42,c:{}};
      // Replacing number 1 by string "1" regresses one strict leaf while
      // correcting null gains one: equal progress must retain the baseline.
      return candidate?{a:'1',b:null,c:{}}:{a:1,b:42,c:{}};
    };
    const started=await manager.start({document,input:'training',expected,maxRounds:2,
      ...(validationOnly?{validationCases:[{input:'HIDDEN_VALIDATION_INPUT',expected:{a:1,b:'HIDDEN_VALIDATION_EXPECTED',c:[]}}]}:{})});
    const result=await finished(app,manager,started.id);
    assert.equal(result.status,'exhausted');assert.equal(result.bestRound,0);assert.equal(result.bestScore,0);
    for(const prompt of app.prompts){assert(!prompt.includes('HIDDEN_VALIDATION_INPUT'));assert(!prompt.includes('HIDDEN_VALIDATION_EXPECTED'));}
  }
});

test('model-scored JSON ties and exact text similarity retain their existing selection rules', async t => {
  for(const comparison of ['model','exact']) {
    const {app,manager}=setup(t),document=graph(1,false,comparison);
    document.nodes.find(n=>n.type==='skill').config.outputType='any';
    app.outputFor=({document})=>{
      const candidate=document.nodes.find(n=>n.type==='skill').config.skillRef.startsWith('candidate-');
      return comparison==='model'?{a:candidate,b:false}:candidate?'almost-target':'wrong';
    };
    app.onGenerate=prompt=>prompt.includes('独立结果评估器')
      ?JSON.stringify({scores:[{score:0,feedback:'Not accepted.'}],feedback:'No full match.'})
      :JSON.stringify({content:CONTENT.replace('old','better'),summary:'One improvement.'});
    const started=await manager.start({document,input:'training',expected:comparison==='model'?{a:true,b:true}:'target',maxRounds:2,comparison});
    const result=await finished(app,manager,started.id);
    assert.equal(result.status,'exhausted');assert.equal(result.bestRound,0);assert.equal(result.bestScore,0);
  }
});

test('a learning batch pins the same main model for memory, samples and optimization after a global switch', async t => {
  const { app, manager } = setup(t), routes = [];
  let selected = { provider: 'before-switch', model: 'model-one' }, captures = 0;
  app.captureModelRoute = async () => { captures++; return copy(selected); };
  const capture = app.learningModel.createMemoryScope;
  app.learningModel.createMemoryScope = options => { routes.push(copy(options.modelRoute)); return capture(options); };
  const generate = app.learningModel.generate;
  app.learningModel.generate = (prompt, options) => { routes.push(copy(options.modelRoute)); selected = { provider: 'after-switch', model: 'model-two' }; return generate(prompt, options); };
  const start = app.workflows.start;
  app.workflows.start = (payload, options) => { routes.push(copy(options.modelRoute)); return start(payload, options); };
  app.outputFor = () => 'wrong';
  const started = await manager.start({ document: graph(1, false), input: 'training', expected: 'target', maxRounds: 2 });
  const result = await finished(app, manager, started.id);
  assert.equal(result.status, 'exhausted', result.error);
  assert.equal(captures, 1);
  assert.deepEqual(result.modelRoute, { provider: 'before-switch', model: 'model-one' });
  assert(routes.length >= 4);
  assert(routes.every(route => JSON.stringify(route) === JSON.stringify(result.modelRoute)));
});

for (const recoverable of [true, false]) {
  test(`a legacy learning review ${recoverable ? 'recovers its original model for remaining samples and optimization' : 'refuses an unknown model without replaying its waiting artifact'}`, async t => {
    const { app, manager, db } = setup(t), original = { provider: 'legacy-learning-provider', model: 'legacy-learning-model' };
    let captures = 0, held;
    const routes = [], recoveries = [];
    app.captureModelRoute = async () => { captures++; return copy(original); };
    app.backend = { state: 'ready' }; app.workflows.get = id => copy(app.workflows.runs.get(id));
    app.onCreateMemoryScope = async options => ({ id: options.id, mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false,
      snapshot: { version: 1, scopeId: options.id, digest: 'sha256:' + 'e'.repeat(64) } });
    app.learningModel.suspendMemoryScope = id => app.memoryScopes.delete(id);
    app.learningModel.restoreMemoryScope = async ({ id, snapshot }) => {
      const scope = { id, snapshot, mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false };
      app.memoryScopes.set(id, scope); return scope;
    };
    const start = app.workflows.start;
    app.workflows.start = (payload, options) => { routes.push(copy(options.modelRoute)); return start(payload, options); };
    const generate = app.learningModel.generate;
    app.learningModel.generate = (prompt, options) => { routes.push(copy(options.modelRoute)); return generate(prompt, options); };
    let document = graph(1, false); document.schemaVersion = 2; document.settings = { maxConcurrency: 4, outputDirectory: '' };
    document.edges = document.edges.filter(edge => !(edge.sourceNode === 'skill-0' && edge.targetNode === 'output'));
    document.nodes.push(createNode('human', { x: 700, y: 0 }, { id: 'review', config: { inputType: 'text', outputType: 'text', reviewTargetNodeId: 'skill-0' } }));
    document = connectNodes(document, { sourceNode: 'skill-0', sourcePort: 'out', targetNode: 'review', targetPort: 'in' });
    document = connectNodes(document, { sourceNode: 'review', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
    const completedNodes = (run, output) => ({ 'skill-0': { status: 'complete', input: run.input, output },
      review: { status: 'complete', input: output, output }, output: { status: 'complete', input: output, output } });
    app.onStart = run => {
      run.memoryScopeId = run.learningId;
      const baseline = run.document.nodes.find(node => node.id === 'skill-0').config.skillRef === 'fixture-0';
      if (baseline && run.input === 'legacy-training') {
        held = run; run.status = 'waiting_review';
        run.nodes = { 'skill-0': { status: 'complete', input: run.input, output: 'retained old result' },
          review: { status: 'waiting_review' }, output: { status: 'pending' } };
        app.publish('workflow.run', null, copy(run)); return Promise.resolve(copy(run));
      }
      queueMicrotask(() => app.complete(run.id, 'target', 'complete', { nodes: completedNodes(run, 'target') }));
      return Promise.resolve(copy(run));
    };
    const started = await manager.start({ document, input: 'legacy-training', expected: 'target', maxRounds: 2,
      validationCases: [{ input: 'private-validation', expected: 'target' }] });
    for (let index = 0; index < 100 && manager.get(started.id).phase !== 'waiting-review'; index++) await immediate();
    assert.equal(manager.get(started.id).phase, 'waiting-review');
    const artifact = copy(held.nodes['skill-0']);
    await manager.close();
    const legacy = manager.get(started.id); delete legacy.modelRoute;
    // Old review checkpoints have no active model session. A source-bound
    // child run may still retain the route recovered from its completed Skill.
    legacy.modelSessionId = null;
    if (recoverable) held.modelRoute = copy(original);
    db.prepare('UPDATE workflow_learning SET value=? WHERE id=?').run(JSON.stringify(legacy), started.id);
    app.recoverModelRoute = ids => { recoveries.push(copy(ids)); return null; };
    app.captureModelRoute = async () => { captures++; return { provider: 'new-provider', model: 'new-model' }; };
    app.memoryScopes.clear();
    const restarted = new WorkflowLearning(app); app.learning = restarted;
    const done = finished(app, restarted, started.id);
    await restarted.prepareReviewResume(started.id);
    if (recoverable) {
      for (let index = 0; index < 100 && !restarted.active.get(started.id)?.waiter; index++) await immediate();
      assert(restarted.active.get(started.id)?.waiter, 'the original pending sample is resumed instead of started again');
      assert.deepEqual(restarted.get(started.id).modelRoute, original);
      app.complete(held.id, 'retained old result', 'complete', { nodes: completedNodes(held, 'retained old result') });
    }
    const final = await done;
    assert.equal(captures, 1, 'legacy recovery must not capture the changed global default');
    if (recoverable) assert.deepEqual(recoveries, [], 'a bound child route is already authoritative');
    else assert.equal(recoveries.length, 1);
    assert.equal(app.memoryScopeRequests.length, 1, 'the original memory snapshot is restored, never recaptured');
    assert.equal(app.workflows.interrupts.length, 0, 'recovery does not destroy the waiting artifact');
    if (recoverable) {
      assert.equal(final.status, 'complete', final.error); assert.equal(app.created.length, 1);
      assert(routes.every(route => JSON.stringify(route) === JSON.stringify(original)));
      assert.equal(final.rounds[0].cases[0].runId, held.id);
    } else {
      assert.equal(final.status, 'error'); assert.match(final.error, /旧学习批次.*未记录主模型/);
      assert.equal(app.prompts.length, 0); assert.equal(app.created.length, 0);
      assert.equal(app.workflows.calls.length, 1);
      assert.equal(held.status, 'waiting_review'); assert.deepEqual(held.nodes['skill-0'], artifact);
    }
  });
}
