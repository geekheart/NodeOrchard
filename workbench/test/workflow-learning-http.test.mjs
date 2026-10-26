import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { Application } from '../src/application.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

const terminal = new Set(['complete', 'error', 'interrupted', 'unknown', 'exhausted']);
const candidate = stage => `# Fixture report\n\nFixture result stage: ${stage}.\n`;

async function until(read, predicate, timeout = 6000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected learning HTTP state was not observed: ' + JSON.stringify(last));
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-learning-http-'));
  const config = { ...readConfig(), host: '127.0.0.1', port: 0,
    workflowRunRoot: join(directory, 'runs'),
    dataDir: join(directory, 'data'), workspaceRoot: join(directory, 'workspace'),
    hermesHome: join(directory, 'fake-home'), command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/fake-hermes.mjs', import.meta.url))],
    childEnv: { FAKE_HERMES_STATE_PATH: join(directory, 'hermes.json'),
      FAKE_APPROVAL_MODE: 'manual', FAKE_FALLBACK_PROVIDER: '', FAKE_RESUME_RACE: '' },
  };
  const app = new Application(config);
  const nativeGenerate = app.learningModel.generate.bind(app.learningModel);
  const preparations = [], boundInputs = [], generations = [], generationOptions = [];
  const memoryCaptures = [], memoryReleases = [], memoryScopes = new Set(), releasedScopes = new Set();
  const scopePolicy = id => ({ toolsAllowed: false, memoryAllowed: true, memoryWriteAllowed: false,
    externalMemoryAllowed: false, memoryMode: 'batch-snapshot', memoryScopeId: id, skillMutationBlocked: true });
  let policyPreparations = 0;
  const request = app.adapter.request.bind(app.adapter);
  app.adapter.request = async (method, params, ...rest) => {
    if (method === 'workbench.learning.memory.capture') {
      memoryCaptures.push(structuredClone(params));
      if (app.onMemoryCapture) await app.onMemoryCapture(params);
      if (releasedScopes.has(params.memory_scope_id)) throw new Error('Scope already released.');
      memoryScopes.add(params.memory_scope_id);
      return { policy: { ...scopePolicy(params.memory_scope_id), ...app.capturePolicyOverride } };
    }
    if (method === 'workbench.learning.memory.release') {
      memoryReleases.push(params.memory_scope_id); releasedScopes.add(params.memory_scope_id);
      memoryScopes.delete(params.memory_scope_id); return { released: true };
    }
    if (method === 'workbench.learning.prepare') {
      policyPreparations++;
      if (params.memory_scope_id) {
        assert(memoryScopes.has(params.memory_scope_id), 'control attaches to the existing fixed batch scope');
        return { policy: scopePolicy(params.memory_scope_id) };
      }
      return { policy: { toolsAllowed: false, memoryAllowed: true, memoryWriteAllowed: false, skillMutationBlocked: true } };
    }
    return request(method, params, ...rest);
  };
  // The optimization model is a deterministic fixture; execution still submits
  // through the real adapter process and confirms the persisted assistant turn.
  app.learningModel.generate = async (prompt, options) => {
    generations.push(prompt);
    generationOptions.push(options);
    assert(memoryScopes.has(options.memoryScopeId), 'all rewrite calls use the admitted memory scope');
    return JSON.stringify({ content: candidate(generations.length === 1 ? 'middle' : 'target'),
      summary: `Fixture adjustment ${generations.length}` });
  };
  app.workflows.prepareSkill = async (_app, session, skill, { input, skillNode, ...options }) => {
    if (options.learningId) assert(memoryScopes.has(options.memoryScopeId), 'all learning Skill steps use the admitted memory scope');
    const frozen = structuredClone(skill);
    preparations.push({ skill: frozen, sessionId: session.id, nodeId: skillNode.id, input, ...options });
    const text = frozen.content.includes('Fixture result stage: target.') ? 'target'
      : frozen.content.includes('Fixture result stage: middle.') ? 'middle' : 'old';
    let finished = false;
    return { text, skill: frozen,
      bindInput: async value => {
        assert.equal(finished, false, 'a finished snapshot cannot be replayed');
        boundInputs.push({ sessionId: session.id, name: frozen.name, input: structuredClone(value), text });
        return { text };
      },
      cleanup: async () => { finished = true; },
    };
  };
  const bridge = createWorkbenchServer(config, app);
  t.after(async () => {
    try { await bridge.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const origin = await bridge.listen();
  const bootstrap = await (await fetch(origin + '/api/bootstrap')).json();
  const api = async (path, body, headers = {}) => {
    const response = await fetch(origin + path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        'X-Workbench-Token': bootstrap.csrfToken, ...headers }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  await app.connect();
  const original = await app.skill('fixture-report');
  let document = createDocument({ title: '学习 HTTP 集成' });
  document.mode = 'learn';
  document.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: 'text' } }),
    createNode('skill', { x: 300, y: 0 }, { id: 'skill', config: {
      inputType: 'text', outputType: 'text', skillRef: original.name, version: original.revision,
    } }), createNode('output', { x: 600, y: 0 }, { id: 'output' })];
  for (const [sourceNode, targetNode] of [['input', 'skill'], ['skill', 'output']]) {
    document = connectNodes(document, { sourceNode, sourcePort: 'out', targetNode, targetPort: 'in' });
  }
  document.nodes.push(createNode('evaluation', { x: 600, y: 250 }, { id: 'compare', config: { comparison: 'exact' } }),
    createNode('improvement', { x: 900, y: 250 }, { id: 'improve', config: { targetSkillNodeIds: ['skill'] } }));
  document = connectNodes(document, { sourceNode: 'output', sourcePort: 'learning', targetNode: 'compare', targetPort: 'in' });
  document = connectNodes(document, { sourceNode: 'compare', sourcePort: 'out', targetNode: 'improve', targetPort: 'in' });
  return { app, api, origin, server: bridge.server, csrfToken: bootstrap.csrfToken,
    document, original, preparations, boundInputs, generations, generationOptions, nativeGenerate,
    memoryCaptures, memoryReleases, memoryScopes,
    policyPreparations: () => policyPreparations };
}

