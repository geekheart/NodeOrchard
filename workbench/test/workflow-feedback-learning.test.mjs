import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowLearning } from '../src/workflows/workflow-learning.mjs';
import { WorkflowFeedback } from '../src/workflows/workflow-feedback.mjs';
import { LearnedSkills } from '../src/workflows/learned-skills.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const terminal = new Set(['complete', 'exhausted', 'error', 'interrupted', 'unknown']);
const instructions = index => `---\nname: fixture-${index}\ndescription: Narrow reusable capability ${index}\nallowed-tools: []\n---\nOriginal method ${index}.\n`;
const improved = index => instructions(index).replace(`Original method ${index}.`, `Improved reusable method ${index}.`);

function graph(count) {
  let document = createDocument({ title: '分项反馈学习' });
  document.mode = 'execute';
  document.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: 'text' } })];
  for (let index = 0; index < count; index++) {
    document.nodes.push(createNode('skill', { x: 200 + index * 400, y: 0 }, { id: `skill-${index}`, title: `Capability ${index}`,
      config: { skillRef: `fixture-${index}`, version: hash(instructions(index)), inputType: 'text', outputType: 'text' } }),
    createNode('tool', { x: 400 + index * 400, y: 0 }, { id: `produce-${index}`, config: {
      executionMode: 'code', language: 'javascript', code: 'return input;', inputType: 'text', outputType: 'text',
    } }));
  }
  document.nodes.push(createNode('output', { x: 200 + count * 400, y: 0 }, { id: 'output' }));
  for (let index = 0; index < document.nodes.length - 1; index++) document = connectNodes(document, {
    sourceNode: document.nodes[index].id, sourcePort: 'out', targetNode: document.nodes[index + 1].id, targetPort: 'in',
  });
  document.nodes.push(createNode('evaluation', { x: 0, y: 250 }, { id: 'compare', config: { comparison: 'exact' } }),
    createNode('improvement', { x: 300, y: 250 }, { id: 'improve', config: { targetSkillNodeIds: Array.from({ length: count }, (_, index) => `skill-${index}`) } }));
  document = connectNodes(document, { sourceNode: 'output', sourcePort: 'learning', targetNode: 'compare', targetPort: 'in' });
  return connectNodes(document, { sourceNode: 'compare', sourcePort: 'out', targetNode: 'improve', targetPort: 'in' });
}