const payload = (document, overrides = {}) => ({ document, input: 'training input', expected: 'Echo: target',
  comparison: 'exact', targetScore: 100, maxRounds: 3, ...overrides });
const trainingCases = () => [
  { id: 'training-one', name: '第一条训练', input: 'TRAIN_FIRST_INPUT', expected: 'Echo: target' },
  { id: 'training-two', name: '非首条失败训练', input: 'TRAIN_NONFIRST_FAILURE', expected: 'Echo: target' },
  { id: 'training-three', name: '第三条训练', input: 'TRAIN_THIRD_INPUT', expected: 'Echo: target' },
];
const validationCases = () => [
  { id: 'heldout-one', name: 'PRIVATE_VALIDATION_NAME_ONE', input: 'PRIVATE_VALIDATION_INPUT_ONE', expected: 'Echo: target' },
  { id: 'heldout-two', name: 'PRIVATE_VALIDATION_NAME_TWO', input: 'PRIVATE_VALIDATION_INPUT_TWO', expected: 'Echo: target' },
];
const datasetPayload = (document, overrides = {}) => ({ document, trainingCases: trainingCases(), validationCases: validationCases(),
  comparison: 'exact', targetScore: 100, maxRounds: 3, ...overrides });

test('chunked learning imports preserve Chinese text when UTF-8 bytes span HTTP chunks', async t => {
  const f = await fixture(t);
  const input = '中文跨包输入', expected = '已知答案保留原文';
  const bytes = Buffer.from(JSON.stringify(datasetPayload(f.document, {
    trainingCases: [{ id: 'chinese', name: '中文样例', input, expected }], validationCases: [], maxRounds: 1,
  })));
  const split = bytes.indexOf(Buffer.from('跨')) + 1;
  let firstChunk;
  const receivedFirst = new Promise(resolve => {
    f.server.once('request', req => req.once('data', part => { firstChunk = part; resolve(); }));
  });
  let client;
  const response = new Promise((resolve, reject) => {
    client = httpRequest(f.origin + '/api/workflow-learning', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Workbench-Token': f.csrfToken,
    } }, res => {
      const chunks = []; res.on('data', part => chunks.push(part)); res.on('error', reject);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); } catch (error) { reject(error); } });
    });
    client.on('error', reject);
  });
  client.write(bytes.subarray(0, split));
  await receivedFirst;
  assert.equal(firstChunk.at(-1), Buffer.from('跨')[0], 'the server received a partial Chinese character');
  client.end(bytes.subarray(split));
  const started = await response;
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal(started.body.config.trainingCases[0].input, input);
  assert.equal(started.body.config.trainingCases[0].expected, expected);
  const result = (await until(() => f.api('/api/workflow-learning/' + started.body.id), value => terminal.has(value.body.status))).body;
  assert.equal(result.rounds[0].cases[0].input, input);
  assert.equal(result.rounds[0].cases[0].expected, expected);
  assert.equal(f.boundInputs[0].input, input);
});

test('learning HTTP executes all three training and two validation cases over three rounds, applies the best, and reruns it', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/skills')).body.skills.some(skill => skill.source === 'learned'), false);
  const submitted = datasetPayload(f.document);
  const started = await f.api('/api/workflow-learning', submitted);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const result = (await until(() => f.api('/api/workflow-learning/' + started.body.id),
    value => terminal.has(value.body.status))).body;
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.equal(result.reason, 'target');
  assert.equal(result.bestRound, 2);
  assert.equal(result.bestScore, 100);
  assert.deepEqual(result.config.comparisonSource, { nodeId: 'output', port: 'learning', valuePath: '' });
  assert.deepEqual(result.config.trainableNodeIds, ['skill']);
  assert.equal(f.memoryCaptures.length, 1, 'a batch captures memory only once, before any sample');
  assert.equal(result.memoryScopeId, result.id);
  assert.deepEqual(result.memoryPolicy, { mode: 'batch-snapshot', memoryWriteAllowed: false, externalMemoryAllowed: false });
  assert(f.generationOptions.every(options => options.memoryScopeId === result.id));
  assert.deepEqual(result.rounds.map(round => round.score), [0, 0, 100]);
  assert.deepEqual(result.rounds.map(round => round.status), ['complete', 'complete', 'complete']);
  assert.deepEqual(result.rounds.map(round => round.cases.map(item => item.output)),
    ['old', 'middle', 'target'].map(stage => Array(5).fill('Echo: ' + stage)));
  assert.deepEqual(result.rounds.map(round => round.cases.map(item => item.role)),
    Array.from({ length: 3 }, () => ['train', 'train', 'train', 'validation', 'validation']));
  assert.deepEqual(result.config.trainingCases, submitted.trainingCases);
  assert.deepEqual(result.config.validationCases, submitted.validationCases);
  for (const [index, round] of result.rounds.entries()) {
    assert.deepEqual(round.cases.map(({ id, name, input, expected }) => ({ id, name, input, expected })),
      [...submitted.trainingCases, ...submitted.validationCases]);
    for (const [group, total] of [['train', 3], ['validation', 2], ['overall', 5]]) {
      assert.deepEqual(round.metrics[group], { total, passed: index === 2 ? total : 0,
        failed: index === 2 ? 0 : total, pending: 0, evaluated: total,
        passRate: index === 2 ? 1 : 0, averageScore: index === 2 ? 100 : 0, minScore: index === 2 ? 100 : 0 });
    }
  }
  assert.equal(f.generations.length, 2, 'exact scoring needs models only for candidate rewriting');
  for (const [index, prompt] of f.generations.entries()) {
    for (const item of submitted.validationCases) {
      assert.equal(prompt.includes(item.input), false, 'validation inputs stay out of the rewrite prompt');
      assert.equal(prompt.includes(item.name), false, 'validation metadata stays out of the rewrite prompt');
    }
    const evidence = JSON.parse(prompt.split('\n').at(-1));
    assert.deepEqual(evidence.trainingCases.map(({ id, name, input, expected }) => ({ id, name, input, expected })), submitted.trainingCases,
      'every training case, including the nonfirst failure, must reach optimization');
    assert(evidence.trainingCases.every(item => item.best.score === 0 && item.latest.score === 0));
    assert.equal(evidence.trainingCases[1].latest.output, index === 0 ? 'Echo: old' : 'Echo: middle');
  }
  assert.equal(f.preparations.length, 15);
  assert(f.preparations.every(options => options.memoryScopeId === result.id && options.learningId === result.id));
  assert.deepEqual(f.boundInputs.map(item => item.input),
    Array.from({ length: 3 }, () => [...submitted.trainingCases, ...submitted.validationCases].map(item => item.input)).flat());
  assert.deepEqual(await f.app.skill(f.original.name), f.original, 'learning must not mutate the installed Skill');
  assert.equal((await f.api('/api/skills')).body.skills.some(skill => skill.source === 'learned'), false,
    'successful but unapplied candidates stay out of the picker');
  for (const round of result.rounds) for (const item of round.cases) {
    const run = (await f.api('/api/workflow-runs/' + item.runId)).body;
    assert.equal(run.learningId, result.id);
    assert.equal(run.memoryScopeId, result.id);
    assert.equal(run.status, 'complete');
    for (const id of ['compare', 'improve']) {
      assert.equal(run.nodes[id].status, 'skipped');
      assert.equal(run.nodes[id].reason, '由学习控制器管理');
      assert.equal(Object.hasOwn(run.nodes[id], 'output'), false);
    }
    const history = await f.app.history(run.nodes.skill.sessionId);
    assert.equal(history.messages.filter(message => message.role === 'assistant').at(-1).text, item.output);
  }
  const applied = await f.api('/api/workflow-learning/' + result.id + '/apply', {});
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.round, 2);
  assert.equal(applied.body.score, 100);
  assert.equal(applied.body.document.mode, 'execute');
  const selected = applied.body.document.nodes.find(node => node.id === 'skill');
  assert.match(selected.config.skillRef, /^wb-learn-/);
  const catalog = (await f.api('/api/skills')).body.skills.filter(skill => skill.source === 'learned');
  assert.deepEqual(catalog.map(skill => skill.name), [selected.config.skillRef]);
  const detail = await f.api('/api/skills/' + selected.config.skillRef);
  assert.equal(detail.body.content, candidate('target'));
  assert.equal(detail.body.baseName, f.original.name);
  assert.equal(detail.body.baseRevision, f.original.revision);
  assert.equal(detail.body.revision, selected.config.version);
  const execution = await f.api('/api/workflow-runs', { document: applied.body.document, input: 'new execution input' });
  assert.equal(execution.status, 202, JSON.stringify(execution.body));
  const executed = (await until(() => f.api('/api/workflow-runs/' + execution.body.id),
    value => terminal.has(value.body.status))).body;
  assert.equal(executed.status, 'complete', JSON.stringify(executed));
  assert.equal(executed.output, 'Echo: target');
  assert.equal(executed.nodes.skill.input, 'new execution input');
  for (const id of ['compare', 'improve']) {
    assert.equal(executed.nodes[id].status, 'skipped');
    assert.equal(executed.nodes[id].reason, '执行模式跳过学习支路');
  }
  assert.equal(f.preparations.at(-1).memoryScopeId, undefined, 'ordinary execution does not inherit isolated learning memory');
  assert.equal(f.preparations.at(-1).learningId, undefined);
  assert(f.memoryReleases.includes(result.id));
  assert.equal(f.memoryScopes.size, 0);
  assert.equal(f.preparations.at(-1).skill.name, selected.config.skillRef);
  assert.equal(f.preparations.at(-1).skill.content, candidate('target'));
  assert.equal(f.generations.length, 2, 'ordinary execution never rewrites Skills');
  assert.deepEqual(await f.app.skill(f.original.name), f.original);
  const listed = await f.api('/api/workflow-learning?workflowId=' + encodeURIComponent(f.document.id));
  assert.equal(listed.body.learnings[0].id, result.id);
  assert.equal(listed.body.learnings[0].bestRound, 2);
  assert.deepEqual(listed.body.learnings[0].config.trainingCases, submitted.trainingCases);
  assert.deepEqual(listed.body.learnings[0].rounds[2].metrics, result.rounds[2].metrics);
});