function setup(t, { count = 2, allowed = ['skill-0'], legacy = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const app = new EventEmitter();
  Object.assign(app, { store: { db }, events: [], prompts: [], generated: [], created: [], published: [],
    memoryRequests: [], memoryReleases: [], memoryScopes: new Map(), skillCalls: [], runStarts: [],
    checkReady() {},
  });
  const bases = new Map(Array.from({ length: count }, (_, index) => [`fixture-${index}`, {
    name: `fixture-${index}`, content: instructions(index), revision: hash(instructions(index)), source: 'local',
  }]));
  app.adapter = { request: async (method, params) => {
    if (method === 'skills.manage') return { skills: { local: [...bases.keys()] } };
    if (method === 'commands.catalog') return {};
    if (method === 'learning.detail') return { ok: true, kind: 'skill', content: bases.get(params.id)?.content };
    throw new Error('Unexpected adapter call: ' + method);
  } };
  app.publish = (type, sessionId, payload) => { const event = { type, sessionId, payload: copy(payload) }; app.events.push(event); app.emit('event', event); };
  const document = graph(count), runId = randomUUID();
  document.nodes.find(node => node.id === 'improve').config.targetSkillNodeIds = [...allowed];
  const run = { id: runId, workflowId: document.id, title: document.title, status: 'complete', document,
    input: 'WORKFLOW_INPUT', output: 'FINAL_PRODUCTION_OUTPUT', startedAt: '2026-10-24T00:00:00.000Z', completedAt: '2026-10-24T00:01:00.000Z',
    skills: Array.from({ length: count }, (_, index) => ({ nodeId: `skill-${index}`, name: `fixture-${index}`, revision: hash(instructions(index)), source: 'local' })),
    nodes: Object.fromEntries(document.nodes.map(node => [node.id, { status: ['evaluation', 'improvement'].includes(node.type) ? 'skipped' : 'complete',
      input: `ACTUAL_INPUT_${node.id}`, output: `ACTUAL_OUTPUT_${node.id}` }])),
  };
  const writeRun = value => db.prepare('INSERT INTO workflow_runs(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.id, JSON.stringify(value));
  writeRun(run);
  app.workflows = { locks: new Map(), get: id => {
    const row = db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(id);
    if (!row) throw Object.assign(new Error('运行不存在。'), { httpStatus: 404 });
    return JSON.parse(row.value);
  }, start: (...args) => { app.runStarts.push(args); throw new Error('Feedback must not execute or rerun a workflow.'); }, interrupt: async () => {} };
  app.learnedSkills = new LearnedSkills(app);
  const nativeCreate = app.learnedSkills.create.bind(app.learnedSkills);
  app.learnedSkills.create = (base, options) => { const candidate = nativeCreate(base, options); app.created.push({ base: copy(base), options: copy(options), candidate: copy(candidate) }); return candidate; };
  const nativePublish = app.learnedSkills.publish.bind(app.learnedSkills);
  app.learnedSkills.publish = async (value, options) => { app.published.push(copy(value)); return nativePublish(value, options); };
  app.skill = async ref => { app.skillCalls.push(ref); if (app.onSkill) await app.onSkill(ref); return app.learnedSkills.has(ref) ? app.learnedSkills.resolve(ref) : copy(bases.get(ref)); };
  app.feedback = new WorkflowFeedback(app);
  const feedbackItems = Array.from({ length: count }, (_, index) => ({ nodeId: `skill-${index}`, score: 42 + index,
    comment: `FEEDBACK_ONLY_${index}: improve the reusable method.`, selectedForLearning: allowed.includes(`skill-${index}`) }));
  const comment = 'OVERALL_FEEDBACK: improve reusable production layout and document clarity; leave unrelated capabilities unchanged.';
  const feedback = legacy ? { runId, workflowId: document.id, revision: 1,
    createdAt: '2026-10-24T00:02:00.000Z', updatedAt: '2026-10-24T00:02:00.000Z',
    items: feedbackItems.map(item => ({ ...app.feedback.targets(run).find(target => target.nodeId === item.nodeId), ...item })) }
    : app.feedback.save(runId, { expectedRevision: 0, comment });
  if (legacy) db.prepare('INSERT INTO workflow_feedback(run_id,revision,workflow_id,value) VALUES(?,?,?,?)')
    .run(runId, 1, document.id, JSON.stringify(feedback));
  app.learningModel = {
    createMemoryScope: async options => {
      app.memoryRequests.push(options); options.onSession?.('memory-session');
      const scope = app.onMemory ? await app.onMemory(options) : { id: options.id, mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false };
      app.memoryScopes.set(options.id, scope); return scope;
    },
    releaseMemoryScope: async id => { app.memoryReleases.push(id); app.memoryScopes.delete(id); },
    generate: async (prompt, options) => {
      const { snapshot, ...policy } = app.memoryScopes.get(options.memoryScopeId);
      assert.deepEqual(policy, { id: options.memoryScopeId, mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false });
      app.prompts.push(prompt); app.generated.push(options); options.onSession?.('model-session-' + app.prompts.length);
      if (app.onGenerate) return app.onGenerate(prompt, options);
      const index = Number(/name: fixture-(\d+)/.exec(prompt)?.[1]);
      assert(Number.isInteger(index), 'Each optimizer receives its exact original Skill content.');
      return JSON.stringify({ content: improved(index), summary: `General improvement ${index}.` });
    },
  };
  app.learning = new WorkflowLearning(app);
  t.after(async () => { await app.learning.close(); await immediate(); db.close(); });
  return { app, manager: app.learning, db, bases, run, document, runId, feedback, feedbackItems, writeRun,
    start: () => app.learning.startFeedback({ runId, feedbackRevision: feedback.revision }) };
}

function setupDAG(t) {
  const f = setup(t, { count: 1 }), directory = mkdtempSync(join(realpathSync(tmpdir()), 'feedback-dag-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  f.app.onMemory = async options => ({ id: options.id, mode: 'batch-snapshot', memoryWriteAllowed: false,
    externalMemoryAllowed: false, snapshot: { version: 1, scopeId: options.id, digest: hash('fixture readonly snapshot') } });
  let document = createDocument({ schemaVersion: 2, title: f.document.title });
  document.id = f.document.id;
  const tool = id => createNode('tool', {}, { id, config: { executionMode: 'code', language: 'javascript', code: 'return input;', inputType: 'object', outputType: 'object' } });
  document.nodes = [createNode('input', {}, { id: 'input', config: { outputType: 'object' } }),
    createNode('skill', {}, { id: 'skill-0', title: 'Capability 0', config: { skillRef: 'fixture-0', version: hash(instructions(0)), inputType: 'object', outputType: 'object' } }),
    tool('produce-0'), tool('produce-back'), createNode('merge', {}, { id: 'merge', ports: {
      inputs: [{ id: 'front', label: 'front', type: 'object' }, { id: 'back', label: 'back', type: 'object' }],
      outputs: [{ id: 'out', label: 'out', type: 'object' }],
    } }), createNode('human', {}, { id: 'human' }),
    createNode('tool', {}, { id: 'verify', config: { executionMode: 'code', language: 'javascript', code: 'return input;', inputType: 'object', outputType: 'object' }, ports: {
      inputs: [{ id: 'in', label: 'in', type: 'object' }], outputs: [{ id: 'out', label: 'selected bundle', type: 'object', valuePath: 'bundle' }],
    } }), createNode('output', {}, { id: 'output' }),
    createNode('tool', {}, { id: 'independent', config: { executionMode: 'code', language: 'javascript', code: 'return input;', inputType: 'object', outputType: 'object' } }),
    createNode('output', {}, { id: 'independent-output' }),
    createNode('evaluation', {}, { id: 'compare', config: { comparison: 'model', valuePath: 'learningComparison' } }),
    createNode('improvement', {}, { id: 'improve', config: { targetSkillNodeIds: ['skill-0'] } })];
  for (const [sourceNode, sourcePort, targetNode, targetPort] of [
    ['input', 'out', 'skill-0', 'in'], ['skill-0', 'out', 'produce-0', 'in'], ['skill-0', 'out', 'produce-back', 'in'],
    ['produce-0', 'out', 'merge', 'front'], ['produce-back', 'out', 'merge', 'back'], ['merge', 'out', 'human', 'in'],
    ['human', 'out', 'verify', 'in'], ['verify', 'out', 'output', 'in'], ['input', 'out', 'independent', 'in'],
    ['independent', 'out', 'independent-output', 'in'], ['verify', 'out', 'compare', 'in'], ['compare', 'out', 'improve', 'in'],
  ]) document = connectNodes(document, { sourceNode, sourcePort, targetNode, targetPort });
  const run = copy(f.run); run.schemaVersion = 2; run.document = document;
  run.nodes = Object.fromEntries(document.nodes.map(node => [node.id, { status: ['evaluation', 'improvement'].includes(node.type) ? 'skipped' : 'complete',
    attempt: 1, attemptId: randomUUID(), input: null, output: null }]));
  const comparison = { qualitySummary: { checks: { currentSource: true, actualImage: true }, userReviewStatus: 'pending' },
    labelInventory: Array.from({ length: 54 }, (_, index) => ({ category: 'chapter', item: String(index + 1), label: 'Section ' + index,
      sourceTrace: 'ACTUAL_COMPARISON_DETAIL_' + index + '_'.repeat(180) })) };
  const artifacts = Array.from({ length: 6 }, (_, index) => ({ artifactId: randomUUID(), path: join(directory, 'artifact-' + index + '-'.repeat(220)), sha256: 'a'.repeat(64), bytes: 100 }));
  const produced = (id, extra = {}) => {
    const result = { kind: 'business-output', sourceId: id, artifacts: copy(artifacts), ...extra };
    Object.assign(run.nodes[id], { outputDirectory: join(directory, id), output: result }); return result;
  };
  const front = produced('produce-0'), back = produced('produce-back');
  const verified = produced('verify', { bundle: { learningComparison: copy(comparison) } });
  run.nodes['skill-0'].input = { displayOptions: { actual: true }, userInput: 'ACTUAL_BUSINESS_INPUT' };
  run.nodes['skill-0'].output = { headings: [{ id: 'chapter-4', label: 'Chapter 4' }] };
  run.nodes['skill-0'].reviewFeedback = 'EXECUTION_ONLY_REVIEW: the actual output also used temporary review instructions.';
  run.nodes.merge.output = { front: copy(front), back: copy(back) };
  run.nodes.human.output = copy(run.nodes.merge.output);
  run.nodes.output.output = copy(verified.bundle);
  const independent = { raw: 'UNRELATED_PARALLEL_BRANCH_'.repeat(10000) };
  run.nodes.independent.output = independent; run.nodes['independent-output'].output = copy(independent);
  run.output = { output: copy(verified.bundle), 'independent-output': copy(independent) };
  f.writeRun(run);
  return Object.assign(f, { run, document, comparison, directory, artifacts });
}

async function until(read, predicate, label = 'expected state') {
  let value;
  for (let index = 0; index < 300; index++) {
    value = read(); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(label + ' was not observed: ' + JSON.stringify(value));
}
const done = (fixture, id) => until(() => fixture.app.learning.get(id), value => terminal.has(value.status), 'terminal feedback job');
const settled = async fixture => { const started = await fixture.start(); return done(fixture, started.id); };

// Overall feedback guides candidate generation. It does not certify the
// unexecuted candidate or create a synthetic score.
test('feedback creates a versioned, unvalidated candidate without rerunning or altering the reviewed result', async t => {
  const f = setup(t), originalRun = f.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(f.runId).value;
  const originalBases = copy([...f.bases]);
  const result = await settled(f);
  assert.equal(result.kind, 'feedback'); assert.equal(result.status, 'complete'); assert.equal(result.reason, 'feedback-candidate-ready');
  assert.equal(result.sourceRunId, f.runId); assert.equal(result.feedbackRevision, 1); assert.deepEqual(result.feedbackSnapshot, f.feedback);
  assert.deepEqual(result.config.trainableNodeIds, ['skill-0']); assert.equal(result.validationStatus, 'not-run');
  assert.equal(result.bestDocument, null); assert.equal(result.bestScore, null); assert.equal(result.bestRound, null);
  assert.equal(result.rounds.length, 1); assert.equal(result.rounds[0].score, null); assert.deepEqual(result.rounds[0].cases, []);
  assert.equal(result.rounds[0].changes.length, 1); assert.equal(result.rounds[0].changes[0].nodeId, 'skill-0');
  assert.equal(result.candidateDocument.mode, 'learn');
  assert.equal(result.candidateDocument.nodes.find(node => node.id === 'skill-1').config.skillRef, 'fixture-1');
  assert.notEqual(result.candidateDocument.nodes.find(node => node.id === 'skill-0').config.skillRef, 'fixture-0');
  assert.deepEqual(f.app.runStarts, []); assert.deepEqual(f.app.published, []); assert.deepEqual(f.app.learnedSkills.list(), []);
  assert.equal(f.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(f.runId).value, originalRun);
  assert.deepEqual(copy([...f.bases]), originalBases);
  assert.equal(f.app.memoryRequests.length, 1); assert.deepEqual(new Set(f.app.generated.map(options => options.memoryScopeId)), new Set([result.id]));
  assert.equal(result.memoryPolicy.mode, 'batch-snapshot'); assert.equal(result.memoryPolicy.memoryWriteAllowed, false); assert.equal(result.memoryPolicy.externalMemoryAllowed, false);
  await until(() => f.app.memoryReleases, value => value.includes(result.id));
  assert.equal(f.manager.isLocked(f.document.id), false);
  assert.equal(f.manager.get(result.id).bestScore, null); assert.equal(f.manager.list(f.document.id)[0].id, result.id);
});

test('overall feedback reaches each allowed Skill with its own actual I/O and production evidence', async t => {
  const f = setup(t, { allowed: ['skill-0', 'skill-1'] });
  const result = await settled(f);
  assert.equal(result.status, 'complete'); assert.equal(f.app.prompts.length, 2);
  assert.deepEqual(result.rounds[0].changes.map(change => change.nodeId), ['skill-0', 'skill-1']);
  for (let index = 0; index < 2; index++) {
    const prompt = f.app.prompts.find(value => value.includes(`name: fixture-${index}`));
    assert(prompt, 'Each allowed target receives its original Skill.');
    assert(prompt.includes(f.feedback.comment), 'The complete overall feedback is shared with each permitted target.');
    assert(prompt.includes(`ACTUAL_INPUT_skill-${index}`)); assert(prompt.includes(`ACTUAL_OUTPUT_skill-${index}`));
    assert(prompt.includes(`ACTUAL_OUTPUT_produce-${index}`), 'The actual production step after the Skill is included.');
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    assert(!Object.hasOwn(payload.feedback, 'score'), 'No removed user rating is manufactured for the optimizer.');
    assert(!prompt.includes(`ACTUAL_INPUT_skill-${1 - index}`), 'Another Skill actual input is not substituted for this target.');
  }
});

test('feedback snapshot remains immutable if a later feedback revision arrives while a candidate is being generated', async t => {
  const f = setup(t); let resolve;
  f.app.onGenerate = () => new Promise(done => { resolve = done; });
  const started = await f.start(); await until(() => f.app.prompts.length, value => value === 1);
  f.app.feedback.save(f.runId, { expectedRevision: 1, comment: 'LATER_FEEDBACK_REVISION' });
  resolve(JSON.stringify({ content: improved(0), summary: 'Original feedback revision improvement.' }));
  const result = await done(f, started.id);
  assert.equal(result.feedbackRevision, 1); assert.deepEqual(result.feedbackSnapshot, f.feedback);
  assert(!f.app.prompts[0].includes('LATER_FEEDBACK_REVISION'));
  await assert.rejects(f.manager.applyFeedback(result.id), /反馈|版本|重新/);
  assert.equal(f.app.published.length, 0);
});

test('all completed Skill targets are recorded but only the explicit improvement scope is optimized', async t => {
  const f = setup(t), result = await settled(f);
  assert.equal(f.feedback.schemaVersion, 2); assert.equal(f.feedback.comment.startsWith('OVERALL_FEEDBACK'), true);
  assert.deepEqual(f.feedback.targets.map(target => target.nodeId), ['skill-0', 'skill-1']);
  assert(!Object.hasOwn(f.feedback, 'items'));
  for (const target of f.feedback.targets) { assert(!Object.hasOwn(target, 'score')); assert(!Object.hasOwn(target, 'selectedForLearning')); }
  assert.deepEqual(result.config.trainableNodeIds, ['skill-0']); assert.equal(f.app.prompts.length, 1);
  assert(!f.app.prompts[0].includes('name: fixture-1'));
  assert.equal(result.candidateDocument.nodes.find(node => node.id === 'skill-1').config.skillRef, 'fixture-1');
});

test('feedback learning rejects a workflow without an explicit permitted improvement scope', async t => {
  const f = setup(t), run = copy(f.run);
  run.document.nodes.find(node => node.id === 'improve').config.targetSkillNodeIds = []; f.writeRun(run);
  await assert.rejects(f.start(), /允许|范围|目标|改进/); assert.equal(f.app.prompts.length, 0); assert.equal(f.app.memoryRequests.length, 0);
});

test('feedback learning rejects stale or incomplete source Skill evidence before calling the model', async t => {
  for (const mutate of [run => { run.skills[0].revision = hash('wrong version'); },
    run => { delete run.nodes['skill-0'].input; }, run => { delete run.nodes['skill-0'].output; },
    run => { run.nodes['skill-0'].status = 'running'; }]) {
    const f = setup(t), run = copy(f.run); mutate(run); f.writeRun(run);
    await assert.rejects(f.start(), /版本|输入|输出|完成|快照|反馈/);
    assert.equal(f.app.prompts.length, 0);
  }
});

test('source Skill changes prevent feedback learning rather than editing a new version using old feedback', async t => {
  const f = setup(t), base = f.bases.get('fixture-0'); base.content += 'A source change.'; base.revision = hash(base.content);
  await assert.rejects(f.start(), /版本|变化/); assert.equal(f.app.prompts.length, 0); assert.equal(f.app.created.length, 0);
});

test('feedback cannot silently alter frontmatter, even when the replacement body would otherwise be valid', async t => {
  const f = setup(t); f.app.onGenerate = () => JSON.stringify({ content: improved(0).replace('allowed-tools: []', 'allowed-tools: [terminal]'), summary: 'Try changing metadata.' });
  const result = await settled(f);
  assert.equal(result.status, 'error'); assert.match(result.error, /frontmatter|元配置|头部/);
  assert.equal(f.app.created.length, 0); assert.equal(result.candidateDocument, null); assert.equal(f.app.published.length, 0);
});

test('feedback candidate generation waits for confirmed memory isolation and fails closed on an invalid scope', async t => {
  const f = setup(t); f.app.onMemory = async options => ({ id: options.id, mode: 'batch-snapshot', memoryWriteAllowed: true, externalMemoryAllowed: false });
  const result = await settled(f);
  assert.equal(result.status, 'error'); assert.match(result.error, /只读|快照|策略/);
  assert.equal(f.app.prompts.length, 0); assert.equal(f.app.created.length, 0); assert.equal(f.manager.isLocked(f.document.id), false);
  await until(() => f.app.memoryReleases, value => value.includes(result.id));
});

test('feedback learning locks against another batch and a late optimizer response after stop cannot create a candidate', async t => {
  const f = setup(t); let resolve;
  f.app.onGenerate = () => new Promise(done => { resolve = done; });
  const started = await f.start(); await until(() => f.app.prompts.length, value => value === 1);
  await assert.rejects(f.start(), /正在|执行|学习|批次/);
  await f.manager.interrupt(started.id);
  resolve(JSON.stringify({ content: improved(0), summary: 'Late result must not be accepted.' }));
  const result = await done(f, started.id);
  assert.equal(result.status, 'interrupted'); assert.equal(f.app.created.length, 0); assert.equal(f.app.published.length, 0);
  assert.equal(f.manager.isLocked(f.document.id), false);
});

test('a feedback batch cannot start while the source workflow is already executing', async t => {
  const f = setup(t); f.app.workflows.locks.set(f.document.id, 'active-execution');
  await assert.rejects(f.start(), /正在|执行|批次/); assert.equal(f.app.memoryRequests.length, 0);
});

test('stopping memory capture cleans up both prompt and late admission without leaking a workflow lock', async t => {
  const f = setup(t); let resolve;
  f.app.onMemory = options => new Promise(done => { resolve = () => done({ id: options.id, mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false }); });
  const started = await f.start(); await until(() => f.app.memoryRequests.length, value => value === 1);
  await f.manager.interrupt(started.id); const result = await done(f, started.id);
  assert.equal(result.status, 'interrupted'); resolve(); await immediate(); await immediate();
  assert.equal(f.app.prompts.length, 0); assert.equal(f.app.created.length, 0); assert.equal(f.manager.isLocked(f.document.id), false);
  assert.equal(f.app.memoryScopes.has(started.id), false); assert(f.app.memoryReleases.includes(started.id));
});

test('feedback apply explicitly publishes the candidate, returns no invented score and preserves the original run', async t => {
  const f = setup(t), result = await settled(f), source = f.app.workflows.get(f.runId);
  const applied = await f.manager.applyFeedback(result.id);
  assert.equal(applied.learningId, result.id); assert.equal(applied.score, null); assert.equal(applied.validationStatus, 'not-run');
  assert.deepEqual(applied.document, { ...result.candidateDocument, mode: 'execute' }); assert.equal(f.app.published.length, 1);
  assert.equal(f.app.learnedSkills.list().length, 1); assert.deepEqual(f.app.workflows.get(f.runId), source);
  assert.deepEqual(f.app.runStarts, []);
});

test('feedback apply rechecks source versions and refuses a source bundle changed since candidate generation', async t => {
  const f = setup(t), result = await settled(f), base = f.bases.get('fixture-0');
  base.content += 'Source bundle changed after candidate generation.'; base.revision = hash(base.content);
  await assert.rejects(f.manager.applyFeedback(result.id), /版本|变化/); assert.equal(f.app.published.length, 0);
});

test('feedback apply independently checks candidate integrity instead of trusting persisted document fields', async t => {
  const f = setup(t), result = await settled(f), candidate = result.rounds[0].changes[0].after;
  const saved = f.db.prepare('SELECT value FROM learned_skills WHERE id=?').get(candidate.ref);
  const tampered = JSON.parse(saved.value); tampered.content += 'Untracked tampering.';
  f.db.prepare('UPDATE learned_skills SET value=? WHERE id=?').run(JSON.stringify(tampered), candidate.ref);
  await assert.rejects(f.manager.applyFeedback(result.id), /完整性|指纹|版本/); assert.equal(f.app.published.length, 0);
});

test('completed feedback candidates survive manager restart as unvalidated, immutable records', async t => {
  const f = setup(t), result = await settled(f);
  await f.manager.close(); f.app.learning = new WorkflowLearning(f.app);
  const restored = f.app.learning.get(result.id), listed = f.app.learning.list(f.document.id)[0];
  assert.equal(restored.kind, 'feedback'); assert.equal(restored.status, 'complete'); assert.equal(restored.bestScore, null);
  assert.equal(restored.validationStatus, 'not-run'); assert.deepEqual(restored.feedbackSnapshot, f.feedback);
  assert.deepEqual(restored.candidateDocument, result.candidateDocument); assert.equal(listed.id, result.id);
  assert.equal(f.app.prompts.length, 1); assert.deepEqual(f.app.runStarts, []);
});

test('an in-flight feedback job is marked unknown on restart and is never replayed automatically', async t => {
  const f = setup(t); let resolve;
  f.app.onGenerate = () => new Promise(done => { resolve = done; });
  const started = await f.start(); await until(() => f.app.prompts.length, value => value === 1);
  // Model a crash: persisted running state is recovered by a fresh manager.
  f.manager.closed = true; f.app.off('event', f.manager.onEvent);
  f.app.learning = new WorkflowLearning(f.app);
  const recovered = f.app.learning.get(started.id);
  assert.equal(recovered.kind, 'feedback'); assert.equal(recovered.status, 'unknown'); assert.equal(recovered.reason, 'restart');
  assert.equal(recovered.bestScore, null); assert.equal(recovered.candidateDocument, null);
  resolve(JSON.stringify({ content: improved(0), summary: 'Late pre-restart result.' })); await immediate();
  assert.equal(f.app.created.length, 0); assert.equal(f.app.prompts.length, 1); assert.deepEqual(f.app.runStarts, []);
});

test('oversized actual evidence is rejected explicitly instead of silently truncating the user-reviewed result', async t => {
  const f = setup(t), run = copy(f.run); run.nodes['produce-0'].output = 'EXCESS_EVIDENCE_'.repeat(20000); f.writeRun(run);
  let result;
  try { const started = await f.start(); result = await done(f, started.id); }
  catch (error) { assert.match(error.message, /大小|过大|超过|长度|KB|KiB/); return; }
  assert.equal(result.status, 'error'); assert.match(result.error, /大小|过大|超过|长度|KB|KiB/);
  assert.equal(f.app.prompts.length, 0); assert.equal(f.app.created.length, 0);
});

test('a source version changed during the optimizer call invalidates the returned candidate', async t => {
  const f = setup(t);
  f.app.onGenerate = () => {
    const base = f.bases.get('fixture-0'); base.content += 'Concurrent source edit.'; base.revision = hash(base.content);
    return JSON.stringify({ content: improved(0), summary: 'A proposal based on an outdated version.' });
  };
  const result = await settled(f);
  assert.equal(result.status, 'error'); assert.match(result.error, /版本|变化/);
  assert.equal(f.app.created.length, 0); assert.equal(f.app.published.length, 0);
});

test('one failed permitted target prevents a partially generated batch from being applied as a finished candidate', async t => {
  const f = setup(t, { allowed: ['skill-0', 'skill-1'] });
  f.app.onGenerate = prompt => prompt.includes('name: fixture-0')
    ? JSON.stringify({ content: improved(0), summary: 'First target drafted.' }) : 'not a JSON response';
  const result = await settled(f);
  assert.equal(result.status, 'error'); assert.equal(result.candidateDocument, null);
  assert.equal(result.validationStatus, 'not-run'); assert.equal(f.app.published.length, 0);
  await assert.rejects(f.manager.applyFeedback(result.id), /候选|完成|应用|结束/);
  assert.deepEqual(f.app.learnedSkills.list(), []);
});

test('persisted candidate documents cannot smuggle unrelated tool code into feedback application', async t => {
  const f = setup(t), result = await settled(f);
  const row = f.db.prepare('SELECT value FROM workflow_learning WHERE id=?').get(result.id);
  const changed = JSON.parse(row.value);
  changed.candidateDocument.nodes.find(node => node.id === 'produce-0').config.code = 'return "bypass production";';
  f.db.prepare('UPDATE workflow_learning SET value=? WHERE id=?').run(JSON.stringify(changed), result.id);
  await assert.rejects(f.manager.applyFeedback(result.id), /候选|快照|范围|变化|一致|完整性/);
  assert.equal(f.app.published.length, 0);
});

test('feedback replaced during asynchronous publish resolution rejects application before any candidate is published', async t => {
  const f = setup(t), result = await settled(f);
  const resolve = f.app.learnedSkills.resolve.bind(f.app.learnedSkills), publish = f.app.learnedSkills.publish.bind(f.app.learnedSkills);
  let publishing = false, reached = false, release;
  const blocked = new Promise(done => { release = done; });
  f.app.learnedSkills.publish = (...args) => { publishing = true; return publish(...args); };
  f.app.learnedSkills.resolve = async ref => {
    if (publishing) { reached = true; await blocked; }
    return resolve(ref);
  };
  const pending = f.manager.applyFeedback(result.id);
  await until(() => reached, Boolean, 'publication waiting for source resource resolution');
  f.app.feedback.save(f.runId, { expectedRevision: 1,
    comment: 'A newer review replaced the feedback during publication.' });
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.httpStatus, 409); assert.match(error.message, /反馈|版本|重新/); return true;
  });
  release(); await rejected;
  assert.deepEqual(f.app.learnedSkills.list(), []);
  for (const change of result.rounds[0].changes) assert.equal(f.app.learnedSkills.get(change.after.ref).published, false);
  assert.equal(f.manager.get(result.id).validationStatus, 'not-run');
});

test('model errors are redacted before feedback job events and durable records are saved', async t => {
  const f = setup(t), apiSecret = 'sk-feedbackfixture_0123456789abcdef', bearerSecret = 'feedback-bearer-token-0123456789';
  f.app.onGenerate = () => { throw new Error(`Backend refused ${apiSecret}; Authorization: Bearer ${bearerSecret}`); };
  const result = await settled(f);
  assert.equal(result.status, 'error'); assert.match(result.error, /REDACTED/);
  const persisted = f.db.prepare('SELECT value FROM workflow_learning WHERE id=?').get(result.id).value;
  const events = JSON.stringify(f.app.events.filter(event => event.type === 'learning.run'));
  for (const text of [result.error, persisted, events]) {
    assert(!text.includes(apiSecret), 'API secret must never be saved or published.');
    assert(!text.includes(bearerSecret), 'Bearer credentials must never be saved or published.');
  }
  assert.equal(f.app.created.length, 0); assert.equal(f.app.published.length, 0);
});

test('unrelated permitted Skills may keep their original text while only a relevant subset is improved', async t => {
  const f = setup(t, { allowed: ['skill-0', 'skill-1'] });
  f.app.onGenerate = prompt => prompt.includes('name: fixture-1')
    ? JSON.stringify({ content: improved(1), summary: 'Only this capability is relevant to the overall feedback.' })
    : JSON.stringify({ content: instructions(0), summary: 'The overall feedback does not require changing this capability.' });
  const result = await settled(f);
  assert.equal(result.reason, 'feedback-candidate-ready'); assert.deepEqual(result.config.trainableNodeIds, ['skill-0', 'skill-1']);
  assert.deepEqual(result.rounds[0].changes.map(change => change.nodeId), ['skill-1']); assert.equal(f.app.created.length, 1);
  assert.equal(result.candidateDocument.nodes.find(node => node.id === 'skill-0').config.skillRef, 'fixture-0');
  assert.equal(result.bestScore, null); assert.equal(result.validationStatus, 'not-run');
  const applied = await f.manager.applyFeedback(result.id);
  assert.equal(applied.score, null); assert.equal(f.app.learnedSkills.list().length, 1); assert.deepEqual(f.app.runStarts, []);
});