test('learning HTTP rejects leaked inputs, duplicate IDs, ambiguous legacy fields, oversized datasets and wrong answer types atomically', async t => {
  const f = await fixture(t);
  const valid = datasetPayload(f.document);
  const typedDocument = structuredClone(f.document);
  Object.assign(typedDocument.edges.find(edge => edge.targetNode === 'compare'), { sourceNode: 'skill', sourcePort: 'out' });
  const invalid = [
    [{ ...valid, validationCases: [{ id: 'different', input: valid.trainingCases[1].input, expected: 'different answer' }] }, /相同 input.*不同答案/],
    [{ ...valid, validationCases: [{ id: valid.trainingCases[0].id, input: 'different validation input', expected: 'Echo: target' }] }, /全局唯一/],
    [{ ...valid, input: 'ambiguous', expected: 'Echo: target' }, /trainingCases.*旧 input/],
    [{ ...valid, trainingCases: Array.from({ length: 21 }, (_, index) => ({ input: 'case-' + index, expected: 'Echo: target' })), validationCases: [] }, /20 条/],
    [{ ...valid, document: typedDocument, trainingCases: [{ input: 'wrong answer', expected: { wrong: 'object instead of text' } }] }, /已知答案.*输出类型/],
    [{ ...valid, document: typedDocument, validationCases: [{ input: 'wrong validation answer', expected: false }] }, /已知答案.*输出类型/],
  ];
  for (const [body, expectedError] of invalid) {
    const rejected = await f.api('/api/workflow-learning', body);
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.match(rejected.body.error, expectedError);
  }
  assert.equal(f.app.learning.list().length, 0);
  assert.equal(f.app.workflows.list().length, 0);
  assert.equal(f.app.store.list().length, 0);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM learning_model_sessions').get().count, 0);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM learned_skills').get().count, 0);
  assert.equal(f.generations.length, 0);
  assert.equal(f.preparations.length, 0);
});

test('learning HTTP requires an explicit learning branch and rejects request attempts to widen its Skill scope or change comparison', async t => {
  const f = await fixture(t);
  const valid = datasetPayload(f.document);
  const withoutBranch = structuredClone(f.document);
  withoutBranch.nodes = withoutBranch.nodes.filter(node => !['evaluation', 'improvement'].includes(node.type));
  withoutBranch.edges = withoutBranch.edges.filter(edge => !['compare', 'improve'].includes(edge.sourceNode)
    && !['compare', 'improve'].includes(edge.targetNode));
  const noTarget = structuredClone(f.document);
  noTarget.nodes.find(node => node.id === 'improve').config.targetSkillNodeIds = [];
  const nonSkillTarget = structuredClone(f.document);
  nonSkillTarget.nodes.find(node => node.id === 'improve').config.targetSkillNodeIds = ['output'];
  for (const [body, error] of [
    [{ ...valid, document: withoutBranch }, /学习.*支路/],
    [{ ...valid, comparison: 'model' }, /比较方式.*节点/],
    [{ ...valid, trainableNodeIds: ['skill', 'output'] }, /不能.*扩大修改范围/],
    [{ ...valid, document: noTarget }, /可调整 Skill 节点/],
    [{ ...valid, document: nonSkillTarget }, /可调整 Skill 节点/],
  ]) {
    const rejected = await f.api('/api/workflow-learning', body);
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.match(rejected.body.error, error);
  }
  assert.equal(f.app.learning.list().length, 0);
  assert.equal(f.app.workflows.list().length, 0);
  assert.equal(f.app.store.list().length, 0);
  assert.equal(f.memoryCaptures.length, 0);
  assert.equal(f.generations.length, 0);
  assert.equal(f.preparations.length, 0);
});