test('an entirely unrelated overall comment produces no candidate and no automatic workflow execution', async t => {
  const f = setup(t, { allowed: ['skill-0', 'skill-1'] });
  f.app.onGenerate = prompt => {
    const index = Number(/name: fixture-(\d+)/.exec(prompt)?.[1]);
    return JSON.stringify({ content: instructions(index), summary: 'No relevant generalizable Skill change is needed.' });
  };
  const result = await settled(f);
  assert.equal(result.status, 'complete'); assert.equal(result.reason, 'feedback-no-change');
  assert.equal(result.candidateDocument, null); assert.deepEqual(result.rounds[0].changes, []);
  assert.equal(result.bestScore, null); assert.equal(result.validationStatus, 'not-run');
  assert.equal(f.app.created.length, 0); assert.equal(f.app.published.length, 0); assert.deepEqual(f.app.runStarts, []);
  await assert.rejects(f.manager.applyFeedback(result.id), /候选|应用/);
});

test('historical item feedback stays readable and its original selected scope remains applicable without inventing a new score', async t => {
  const f = setup(t, { legacy: true }), original = copy(f.feedback);
  const result = await settled(f);
  assert.equal(result.status, 'complete'); assert.deepEqual(result.feedbackSnapshot, original);
  assert.deepEqual(result.config.trainableNodeIds, ['skill-0']); assert.equal(result.bestScore, null);
  assert.equal(f.app.prompts.length, 1); assert(f.app.prompts[0].includes('FEEDBACK_ONLY_0'));
  assert(!f.app.prompts[0].includes('FEEDBACK_ONLY_1'), 'Unselected historical feedback cannot widen the original modification scope.');
  const applied = await f.manager.applyFeedback(result.id);
  assert.equal(applied.score, null); assert.equal(applied.validationStatus, 'not-run');
  assert.equal(f.app.learnedSkills.list().length, 1); assert.deepEqual(f.app.feedback.get(f.runId).feedback, original);
  assert.deepEqual(f.app.runStarts, []);
});

test('v2 feedback keeps full Skill I/O and the explicit projected comparison while deduplicating equal generic DAG values', async t => {
  const f = setupDAG(t), original = f.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(f.runId).value;
  assert(Buffer.byteLength(JSON.stringify(f.run.nodes)) > 96 * 1024, 'The unprojected real-shape DAG exceeds the evidence limit.');
  const result = await settled(f);
  assert.equal(result.reason, 'feedback-candidate-ready', result.error);
  const prompt = f.app.prompts[0], payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)), evidence = payload.evidence;
  assert.deepEqual(evidence.skillInput, f.run.nodes['skill-0'].input);
  assert.deepEqual(evidence.skillOutput, f.run.nodes['skill-0'].output);
  assert.equal(evidence.executionReviewFeedback, f.run.nodes['skill-0'].reviewFeedback);
  assert.deepEqual(evidence.comparison.value, f.comparison);
  assert.equal(evidence.comparison.portValuePath, 'bundle');
  assert.equal(evidence.comparison.valuePath, 'learningComparison');
  assert.equal(evidence.comparison.available, true);
  assert.equal(Object.hasOwn(evidence, 'receipts'), false);
  for (const id of ['produce-0', 'produce-back']) {
    const selected = evidence.subsequent.find(node => node.nodeId === id);
    assert.deepEqual(evidence.values.find(value => value.id === selected.output.id).value, f.run.nodes[id].output);
  }
  const merge = evidence.subsequent.find(node => node.nodeId === 'merge');
  assert.deepEqual(merge.output, evidence.subsequent.find(node => node.nodeId === 'human').output);
  assert.equal(evidence.values.filter(value => value.id === merge.output.id).length, 1);
  assert(!Object.hasOwn(evidence, 'workflowOutput'), 'An unrelated parallel output is not copied into this target evidence.');
  assert(!prompt.includes('UNRELATED_PARALLEL_BRANCH_'));
  assert(!evidence.subsequent.some(node => node.nodeId.startsWith('independent')));
  assert.equal(prompt.split('ACTUAL_COMPARISON_DETAIL_53').length - 1, 1, 'The selected comparison is preserved exactly once.');
  assert(prompt.includes(f.artifacts[0].artifactId), 'Generic business inventories remain complete JSON data.');
  assert(Buffer.byteLength(JSON.stringify(evidence)) < 96 * 1024);
  assert.deepEqual(f.app.runStarts, []);
  assert.equal(f.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(f.runId).value, original);
});