test('stopping the first dataset case keeps the full denominator and every unexecuted case pending', async t => {
  const f = await fixture(t);
  const prepare = f.app.workflows.prepareSkill;
  f.app.workflows.prepareSkill = async (...args) => {
    const prepared = await prepare(...args), bind = prepared.bindInput;
    prepared.bindInput = async value => { await bind(value); return { text: 'slow first dataset case' }; };
    return prepared;
  };
  const submitted = datasetPayload(f.document);
  const started = await f.api('/api/workflow-learning', submitted);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const running = (await until(() => f.api('/api/workflow-learning/' + started.body.id), value =>
    value.body.rounds?.[0]?.cases[0]?.status === 'running' && value.body.activeRunId
      && f.app.workflows.get(value.body.activeRunId).partialText === 'Working slowly')).body;
  const firstRound = running.rounds[0];
  assert.equal(firstRound.cases.length, 5);
  assert.deepEqual(firstRound.cases.map(item => item.status), ['running', 'pending', 'pending', 'pending', 'pending']);
  for (const [group, total] of [['train', 3], ['validation', 2], ['overall', 5]]) {
    assert.equal(firstRound.metrics[group].total, total);
    assert.equal(firstRound.metrics[group].pending, total);
    assert.equal(firstRound.metrics[group].passRate, null);
    assert.equal(firstRound.metrics[group].passed, 0);
  }
  assert.equal((await f.api('/api/workflow-learning/' + started.body.id + '/interrupt', {})).status, 200);
  const stopped = (await until(() => f.api('/api/workflow-learning/' + started.body.id),
    value => terminal.has(value.body.status))).body;
  assert.equal(stopped.status, 'interrupted');
  assert.deepEqual(stopped.rounds[0].cases.map(item => item.status), ['interrupted', 'pending', 'pending', 'pending', 'pending']);
  assert.deepEqual(stopped.rounds[0].cases.map(item => item.id), [...submitted.trainingCases, ...submitted.validationCases].map(item => item.id));
  assert.deepEqual(stopped.rounds[0].metrics.overall, { total: 5, passed: 0, failed: 0, pending: 5,
    evaluated: 0, passRate: null, averageScore: null, minScore: null });
  assert.equal(f.preparations.length, 1);
  assert.equal(f.app.workflows.list().length, 1);
  assert.equal(f.generations.length, 0);
  assert.equal(f.app.learnedSkills.list().length, 0);
});

test('legacy learning GET and list add stable sample identities and metrics without rewriting stored history', async t => {
  const f = await fixture(t);
  const legacy = { id: 'legacy-http-learning', workflowId: f.document.id, status: 'exhausted', phase: 'finished',
    document: f.document, input: 'old training input', expected: 'old answer',
    config: { comparison: 'exact', targetScore: 90, maxRounds: 1, trainableNodeIds: ['skill'],
      validationCases: [{ input: 'old heldout input', expected: 'old heldout answer' }] },
    rounds: [{ index: 0, status: 'complete', document: { ...f.document, mode: 'execute' }, score: 50, changes: [],
      cases: [{ role: 'train', input: 'old training input', expected: 'old answer', status: 'complete', output: 'old answer', score: 100 },
        { role: 'validation', input: 'old heldout input', expected: 'old heldout answer', status: 'complete', output: 'wrong old answer', score: 50 }] }],
    bestRound: 0, bestScore: 50, bestDocument: { ...f.document, mode: 'execute' },
    startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:01:00.000Z', error: '', reason: 'maxRounds' };
  const saved = JSON.stringify(legacy);
  f.app.store.db.prepare('INSERT INTO workflow_learning(id,value) VALUES(?,?)').run(legacy.id, saved);
  const read = await f.api('/api/workflow-learning/' + legacy.id);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.bestScore, 50);
  assert.equal(read.body.memoryPolicy.mode, 'legacy');
  assert.equal(read.body.config.trainingCases[0].id, 'train-1');
  assert.equal(read.body.config.validationCases[0].id, 'validation-1');
  assert.deepEqual(read.body.rounds[0].cases.map(item => item.id), ['train-1', 'validation-1']);
  assert.deepEqual(read.body.rounds[0].cases.map(item => item.name), ['训练样例 1', '验证样例 1']);
  assert.equal(read.body.rounds[0].metrics.train.passRate, 1);
  assert.equal(read.body.rounds[0].metrics.validation.passRate, 0);
  assert.equal(read.body.rounds[0].metrics.overall.passRate, 0.5);
  const listed = await f.api('/api/workflow-learning?workflowId=' + encodeURIComponent(f.document.id));
  assert.deepEqual(listed.body.learnings[0].rounds[0].metrics, read.body.rounds[0].metrics);
  assert.equal(f.app.store.db.prepare('SELECT value FROM workflow_learning WHERE id=?').get(legacy.id).value, saved,
    'GET compatibility must not mutate historical records');
  assert.equal(f.generations.length, 0);
  assert.equal(f.preparations.length, 0);
});