test('v2 feedback treats business receipt-shaped values as ordinary data without discarding fields', async t => {
  const f = setupDAG(t), unknown = { kind: 'custom-business-receipt', nodeId: 'not-a-producer', runId: f.runId,
    operation: 'external.prepare', receiptPath: '/untrusted/path/must-not-be-read', receiptSha256: 'a'.repeat(64),
    unknownInventory: [{ exactUserData: 'MUST_KEEP_UNKNOWN_RECEIPT_FIELD' }] };
  f.run.nodes['produce-0'].output = copy(unknown);
  f.run.nodes.merge.output.front = copy(unknown); f.run.nodes.human.output.front = copy(unknown);
  const extra = { marker: 'MUST_KEEP_UNRECOGNIZED_FIELD_ON_REAL_RECEIPT' };
  f.run.nodes['produce-back'].output.unrecognized = copy(extra);
  f.run.nodes.merge.output.back = copy(f.run.nodes['produce-back'].output);
  f.run.nodes.human.output.back = copy(f.run.nodes['produce-back'].output); f.writeRun(f.run);
  const result = await settled(f); assert.equal(result.status, 'complete', result.error);
  const prompt = f.app.prompts[0], evidence = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)).evidence;
  assert.equal(Object.hasOwn(evidence, 'receipts'), false);
  const back = evidence.subsequent.find(node => node.nodeId === 'produce-back');
  assert.deepEqual(evidence.values.find(value => value.id === back.output.id).value.unrecognized, extra);
  const selected = evidence.subsequent.find(node => node.nodeId === 'produce-0');
  assert.deepEqual(evidence.values.find(value => value.id === selected.output.id).value, unknown);
});