test('learning HTTP rejects CSRF, foreign origins, missing Skills, and wrong modes without side effects', async t => {
  const f = await fixture(t);
  const start = payload(f.document);
  assert.equal((await f.api('/api/workflow-learning', start, { 'X-Workbench-Token': 'invalid' })).status, 403);
  assert.equal((await f.api('/api/workflow-learning', start, { Origin: 'https://example.invalid' })).status, 403);
  assert.equal((await f.api('/api/workflow-runs', { document: f.document, input: 'x' })).status, 400);
  assert.equal((await f.api('/api/workflow-learning', { ...start, document: { ...f.document, mode: 'execute' } })).status, 400);
  const withoutSkill = structuredClone(f.document);
  withoutSkill.nodes[1] = createNode('tool', { x: 300, y: 0 }, { id: 'skill', config: {
    executionMode: 'code', inputType: 'text', outputType: 'text', code: 'return input;',
  } });
  const noSkill = await f.api('/api/workflow-learning', { ...start, document: withoutSkill });
  assert.equal(noSkill.status, 400);
  assert.match(noSkill.body.error, /Skill/);
  assert.equal(f.app.learning.list().length, 0);
  assert.equal(f.app.workflows.list().length, 0);
  assert.equal(f.app.store.list().length, 0);
  assert.equal(f.generations.length, 0);
  assert.equal(f.preparations.length, 0);
});

test('active learning locks manual execution and application; stopping ignores a late candidate', async t => {
  const f = await fixture(t);
  let release, modelSignal;
  f.app.learningModel.generate = async (_prompt, { signal }) => {
    modelSignal = signal;
    return new Promise(resolve => { release = () => resolve(JSON.stringify({ content: candidate('target'), summary: 'late candidate' })); });
  };
  const started = await f.api('/api/workflow-learning', payload(f.document));
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const optimizing = (await until(() => f.api('/api/workflow-learning/' + started.body.id),
    value => value.body.phase === 'optimizing' && typeof release === 'function')).body;
  assert.equal(optimizing.rounds[0].status, 'complete');
  assert.equal((await f.api('/api/workflow-runs', { document: { ...f.document, mode: 'execute' }, input: 'manual bypass' })).status, 409);
  assert.equal((await f.api('/api/workflow-learning', payload(f.document))).status, 409);
  assert.equal((await f.api('/api/workflow-learning/' + started.body.id + '/apply', {})).status, 409);
  assert.equal((await f.api('/api/workflow-learning/' + started.body.id + '/interrupt', {},
    { 'X-Workbench-Token': 'invalid' })).status, 403);
  assert.equal(modelSignal.aborted, false);
  assert.equal((await f.api('/api/workflow-learning/' + started.body.id + '/interrupt', {})).status, 200);
  assert.equal(modelSignal.aborted, true);
  release();
  const stopped = (await until(() => f.api('/api/workflow-learning/' + started.body.id),
    value => terminal.has(value.body.status))).body;
  assert.equal(stopped.status, 'interrupted');
  assert.equal(stopped.rounds.length, 1);
  assert.equal(f.preparations.length, 1, 'a late rewrite must never start the next execution');
  assert.equal(f.app.workflows.list().length, 1);
  assert.equal(f.app.learnedSkills.list().length, 0);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM learned_skills').get().count, 0);
  assert.equal(f.app.learning.isLocked(f.document.id), false);
  assert.deepEqual(await f.app.skill(f.original.name), f.original);
});