test('v2 feedback keeps oversized unknown payloads and selected comparisons subject to the same 96KiB hard limit', async t => {
  for (const kind of ['unknown-receipt', 'business-value-extra', 'comparison', 'skill-input', 'skill-output']) {
    await t.test(kind, async t => {
      const f = setupDAG(t), large = 'EVIDENCE_MUST_NOT_BE_TRUNCATED_'.repeat(8000);
      if (kind === 'unknown-receipt') {
        const unknown = { kind: 'custom-business-receipt', nodeId: 'not-a-producer', runId: f.runId,
          receiptSha256: 'a'.repeat(64), receiptPath: '/untrusted/path', inventory: large };
        f.run.nodes['produce-0'].output = unknown; f.run.nodes.merge.output.front = copy(unknown); f.run.nodes.human.output.front = copy(unknown);
      } else if (kind === 'business-value-extra') {
        f.run.nodes['produce-0'].output.unrecognized = large;
        f.run.nodes.merge.output.front = copy(f.run.nodes['produce-0'].output);
        f.run.nodes.human.output.front = copy(f.run.nodes['produce-0'].output);
      } else if (kind === 'comparison') f.run.nodes.verify.output.bundle.learningComparison = { fullComparison: large };
      else f.run.nodes['skill-0'][kind === 'skill-input' ? 'input' : 'output'] = { actual: large };
      f.writeRun(f.run);
      await assert.rejects(f.start(), error => error.httpStatus === 413 && /96KB|超过/.test(error.message));
      assert.equal(f.app.prompts.length, 0); assert.equal(f.app.memoryRequests.length, 0);
      assert.deepEqual(f.app.runStarts, []);
    });
  }
});

test('v2 feedback rejects a missing explicit comparison before memory or model calls', async t => {
  const f = setupDAG(t);
  f.run.document.nodes.find(node => node.id === 'compare').config.valuePath = 'missingComparison';
  f.writeRun(f.run);
  await assert.rejects(f.start(), error => error.httpStatus === 409 && /对比字段/.test(error.message));
  assert.equal(f.app.prompts.length, 0); assert.equal(f.app.memoryRequests.length, 0);
});

test('v2 compact evidence does not weaken the complete source snapshot fingerprint at candidate application', async t => {
  const f = setupDAG(t), result = await settled(f);
  assert.equal(result.status, 'complete', result.error);
  const run = f.app.workflows.get(f.runId);
  run.nodes['produce-0'].output.artifacts[0].bytes++;
  f.writeRun(run);
  await assert.rejects(f.manager.applyFeedback(result.id), /原执行记录已变化/);
  assert.equal(f.app.published.length, 0);
  assert.deepEqual(f.app.learnedSkills.list(), []);
});

test('v2 failed comparison sources remain explicit diagnostics rather than a fabricated completed product', async t => {
  const f = setupDAG(t); f.run.status = 'error';
  Object.assign(f.run.nodes.verify, { status: 'error', output: null, error: 'ACTUAL_VERIFICATION_FAILURE' });
  f.run.nodes.output.status = 'blocked'; f.run.nodes.output.output = null; f.writeRun(f.run);
  const result = await settled(f); assert.equal(result.status, 'complete', result.error);
  const prompt = f.app.prompts[0], evidence = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)).evidence;
  assert.equal(evidence.comparison.available, false);
  assert.equal(evidence.comparison.status, 'error');
  assert.equal(evidence.comparison.error, 'ACTUAL_VERIFICATION_FAILURE');
  assert(!Object.hasOwn(evidence.comparison, 'value'));
  assert.deepEqual(f.app.runStarts, []);
});

test('scoped multi-Skill feedback optimizes only the selected immutable Skill and leaves all other source versions untouched', async t => {
  const f = setup(t, { count: 3, allowed: ['skill-0', 'skill-1', 'skill-2'] });
  const originalRun = f.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(f.runId).value;
  const originalBases = copy([...f.bases]);
  const scoped = f.app.feedback.saveScoped(f.runId, { expectedRevision: 1, comment: 'SELECTED_ONLY: refine this reusable capability.', targetNodeIds: ['skill-1'] });
  const started = await f.manager.startFeedback({ runId: f.runId, feedbackRevision: scoped.revision });
  const result = await done(f, started.id);
  assert.equal(result.status, 'complete'); assert.equal(result.feedbackSnapshot.schemaVersion, 3);
  assert.deepEqual(result.config.trainableNodeIds, ['skill-1']); assert.equal(f.app.prompts.length, 1);
  assert(f.app.prompts[0].includes('name: fixture-1')); assert(!f.app.prompts[0].includes('name: fixture-0')); assert(!f.app.prompts[0].includes('name: fixture-2'));
  assert.deepEqual(result.rounds[0].changes.map(change => change.nodeId), ['skill-1']);
  for (const index of [0, 2]) {
    const node = result.candidateDocument.nodes.find(node => node.id === 'skill-' + index);
    assert.equal(node.config.skillRef, 'fixture-' + index); assert.equal(node.config.version, hash(instructions(index)));
  }
  assert.notEqual(result.candidateDocument.nodes.find(node => node.id === 'skill-1').config.skillRef, 'fixture-1');
  assert.equal(f.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(f.runId).value, originalRun);
  assert.deepEqual(copy([...f.bases]), originalBases); assert.deepEqual(f.app.runStarts, []); assert.deepEqual(f.app.published, []);
  assert.equal(result.validationStatus, 'not-run'); assert.equal(result.bestScore, null);
});