test('HTTP cannot inject messages into a real adapter learning-control session, including after stopping', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  let sessionId;
  const result = f.nativeGenerate('slow learning controller', { signal: controller.signal,
    onSession: id => { sessionId = id; } });
  result.catch(() => {});
  await until(() => Promise.resolve(sessionId && f.app.session(sessionId)),
    session => session?.hasPrompted === true && session.status === 'running');
  assert.equal(f.policyPreparations(), 1);
  const bootstrap = await f.api('/api/bootstrap');
  assert.equal(bootstrap.body.sessions.find(session => session.id === sessionId).workflowManaged, true);
  const before = await f.app.history(sessionId);
  assert.deepEqual(before.messages.filter(message => message.role === 'user').map(message => message.text), ['slow learning controller']);
  assert.equal((await f.api(`/api/sessions/${sessionId}/messages`, { text: 'inject into controller' })).status, 409);
  controller.abort();
  await assert.rejects(result, /停止/);
  await until(() => Promise.resolve(f.app.session(sessionId)), session => session.status === 'interrupted');
  assert.equal((await f.api(`/api/sessions/${sessionId}/messages`, { text: 'revive controller' })).status, 409);
  const after = await f.app.history(sessionId);
  assert.deepEqual(after.messages.filter(message => message.role === 'user').map(message => message.text), ['slow learning controller']);
  assert.equal(f.app.store.runs(sessionId).length, 1);
});

test('freezing learning memory admits no samples until confirmed, and stopping rejects a late snapshot', async t => {
  const f = await fixture(t); let releaseCapture;
  f.app.onMemoryCapture = () => new Promise(resolve => { releaseCapture = resolve; });
  const started = await f.api('/api/workflow-learning', datasetPayload(f.document));
  assert.equal(started.status, 202);
  const preparing = (await until(() => f.api('/api/workflow-learning/' + started.body.id), value =>
    value.body.phase === 'preparing-memory' && typeof releaseCapture === 'function')).body;
  assert.equal(preparing.memoryPolicy.mode, 'pending'); assert.equal(preparing.memoryScopeId, null);
  assert.equal(f.preparations.length, 0); assert.equal(f.generations.length, 0);
  assert.equal(f.app.workflows.list().length, 0);
  const anchor = f.app.store.list().find(session => session.title === '学习 · 固定记忆快照');
  assert(anchor); assert.equal(anchor.hasPrompted, false);
  assert.equal((await f.api(`/api/sessions/${anchor.id}/messages`, { text: 'inject before learning' })).status, 409);
  await f.api('/api/workflow-learning/' + started.body.id + '/interrupt', {});
  const stopped = (await until(() => f.api('/api/workflow-learning/' + started.body.id), value => terminal.has(value.body.status))).body;
  assert.equal(stopped.status, 'interrupted');
  releaseCapture(); await new Promise(resolve => setImmediate(resolve));
  await until(() => Promise.resolve(f.app.learningModel.pending.size), count => count === 0);
  assert.equal(f.memoryScopes.size, 0); assert(f.memoryReleases.includes(started.body.id));
  assert.equal(f.app.workflows.list().length, 0); assert.equal(f.generations.length, 0);
  assert.equal((await f.api('/api/workflow-learning/' + started.body.id)).body.rounds.length, 0);
});

test('unconfirmed batch memory fails closed and clients cannot supply their own memory policy', async t => {
  const f = await fixture(t), config = datasetPayload(f.document);
  for (const fields of [{ memoryScopeId: 'forged' }, { memoryPolicy: { mode: 'live' } }, { memory_scope_id: 'forged' }]) {
    assert.equal((await f.api('/api/workflow-learning', { ...config, ...fields })).status, 400);
  }
  assert.equal(f.memoryCaptures.length, 0);
  f.app.capturePolicyOverride = { externalMemoryAllowed: true };
  const started = await f.api('/api/workflow-learning', config);
  const failed = (await until(() => f.api('/api/workflow-learning/' + started.body.id), value => terminal.has(value.body.status))).body;
  assert.equal(failed.status, 'error'); assert.match(failed.error, /记忆/);
  assert.equal(failed.rounds.length, 0); assert.equal(failed.memoryPolicy.mode, 'pending');
  assert.equal(f.preparations.length, 0); assert.equal(f.generations.length, 0);
  assert.equal(f.app.workflows.list().length, 0); assert.equal(f.memoryScopes.size, 0);
});
